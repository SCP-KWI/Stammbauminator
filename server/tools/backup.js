'use strict';

/**
 * Konsistente Kopie der Datenbank — im laufenden Betrieb, ohne Zusatzwerkzeug.
 *
 * Warum es dieses Skript braucht: Die Datenbank läuft im WAL-Modus. Die zuletzt
 * geschriebenen Daten stehen dann nicht in `stammbaum.db`, sondern in
 * `stammbaum.db-wal` — im Betrieb sind das schnell einige Megabyte, während die
 * Hauptdatei bei wenigen Kilobyte bleibt. Wer nur `stammbaum.db` wegkopiert,
 * sichert also unter Umständen eine fast leere Datenbank.
 *
 * `VACUUM INTO` schreibt eine in sich geschlossene, aufgeräumte Kopie — auch
 * während parallel geschrieben wird. Das kann SQLite von Haus aus; es braucht
 * weder das sqlite3-Kommandozeilenwerkzeug auf dem Host noch eine Auszeit des
 * Containers.
 *
 * Aufruf im laufenden Container:
 *
 *   docker exec <container> node server/tools/backup.js /app/data/backup.db
 *
 * `/app/data` ist der Bind-Mount, die Datei erscheint also sofort auf dem Host
 * unter `<app-ordner>/data/backup.db` und kann von dort weggeschoben werden.
 * Die Fotos in `uploads/` sind gewöhnliche Dateien und werden separat kopiert.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'stammbaum.db');

const ziel = process.argv[2];

if (!ziel) {
  console.error('\nAufruf: node server/tools/backup.js <zieldatei>\n\n' +
    'Beispiel im Container:\n' +
    '  docker exec <container> node server/tools/backup.js /app/data/backup.db\n');
  process.exit(1);
}

if (fs.existsSync(ziel)) {
  console.error('\n[stammbaum] ' + ziel + ' gibt es schon — bitte erst wegschieben ' +
    'oder einen anderen Namen waehlen. Es wird nichts ueberschrieben.\n');
  process.exit(1);
}

if (!fs.existsSync(DB_FILE)) {
  console.error('\n[stammbaum] Keine Datenbank unter ' + DB_FILE + '\n');
  process.exit(1);
}

// SQLite nimmt den Pfad als String-Literal entgegen; einfache Anfuehrungszeichen
// im Dateinamen muessen darum verdoppelt werden.
const literal = "'" + String(ziel).replace(/'/g, "''") + "'";

const db = new DatabaseSync(DB_FILE);
try {
  db.exec('VACUUM INTO ' + literal);
} finally {
  db.close();
}

// Gegenprobe: Die Kopie wird geoeffnet und gezaehlt. Ein Backup, das man nicht
// lesen kann, faellt sonst erst auf, wenn man es braucht.
const kopie = new DatabaseSync(ziel, { readOnly: true });
let zahlen;
try {
  const eins = (sql) => kopie.prepare(sql).get().n;
  zahlen = {
    personen: eins('SELECT COUNT(*) AS n FROM persons'),
    partnerschaften: eins('SELECT COUNT(*) AS n FROM unions'),
    fotos: eins('SELECT COUNT(*) AS n FROM photos'),
    markierungen: eins('SELECT COUNT(*) AS n FROM photo_tags'),
    kaputt: kopie.prepare('PRAGMA integrity_check').get(),
  };
} finally {
  kopie.close();
}

const groesse = fs.statSync(ziel).size;
const ok = zahlen.kaputt && Object.values(zahlen.kaputt)[0] === 'ok';

console.log('\n[stammbaum] Backup geschrieben: ' + ziel);
console.log('  Groesse:         ' + (groesse / 1024 / 1024).toFixed(2) + ' MB');
console.log('  Personen:        ' + zahlen.personen);
console.log('  Partnerschaften: ' + zahlen.partnerschaften);
console.log('  Fotos:           ' + zahlen.fotos);
console.log('  Markierungen:    ' + zahlen.markierungen);
console.log('  Integritaet:     ' + (ok ? 'in Ordnung' : 'FEHLERHAFT'));
console.log('\nNicht vergessen: die Bilddateien in uploads/ gehoeren auch ins Backup.\n');

if (!ok) process.exitCode = 1;
