# Stammbauminator — Technische Spezifikation

Verbindlicher Vertrag für alle Module. **Nicht abweichen.** Wenn etwas fehlt, das
naheliegendste an dieser Spec orientierte Verhalten wählen und im Code kommentieren.

## 1. Überblick

Passwortgeschützte Familien-Webapp:

- **Stammbaum** — Paar-Knoten, Kinder darunter, Personendetails im Panel
- **Fotoalbum** — Gruppenfotos, Personen im Bild markieren
- **Admin** — Fotos hochladen, Personen löschen, Passwörter ändern

Stack: Node 24 (Express) + `node:sqlite` (built-in, **keine** native Deps wie
better-sqlite3), Vanilla-JS-Frontend ohne Build-Schritt, Docker hinter einem Reverse Proxy.

## 2. Datenmodell (SQLite)

Kernidee: Der Stammbaum besteht aus **Blutlinien-Personen** und **Unions**
(Partnerschaften). Eine Blutlinien-Person kann auf jeder ihrer beiden Seiten
(`left` / `right`) **beliebig viele** Unions haben, davon **höchstens eine mit
Kindern pro Seite**. Die Partner:innen dieser Unions kommen "von aussen"
(heiraten ein). Kinder hängen immer an genau einer Union und sind selbst wieder
Blutlinien-Personen mit eigenen Unions.

```sql
CREATE TABLE persons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL DEFAULT '',
  maiden_name     TEXT NOT NULL DEFAULT '',   -- Ledigname
  -- Immer ISO speichern (sortierbar); die Oberfläche zeigt und nimmt TT.MM.JJJJ
  birth_date      TEXT NOT NULL DEFAULT '',   -- 'YYYY-MM-DD' | 'YYYY-MM' | 'YYYY' | ''
  death_date      TEXT NOT NULL DEFAULT '',
  address         TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  email           TEXT NOT NULL DEFAULT '',
  notes           TEXT NOT NULL DEFAULT '',
  parent_union_id INTEGER REFERENCES unions(id) ON DELETE CASCADE, -- NULL = Stammvater/-mutter (Wurzel) oder eingeheiratet
  is_partner      INTEGER NOT NULL DEFAULT 0,  -- 1 = eingeheiratet (gehört zu einer Union, nicht zur Blutlinie)
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE TABLE unions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE, -- Blutlinien-Anker
  partner_id INTEGER REFERENCES persons(id) ON DELETE SET NULL,         -- eingeheiratet, darf NULL sein
  side       TEXT NOT NULL DEFAULT 'left' CHECK (side IN ('left','right')),
  is_current INTEGER NOT NULL DEFAULT 1,   -- aktuell laufende Partnerschaft
  note       TEXT NOT NULL DEFAULT '',     -- z.B. "verheiratet seit 2010", "getrennt"
  created_at TEXT NOT NULL
  -- KEIN UNIQUE (person_id, side): mehrere Partnerschaften je Seite sind
  -- erlaubt. "Höchstens eine mit Kindern pro Seite" hängt an einer anderen
  -- Tabelle und wird deshalb in den Routen erzwungen, nicht im Schema.
);

CREATE TABLE photos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL DEFAULT '',
  filename   TEXT NOT NULL,          -- Dateiname in data/uploads/
  mime       TEXT NOT NULL,
  width      INTEGER NOT NULL DEFAULT 0,
  height     INTEGER NOT NULL DEFAULT 0,
  taken_at   TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE photo_tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id   INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  person_id  INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  x          REAL NOT NULL,   -- 0..1, relativ zur Bildbreite
  y          REAL NOT NULL,   -- 0..1, relativ zur Bildhöhe
  created_at TEXT NOT NULL,
  UNIQUE (photo_id, person_id)
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- keys: family_password, admin_password (jeweils scrypt-Hash), family_name, schema_version

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,   -- sha256 des Cookie-Tokens
  role        TEXT NOT NULL CHECK (role IN ('family','admin')),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  admin_until TEXT NOT NULL DEFAULT ''   -- ISO-Zeit, bis wann role='admin' gilt; '' = kein Adminmodus
);

CREATE TABLE login_attempts (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  ip    TEXT NOT NULL,
  ts    TEXT NOT NULL,
  ok    INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT 'login'    -- 'login' oder 'admin', getrennte Rate-Limit-Töpfe
);
```

### Invarianten

- Genau **eine** Wurzelperson: `parent_union_id IS NULL AND is_partner = 0`.
- Pro `person_id` **beliebig viele** Unions je Seite, aber **höchstens eine mit
  Kindern pro Seite** (also maximal zwei mit Kindern insgesamt). Grund: Die
  Kinder einer Union hängen unter der Person auf deren Seite — dieser Platz ist
  einmal pro Seite vorhanden. Frühere, kinderlose Partnerschaften werden darüber
  gestapelt; kommt eine neue dazu, rutschen die bestehenden nach oben.
  Das frühere `UNIQUE(person_id, side)` ist damit entfallen (Migration auf
  `schema_version` 4, Tabellen-Neuaufbau — SQLite kann Constraints nicht droppen).
- Ein „+" für eine weitere Partnerschaft erscheint auf einer Seite genau dann,
  wenn dort **noch keine** Union mit Kindern hängt.
- Bekommt eine hochgeschobene Union ein Kind und die Seite hat noch keine
  Kinder-Union, rutscht sie automatisch nach unten — das ergibt sich aus der
  Sortierung in `Store.unionStack()` und braucht keinen eigenen Schritt.
- Höchstens eine Union pro Person mit `is_current = 1` (Backend erzwingt: beim
  Setzen von `is_current` wird die andere Union derselben Person auf 0 gesetzt).
- `is_partner = 1` Personen haben immer `parent_union_id IS NULL` und tauchen
  **nicht** als Blutlinien-Knoten auf — sie sind nur über ihre Union sichtbar.
- Löschen einer Blutlinien-Person löscht kaskadierend deren Unions,
  Partner:innen und Nachkommen. Das Backend muss vorher die betroffene Anzahl
  melden können (`GET /api/persons/:id/impact`); die Vorschau und das
  tatsächliche Ergebnis müssen exakt übereinstimmen.
- Es bleiben **keine beziehungslosen** `is_partner = 1`-Personen zurück: Wer nur
  über eine Union sichtbar war, geht mit dieser Union mit.
- **Löschen einer eingeheirateten Person räumt ihre Union mit auf:**
  - Union **ohne Kinder** → Union ebenfalls löschen. Sonst bliebe sie als
    Geisterbeziehung mit „Partner:in unbekannt" im Baum stehen.
  - Union **mit Kindern** → Union **behalten**, `partner_id = NULL`. Die Kinder
    stammen weiterhin vom verbleibenden Elternteil ab; `persons.parent_union_id`
    hängt an `ON DELETE CASCADE`, ein Löschen der Union würde sie samt ihrer
    gesamten Nachkommenschaft mitreissen. Eine Union mit `partner_id = NULL` und
    Kindern ist zulässig (alleinerziehend / anderer Elternteil unbekannt).
- Die Wurzelperson kann nicht gelöscht werden — serverseitig erzwungen
  (`409 root_person`), unabhängig von der Rolle.

### Migration

`SCHEMA_VERSION` ist aktuell `'4'` (1 = Initialschema, 2 = `persons.portrait`,
3 = `sessions.admin_until` und `login_attempts.scope`, 4 = `unions` ohne
`UNIQUE (person_id, side)`).

Die Migrationsschritte entscheiden **ausschliesslich anhand des tatsächlichen
Schemas** (`hasColumn`, `unionsHasSideUnique`); `settings.schema_version` ist
reine Buchhaltung. Grund: eine alte Datenbank ohne den Schlüssel
`schema_version` wurde sonst fälschlich sofort als aktuell gestempelt, und
`CREATE TABLE IF NOT EXISTS` ergänzt bei einer bestehenden Tabelle weder eine
Spalte noch entfernt es einen Constraint. Jeder Schritt muss dadurch beliebig
oft wiederholbar sein und darf bestehende Datenbanken nicht beschädigen.

**Schritt 4 im Detail.** SQLite kann Constraints nicht per `ALTER TABLE`
entfernen, die Tabelle muss neu aufgebaut werden: neue Tabelle ohne den
Constraint, Daten kopieren, alte löschen, umbenennen, Indizes wiederherstellen.

- Erkennung: `PRAGMA index_list('unions')` — ein Index mit `origin = 'u'`
  (aus einem UNIQUE-Constraint) über exakt den Spalten `(person_id, side)`
  laut `PRAGMA index_info` beweist, dass der Constraint noch existiert.
  Bewusst nicht über den SQL-Text aus `sqlite_master`: der hängt an
  Schreibweise und Leerzeichen der ursprünglichen Anweisung.
- `PRAGMA foreign_keys` muss während des Umbaus **aus** sein, sonst löst
  `DROP TABLE unions` das `ON DELETE CASCADE` von `persons.parent_union_id` aus
  und reisst alle Kinder mit. Umschalten geht nur **ausserhalb** einer
  Transaktion (innerhalb ist das Pragma ein No-op); danach wieder **an**.
- Der Umbau selbst läuft in **einer** Transaktion, `PRAGMA foreign_key_check`
  prüft vor dem `COMMIT`, dass keine Referenz ins Leere zeigt.
- Das Umbenennen lässt die Fremdschlüssel in `persons` unangetastet: SQLite
  schreibt beim `RENAME` nur Verweise auf den alten Namen um.

### Seed (beim ersten Start)

- Person 1: `Grosspapi`, `is_partner=0`, `parent_union_id=NULL` (Wurzel)
- Person 2: `Grossmueti`, `is_partner=1`
- Union 1: `person_id=1, partner_id=2, side='left', is_current=1`
- Passwörter aus ENV `INITIAL_FAMILY_PASSWORD` / `INITIAL_ADMIN_PASSWORD` — beim
  ersten Start in `settings` gehasht ablegen. **Es gibt keine fest eingebauten
  Standardpasswörter** (früher `familie` / `admin`). Fehlt eine der beiden
  Variablen, erzeugt die App ein zufälliges starkes Passwort, gibt es einmalig
  auf der Konsole aus (`docker compose logs stammbaum`) und startet trotzdem
  weiter — der HEALTHCHECK auf `/api/auth/session` soll nicht scheitern.

## 3. Authentifizierung

- **Kein Account.** Zwei Passwörter: Familien-PW (Zugang) und Admin-PW (Adminbereich).
- Login: `POST /api/auth/login` mit Familien-PW → Session `role='family'`.
- Upgrade: `POST /api/auth/admin` mit Admin-PW → dieselbe Session wird `role='admin'`.
- **Der Adminmodus läuft ab:** `role='admin'` gilt nur 30 Minuten
  (`admin_until`). Danach fällt die Session automatisch auf `role='family'`
  zurück — die Anmeldung selbst bleibt bestehen, nur die Adminrechte sind weg.
  Ein Aufruf einer Adminroute antwortet dann mit `403` und dem Code `forbidden`.
- Session-Cookie: über TLS heisst es `__Host-stb_session`, ohne Secure-Cookies
  `stb_session`. Gelesen werden **beide** Namen, damit ein Wechsel zwischen den
  Betriebsarten bestehende Anmeldungen nicht wegwirft. Attribute: `HttpOnly`,
  `SameSite=Lax`, `Path=/`, `Max-Age=30d`, `Secure` wenn
  `process.env.SECURE_COOKIES !== 'false'` (Default an, läuft hinter TLS am Proxy).
  Das `__Host-`-Präfix erzwingt browserseitig `Secure`, `Path=/` und verbietet
  ein `Domain`-Attribut; über `http://` würde der Browser so ein Cookie verwerfen.
- Token: 32 zufällige Bytes base64url; in der DB nur `sha256(token)`.
- Passwort-Hashing: **asynchrones** `crypto.scrypt(pw, salt, 64)`, gespeichert
  als `scrypt$<saltHex>$<hashHex>`; Vergleich mit `crypto.timingSafeEqual`.
  Das synchrone `scryptSync` blockiert die Event-Loop — unter Last stiegen die
  Antwortzeiten dadurch um rund das 700-fache; es bleibt ausschliesslich dem
  Seed beim Start vorbehalten (`hashPasswordSync` in `db.js`).
- **Deckel für scrypt:** höchstens 2 gleichzeitige Passwortprüfungen, dahinter
  eine Warteschlange von 20. Ist auch die voll, antwortet der Server mit `503`
  und dem Code `busy`. Grund: der libuv-Threadpool hat nur 4 Threads, ohne
  Deckel würden parallele Loginversuche alle Dateizugriffe aushungern.
- **Rate-Limit:** getrennte Zähler je Scope (`login` / `admin`), nicht ein
  gemeinsamer Topf — sonst sperrt ein vertipptes Adminpasswort alle Nutzer
  hinter derselben NAT-IP vom Familienlogin aus.
  - pro IP und Scope max 10 Fehlversuche je 15 Minuten → `429 rate_limited`
  - über alle IPs eines Scopes max 100 Fehlversuche je 15 Minuten →
    `429 rate_limited_global` (gegen verteilte Rateversuche)
  - ein erfolgreicher Versuch löscht die Fehlversuche dieser IP **in diesem Scope**
- Alle `/api/*` (ausser `/api/auth/login`, `/api/auth/session` und `/api/settings`)
  und `/uploads/*` erfordern eine gültige Session. Admin-Routen erfordern `role='admin'`.
- **IP-Ermittlung: ausschliesslich `req.ip`** (Express, mit
  `app.set('trust proxy', 1)`). Der `X-Forwarded-For`-Header darf **nie** selbst
  gelesen werden — schon gar nicht dessen erster Eintrag. Der Reverse Proxy
  hängt die echte IP per `$proxy_add_x_forwarded_for` **hinten** an; die vorderen
  Einträge stammen vom Aufrufer und sind frei erfindbar. Mit einem gefälschten
  Header wäre das Rate-Limit sonst komplett aushebelbar. `trust proxy = 1` wertet
  genau den letzten Eintrag aus — das ist die einzige vertrauenswürdige Angabe.

### Sicherheits-Header

Auf **allen** Antworten (vor `express.static` gesetzt):

| Header | Wert |
|---|---|
| `Content-Security-Policy` | `default-src 'self'`, `script-src 'self'`, `style-src 'self'`, `img-src 'self' data: blob:`, `connect-src 'self'`, `font-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` — **nur** wenn `SECURE_COOKIES !== 'false'`, sonst würde HSTS die lokale Entwicklung über `http://` aussperren |

Die CSP kennt **kein** `'unsafe-inline'`, weder für Skripte noch für Stile.
Was daraus für das Frontend folgt, steht in Abschnitt 5.
`img-src data:` ist für das Inline-SVG-Favicon nötig, `img-src blob:` für die
Upload-Vorschau (`URL.createObjectURL`).

## 4. HTTP-API

Alle Bodies und Antworten sind JSON (Ausnahme: Foto-Upload = `multipart/form-data`).
Fehler: `{ "error": "<code>", "message": "<deutsch, benutzertauglich>" }` mit
passendem Statuscode (400 Validierung, 401 nicht eingeloggt, 403 kein Admin,
404 nicht gefunden, 409 Konflikt, 413 zu gross, 429 Rate-Limit,
503 `busy` = zu viele gleichzeitige Passwortprüfungen).

### Auth

| Methode | Pfad | Body | Antwort |
|---|---|---|---|
| `GET` | `/api/auth/session` | – | `{ authenticated: bool, role: 'family'\|'admin'\|null, adminUntil: string }` |
| `POST` | `/api/auth/login` | `{ password }` | `{ role: 'family' }` + Cookie |
| `POST` | `/api/auth/admin` | `{ password }` | `{ role: 'admin', adminUntil }` |
| `POST` | `/api/auth/admin/leave` | – | `{ role: 'family', adminUntil: '' }` (Admin-Modus verlassen) |
| `POST` | `/api/auth/logout` | – | `{ ok: true }` + Cookie gelöscht |

`adminUntil` ist ein ISO-Zeitstempel, bis wann der Adminmodus gilt; `''` heisst
„kein Adminmodus". Ist er abgelaufen, meldet `/api/auth/session` wieder
`role: 'family'`.

### Stammbaum

| Methode | Pfad | Body | Antwort |
|---|---|---|---|
| `GET` | `/api/tree` | – | `{ rootPersonId, persons: Person[], unions: Union[] }` |
| `POST` | `/api/persons` | `{ parentUnionId, ...personFields }` | `Person` — legt ein Kind in der Union an |
| `PATCH` | `/api/persons/:id` | Teilmenge der Personenfelder | `Person` |
| `DELETE` | `/api/persons/:id` | – | `{ deleted: number }` |
| `GET` | `/api/persons/:id/impact` | – | `{ persons, tags, names: string[], adminRequired: bool }` |
| `POST` | `/api/unions` | `{ personId, side, isCurrent, note, partner: {...personFields} \| null }` | `{ union, partner }` |
| `PATCH` | `/api/unions/:id` | `{ isCurrent?, note?, side? }` | `Union` |
| `DELETE` | `/api/unions/:id` | – (**Admin**) | `{ deleted: number }` |

**Personen löschen ist nicht auf den Adminmodus beschränkt:** `DELETE
/api/persons/:id` und `GET /api/persons/:id/impact` genügt eine gültige Session
(Familien-Passwort) — wie beim Anlegen von Personen und beim Pflegen von
Portraits. Die Rückfrage passiert im Frontend durch Eintippen des Vornamens; die
Invariante „Wurzelperson ist unlöschbar" bleibt serverseitig erzwungen.

**Ab zwei betroffenen Personen braucht es aber den Adminmodus.** Löschen wirkt
kaskadierend: Mit einer Person verschwinden ihre Partner:innen und ihre gesamte
Nachkommenschaft. Solange nur diese eine Person betroffen ist, darf jede:r sie
entfernen; sobald mehr dranhängt, ist es eine Massenlöschung und `DELETE`
antwortet ohne Adminmodus mit **403** und dem Code **`admin_required`**.

> Der Code muss `admin_required` lauten und **nicht** `forbidden`: `api.js`
> deutet `forbidden` als „Adminmodus abgelaufen" und würde die Rolle
> zurücksetzen und eine irreführende Meldung zeigen.

`impact.adminRequired` sagt dasselbe vorab, damit das Frontend die Freischaltung
anbieten kann, statt in den 403 zu laufen.
`DELETE /api/unions/:id` bleibt dagegen **Admin** — das löscht eine
Partnerschaft samt Nachkommenschaft und ist eine andere Operation.

**Die Kinderregel je Seite** (siehe Abschnitt 2) erzwingen drei Routen mit
demselben Code `409 side_has_children`. Die früheren Codes `union_limit`
(max. 2 Partnerschaften) und `side_taken` (Seite belegt) gibt es **nicht mehr**:

- `POST /api/unions` — auf der gewünschten Seite hängt bereits eine Union mit
  Kindern. Ohne `side` im Body wählt der Server selbst: bevorzugt eine Seite
  ohne Kinder-Union, sind beide frei, `left` zuerst.
- `PATCH /api/unions/:id` mit `side` — der Wechsel würde zwei Unions mit
  Kindern auf dieselbe Seite bringen. Eine **kinderlose** Union darf immer
  wechseln, sie nimmt niemandem den Platz unter der Person weg.
- `POST /api/persons` — an derselben Seite derselben Person hat bereits eine
  **andere** Union Kinder. Hat die Zielunion selbst schon Kinder, ist alles in
  Ordnung.

`personFields` = `firstName, lastName, maidenName, birthDate, deathDate, address,
phone, email, notes`. Nur `firstName` ist Pflicht (nicht leer, max 60 Zeichen).
Alle Textfelder werden getrimmt, max 500 Zeichen (`notes`/`address` max 2000).

**Obergrenze:** max. 2000 Personen insgesamt. Jedes weitere Anlegen (auch die
eingeheiratete Person in `POST /api/unions`) antwortet mit
`409 person_limit`. Ohne diese Grenze könnte jede:r mit dem Familien-Passwort
unbegrenzt Datensätze — und damit Portraits — anlegen.

**Person (JSON, camelCase):**
```json
{ "id": 3, "firstName": "Anna", "lastName": "Muster", "maidenName": "",
  "birthDate": "2000-01-01", "deathDate": "", "address": "Musterweg 1, 8000 Zürich",
  "phone": "+41 79 000 00 00", "email": "anna@example.ch", "notes": "",
  "parentUnionId": 1, "isPartner": false, "sortOrder": 0 }
```

**Union (JSON):**
```json
{ "id": 4, "personId": 3, "partnerId": 12, "side": "right",
  "isCurrent": true, "note": "verheiratet seit 2010" }
```

### Fotos

| Methode | Pfad | Body | Antwort |
|---|---|---|---|
| `GET` | `/api/photos` | – | `Photo[]` inkl. `tags` |
| `POST` | `/api/photos` | `multipart`: `file`, `title`, `takenAt` (**Admin**) | `Photo` |
| `PATCH` | `/api/photos/:id` | `{ title?, takenAt?, sortOrder? }` (**Admin**) | `Photo` |
| `DELETE` | `/api/photos/:id` | – (**Admin**) | `{ ok: true }` |
| `POST` | `/api/photos/:id/tags` | `{ personId, x, y }` | `Tag` |
| `PATCH` | `/api/tags/:id` | `{ x, y }` | `Tag` |
| `DELETE` | `/api/tags/:id` | – | `{ ok: true }` |
| `GET` | `/uploads/:filename` | – | Bilddatei (auth-geschützt) |

**Photo (JSON):**
```json
{ "id": 1, "title": "Beispielfoto", "url": "/uploads/abc123.jpg",
  "width": 2000, "height": 1333, "takenAt": "2024-07-14", "sortOrder": 0,
  "tags": [ { "id": 9, "personId": 3, "x": 0.42, "y": 0.31 } ] }
```

Upload: nur `image/jpeg`, `image/png`, `image/webp`; max 15 MB; Dateiname wird
serverseitig durch `crypto.randomUUID()` + Extension ersetzt.

- `width`/`height` ermittelt der **Server** aus dem Bildkopf. Die gleichnamigen
  Formfelder des Clients sind nur noch der Rückfall, falls sich aus dem Bild
  nichts auslesen liess; fehlen auch sie, `0` speichern.
- **Bildprüfung** (strukturell, nicht nur Magic Bytes) — Fehlschlag →
  `400 invalid_image`:
  - Mindestgrösse 100 Byte
  - JPEG: `SOI` am Anfang, `EOI` am Ende, und die Segmentkette muss bis zu
    einem `SOF`-Marker durchlaufen (dort stehen auch die Masse)
  - PNG: 8-Byte-Signatur, `IHDR` als **erster** Chunk, `IEND` am Dateiende
  - WebP: `RIFF`/`WEBP`-Container, dessen angegebene Länge zur Dateigrösse
    passt, danach ein bekannter Bild-Chunk (`VP8 `, `VP8L`, `VP8X`)
- **Obergrenzen:** max. 2000 Fotos (`409 photo_limit`, geprüft **vor** dem
  Einlesen der Datei) und max. 200 Markierungen pro Foto (`409 tag_limit`).
- `GET /uploads/:filename` setzt `Content-Disposition: inline;
  filename="<uuid>.<ext>"` und `Cache-Control: private, max-age=86400`.
  Ausgeliefert wird nur, was in `photos.filename` **oder** `persons.portrait`
  steht.

### Portraits

| Methode | Pfad | Body | Antwort |
|---|---|---|---|
| `POST` | `/api/persons/:id/portrait` | `multipart`: `file` | `Person` (mit neuem `portraitUrl`) |
| `DELETE` | `/api/persons/:id/portrait` | – | `Person` (mit leerem `portraitUrl`) |

Nicht auf Admin beschränkt — wer das Familien-Passwort hat, darf Portraits
pflegen, wie beim Anlegen von Personen. Dieselben Regeln wie beim Foto-Upload:
nur `image/jpeg`, `image/png`, `image/webp`, max 15 MB, MIME **und** die
strukturelle Bildprüfung von oben, Dateiname serverseitig aus
`crypto.randomUUID()`. Ein vorhandenes
Portrait wird beim Ersetzen und beim Löschen der Person von der Platte entfernt.

**Wichtig:** `GET /uploads/:filename` liefert bisher nur Dateien, die in `photos`
eingetragen sind. Portraits müssen ebenfalls ausgeliefert werden — die Prüfung
muss also `photos.filename` **oder** `persons.portrait` akzeptieren.

`persons` bekommt dafür eine neue Spalte:

```sql
ALTER TABLE persons ADD COLUMN portrait TEXT NOT NULL DEFAULT '';
```

Im Person-JSON erscheint sie als `portraitUrl` — `"/uploads/<datei>"` oder `""`.
Die Migration entscheidet über `hasColumn` (siehe Abschnitt 2, „Migration") und
darf bestehende Datenbanken nicht beschädigen.

### Einstellungen

Die App heisst als Produkt **Stammbauminator** und ist nicht auf eine bestimmte
Familie zugeschnitten. Der Familienname ist eine Einstellung.

| Methode | Pfad | Body | Antwort |
|---|---|---|---|
| `GET` | `/api/settings` | – (**ohne Session**) | `{ familyName, appTitle }` |
| `POST` | `/api/admin/settings` | `{ familyName }` (**Admin**) | `{ familyName, appTitle }` |

- Gespeichert in `settings` unter dem Schlüssel `family_name`, Vorgabe `''`.
- Validierung: trimmen, max. 40 Zeichen, leer ist erlaubt (setzt zurück).
- `appTitle` berechnet der Server: `familyName ? familyName + ' Stammbaum' : 'Stammbaum'`.
  Damit steht die Regel an genau einer Stelle.
- `GET /api/settings` ist die **einzige** API-Route ohne Session-Pflicht neben
  `/api/auth/login` und `/api/auth/session`. Sie wird in `index.js` bewusst
  **vor** `requireAuth` gemountet (`adminRoutes.publicRouter`), damit das
  Login-Gate den Familiennamen anzeigen kann. Der Nachname ist damit für jeden
  lesbar, der die Adresse kennt — das ist so gewollt. Die Route darf **nie**
  mehr als diese beiden Felder ausliefern.
- Das Schreiben (`POST /api/admin/settings`) bleibt im geschützten Router.
- Ist kein Familienname gesetzt, zeigt das Gate den Produktnamen
  „Stammbauminator" statt des blossen `appTitle` („Stammbaum").

### Admin

| Methode | Pfad | Body | Antwort |
|---|---|---|---|
| `POST` | `/api/admin/passwords` | `{ currentAdminPassword, familyPassword?, adminPassword?, logoutEverywhere? }` | `{ ok: true, changed: string[], sessionsRevoked: number }` |
| `GET` | `/api/admin/stats` | – | `{ persons, partners, unions, photos, tags, portraits, dbSizeBytes }` |

Passwortwechsel verlangt immer das **aktuelle Admin-PW**. Neue Passwörter:
**min. 12 Zeichen** (max. 200), server- und clientseitig geprüft.

Ohne `logoutEverywhere` bleiben bestehende Sessions gültig — blosses Rotieren
hilft aber nicht, wenn ein Passwort abhandengekommen ist. Mit
`logoutEverywhere: true` werden deshalb alle **anderen** Sessions gelöscht, die
eigene bleibt bestehen; `sessionsRevoked` meldet die Anzahl (ohne das Flag `0`).

## 5. Frontend-Architektur

Kein Build-Schritt, keine externen CDN-Requests. Alle Skripte als klassische
`<script>`-Tags (keine ES-Module-Imports), Kommunikation über globale Objekte.

**Was die CSP erzwingt** (siehe Abschnitt 3) — gilt für jede Änderung am Frontend:

- **Kein Inline-`<script>`.** Der Start der App steht in `public/js/boot.js`
  (ruft `App.start()`) und wird als letztes Script eingebunden.
- **Kein zur Laufzeit eingehängter `<style>`-Block.** Stile gehören in eine
  `.css`-Datei; die des Personen-Panels stehen in `public/css/person.css`.
  (`el.style.x = …` bleibt erlaubt — CSSOM statt Markup, das fällt nicht unter
  `style-src`.)
- **Keine externen Quellen** — keine CDNs, Fonts, Bilder oder `fetch` nach
  aussen. Alles kommt von `'self'`.

Bereits vorhanden (**nicht ändern**, nur benutzen):

- `public/css/tokens.css` — Design-System (Farben, Abstände, Typo, Komponenten)
- `public/js/api.js` — `window.API` (fetch-Wrapper, wirft `ApiError`)
- `public/js/store.js` — `window.Store` (Tree-Cache, Helper, Pub/Sub)
- `public/js/app.js` — Login-Gate, Tab-Routing, Toasts, Modal-Helper
- `public/js/image.js` — `window.ImageTools` (Bildverarbeitung im Browser)
- `public/js/boot.js` — Startpunkt, ruft `App.start()`

`public/index.html` ist die App-Shell mit allen Mountpoints. Änderungen daran
beschränken sich auf das **Einbinden neuer Dateien** (`<link>`- und
`<script>`-Tags in der bestehenden Reihenfolge, `boot.js` bleibt zuletzt) —
Struktur, Mountpoints und IDs bleiben unangetastet.

### Verfügbare Globals

```js
API.get(path)                    // → Promise<json>
API.post(path, body)             // body = Objekt (JSON) oder FormData
API.patch(path, body)
API.del(path)
API.ApiError                     // .status, .code, .message

Store.load()                     // lädt /api/tree neu, benachrichtigt Subscriber
Store.data                       // { rootPersonId, persons, unions }
Store.person(id)                 // → Person | undefined
Store.union(id)                  // → Union | undefined
Store.unionsOf(personId)         // → Union[] aller Seiten, je Seite oben→unten
Store.childrenOf(unionId)        // → Person[] (nach Alter; ohne Datum alphabetisch hinten)
Store.bloodlinePersons()         // → Person[] (isPartner === false)
Store.allPersons()               // → Person[] (alle, alphabetisch)
Store.displayName(person)        // → "Anna Muster"
Store.parentUnionOptions()       // → [{ unionId, label }] für Eltern-Dropdowns
Store.subscribe(fn)              // fn wird bei jedem load() aufgerufen; → unsubscribe
Store.rootPerson()               // → Person

// Unions: `unionsOf` findet nur Unions, in denen die Person Blutlinien-Anker
// ist. Für Anzeigen IMMER `unionsInvolving` nehmen — sonst haben eingeheiratete
// Personen scheinbar keine Partner:in und keine Kinder.
Store.unionsInvolving(personId)  // → Union[] (als Anker ODER als Partner:in)
Store.unionStack(personId, side) // → Union[] einer Seite, von OBEN nach UNTEN
Store.unionHasChildren(unionId)  // → bool
Store.sideHasChildUnion(personId, side)  // → bool
Store.canAddUnion(personId, side)        // → bool; steuert das "+"
Store.childrenOfPerson(personId) // → Person[] über alle Unions der Person
Store.spouseIn(union, personId)  // → die jeweils andere Person der Union
Store.descendantsOfUnion(unionId, depth, withPartners)
                                 // → [{ person, generation }] ab generation 1
// Dritter Parameter: Objekt { partners, formerPartners } — `partners` nimmt die
// Partner:innen laufender Partnerschaften mit (union.isCurrent === true),
// `formerPartners` jene beendeter. Ein Wahrheitswert bleibt als alte
// Aufrufform gültig: true = beide, false = keine.

Portrait.load(force)             // → Promise; lädt /api/photos für Ausschnitte
Portrait.invalidate()            // Cache verwerfen (nach Upload/Tag-Änderung)
Portrait.setPhotos(list)         // PFLICHT für jeden, der /api/photos lädt —
                                 // sonst bleibt der Ausschnitt-Index veraltet
Portrait.subscribe(fn)           // fn(photos), wenn sich die Bildquellen ändern
Portrait.source(person)          // → { kind: 'portrait'|'crop'|'initials', url?, photo?, tag? }
// Quellenwahl beim Ausschnitt: unter den 3 jüngsten Fotos mit Markierung
// gewinnt das mit den meisten echten Bildpunkten im Ausschnitt
// (Ausschnittanteil × Bildbreite) — ein Gruppenbild aus grosser Distanz liefert
// sonst einen unscharfen Farbfleck. Ein älteres Foto muss dafür 15 % mehr
// Pixel bringen, sonst bliebe die Wahl bei jeder neuen Markierung unruhig.
Portrait.hasImage(person)        // → bool
Portrait.apply(el, person, size) // setzt Hintergrundbild bzw. Initialen; size = Kantenlänge px
Portrait.sourcePhoto(person)     // → Photo, aus dem der Ausschnitt stammt

// Bildverarbeitung im Browser (js/image.js). PFLICHT für jeden, der Bilder vor
// dem Hochladen anfasst — nicht nochmals selbst implementieren.
ImageTools.load(file)            // → Promise<ImageBitmap|HTMLImageElement>
ImageTools.release(source)       // Object-URL bzw. Bitmap wieder freigeben
ImageTools.hasAlpha(source, w, h)// → bool (entscheidet PNG vs. JPEG)
ImageTools.renameFor(name, mimeType, { fallback, maxBase })  // → Dateiname
ImageTools.formatBytes(bytes)    // → '1,2 MB' (de-CH)
ImageTools.resizeToFit(file, { maxEdge, quality, skipUnderBytes })
                                 // → Promise<{ blob, width, height, filename, resized }>
ImageTools.squareCrop(file, { maxEdge, quality })
                                 // → Promise<{ blob, width, height, filename }>

App.onTabChange(fn)              // fn(tabName), sobald ein Tab sichtbar wird
App.activeTab                    // 'tree' | 'photos' | 'quiz' | 'admin'

App.formatDate(iso)              // '2000-01-01' → '01.01.2000'; Teilangaben bleiben
App.parseDateInput(text)         // → { ok, value } | { ok: false, message }
App.DATE_HINT                    // einheitlicher Eingabehinweis

App.settings                     // { familyName, appTitle } — nach dem Login geladen
App.applySettings(settings)      // Kopfzeile und document.title neu setzen
App.onSettingsChange(fn)         // fn(settings); → unsubscribe

App.role                         // 'family' | 'admin' | null
App.isAdmin()                    // → bool
App.onRoleChange(fn)             // → unsubscribe
App.handleAdminExpired()         // ruft api.js bei 403 + Code 'forbidden' auf:
                                 // abgelaufener Adminmodus → zurück auf 'family'
                                 // (die Anmeldung selbst bleibt bestehen)
App.toast(message, type)         // type: 'success' | 'error' | 'info'
App.modal({ title, body, actions }) // body = HTMLElement, actions = [{label,variant,onClick}]
                                    // → { close() }; onClick bekommt ({ close })
App.confirm({ title, message, confirmLabel, danger }) // → Promise<bool>
App.showTab(name)                // 'tree' | 'photos' | 'admin'
App.escapeHtml(str)              // → string
```

### Modul-Vertrag

Jedes Modul registriert sich global und implementiert `mount(rootElement)`.
`mount` wird genau einmal beim App-Start aufgerufen (nach erfolgreichem Login).
Module reagieren selbst auf `Store.subscribe` und `App.onRoleChange`.

| Modul | Datei(en) | Global | Mountpoint |
|---|---|---|---|
| Stammbaum | `js/tree.js`, `css/tree.css` | `window.TreeView` | `#tab-tree` |
| Personen-Panel | `js/person.js`, `css/person.css` | `window.PersonPanel` | `#person-panel` |
| Fotoalbum | `js/photos.js`, `css/photos.css` | `window.PhotoAlbum` | `#tab-photos` |
| Lern-Quiz | `js/quiz.js`, `css/quiz.css` | `window.QuizView` | `#tab-quiz` |
| Admin | `js/admin.js`, `css/admin.css` | `window.AdminView` | `#tab-admin` |

Zusätzlich exportiert `PersonPanel`:
- `PersonPanel.open(personId)` — Detailpanel öffnen
- `PersonPanel.close()`

Zusätzlich exportiert `TreeView`:
- `TreeView.focusPerson(personId)` — Knoten zentrieren und kurz hervorheben

## 6. Design-System

Verbindlich: **nur** die Custom Properties aus `css/tokens.css` verwenden, keine
Hex-Farben in Modul-CSS. Sommerlich, freundlich, hell. Utility-Klassen und
Komponenten (`.btn`, `.card`, `.field`, `.pill`, …) sind in `tokens.css`
definiert und dokumentiert — zuerst dort nachschauen, bevor neues CSS entsteht.

Regeln:
- Mobile-first, ab `768px` Desktop-Layout. Muss auf dem Handy bedienbar sein.
- Keine externen Fonts/Bilder/Skripte (funktioniert offline) — die CSP des
  Servers erlaubt ohnehin nur `'self'`.
- Stile gehören in eine `.css`-Datei, die `index.html` per `<link>` einbindet.
  Ein zur Laufzeit eingehängter `<style>`-Block wird von der CSP blockiert
  (`style-src 'self'`, kein `'unsafe-inline'`) — deshalb liegen z.B. die Stile
  des Personen-Panels in `css/person.css`. `el.style.x = …` bleibt erlaubt.
- Fokus-Ringe nie entfernen (`:focus-visible` ist in tokens.css gestylt).
- Touch-Ziele min. 44×44 px.
- Deutsche UI-Texte, Schweizer Schreibweise (**ss statt ß**).

## 7. Deployment

- Docker-Image baut aus `Dockerfile` (node:24-alpine), Port 3000 im Container.
- Persistente Daten in `/app/data` (Volume-Mount `./data`): `stammbaum.db` + `uploads/`.
- Container haengt im Docker-Netzwerk des Reverse Proxy und wird ueber eine eigene Subdomain veroeffentlicht.
- Details in `DEPLOY.md`.
