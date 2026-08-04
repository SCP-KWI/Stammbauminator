/* Stammbauminator — Lern-Quiz «Namen lernen»
   Globals: window.QuizView

   Lernkärtchen: vorne ein Gesicht, hinten der Name. Wer den Namen wusste,
   sieht das Kärtchen nicht wieder; wer nicht, bekommt es einige Kärtchen
   später erneut vorgelegt — bis es einmal sass.

   Drei Bildschirme im selben Mountpoint:
     'setup' → Auswahl des Ausschnitts (Elternpaar, Tiefe, Partner:innen)
     'round' → laufende Runde
     'done'  → Abschluss mit Auswertung */
(function () {
  'use strict';

  // --- Konstanten -----------------------------------------------------------

  // Ein nicht gewusstes Kärtchen kommt nach 3–5 weiteren zurück. Direkt danach
  // wäre der Name noch im Kurzzeitgedächtnis — das lernt niemand.
  const REQUEUE_MIN = 3;
  const REQUEUE_MAX = 5;

  const DEPTH_OPTIONS = [
    { value: '1',   label: '1 — nur die Kinder' },
    { value: '2',   label: '2 — Kinder und Enkel' },
    { value: '3',   label: '3 — bis zu den Urenkeln' },
    { value: 'all', label: 'alle Generationen' }
  ];

  // --- Zustand --------------------------------------------------------------

  const state = {
    root: null,
    screen: 'setup',                 // 'setup' | 'round' | 'done'
    setup: {
      unionId: null,
      depth: 'all',
      withPartners: true,       // Partner:innen laufender Partnerschaften
      formerPartners: false,    // zusätzlich jene beendeter Partnerschaften
      includeNoPhoto: false
    },
    round: null,                     // { queue, total, revealed, firstTry, learned }
    result: null,                    // Auswertung der letzten Runde
    els: {},                         // Referenzen der aktuellen Ansicht
    resizeObserver: null,
    keyHandler: null,
    unionChosen: false               // Vorauswahl nur einmal automatisch setzen
  };

  // --- Modul ----------------------------------------------------------------

  const QuizView = {
    mount(root) {
      state.root = root;
      root.classList.add('q-root');

      // Ausschnitte brauchen die Fotos — im Hintergrund holen und die Vorschau
      // nachziehen, sobald die Zahlen stimmen.
      if (window.Portrait) {
        Portrait.load().then(() => {
          if (state.screen === 'setup') updatePreview();
        });
      }

      Store.subscribe(() => {
        // Eine laufende Runde nicht unter den Füssen wegziehen.
        if (state.screen === 'setup') renderSetup();
      });

      App.onTabChange((name) => {
        if (name === 'quiz') {
          bindKeys();
          // Im versteckten Tab hat das Kärtchen die Grösse 0 — jetzt neu messen.
          if (state.screen === 'round') requestAnimationFrame(applyPortrait);
        } else {
          unbindKeys();
        }
      });

      renderSetup();
      if (App.activeTab === 'quiz') bindKeys();
    }
  };

  // --- Startbildschirm ------------------------------------------------------

  function renderSetup() {
    teardownRound();
    state.screen = 'setup';
    state.round = null;

    const options = Store.parentUnionOptions();

    // Vorauswahl: das Paar mit den meisten Nachkommen — in aller Regel das
    // Wurzelpaar. Eine getroffene Wahl bleibt erhalten, solange es sie gibt.
    if (options.length) {
      const known = options.some((o) => Number(o.unionId) === Number(state.setup.unionId));
      if (!known) {
        state.setup.unionId = state.unionChosen ? options[0].unionId : mostDescendants(options);
      }
    } else {
      state.setup.unionId = null;
    }

    const page = el('div', 'page q-page');
    const card = el('section', 'card q-setup');

    card.append(
      el('h2', 'q-setup__title', 'Namen lernen'),
      el('p', 'muted small q-setup__lead',
        'Ein Kärtchen zeigt ein Gesicht. Überlege den Namen, drehe um — und sage '
        + 'ehrlich, ob du ihn wusstest. Was daneben ging, kommt später nochmals.')
    );

    if (!options.length) {
      const empty = el('div', 'empty');
      empty.append(
        el('div', 'empty__icon', '🎴'),
        el('p', null, 'Es gibt noch keine Paare im Stammbaum, aus denen sich ein Quiz bauen liesse.')
      );
      card.appendChild(empty);
      page.appendChild(card);
      state.root.textContent = '';
      state.root.appendChild(page);
      return;
    }

    // Elternpaar
    const unionField = el('div', 'field');
    const unionLabel = el('label', null, 'Alle Kinder von …');
    unionLabel.htmlFor = 'q-union';
    const unionSelect = el('select');
    unionSelect.id = 'q-union';
    for (const opt of options) {
      const o = el('option', null, opt.label);
      o.value = String(opt.unionId);
      if (Number(opt.unionId) === Number(state.setup.unionId)) o.selected = true;
      unionSelect.appendChild(o);
    }
    unionSelect.addEventListener('change', () => {
      state.setup.unionId = Number(unionSelect.value);
      state.unionChosen = true;
      updatePreview();
    });
    unionField.append(unionLabel, unionSelect);

    // Generationentiefe
    const depthField = el('div', 'field');
    const depthLabel = el('label', null, 'Wie viele Generationen?');
    depthLabel.htmlFor = 'q-depth';
    const depthSelect = el('select');
    depthSelect.id = 'q-depth';
    for (const opt of DEPTH_OPTIONS) {
      const o = el('option', null, opt.label);
      o.value = opt.value;
      if (opt.value === state.setup.depth) o.selected = true;
      depthSelect.appendChild(o);
    }
    depthSelect.addEventListener('change', () => {
      state.setup.depth = depthSelect.value;
      updatePreview();
    });
    depthField.append(depthLabel, depthSelect);

    const grid = el('div', 'field-grid field-grid--2 q-setup__grid');
    grid.append(unionField, depthField);

    // Schalter. «Frühere Partner:innen» erweitert die Auswahl darüber und ist
    // ohne sie gesperrt: ein Stapel aus lauter Ex-Partner:innen, aber ohne die
    // heutigen, stiftet genau die Verwechslung, die die Trennung vermeidet.
    const partnersLine = checkline('q-partners', 'Aktuelle Partner:innen mitlernen',
      state.setup.withPartners, (on) => {
        state.setup.withPartners = on;
        syncFormerSwitch();
        updatePreview();
      });
    const formerLine = checkline('q-former', 'Auch frühere Partner:innen',
      state.setup.withPartners && state.setup.formerPartners,
      (on) => { state.setup.formerPartners = on; updatePreview(); },
      'checkline--sub');
    const formerBox = formerLine.querySelector('input');

    const switches = el('div', 'stack--sm q-switches');
    switches.append(
      partnersLine,
      formerLine,
      checkline('q-nophoto', 'Auch Personen ohne Foto üben',
        state.setup.includeNoPhoto, (on) => { state.setup.includeNoPhoto = on; updatePreview(); })
    );

    // Vorschau
    const preview = el('div', 'q-preview');
    preview.setAttribute('aria-live', 'polite');
    const count = el('div', 'q-preview__count');
    const note = el('div', 'q-preview__note small muted');
    preview.append(count, note);

    const startBtn = el('button', 'btn btn--sun btn--lg btn--block q-start', 'Los geht’s');
    startBtn.type = 'button';
    startBtn.addEventListener('click', startRound);

    card.append(grid, switches, preview, startBtn);
    page.appendChild(card);

    state.root.textContent = '';
    state.root.appendChild(page);

    state.els = { count, note, startBtn, formerLine, formerBox };
    syncFormerSwitch();
    updatePreview();
  }

  /** Ohne die aktuellen Partner:innen ist die zweite Auswahl wirkungslos. */
  function syncFormerSwitch() {
    const els = state.els;
    if (!els || !els.formerBox) return;
    const on = state.setup.withPartners;
    els.formerBox.disabled = !on;
    // Angezeigt wird, was tatsächlich zählt; die Vorliebe bleibt gemerkt und
    // kehrt zurück, sobald die Auswahl darüber wieder an ist.
    els.formerBox.checked = on && state.setup.formerPartners;
    els.formerLine.classList.toggle('is-disabled', !on);
  }

  /** Zahlen unter den Auswahlfeldern frisch rechnen. */
  function updatePreview() {
    const els = state.els;
    if (!els || !els.count) return;

    const all = rawCandidates();
    const list = all.filter(alive);
    const missing = list.filter((entry) => !hasImage(entry.person)).length;
    const deck = state.setup.includeNoPhoto
      ? list
      : list.filter((entry) => hasImage(entry.person));

    els.count.textContent = deck.length === 1
      ? '1 Kärtchen'
      : deck.length + ' Kärtchen';

    let reason = '';
    if (state.setup.unionId == null) {
      reason = 'Wähle zuerst ein Elternpaar.';
    } else if (!all.length) {
      reason = 'Bei diesem Paar sind noch keine Kinder erfasst — wähle ein anderes Paar '
             + 'oder eine grössere Generationentiefe.';
    } else if (!list.length) {
      reason = 'Von diesen Personen lebt keine mehr — Verstorbene kommen nicht ins Quiz. '
             + 'Wähle ein anderes Paar oder eine grössere Generationentiefe.';
    } else if (!deck.length) {
      reason = 'Von diesen Personen hat keine ein Foto. Schalte «Auch Personen ohne Foto '
             + 'üben» ein, um trotzdem zu starten.';
    }

    if (reason) {
      els.note.textContent = reason;
    } else if (missing && !state.setup.includeNoPhoto) {
      els.note.textContent = missing === 1
        ? '1 Person ohne Foto wird übersprungen.'
        : missing + ' Personen ohne Foto werden übersprungen.';
    } else if (missing) {
      els.note.textContent = missing === 1
        ? '1 Kärtchen zeigt statt eines Fotos die Initialen.'
        : missing + ' Kärtchen zeigen statt eines Fotos die Initialen.';
    } else {
      els.note.textContent = 'Von allen ausgewählten Personen gibt es ein Bild.';
    }

    els.startBtn.disabled = deck.length === 0;
    els.count.classList.toggle('is-empty', deck.length === 0);
  }

  /** Welche Partner:innen gehören zum Zuschnitt? */
  function partnerScope() {
    const on = state.setup.withPartners;
    return { partners: on, formerPartners: on && state.setup.formerPartners };
  }

  /**
   * Personen des aktuellen Zuschnitts — ohne Verstorbene, noch ohne Foto-Filter.
   * Wer gestorben ist, begegnet einem nicht mehr; Gesichter zu üben, die man
   * nie mehr zuordnen muss, will niemand. Dafür gibt es bewusst keinen Schalter.
   */
  function candidates() {
    return rawCandidates().filter(alive);
  }

  /** Der Zuschnitt, wie ihn der Store liefert — noch ohne jeden Filter. */
  function rawCandidates() {
    const { unionId, depth } = state.setup;
    if (unionId == null) return [];
    const limit = depth === 'all' ? Infinity : Number(depth);
    try {
      return Store.descendantsOfUnion(unionId, limit, partnerScope()) || [];
    } catch (err) {
      console.error('Nachkommen konnten nicht ermittelt werden', err);
      return [];
    }
  }

  function alive(entry) {
    return !Store.isDeceased(entry.person);
  }

  function mostDescendants(options) {
    let bestId = options[0].unionId;
    let best = -1;
    for (const opt of options) {
      let n = 0;
      try { n = Store.descendantsOfUnion(opt.unionId, Infinity, true).length; }
      catch (err) { n = 0; }
      if (n > best) { best = n; bestId = opt.unionId; }
    }
    return bestId;
  }

  // --- Runde ----------------------------------------------------------------

  async function startRound() {
    const btn = state.els.startBtn;
    const btnLabel = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Kärtchen werden gemischt …'; }

    // Ohne die Fotos fehlen die Ausschnitte — vor dem Start abwarten.
    try { if (window.Portrait) await Portrait.load(); }
    catch (err) { console.warn('Fotos nicht ladbar', err); }

    const list = candidates();
    const deck = state.setup.includeNoPhoto
      ? list
      : list.filter((entry) => hasImage(entry.person));

    if (!deck.length) {
      if (btn) { btn.textContent = btnLabel; btn.disabled = false; }
      updatePreview();
      App.toast('Für diese Auswahl gibt es keine Kärtchen.', 'info');
      return;
    }

    state.round = {
      queue: shuffle(deck.map((entry) => ({
        id: entry.person.id,
        person: entry.person,
        generation: entry.generation,
        misses: 0
      }))),
      total: deck.length,
      revealed: false,
      firstTry: 0,
      learned: []
    };

    renderRound();
  }

  function renderRound() {
    teardownRound();
    state.screen = 'round';

    const page = el('div', 'page q-page q-page--round');

    // Fortschritt
    const progress = el('div', 'q-progress');
    const progressTop = el('div', 'q-progress__top');
    const progressLabel = el('div', 'q-progress__label');
    const attempt = el('span', 'pill pill--coral q-attempt');
    attempt.hidden = true;
    progressTop.append(progressLabel, el('span', 'spacer'), attempt);
    const bar = el('div', 'q-progress__bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(state.round.total));
    const fill = el('span', 'q-progress__fill');
    bar.appendChild(fill);
    progress.append(progressTop, bar);

    // Kärtchen
    const stage = el('div', 'q-stage');
    const cardBtn = el('button', 'q-card');
    cardBtn.type = 'button';
    cardBtn.setAttribute('aria-label', 'Kärtchen umdrehen und den Namen zeigen');
    const inner = el('span', 'q-card__inner');
    const front = el('span', 'q-card__face q-card__face--front');
    const portrait = el('span', 'q-portrait');
    front.appendChild(portrait);
    const back = el('span', 'q-card__face q-card__face--back');
    const name = el('span', 'q-back__name');
    const rel = el('span', 'q-back__rel');
    const life = el('span', 'q-back__life tiny faint');
    back.append(name, rel, life);
    inner.append(front, back);
    cardBtn.appendChild(inner);
    stage.appendChild(cardBtn);
    cardBtn.addEventListener('click', reveal);

    const hint = el('div', 'q-hint small faint');

    // Antworten — vor dem Umdrehen weder sichtbar noch anklickbar
    const actions = el('div', 'q-actions');
    const knownBtn = el('button', 'btn btn--sun btn--lg q-answer', 'Wusste ich');
    knownBtn.type = 'button';
    knownBtn.disabled = true;
    knownBtn.addEventListener('click', () => answer(true));
    const unknownBtn = el('button', 'btn btn--primary btn--lg q-answer', 'Wusste ich noch nicht');
    unknownBtn.type = 'button';
    unknownBtn.disabled = true;
    unknownBtn.addEventListener('click', () => answer(false));
    actions.append(knownBtn, unknownBtn);

    const abort = el('button', 'btn btn--ghost btn--sm q-abort', 'Runde abbrechen');
    abort.type = 'button';
    abort.addEventListener('click', () => {
      state.round = null;
      renderSetup();
    });
    const abortRow = el('div', 'q-abort-row');
    abortRow.appendChild(abort);

    page.append(progress, stage, hint, actions, abortRow);

    state.root.textContent = '';
    state.root.appendChild(page);

    state.els = {
      cardBtn, portrait, name, rel, life, hint, actions,
      knownBtn, unknownBtn, progressLabel, bar, fill, attempt
    };

    if (typeof ResizeObserver === 'function') {
      state.resizeObserver = new ResizeObserver(() => applyPortrait());
      state.resizeObserver.observe(cardBtn);
    }

    showCard();
    // Erst nach dem Layout messen — vorher ist die Kantenlänge unbekannt.
    requestAnimationFrame(applyPortrait);
  }

  function showCard() {
    const round = state.round;
    const els = state.els;
    if (!round || !els.cardBtn) return;

    const card = round.queue[0];
    if (!card) { finishRound(); return; }

    round.revealed = false;
    els.cardBtn.classList.remove('is-flipped');
    els.cardBtn.disabled = false;

    const person = personOf(card);

    els.portrait.className = 'q-portrait'
      + (hasImage(person) ? '' : ' q-portrait--initials ' + Store.avatarClass(person));
    applyPortrait();

    els.name.textContent = Store.displayName(person);
    els.rel.textContent = relationText(person);
    els.life.textContent = Store.lifeSpan(person);

    els.attempt.hidden = card.misses === 0;
    els.attempt.textContent = card.misses ? (card.misses + 1) + '. Anlauf' : '';

    setAnswersVisible(false);
    updateProgress();
  }

  /** Ausschnitt setzen — `size` muss die echte Kantenlänge in px sein. */
  function applyPortrait() {
    const els = state.els;
    const round = state.round;
    if (!round || !els.portrait || !els.cardBtn) return;
    const card = round.queue[0];
    if (!card || !window.Portrait) return;

    const size = Math.round(els.cardBtn.getBoundingClientRect().width);
    if (size < 2) return;   // Tab versteckt — später erneut versuchen
    Portrait.apply(els.portrait, personOf(card), size);
  }

  function reveal() {
    const round = state.round;
    if (state.screen !== 'round' || !round || round.revealed) return;
    round.revealed = true;
    state.els.cardBtn.classList.add('is-flipped');
    setAnswersVisible(true);
  }

  function setAnswersVisible(visible) {
    const els = state.els;
    els.actions.classList.toggle('is-visible', visible);
    els.knownBtn.disabled = !visible;
    els.unknownBtn.disabled = !visible;
    els.hint.textContent = visible
      ? '1 = wusste ich · 2 = wusste ich noch nicht'
      : 'Tippen oder Leertaste zum Umdrehen';
  }

  function answer(known) {
    const round = state.round;
    if (state.screen !== 'round' || !round || !round.revealed) return;

    const card = round.queue.shift();
    if (known) {
      if (card.misses === 0) round.firstTry++;
      round.learned.push(card);
    } else {
      card.misses++;
      // Einige Positionen weiter hinten wieder einreihen; ist der Stapel
      // kürzer, ans Ende. Bleibt nur dieses Kärtchen übrig, kommt es sofort
      // wieder — sonst könnte die Runde nicht enden.
      const gap = REQUEUE_MIN + Math.floor(Math.random() * (REQUEUE_MAX - REQUEUE_MIN + 1));
      round.queue.splice(Math.min(gap, round.queue.length), 0, card);
    }

    if (!round.queue.length) finishRound();
    else showCard();
  }

  function updateProgress() {
    const round = state.round;
    const els = state.els;
    const remaining = round.queue.length;
    els.progressLabel.textContent = 'noch ' + remaining + ' von ' + round.total;
    const done = round.total - remaining;
    els.fill.style.width = (round.total ? (done / round.total) * 100 : 0) + '%';
    els.bar.setAttribute('aria-valuenow', String(done));
    els.bar.setAttribute('aria-valuetext', 'noch ' + remaining + ' von ' + round.total + ' Kärtchen');
  }

  // --- Abschluss ------------------------------------------------------------

  function finishRound() {
    const round = state.round;
    state.result = {
      total: round.total,
      firstTry: round.firstTry,
      tricky: round.learned
        .filter((card) => card.misses > 0)
        .sort((a, b) => b.misses - a.misses)
    };
    state.round = null;
    renderDone();
  }

  function renderDone() {
    teardownRound();
    state.screen = 'done';

    const result = state.result;
    const page = el('div', 'page q-page');
    const card = el('section', 'card q-done');

    card.append(
      el('div', 'q-done__mark', '🎉'),
      el('h2', 'q-done__title', 'Geschafft!'),
      el('p', 'muted q-done__lead', result.total === 1
        ? 'Du hast einen Namen durchgespielt.'
        : 'Du hast alle ' + result.total + ' Namen durchgespielt.')
    );

    const stats = el('div', 'q-stats');
    stats.append(
      stat(result.firstTry, 'auf Anhieb gewusst'),
      stat(result.total - result.firstTry, 'mit mehreren Anläufen'),
      stat(result.total, result.total === 1 ? 'Name gelernt' : 'Namen gelernt')
    );
    card.appendChild(stats);

    if (result.tricky.length) {
      card.appendChild(el('h3', 'q-done__sub', 'Diese Namen brauchten mehrere Anläufe'));
      card.appendChild(el('p', 'small muted q-done__hint',
        'Tippe auf einen Namen, um die Person nachzuschauen.'));

      const list = el('ul', 'q-tricky');
      for (const entry of result.tricky) {
        const person = personOf(entry);
        const li = el('li');
        const btn = el('button', 'q-tricky__item');
        btn.type = 'button';

        const avatar = el('span', 'avatar q-tricky__avatar'
          + (hasImage(person) ? '' : ' ' + Store.avatarClass(person)));
        if (window.Portrait) Portrait.apply(avatar, person, 46);

        const text = el('span', 'q-tricky__text');
        text.append(
          el('span', 'q-tricky__name', Store.displayName(person)),
          el('span', 'q-tricky__rel tiny faint', relationText(person))
        );

        const pill = el('span', 'pill pill--sun q-tricky__count',
          entry.misses === 1 ? '1 Fehlversuch' : entry.misses + ' Fehlversuche');

        btn.append(avatar, text, el('span', 'spacer'), pill);
        btn.addEventListener('click', () => openPerson(person));
        li.appendChild(btn);
        list.appendChild(li);
      }
      card.appendChild(list);
    } else {
      card.appendChild(el('p', 'q-done__perfect',
        'Alle Namen sassen auf Anhieb — stark!'));
    }

    const again = el('button', 'btn btn--sun btn--lg q-done__btn', 'Nochmals üben');
    again.type = 'button';
    again.addEventListener('click', startRound);

    const other = el('button', 'btn btn--secondary btn--lg q-done__btn', 'Andere Auswahl');
    other.type = 'button';
    other.addEventListener('click', renderSetup);

    const row = el('div', 'row q-done__actions');
    row.append(again, other);
    card.appendChild(row);

    page.appendChild(card);
    state.root.textContent = '';
    state.root.appendChild(page);

    // startRound() greift auf den Startknopf zu, wenn es einen gibt.
    state.els = { startBtn: again };
  }

  function stat(value, label) {
    const box = el('div', 'q-stat');
    box.append(el('strong', 'q-stat__value', String(value)), el('span', 'q-stat__label', label));
    return box;
  }

  function openPerson(person) {
    if (!person) return;
    if (window.PersonPanel && typeof PersonPanel.open === 'function') {
      PersonPanel.open(person.id);
    } else {
      App.toast('Die Personendetails sind gerade nicht verfügbar.', 'info');
    }
  }

  // --- Tastatur -------------------------------------------------------------

  function bindKeys() {
    if (state.keyHandler) return;
    state.keyHandler = (ev) => {
      if (state.screen !== 'round' || !state.round) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      // Modals und Eingabefelder haben Vorrang
      if (document.querySelector('.modal-backdrop')) return;
      const tag = ev.target && ev.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (ev.target && ev.target.isContentEditable) return;

      if (!state.round.revealed) {
        if (ev.key === ' ' || ev.key === 'Spacebar' || ev.key === 'Enter') {
          // Liegt der Fokus auf dem Kärtchen, löst der Browser selbst schon
          // einen Klick aus — sonst gäbe es zwei Umdrehungen.
          if (ev.target === state.els.cardBtn) return;
          ev.preventDefault();
          reveal();
        }
        return;
      }

      if (ev.key === '1' || ev.key === 'ArrowLeft') {
        ev.preventDefault();
        answer(true);
      } else if (ev.key === '2' || ev.key === 'ArrowRight') {
        ev.preventDefault();
        answer(false);
      }
    };
    document.addEventListener('keydown', state.keyHandler);
  }

  function unbindKeys() {
    if (!state.keyHandler) return;
    document.removeEventListener('keydown', state.keyHandler);
    state.keyHandler = null;
  }

  // --- Helfer ---------------------------------------------------------------

  function teardownRound() {
    if (state.resizeObserver) {
      state.resizeObserver.disconnect();
      state.resizeObserver = null;
    }
  }

  function personOf(card) {
    return (card && Store.person(card.id)) || (card && card.person) || null;
  }

  function hasImage(person) {
    return Boolean(window.Portrait && Portrait.hasImage(person));
  }

  /** Einordnung für die Kartenrückseite — hilft beim Merken. */
  function relationText(person) {
    if (!person) return '';

    if (person.isPartner) {
      for (const union of Store.unionsInvolving(person.id)) {
        const spouse = Store.spouseIn(union, person.id);
        if (spouse) return 'Partner:in von ' + Store.displayName(spouse);
      }
    }

    const parents = Store.parentsOf(person.id);
    if (parents.length) {
      return 'Kind von ' + parents.map((p) => p.firstName || Store.displayName(p)).join(' & ');
    }

    for (const union of Store.unionsInvolving(person.id)) {
      const spouse = Store.spouseIn(union, person.id);
      if (spouse) return 'Partner:in von ' + Store.displayName(spouse);
    }
    return '';
  }

  /** Fisher-Yates. */
  function shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    return list;
  }

  function checkline(id, labelText, checked, onChange, extraClass) {
    const label = el('label', 'checkline' + (extraClass ? ' ' + extraClass : ''));
    label.htmlFor = id;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = id;
    box.checked = Boolean(checked);
    box.addEventListener('change', () => onChange(box.checked));
    label.append(box, el('span', null, labelText));
    return label;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;   // nie innerHTML für Benutzerdaten
    return node;
  }

  window.QuizView = QuizView;
})();
