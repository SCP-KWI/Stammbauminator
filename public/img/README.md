# Platzhalterbilder

`platzhalter-1.jpg`, `platzhalter-2.jpg` und `platzhalter-3.jpg` sind
**Platzhalter zum Ersetzen**. Sie wurden programmatisch erzeugt (abstrakte
Figuren in den Farben aus `css/tokens.css`) und zeigen **keine echten
Personen**. Sie dienen nur dazu, das Fotoalbum und die Personen-Markierung
auszuprobieren, bevor echte Familienfotos vorhanden sind.

- Format: JPEG, ca. 1600 × 1000 px, je unter 100 KB
- Motiv: sommerliche Szene mit ein paar abstrakten Figuren, die man markieren kann

## Ins Album bringen

Der Server-Seed spielt diese Bilder **nicht** automatisch ein — Fotos leben in
`data/uploads/` und in der Tabelle `photos`. So kommen sie hinein:

1. In der App anmelden und den Tab **Admin** öffnen.
2. Mit dem Admin-Passwort freischalten.
3. Unter **Fotos hochladen** eine der Dateien aus diesem Ordner auswählen,
   Titel (z. B. „Gartenfest 2024“) und optional ein Datum eintragen, hochladen.
4. Im Tab **Fotoalbum** erscheint das Bild; per Klick ins Bild lassen sich
   Personen markieren.

Sobald echte Fotos vorhanden sind, können diese Dateien gelöscht werden — sie
werden von der App nirgends fest referenziert.
