'use strict';

/**
 * Datenbank: Schema, Migration, Seed.
 * Nutzt das eingebaute node:sqlite (keine nativen Abhaengigkeiten).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'stammbaum.db');

const SCHEMA_VERSION = '4';

/**
 * Datenverzeichnis anlegen — mit verstaendlicher Meldung statt Stacktrace.
 *
 * Haeufigster Stolperstein beim Deployment: Im Container laeuft die App als
 * Benutzer `node` (UID 1000). Das `chown` im Dockerfile hilft dabei nicht, weil
 * ein Bind-Mount das Verzeichnis aus dem Image zur Laufzeit vollstaendig
 * ueberdeckt — die Rechte kommen dann vom Host. Legt Docker den Ordner beim
 * ersten Start selbst an, gehoert er `root` und die App kann nicht schreiben.
 */
function ensureWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
    console.error(
      '\n[stammbaum] Kein Schreibrecht auf ' + dir + '\n\n' +
      'Die App laeuft als Benutzer "node" (UID 1000). Bei einem Bind-Mount\n' +
      'muessen die Rechte auf dem Host stimmen. Einmalig auf dem Server:\n\n' +
      '  sudo chown -R 1000:1000 <app-ordner>/data\n\n' +
      'Danach:  docker compose up -d\n'
    );
    process.exit(1);
  }
}

ensureWritableDir(DATA_DIR);
ensureWritableDir(UPLOAD_DIR);

const db = new DatabaseSync(DB_FILE);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

/**
 * Spalten der Tabelle `unions` — eine einzige Quelle, weil die Migration die
 * Tabelle neu aufbauen muss (SQLite kann Constraints nicht droppen) und dabei
 * exakt dieselbe Definition braucht.
 *
 * Bewusst OHNE `UNIQUE (person_id, side)`: Pro Seite sind beliebig viele
 * Partnerschaften erlaubt, hoechstens eine davon mit Kindern (SPEC 2,
 * Invarianten). Die Kinderregel steht in den Routen, nicht im Schema — sie
 * haengt an einer anderen Tabelle und laesst sich nicht als Constraint
 * ausdruecken.
 */
const UNIONS_COLUMNS = `
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  partner_id INTEGER REFERENCES persons(id) ON DELETE SET NULL,
  side       TEXT NOT NULL DEFAULT 'left' CHECK (side IN ('left','right')),
  is_current INTEGER NOT NULL DEFAULT 1,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
`;

/** Indizes auf `unions` — beim Tabellen-Neuaufbau erneut anzulegen. */
const UNIONS_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_unions_person  ON unions(person_id);
CREATE INDEX IF NOT EXISTS idx_unions_partner ON unions(partner_id);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS unions (${UNIONS_COLUMNS});

CREATE TABLE IF NOT EXISTS persons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL DEFAULT '',
  maiden_name     TEXT NOT NULL DEFAULT '',
  birth_date      TEXT NOT NULL DEFAULT '',
  death_date      TEXT NOT NULL DEFAULT '',
  address         TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  email           TEXT NOT NULL DEFAULT '',
  notes           TEXT NOT NULL DEFAULT '',
  parent_union_id INTEGER REFERENCES unions(id) ON DELETE CASCADE,
  is_partner      INTEGER NOT NULL DEFAULT 0,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  portrait        TEXT NOT NULL DEFAULT ''   -- Dateiname in data/uploads/, '' = keines
);

CREATE TABLE IF NOT EXISTS photos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL DEFAULT '',
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  width      INTEGER NOT NULL DEFAULT 0,
  height     INTEGER NOT NULL DEFAULT 0,
  taken_at   TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS photo_tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id   INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  person_id  INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (photo_id, person_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  role        TEXT NOT NULL CHECK (role IN ('family','admin')),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  admin_until TEXT NOT NULL DEFAULT ''   -- ISO-Zeit, '' = kein Adminmodus
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  ip    TEXT NOT NULL,
  ts    TEXT NOT NULL,
  ok    INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT 'login'    -- 'login' oder 'admin'
);

CREATE INDEX IF NOT EXISTS idx_persons_parent_union ON persons(parent_union_id);
${UNIONS_INDEXES}
CREATE INDEX IF NOT EXISTS idx_tags_photo           ON photo_tags(photo_id);
CREATE INDEX IF NOT EXISTS idx_tags_person          ON photo_tags(person_id);
CREATE INDEX IF NOT EXISTS idx_attempts_ip_ts       ON login_attempts(ip, ts);
CREATE INDEX IF NOT EXISTS idx_sessions_expires     ON sessions(expires_at);
`;
// Der Index auf (scope, ip, ts) steht bewusst in migrate(): bei einer
// Alt-Datenbank gibt es die Spalte `scope` hier noch gar nicht.

db.exec(SCHEMA);

// ---------------------------------------------------------------------------
// Settings-Helfer
// ---------------------------------------------------------------------------

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/** Prueft, ob eine Spalte existiert — macht Migrationen wiederholbar. */
function hasColumn(table, column) {
  // Tabellennamen kommen ausschliesslich aus dem Code, nie aus Requests.
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
}

/**
 * Prueft, ob auf `unions` noch das alte `UNIQUE (person_id, side)` liegt.
 *
 * Test ueber `PRAGMA index_list('unions')`: Jeder Index meldet dort seine
 * Herkunft — 'c' = per CREATE INDEX angelegt, 'pk' = Primaerschluessel,
 * 'u' = aus einem UNIQUE-Constraint der Tabellendefinition. Genau ein solcher
 * Auto-Index ('u') ueber exakt den Spalten (person_id, side) beweist, dass der
 * Constraint noch da ist; die Spalten holt `PRAGMA index_info`.
 *
 * Bewusst nicht ueber den SQL-Text aus `sqlite_master` gesucht: dort haengt das
 * Ergebnis an Schreibweise, Leerzeichen und Zeilenumbruechen der urspruenglichen
 * Anweisung. Die Pragmas liefern die geparste Wahrheit.
 */
function unionsHasSideUnique() {
  const indexes = db.prepare("PRAGMA index_list('unions')").all();
  for (const idx of indexes) {
    if (idx.origin !== 'u' || idx.unique !== 1) continue;
    // Indexnamen stammen aus dem Schema, nie aus Requests; trotzdem escapen.
    const quoted = `'${String(idx.name).replace(/'/g, "''")}'`;
    const cols = db
      .prepare(`PRAGMA index_info(${quoted})`)
      .all()
      .sort((a, b) => a.seqno - b.seqno)
      .map((c) => c.name);
    if (cols.length === 2 && cols[0] === 'person_id' && cols[1] === 'side') return true;
  }
  return false;
}

/**
 * Baut `unions` ohne `UNIQUE (person_id, side)` neu auf (SQLite kann
 * Constraints nicht per ALTER TABLE entfernen) — das offizielle Verfahren:
 * neue Tabelle, Daten kopieren, alte loeschen, umbenennen, Indizes neu.
 *
 * `PRAGMA foreign_keys` MUSS dabei aus sein, und das laesst sich nur
 * AUSSERHALB einer Transaktion umschalten (drinnen ist es ein No-op). Sonst
 * wuerde `DROP TABLE unions` das `ON DELETE CASCADE` von
 * `persons.parent_union_id` ausloesen und saemtliche Kinder mitreissen — genau
 * der Datenverlust, den dieser Umbau vermeiden soll. Der Umbau selbst laeuft in
 * einer Transaktion, `PRAGMA foreign_key_check` prueft vor dem COMMIT, dass
 * keine Referenz ins Leere zeigt, und danach geht `foreign_keys` wieder an.
 *
 * Das Umbenennen laesst die Fremdschluessel in `persons` unangetastet: SQLite
 * schreibt beim RENAME nur Verweise auf den ALTEN Namen (`unions_rebuild`) um,
 * und den nennt niemand.
 */
function rebuildUnionsWithoutSideUnique() {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    try {
      db.exec('DROP TABLE IF EXISTS unions_rebuild'); // Rest eines Abbruchs
      db.exec(`CREATE TABLE unions_rebuild (${UNIONS_COLUMNS})`);
      db.exec(
        `INSERT INTO unions_rebuild
           (id, person_id, partner_id, side, is_current, note, created_at)
         SELECT id, person_id, partner_id, side, is_current, note, created_at
           FROM unions`
      );
      db.exec('DROP TABLE unions');
      db.exec('ALTER TABLE unions_rebuild RENAME TO unions');
      db.exec(UNIONS_INDEXES);
      const broken = db.prepare('PRAGMA foreign_key_check').all();
      if (broken.length > 0) {
        throw new Error(
          `Fremdschluessel nach dem Umbau von "unions" verletzt: ${JSON.stringify(broken)}`
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* Rollback-Fehler nicht ueberdecken */
      }
      throw err;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Schema-Stand:
 *   1 — Initialschema
 *   2 — persons.portrait (Portraitfoto, SPEC 4 "Portraits")
 *   3 — sessions.admin_until (Adminmodus laeuft ab) und
 *       login_attempts.scope (getrennte Rate-Limit-Toepfe)
 *   4 — unions ohne UNIQUE (person_id, side): beliebig viele Partnerschaften
 *       je Seite, hoechstens eine mit Kindern (SPEC 2, Invarianten)
 *
 * Bewusst NICHT an der Versionsnummer aufgehaengt: `CREATE TABLE IF NOT EXISTS`
 * ergaenzt bei einer bestehenden Tabelle keine Spalte und entfernt auch keinen
 * Constraint, und eine Alt-Datenbank ohne `schema_version` wurde frueher
 * faelschlich sofort als aktuell gestempelt. Darum entscheidet ausschliesslich
 * das tatsaechliche Schema (`hasColumn`, `unionsHasSideUnique`), die Version
 * ist reine Buchhaltung. Alle Schritte sind dadurch beliebig oft wiederholbar.
 */
function migrate() {
  if (!hasColumn('persons', 'portrait')) {
    db.exec("ALTER TABLE persons ADD COLUMN portrait TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn('sessions', 'admin_until')) {
    db.exec("ALTER TABLE sessions ADD COLUMN admin_until TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn('login_attempts', 'scope')) {
    db.exec("ALTER TABLE login_attempts ADD COLUMN scope TEXT NOT NULL DEFAULT 'login'");
  }
  if (unionsHasSideUnique()) {
    rebuildUnionsWithoutSideUnique();
  }

  // Erst jetzt, wenn die Spalte sicher existiert.
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_attempts_scope_ip_ts ON login_attempts(scope, ip, ts)'
  );

  if (getSetting('schema_version') !== SCHEMA_VERSION) {
    setSetting('schema_version', SCHEMA_VERSION);
  }
}

// ---------------------------------------------------------------------------
// Passwort-Hashing (hier, damit der Seed ohne Zirkelbezug auf auth.js auskommt)
// ---------------------------------------------------------------------------

/**
 * Synchrone Variante — ausschliesslich fuer den Seed beim Start.
 * Im Request-Pfad gilt die asynchrone `hashPassword` aus auth.js, sonst
 * blockiert scrypt die Event-Loop.
 */
function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/**
 * Legt ein Passwort beim allerersten Start an.
 * Fehlt die Umgebungsvariable, gibt es KEIN festes Standardpasswort mehr
 * (frueher 'familie' / 'admin'), sondern ein zufaelliges starkes Passwort,
 * das einmalig auf der Konsole steht. Der Start laeuft bewusst weiter,
 * damit der HEALTHCHECK auf /api/auth/session nicht scheitert.
 */
function ensureInitialPassword(key, envName, label) {
  if (getSetting(key) !== null) return;

  const fromEnv = process.env[envName];
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    setSetting(key, hashPasswordSync(fromEnv));
    return;
  }

  const generated = crypto.randomBytes(18).toString('base64url');
  setSetting(key, hashPasswordSync(generated));
  console.warn(`[stammbaum] ACHTUNG: ${envName} war nicht gesetzt.`);
  console.warn(`[stammbaum] Erzeugtes ${label}: ${generated}`);
  console.warn('[stammbaum] Bitte notieren und im Adminbereich aendern.');
}

function seed() {
  const now = new Date().toISOString();

  ensureInitialPassword('family_password', 'INITIAL_FAMILY_PASSWORD', 'Familien-Passwort');
  ensureInitialPassword('admin_password', 'INITIAL_ADMIN_PASSWORD', 'Admin-Passwort');

  // Familienname (SPEC 4 "Einstellungen"): Vorgabe leer — die App heisst dann
  // schlicht "Stammbaum". Kein Schema-Eingriff, nur ein Key-Value-Eintrag.
  if (getSetting('family_name') === null) {
    setSetting('family_name', '');
  }

  const count = db.prepare('SELECT COUNT(*) AS n FROM persons').get().n;
  if (count > 0) return;

  db.exec('BEGIN');
  try {
    const insertPerson = db.prepare(
      `INSERT INTO persons
         (first_name, last_name, maiden_name, birth_date, death_date,
          address, phone, email, notes, parent_union_id, is_partner, sort_order, created_at)
       VALUES (?, '', '', '', '', '', '', '', '', NULL, ?, 0, ?)`
    );
    const rootId = Number(insertPerson.run('Grosspapi', 0, now).lastInsertRowid);
    const partnerId = Number(insertPerson.run('Grossmueti', 1, now).lastInsertRowid);
    db.prepare(
      `INSERT INTO unions (person_id, partner_id, side, is_current, note, created_at)
       VALUES (?, ?, 'left', 1, '', ?)`
    ).run(rootId, partnerId, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

migrate();
seed();

// ---------------------------------------------------------------------------
// Transaktions-Helfer
// ---------------------------------------------------------------------------

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* Rollback-Fehler nicht ueberdecken */
    }
    throw err;
  }
}

/** Wurzelperson: parent_union_id IS NULL AND is_partner = 0 */
function rootPersonId() {
  const row = db
    .prepare(
      'SELECT id FROM persons WHERE parent_union_id IS NULL AND is_partner = 0 ORDER BY id LIMIT 1'
    )
    .get();
  return row ? row.id : null;
}

module.exports = {
  db,
  DATA_DIR,
  UPLOAD_DIR,
  DB_FILE,
  getSetting,
  setSetting,
  transaction,
  rootPersonId,
  hashPasswordSync,
};
