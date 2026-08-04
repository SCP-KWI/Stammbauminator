/* Stammbauminator — Startpunkt
   Startet die App, sobald alle Module geladen sind.
   Bewusst eine eigene Datei statt eines Inline-Scripts: die Content-Security-
   Policy des Servers erlaubt nur `script-src 'self'` ohne `'unsafe-inline'` —
   ein Inline-Script würde blockiert und die App startete gar nicht. */
(function () {
  'use strict';

  App.start();
})();
