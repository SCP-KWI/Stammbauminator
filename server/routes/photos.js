'use strict';

/**
 * Foto-Routen: Album, Upload, Tags und das geschuetzte Ausliefern der Uploads.
 * Siehe SPEC.md Abschnitt 4 (Fotos).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const { db, UPLOAD_DIR } = require('../db');
const { requireAdmin, requireAuth } = require('../auth');
// Fehlerklasse, Validierungs- und Upload-Helfer sind fuer alle Routen dieselben.
const {
  ApiError,
  validateDate,
  cleanText,
  readId,
  MAX_UPLOAD_BYTES,
  ALLOWED_MIME,
  MIME_BY_EXT,
  FILENAME_RE,
  upload,
  inspectImage,
} = require('../uploads');

const router = express.Router();
const uploadsRouter = express.Router();

/**
 * Obergrenzen, damit ein Missgeschick (oder ein Skript) die Platte des
 * Servers nicht volllaufen laesst. Grosszuegig genug fuer ein
 * Familienalbum, klein genug fuer ein paar GB Uploads.
 */
const MAX_PHOTOS = 2000;
const MAX_TAGS_PER_PHOTO = 200;

// ---------------------------------------------------------------------------
// Validierung
// ---------------------------------------------------------------------------

/** Tag-Koordinaten sind relativ zum Bild und werden hart auf 0..1 begrenzt. */
function readUnitCoord(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ApiError(400, 'invalid_coordinate', `${label} muss eine Zahl sein.`);
  }
  return Math.min(1, Math.max(0, n));
}

function readDimension(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(100000, Math.trunc(n));
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toTag(row) {
  return { id: row.id, personId: row.person_id, x: row.x, y: row.y };
}

function toPhoto(row, tags) {
  return {
    id: row.id,
    title: row.title,
    url: `/uploads/${row.filename}`,
    width: row.width,
    height: row.height,
    takenAt: row.taken_at,
    sortOrder: row.sort_order,
    tags: tags || [],
  };
}

function loadPhoto(id) {
  const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  if (!row) return null;
  const tags = db
    .prepare('SELECT * FROM photo_tags WHERE photo_id = ? ORDER BY id')
    .all(id)
    .map(toTag);
  return toPhoto(row, tags);
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Laeuft VOR `upload.single`, damit eine Anfrage ueber der Obergrenze gar nicht
 * erst 15 MB in den Speicher zieht und nichts auf die Platte geschrieben wird.
 */
function requirePhotoCapacity(_req, _res, next) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM photos').get().n;
  if (count >= MAX_PHOTOS) {
    next(
      new ApiError(
        409,
        'photo_limit',
        `Es sind bereits ${MAX_PHOTOS} Fotos erfasst — mehr fasst das Album nicht.`
      )
    );
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Routen: Fotos
// ---------------------------------------------------------------------------

router.get('/photos', (_req, res) => {
  const photos = db.prepare('SELECT * FROM photos ORDER BY sort_order, id').all();
  const tagRows = db.prepare('SELECT * FROM photo_tags ORDER BY id').all();
  const byPhoto = new Map();
  for (const t of tagRows) {
    if (!byPhoto.has(t.photo_id)) byPhoto.set(t.photo_id, []);
    byPhoto.get(t.photo_id).push(toTag(t));
  }
  res.json(photos.map((p) => toPhoto(p, byPhoto.get(p.id) || [])));
});

router.post('/photos', requireAdmin, requirePhotoCapacity, upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) {
    throw new ApiError(400, 'no_file', 'Es wurde keine Bilddatei mitgeschickt.');
  }
  const ext = ALLOWED_MIME[file.mimetype];
  if (!ext) {
    throw new ApiError(400, 'invalid_mime', 'Erlaubt sind nur JPEG-, PNG- und WebP-Bilder.');
  }
  const image = inspectImage(file.buffer, file.mimetype);
  if (!image.ok) {
    throw new ApiError(
      400,
      'invalid_image',
      'Die Datei ist kein gueltiges JPEG-, PNG- oder WebP-Bild.'
    );
  }

  const title = cleanText(req.body?.title, 500);
  const takenAt = validateDate(req.body?.takenAt, 'Das Aufnahmedatum');
  // Die Masse stammen aus dem Bildkopf; die Angabe des Clients ist nur der
  // Rueckfall fuer Formate, aus denen sich nichts auslesen liess.
  const width = image.width > 0 ? image.width : readDimension(req.body?.width);
  const height = image.height > 0 ? image.height : readDimension(req.body?.height);

  // Dateiname immer serverseitig vergeben — der Client-Name wird nie verwendet.
  const filename = `${crypto.randomUUID()}${ext}`;
  const target = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(target, file.buffer, { flag: 'wx' });

  try {
    const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM photos').get();
    const info = db
      .prepare(
        `INSERT INTO photos (title, filename, mime, width, height, taken_at, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        title,
        filename,
        file.mimetype,
        width,
        height,
        takenAt,
        maxRow.m + 1,
        new Date().toISOString()
      );
    res.status(201).json(loadPhoto(Number(info.lastInsertRowid)));
  } catch (err) {
    // DB-Eintrag fehlgeschlagen -> keine verwaiste Datei zuruecklassen
    try {
      fs.unlinkSync(target);
    } catch {
      /* egal */
    }
    throw err;
  }
});

router.patch('/photos/:id', requireAdmin, (req, res) => {
  const id = readId(req.params.id, 'Die Foto-ID');
  const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  if (!row) {
    throw new ApiError(404, 'photo_not_found', 'Dieses Foto wurde nicht gefunden.');
  }
  const body = req.body || {};
  const sets = [];
  const values = [];

  if (Object.prototype.hasOwnProperty.call(body, 'title')) {
    sets.push('title = ?');
    values.push(cleanText(body.title, 500));
  }
  if (Object.prototype.hasOwnProperty.call(body, 'takenAt')) {
    sets.push('taken_at = ?');
    values.push(validateDate(body.takenAt, 'Das Aufnahmedatum'));
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sortOrder')) {
    const n = Number(body.sortOrder);
    if (!Number.isFinite(n)) {
      throw new ApiError(400, 'invalid_sort_order', 'Die Sortierung muss eine Zahl sein.');
    }
    sets.push('sort_order = ?');
    values.push(Math.max(0, Math.min(100000, Math.trunc(n))));
  }

  if (sets.length > 0) {
    values.push(id);
    db.prepare(`UPDATE photos SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }
  res.json(loadPhoto(id));
});

router.delete('/photos/:id', requireAdmin, (req, res) => {
  const id = readId(req.params.id, 'Die Foto-ID');
  const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  if (!row) {
    throw new ApiError(404, 'photo_not_found', 'Dieses Foto wurde nicht gefunden.');
  }
  db.prepare('DELETE FROM photo_tags WHERE photo_id = ?').run(id);
  db.prepare('DELETE FROM photos WHERE id = ?').run(id);

  if (FILENAME_RE.test(row.filename)) {
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, row.filename));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Routen: Tags
// ---------------------------------------------------------------------------

router.post('/photos/:id/tags', (req, res) => {
  const photoId = readId(req.params.id, 'Die Foto-ID');
  const photo = db.prepare('SELECT id FROM photos WHERE id = ?').get(photoId);
  if (!photo) {
    throw new ApiError(404, 'photo_not_found', 'Dieses Foto wurde nicht gefunden.');
  }
  const body = req.body || {};
  const personId = readId(body.personId, 'Die Personen-ID');
  const person = db.prepare('SELECT id FROM persons WHERE id = ?').get(personId);
  if (!person) {
    throw new ApiError(404, 'person_not_found', 'Diese Person wurde nicht gefunden.');
  }
  const x = readUnitCoord(body.x, 'Die X-Position');
  const y = readUnitCoord(body.y, 'Die Y-Position');

  const tagCount = db
    .prepare('SELECT COUNT(*) AS n FROM photo_tags WHERE photo_id = ?')
    .get(photoId).n;
  if (tagCount >= MAX_TAGS_PER_PHOTO) {
    throw new ApiError(
      409,
      'tag_limit',
      `Auf diesem Foto sind bereits ${MAX_TAGS_PER_PHOTO} Personen markiert — mehr gehen nicht.`
    );
  }

  const existing = db
    .prepare('SELECT id FROM photo_tags WHERE photo_id = ? AND person_id = ?')
    .get(photoId, personId);
  if (existing) {
    throw new ApiError(
      409,
      'tag_exists',
      'Diese Person ist auf dem Foto bereits markiert.'
    );
  }

  const info = db
    .prepare(
      'INSERT INTO photo_tags (photo_id, person_id, x, y, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(photoId, personId, x, y, new Date().toISOString());
  const row = db.prepare('SELECT * FROM photo_tags WHERE id = ?').get(Number(info.lastInsertRowid));
  res.status(201).json(toTag(row));
});

router.patch('/tags/:id', (req, res) => {
  const id = readId(req.params.id, 'Die Markierungs-ID');
  const row = db.prepare('SELECT * FROM photo_tags WHERE id = ?').get(id);
  if (!row) {
    throw new ApiError(404, 'tag_not_found', 'Diese Markierung wurde nicht gefunden.');
  }
  const body = req.body || {};
  const x = Object.prototype.hasOwnProperty.call(body, 'x')
    ? readUnitCoord(body.x, 'Die X-Position')
    : row.x;
  const y = Object.prototype.hasOwnProperty.call(body, 'y')
    ? readUnitCoord(body.y, 'Die Y-Position')
    : row.y;
  db.prepare('UPDATE photo_tags SET x = ?, y = ? WHERE id = ?').run(x, y, id);
  res.json(toTag(db.prepare('SELECT * FROM photo_tags WHERE id = ?').get(id)));
});

router.delete('/tags/:id', (req, res) => {
  const id = readId(req.params.id, 'Die Markierungs-ID');
  const row = db.prepare('SELECT id FROM photo_tags WHERE id = ?').get(id);
  if (!row) {
    throw new ApiError(404, 'tag_not_found', 'Diese Markierung wurde nicht gefunden.');
  }
  db.prepare('DELETE FROM photo_tags WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Geschuetztes Ausliefern der Uploads
// ---------------------------------------------------------------------------

uploadsRouter.get('/:filename', requireAuth, (req, res) => {
  const name = String(req.params.filename || '');
  if (!FILENAME_RE.test(name)) {
    throw new ApiError(404, 'not_found', 'Diese Datei gibt es nicht.');
  }
  // Ausgeliefert wird nur, was auch in der Datenbank steht: Albumfoto ODER Portrait.
  const photo = db.prepare('SELECT mime FROM photos WHERE filename = ?').get(name);
  let mime = photo ? photo.mime : null;
  if (!mime) {
    const portrait = db.prepare('SELECT id FROM persons WHERE portrait = ?').get(name);
    if (portrait) mime = MIME_BY_EXT[path.extname(name).toLowerCase()] || null;
  }
  if (!mime) {
    throw new ApiError(404, 'not_found', 'Diese Datei gibt es nicht.');
  }
  res.type(mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  // Der Name ist serverseitig vergeben und passt auf FILENAME_RE — er kann
  // keine Anfuehrungszeichen oder Steuerzeichen enthalten.
  // `nosniff` setzt die App global, hier nicht noetig.
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  res.sendFile(path.join(UPLOAD_DIR, name), (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: 'not_found', message: 'Diese Datei gibt es nicht.' });
    }
  });
});

module.exports = {
  router,
  uploadsRouter,
  MAX_UPLOAD_BYTES,
};
