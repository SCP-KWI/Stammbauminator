'use strict';

/**
 * Admin-Routen: Passwortwechsel, Statistik und Einstellungen.
 * Siehe SPEC.md Abschnitt 4 (Admin, Einstellungen).
 */

const fs = require('node:fs');
const express = require('express');

const { db, DB_FILE, getSetting, setSetting } = require('../db');
const {
  requireAdmin,
  rateLimit,
  verifyPassword,
  hashPassword,
  clientIp,
  recordAttempt,
  clearAttempts,
  destroyAllSessions,
} = require('../auth');

const router = express.Router();
// Routen ohne Session-Pflicht — wird in index.js VOR requireAuth gemountet.
const publicRouter = express.Router();

const MIN_PASSWORD_LENGTH = 12;
const FAMILY_NAME_KEY = 'family_name';
const FAMILY_NAME_MAX = 40;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function readNewPassword(value, label) {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'invalid_password', `${label} ist ungueltig.`);
  }
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new ApiError(
      400,
      'password_too_short',
      `${label} muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`
    );
  }
  if (value.length > 200) {
    throw new ApiError(
      400,
      'password_too_long',
      `${label} darf hoechstens 200 Zeichen lang sein.`
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Passwoerter
// ---------------------------------------------------------------------------

router.post('/admin/passwords', rateLimit('admin'), requireAdmin, async (req, res) => {
  const ip = req.clientIp || clientIp(req);
  const body = req.body || {};

  const current = typeof body.currentAdminPassword === 'string' ? body.currentAdminPassword : '';
  if (!(await verifyPassword(current, getSetting('admin_password') || ''))) {
    recordAttempt('admin', ip, false);
    throw new ApiError(403, 'wrong_password', 'Das aktuelle Adminpasswort stimmt nicht.');
  }

  const wantsFamily = Object.prototype.hasOwnProperty.call(body, 'familyPassword');
  const wantsAdmin = Object.prototype.hasOwnProperty.call(body, 'adminPassword');
  if (!wantsFamily && !wantsAdmin) {
    throw new ApiError(
      400,
      'nothing_to_change',
      'Es wurde kein neues Passwort angegeben.'
    );
  }

  const changed = [];
  if (wantsFamily) {
    const pw = readNewPassword(body.familyPassword, 'Das Familienpasswort');
    setSetting('family_password', await hashPassword(pw));
    changed.push('familyPassword');
  }
  if (wantsAdmin) {
    const pw = readNewPassword(body.adminPassword, 'Das Adminpasswort');
    setSetting('admin_password', await hashPassword(pw));
    changed.push('adminPassword');
  }

  // Bestehende Sessions bleiben standardmaessig gueltig. Ist ein Passwort
  // abhandengekommen, bringt blosses Rotieren aber nichts — dann raeumt
  // `logoutEverywhere` alle anderen Sitzungen weg, die eigene bleibt.
  let sessionsRevoked = 0;
  if (body.logoutEverywhere === true) {
    sessionsRevoked = destroyAllSessions(req.session ? req.session.tokenHash : null);
  }

  clearAttempts('admin', ip);
  res.json({ ok: true, changed, sessionsRevoked });
});

// ---------------------------------------------------------------------------
// Statistik
// ---------------------------------------------------------------------------

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

router.get('/admin/stats', requireAdmin, (_req, res) => {
  const persons = db.prepare('SELECT COUNT(*) AS n FROM persons WHERE is_partner = 0').get().n;
  const partners = db.prepare('SELECT COUNT(*) AS n FROM persons WHERE is_partner = 1').get().n;
  const unions = db.prepare('SELECT COUNT(*) AS n FROM unions').get().n;
  const photos = db.prepare('SELECT COUNT(*) AS n FROM photos').get().n;
  const tags = db.prepare('SELECT COUNT(*) AS n FROM photo_tags').get().n;
  const portraits = db.prepare("SELECT COUNT(*) AS n FROM persons WHERE portrait != ''").get().n;

  // WAL-Datei mitzaehlen, sonst wirkt die DB nach vielen Schreibvorgaengen zu klein.
  const dbSizeBytes = fileSize(DB_FILE) + fileSize(`${DB_FILE}-wal`);

  res.json({ persons, partners, unions, photos, tags, portraits, dbSizeBytes });
});

// ---------------------------------------------------------------------------
// Einstellungen (SPEC 4 "Einstellungen")
// ---------------------------------------------------------------------------

/**
 * Einzige Stelle, an der aus dem Familiennamen der App-Titel wird.
 * Frontend und Login-Gate leiten den Titel NICHT selbst ab.
 */
function appTitleFor(familyName) {
  return familyName ? `${familyName} Stammbaum` : 'Stammbaum';
}

/** Aktueller Stand aus dem Key-Value-Speicher; fehlender Key = leer. */
function currentSettings() {
  const familyName = getSetting(FAMILY_NAME_KEY) || '';
  return { familyName, appTitle: appTitleFor(familyName) };
}

/**
 * Steuerzeichen und Zeilenumbrueche entfernen, Rest trimmen.
 * Bewusst durch ein Leerzeichen ersetzt statt ersatzlos gestrichen, damit aus
 * "Meier\nHof" nicht "MeierHof" wird; danach werden Whitespace-Folgen
 * zusammengezogen. Kein HTML-Filter noetig — das Frontend setzt `textContent`.
 */
function cleanFamilyName(value) {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'invalid_family_name', 'Der Familienname ist ungueltig.');
  }
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F\u0085\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length > FAMILY_NAME_MAX) {
    throw new ApiError(
      400,
      'family_name_too_long',
      `Der Familienname darf hoechstens ${FAMILY_NAME_MAX} Zeichen lang sein.`
    );
  }
  return cleaned;
}

// Bewusst OEFFENTLICH, ohne Session: Die Anmeldeseite zeigt den Familiennamen,
// damit die Familie sofort sieht, dass sie am richtigen Ort ist. Der Nachname
// ist damit fuer jeden lesbar, der die Adresse kennt — das ist so gewollt.
// Es werden ausschliesslich diese beiden Felder ausgeliefert, nie mehr.
publicRouter.get('/settings', (_req, res) => {
  res.json(currentSettings());
});

router.post('/admin/settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  if (!Object.prototype.hasOwnProperty.call(body, 'familyName')) {
    throw new ApiError(400, 'invalid_body', 'Es wurde kein Familienname gesendet.');
  }
  // Leer ist ausdruecklich erlaubt und setzt auf den Produktnamen zurueck.
  setSetting(FAMILY_NAME_KEY, cleanFamilyName(body.familyName));
  res.json(currentSettings());
});

module.exports = { router, publicRouter };
