/* Stammbauminator — Datenspeicher für den Stammbaum
   Globals: window.Store
   Hält /api/tree im Speicher und bietet Lesezugriffe für alle Module. */
(function () {
  'use strict';

  const subscribers = new Set();

  const Store = {
    data: { rootPersonId: null, persons: [], unions: [] },
    loaded: false,

    async load() {
      const data = await API.get('/api/tree');
      Store.data = {
        rootPersonId: data.rootPersonId,
        persons: data.persons || [],
        unions: data.unions || []
      };
      Store.loaded = true;
      index();
      notify();
      return Store.data;
    },

    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    person: (id) => byPerson.get(Number(id)),
    union:  (id) => byUnion.get(Number(id)),

    rootPerson: () => byPerson.get(Number(Store.data.rootPersonId)),

    /** Unions einer Person: links zuerst, dann rechts, je Seite von oben nach unten. */
    unionsOf(personId) {
      return [
        ...Store.unionStack(personId, 'left'),
        ...Store.unionStack(personId, 'right')
      ];
    },

    /**
     * Die Partnerschaften einer Seite als Stapel, **von oben nach unten**.
     *
     * Pro Seite darf höchstens eine Partnerschaft Kinder haben — deren Kinder
     * hängen unter der Person, also muss sie zuunterst stehen. Frühere,
     * kinderlose Partnerschaften werden darüber gestapelt: Kommt eine neue
     * dazu, rutschen die bestehenden nach oben.
     *
     * Zuunterst steht: die Partnerschaft mit Kindern; sonst die aktuelle;
     * sonst die neueste. Darüber die übrigen, älteste zuoberst.
     */
    unionStack(personId, side) {
      const list = (unionsByPerson.get(Number(personId)) || [])
        .filter((u) => u.side === side);
      if (list.length < 2) return list.slice();

      const nachAlter = (a, b) => Number(a.id) - Number(b.id);
      const mitKindern = list.filter((u) => Store.unionHasChildren(u.id)).sort(nachAlter);
      const ohneKinder = list.filter((u) => !Store.unionHasChildren(u.id)).sort(nachAlter);

      // Partnerschaften mit Kindern gehören ausnahmslos nach unten — auch
      // frühere. Stünde eine darüber, liefe ihre Linie zu den Kindern quer
      // durch die Karten der Partnerschaften darunter.
      //
      // Normalerweise gibt es je Seite höchstens eine mit Kindern (Invariante,
      // serverseitig erzwungen). Ältere Datenbestände können mehrere enthalten;
      // dann stehen sie alle unten, die älteste zuoberst.
      if (mitKindern.length) return [...ohneKinder, ...mitKindern];

      // Gar keine Kinder im Spiel: die laufende Partnerschaft nach unten,
      // sonst die neueste.
      const unten = ohneKinder.find((u) => u.isCurrent)
        || ohneKinder[ohneKinder.length - 1];
      return [...ohneKinder.filter((u) => u !== unten), unten];
    },

    unionHasChildren(unionId) {
      return (childrenByUnion.get(Number(unionId)) || []).length > 0;
    },

    /**
     * Hat diese Seite schon eine Partnerschaft mit Kindern? Dann ist der Platz
     * unter der Person belegt und es gibt dort kein "+" mehr für eine weitere.
     */
    sideHasChildUnion(personId, side) {
      return (unionsByPerson.get(Number(personId)) || [])
        .some((u) => u.side === side && Store.unionHasChildren(u.id));
    },

    /** Darf auf dieser Seite eine weitere Partnerschaft angelegt werden? */
    canAddUnion(personId, side) {
      return !Store.sideHasChildUnion(personId, side);
    },

    /** Aktuell laufende Partnerschaft einer Person (oder undefined). */
    currentUnionOf(personId) {
      return Store.unionsOf(personId).find((u) => u.isCurrent);
    },

    /** Alle Unions, an denen die Person beteiligt ist — als Blutlinien-Anker
        ODER als eingeheiratete Partner:in. `unionsOf` findet nur die erste
        Variante; für Anzeigen (Panel, Quiz) ist immer diese hier richtig,
        sonst haben eingeheiratete Personen scheinbar keine Kinder. */
    unionsInvolving(personId) {
      const id = Number(personId);
      const own = unionsByPerson.get(id) || [];
      const married = unionsByPartner.get(id) || [];
      return own.concat(married).sort((a, b) => sideRank(a.side) - sideRank(b.side));
    },

    /** Kinder einer Person über alle ihre Unions hinweg, in Baumreihenfolge. */
    childrenOfPerson(personId) {
      return Store.unionsInvolving(personId).flatMap((u) => Store.childrenOf(u.id));
    },

    /** Die andere Person in einer Union, aus Sicht von `personId`. */
    spouseIn(union, personId) {
      if (!union) return undefined;
      const id = Number(personId);
      return Number(union.personId) === id
        ? Store.partnerOf(union)
        : byPerson.get(Number(union.personId));
    },

    /** Kinder einer Union — nach Alter, Kinder ohne Geburtsdatum alphabetisch
        hinten dran (siehe compareChildren). */
    childrenOf(unionId) {
      const list = childrenByUnion.get(Number(unionId)) || [];
      return list.slice().sort(compareChildren);
    },

    /** Partner:in einer Union als Person-Objekt (oder undefined). */
    partnerOf(union) {
      return union && union.partnerId ? byPerson.get(Number(union.partnerId)) : undefined;
    },

    /** Alle Blutlinien-Personen (keine Eingeheirateten). */
    bloodlinePersons() {
      return Store.data.persons.filter((p) => !p.isPartner);
    },

    /** Alle Personen alphabetisch — für Dropdowns in der Foto-Markierung. */
    allPersons() {
      return Store.data.persons
        .slice()
        .sort((a, b) => Store.displayName(a).localeCompare(Store.displayName(b), 'de-CH'));
    },

    displayName(person) {
      if (!person) return 'Unbekannt';
      return [person.firstName, person.lastName].filter(Boolean).join(' ').trim() || 'Unbenannt';
    },

    /** Initialen für Avatare, z.B. "Anna Muster" → "AM". */
    initials(person) {
      if (!person) return '?';
      const a = (person.firstName || '').trim()[0] || '';
      const b = (person.lastName || '').trim()[0] || '';
      return (a + b).toUpperCase() || '?';
    },

    /** Stabile Avatar-Farbklasse aus der Personen-ID. */
    avatarClass(person) {
      const id = person && person.id ? Number(person.id) : 0;
      return 'avatar--c' + (id % 6);
    },

    /** Elternteile (Blutlinien-Person + ggf. Partner:in) einer Person. */
    parentsOf(personId) {
      const p = byPerson.get(Number(personId));
      if (!p || !p.parentUnionId) return [];
      const u = byUnion.get(Number(p.parentUnionId));
      if (!u) return [];
      return [byPerson.get(Number(u.personId)), Store.partnerOf(u)].filter(Boolean);
    },

    /** Optionen für Eltern-Dropdowns: jede Union als "Anna & Beat". */
    parentUnionOptions() {
      return Store.data.unions
        .map((u) => ({ unionId: u.id, label: unionLabel(u), sort: unionLabel(u) }))
        .sort((a, b) => a.sort.localeCompare(b.sort, 'de-CH'));
    },

    unionLabel,

    /** Jahresangabe fürs Karten-Label, z.B. "1950–2020" oder "* 1990". */
    lifeSpan(person) {
      if (!person) return '';
      const born = year(person.birthDate);
      const died = year(person.deathDate);
      if (born && died) return born + '–' + died;
      if (died) return '† ' + died;
      if (born) return '* ' + born;
      return '';
    },

    isDeceased: (person) => Boolean(person && person.deathDate),

    /**
     * Nachkommen einer Union bis zu einer Generationentiefe — Grundlage fürs
     * Lern-Quiz ("alle Kinder von X, N Generationen tief").
     *
     * Kinder kommen immer mit; eingeheiratete Partner:innen nur auf Wunsch,
     * getrennt nach laufender und beendeter Partnerschaft (`union.isCurrent`).
     *
     * @param {number} unionId
     * @param {number} depth  1 = nur die Kinder, 2 = plus Enkel, Infinity = alle
     * @param {boolean|{partners?: boolean, formerPartners?: boolean}} withPartners
     *        Objekt: `partners` = Partner:innen laufender Partnerschaften,
     *        `formerPartners` = jene beendeter Partnerschaften.
     *        Wahrheitswert (alte Aufrufform): `true` nimmt beide mit,
     *        `false` keine.
     * @returns {Array<{person: object, generation: number}>} generation ab 1
     */
    descendantsOfUnion(unionId, depth, withPartners) {
      const opts = partnerOptions(withPartners);
      const out = [];
      const seen = new Set();
      const limit = depth == null ? Infinity : depth;

      const wanted = (union) => (union.isCurrent === true ? opts.partners : opts.formerPartners);

      const walk = (uid, generation) => {
        if (generation > limit) return;
        for (const child of Store.childrenOf(uid)) {
          if (seen.has(child.id)) continue;      // Zyklusschutz
          seen.add(child.id);
          out.push({ person: child, generation });

          for (const union of Store.unionsOf(child.id)) {
            if (wanted(union)) {
              const partner = Store.partnerOf(union);
              if (partner && !seen.has(partner.id)) {
                seen.add(partner.id);
                out.push({ person: partner, generation });
              }
            }
            walk(union.id, generation + 1);
          }
        }
      };

      walk(Number(unionId), 1);
      return out;
    },

    /** Alle Nachkommen-IDs einer Person (für Lösch-Warnungen im Frontend). */
    descendantIds(personId) {
      const out = [];
      const walk = (pid) => {
        for (const u of Store.unionsOf(pid)) {
          for (const child of Store.childrenOf(u.id)) {
            out.push(child.id);
            walk(child.id);
          }
        }
      };
      walk(Number(personId));
      return out;
    }
  };

  // --- interne Indizes ------------------------------------------------------

  let byPerson = new Map();
  let byUnion = new Map();
  let unionsByPerson = new Map();
  let unionsByPartner = new Map();
  let childrenByUnion = new Map();

  function index() {
    byPerson = new Map();
    byUnion = new Map();
    unionsByPerson = new Map();
    unionsByPartner = new Map();
    childrenByUnion = new Map();

    for (const p of Store.data.persons) byPerson.set(Number(p.id), p);

    for (const u of Store.data.unions) {
      byUnion.set(Number(u.id), u);
      push(unionsByPerson, Number(u.personId), u);
      if (u.partnerId != null) push(unionsByPartner, Number(u.partnerId), u);
    }

    for (const p of Store.data.persons) {
      if (p.parentUnionId != null) push(childrenByUnion, Number(p.parentUnionId), p);
    }
  }

  function push(map, key, value) {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  }

  function notify() {
    for (const fn of subscribers) {
      try { fn(Store.data); }
      catch (err) { console.error('Store-Subscriber fehlgeschlagen', err); }
    }
  }

  function sideRank(side) { return side === 'left' ? 0 : 1; }

  /** Dritter Parameter von `descendantsOfUnion` — Wahrheitswert oder Objekt. */
  function partnerOptions(value) {
    if (value && typeof value === 'object') {
      return {
        partners: value.partners === true,
        formerPartners: value.formerPartners === true
      };
    }
    // Alte Aufrufform: ein Wahrheitswert meinte "alle Partner:innen".
    const all = Boolean(value);
    return { partners: all, formerPartners: all };
  }

  function unionLabel(union) {
    const anchor = byPerson.get(Number(union.personId));
    const partner = union.partnerId ? byPerson.get(Number(union.partnerId)) : null;
    const names = [Store.displayName(anchor)];
    if (partner) names.push(Store.displayName(partner));
    return names.join(' & ');
  }

  function year(dateStr) {
    if (!dateStr) return '';
    const m = String(dateStr).match(/(\d{4})/);
    return m ? m[1] : '';
  }

  /**
   * Geschwister von links nach rechts: das älteste zuerst. Wer kein
   * Geburtsdatum hat, hängt hinten dran, dort alphabetisch.
   *
   * Teilangaben werden als ISO-Präfix verglichen — «1975» steht damit vor
   * «1975-04-02». Wer nur das Jahr kennt, landet also am Jahresanfang; das
   * ist die einzige Annahme, die ohne Zusatzwissen auskommt.
   *
   * `sortOrder` ist nur noch der letzte Stichentscheid. Er wird beim Anlegen
   * fortlaufend vergeben und war deshalb bei zwei Geschwistern immer
   * verschieden — womit das Geburtsdatum nie zum Zug kam und die Kinder in
   * der Reihenfolge ihrer Erfassung standen.
   */
  function compareChildren(a, b) {
    const ad = String(a.birthDate || '').trim();
    const bd = String(b.birthDate || '').trim();
    if (Boolean(ad) !== Boolean(bd)) return ad ? -1 : 1;
    if (ad && ad !== bd) return ad < bd ? -1 : 1;
    const nachName = Store.displayName(a).localeCompare(Store.displayName(b), 'de-CH');
    if (nachName !== 0) return nachName;
    return (a.sortOrder || 0) - (b.sortOrder || 0);
  }

  window.Store = Store;
})();
