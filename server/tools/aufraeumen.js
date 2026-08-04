'use strict';

/**
 * Einmaliges Aufräumen von Altlasten in der Datenbank.
 *
 * Anlass: Bis zu einem frueheren Fix blieb beim Löschen einer eingeheirateten
 * Person deren Partnerschaft als "Geisterbeziehung" stehen — `partner_id` wurde
 * per `ON DELETE SET NULL` geleert, die Union selbst blieb. Im Baum erschien
 * dann eine Karte "Partner:in unbekannt" ohne jeden Inhalt. Neue entstehen
 * nicht mehr; bereits vorhandene muss dieses Skript entfernen.
 *
 * Aufruf im laufenden Container:
 *
 *   docker exec <container> node server/tools/aufraeumen.js            # nur zeigen
 *   docker exec <container> node server/tools/aufraeumen.js --apply    # loeschen
 *
 * Ohne `--apply` wird NICHTS veraendert.
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'stammbaum.db');
const apply = process.argv.includes('--apply');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON');

const name = (row) =>
  [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || 'Unbenannt';

// ---------------------------------------------------------------------------
// 1. Geisterbeziehungen: keine Partner:in UND keine Kinder
// ---------------------------------------------------------------------------
//
// Die Bedingung "keine Kinder" ist der entscheidende Schutz: Eine Union ohne
// Partner:in, an der Kinder haengen, ist voellig zulaessig (alleinerziehend
// oder anderer Elternteil unbekannt). Sie zu loeschen wuerde ueber
// `persons.parent_union_id ON DELETE CASCADE` die Kinder samt deren
// Nachkommenschaft mitreissen.

const geister = db
  .prepare(
    `SELECT u.id, u.side, u.is_current, u.note,
            p.first_name, p.last_name
       FROM unions u
       JOIN persons p ON p.id = u.person_id
      WHERE u.partner_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM persons k WHERE k.parent_union_id = u.id)
      ORDER BY u.id`
  )
  .all();

// ---------------------------------------------------------------------------
// 2. Beziehungslose eingeheiratete Personen
// ---------------------------------------------------------------------------
//
// Wer `is_partner = 1` ist, war nur ueber eine Union sichtbar. Ist diese weg,
// taucht die Person im Baum nirgends mehr auf — sie existiert aber weiter und
// kann auf Fotos markiert sein. Wird nur gemeldet, nicht geloescht: Hier ist
// nicht sicher, ob es sich um Muell oder um jemanden handelt, der noch
// gebraucht wird.

const verwaiste = db
  .prepare(
    `SELECT p.id, p.first_name, p.last_name,
            (SELECT COUNT(*) FROM photo_tags t WHERE t.person_id = p.id) AS tags
       FROM persons p
      WHERE p.is_partner = 1
        AND NOT EXISTS (SELECT 1 FROM unions u WHERE u.partner_id = p.id)
      ORDER BY p.id`
  )
  .all();

// ---------------------------------------------------------------------------
// Bericht
// ---------------------------------------------------------------------------

console.log('\nDatenbank: ' + DB_FILE + '\n');

if (geister.length === 0) {
  console.log('Geisterbeziehungen: keine gefunden.');
} else {
  console.log(`Geisterbeziehungen (ohne Partner:in, ohne Kinder): ${geister.length}`);
  for (const g of geister) {
    const seite = g.side === 'left' ? 'links' : 'rechts';
    const stand = g.is_current ? 'aktuell' : 'frueher';
    const notiz = g.note ? ` — Notiz: "${g.note}"` : '';
    console.log(`  Union ${g.id}: bei ${name(g)} (${seite}, ${stand})${notiz}`);
  }
}

if (verwaiste.length > 0) {
  console.log(`\nZusaetzlich gefunden: ${verwaiste.length} eingeheiratete Person(en) ohne`);
  console.log('jede Partnerschaft. Sie sind im Stammbaum unsichtbar. Dieses Skript');
  console.log('loescht sie NICHT — bitte selbst pruefen und ggf. im Adminbereich entfernen:');
  for (const v of verwaiste) {
    const fotos = v.tags > 0 ? `, auf ${v.tags} Foto(s) markiert` : '';
    console.log(`  Person ${v.id}: ${name(v)}${fotos}`);
  }
}

// ---------------------------------------------------------------------------
// Loeschen
// ---------------------------------------------------------------------------

if (geister.length === 0) {
  console.log('\nNichts zu tun.\n');
} else if (!apply) {
  console.log('\nProbelauf — es wurde nichts veraendert.');
  console.log('Zum tatsaechlichen Loeschen denselben Befehl mit --apply aufrufen.\n');
} else {
  db.exec('BEGIN');
  try {
    const stmt = db.prepare('DELETE FROM unions WHERE id = ?');
    for (const g of geister) stmt.run(g.id);

    // Sicherheitsnetz: Wenn hier etwas nicht stimmt, lieber zurueckrollen.
    const kaputt = db.prepare('PRAGMA foreign_key_check').all();
    if (kaputt.length > 0) throw new Error('foreign_key_check meldet Probleme');

    db.exec('COMMIT');
    console.log(`\n${geister.length} Geisterbeziehung(en) geloescht.\n`);
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('\nAbgebrochen, nichts geaendert: ' + err.message + '\n');
    process.exitCode = 1;
  }
}

db.close();
