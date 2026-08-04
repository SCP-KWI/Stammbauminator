'use strict';

/**
 * Gemeinsame Bausteine fuer alle Routen: Fehlerklasse, kleine Validierungs-
 * helfer, Upload-Regeln (MIME, Groesse, serverseitiger Dateiname) und die
 * Bildpruefung.
 *
 * Frueher lagen diese Helfer in routes/photos.js und wurden von routes/tree.js
 * dort importiert — eine Route haengte also an einer anderen Route. Jetzt
 * importieren beide aus diesem Modul.
 */

const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');

const { UPLOAD_DIR } = require('./db');

// ---------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------

/**
 * Von den Routen geworfen; der zentrale Fehler-Handler in index.js erkennt
 * solche Fehler an `status` + `code` und antwortet mit { error, message }.
 */
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Validierung
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

/**
 * Erlaubt '', 'YYYY', 'YYYY-MM', 'YYYY-MM-DD'. Alles andere -> 400.
 */
function validateDate(value, label) {
  const s = String(value ?? '').trim();
  if (s === '') return '';
  if (!DATE_RE.test(s)) {
    throw new ApiError(
      400,
      'invalid_date',
      `${label} muss im Format JJJJ, JJJJ-MM oder JJJJ-MM-TT angegeben werden.`
    );
  }
  const [y, m, d] = s.split('-').map(Number);
  if (y < 1 || y > 3000) {
    throw new ApiError(400, 'invalid_date', `${label} enthaelt ein unrealistisches Jahr.`);
  }
  if (m !== undefined && (m < 1 || m > 12)) {
    throw new ApiError(400, 'invalid_date', `${label} enthaelt einen ungueltigen Monat.`);
  }
  if (d !== undefined && (d < 1 || d > 31)) {
    throw new ApiError(400, 'invalid_date', `${label} enthaelt einen ungueltigen Tag.`);
  }
  return s;
}

/** Trimmt und begrenzt die Laenge (stille Kuerzung, wie in SPEC 4 beschrieben). */
function cleanText(value, max) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function readId(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ApiError(400, 'invalid_id', `${label} ist ungueltig.`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Upload-Regeln
// ---------------------------------------------------------------------------

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB laut SPEC

/** Erlaubte MIME-Typen und die serverseitig vergebene Extension. */
const ALLOWED_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/** Extension -> MIME, fuer Portraits (persons speichert nur den Dateinamen). */
const MIME_BY_EXT = Object.fromEntries(
  Object.entries(ALLOWED_MIME).map(([mime, ext]) => [ext, mime])
);

/** Nur UUID-Dateinamen mit erlaubter Extension — verhindert Path-Traversal. */
const FILENAME_RE = /^[a-f0-9-]+\.(jpg|png|webp)$/;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 20 },
  fileFilter(_req, file, cb) {
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_MIME, file.mimetype)) {
      cb(new ApiError(400, 'invalid_mime', 'Erlaubt sind nur JPEG-, PNG- und WebP-Bilder.'));
      return;
    }
    cb(null, true);
  },
});

// ---------------------------------------------------------------------------
// Bildpruefung
// ---------------------------------------------------------------------------

/**
 * Kleiner als das gilt nichts als Bild — ein echtes JPEG/PNG/WebP hat schon
 * fuer Kopf und Abschluss mehr Bytes noetig.
 */
const MIN_IMAGE_BYTES = 100;

/** Fehlschlag-Ergebnis; `ok: false` heisst immer 400 invalid_image. */
const INVALID = { ok: false, width: 0, height: 0 };

/** SOF-Marker (Bildrahmen). Ausgenommen sind DHT (C4), JPG (C8) und DAC (CC). */
function isSofMarker(marker) {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

/**
 * JPEG: SOI am Anfang, EOI am Ende, und die Segmentkette muss bis zu einem
 * SOF-Marker durchlaufen. Damit reicht es nicht mehr, einer beliebigen Datei
 * drei Magic Bytes voranzustellen.
 */
function inspectJpeg(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return INVALID;
  // EOI: die letzten zwei Bytes. Kleine Toleranz fuer Kameras, die noch ein
  // paar Fuellbytes anhaengen.
  let hasEoi = false;
  for (let i = buf.length - 2; i >= buf.length - 8 && i >= 2; i--) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd9) {
      hasEoi = true;
      break;
    }
  }
  if (!hasEoi) return INVALID;

  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) return INVALID; // Kette gerissen -> kein gueltiges JPEG
    let marker = buf[i + 1];
    // 0xFF darf als Fuellbyte mehrfach vorkommen.
    while (marker === 0xff && i + 2 < buf.length) {
      i += 1;
      marker = buf[i + 1];
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // Marker ohne Nutzlast
      continue;
    }
    if (marker === 0xd9) return INVALID; // EOI vor jedem SOF -> kein Bild
    if (marker === 0xda) return INVALID; // Bilddaten beginnen ohne SOF davor
    if (i + 3 >= buf.length) return INVALID;
    const length = buf.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > buf.length) return INVALID;
    if (isSofMarker(marker)) {
      if (length < 8) return INVALID;
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      if (width < 1 || height < 1) return INVALID;
      return { ok: true, width, height };
    }
    i += 2 + length;
  }
  return INVALID;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * PNG: 8-Byte-Signatur, danach zwingend der IHDR-Chunk (dort stehen die Masse),
 * und am Dateiende der IEND-Chunk.
 */
function inspectPng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return INVALID;
  if (buf.readUInt32BE(8) !== 13) return INVALID; // IHDR ist immer 13 Bytes lang
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return INVALID;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width < 1 || height < 1) return INVALID;
  // IEND steht als letzter Chunk: 4 Byte Laenge, 'IEND', 4 Byte CRC.
  if (buf.toString('ascii', buf.length - 8, buf.length - 4) !== 'IEND') return INVALID;
  return { ok: true, width, height };
}

const WEBP_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X']);

/**
 * WebP: RIFF-Container, dessen angegebene Laenge zur Dateigroesse passen muss,
 * danach ein bekannter Bild-Chunk. Die Masse holen wir aus dem jeweiligen
 * Chunk-Kopf.
 */
function inspectWebp(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return INVALID;
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return INVALID;
  const riffLength = buf.readUInt32LE(4);
  // RIFF-Chunks werden auf gerade Laenge aufgefuellt — 2 Byte Toleranz.
  if (Math.abs(buf.length - (8 + riffLength)) > 2) return INVALID;
  const chunk = buf.toString('ascii', 12, 16);
  if (!WEBP_CHUNKS.has(chunk)) return INVALID;

  let width = 0;
  let height = 0;
  if (chunk === 'VP8 ' && buf.length >= 30) {
    // Lossy: 3 Byte Frame-Tag, dann der Sync-Code 9D 01 2A.
    if (buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      width = buf.readUInt16LE(26) & 0x3fff;
      height = buf.readUInt16LE(28) & 0x3fff;
    }
  } else if (chunk === 'VP8L' && buf.length >= 25) {
    // Lossless: Signaturbyte 0x2F, danach 14 Bit Breite und 14 Bit Hoehe.
    if (buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    }
  } else if (chunk === 'VP8X' && buf.length >= 30) {
    // Erweitert: Canvas-Masse als je 24 Bit (little endian), minus 1 gespeichert.
    width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
    height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
  }
  return { ok: true, width, height };
}

/**
 * Prueft, ob `buf` wirklich ein Bild des gemeldeten Typs ist, und liest dabei
 * die Masse aus. Rueckgabe: { ok, width, height } — width/height koennen 0
 * sein, wenn sie sich nicht ermitteln liessen.
 */
function inspectImage(buf, mime) {
  if (!Buffer.isBuffer(buf) || buf.length < MIN_IMAGE_BYTES) return INVALID;
  if (mime === 'image/jpeg') return inspectJpeg(buf);
  if (mime === 'image/png') return inspectPng(buf);
  if (mime === 'image/webp') return inspectWebp(buf);
  return INVALID;
}

// ---------------------------------------------------------------------------
// Dateien
// ---------------------------------------------------------------------------

/** Entfernt Upload-Dateien; fehlende Dateien sind kein Fehler. */
function removeFiles(filenames) {
  for (const name of filenames) {
    if (!name || !FILENAME_RE.test(name)) continue;
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, name));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Eine verwaiste Datei darf die bereits committete Aenderung nicht kippen.
        console.error('[stammbaum] Datei konnte nicht geloescht werden:', name, err);
      }
    }
  }
}

module.exports = {
  ApiError,
  validateDate,
  cleanText,
  readId,
  MAX_UPLOAD_BYTES,
  ALLOWED_MIME,
  MIME_BY_EXT,
  FILENAME_RE,
  MIN_IMAGE_BYTES,
  upload,
  inspectImage,
  removeFiles,
};
