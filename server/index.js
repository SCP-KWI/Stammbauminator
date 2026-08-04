'use strict';

/**
 * Stammbauminator — Express-App.
 * Static-Serving, Auth-Routen, API-Mounting, Fehlerbehandlung, Start.
 */

const path = require('node:path');
const express = require('express');

const { DATA_DIR } = require('./db');
const auth = require('./auth');
const treeRoutes = require('./routes/tree');
const photoRoutes = require('./routes/photos');
const adminRoutes = require('./routes/admin');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();

// Laeuft hinter einem Reverse Proxy.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.set('etag', 'strong');

app.use(express.json({ limit: '256kb' }));

// ---------------------------------------------------------------------------
// Sicherheits-Header (vor express.static, damit sie auf ALLEN Antworten stehen)
// ---------------------------------------------------------------------------

// Kein 'unsafe-inline', weder fuer Skripte noch fuer Stile:
//   - Das frueher inline eingebettete `App.start()` steht jetzt in js/boot.js.
//   - Das Personen-Panel haengte seine Stile zur Laufzeit als <style>-Block ein;
//     das faellt unter style-src und steht jetzt in css/person.css.
// `img-src data:` ist noetig, weil das Favicon ein Inline-SVG ist.
// `img-src blob:` ebenfalls: der Adminbereich zeigt vor dem Hochladen eine
// Vorschau aus `URL.createObjectURL(datei)`, und ImageTools faellt auf
// `<img src=blob:…>` zurueck, wenn `createImageBitmap` fehlt.
// `el.style.x = …` aus dem Frontend faellt nicht unter style-src (CSSOM statt
// Markup), das bleibt also auch ohne 'unsafe-inline' erlaubt.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // HSTS nur im TLS-Betrieb — lokal ueber http wuerde es den Browser aussperren.
  if (auth.useSecureCookies()) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// App-Shell ist oeffentlich, die Daten dahinter nicht.
// Bewusst vor attachSession, damit statische Dateien keine DB-Abfrage ausloesen.
app.use(
  express.static(PUBLIC_DIR, {
    index: 'index.html',
    extensions: false,
    maxAge: 0,
  })
);

app.use(auth.attachSession);

// ---------------------------------------------------------------------------
// Auth-Routen (SPEC 4)
// ---------------------------------------------------------------------------

const authRouter = express.Router();

authRouter.get('/session', (req, res) => {
  res.json({
    authenticated: Boolean(req.session),
    role: req.session ? req.session.role : null,
    adminUntil: req.session ? req.session.adminUntil || '' : '',
  });
});

// Express 5 faengt abgelehnte Promises aus Route-Handlern selbst ab, darum
// duerfen die Handler async sein (verifyPassword rechnet im Threadpool).
authRouter.post('/login', auth.rateLimit('login'), async (req, res) => {
  const ip = req.clientIp;
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!(await auth.verifyPassword(password, auth.getSetting('family_password') || ''))) {
    auth.recordAttempt('login', ip, false);
    return res.status(401).json({
      error: 'wrong_password',
      message: 'Das Passwort stimmt nicht.',
    });
  }
  auth.clearAttempts('login', ip);
  const token = auth.createSession('family');
  auth.setSessionCookie(res, token);
  res.json({ role: 'family' });
});

authRouter.post('/admin', auth.rateLimit('admin'), auth.requireAuth, async (req, res) => {
  const ip = req.clientIp;
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!(await auth.verifyPassword(password, auth.getSetting('admin_password') || ''))) {
    auth.recordAttempt('admin', ip, false);
    return res.status(403).json({
      error: 'wrong_password',
      message: 'Das Adminpasswort stimmt nicht.',
    });
  }
  auth.clearAttempts('admin', ip);
  // Adminmodus ist befristet; danach faellt die Session auf 'family' zurueck.
  const adminUntil = auth.grantAdmin(req.session.tokenHash);
  res.json({ role: 'admin', adminUntil });
});

authRouter.post('/admin/leave', auth.requireAuth, (req, res) => {
  auth.revokeAdmin(req.session.tokenHash);
  res.json({ role: 'family', adminUntil: '' });
});

authRouter.post('/logout', (req, res) => {
  if (req.session) auth.destroySession(req.session.tokenHash);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.use('/api/auth', authRouter);

// Oeffentlich, ohne Session: Die Anmeldeseite braucht den App-Titel.
app.use('/api', adminRoutes.publicRouter);

// ---------------------------------------------------------------------------
// Geschuetzte API
// ---------------------------------------------------------------------------

app.use('/api', auth.requireAuth, treeRoutes);
app.use('/api', auth.requireAuth, photoRoutes.router);
app.use('/api', auth.requireAuth, adminRoutes.router);

// Uploads nur mit gueltiger Session (Auth-Check steckt im Router selbst).
app.use('/uploads', photoRoutes.uploadsRouter);

// ---------------------------------------------------------------------------
// 404 und Fehlerbehandlung
// ---------------------------------------------------------------------------

app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
    return res.status(404).json({
      error: 'not_found',
      message: 'Diese Adresse gibt es nicht.',
    });
  }
  // Alles andere auf die App-Shell zurueckfallen lassen.
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
      if (err && !res.headersSent) res.status(404).type('txt').send('Nicht gefunden');
    });
  }
  res.status(404).json({ error: 'not_found', message: 'Diese Adresse gibt es nicht.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  // Von den Routen geworfene ApiError-Objekte (status + code).
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600 && err.code) {
    return res.status(err.status).json({
      error: String(err.code),
      message: err.message || 'Die Anfrage konnte nicht verarbeitet werden.',
    });
  }

  // Multer
  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'file_too_large',
        message: 'Das Bild ist zu gross (maximal 15 MB).',
      });
    }
    return res.status(400).json({
      error: 'upload_failed',
      message: 'Der Upload war nicht gueltig.',
    });
  }

  // Body-Parser
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'invalid_json',
      message: 'Die gesendeten Daten waren kein gueltiges JSON.',
    });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'payload_too_large',
      message: 'Die gesendeten Daten sind zu gross.',
    });
  }

  // SQLite-Constraints, die trotz Vorpruefung durchrutschen.
  if (err && typeof err.message === 'string' && /UNIQUE constraint failed/.test(err.message)) {
    return res.status(409).json({
      error: 'conflict',
      message: 'Dieser Eintrag existiert bereits.',
    });
  }

  console.error('[stammbaum] Unerwarteter Fehler:', err);
  res.status(500).json({
    error: 'server_error',
    message: 'Es ist ein unerwarteter Fehler aufgetreten.',
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

auth.startCleanupTimer();

const server = app.listen(PORT, () => {
  console.log(`[stammbaum] laeuft auf Port ${PORT} (Daten: ${DATA_DIR})`);
});

function shutdown(signal) {
  console.log(`[stammbaum] ${signal} empfangen, fahre herunter.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
