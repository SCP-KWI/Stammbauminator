/* Stammbauminator — Portraits
   Globals: window.Portrait

   Bildquelle für eine Person, in dieser Reihenfolge:
     1. hochgeladenes Portrait (person.portraitUrl)
     2. Ausschnitt aus dem aktuellsten Gruppenfoto, auf dem sie markiert ist
     3. Initialen (kein Bild vorhanden)

   Der Ausschnitt entsteht rein clientseitig: Das Gruppenfoto wird als
   background-image so skaliert und verschoben, dass die Markierung (x/y,
   normiert auf 0..1) in der Mitte des quadratischen Rahmens liegt. */
(function () {
  'use strict';

  // Kantenlänge des Ausschnitts als Anteil der Bildbreite.
  //
  // Ein fester Wert funktioniert nicht: Auf einem Foto mit acht Personen ist ein
  // Kopf ungefähr ein Sechstel der Bildbreite, auf einem Gruppenbild mit dreissig
  // Leuten nur ein Vierzigstel. Derselbe Anteil liefert einmal ein Portrait und
  // einmal eine halbe Sitzreihe.
  //
  // Darum wird die Grösse aus den Markierungen desselben Fotos geschätzt: Der
  // Abstand zur nächstgelegenen anderen Markierung entspricht ungefähr dem
  // Personenabstand, und ein Kopf ist etwas kleiner als dieser Abstand. Das ist
  // dasselbe Signal, das eine Gesichtserkennung liefern würde — nur ohne Modell.
  // Je mehr Personen markiert sind, desto genauer wird die Schätzung.
  const CROP_FRACTION = 0.08;     // Rückfall, solange nur eine Markierung existiert
  const CROP_SPACING_FACTOR = 1.1; // Kopf + etwas Schulter, relativ zum Abstand
  const CROP_MIN = 0.02;
  const CROP_MAX = 0.25;

  // Wie viele der jüngsten Fotos für die Bildquelle in Frage kommen.
  const CANDIDATE_PHOTOS = 3;
  // Ein älteres Foto muss deutlich schärfer sein, um das neuere zu verdrängen.
  const MIN_SHARPNESS_GAIN = 1.15;

  let photos = [];            // wie von /api/photos geliefert
  let bestByPerson = new Map(); // personId → { photo, tag }
  let loadPromise = null;
  let fractionCache = new Map();  // photoId → Ausschnittanteil
  const subscribers = new Set();

  const Portrait = {
    CROP_FRACTION,

    /** Fotos laden und den Index aufbauen. Mehrfachaufrufe teilen sich einen
        laufenden Request; `force` erzwingt ein Neuladen. */
    load(force) {
      if (loadPromise && !force) return loadPromise;
      loadPromise = API.get('/api/photos')
        .then((list) => {
          photos = Array.isArray(list) ? list : [];
          reindex();
          return photos;
        })
        .catch((err) => {
          // Ohne Fotos funktioniert weiterhin alles, nur ohne Ausschnitte.
          console.warn('Fotos für Portraits nicht ladbar', err);
          photos = [];
          reindex();
          return photos;
        });
      return loadPromise;
    },

    /** Cache verwerfen — nach Foto-Upload, Löschen oder neuer Markierung. */
    invalidate() {
      loadPromise = null;
    },

    /**
     * Frisch geladene Fotoliste übernehmen, ohne erneut zu laden.
     *
     * Wer /api/photos ohnehin abruft (Fotoalbum, Adminbereich), MUSS das
     * Ergebnis hier durchreichen. Sonst bleibt der Index veraltet und eine eben
     * gesetzte Markierung erzeugt keinen Portrait-Ausschnitt, bis die Seite neu
     * geladen wird — genau dieser Fehler ist schon einmal aufgetreten.
     */
    setPhotos(list) {
      photos = Array.isArray(list) ? list : [];
      reindex();
      loadPromise = Promise.resolve(photos);
      for (const fn of subscribers) {
        try { fn(photos); }
        catch (err) { console.error('Portrait-Subscriber fehlgeschlagen', err); }
      }
      return photos;
    },

    /** Benachrichtigung, wenn sich die Bildquellen geändert haben. */
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    /** @returns {{kind:'portrait'|'crop'|'initials', url?:string, photo?:object, tag?:object}} */
    source(person) {
      if (!person) return { kind: 'initials' };
      if (person.portraitUrl) return { kind: 'portrait', url: person.portraitUrl };
      const hit = bestByPerson.get(Number(person.id));
      if (hit) return { kind: 'crop', url: hit.photo.url, photo: hit.photo, tag: hit.tag };
      return { kind: 'initials' };
    },

    hasImage(person) {
      return Portrait.source(person).kind !== 'initials';
    },

    /** Anzahl Personen mit Bild — fürs Quiz, um leere Kärtchen zu vermeiden. */
    countWithImage(persons) {
      return persons.reduce((n, p) => n + (Portrait.hasImage(p) ? 1 : 0), 0);
    },

    /**
     * Setzt das Bild als Hintergrund eines quadratischen Elements.
     * Das Element muss bereits seine Grösse haben (CSS), `size` ist die
     * Kantenlänge in px und wird für die Ausschnitt-Berechnung gebraucht.
     * Ohne Bild werden die Initialen als Text gesetzt.
     *
     * @param {HTMLElement} el
     * @param {object} person
     * @param {number} size  Kantenlänge in px
     */
    apply(el, person, size) {
      const src = Portrait.source(person);
      el.classList.remove('has-portrait', 'has-crop');
      el.style.backgroundImage = '';
      el.style.backgroundSize = '';
      el.style.backgroundPosition = '';

      if (src.kind === 'initials') {
        el.textContent = Store.initials(person);
        el.removeAttribute('aria-label');
        return src;
      }

      el.textContent = '';
      el.style.backgroundImage = 'url("' + encodeURI(src.url) + '")';

      if (src.kind === 'portrait') {
        el.classList.add('has-portrait');
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
      } else {
        el.classList.add('has-crop');
        const geom = Portrait.cropGeometry(src.photo, src.tag, size);
        el.style.backgroundSize = geom.width + 'px ' + geom.height + 'px';
        el.style.backgroundPosition = geom.x + 'px ' + geom.y + 'px';
      }

      el.setAttribute('aria-label', Store.displayName(person));
      return src;
    },

    /**
     * Hintergrund-Geometrie für den quadratischen Ausschnitt.
     * Skaliert das Foto so, dass CROP_FRACTION der Bildbreite genau `size`
     * füllt, und verschiebt es so, dass die Markierung mittig sitzt. Der
     * Versatz wird geklemmt, damit an den Bildrändern keine Leerfläche entsteht.
     */
    cropGeometry(photo, tag, size) {
      const ratio = photo && photo.width && photo.height
        ? photo.height / photo.width
        : 2 / 3;                       // Notfall-Annahme, falls Masse fehlen

      const width = size / Portrait.cropFractionFor(photo);
      const height = width * ratio;

      const x = clamp(size / 2 - tag.x * width, size - width, 0);
      const y = clamp(size / 2 - tag.y * height, size - height, 0);

      return { width: round(width), height: round(height), x: round(x), y: round(y) };
    },

    /**
     * Geschätzte Ausschnittgrösse für ein Foto, als Anteil der Bildbreite.
     *
     * Grundlage ist der Median der Abstände zur jeweils nächsten anderen
     * Markierung — gerechnet in echten Bildpixeln, damit hochkant und quer
     * gleich behandelt werden. Bei weniger als zwei Markierungen gibt es kein
     * Signal, dann greift der Rückfallwert.
     */
    cropFractionFor(photo) {
      if (!photo) return CROP_FRACTION;
      if (fractionCache.has(photo.id)) return fractionCache.get(photo.id);

      const tags = photo.tags || [];
      const w = photo.width || 0;
      const h = photo.height || (w ? w * 2 / 3 : 0);

      let fraction = CROP_FRACTION;
      if (tags.length >= 2 && w > 0) {
        const nearest = [];
        for (const a of tags) {
          let best = Infinity;
          for (const b of tags) {
            if (a === b) continue;
            const dx = (a.x - b.x) * w;
            const dy = (a.y - b.y) * h;
            const dist = Math.hypot(dx, dy);
            if (dist < best) best = dist;
          }
          if (best < Infinity && best > 0) nearest.push(best / w);
        }
        if (nearest.length) {
          nearest.sort((p, q) => p - q);
          const mid = Math.floor(nearest.length / 2);
          const median = nearest.length % 2
            ? nearest[mid]
            : (nearest[mid - 1] + nearest[mid]) / 2;
          fraction = median * CROP_SPACING_FACTOR;
        }
      }

      fraction = Math.min(CROP_MAX, Math.max(CROP_MIN, fraction));
      fractionCache.set(photo.id, fraction);
      return fraction;
    },

    /** Das Foto, aus dem der Ausschnitt stammt (für "gesehen auf"-Hinweise). */
    sourcePhoto(person) {
      const hit = bestByPerson.get(Number(person && person.id));
      return hit ? hit.photo : null;
    },

    /** Alle geladenen Fotos, neueste zuerst. */
    photos() {
      return photos.slice().sort(byRecencyDesc);
    }
  };

  // --- intern ---------------------------------------------------------------

  /**
   * Ordnet jeder Person das Foto zu, aus dem ihr Ausschnitt stammt.
   *
   * Nicht einfach das neuste: Ein Gruppenbild aus grosser Distanz liefert einen
   * Ausschnitt von vielleicht 40 Pixeln Kantenlänge — auf dem Kärtchen ist das
   * ein Farbfleck. Ein älteres, näher aufgenommenes Foto ist dann die bessere
   * Quelle, auch wenn es nicht das aktuellste ist.
   *
   * Darum: unter den jüngsten CANDIDATE_PHOTOS Fotos, auf denen die Person
   * markiert ist, gewinnt jenes mit den **meisten echten Bildpunkten** im
   * Ausschnitt — also dort, wo am wenigsten hineingezoomt werden muss.
   * Die Beschränkung auf die jüngsten paar Fotos hält das Bild halbwegs
   * aktuell; sonst gewönne womöglich für immer ein zwanzig Jahre altes Portrait.
   */
  function reindex() {
    bestByPerson = new Map();
    // Neue Markierungen verändern die geschätzte Ausschnittgrösse.
    fractionCache = new Map();

    const nachPerson = new Map();
    for (const photo of photos.slice().sort(byRecencyDesc)) {
      for (const tag of photo.tags || []) {
        const key = Number(tag.personId);
        const liste = nachPerson.get(key);
        if (liste) liste.push({ photo, tag });
        else nachPerson.set(key, [{ photo, tag }]);
      }
    }

    for (const [key, alle] of nachPerson) {
      const kandidaten = alle.slice(0, CANDIDATE_PHOTOS);   // schon nach Alter sortiert
      let beste = kandidaten[0];
      let besteAufloesung = cropPixels(beste.photo);
      for (const k of kandidaten.slice(1)) {
        const px = cropPixels(k.photo);
        // Nur bei spürbarem Gewinn wechseln — sonst kippt die Wahl bei jeder
        // neuen Markierung hin und her, und das Kärtchen zeigt ständig ein
        // anderes Gesicht.
        if (px > besteAufloesung * MIN_SHARPNESS_GAIN) {
          beste = k;
          besteAufloesung = px;
        }
      }
      bestByPerson.set(key, beste);
    }
  }

  /** Kantenlänge des Ausschnitts in echten Bildpunkten der Vorlage. */
  function cropPixels(photo) {
    if (!photo || !photo.width) return 0;
    return Portrait.cropFractionFor(photo) * photo.width;
  }

  /** "Aktuellstes" Foto: Aufnahmedatum, sonst Reihenfolge, sonst ID. */
  function byRecencyDesc(a, b) {
    const at = a.takenAt || '';
    const bt = b.takenAt || '';
    if (at !== bt) return at < bt ? 1 : -1;
    if ((a.sortOrder || 0) !== (b.sortOrder || 0)) return (b.sortOrder || 0) - (a.sortOrder || 0);
    return Number(b.id) - Number(a.id);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function round(value) {
    return Math.round(value * 100) / 100;
  }

  window.Portrait = Portrait;
})();
