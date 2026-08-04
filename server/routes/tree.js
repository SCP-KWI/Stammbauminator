'use strict';

/**
 * Stammbaum-Routen: Personen und Unions.
 * Siehe SPEC.md Abschnitt 2 (Invarianten) und 4 (API).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { db, transaction, rootPersonId, UPLOAD_DIR } = require('../db');
const { requireAdmin } = require('../auth');
// Fehlerklasse, Validierungs- und Upload-Helfer sind fuer alle Routen dieselben;
// fuer Portraits gelten damit dieselben Regeln wie fuer Albumfotos
// (MIME, Bildpruefung, 15 MB, serverseitiger Dateiname).
const {
  ApiError,
  validateDate,
  cleanText,
  readId,
  ALLOWED_MIME,
  upload,
  inspectImage,
  removeFiles,
} = require('../uploads');

const router = express.Router();

/**
 * Obergrenze fuer die Gesamtzahl Personen. Ohne sie kann jede:r mit dem
 * Familienpasswort unbegrenzt Datensaetze (und damit Portraits) anlegen.
 */
const MAX_PERSONS = 2000;

// ---------------------------------------------------------------------------
// Validierung
// ---------------------------------------------------------------------------

/**
 * personFields laut SPEC. Reihenfolge = Spaltenreihenfolge beim Insert.
 * `max` gilt fuer Textfelder, `date` markiert Datumsfelder.
 */
const PERSON_FIELDS = [
  { key: 'firstName', col: 'first_name', max: 60, required: true, label: 'Vorname' },
  { key: 'lastName', col: 'last_name', max: 500, label: 'Nachname' },
  { key: 'maidenName', col: 'maiden_name', max: 500, label: 'Ledigname' },
  { key: 'birthDate', col: 'birth_date', date: true, label: 'Geburtsdatum' },
  { key: 'deathDate', col: 'death_date', date: true, label: 'Todesdatum' },
  { key: 'address', col: 'address', max: 2000, label: 'Adresse' },
  { key: 'phone', col: 'phone', max: 500, label: 'Telefon' },
  { key: 'email', col: 'email', max: 500, label: 'E-Mail' },
  { key: 'notes', col: 'notes', max: 2000, label: 'Notizen' },
];

/**
 * Baut aus einem beliebigen Body ein sauberes Feld-Objekt.
 * Unbekannte Felder werden ignoriert (nie durchgereicht).
 * `partial=true` -> nur mitgeschickte Felder, `firstName` nur pruefen wenn vorhanden.
 */
function readPersonFields(body, partial) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_body', 'Es wurden keine gueltigen Daten gesendet.');
  }
  const out = {};
  for (const f of PERSON_FIELDS) {
    const present = Object.prototype.hasOwnProperty.call(body, f.key);
    if (partial && !present) continue;
    const raw = present ? body[f.key] : '';
    if (f.date) {
      out[f.key] = validateDate(raw, f.label);
    } else {
      const val = cleanText(raw, f.max);
      if (f.required && val === '') {
        throw new ApiError(400, 'invalid_first_name', 'Der Vorname darf nicht leer sein.');
      }
      if (f.required && typeof raw === 'string' && raw.trim().length > f.max) {
        throw new ApiError(
          400,
          'invalid_first_name',
          `Der Vorname darf hoechstens ${f.max} Zeichen lang sein.`
        );
      }
      out[f.key] = val;
    }
  }
  return out;
}

function readBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

// ---------------------------------------------------------------------------
// Mapping DB -> JSON (camelCase)
// ---------------------------------------------------------------------------

function toPerson(row) {
  if (!row) return null;
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    maidenName: row.maiden_name,
    birthDate: row.birth_date,
    deathDate: row.death_date,
    address: row.address,
    phone: row.phone,
    email: row.email,
    notes: row.notes,
    parentUnionId: row.parent_union_id === null ? null : row.parent_union_id,
    isPartner: row.is_partner === 1,
    sortOrder: row.sort_order,
    // Einzige Stelle, an der aus dem Dateinamen eine URL wird.
    portraitUrl: row.portrait ? `/uploads/${row.portrait}` : '',
  };
}

function toUnion(row) {
  if (!row) return null;
  return {
    id: row.id,
    personId: row.person_id,
    partnerId: row.partner_id === null ? null : row.partner_id,
    side: row.side,
    isCurrent: row.is_current === 1,
    note: row.note,
  };
}

function getPersonRow(id) {
  return db.prepare('SELECT * FROM persons WHERE id = ?').get(id) || null;
}

function getUnionRow(id) {
  return db.prepare('SELECT * FROM unions WHERE id = ?').get(id) || null;
}

// ---------------------------------------------------------------------------
// Invarianten-Helfer
// ---------------------------------------------------------------------------

/**
 * Sucht auf einer Seite einer Person die Union, an der bereits Kinder haengen.
 *
 * Kernregel des Datenmodells (SPEC 2): Pro Seite sind beliebig viele
 * Partnerschaften erlaubt, aber hoechstens EINE mit Kindern — der Platz unter
 * der Person gibt es je Seite nur einmal. `exceptUnionId` blendet die Union
 * aus, um die es gerade geht.
 *
 * Gibt die ID der blockierenden Union zurueck oder null.
 */
function childUnionOnSide(personId, side, exceptUnionId) {
  const except = exceptUnionId === undefined ? null : exceptUnionId;
  const row = db
    .prepare(
      `SELECT u.id AS id
         FROM unions u
        WHERE u.person_id = ?
          AND u.side = ?
          AND (? IS NULL OR u.id != ?)
          AND EXISTS (SELECT 1 FROM persons p WHERE p.parent_union_id = u.id)
        ORDER BY u.id
        LIMIT 1`
    )
    .get(personId, side, except, except);
  return row ? row.id : null;
}

/** Haengen an dieser Union Kinder? */
function unionHasChildren(unionId) {
  return Boolean(
    db.prepare('SELECT 1 AS x FROM persons WHERE parent_union_id = ? LIMIT 1').get(unionId)
  );
}

/** Genau eine Union pro Person darf is_current = 1 haben. */
function clearOtherCurrent(personId, keepUnionId) {
  db.prepare('UPDATE unions SET is_current = 0 WHERE person_id = ? AND id != ?').run(
    personId,
    keepUnionId
  );
}

/**
 * Sammelt rekursiv alle Personen, die beim Loeschen mitgehen:
 * die Seed-Personen selbst, deren Unions, deren eingeheiratete Partner:innen
 * und alle Nachkommen.
 *
 * Dass `u.partner_id` mit auf den Stapel kommt, ist der Grund, weshalb beim
 * Loeschen einer Blutlinien-Person keine beziehungslosen `is_partner = 1`-
 * Personen zurueckbleiben: Verschwindet eine Union, verschwindet auch die
 * Person, die nur ueber diese Union sichtbar war.
 */
function collectSubtree(seedPersonIds) {
  const personIds = new Set();
  const unionIds = new Set();
  const stack = [...seedPersonIds];
  const unionsOf = db.prepare('SELECT id, partner_id FROM unions WHERE person_id = ?');
  const childrenOf = db.prepare('SELECT id FROM persons WHERE parent_union_id = ?');

  while (stack.length > 0) {
    const pid = stack.pop();
    if (personIds.has(pid)) continue;
    personIds.add(pid);
    for (const u of unionsOf.all(pid)) {
      unionIds.add(u.id);
      if (u.partner_id !== null && !personIds.has(u.partner_id)) stack.push(u.partner_id);
      for (const c of childrenOf.all(u.id)) stack.push(c.id);
    }
  }
  return { personIds, unionIds };
}

/** IN (...)-Abfragen in Bloecken, damit die Parameterzahl beschraenkt bleibt. */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function countTagsFor(personIds) {
  let total = 0;
  for (const part of chunk(personIds, 400)) {
    const placeholders = part.map(() => '?').join(',');
    total += db
      .prepare(`SELECT COUNT(*) AS n FROM photo_tags WHERE person_id IN (${placeholders})`)
      .get(...part).n;
  }
  return total;
}

function namesFor(personIds, limit) {
  const names = [];
  for (const part of chunk(personIds, 400)) {
    if (names.length >= limit) break;
    const placeholders = part.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT first_name, last_name FROM persons WHERE id IN (${placeholders}) ORDER BY id`
      )
      .all(...part);
    for (const r of rows) {
      if (names.length >= limit) break;
      names.push(`${r.first_name} ${r.last_name}`.trim());
    }
  }
  return names;
}

/**
 * Loescht die Personen und gibt die Dateinamen ihrer Portraits zurueck.
 * Die Dateien werden bewusst erst nach dem Commit entfernt (siehe removeFiles).
 */
function deletePersons(personIds) {
  const portraits = [];
  for (const part of chunk(personIds, 400)) {
    const placeholders = part.map(() => '?').join(',');
    for (const r of db
      .prepare(`SELECT portrait FROM persons WHERE id IN (${placeholders}) AND portrait != ''`)
      .all(...part)) {
      portraits.push(r.portrait);
    }
    // photo_tags und unions haengen per ON DELETE CASCADE dran, wir loeschen sie
    // trotzdem explizit, damit das Verhalten nicht von den Pragmas abhaengt.
    db.prepare(`DELETE FROM photo_tags WHERE person_id IN (${placeholders})`).run(...part);
    db.prepare(`DELETE FROM unions WHERE person_id IN (${placeholders})`).run(...part);
    db.prepare(`DELETE FROM persons WHERE id IN (${placeholders})`).run(...part);
  }
  return portraits;
}

/**
 * Unions, in denen eine der zu loeschenden Personen die eingeheiratete
 * Partner:in ist. Muss VOR dem Loeschen aufgerufen werden — danach hat
 * `partner_id ... ON DELETE SET NULL` die Spur bereits verwischt.
 */
function unionIdsWithPartnerIn(personIds) {
  const ids = [];
  for (const part of chunk(personIds, 400)) {
    const placeholders = part.map(() => '?').join(',');
    for (const r of db
      .prepare(`SELECT id FROM unions WHERE partner_id IN (${placeholders})`)
      .all(...part)) {
      ids.push(r.id);
    }
  }
  return ids;
}

/**
 * Raeumt die Unions auf, deren Partner:in soeben geloescht wurde. Nach dem
 * Loeschen aufrufen, dann steht `partner_id` bereits auf NULL.
 *
 *   - keine Kinder -> Union loeschen. Sonst bliebe sie als Geisterbeziehung
 *     mit "Partner:in unbekannt" im Baum stehen.
 *   - Kinder vorhanden -> Union behalten (mit partner_id = NULL). Die Kinder
 *     stammen weiter vom verbleibenden Elternteil ab; `persons.parent_union_id`
 *     haengt an ON DELETE CASCADE, ein Loeschen wuerde sie samt ihrer gesamten
 *     Nachkommenschaft mitreissen. Der Zustand ist laut Datenmodell zulaessig
 *     (alleinerziehend / anderer Elternteil unbekannt).
 *
 * Unions, deren Anker ebenfalls geloescht wurde, sind bereits weg (`get`
 * liefert dann nichts), und eine Union, deren `partner_id` noch gesetzt ist,
 * wird nicht angefasst.
 */
function pruneChildlessPartnerUnions(unionIds) {
  const unionById = db.prepare('SELECT id, partner_id FROM unions WHERE id = ?');
  const anyChild = db.prepare('SELECT id FROM persons WHERE parent_union_id = ? LIMIT 1');
  const removeUnion = db.prepare('DELETE FROM unions WHERE id = ?');
  let removed = 0;
  for (const unionId of unionIds) {
    const union = unionById.get(unionId);
    if (!union || union.partner_id !== null) continue;
    if (anyChild.get(unionId)) continue;
    removeUnion.run(unionId);
    removed += 1;
  }
  return removed;
}

/**
 * Loescht Personen samt der dadurch leer gewordenen Partnerschaften.
 * Gibt die Dateinamen der Portraits zurueck (erst nach dem Commit entfernen).
 */
function deletePersonsAndCleanUnions(personIds) {
  const affectedUnions = unionIdsWithPartnerIn(personIds);
  const portraits = deletePersons(personIds);
  pruneChildlessPartnerUnions(affectedUnions);
  return portraits;
}

// ---------------------------------------------------------------------------
// Obergrenze
// ---------------------------------------------------------------------------

/** Wirft 409, sobald der Stammbaum voll ist. Vor jedem Anlegen aufrufen. */
function assertPersonCapacity() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM persons').get().n;
  if (count >= MAX_PERSONS) {
    throw new ApiError(
      409,
      'person_limit',
      `Es sind bereits ${MAX_PERSONS} Personen erfasst — mehr fasst der Stammbaum nicht.`
    );
  }
}

// ---------------------------------------------------------------------------
// Routen
// ---------------------------------------------------------------------------

router.get('/tree', (_req, res) => {
  const persons = db.prepare('SELECT * FROM persons ORDER BY id').all().map(toPerson);
  const unions = db.prepare('SELECT * FROM unions ORDER BY id').all().map(toUnion);
  res.json({ rootPersonId: rootPersonId(), persons, unions });
});

// --- Personen -------------------------------------------------------------

router.post('/persons', (req, res) => {
  assertPersonCapacity();
  const body = req.body || {};
  const parentUnionId = readId(body.parentUnionId, 'Die Eltern-Partnerschaft');
  const union = getUnionRow(parentUnionId);
  if (!union) {
    throw new ApiError(404, 'union_not_found', 'Die angegebene Partnerschaft existiert nicht.');
  }

  // Pro Seite darf nur EINE Partnerschaft Kinder haben (SPEC 2). Hat auf
  // derselben Seite derselben Person bereits eine ANDERE Union Kinder, ist der
  // Platz belegt. Hat die Zielunion selbst schon Kinder, ist alles in Ordnung —
  // darum blendet `exceptUnionId` sie aus.
  if (childUnionOnSide(union.person_id, union.side, union.id) !== null) {
    throw new ApiError(
      409,
      'side_has_children',
      'Auf dieser Seite hat bereits eine andere Partnerschaft Kinder. ' +
        'Kinder lassen sich pro Seite nur an eine Partnerschaft haengen.'
    );
  }

  const fields = readPersonFields(body, false);

  const person = transaction(() => {
    const maxRow = db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM persons WHERE parent_union_id = ?')
      .get(parentUnionId);
    const sortOrder = maxRow.m + 1;
    const info = db
      .prepare(
        `INSERT INTO persons
           (first_name, last_name, maiden_name, birth_date, death_date,
            address, phone, email, notes, parent_union_id, is_partner, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        fields.firstName,
        fields.lastName,
        fields.maidenName,
        fields.birthDate,
        fields.deathDate,
        fields.address,
        fields.phone,
        fields.email,
        fields.notes,
        parentUnionId,
        sortOrder,
        new Date().toISOString()
      );
    return getPersonRow(Number(info.lastInsertRowid));
  });

  res.status(201).json(toPerson(person));
});

router.patch('/persons/:id', (req, res) => {
  const id = readId(req.params.id, 'Die Personen-ID');
  const row = getPersonRow(id);
  if (!row) {
    throw new ApiError(404, 'person_not_found', 'Diese Person wurde nicht gefunden.');
  }
  const fields = readPersonFields(req.body || {}, true);

  const sets = [];
  const values = [];
  for (const f of PERSON_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields, f.key)) {
      sets.push(`${f.col} = ?`);
      values.push(fields[f.key]);
    }
  }
  // Zusatz zur SPEC: sortOrder ist per PATCH aenderbar. Die Geschwister
  // ordnen sich im Frontend nach dem Geburtsdatum (Store.compareChildren);
  // sortOrder entscheidet nur noch, wenn Datum UND Name gleich sind.
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'sortOrder')) {
    const n = Number(req.body.sortOrder);
    if (!Number.isFinite(n)) {
      throw new ApiError(400, 'invalid_sort_order', 'Die Sortierung muss eine Zahl sein.');
    }
    sets.push('sort_order = ?');
    values.push(Math.max(0, Math.min(100000, Math.trunc(n))));
  }

  if (sets.length > 0) {
    values.push(id);
    db.prepare(`UPDATE persons SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }
  res.json(toPerson(getPersonRow(id)));
});

// --- Portraits ------------------------------------------------------------
// Bewusst ohne requireAdmin: wer das Familienpasswort hat, darf Portraits
// pflegen — wie beim Anlegen von Personen (SPEC 4 "Portraits").

/**
 * Laeuft VOR `upload.single`: eine Anfrage fuer eine unbekannte Person soll
 * nicht erst bis zu 15 MB in den Speicher ziehen, nur um dann 404 zu werden.
 */
function loadPortraitPerson(req, _res, next) {
  try {
    const id = readId(req.params.id, 'Die Personen-ID');
    const row = getPersonRow(id);
    if (!row) {
      throw new ApiError(404, 'person_not_found', 'Diese Person wurde nicht gefunden.');
    }
    req.personId = id;
    req.personRow = row;
    next();
  } catch (err) {
    next(err);
  }
}

router.post('/persons/:id/portrait', loadPortraitPerson, upload.single('file'), (req, res) => {
  const id = req.personId;
  const row = req.personRow;

  const file = req.file;
  if (!file) {
    throw new ApiError(400, 'no_file', 'Es wurde keine Bilddatei mitgeschickt.');
  }
  const ext = ALLOWED_MIME[file.mimetype];
  if (!ext) {
    throw new ApiError(400, 'invalid_mime', 'Erlaubt sind nur JPEG-, PNG- und WebP-Bilder.');
  }
  if (!inspectImage(file.buffer, file.mimetype).ok) {
    throw new ApiError(
      400,
      'invalid_image',
      'Die Datei ist kein gueltiges JPEG-, PNG- oder WebP-Bild.'
    );
  }

  // Dateiname immer serverseitig vergeben — der Client-Name wird nie verwendet.
  const filename = `${crypto.randomUUID()}${ext}`;
  const target = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(target, file.buffer, { flag: 'wx' });

  try {
    db.prepare('UPDATE persons SET portrait = ? WHERE id = ?').run(filename, id);
  } catch (err) {
    try {
      fs.unlinkSync(target);
    } catch {
      /* keine verwaiste Datei zuruecklassen, Fehler dabei egal */
    }
    throw err;
  }

  // Ersetztes Portrait von der Platte nehmen.
  if (row.portrait && row.portrait !== filename) removeFiles([row.portrait]);

  res.json(toPerson(getPersonRow(id)));
});

router.delete('/persons/:id/portrait', (req, res) => {
  const id = readId(req.params.id, 'Die Personen-ID');
  const row = getPersonRow(id);
  if (!row) {
    throw new ApiError(404, 'person_not_found', 'Diese Person wurde nicht gefunden.');
  }
  if (row.portrait) {
    db.prepare("UPDATE persons SET portrait = '' WHERE id = ?").run(id);
    removeFiles([row.portrait]);
  }
  res.json(toPerson(getPersonRow(id)));
});

// Loeschen ist nicht mehr auf den Adminmodus beschraenkt: wer das Familien-
// Passwort hat, darf Personen entfernen (SPEC 4 "Stammbaum"). Die Rueckfrage
// passiert im Frontend durch Eintippen des Vornamens; serverseitig bleibt die
// Invariante "Wurzelperson ist unloeschbar" erzwungen.
/**
 * Personen, die mit dieser Loeschung verschwinden.
 * Eingeheiratete Personen haengen an keiner Blutlinie: nur sie selbst geht.
 */
function affectedPersonIds(row, id) {
  return row.is_partner === 1 ? [id] : [...collectSubtree([id]).personIds];
}

router.get('/persons/:id/impact', (req, res) => {
  const id = readId(req.params.id, 'Die Personen-ID');
  const row = getPersonRow(id);
  if (!row) {
    throw new ApiError(404, 'person_not_found', 'Diese Person wurde nicht gefunden.');
  }

  const ids = affectedPersonIds(row, id);

  res.json({
    persons: ids.length,
    tags: countTagsFor(ids),
    names: namesFor(ids, 50),
    // Ab zwei betroffenen Personen verlangt das Loeschen den Adminmodus. Das
    // Frontend kann damit vorab freischalten, statt in den 403 zu laufen.
    adminRequired: ids.length > 1,
  });
});

router.delete('/persons/:id', (req, res) => {
  const id = readId(req.params.id, 'Die Personen-ID');
  const row = getPersonRow(id);
  if (!row) {
    throw new ApiError(404, 'person_not_found', 'Diese Person wurde nicht gefunden.');
  }
  if (id === rootPersonId()) {
    throw new ApiError(
      409,
      'root_person',
      'Die Stammperson kann nicht geloescht werden.'
    );
  }

  // Eine einzelne Person darf jede:r mit dem Familienpasswort entfernen — die
  // Rueckfrage ist der eingetippte Vorname. Sobald aber Nachkommen oder eine
  // Partner:in mitgehen, ist es eine Massenloeschung: dafuer braucht es den
  // Adminmodus. Serverseitig erzwungen, nicht nur in der Oberflaeche.
  // Eigener Fehlercode: 'forbidden' bedeutet im Frontend "Adminmodus
  // abgelaufen" und wuerde hier die falsche Meldung ausloesen.
  if (affectedPersonIds(row, id).length > 1 && req.session.role !== 'admin') {
    throw new ApiError(
      403,
      'admin_required',
      'Mit dieser Person verschwinden auch ihre Nachkommen. Dafuer braucht es das Adminpasswort.'
    );
  }

  const result = transaction(() => {
    // Dieselbe Menge wie in /impact — die Vorschau muss exakt stimmen.
    const ids = affectedPersonIds(row, id);
    const portraits = deletePersonsAndCleanUnions(ids);
    return { deleted: ids.length, portraits };
  });

  // Erst nach dem Commit: eine geloeschte Datei laesst sich nicht zurueckrollen.
  removeFiles(result.portraits);

  res.json({ deleted: result.deleted });
});

// --- Unions ---------------------------------------------------------------

router.post('/unions', (req, res) => {
  const body = req.body || {};
  const personId = readId(body.personId, 'Die Personen-ID');
  const person = getPersonRow(personId);
  if (!person) {
    throw new ApiError(404, 'person_not_found', 'Diese Person wurde nicht gefunden.');
  }
  if (person.is_partner === 1) {
    throw new ApiError(
      400,
      'partner_no_union',
      'Eingeheiratete Personen koennen keine eigene Partnerschaft haben.'
    );
  }

  // Es gibt keine Obergrenze mehr fuer die Zahl der Partnerschaften und keine
  // belegten Seiten: Beliebig viele kinderlose Partnerschaften stapeln sich auf
  // einer Seite. Belegt ist eine Seite nur, wenn dort eine Union mit Kindern
  // haengt (SPEC 2, Invarianten).
  let side = body.side;
  if (side === undefined || side === null || side === '') {
    // Nicht angegeben: bevorzugt eine Seite ohne Kinder-Union, links zuerst.
    // Sind beide belegt, faellt die Wahl auf 'left' und die Pruefung unten
    // liefert die passende Fehlermeldung.
    side = childUnionOnSide(personId, 'left') === null
      ? 'left'
      : childUnionOnSide(personId, 'right') === null
        ? 'right'
        : 'left';
  }
  if (side !== 'left' && side !== 'right') {
    throw new ApiError(400, 'invalid_side', 'Die Seite muss "left" oder "right" sein.');
  }
  if (childUnionOnSide(personId, side) !== null) {
    throw new ApiError(
      409,
      'side_has_children',
      'Auf dieser Seite haengt bereits eine Partnerschaft mit Kindern — ' +
        'dort ist kein Platz fuer eine weitere.'
    );
  }

  const isCurrent = readBool(body.isCurrent, true);
  const note = cleanText(body.note, 500);

  let partnerFields = null;
  if (body.partner !== undefined && body.partner !== null) {
    // Auch hier entsteht eine neue Person — dieselbe Obergrenze gilt.
    assertPersonCapacity();
    partnerFields = readPersonFields(body.partner, false);
  }

  const result = transaction(() => {
    const now = new Date().toISOString();
    let partnerId = null;
    if (partnerFields) {
      const info = db
        .prepare(
          `INSERT INTO persons
             (first_name, last_name, maiden_name, birth_date, death_date,
              address, phone, email, notes, parent_union_id, is_partner, sort_order, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, 0, ?)`
        )
        .run(
          partnerFields.firstName,
          partnerFields.lastName,
          partnerFields.maidenName,
          partnerFields.birthDate,
          partnerFields.deathDate,
          partnerFields.address,
          partnerFields.phone,
          partnerFields.email,
          partnerFields.notes,
          now
        );
      partnerId = Number(info.lastInsertRowid);
    }

    const info = db
      .prepare(
        `INSERT INTO unions (person_id, partner_id, side, is_current, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(personId, partnerId, side, isCurrent ? 1 : 0, note, now);
    const unionId = Number(info.lastInsertRowid);
    if (isCurrent) clearOtherCurrent(personId, unionId);

    return {
      union: toUnion(getUnionRow(unionId)),
      partner: partnerId === null ? null : toPerson(getPersonRow(partnerId)),
    };
  });

  res.status(201).json(result);
});

router.patch('/unions/:id', (req, res) => {
  const id = readId(req.params.id, 'Die Partnerschafts-ID');
  const row = getUnionRow(id);
  if (!row) {
    throw new ApiError(404, 'union_not_found', 'Diese Partnerschaft wurde nicht gefunden.');
  }
  const body = req.body || {};

  let newSide = row.side;
  if (Object.prototype.hasOwnProperty.call(body, 'side')) {
    if (body.side !== 'left' && body.side !== 'right') {
      throw new ApiError(400, 'invalid_side', 'Die Seite muss "left" oder "right" sein.');
    }
    newSide = body.side;
    // Entscheidend ist einzig, dass nach dem Wechsel nie zwei Unions MIT
    // KINDERN auf derselben Seite stehen. Eine kinderlose Union darf also
    // ueberall hin — sie stapelt sich oben drauf und nimmt niemandem den Platz
    // unter der Person weg.
    if (newSide !== row.side && unionHasChildren(id)) {
      const blocker = childUnionOnSide(row.person_id, newSide, id);
      if (blocker !== null) {
        throw new ApiError(
          409,
          'side_has_children',
          'Auf dieser Seite haengt bereits eine Partnerschaft mit Kindern — ' +
            'diese laesst sich nicht dorthin verschieben.'
        );
      }
    }
  }

  const hasCurrent = Object.prototype.hasOwnProperty.call(body, 'isCurrent');
  const isCurrent = hasCurrent ? readBool(body.isCurrent, row.is_current === 1) : null;
  const hasNote = Object.prototype.hasOwnProperty.call(body, 'note');
  const note = hasNote ? cleanText(body.note, 500) : null;

  transaction(() => {
    const sets = [];
    const values = [];
    if (newSide !== row.side) {
      sets.push('side = ?');
      values.push(newSide);
    }
    if (hasCurrent) {
      sets.push('is_current = ?');
      values.push(isCurrent ? 1 : 0);
    }
    if (hasNote) {
      sets.push('note = ?');
      values.push(note);
    }
    if (sets.length > 0) {
      values.push(id);
      db.prepare(`UPDATE unions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }
    if (hasCurrent && isCurrent) clearOtherCurrent(row.person_id, id);
  });

  res.json(toUnion(getUnionRow(id)));
});

router.delete('/unions/:id', requireAdmin, (req, res) => {
  const id = readId(req.params.id, 'Die Partnerschafts-ID');
  const row = getUnionRow(id);
  if (!row) {
    throw new ApiError(404, 'union_not_found', 'Diese Partnerschaft wurde nicht gefunden.');
  }

  const result = transaction(() => {
    const seeds = [];
    if (row.partner_id !== null) seeds.push(row.partner_id);
    for (const c of db.prepare('SELECT id FROM persons WHERE parent_union_id = ?').all(id)) {
      seeds.push(c.id);
    }
    const ids = seeds.length > 0 ? [...collectSubtree(seeds).personIds] : [];
    // Auch hier aufraeumen: waere eine der Personen anderswo als Partner:in
    // eingetragen, bliebe sonst dort eine leere Union stehen.
    const portraits = ids.length > 0 ? deletePersonsAndCleanUnions(ids) : [];
    db.prepare('DELETE FROM unions WHERE id = ?').run(id);
    return { deleted: ids.length, portraits }; // Anzahl geloeschter Personen
  });

  removeFiles(result.portraits);

  res.json({ deleted: result.deleted });
});

module.exports = router;
