'use strict';

/**
 * Authentifizierung: Passwort-Hashing, Sessions, Middleware, Rate-Limit.
 * Siehe SPEC.md Abschnitt 3.
 */

const crypto = require('node:crypto');
const { db, getSetting, setSetting, hashPasswordSync } = require('./db');

const COOKIE_NAME = 'stb_session';
// `__Host-` erzwingt Secure, Path=/ und verbietet ein Domain-Attribut. Ueber
// http (lokale Entwicklung) wuerde der Browser so ein Cookie verwerfen.
const COOKIE_NAME_SECURE = `__Host-${COOKIE_NAME}`;
const SESSION_DAYS = 30;
const SESSION_MAX_AGE_SEC = SESSION_DAYS * 24 * 60 * 60;

// Adminmodus laeuft ab; die Session selbst bleibt davon unberuehrt.
const ADMIN_MODE_MS = 30 * 60 * 1000; // 30 Minuten

const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 Minuten
const RATE_MAX_FAILS = 10; // pro IP und Scope
const RATE_MAX_FAILS_GLOBAL = 100; // ueber alle IPs eines Scopes
const RATE_SCOPES = ['login', 'admin'];
const ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 Stunden

// ---------------------------------------------------------------------------
// Passwoerter
// ---------------------------------------------------------------------------

// scrypt ist absichtlich rechenintensiv. Synchron ausgefuehrt blockiert es die
// Event-Loop, deshalb laeuft es asynchron im libuv-Threadpool. Der hat aber
// standardmaessig nur 4 Threads — ohne Deckel wuerden parallele Loginversuche
// alle Dateizugriffe aushungern. Also hoechstens zwei Pruefungen gleichzeitig,
// der Rest wartet in einer kurzen Warteschlange.
const SCRYPT_MAX_ACTIVE = 2;
const SCRYPT_MAX_QUEUE = 20;

let scryptActive = 0;
const scryptQueue = [];

/** 503-Fehler im ueblichen Format; index.js macht daraus die Antwort. */
function busyError() {
  const err = new Error('Der Server ist gerade ausgelastet. Bitte gleich nochmals versuchen.');
  err.status = 503;
  err.code = 'busy';
  return err;
}

/** Platz im Deckel holen; loest mit einer Freigabefunktion auf. */
function acquireScryptSlot() {
  if (scryptActive < SCRYPT_MAX_ACTIVE) {
    scryptActive += 1;
    return Promise.resolve(releaseScryptSlot);
  }
  if (scryptQueue.length >= SCRYPT_MAX_QUEUE) {
    return Promise.reject(busyError());
  }
  return new Promise((resolve) => {
    scryptQueue.push(() => resolve(releaseScryptSlot));
  });
}

function releaseScryptSlot() {
  const next = scryptQueue.shift();
  if (next) {
    next(); // Platz direkt weiterreichen, scryptActive bleibt unveraendert.
    return;
  }
  scryptActive -= 1;
}

function scryptAsync(password, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/** Rechnet mit Deckel: erst Platz holen, dann scrypt, danach immer freigeben. */
async function withScryptSlot(fn) {
  const release = await acquireScryptSlot();
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Vergleicht ein Klartext-Passwort mit einem `scrypt$<saltHex>$<hashHex>`-Eintrag.
 * Immer timingSafeEqual, damit die Laufzeit nichts verraet.
 * Asynchron; wirft einen 503-Fehler, wenn die Warteschlange voll ist.
 */
async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  return withScryptSlot(async () => {
    let actual;
    try {
      actual = await scryptAsync(password, salt, expected.length);
    } catch {
      return false;
    }
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  });
}

/**
 * Erzeugt `scrypt$<saltHex>$<hashHex>` — asynchron, fuer den Request-Pfad.
 * Beim Start (Seed) gilt stattdessen `hashPasswordSync` aus db.js.
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await withScryptSlot(() => scryptAsync(String(password), salt, 64));
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

function parseCookies(header) {
  const out = Object.create(null);
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function useSecureCookies() {
  return process.env.SECURE_COOKIES !== 'false';
}

/** Ueber TLS mit `__Host-`-Praefix, lokal ueber http ohne. */
function sessionCookieName() {
  return useSecureCookies() ? COOKIE_NAME_SECURE : COOKIE_NAME;
}

function cookieAttributes(maxAgeSec) {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (useSecureCookies()) attrs.push('Secure');
  return attrs;
}

function setSessionCookie(res, token) {
  res.append(
    'Set-Cookie',
    `${sessionCookieName()}=${token}; ${cookieAttributes(SESSION_MAX_AGE_SEC).join('; ')}`
  );
}

function clearSessionCookie(res) {
  // Beide Namen loeschen, damit beim Wechsel des Praefixes nichts liegen bleibt.
  for (const name of new Set([sessionCookieName(), COOKIE_NAME, COOKIE_NAME_SECURE])) {
    res.append('Set-Cookie', `${name}=; ${cookieAttributes(0).join('; ')}`);
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createSession(role) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_MAX_AGE_SEC * 1000);
  db.prepare(
    'INSERT INTO sessions (token_hash, role, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(sha256(token), role, now.toISOString(), expires.toISOString());
  return token;
}

function readSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  // Beide Namen lesen: nach einem Wechsel auf TLS (oder zurueck) bleiben
  // bestehende Anmeldungen so gueltig.
  const token = cookies[sessionCookieName()] || cookies[COOKIE_NAME_SECURE] || cookies[COOKIE_NAME];
  if (!token) return null;
  const tokenHash = sha256(token);
  const row = db
    .prepare('SELECT token_hash, role, expires_at, admin_until FROM sessions WHERE token_hash = ?')
    .get(tokenHash);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }

  let role = row.role;
  let adminUntil = row.admin_until || '';
  if (role === 'admin') {
    const until = adminUntil ? new Date(adminUntil).getTime() : 0;
    if (!(until > Date.now())) {
      // Adminmodus abgelaufen: Rolle faellt zurueck, die Session bleibt gueltig.
      revokeAdmin(tokenHash);
      role = 'family';
      adminUntil = '';
    }
  } else {
    adminUntil = '';
  }
  return { tokenHash, role, adminUntil };
}

/** Adminmodus freischalten — befristet auf ADMIN_MODE_MS. */
function grantAdmin(tokenHash) {
  const until = new Date(Date.now() + ADMIN_MODE_MS).toISOString();
  db.prepare("UPDATE sessions SET role = 'admin', admin_until = ? WHERE token_hash = ?").run(
    until,
    tokenHash
  );
  return until;
}

/** Adminmodus beenden; die Session selbst bleibt bestehen. */
function revokeAdmin(tokenHash) {
  db.prepare(
    "UPDATE sessions SET role = 'family', admin_until = '' WHERE token_hash = ?"
  ).run(tokenHash);
}

function destroySession(tokenHash) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

/**
 * Loescht alle Sessions ausser der angegebenen und liefert die Anzahl.
 * Nach einem Passwortwechsel fliegt damit auch ein Eindringling raus.
 */
function destroyAllSessions(exceptTokenHash) {
  const info = exceptTokenHash
    ? db.prepare('DELETE FROM sessions WHERE token_hash != ?').run(exceptTokenHash)
    : db.prepare('DELETE FROM sessions').run();
  return Number(info.changes || 0);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/** Haengt `req.session` an (oder null). Blockiert nichts. */
function attachSession(req, _res, next) {
  req.session = readSession(req);
  next();
}

function requireAuth(req, res, next) {
  if (!req.session) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Bitte zuerst mit dem Familienpasswort anmelden.',
    });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Bitte zuerst mit dem Familienpasswort anmelden.',
    });
  }
  if (req.session.role !== 'admin') {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Dafuer braucht es den Adminmodus.',
    });
  }
  next();
}

// ---------------------------------------------------------------------------
// IP-Ermittlung und Rate-Limit
// ---------------------------------------------------------------------------

/**
 * Die echte Client-IP kommt von Express selbst.
 * `app.set('trust proxy', 1)` wertet den LETZTEN Eintrag von X-Forwarded-For
 * aus — genau den, den ein Reverse Proxy per `$proxy_add_x_forwarded_for`
 * anhaengt. Der Header darf hier nicht selbst gelesen werden: dessen vordere
 * Eintraege stammen vom Aufrufer und sind frei erfindbar, damit waere das
 * Rate-Limit mit einem gefaelschten Header komplett aushebelbar.
 */
function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 100);
}

function normalizeScope(scope) {
  return RATE_SCOPES.includes(scope) ? scope : 'login';
}

function recentFailures(scope, ip) {
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  return db
    .prepare(
      'SELECT COUNT(*) AS n FROM login_attempts WHERE scope = ? AND ip = ? AND ok = 0 AND ts > ?'
    )
    .get(scope, ip, since).n;
}

/** Fehlversuche eines Scopes ueber alle IPs — gegen verteilte Rateversuche. */
function recentFailuresGlobal(scope) {
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  return db
    .prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE scope = ? AND ok = 0 AND ts > ?')
    .get(scope, since).n;
}

function recordAttempt(scope, ip, ok) {
  db.prepare('INSERT INTO login_attempts (scope, ip, ts, ok) VALUES (?, ?, ?, ?)').run(
    normalizeScope(scope),
    ip,
    new Date().toISOString(),
    ok ? 1 : 0
  );
}

function clearAttempts(scope, ip) {
  db.prepare('DELETE FROM login_attempts WHERE scope = ? AND ip = ?').run(
    normalizeScope(scope),
    ip
  );
}

/**
 * Rate-Limit fuer Endpunkte, die ein Passwort entgegennehmen — pro Scope.
 * Getrennte Toepfe, damit ein vertipptes Adminpasswort nicht den ganzen
 * Haushalt (eine NAT-IP) vom Familienlogin aussperrt.
 */
function rateLimit(scope) {
  const useScope = normalizeScope(scope);
  return function rateLimitMiddleware(req, res, next) {
    const ip = clientIp(req);
    req.clientIp = ip;
    req.rateScope = useScope;
    if (recentFailures(useScope, ip) >= RATE_MAX_FAILS) {
      return res.status(429).json({
        error: 'rate_limited',
        message: 'Zu viele Fehlversuche. Bitte in 15 Minuten nochmals probieren.',
      });
    }
    if (recentFailuresGlobal(useScope) >= RATE_MAX_FAILS_GLOBAL) {
      return res.status(429).json({
        error: 'rate_limited_global',
        message:
          'Zurzeit gibt es auffaellig viele Fehlversuche. Bitte in 15 Minuten nochmals probieren.',
      });
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Aufraeumen
// ---------------------------------------------------------------------------

function cleanup() {
  const now = new Date().toISOString();
  const attemptCutoff = new Date(Date.now() - ATTEMPT_RETENTION_MS).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM login_attempts WHERE ts <= ?').run(attemptCutoff);
  // Abgelaufener Adminmodus: Rolle zuruecksetzen, Session behalten.
  db.prepare(
    "UPDATE sessions SET role = 'family', admin_until = '' " +
      "WHERE admin_until != '' AND admin_until <= ?"
  ).run(now);
}

function startCleanupTimer() {
  cleanup();
  const timer = setInterval(cleanup, 60 * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = {
  COOKIE_NAME,
  COOKIE_NAME_SECURE,
  ADMIN_MODE_MS,
  hashPassword, // asynchron — Request-Pfad
  hashPasswordSync, // synchron — nur Seed beim Start
  verifyPassword,
  useSecureCookies,
  getSetting,
  setSetting,
  createSession,
  readSession,
  grantAdmin,
  revokeAdmin,
  destroySession,
  destroyAllSessions,
  setSessionCookie,
  clearSessionCookie,
  attachSession,
  requireAuth,
  requireAdmin,
  clientIp,
  rateLimit,
  recordAttempt,
  clearAttempts,
  cleanup,
  startCleanupTimer,
};
