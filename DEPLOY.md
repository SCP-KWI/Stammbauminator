# Deployment — Stammbauminator

Anleitung zum Aufsetzen der App auf einem Linux-Server mit Docker. Zielzustand:
die App läuft in einem Container und ist über einen Reverse Proxy mit TLS unter
einer eigenen Subdomain erreichbar.

Diese Anleitung beschreibt bewusst nur den allgemeinen Teil. Wie DNS-Einträge
und Zertifikate angelegt werden, hängt vom jeweiligen Domain-Anbieter und
Reverse Proxy ab und steht in deren Dokumentation.

Alle Server-Befehle laufen per SSH auf dem Server, alle Befehle mit dem
Kommentar „auf dem Arbeitsrechner" lokal.

In allen Beispielen sind Platzhalter einzusetzen:

| Platzhalter | Bedeutung |
|---|---|
| `/opt/apps/stammbaum` | Ordner der App auf dem Server |
| `stammbaum.example.com` | die eigene Subdomain |
| `BENUTZER@SERVER` | SSH-Zugang zum Server |
| `PROXY_NETZ` | Docker-Netzwerk, in dem der Reverse Proxy hängt |

Feste Werte:

| | |
|---|---|
| Container-Name | `stammbaum` |
| Interner Port | `3000` (nicht nach aussen freigegeben) |
| Persistente Daten | `<App-Ordner>/data/` |

---

## 1. Dateien auf den Server bringen

Es gibt zwei sinnvolle Wege. **Empfohlen ist `git clone`** — damit sind Updates
später ein einzelnes `git pull`. (Vom Speichern über den Browser wird abgeraten,
die Dateien landen sonst mit falschen Namen oder Zeilenenden.)

### Variante A (empfohlen): git clone

Ordner anlegen:

```bash
sudo mkdir -p /opt/apps/stammbaum && sudo chown -R $USER:$USER /opt/apps/stammbaum
```

Repository hineinklonen:

```bash
git clone https://github.com/SCP-KWI/Stammbauminator.git /opt/apps/stammbaum
```

### Variante B: rsync vom Arbeitsrechner

```bash
# auf dem Arbeitsrechner
rsync -av --delete --exclude node_modules --exclude data --exclude .git --exclude .env /pfad/zum/projekt/stammbauminator/ BENUTZER@SERVER:/opt/apps/stammbaum/
```

Anschliessend prüfen, dass alles da ist:

```bash
ls -la /opt/apps/stammbaum
```

Erwartet: `Dockerfile`, `docker-compose.yml`, `.env.example`, `app.json`,
`package.json`, `package-lock.json`, `server/`, `public/`.

---

## 2. `.env` anlegen und starke Startpasswörter setzen

```bash
cd /opt/apps/stammbaum && cp .env.example .env
```

Zwei starke Passwörter erzeugen (zweimal ausführen, Ausgabe notieren):

```bash
openssl rand -base64 18
```

`.env` bearbeiten und die beiden Werte eintragen:

```bash
nano /opt/apps/stammbaum/.env
```

Inhalt danach sinngemäss:

```bash
INITIAL_FAMILY_PASSWORD=<starkes Passwort fuer die Familie>
INITIAL_ADMIN_PASSWORD=<anderes starkes Passwort fuer den Adminbereich>
```

Rechte einschränken, damit die Passwörter nicht mitlesbar sind:

```bash
chmod 600 /opt/apps/stammbaum/.env
```

> Diese Werte greifen **nur beim allerersten Start**, solange noch keine
> `data/stammbaum.db` existiert. Danach liegen die Passwörter gehasht in der
> Datenbank und werden ausschliesslich über den Admin-Bereich der App geändert.
> Mindestens 12 Zeichen — dieselbe Untergrenze gilt später im Adminbereich.

> **Ein fest eingebautes Standardpasswort gibt es nicht.** Fehlt eine der beiden
> Variablen, bricht `docker compose` bereits vor dem Start ab — beide sind in der
> `docker-compose.yml` als Pflicht markiert. Startet die App ohne Compose,
> erzeugt sie stattdessen ein zufälliges starkes Passwort und gibt es einmalig
> im Log aus.

---

## 3. Datenverzeichnis anlegen — vor dem ersten Start

**Diesen Schritt nicht überspringen.** Der Ordner `data/` ist nicht im
Repository. Legt Docker ihn beim ersten Start selbst an, gehört er `root` — und
die App, die im Container als Benutzer `node` (UID 1000) läuft, kann nicht
hineinschreiben. Der Container startet dann in einer Endlosschleife neu mit
`EACCES: permission denied, mkdir '/app/data/uploads'`.

Das `chown` im Dockerfile hilft hier nicht: Ein Bind-Mount überdeckt das
Verzeichnis aus dem Image vollständig, die Rechte kommen vom Host.

```bash
mkdir -p /opt/apps/stammbaum/data/uploads
```

```bash
sudo chown -R 1000:1000 /opt/apps/stammbaum/data
```

---

## 4. Container bauen und starten

```bash
cd /opt/apps/stammbaum && docker compose up -d --build
```

Logs anschauen (mit `Strg+C` verlassen):

```bash
docker compose -f /opt/apps/stammbaum/docker-compose.yml logs -f stammbaum
```

Status prüfen — erwartet `Up (healthy)`:

```bash
docker ps --filter name=stammbaum
```

Schneller Funktionstest von innerhalb des Docker-Netzwerks:

```bash
docker exec stammbaum wget -qO- http://127.0.0.1:3000/api/auth/session
```

Erwartete Antwort: `{"authenticated":false,"role":null,"adminUntil":""}`

---

## 5. Erreichbar machen: DNS und Reverse Proxy

Beides ist anbieterabhängig und hier nur im Grundsatz beschrieben.

**DNS:** Beim Domain-Anbieter einen Eintrag anlegen, der die gewünschte
Subdomain auf den Server zeigen lässt — je nach Situation ein A-Record auf eine
feste IP oder ein CNAME auf einen DynDNS-Namen. Vor dem nächsten Schritt prüfen,
dass die Auflösung stimmt, sonst schlägt die Zertifikatsanfrage fehl:

```bash
nslookup stammbaum.example.com
```

**Reverse Proxy:** Die App gibt keinen Port nach aussen frei. Der Proxy muss
deshalb im selben Docker-Netzwerk hängen und auf den Container-Namen
weiterleiten:

| Feld | Wert |
|---|---|
| Domain | `stammbaum.example.com` |
| Ziel-Schema | `http` |
| Ziel-Host | `stammbaum` (Container-Name, nicht `localhost`, nicht die Server-IP) |
| Ziel-Port | `3000` |
| Websockets | aktivieren |

Danach ein TLS-Zertifikat einrichten (z.B. Let's Encrypt) und **HTTP auf HTTPS
umleiten**. Das ist nicht optional: Das Session-Cookie heisst im TLS-Betrieb
`__Host-stb_session` und wird mit `Secure` gesetzt (`SECURE_COOKIES=true`) —
über reines HTTP verwirft der Browser es. Ebenso schickt die App dann
`Strict-Transport-Security`.

Test:

```bash
curl -I https://stammbaum.example.com
```

---

## 6. Test im Inkognito-Fenster

Ein **privates / Inkognito-Fenster** öffnen (umgeht Browser-Cache und alte
Cookies) und die Subdomain aufrufen.

Checkliste:

- Log des ersten Starts durchsehen, ob die App ein Passwort selbst erzeugt hat
  (`docker compose -f /opt/apps/stammbaum/docker-compose.yml logs stammbaum | grep ACHTUNG`).
  Erscheint dort „`ACHTUNG: INITIAL_…_PASSWORD war nicht gesetzt`", steht das
  erzeugte Zufallspasswort einmalig daneben — sofort notieren, es taucht
  nirgends wieder auf.
- Login-Maske erscheint
- Login mit dem Familien-Passwort aus der `.env` funktioniert
- Der Stammbaum zeigt die beiden Personen aus dem Startbestand
- Admin-Bereich lässt sich mit dem Admin-Passwort freischalten
- Foto-Upload und das Markieren einer Person im Bild funktionieren
- Seite auf dem Handy aufrufen und bedienen

**Direkt danach:** im Admin-Bereich beide Passwörter auf die endgültigen Werte
ändern (mindestens 12 Zeichen) und diese in einem Passwortmanager ablegen.

Der Adminmodus läuft nach 30 Minuten von selbst ab. Die Anmeldung bleibt dabei
bestehen, es fallen nur die Adminrechte weg — im Adminbereich einfach nochmals
mit dem Admin-Passwort freischalten.

---

## 7. Backup

### Was gesichert werden muss

Alles liegt unter `/opt/apps/stammbaum/data/`:

- `stammbaum.db` — die Datenbank
- `stammbaum.db-wal` und `stammbaum.db-shm` — die WAL-Dateien. **Wichtig:**
  SQLite läuft im WAL-Modus, die zuletzt geschriebenen Daten stehen unter
  Umständen nur im `-wal`. Eine Kopie von `stammbaum.db` allein kann daher
  unvollständig oder inkonsistent sein.
- `uploads/` — alle hochgeladenen Fotos

Zusätzlich sichern (einmalig, ändert sich selten): `.env` — enthält nur die
Startpasswörter, ist aber trotzdem vertraulich.

### Backups sind Klartext

Datenbank und Uploads liegen **unverschlüsselt** auf der Platte — die App
speichert Adressen, Telefonnummern, Geburtsdaten und Fotos, auch von
Minderjährigen. Jede Kopie davon ist damit ebenfalls Klartext. Deshalb:

- Zugriffsrechte einschränken: `chmod 700 ~/backups/stammbaum`
- Archive vor dem Auslagern (Cloud-Speicher, externe Platte, anderes Gerät)
  verschlüsseln:

```bash
age -p -o ~/backups/stammbaum-JJJJ-MM-TT.tar.gz.age ~/backups/stammbaum-JJJJ-MM-TT.tar.gz
```

oder ohne Zusatzwerkzeug:

```bash
gpg -c ~/backups/stammbaum-JJJJ-MM-TT.tar.gz
```

Beide fragen die Passphrase interaktiv ab; danach die unverschlüsselte Datei
löschen. Die Passphrase gehört in den Passwortmanager — ohne sie ist das Backup
wertlos.

### Variante A (empfohlen): im laufenden Betrieb, ohne Zusatzwerkzeug

Der Container bringt Node mit, und Node kann SQLite. Das mitgelieferte Werkzeug
schreibt mit `VACUUM INTO` eine in sich geschlossene Kopie — auch während
gearbeitet wird, ohne Auszeit und ohne `sqlite3` auf dem Host.

Datenbank sichern:

```bash
docker exec stammbaum node server/tools/backup.js /app/data/backup.db
```

Es meldet danach, was in der Kopie steckt, und prüft sie mit
`PRAGMA integrity_check` gegen. Die Datei liegt durch den Bind-Mount sofort auf
dem Host. Wegschieben und mit den Fotos zusammenpacken:

```bash
mkdir -p ~/backups/stammbaum && mv /opt/apps/stammbaum/data/backup.db ~/backups/stammbaum/stammbaum-$(date +%F).db
```

```bash
rsync -a --delete /opt/apps/stammbaum/data/uploads/ ~/backups/stammbaum/uploads/
```

> Das Werkzeug überschreibt nie eine bestehende Datei. Liegt `backup.db` noch
> vom letzten Lauf da, bricht es ab, statt sie zu ersetzen. Wer das automatisiert
> (z.B. per Cron), räumt sie deshalb vor dem Lauf mit `rm -f` weg.

Wer lieber das SQLite-Kommandozeilenwerkzeug nutzt, kann das weiterhin tun
(`sudo apt install -y sqlite3`, dann
`sqlite3 …/stammbaum.db ".backup '…/stammbaum-$(date +%F).db'"`) — nötig ist es
nicht mehr.

### Variante B: der einfache, garantiert konsistente Weg (Container kurz stoppen)

Ein paar Sekunden Downtime, dafür ohne Zusatzwerkzeug und inklusive allem:

```bash
cd /opt/apps/stammbaum && docker compose stop && tar -czf ~/backups/stammbaum-$(date +%F).tar.gz -C /opt/apps/stammbaum data && docker compose start
```

### Wiederherstellen

```bash
cd /opt/apps/stammbaum && docker compose down
```

```bash
tar -xzf ~/backups/stammbaum-JJJJ-MM-TT.tar.gz -C /opt/apps/stammbaum
```

```bash
cd /opt/apps/stammbaum && docker compose up -d
```

Bei einer `.backup`-Datei stattdessen die Datei nach
`data/stammbaum.db` kopieren und `data/stammbaum.db-wal` sowie
`data/stammbaum.db-shm` vorher löschen — beide werden neu angelegt.

Liegen die Backups auf demselben Server, sind sie nur gegen Bedienfehler
geschützt, nicht gegen einen Ausfall. Für den Ernstfall den Backup-Ordner
zusätzlich auf ein anderes Gerät oder einen Cloud-Speicher spiegeln. Auch dort
gilt: vorher verschlüsseln (siehe oben).

---

## 8. Update einspielen

Vorher ein Backup ziehen (siehe Abschnitt 7), dann:

```bash
cd /opt/apps/stammbaum && git pull
```

Bei Variante B aus Schritt 1 stattdessen erneut vom Arbeitsrechner synchronisieren:

```bash
# auf dem Arbeitsrechner
rsync -av --delete --exclude node_modules --exclude data --exclude .git --exclude .env /pfad/zum/projekt/stammbauminator/ BENUTZER@SERVER:/opt/apps/stammbaum/
```

Neu bauen und starten:

```bash
cd /opt/apps/stammbaum && docker compose up -d --build
```

Kontrolle:

```bash
docker compose -f /opt/apps/stammbaum/docker-compose.yml logs --tail 50 stammbaum
```

`data/` bleibt dabei unangetastet: Der Ordner liegt auf dem Host und wird nur ins
Image hineingemountet, nie mit hineingebaut (`.dockerignore` und `.gitignore`
schliessen ihn aus). Passwörter, Personen und Fotos überleben ein Update also.
Fehlende Spalten ergänzt die App beim Start selbst; das Schema ist auf Stand `3`.

Alte Images gelegentlich aufräumen:

```bash
docker image prune -f
```

---

## 9. Fehlersuche

### 502 Bad Gateway vom Proxy

Der Proxy erreicht den Container nicht. Zuerst prüfen, ob er überhaupt läuft:

```bash
docker ps -a --filter name=stammbaum
```

Läuft er nicht oder startet er im Kreis, in die Logs schauen:

```bash
docker logs --tail 100 stammbaum
```

Läuft er, ist meist der Ziel-Host im Proxy falsch: Er muss exakt `stammbaum`
und der Port `3000` sein — nicht `localhost`, nicht die Server-IP. Prüfen, ob
Proxy und App im selben Netzwerk hängen:

```bash
docker network inspect PROXY_NETZ --format '{{range .Containers}}{{.Name}} {{end}}'
```

Fehlt `stammbaum` in der Liste:

```bash
cd /opt/apps/stammbaum && docker compose up -d
```

Gegenprobe direkt aus dem Proxy-Container heraus:

```bash
docker exec PROXY_CONTAINER wget -qO- http://stammbaum:3000/api/auth/session
```

### Login klappt, aber man wird sofort wieder ausgeloggt

Das Session-Cookie kommt nicht zurück. Ursache ist fast immer `SECURE_COOKIES=true`
ohne funktionierendes HTTPS: Das Cookie heisst dann `__Host-stb_session` und
verlangt zwingend `Secure` — über `http://` verwirft der Browser es.

- Prüfen, dass das Zertifikat aktiv ist und HTTP zwingend auf HTTPS umgeleitet
  wird (Schritt 5), und die Seite über `https://` aufrufen.
- Nur für einen lokalen Test ohne TLS in `docker-compose.yml` vorübergehend
  `SECURE_COOKIES: "false"` setzen und `docker compose up -d` — danach unbedingt
  wieder auf `"true"` zurückstellen. Die App heisst das Cookie dann wieder
  `stb_session` und schickt kein `Strict-Transport-Security`.
- Landen alle Zugriffe unter derselben IP, fehlt am Proxy der
  `X-Forwarded-For`-Header. Die App wertet ihn nie selbst aus, sondern nimmt
  `req.ip` mit `trust proxy = 1`, also genau den Eintrag, den der Proxy anhängt.
  Fehlt der Header, zählt das Rate-Limit alle Fehlversuche auf die Proxy-IP —
  dann sperrt ein einzelner Vertipper alle aus (10 Fehlversuche pro IP und
  15 Minuten).

### Rechteproblem auf `data/`

Symptom in den Logs: `EACCES: permission denied, mkdir '/app/data/uploads'`,
`SQLITE_CANTOPEN` oder `permission denied` beim Schreiben — der Container
startet dabei in einer Endlosschleife neu.

Das passiert, wenn Schritt 3 übersprungen wurde: Docker legt `data/` beim ersten
Start als `root` an, die App läuft aber als `node` (UID 1000). Neuere Fassungen
der App melden das im Log im Klartext statt mit einem Stacktrace.

Der Ordner auf dem Host muss dem Benutzer mit UID 1000 gehören:

```bash
sudo chown -R 1000:1000 /opt/apps/stammbaum/data
```

```bash
cd /opt/apps/stammbaum && docker compose restart
```

Kontrolle von innen:

```bash
docker exec stammbaum ls -la /app/data
```

### Passwort vergessen

Die Passwörter stehen gehasht in der Tabelle `settings` (Schlüssel
`family_password` und `admin_password`). Die Werte in der `.env` helfen nicht
mehr — sie werden nach dem ersten Start ignoriert.

Gehasht wird mit der Funktion der App selbst — so ist das Format garantiert
identisch zu dem, was sie beim Prüfen erwartet. Dafür gibt es zwei Ausführungen:

- `hashPassword` aus `server/auth.js` ist **asynchron** und liefert ein Promise.
  In einem Einzeiler wie unten würde damit wörtlich `[object Promise]` in der
  Datenbank landen — unbrauchbar.
- `hashPasswordSync` aus `server/db.js` ist die synchrone Ausführung (sie
  bedient auch den Startbestand beim ersten Start). **Diese hier verwenden.**

Das neue Passwort darf nicht als Kommandozeilenargument übergeben werden: es
stünde sonst in der Shell-History und wäre während der Laufzeit in `ps` für
jeden Benutzer des Servers sichtbar. Stattdessen einlesen (`-s` zeigt beim
Tippen nichts an, `-r` lässt Backslashes in Ruhe) und über die Standardeingabe
hineinreichen:

```bash
printf 'Neues Admin-Passwort: '; read -rs NEW_PW; echo
```

```bash
printf '%s' "$NEW_PW" | docker exec -i stammbaum node -e "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const{setSetting,hashPasswordSync}=require('/app/server/db.js');setSetting('admin_password',hashPasswordSync(s));console.log('admin_password neu gesetzt');});"
```

Danach die Variable wieder aus der Sitzung werfen:

```bash
unset NEW_PW
```

Für das Familien-Passwort dasselbe mit `family_password` statt `admin_password`.
Mindestens 12 Zeichen — die App prüft das an dieser Stelle nicht, im Adminbereich
später schon.

Danach den Container neu starten, damit nichts Altes im Speicher hängt:

```bash
docker compose -f /opt/apps/stammbaum/docker-compose.yml restart
```

Aktuellen Zustand der Tabelle anschauen (zeigt die Hashes, nicht die Passwörter):

```bash
docker exec stammbaum node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/app/data/stammbaum.db');console.log(db.prepare('SELECT key, substr(value,1,12)||chr(8230) AS wert FROM settings').all());"
```

**Letzter Ausweg**, wenn gar nichts mehr geht: Backup ziehen, die Datenbank
beiseiteschieben und die App einmal frisch aufsetzen lassen. Achtung — dabei
sind alle Personen und Fototags weg, die Bilddateien in `data/uploads/` bleiben:

```bash
cd /opt/apps/stammbaum && docker compose down && mv data/stammbaum.db data/stammbaum.db.alt && rm -f data/stammbaum.db-wal data/stammbaum.db-shm && docker compose up -d
```

Danach gelten wieder die Passwörter aus der `.env`.

### „Partner:in unbekannt" ohne Inhalt im Stammbaum

In früheren Fassungen blieb beim Löschen einer eingeheirateten Person deren
Partnerschaft stehen: `partner_id` wurde geleert, die Partnerschaft selbst nicht
entfernt. Im Baum erscheint dann eine leere Karte „Partner:in unbekannt". Neue
entstehen nicht mehr — schon vorhandene räumt dieses Skript weg.

**Zuerst nur anschauen** (verändert nichts):

```bash
docker exec stammbaum node server/tools/aufraeumen.js
```

Die Liste durchsehen. Passt sie, dann löschen:

```bash
docker exec stammbaum node server/tools/aufraeumen.js --apply
```

Vorher ein Backup ziehen (siehe Abschnitt 7) — es wird gelöscht.

Das Skript fasst **nur** Partnerschaften an, die weder eine Partner:in **noch**
Kinder haben. Eine Partnerschaft ohne Partner:in, an der Kinder hängen, bleibt
unberührt: Sie ist zulässig (alleinerziehend oder anderer Elternteil unbekannt),
und ein Löschen würde über `ON DELETE CASCADE` die Kinder samt deren
Nachkommenschaft mitreissen.

Zusätzlich meldet das Skript eingeheiratete Personen, die zu gar keiner
Partnerschaft mehr gehören und damit im Baum unsichtbar sind. Die **löscht es
nicht** — dort lässt sich nicht maschinell entscheiden, ob sie noch gebraucht
werden. Bei Bedarf über die Personenliste im Adminbereich entfernen.

Der Aufruf ist beliebig wiederholbar; findet er nichts, meldet er das.

### Weitere nützliche Befehle

Alle Umgebungsvariablen des laufenden Containers anzeigen:

```bash
docker exec stammbaum env
```

Compose-Konfiguration vor dem Start prüfen (meckert bei fehlender `.env`):

```bash
cd /opt/apps/stammbaum && docker compose config
```

Container komplett neu aufbauen (ohne Cache):

```bash
cd /opt/apps/stammbaum && docker compose build --no-cache && docker compose up -d
```
