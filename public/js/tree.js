/* Stammbauminator — Stammbaum-Ansicht
   Globals: window.TreeView
   Rekursiver Baum aus Blutlinien-Knoten mit beliebig vielen Partnerschaften je
   Seite: die unterste (Anker, mit Kindern) liegt auf Höhe der Personenkarte,
   frühere kinderlose sind darüber gestapelt (Reihenfolge: Store.unionStack).
   Der Knoten ist ein 5-spaltiges Raster — 1 Partnerkarten links, 2 Statuspillen
   links, 3 Personenkarte, 4/5 spiegelbildlich rechts; jede Partnerschaft belegt
   eine Rasterzeile. Verbindungslinien als SVG-Overlay im gezoomten Canvas.
   Alle Koordinaten kommen aus offsetLeft/offsetTop (nicht getBoundingClientRect),
   weil der Canvas per CSS-transform skaliert wird. */
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Grosse Familien werden sehr breit — der Zoom muss weit genug herausgehen,
  // damit "Ganzer Baum" auch bei sehr vielen Personen tatsaechlich alles zeigt.
  const MIN_SCALE = 0.12;
  const MAX_SCALE = 2;
  const READABLE_SCALE = 0.9;  // Zoomstufe, ab der Karten gut lesbar sind
  const CORNER = 14;          // Radius der abgerundeten Ecken
  const DRAG_SLOP = 8;        // ab hier gilt es als Ziehen, nicht als Klick
  const FOCUS_MS = 1500;

  // --- Druck: A4 quer -------------------------------------------------------
  // 297 × 210 mm sind bei 96 dpi 1122 × 794 px; mit 10 mm Rand ringsum bleiben
  // 277 × 190 mm bzw. 1046 × 718 px übrig. CSS-Pixel sind fest als 1/96 Zoll
  // definiert, die Zahlen gelten also unabhängig von der Auflösung des Druckers.
  // Davon 2 px Sicherheitsabstand: bei exakt 718 px genügt ein Rundungsfehler
  // im Drucklayout, und der Baum rutscht auf eine zweite Seite.
  // Muss mit --print-w / --print-h in css/print.css übereinstimmen.
  const PRINT_W = 1044;
  const PRINT_H = 716;
  // Höhe des Titelbands über dem Baum. Muss von der Blatthöhe abgezogen werden,
  // sonst schiebt der Titel den Baum auf eine zweite Seite.
  // Muss mit --print-title-h in css/print.css übereinstimmen.
  const PRINT_TITLE_H = 34;
  const PRINT_TREE_H = PRINT_H - PRINT_TITLE_H;
  const PRINT_MODE_CLASS = 'is-printing';
  // Schriftgrad der Namen im Druck — steht so in css/print.css
  const PRINT_NAME_PX = 12;
  // Faustregel: unter 1,5 mm Versalhöhe ist ein Name auf Papier unbrauchbar.
  // Versalhöhe ≈ 0,7 × Schriftgrad, 1 px = 25,4/96 mm.
  const MIN_CAP_MM = 1.5;
  const PX_TO_MM = 25.4 / 96;
  const CAP_RATIO = 0.7;
  // Notbremse: falls ein Browser kein afterprint schickt, bleibt die Ansicht
  // sonst für immer im Druckmodus stecken. Bewusst grosszügig, damit ein lange
  // offenes Druckvorschaufenster nicht mittendrin umgebaut wird.
  const PRINT_FALLBACK_MS = 300000;

  // --- Druck: verschachtelte Geschwister -------------------------------------
  // Ein breiter, flacher Baum verschenkt auf A4 quer fast die ganze Blatthöhe:
  // gebunden hat allein die Breite, und die Karten schrumpfen auf Briefmarken-
  // grösse. Im Druck verteilen wir deshalb die Geschwister einer Reihe auf
  // mehrere Spuren — Spur 0 oben, Spur 1 tiefer, und so fort. Versetzte Knoten
  // dürfen sich waagrecht überlappen, die Reihe wird kürzer, der Massstab und
  // mit ihm die Kartengrösse steigen. Wie viele Spuren, entscheidet die
  // Messung (siehe printPlan), nicht eine feste Zahl.
  const PRINT_LANES_CLASS = 'is-print-lanes';
  const PRINT_LANES_MAX = 4;
  // Mindestversatz nach rechts — hält die Lesereihenfolge einer Reihe sichtbar
  const LANE_STEP = 26;
  // Freie Gasse zwischen zwei Knoten derselben Spur. Genau hier laufen die
  // senkrechten Abgänge zu den tieferen Spuren an den Karten vorbei.
  const LANE_CORRIDOR = 16;
  // Senkrechter Abstand zwischen zwei Spuren; darin liegt deren Querlinie
  const LANE_GAP = 18;
  // Sicherheitsabstand der Linien zu den Karten
  const LANE_CLEAR = 3;
  // Im Druck bleiben die Ecken enger, damit der Bogen in die Gasse passt
  const LANE_CORNER = 7;

  // --- Linienfarben je Elternschaft -----------------------------------------
  // Hat eine Person Kinder aus mehr als einer Partnerschaft, laufen zwei
  // Linienbündel nebeneinander her und kreuzen sich. Damit an einer Kreuzung
  // klar bleibt, welches Kind zu welcher Partnerschaft gehört, bekommt jedes
  // Bündel eine eigene Farbe. Die Farben selbst stehen als Klassen
  // .tree-line--tint0 … in css/tree.css (nur Tokens); hier zählt nur, wie
  // viele es sind. Drei genügen: je Seite darf höchstens eine Partnerschaft
  // Kinder haben, mehr als zwei kommen also praktisch nicht vor.
  const TINT_COUNT = 3;

  // --- Versatz paralleler Linien --------------------------------------------
  // Seit alle Linien durchgezogen sind, sind zwei deckungsgleiche Linien nicht
  // mehr auseinanderzuhalten. Solche Bündel werden darum seitlich versetzt.
  // TOL: bis hierhin gelten zwei Abschnitte als dieselbe Lage (Strichbreite
  // 2,5 px plus etwas Luft). MIN: erst ab so viel Überschneidung — ein Bündel
  // darf ein anderes weiterhin kreuzen und dabei kurz berühren.
  // STEP: Abstand zweier Nachbarlinien. Klein genug, dass die Linien sichtbar
  // an ihren Karten ansetzen und die Querlinie in ihrer Gasse bleibt.
  const PARALLEL_TOL = 4;
  const PARALLEL_MIN = 2;
  const PARALLEL_STEP = 6;

  // --- Modus «Person hinzufügen» --------------------------------------------
  // Neben fast jeder Karte steht ein Herz oder ein Fläschchen. Zum Anschauen
  // des Baums ist das zu viel; gebraucht werden sie nur beim Erfassen. Darum
  // sind sie normalerweise unsichtbar und erscheinen erst auf Knopfdruck.
  //
  // Bewusst nur unsichtbar (visibility) statt aus dem Fluss genommen (display):
  // an einem grossen Baum gemessen schrumpft dieser sonst von 2637 × 461 px auf
  // 2140 × 409 px — jedes Umschalten liesse ihn also um rund 500 px springen.
  // Reservierter Platz kostet nichts ausser etwas Luft, dafür bleibt das
  // Layout in beiden Zuständen Pixel für Pixel dasselbe. Die Klasse sitzt am
  // .tree-view, die Regeln stehen in css/tree.css.
  const ADD_MODE_CLASS = 'is-adding';
  const ADD_MODE_OFF = { glyph: '➕', label: 'Person hinzufügen',
    title: 'Herzen und Fläschchen einblenden, um jemanden hinzuzufügen' };
  const ADD_MODE_ON = { glyph: '✓', label: 'Hinzufügen beenden',
    title: 'Herzen und Fläschchen wieder ausblenden' };

  let mountEl = null;
  let viewEl = null;
  let viewport = null;
  let canvas = null;
  let svg = null;
  let treeRoot = null;
  let stateEl = null;
  let printTitle = null;
  let searchInput = null;
  let searchStatus = null;
  let addToggle = null;
  // Gilt nur für diese Sitzung — nichts gespeichert, nach dem Neuladen wieder aus.
  let addMode = false;

  let tx = 0, ty = 0, scale = 1;
  let rafHandle = null;
  let links = [];             // { union, anchorEl, partnerEl, kidsEl, targets[] }
  // Linie Person ↔ Partner:in — eine je Partnerschaft, auch für die
  // hochgeschobenen im Stapel: { union, personEl, partnerEl, stacked }
  let spouseLinks = [];
  let cards = [];             // { id, el } in DOM-Reihenfolge
  // Partnerkarte je Union — nur fuer die Linienberechnung im aktuellen Aufbau.
  // Bewusst eine eigene Map statt eines Feldes am Union-Objekt: die Objekte
  // stammen aus dem Store-Cache und sollen keine DOM-Knoten festhalten.
  let partnerCards = new Map();
  let searchTerm = '';
  let focusTimer = null;
  let didInitialView = false;
  let printState = null;      // { tx, ty, scale, timer } während des Druckens
  // Verschachtelung im Druck: Map(.tree-kids → { kidsEl, laneCount, laneOf })
  let printLaneRows = null;
  let printLaneNodes = [];    // Knoten mit gesetzten Rändern — zum Zurückbauen
  let fieldSeq = 0;
  let openMenu = null;        // { unionId, backdrop, menu, anchor } — Statusauswahl

  // ==========================================================================
  // Öffentliche API
  // ==========================================================================

  const TreeView = {
    mount(el) {
      if (!el) return;
      mountEl = el;
      buildShell();
      Store.subscribe(() => render());
      if (window.App && typeof App.onRoleChange === 'function') {
        App.onRoleChange(() => render());
      }
      render();
    },

    /** Knoten zentrieren und kurz hervorheben. */
    focusPerson(personId) {
      const id = Number(personId);
      if (!viewport) return;
      if (window.App && typeof App.showTab === 'function') App.showTab('tree');

      const entry = cards.find((c) => c.id === id);
      if (!entry) return;

      const box = boxOf(entry.el);
      const vw = viewport.clientWidth;
      const vh = viewport.clientHeight;
      if (!vw || !vh) return;

      // Aus der Übersicht heraus wäre die Karte unlesbar klein — auf eine
      // lesbare Stufe heranzoomen, einen bereits näheren Zoom aber behalten.
      if (scale < READABLE_SCALE) scale = READABLE_SCALE;

      tx = vw / 2 - (box.x + box.w / 2) * scale;
      ty = vh / 2 - (box.y + box.h / 2) * scale;
      applyTransform();

      for (const c of cards) c.el.classList.remove('tree-card--focus');
      entry.el.classList.add('tree-card--focus');
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => entry.el.classList.remove('tree-card--focus'), FOCUS_MS);
    }
  };

  // ==========================================================================
  // Grundgerüst
  // ==========================================================================

  function buildShell() {
    mountEl.textContent = '';

    const view = el('div', 'tree-view');
    viewEl = view;

    // --- Werkzeugleiste mit Suche ---------------------------------------
    const toolbar = el('div', 'tree-toolbar');

    const searchWrap = el('div', 'tree-search');
    const icon = el('span', 'tree-search__icon', '🔍');
    icon.setAttribute('aria-hidden', 'true');
    searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'input tree-search__input';
    searchInput.placeholder = 'Person suchen …';
    searchInput.setAttribute('aria-label', 'Person im Stammbaum suchen');
    searchWrap.append(icon, searchInput);

    searchStatus = el('span', 'tree-search__status small muted');
    searchStatus.setAttribute('role', 'status');

    // Bewusst keine Legende mehr: die Pillen auf den Karten sind beschriftet,
    // die statische Legende wurde im Nutzertest als Filter missverstanden.
    toolbar.append(searchWrap, searchStatus, buildAddToggle());

    searchInput.addEventListener('input', () => {
      searchTerm = searchInput.value || '';
      applyHighlight();
    });
    searchInput.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const first = firstMatch();
      if (first) TreeView.focusPerson(first.id);
      else if (searchTerm.trim()) App.toast('Keine passende Person gefunden.', 'info');
    });

    // --- Ansichtsfläche --------------------------------------------------
    viewport = el('div', 'tree-viewport');
    viewport.setAttribute('aria-label', 'Stammbaum');

    canvas = el('div', 'tree-canvas');

    svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'tree-lines');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    treeRoot = el('div', 'tree-root');
    canvas.append(svg, treeRoot);   // SVG als erstes Kind

    stateEl = el('div', 'tree-state');

    // Titel erscheint nur auf dem Papier — am Bildschirm steht er in der Kopfzeile.
    printTitle = el('div', 'tree-print-title');
    printTitle.setAttribute('aria-hidden', 'true');

    viewport.append(canvas, printTitle, stateEl, buildControls());
    view.append(toolbar, viewport);
    mountEl.appendChild(view);

    wireGestures();

    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => scheduleDraw());
      ro.observe(canvas);
      ro.observe(viewport);
    }
    window.addEventListener('resize', scheduleDraw);

    // Auch Strg+P (statt des Knopfes) soll ein brauchbares Blatt ergeben.
    window.addEventListener('beforeprint', beginPrint);
    window.addEventListener('afterprint', endPrint);
  }

  /**
   * Umschalter «Person hinzufügen» in der Werkzeugleiste.
   *
   * Der Zustand steht dreifach am Knopf: `aria-pressed` fürs Vorlesen, die
   * Beschriftung («Person hinzufügen» ↔ «Hinzufügen beenden») samt Zeichen
   * fürs Auge — und erst zuletzt die Färbung. Nie allein die Farbe.
   */
  function buildAddToggle() {
    addToggle = document.createElement('button');
    addToggle.type = 'button';
    addToggle.className = 'btn btn--secondary tree-addmode';

    const glyph = el('span', 'tree-addmode__glyph');
    glyph.setAttribute('aria-hidden', 'true');
    addToggle.append(glyph, el('span', 'tree-addmode__label'));

    addToggle.addEventListener('click', () => setAddMode(!addMode));
    syncAddToggle();
    return addToggle;
  }

  function setAddMode(on) {
    addMode = Boolean(on);
    if (viewEl) viewEl.classList.toggle(ADD_MODE_CLASS, addMode);
    syncAddToggle();
    // Die Abstammungslinien enden im Modus am Fläschchen, sonst am letzten
    // Kind — neu zeichnen, sobald sich das ändert.
    scheduleDraw();
  }

  function syncAddToggle() {
    if (!addToggle) return;
    const state = addMode ? ADD_MODE_ON : ADD_MODE_OFF;
    addToggle.setAttribute('aria-pressed', String(addMode));
    addToggle.title = state.title;
    addToggle.querySelector('.tree-addmode__glyph').textContent = state.glyph;
    addToggle.querySelector('.tree-addmode__label').textContent = state.label;
  }

  function buildControls() {
    const bar = el('div', 'tree-controls');
    const items = [
      { act: 'in',    icon: '＋', label: 'Vergrössern' },
      { act: 'out',   icon: '－', label: 'Verkleinern' },
      { act: 'fit',   icon: '⤢',  label: 'Ganzer Baum' },
      { act: 'reset', icon: '⟲',  label: 'Ansicht zurücksetzen' },
      // Emoji mit Variantenselektor (U+FE0F): ohne ihn zeichnen viele
      // Systemschriften U+1F5A8 gar nicht und es bleibt ein leeres Kästchen.
      { act: 'print', icon: '🖨️', label: 'Stammbaum drucken' }
    ];
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn--secondary btn--icon tree-controls__btn';
      btn.dataset.act = item.act;
      btn.title = item.label;
      btn.setAttribute('aria-label', item.label);
      const glyph = el('span', 'tree-controls__icon', item.icon);
      glyph.setAttribute('aria-hidden', 'true');
      btn.append(glyph, el('span', 'sr-only', item.label));
      bar.appendChild(btn);
    }
    bar.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'in') zoomBy(1.25);
      else if (btn.dataset.act === 'out') zoomBy(1 / 1.25);
      else if (btn.dataset.act === 'fit') fitToView();
      else if (btn.dataset.act === 'print') printTree();
      else resetView();
    });
    // Ziehen auf der Steuerleiste darf den Baum nicht verschieben
    bar.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    return bar;
  }

  // ==========================================================================
  // Rendern
  // ==========================================================================

  function render() {
    if (!treeRoot) return;

    // Die Pillen werden neu gebaut — eine offene Auswahl hinge sonst in der Luft
    closeUnionMenu({ keepFocus: true });

    links = [];
    spouseLinks = [];
    cards = [];
    partnerCards = new Map();
    // Die verschachtelten Knoten verschwinden mit dem alten Baum — sonst
    // hielten wir Verweise auf Elemente, die es nicht mehr gibt.
    printLaneRows = null;
    printLaneNodes = [];
    treeRoot.textContent = '';
    stateEl.textContent = '';
    stateEl.hidden = true;

    if (!Store.loaded) {
      showState('spinner');
      scheduleDraw();
      return;
    }

    const rootPerson = Store.rootPerson();
    if (!rootPerson) {
      showState('empty');
      scheduleDraw();
      return;
    }

    treeRoot.appendChild(renderNode(rootPerson, new Set()));
    applyHighlight();

    if (!didInitialView) {
      didInitialView = true;
      // Layout abwarten, dann die Wurzel oben mittig zeigen
      requestAnimationFrame(() => initialView());
    }
    scheduleDraw();
  }

  function showState(kind) {
    stateEl.hidden = false;
    if (kind === 'spinner') {
      const wrap = el('div', 'empty');
      wrap.append(el('div', 'spinner'), el('p', 'muted', 'Stammbaum wird geladen …'));
      stateEl.appendChild(wrap);
      return;
    }
    const wrap = el('div', 'empty');
    const icon = el('div', 'empty__icon', '🌱');
    icon.setAttribute('aria-hidden', 'true');
    wrap.append(icon, el('p', null, 'Noch kein Stammbaum vorhanden.'),
      el('p', 'small muted', 'Sobald eine Wurzelperson existiert, wächst der Baum hier.'));
    stateEl.appendChild(wrap);
  }

  /**
   * Ein Knoten = Blutlinien-Person mit je Seite einem Stapel Partnerschaften.
   *
   * Rasterzeilen: die unterste Zeile (`anchorRow`) trägt die Personenkarte und
   * beide Ankerpartnerschaften — dort hängen die Kinder darunter. Frühere,
   * kinderlose Partnerschaften stehen darüber, älteste zuoberst. Darunter,
   * in einer eigenen Zeile, sitzt das "+" für eine weitere Partnerschaft.
   */
  function renderNode(person, seen) {
    const node = el('div', 'tree-node');
    node.dataset.personId = String(person.id);

    if (seen.has(Number(person.id))) {
      node.appendChild(personCard(person, false));
      return node;                                   // Zyklusschutz
    }
    seen.add(Number(person.id));

    const stacks = {
      left: Store.unionStack(person.id, 'left'),
      right: Store.unionStack(person.id, 'right')
    };
    // Beide Stapel enden auf derselben, untersten Zeile
    const anchorRow = Math.max(stacks.left.length, stacks.right.length, 1);

    const top = el('div', 'tree-node__top');
    const anchor = personCard(person, false);
    anchor.classList.add('tree-node__person');
    anchor.style.gridRow = String(anchorRow);
    top.appendChild(anchor);

    const branchUnions = [];
    const herzSeite = heartSide(person, stacks);

    for (const side of ['left', 'right']) {
      const stack = stacks[side];
      const last = stack.length ? stack[stack.length - 1] : null;
      // Das "+" erscheint genau dann, wenn diese Seite noch keine
      // Partnerschaft mit Kindern trägt — der Platz darunter ist einmalig.
      const canAdd = Store.canAddUnion(person.id, side);

      stack.forEach((union, i) => {
        const row = anchorRow - stack.length + 1 + i;
        top.append(...unionRow(person, anchor, union, side, row, union === last, canAdd));
        // Kinder hängen unter der Ankerpartnerschaft. Laut Invariante ist alles
        // darüber kinderlos; sollten doch welche da sein, bekommen sie trotzdem
        // einen Zweig, damit keine Person unsichtbar wird.
        // Ein Zweig entsteht, wenn es Kinder gibt oder wenn welche angelegt
        // werden dürfen. Eine frühere Partnerschaft ohne Kinder bekommt also
        // keinen leeren Zweig mehr.
        if (Store.unionHasChildren(union.id) || (union === last && union.isCurrent)) {
          branchUnions.push(union);
        }
      });

      // Nur EIN Herz je Person — wo, entscheidet heartSide().
      if (side === herzSeite) {
        top.appendChild(addPartnerSlot(person, side,
          stack.length ? anchorRow + 1 : anchorRow, stack.length > 0));
      }
    }

    node.appendChild(top);

    if (branchUnions.length) {
      const wrap = el('div', 'tree-branches');
      for (const union of branchUnions) wrap.appendChild(renderBranch(union, anchor, seen));
      node.appendChild(wrap);
    }
    return node;
  }

  /**
   * Eine Zeile des Stapels: Partnerkarte + Statuspille, in der richtigen
   * Rasterspalte. Gibt [Zelle, Pille] zurück — beides sind Rasterelemente.
   */
  function unionRow(person, personEl, union, side, row, isAnchor, canAddChild) {
    const partner = Store.partnerOf(union);
    const cardEl = partner
      ? personCard(partner, true, union.isCurrent)
      : emptyPartner(union);
    partnerCards.set(Number(union.id), cardEl);      // für die Linienberechnung

    const cell = el('div', 'tree-union tree-union--' + side +
      (isAnchor ? ' tree-union--anchor' : ' tree-union--stacked'));
    cell.style.gridRow = String(row);

    // Hochgeschobene Partnerschaften haben keinen eigenen Zweig unter dem
    // Knoten — der gehört der Ankerpartnerschaft. Damit auch hier Kinder
    // erfasst werden können, sitzt das Fläschchen direkt in der Zeile.
    // Es erscheint nur, wenn die Partnerschaft laufend ist und die Seite noch
    // keine mit Kindern hat; sonst gäbe es zwei davon auf einer Seite und der
    // Platz unter der Person reichte nicht.
    const kidSlot = (!isAnchor && canAddChild && union.isCurrent)
      ? childAddSlot(union) : null;
    if (side === 'left') cell.append(...(kidSlot ? [kidSlot, cardEl] : [cardEl]));
    else cell.append(...(kidSlot ? [cardEl, kidSlot] : [cardEl]));

    const mark = unionMark(union);
    mark.classList.add('tree-mark--' + side);
    mark.style.gridRow = String(row);

    spouseLinks.push({ union, personEl, partnerEl: cardEl, stacked: !isAnchor });

    return [cell, mark];
  }

  /** Statuspille zwischen Person und Partner:in — anklickbar, öffnet die Auswahl.
      Der Knopf ist bewusst grösser als die sichtbare Pille (44 px Trefferfläche). */
  function unionMark(union) {
    const wrap = el('span', 'tree-mark');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tree-mark__btn';
    btn.dataset.unionId = String(union.id);
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');

    const pill = el('span', 'pill ' + (union.isCurrent ? 'pill--mint' : 'tree-mark__past'));
    const glyph = el('span', 'tree-mark__glyph', union.isCurrent ? '♥' : '⤫');
    glyph.setAttribute('aria-hidden', 'true');
    pill.append(glyph, el('span', 'tree-mark__text',
      union.isCurrent ? 'aktuell' : 'früher'));

    const state = union.isCurrent ? 'Aktuelle Partnerschaft' : 'Frühere Partnerschaft';
    btn.title = state + (union.note ? ': ' + union.note : '') + ' — zum Ändern anklicken';
    btn.setAttribute('aria-label',
      'Status der Partnerschaft ' + unionWith(union) + ' ändern (aktuell: ' +
      (union.isCurrent ? 'aktuelle Partnerschaft' : 'frühere Partnerschaft') + ')');

    btn.appendChild(pill);
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (openMenu && openMenu.unionId === Number(union.id)) closeUnionMenu();
      else openUnionMenu(union, btn);
    });

    wrap.appendChild(btn);
    return wrap;
  }

  /** "mit Beat Muster" bzw. "von Anna Muster", je nachdem was bekannt ist. */
  function unionWith(union) {
    const partner = Store.partnerOf(union);
    if (partner) return 'mit ' + Store.displayName(partner);
    const anchor = Store.person(union.personId);
    return anchor ? 'von ' + Store.displayName(anchor) : '';
  }

  function emptyPartner(union) {
    const box = el('div', 'tree-card tree-card--partner tree-card--ghost');
    box.append(el('span', 'tree-card__name muted', 'Partner:in unbekannt'));
    if (!union.isCurrent) box.classList.add('tree-card--past');
    return box;
  }

  function renderBranch(union, anchorEl, seen) {
    const branch = el('div', 'tree-branch');
    branch.dataset.unionId = String(union.id);
    if (!union.isCurrent) branch.classList.add('tree-branch--past');

    branch.appendChild(el('div', 'tree-branch__drop'));

    const kids = el('div', 'tree-kids');
    const targets = [];

    for (const child of Store.childrenOf(union.id)) {
      const childNode = renderNode(child, seen);
      kids.appendChild(childNode);
      const card = childNode.querySelector('.tree-card[data-person-id="' + child.id + '"]');
      if (card) targets.push(card);
    }

    // Kinder lassen sich nur an eine laufende Partnerschaft hängen. Eine
    // beendete bekommt keine neuen mehr — wer ein Kind nachtragen muss, stellt
    // die Partnerschaft kurz auf «aktuell». Das verhindert vor allem, dass der
    // einmalige Kinderplatz einer Seite versehentlich an eine frühere
    // Partnerschaft geht und der laufenden dann fehlt.
    if (union.isCurrent) {
      const addWrap = el('div', 'tree-add');
      const addBtn = childAddButton(union);
      addWrap.appendChild(addBtn);
      kids.appendChild(addWrap);
      targets.push(addBtn);
    }

    branch.appendChild(kids);

    links.push({
      union,
      anchorEl,
      // Der ganze Knotenkopf: Die Querlinie zu den Kindern muss unterhalb
      // davon verlaufen, sonst schneidet sie die "+"-Zeile unter dem Stapel.
      topEl: anchorEl.closest('.tree-node__top'),
      partnerEl: partnerCards.get(Number(union.id)) || null,
      kidsEl: kids,
      targets
    });
    return branch;
  }

  /**
   * Grüner Knopf für ein Kind einer Partnerschaft.
   *
   * Sinnbild statt "+": Ein Schoppenfläschchen liest sich auch für Kinder und
   * Grosseltern sofort als "hier kommt ein Kind dazu". Einen Schnuller gibt es
   * als Zeichen nicht — das Fläschchen ist das nächstliegende, das überall
   * dargestellt wird.
   */
  function childAddButton(union) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-add tree-add__btn';
    btn.textContent = '🍼';
    const label = 'Kind hinzufügen bei ' + Store.unionLabel(union);
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.addEventListener('click', () => openChildDialog(union));
    return btn;
  }

  /** Derselbe Knopf, aber in einer 44-px-Trefferfläche für den Stapel. */
  function childAddSlot(union) {
    const wrap = el('span', 'tree-union__kid');
    wrap.appendChild(childAddButton(union));
    return wrap;
  }

  /**
   * Auf welcher Seite steht das eine Herz — oder nirgends?
   *
   * Es gibt bewusst nur eines je Person: Zwei Herzen liessen offen, welches
   * gemeint ist, und machten den Knoten unruhig.
   *
   * 1. Keine Partnerschaft → die Seite, die den Baum am wenigsten verbreitert.
   * 2. Genau eine Seite belegt → die andere Seite (damit auch dort eine
   *    Partnerschaft mit Kindern möglich bleibt).
   * 3. Beide Seiten belegt, eine davon mit Kindern → die kinderlose Seite;
   *    auf der anderen ist der Platz unter der Person schon vergeben.
   * 4. Beide belegt und beide kinderlos → wieder die schmalere Seite.
   *
   * Tragen beide Seiten Kinder, ist Schluss: dann kein Herz.
   *
   * @returns {'left'|'right'|null}
   */
  function heartSide(person, stacks) {
    const canLeft = Store.canAddUnion(person.id, 'left');
    const canRight = Store.canAddUnion(person.id, 'right');

    if (!canLeft && !canRight) return null;      // beide Seiten haben Kinder
    if (!canLeft) return 'right';                // Regel 3
    if (!canRight) return 'left';

    const hasLeft = stacks.left.length > 0;
    const hasRight = stacks.right.length > 0;
    if (hasLeft && !hasRight) return 'right';    // Regel 2
    if (hasRight && !hasLeft) return 'left';

    return compactSide(person);                  // Regeln 1 und 4
  }

  /**
   * Die Seite, die den Baum am wenigsten in die Breite treibt.
   *
   * Nachgemessen macht die Seitenwahl bei einer Person ohne Partnerschaft
   * praktisch keinen Unterschied (195 px links gegenüber 193 px rechts) — die
   * Spalte entsteht so oder so. Spürbar ist etwas anderes: Eine weitere
   * Partnerschaft auf einer bereits belegten Seite stapelt sich senkrecht und
   * kostet nur 46 px, auf der freien Seite dagegen 196 px.
   *
   * Bleibt die Optik: Das Herz zeigt zur Mitte des Geschwisterzugs, damit die
   * Aussenkante des Baums nicht unnötig ausfranst.
   */
  function compactSide(person) {
    const geschwister = person.parentUnionId
      ? Store.childrenOf(person.parentUnionId)
      : [];
    if (geschwister.length < 2) return 'left';

    const i = geschwister.findIndex((g) => Number(g.id) === Number(person.id));
    if (i < 0) return 'left';
    return i < (geschwister.length - 1) / 2 ? 'right' : 'left';
  }

  /**
   * Blaues "+" für eine weitere Partnerschaft. Steht unter dem Stapel — dort,
   * wo die nächste Partnerschaft aufschlägt (die bestehenden rutschen hoch).
   * Ist die Seite noch leer, sitzt es wie bisher neben der Personenkarte.
   */
  function addPartnerSlot(person, side, row, belowStack) {
    const wrap = el('div', 'tree-partner-slot tree-partner-slot--' + side +
      (belowStack ? ' tree-partner-slot--stacked' : ''));
    wrap.style.gridRow = String(row);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-add btn-add--partner';
    btn.textContent = '❤️';
    // Der Name gehört in den Tooltip: Bei einem dicht gestapelten Baum ist sonst
    // nicht zu erkennen, zu wem das Herz gehört.
    const label = (belowStack ? 'Weitere Partner:in für ' : 'Partner:in für ') +
      Store.displayName(person) + ' hinzufügen';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.addEventListener('click', () => openPartnerDialog(person, side));
    wrap.appendChild(btn);
    return wrap;
  }

  function personCard(person, isPartner, unionCurrent) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tree-card' + (isPartner ? ' tree-card--partner' : '');
    if (isPartner && unionCurrent === false) btn.classList.add('tree-card--past');
    if (Store.isDeceased(person)) btn.classList.add('tree-card--deceased');
    btn.dataset.personId = String(person.id);

    const avatar = el('span', 'avatar avatar--sm ' + Store.avatarClass(person),
      Store.initials(person));
    avatar.setAttribute('aria-hidden', 'true');

    const body = el('span', 'tree-card__body');
    body.appendChild(el('span', 'tree-card__name', Store.displayName(person)));

    const span = Store.lifeSpan(person);
    const deceased = Store.isDeceased(person);
    if (span || deceased) {
      const meta = el('span', 'tree-card__meta');
      if (deceased) {
        // lifeSpan() setzt bei reinem Todesdatum bereits ein Kreuz davor
        if (!span.startsWith('†')) {
          const cross = el('span', 'tree-card__cross', '†');
          cross.setAttribute('aria-hidden', 'true');
          meta.appendChild(cross);
        }
        meta.appendChild(el('span', 'sr-only', 'verstorben — '));
      }
      meta.appendChild(document.createTextNode(span));
      body.appendChild(meta);
    }

    if (person.maidenName) {
      body.appendChild(el('span', 'tree-card__meta faint', 'geb. ' + person.maidenName));
    }

    btn.append(avatar, body);
    btn.addEventListener('click', () => {
      if (window.PersonPanel && typeof PersonPanel.open === 'function') {
        PersonPanel.open(person.id);
      }
    });

    cards.push({ id: Number(person.id), el: btn });
    return btn;
  }

  // ==========================================================================
  // Linien zeichnen
  // ==========================================================================

  function scheduleDraw() {
    if (rafHandle) return;
    rafHandle = requestAnimationFrame(() => {
      rafHandle = null;
      draw();
    });
  }

  function draw() {
    if (!svg || !canvas) return;

    // Scroll-/Inhaltsgrösse des Canvas — nie über getBoundingClientRect,
    // weil der Canvas per transform: scale() gezoomt wird.
    const w = Math.max(canvas.offsetWidth, canvas.scrollWidth,
      treeRoot ? treeRoot.offsetWidth : 0);
    const h = Math.max(canvas.offsetHeight, canvas.scrollHeight,
      treeRoot ? treeRoot.offsetHeight : 0);
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));

    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if ((!links.length && !spouseLinks.length) || !w) return;

    // Erst die ganze Geometrie sammeln, dann versetzen, dann zeichnen: nur so
    // lässt sich erkennen, welche Abschnitte deckungsgleich verlaufen.
    const bundles = [];

    // --- Person ↔ Partner:in, für jede Partnerschaft des Stapels -----------
    for (const link of spouseLinks) {
      const cls = 'tree-line tree-line--partner' +
        (link.union.isCurrent ? '' : ' tree-line--past');
      const a = boxOf(link.personEl);
      const b = boxOf(link.partnerEl);
      const cy = Math.round(a.y + a.h / 2);
      const toRight = b.x > a.x;
      const x1 = toRight ? a.x + a.w : a.x;          // Kante der Personenkarte
      const x2 = toRight ? b.x : b.x + b.w;          // innere Kante der Partnerkarte

      if (!link.stacked) {
        bundles.push(bundle('s' + link.union.id, cls, [seg('h', cy, x1, x2)],
          (dx, dy) => ['M ' + x1 + ' ' + (cy + dy) + ' H ' + x2]));
        continue;
      }
      // Hochgeschoben: waagrecht bis zur gemeinsamen Senkrechten zwischen den
      // Karten (sie verläuft hinter den Statuspillen), dann hinunter auf die
      // Höhe der Personenkarte, wo die Linie der Ankerpartnerschaft wartet.
      // Alle Hochgeschobenen einer Seite teilen sich diese Senkrechte — sie
      // ist der häufigste Fall deckungsgleicher Linien überhaupt.
      const by = Math.round(b.y + b.h / 2);
      const mid = Math.round((x1 + x2) / 2);
      bundles.push(bundle('s' + link.union.id, cls,
        [seg('h', by, x2, mid), seg('v', mid, by, cy)],
        (dx, dy) => [elbow(x2, by + dy, mid + dx, cy)]));
    }

    // --- Abstammungslinien zu den Kindern ----------------------------------
    // Bei verschachtelten Geschwistern brauchen wir die Lage aller Karten, um
    // die Abgänge durch die Gassen zu führen — einmal messen genügt.
    const obstacles = printLaneRows ? cardRects() : null;
    const tints = descentTints();

    for (const link of links) {
      const targets = link.targets.filter(isLineTarget);
      if (!targets.length) continue;

      const past = !link.union.isCurrent;
      const a = boxOf(link.anchorEl);
      let sx = a.x + a.w / 2;
      let sy = a.y + a.h;

      if (link.partnerEl) {
        const b = boxOf(link.partnerEl);
        sx = (a.x + a.w / 2 + b.x + b.w / 2) / 2;
        sy = Math.max(a.y + a.h, b.y + b.h);
      }

      const kids = boxOf(link.kidsEl);
      let busY = (sy + kids.y) / 2;
      if (link.topEl) {
        // Unter dem Knotenkopf bleiben — dort steht ggf. das "+" für eine
        // weitere Partnerschaft, durch das die Querlinie nicht laufen darf.
        const top = boxOf(link.topEl);
        busY = Math.min(Math.max(busY, top.y + top.h + 8), kids.y - 8);
      }
      busY = Math.round(busY);
      const tint = tints.get(Number(link.union.id));
      const cls = 'tree-line tree-line--descent' + (past ? ' tree-line--past' : '') +
        (tint == null ? '' : ' tree-line--tinted tree-line--tint' + tint);

      const lanes = printLaneRows ? printLaneRows.get(link.kidsEl) : null;
      if (!lanes) {
        const drops = targets.map((target) => {
          const t = boxOf(target);
          return { x: t.x + t.w / 2, y: t.y };
        });
        const segs = [seg('v', sx, sy, busY)];
        for (const d of drops) {
          segs.push(seg('h', busY, sx, d.x));
          segs.push(seg('v', d.x, busY, d.y));
        }
        bundles.push(bundle('u' + link.union.id, cls, segs, (dx, dy) => {
          const out = ['M ' + (sx + dx) + ' ' + sy + ' V ' + (busY + dy)];
          for (const d of drops) out.push(elbow(sx + dx, busY + dy, d.x + dx, d.y));
          return out;
        }));
        continue;
      }

      // Verschachtelt: Spur 0 hängt wie gewohnt an der Querlinie. Für jede
      // tiefere Spur führt ein Abgang durch eine Gasse zwischen den Karten der
      // Spur darüber hinunter auf eine eigene Querlinie — deshalb schneidet
      // keine Linie eine Karte.
      const geo = laneGeometry(lanes);
      const byLane = [];
      for (const target of targets) {
        let k = laneOfTarget(lanes, target);
        if (geo.levelY[k] == null) k = 0;      // Rückfall, falls unvermessen
        (byLane[k] || (byLane[k] = [])).push(target);
      }

      const hops = [];
      const laneSegs = [seg('v', sx, sy, busY)];
      let fromX = sx;
      let fromY = busY;
      for (let k = 0; k < lanes.laneCount; k++) {
        if (geo.levelY[k] == null) continue;
        if (k > 0) {
          const gate = corridorX(fromY, geo.levelY[k], geo.window, fromX, obstacles);
          hops.push({ toLane: true, fromX, fromY, x: gate, y: geo.levelY[k] });
          laneSegs.push(seg('h', fromY, fromX, gate));
          laneSegs.push(seg('v', gate, fromY, geo.levelY[k]));
          fromX = gate;
          fromY = geo.levelY[k];
        }
        for (const target of (byLane[k] || [])) {
          const t = boxOf(target);
          const cx = t.x + t.w / 2;
          hops.push({ toLane: false, fromX, fromY, x: cx, y: t.y });
          laneSegs.push(seg('h', fromY, fromX, cx));
          laneSegs.push(seg('v', cx, fromY, t.y));
        }
      }
      // lockX: die Abgänge sind von corridorX auf freie Gassen eingemessen;
      // ein seitlicher Versatz frässe genau den Sicherheitsabstand auf, der
      // dafür sorgt, dass keine Linie durch eine Karte läuft.
      const laneBundle = bundle('u' + link.union.id, cls, laneSegs, (dx, dy) => {
        const out = ['M ' + sx + ' ' + sy + ' V ' + (busY + dy)];
        for (const hop of hops) {
          out.push(elbow(hop.fromX, hop.fromY + dy, hop.x,
            hop.y + (hop.toLane ? dy : 0), LANE_CORNER));
        }
        return out;
      });
      laneBundle.lockX = true;
      bundles.push(laneBundle);
    }

    spreadParallels(bundles);

    const frag = document.createDocumentFragment();
    for (const b of bundles) {
      for (const d of b.emit(b.dx, b.dy)) frag.appendChild(path(d, b.cls));
    }
    svg.appendChild(frag);
  }

  /**
   * Ein Linienbündel: alle Abschnitte, die zusammen eine Aussage zeichnen
   * (eine Partnerschaft, eine Elternschaft mit all ihren Kindern).
   *
   * `segs` ist die Lage vor dem Versatz — daran wird erkannt, wer sich mit wem
   * überdeckt. `emit(dx, dy)` zeichnet dasselbe Bündel um `dx`/`dy` versetzt:
   * `dy` verschiebt die waagrechten Abschnitte, `dx` die senkrechten. Weil das
   * ganze Bündel denselben Versatz bekommt, zerfällt keine Linie in Stücke;
   * und weil nur die Ecken wandern und nicht die Kartenkanten, setzen die
   * Linien weiterhin an ihren Karten an.
   */
  function bundle(key, cls, segs, emit) {
    return { key, cls, segs, emit, dx: 0, dy: 0, lockX: false };
  }

  /** Ein waagrechter ('h', c = y) oder senkrechter ('v', c = x) Abschnitt. */
  function seg(o, c, a, b) {
    return { o, c, a: Math.min(a, b), b: Math.max(a, b) };
  }

  /**
   * Farbindex je Partnerschaft — nur für Personen mit Kindern aus mehr als
   * einer Partnerschaft. Beim Normalfall (eine Partnerschaft mit Kindern)
   * bleibt es bei der unauffälligen Linienfarbe, der Baum soll nicht unnötig
   * bunt werden.
   *
   * Der Index kommt aus der Union-ID, nicht aus der Zeichenreihenfolge —
   * dieselbe Partnerschaft behält ihre Farbe über Neuzeichnen, Zoom und
   * Neuladen hinweg. Fallen zwei IDs derselben Person auf denselben Platz,
   * rückt die zweite auf den nächsten freien; sortiert wird dafür nach ID,
   * das Ergebnis bleibt also ebenfalls stabil.
   *
   * @returns {Map<number, number>} Union-ID → 0 … TINT_COUNT-1
   */
  function descentTints() {
    const byPerson = new Map();
    for (const link of links) {
      if (!Store.unionHasChildren(link.union.id)) continue;
      const pid = Number(link.union.personId);
      const list = byPerson.get(pid);
      if (list) list.push(link.union);
      else byPerson.set(pid, [link.union]);
    }

    const out = new Map();
    for (const unions of byPerson.values()) {
      if (unions.length < 2) continue;
      const used = new Set();
      for (const u of unions.slice().sort((a, b) => Number(a.id) - Number(b.id))) {
        let i = Number(u.id) % TINT_COUNT;
        for (let step = 0; step < TINT_COUNT && used.has(i); step++) {
          i = (i + 1) % TINT_COUNT;
        }
        used.add(i);
        out.set(Number(u.id), i);
      }
    }
    return out;
  }

  /**
   * Bündel auseinanderziehen, die parallel und deckungsgleich verlaufen.
   *
   * Kreuzen dürfen sich Linien weiterhin — dort ist die Lage ja nicht dieselbe.
   * Wer sich aber über eine Strecke überdeckt, landet in einer Gruppe und wird
   * symmetrisch um wenige Pixel gegeneinander versetzt. Die Reihenfolge kommt
   * aus dem Bündelschlüssel (Union-ID), damit derselbe Baum immer gleich
   * aussieht.
   */
  function spreadParallels(bundles) {
    for (const axis of ['h', 'v']) {
      for (const group of parallelGroups(bundles, axis)) {
        group.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        for (let i = 0; i < group.length; i++) {
          const shift = (i - (group.length - 1) / 2) * PARALLEL_STEP;
          if (axis === 'h') group[i].dy += shift;
          else if (!group[i].lockX) group[i].dx += shift;
        }
      }
    }
  }

  /**
   * Bündel, die sich in dieser Achse überdecken, als Gruppen.
   *
   * Zwei Abschnitte zählen als deckungsgleich, wenn sie dieselbe Achse haben,
   * ihre Lage bis auf PARALLEL_TOL übereinstimmt und sich ihre Ausdehnung
   * wirklich überschneidet. Berühren sich zwei Bündel über mehrere Abschnitte
   * oder über ein drittes, gehören sie in dieselbe Gruppe (Union-Find) —
   * sonst würde ein Bündel zweimal versetzt.
   */
  function parallelGroups(bundles, axis) {
    const root = bundles.map((_, i) => i);
    const find = (i) => {
      while (root[i] !== i) { root[i] = root[root[i]]; i = root[i]; }
      return i;
    };

    const list = [];
    bundles.forEach((b, i) => {
      for (const s of b.segs) if (s.o === axis) list.push({ s, i });
    });

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].i === list[j].i) continue;      // dasselbe Bündel
        const a = list[i].s;
        const b = list[j].s;
        if (Math.abs(a.c - b.c) > PARALLEL_TOL) continue;
        if (Math.min(a.b, b.b) - Math.max(a.a, b.a) <= PARALLEL_MIN) continue;
        const ra = find(list[i].i);
        const rb = find(list[j].i);
        if (ra !== rb) root[ra] = rb;
      }
    }

    const groups = new Map();
    for (let i = 0; i < bundles.length; i++) {
      const r = find(i);
      const g = groups.get(r);
      if (g) g.push(bundles[i]);
      else groups.set(r, [bundles[i]]);
    }
    return Array.from(groups.values()).filter((g) => g.length > 1);
  }

  /** Alle sichtbaren Karten als Rechtecke in Canvas-Koordinaten. */
  function cardRects() {
    const out = [];
    for (const node of canvas.querySelectorAll('.tree-card')) {
      if (isVisible(node)) out.push(boxOf(node));
    }
    return out;
  }

  /** Höhe der Querlinie je Spur und das waagrechte Fenster der Reihe. */
  function laneGeometry(lanes) {
    const levelY = [];
    let minX = Infinity, maxX = -Infinity;
    for (const [node, lane] of lanes.laneOf) {
      const b = boundsOf(node, '.tree-card');
      if (!b) continue;
      if (levelY[lane] == null || b.y < levelY[lane]) levelY[lane] = b.y;
      if (b.x < minX) minX = b.x;
      if (b.x + b.w > maxX) maxX = b.x + b.w;
    }
    // Die Querlinie liegt mittig im Spurabstand: unter allen Karten der Spuren
    // darüber und über allen Karten dieser Spur.
    for (let k = 1; k < levelY.length; k++) {
      if (levelY[k] != null) levelY[k] = Math.round(levelY[k] - LANE_GAP / 2);
    }
    const pad = LANE_CORRIDOR + LANE_CLEAR;
    return {
      levelY,
      window: Number.isFinite(minX)
        ? { min: minX - pad, max: maxX + pad }
        : { min: 0, max: 0 }
    };
  }

  /** Zu welcher Spur gehört das Ziel? Über den Geschwisterknoten, in dem es sitzt. */
  function laneOfTarget(lanes, target) {
    let n = target;
    while (n && n.parentElement !== lanes.kidsEl) n = n.parentElement;
    return (n && lanes.laneOf.get(n)) || 0;
  }

  /**
   * Freie Gasse für einen senkrechten Abgang zwischen zwei Höhen.
   *
   * Alles, was das Höhenband schneidet, sperrt einen x-Streifen; gesucht ist
   * die Lücke, die `near` am nächsten liegt. Damit läuft keine Linie durch eine
   * Karte, auch wenn die Spuren dicht gepackt sind.
   */
  function corridorX(yTop, yBot, win, near, rects) {
    const top = Math.min(yTop, yBot);
    const bottom = Math.max(yTop, yBot);
    const blocked = [];
    for (const r of rects) {
      if (r.y + r.h <= top || r.y >= bottom) continue;
      blocked.push([r.x - LANE_CLEAR, r.x + r.w + LANE_CLEAR]);
    }
    blocked.sort((a, b) => a[0] - b[0]);

    let best = null;
    let bestDist = Infinity;
    const consider = (a, b) => {
      if (b <= a) return;
      const v = Math.min(Math.max(near, a), b);
      const d = Math.abs(v - near);
      if (d < bestDist) { bestDist = d; best = v; }
    };

    let x = win.min;
    for (const [a, b] of blocked) {
      if (a > x) consider(x, Math.min(a, win.max));
      if (b > x) x = b;
      if (x >= win.max) break;
    }
    consider(x, win.max);
    return best == null ? near : Math.round(best);
  }

  /** Senkrecht runter, waagrecht rüber, mit kleinem Bogen wieder senkrecht rein.
      `maxR` begrenzt den Eckenradius — in einer schmalen Gasse muss der Bogen
      eng bleiben, sonst greift er auf die Karte daneben über. */
  function elbow(sx, busY, tx2, ty2, maxR) {
    const dx = tx2 - sx;
    if (Math.abs(dx) < 1.5) return 'M ' + sx + ' ' + busY + ' V ' + ty2;
    const dir = dx > 0 ? 1 : -1;
    const r = Math.min(maxR || CORNER, Math.abs(dx),
      Math.max(2, Math.abs(ty2 - busY)));
    const sweep = dir > 0 ? 1 : 0;
    return 'M ' + sx + ' ' + busY +
           ' H ' + (tx2 - dir * r) +
           ' A ' + r + ' ' + r + ' 0 0 ' + sweep + ' ' + tx2 + ' ' + (busY + r) +
           ' V ' + ty2;
  }

  function path(d, cls) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', cls);
    return p;
  }

  /** Ist das Element im Layout vorhanden? (display:none hat keine Ausmasse.) */
  function isVisible(node) {
    return Boolean(node && (node.offsetWidth || node.offsetHeight));
  }

  /**
   * Taugt das Element als Ende einer Abstammungslinie?
   *
   * Im Druck sind die Fläschchen aus dem Layout genommen — ein solches Ziel hat
   * keine Position und zöge die Linie in die linke obere Ecke. Ausserhalb des
   * Hinzufügen-Modus halten sie zwar ihren Platz, sind aber unsichtbar; eine
   * Linie dorthin endete sichtbar im Nichts.
   */
  function isLineTarget(node) {
    if (!isVisible(node)) return false;
    return addMode || !node.classList.contains('btn-add');
  }

  /** Position relativ zum Canvas — über die offsetParent-Kette, nicht per Rect. */
  function boxOf(node) {
    let x = 0, y = 0, n = node;
    while (n && n !== canvas) {
      x += n.offsetLeft;
      y += n.offsetTop;
      n = n.offsetParent;
    }
    return { x, y, w: node.offsetWidth, h: node.offsetHeight };
  }

  // ==========================================================================
  // Pan, Zoom, Ansicht
  // ==========================================================================

  function applyTransform() {
    canvas.style.transform =
      'translate(' + Math.round(tx) + 'px, ' + Math.round(ty) + 'px) scale(' + scale + ')';
  }

  function clampScale(value) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
  }

  function zoomAt(px, py, next) {
    const target = clampScale(next);
    if (target === scale) return;
    const wx = (px - tx) / scale;
    const wy = (py - ty) / scale;
    scale = target;
    tx = px - wx * scale;
    ty = py - wy * scale;
    applyTransform();
  }

  function zoomBy(factor) {
    zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, scale * factor);
  }

  /** Echte Bounding-Box des Inhalts in Canvas-Koordinaten.
      treeRoot.offsetWidth genügt dafür nicht: verschachtelte Flex-Reihen können
      breiter sein als ihr Elternknoten und über dessen Rand hinausragen — und
      das Wurzelelement hat zusätzlich Innenabstand, der nicht zum Inhalt zählt.
      @param {{cardsOnly?: boolean}} [opts] cardsOnly lässt Herzen und
      Fläschchen aussen vor — im Druck sind sie ausgeblendet und dürfen den
      Massstab nicht mitbestimmen. Ausserhalb des Hinzufügen-Modus gilt
      dasselbe: sie halten zwar ihren Platz, zu sehen ist dort aber nichts. */
  function contentBox(opts) {
    const sel = ((opts && opts.cardsOnly) || !addMode)
      ? '.tree-card' : '.tree-card, .btn-add';
    const box = canvas ? boundsOf(canvas, sel) : null;
    if (box) return box;
    return { x: 0, y: 0, w: treeRoot ? treeRoot.offsetWidth : 0,
             h: treeRoot ? treeRoot.offsetHeight : 0 };
  }

  /** Umschliessendes Rechteck aller sichtbaren Treffer von `sel` in `root`,
      in Canvas-Koordinaten. Ohne Treffer null. */
  function boundsOf(root, sel) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of root.querySelectorAll(sel)) {
      if (!isVisible(node)) continue;
      const b = boxOf(node);
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.w > maxX) maxX = b.x + b.w;
      if (b.y + b.h > maxY) maxY = b.y + b.h;
    }
    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function fitToView() {
    if (!viewport) return;
    const box = contentBox();
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    if (!box.w || !box.h || !vw || !vh) return;
    scale = clampScale(fitScale(box, vw, vh));
    // Auf die Mitte der Bounding-Box zentrieren, nicht auf die Elementmitte
    tx = vw / 2 - (box.x + box.w / 2) * scale;
    ty = vh / 2 - (box.y + box.h / 2) * scale;
    applyTransform();
    scheduleDraw();
  }

  function fitScale(box, vw, vh) {
    const pad = 48;
    // Nie über 1 hochskalieren — kleine Bäume sollen nicht aufgeblasen wirken
    return Math.min((vw - pad) / box.w, (vh - pad) / box.h, 1);
  }

  /** Startansicht: lesbar bleiben, Wurzelperson oben in der Mitte. */
  function initialView() {
    if (!viewport) return;
    const box = contentBox();
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    if (!box.w || !box.h || !vw || !vh) return;

    // Auf schmalen Geräten darf die Startansicht weiter herauszoomen
    const floor = vw < 600 ? 0.5 : 0.7;
    scale = clampScale(Math.max(fitScale(box, vw, vh), floor));
    const entry = cards.find((c) => c.id === Number(Store.data.rootPersonId));
    if (entry) {
      const b = boxOf(entry.el);
      tx = vw / 2 - (b.x + b.w / 2) * scale;
      ty = Math.max(24, 24 - (b.y - 24) * scale);
    } else {
      tx = vw / 2 - (box.x + box.w / 2) * scale;
      ty = 24 - box.y * scale;
    }
    applyTransform();
    scheduleDraw();
  }

  function resetView() {
    if (!viewport) return;
    scale = 1;
    const entry = cards.find((c) => c.id === Number(Store.data.rootPersonId));
    if (entry) {
      const b = boxOf(entry.el);
      tx = viewport.clientWidth / 2 - (b.x + b.w / 2);
      ty = 24 - (b.y - 24);
    } else {
      const box = contentBox();
      tx = viewport.clientWidth / 2 - (box.x + box.w / 2);
      ty = 24 - box.y;
    }
    applyTransform();
    scheduleDraw();
  }

  // ==========================================================================
  // Drucken — der ganze Baum auf eine A4-Seite quer
  // Der Druckmodus ist eine Klasse am <body>; css/print.css blendet damit alles
  // aus, was nicht zum Baum gehört, und setzt den Baum kompakter. Massstab und
  // Verschiebung rechnen wir hier aus, weil nur JS die echte Inhaltsgrösse kennt.
  // ==========================================================================

  /** Versalhöhe der Namen auf dem Papier, in Millimetern. */
  function printCapMm(s) {
    return PRINT_NAME_PX * s * PX_TO_MM * CAP_RATIO;
  }

  // --------------------------------------------------------------------------
  // Verschachtelung der Geschwister (nur im Druck)
  // --------------------------------------------------------------------------

  /** Alle Ränder zurücknehmen — die Bildschirmansicht bleibt unangetastet. */
  function clearPrintLanes() {
    for (const node of printLaneNodes) {
      node.style.marginLeft = '';
      node.style.marginTop = '';
    }
    printLaneNodes = [];
    printLaneRows = null;
    document.body.classList.remove(PRINT_LANES_CLASS);
  }

  /** Geschwisterreihen, tiefste zuerst: die Breite einer Reihe hängt davon ab,
      wie schmal die Reihen darunter schon geworden sind. */
  function kidRowsDeepestFirst() {
    const rows = [];
    for (const row of canvas.querySelectorAll('.tree-kids')) {
      let depth = 0;
      for (let n = row.parentElement; n && n !== canvas; n = n.parentElement) {
        if (n.classList.contains('tree-kids')) depth++;
      }
      rows.push({ el: row, depth });
    }
    rows.sort((a, b) => b.depth - a.depth);
    return rows;
  }

  /**
   * Geschwister einer Reihe auf `laneCount` Spuren verteilen.
   *
   * Reihum: Kind 0 auf Spur 0, Kind 1 auf Spur 1, … Der senkrechte Versatz
   * einer Spur ist so gross, dass die Karten der Spuren darüber — samt ihrer
   * ganzen Nachkommenschaft — vollständig darüber liegen. Dadurch bleibt
   * zwischen zwei Spuren ein waagrechtes Band völlig frei von Karten; genau
   * dort verlaufen später die Querlinien.
   *
   * Waagrecht dürfen sich nur Knoten *verschiedener* Spuren überlappen. Zwei
   * Knoten derselben Spur behalten mindestens LANE_CORRIDOR Abstand — die
   * Gasse, durch die der Abgang zur nächsten Spur läuft.
   */
  function applyPrintLanes(laneCount) {
    clearPrintLanes();
    if (!canvas || laneCount < 2) return;
    document.body.classList.add(PRINT_LANES_CLASS);

    const rows = new Map();
    for (const row of kidRowsDeepestFirst()) {
      const kidsEl = row.el;
      const nodes = Array.from(kidsEl.children)
        .filter((c) => c.classList.contains('tree-node'));
      if (nodes.length < 2) continue;
      const count = Math.min(laneCount, nodes.length);

      // Gemessen wird der Kartenkasten, nicht der Knotenkasten: nur Karten
      // dürfen sich nicht berühren, Zwischenräume im Knoten dürfen es.
      const items = nodes.map((node) => {
        const nb = boxOf(node);
        const cb = boundsOf(node, '.tree-card') || nb;
        return {
          el: node,
          x: nb.x,
          left: cb.x - nb.x,                 // Karten-Einzug links
          right: cb.x + cb.w - nb.x,         // Karten-Kante rechts
          bottom: cb.y + cb.h - nb.y         // unterste Karte des Teilbaums
        };
      });

      const want = [];
      for (let i = 0; i < items.length; i++) {
        let x = i === 0 ? items[0].x : want[i - 1] + LANE_STEP;
        if (i >= count) {
          // Vorgänger derselben Spur: Karten dürfen sich nicht überlappen,
          // und die Gasse dazwischen muss offen bleiben.
          x = Math.max(x, want[i - count] + items[i - count].right +
            LANE_CORRIDOR - items[i].left);
        }
        want.push(x);
      }

      const laneBottom = [];
      for (let i = 0; i < items.length; i++) {
        const lane = i % count;
        laneBottom[lane] = Math.max(laneBottom[lane] || 0, items[i].bottom);
      }
      const laneTop = [0];
      for (let k = 1; k < count; k++) {
        laneTop[k] = laneTop[k - 1] + laneBottom[k - 1] + LANE_GAP;
      }

      // Ränder sind relativ: der gesetzte Rand eines Knotens verschiebt alle
      // folgenden mit. Deshalb jeweils nur die Differenz zum Vorgänger.
      const laneOf = new Map();
      let shifted = 0;
      for (let i = 0; i < items.length; i++) {
        const lane = i % count;
        const delta = want[i] - items[i].x;
        items[i].el.style.marginLeft = Math.round(delta - shifted) + 'px';
        items[i].el.style.marginTop = Math.round(laneTop[lane]) + 'px';
        shifted = delta;
        laneOf.set(items[i].el, lane);
        printLaneNodes.push(items[i].el);
      }
      rows.set(kidsEl, { kidsEl, laneCount: count, laneOf });
    }

    printLaneRows = rows.size ? rows : null;
    if (!printLaneRows) document.body.classList.remove(PRINT_LANES_CLASS);
  }

  /**
   * Beste Spurenzahl suchen — im bereits aktiven Druckmodus.
   *
   * 1, 2, 3 und 4 Spuren werden aufgebaut und gemessen; genommen wird die
   * Variante mit dem grössten min(PRINT_W / Breite, PRINT_TREE_H / Höhe, 1).
   * PRINT_TREE_H ist die Blatthöhe ohne das Titelband. Die 1
   * gehört dazu, weil ein kleiner Baum ohnehin nie vergrössert wird — bringt
   * eine weitere Spur auf dem Papier nichts mehr, bleibt es beim einfacheren
   * Bild. So entscheidet die Messung: bei einem schmalen, tiefen Baum kommt von
   * selbst eine Spur heraus, bei einem breiten, flachen mehrere.
   * @returns {?{scale,tx,ty,box,laneCount}}
   */
  function printPlan() {
    let best = null;
    for (let count = 1; count <= PRINT_LANES_MAX; count++) {
      applyPrintLanes(count);
      const box = contentBox({ cardsOnly: true });
      if (!box.w || !box.h) continue;
      const score = Math.min(PRINT_W / box.w, PRINT_TREE_H / box.h, 1);
      // Gleichstand geht an die kleinere Spurenzahl: weniger Verschachtelung
      // ist leichter zu lesen und kostet auf dem Blatt nichts.
      if (!best || score > best.score + 0.01) best = { score, laneCount: count };
    }
    if (!best) {
      clearPrintLanes();
      return null;
    }
    applyPrintLanes(best.laneCount);
    const fit = printFit();
    if (!fit) {
      clearPrintLanes();
      return null;
    }
    fit.laneCount = best.laneCount;
    return fit;
  }

  /** Massstab und Verschiebung fürs Blatt — misst im bereits aktiven Druckmodus. */
  function printFit() {
    const box = contentBox({ cardsOnly: true });
    if (!box.w || !box.h) return null;
    // Nie vergrössern: ein kleiner Baum soll nicht aufgeblasen werden.
    const s = Math.min(PRINT_W / box.w, PRINT_TREE_H / box.h, 1);
    return {
      scale: s,
      tx: (PRINT_W - box.w * s) / 2 - box.x * s,
      // Unterhalb des Titelbands zentrieren, nicht auf dem ganzen Blatt.
      ty: PRINT_TITLE_H + (PRINT_TREE_H - box.h * s) / 2 - box.y * s,
      box
    };
  }

  function setPrintMode(on) {
    document.body.classList.toggle(PRINT_MODE_CLASS, on);
    // Umbruch erzwingen, damit direkt danach das kompakte Layout gemessen wird
    void document.body.offsetWidth;
  }

  /** Druckmodus einschalten und den Baum aufs Blatt legen. */
  function beginPrint() {
    if (printState || !canvas || !viewport) return;
    const saved = { tx, ty, scale, timer: null };
    // Auf dem Papier fehlt die Kopfzeile — der Titel gehört trotzdem darauf,
    // sonst weiss man bei einem herumliegenden Blatt nicht, welche Familie das ist.
    if (printTitle) {
      printTitle.textContent =
        (window.App && App.settings && App.settings.appTitle) || 'Stammbaum';
    }
    setPrintMode(true);
    const fit = printPlan();
    if (!fit) {                       // leerer Baum — nichts zu skalieren
      clearPrintLanes();
      setPrintMode(false);
      return;
    }
    printState = saved;
    scale = fit.scale;
    tx = fit.tx;
    ty = fit.ty;
    applyTransform();
    draw();                           // Linien auf das kompakte Layout neu ziehen
    printState.timer = setTimeout(endPrint, PRINT_FALLBACK_MS);
  }

  /** Vorherigen Zustand wiederherstellen — auch wenn der Dialog abgebrochen wird. */
  function endPrint() {
    if (!printState) return;
    const saved = printState;
    printState = null;
    clearTimeout(saved.timer);
    clearPrintLanes();
    setPrintMode(false);
    scale = saved.scale;
    tx = saved.tx;
    ty = saved.ty;
    applyTransform();
    draw();
  }

  async function printTree() {
    if (printState || !canvas || !viewport) return;

    // Probehalber messen: passt der Baum lesbar auf ein Blatt?
    setPrintMode(true);
    const fit = printPlan();
    clearPrintLanes();
    setPrintMode(false);               // ohne zwischenzeitliches Neuzeichnen

    if (!fit) {
      App.toast('Es gibt noch keinen Stammbaum zum Drucken.', 'info');
      return;
    }

    if (printCapMm(fit.scale) < MIN_CAP_MM) {
      const ok = await App.confirm({
        title: 'Sehr grosser Stammbaum',
        message: 'Der Baum ist so breit, dass die Namen auf einer A4-Seite quer ' +
          'nur noch rund ' + printCapMm(fit.scale).toFixed(1).replace('.', ',') +
          ' mm hoch werden — das ist kaum mehr lesbar. Trotzdem drucken?',
        confirmLabel: 'Trotzdem drucken'
      });
      if (!ok) return;
    }

    // Selbst umschalten statt auf beforeprint zu warten: nicht jeder Browser
    // schickt das Ereignis. Der Handler steigt dann wegen printState aus.
    beginPrint();
    window.print();
  }

  function wireGestures() {
    const pointers = new Map();
    let pan = null;
    let pinch = null;
    let moved = 0;

    const local = (ev) => {
      const rect = viewport.getBoundingClientRect();   // Viewport ist nie skaliert
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };

    // Capture-Phase: der Zähler wird auch dann zurückgesetzt, wenn der Druck
    // auf der Steuerleiste beginnt.
    viewport.addEventListener('pointerdown', (ev) => {
      if (ev.button != null && ev.button > 1) return;
      moved = 0;
      if (ev.target.closest('.tree-controls')) return;

      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      // Bewusst kein setPointerCapture: das würde das Klickziel auf den
      // Viewport umbiegen und Klicks auf Karten/Knöpfe verschlucken.
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);

      if (pointers.size === 1) {
        pan = { x: ev.clientX, y: ev.clientY, tx, ty };
        pinch = null;
      } else if (pointers.size === 2) {
        pan = null;
        pinch = pinchState(pointers);
      }
      viewport.classList.add('is-grabbing');
    }, true);

    function onMove(ev) {
      if (!pointers.has(ev.pointerId)) return;
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

      if (pointers.size >= 2 && pinch) {
        const now = pinchState(pointers);
        if (!now.dist || !pinch.dist) return;
        const rect = viewport.getBoundingClientRect();
        const mid = { x: now.mid.x - rect.left, y: now.mid.y - rect.top };
        const next = clampScale(pinch.scale * (now.dist / pinch.dist));
        scale = next;
        tx = mid.x - pinch.world.x * scale;
        ty = mid.y - pinch.world.y * scale;
        moved = DRAG_SLOP + 1;
        applyTransform();
        return;
      }

      if (!pan) return;
      const dx = ev.clientX - pan.x;
      const dy = ev.clientY - pan.y;
      moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
      tx = pan.tx + dx;
      ty = pan.ty + dy;
      applyTransform();
    }

    function end(ev) {
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 1) {
        const only = pointers.values().next().value;
        pan = { x: only.x, y: only.y, tx, ty };
      }
      if (pointers.size === 0) {
        pan = null;
        viewport.classList.remove('is-grabbing');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
      }
    }

    // Nach dem Ziehen darf kein Klick auf einer Karte ausgelöst werden
    viewport.addEventListener('click', (ev) => {
      if (moved > DRAG_SLOP) {
        ev.stopPropagation();
        ev.preventDefault();
        moved = 0;
      }
    }, true);

    viewport.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const p = local(ev);
      const step = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
      zoomAt(p.x, p.y, scale * Math.exp(-step * 0.0016));
    }, { passive: false });

    function pinchState(map) {
      const list = Array.from(map.values()).slice(0, 2);
      const dx = list[1].x - list[0].x;
      const dy = list[1].y - list[0].y;
      const mid = { x: (list[0].x + list[1].x) / 2, y: (list[0].y + list[1].y) / 2 };
      const rect = viewport.getBoundingClientRect();
      return {
        dist: Math.hypot(dx, dy),
        mid,
        scale,
        world: {
          x: (mid.x - rect.left - tx) / scale,
          y: (mid.y - rect.top - ty) / scale
        }
      };
    }
  }

  // ==========================================================================
  // Suche
  // ==========================================================================

  function haystack(person) {
    if (!person) return '';
    return [person.firstName, person.lastName, person.maidenName]
      .filter(Boolean).join(' ').toLowerCase();
  }

  function applyHighlight() {
    const term = (searchTerm || '').trim().toLowerCase();
    let hits = 0;
    for (const entry of cards) {
      const match = term ? haystack(Store.person(entry.id)).includes(term) : false;
      entry.el.classList.toggle('tree-card--match', match);
      if (match) hits++;
    }
    if (!searchStatus) return;
    if (!term) searchStatus.textContent = '';
    else if (hits === 0) searchStatus.textContent = 'keine Treffer';
    else searchStatus.textContent = hits === 1 ? '1 Treffer' : hits + ' Treffer';
  }

  function firstMatch() {
    const term = (searchTerm || '').trim().toLowerCase();
    if (!term) return null;
    return cards.find((c) => haystack(Store.person(c.id)).includes(term)) || null;
  }

  // ==========================================================================
  // Statusauswahl der Partnerschaft
  // Popover direkt an der Pille; auf schmalen Geräten ein Bogen von unten.
  // ==========================================================================

  function openUnionMenu(union, anchor) {
    closeUnionMenu({ keepFocus: true });

    const sheet = window.innerWidth < 560;
    const backdrop = el('div', 'tree-unionmenu-backdrop' +
      (sheet ? ' tree-unionmenu-backdrop--dim' : ''));

    const menu = el('div', 'tree-unionmenu' + (sheet ? ' tree-unionmenu--sheet' : ''));
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', 'Status der Partnerschaft ' + unionWith(union));

    menu.appendChild(el('p', 'tree-unionmenu__title',
      ('Partnerschaft ' + unionWith(union)).trim()));

    const errorEl = el('p', 'field__error tree-unionmenu__error');
    errorEl.setAttribute('role', 'alert');
    errorEl.hidden = true;

    const options = el('div', 'tree-unionmenu__options');
    const optionEls = [];

    const noteId = 'tree-un' + (++fieldSeq);
    const noteField = el('div', 'field tree-unionmenu__note');
    const noteLabel = document.createElement('label');
    noteLabel.htmlFor = noteId;
    noteLabel.textContent = 'Notiz zur Beziehung';
    const noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.id = noteId;
    noteInput.maxLength = 500;
    noteInput.value = union.note || '';
    noteInput.placeholder = 'z.B. zusammen seit 2010';
    noteField.append(noteLabel, noteInput);

    const noteBtn = document.createElement('button');
    noteBtn.type = 'button';
    noteBtn.className = 'btn btn--secondary tree-unionmenu__save';
    noteBtn.textContent = 'Notiz sichern';

    const setBusy = (busy) => {
      for (const b of optionEls) b.disabled = busy;
      noteBtn.disabled = busy;
      noteInput.disabled = busy;
    };

    const send = async (body, message) => {
      errorEl.hidden = true;
      setBusy(true);
      try {
        await API.patch('/api/unions/' + union.id, body);
        await Store.load();          // render() schliesst die Auswahl mit
        closeUnionMenu({ keepFocus: true });
        refocusMark(union.id);
        App.toast(message, 'success');
      } catch (err) {
        errorEl.textContent = (err && err.message) || 'Speichern fehlgeschlagen.';
        errorEl.hidden = false;
        setBusy(false);
      }
    };

    const option = (value, glyph, label) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tree-unionmenu__option';
      const active = Boolean(union.isCurrent) === value;
      if (active) btn.classList.add('is-active');
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(active));

      const g = el('span', 'tree-unionmenu__glyph', glyph);
      g.setAttribute('aria-hidden', 'true');
      const check = el('span', 'tree-unionmenu__check', active ? '✓' : '');
      check.setAttribute('aria-hidden', 'true');
      btn.append(g, el('span', 'tree-unionmenu__label', label), check);

      btn.addEventListener('click', () => {
        // Eine offene Notizänderung geht beim Umstellen nicht verloren
        const body = { isCurrent: value };
        const note = noteInput.value.trim();
        if (note !== (union.note || '')) body.note = note;
        send(body, value
          ? 'Als aktuelle Partnerschaft gespeichert.'
          : 'Als frühere Partnerschaft gespeichert.');
      });

      optionEls.push(btn);
      return btn;
    };

    options.append(
      option(true, '♥', 'Aktuelle Partnerschaft'),
      option(false, '⤫', 'Frühere Partnerschaft')
    );
    options.setAttribute('role', 'radiogroup');
    options.setAttribute('aria-label', 'Status der Partnerschaft');

    noteBtn.addEventListener('click', () => {
      const note = noteInput.value.trim();
      if (note === (union.note || '')) {
        closeUnionMenu();
        return;
      }
      send({ note }, 'Notiz gespeichert.');
    });

    noteInput.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      noteBtn.click();
    });

    menu.append(options, noteField, noteBtn, errorEl);

    // Pfeiltasten zwischen den beiden Optionen, Escape schliesst
    menu.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        closeUnionMenu();
        return;
      }
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      const idx = optionEls.indexOf(document.activeElement);
      if (idx === -1) return;
      ev.preventDefault();
      const next = ev.key === 'ArrowDown' ? idx + 1 : idx - 1;
      const target = optionEls[(next + optionEls.length) % optionEls.length];
      if (target) target.focus();
    });

    // Klick daneben schliesst — und verhindert zugleich, dass der Baum mitzieht
    backdrop.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeUnionMenu();
    });

    document.body.append(backdrop, menu);
    if (!sheet) placeMenu(menu, anchor);

    anchor.setAttribute('aria-expanded', 'true');
    openMenu = { unionId: Number(union.id), backdrop, menu, anchor };
    window.addEventListener('resize', onMenuViewportChange);

    const first = optionEls.find((b) => b.classList.contains('is-active')) || optionEls[0];
    if (first) first.focus();
  }

  function placeMenu(menu, anchor) {
    const rect = anchor.getBoundingClientRect();
    const gap = 8;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(gap, Math.min(left, window.innerWidth - w - gap));
    let top = rect.bottom + gap;
    if (top + h > window.innerHeight - gap) {
      top = Math.max(gap, rect.top - h - gap);
    }
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
  }

  function onMenuViewportChange() {
    closeUnionMenu();
  }

  function closeUnionMenu(opts) {
    if (!openMenu) return;
    const { backdrop, menu, anchor } = openMenu;
    openMenu = null;
    window.removeEventListener('resize', onMenuViewportChange);
    backdrop.remove();
    menu.remove();
    if (anchor && document.contains(anchor)) {
      anchor.setAttribute('aria-expanded', 'false');
      if (!opts || !opts.keepFocus) anchor.focus();
    }
  }

  /** Nach dem Neuaufbau des Baums wieder auf dieselbe Pille fokussieren. */
  function refocusMark(unionId) {
    if (!treeRoot) return;
    const next = treeRoot.querySelector(
      '.tree-mark__btn[data-union-id="' + Number(unionId) + '"]');
    if (next) next.focus();
  }

  // ==========================================================================
  // Dialoge
  // ==========================================================================

  function openChildDialog(union) {
    const form = document.createElement('form');
    form.className = 'stack';
    form.autocomplete = 'off';
    form.noValidate = true;

    const hint = el('p', 'field__hint tree-form__hint');
    hint.textContent = 'Eltern: ' + Store.unionLabel(union);

    const errorEl = el('p', 'field__error');
    errorEl.setAttribute('role', 'alert');
    errorEl.hidden = true;

    form.append(hint, personFieldSet(), errorEl);

    let handle = null;
    const submit = async () => {
      errorEl.hidden = true;
      const data = readPersonFields(form);
      if (!data.firstName) {
        fail(errorEl, form, 'Bitte einen Vornamen angeben.');
        return;
      }
      if (!normalizeDateFields(form, data)) return;
      try {
        const person = await API.post('/api/persons',
          Object.assign({ parentUnionId: union.id }, data));
        await Store.load();
        if (handle) handle.close();
        App.toast(Store.displayName(person) + ' wurde hinzugefügt.', 'success');
        if (person && person.id != null) TreeView.focusPerson(person.id);
      } catch (err) {
        fail(errorEl, form, (err && err.message) || 'Speichern fehlgeschlagen.');
      }
    };

    handle = App.modal({
      title: 'Kind hinzufügen',
      body: form,
      actions: [
        { label: 'Abbrechen', variant: 'secondary' },
        { label: 'Hinzufügen', variant: 'primary', onClick: submit }
      ]
    });

    form.addEventListener('submit', (ev) => { ev.preventDefault(); submit(); });
  }

  function openPartnerDialog(person, side) {
    const form = document.createElement('form');
    form.className = 'stack';
    form.autocomplete = 'off';
    form.noValidate = true;

    const hint = el('p', 'field__hint tree-form__hint');
    hint.textContent = 'Partner:in von ' + Store.displayName(person) +
      ' (Seite: ' + (side === 'left' ? 'links' : 'rechts') + ')';

    const errorEl = el('p', 'field__error');
    errorEl.setAttribute('role', 'alert');
    errorEl.hidden = true;

    const relation = el('div', 'stack--sm tree-form__relation');
    const check = document.createElement('label');
    check.className = 'checkline';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.name = 'isCurrent';
    box.checked = true;
    check.append(box, document.createTextNode('aktuelle Partnerschaft'));

    const noteField = fieldEl({
      name: 'unionNote',
      label: 'Notiz zur Beziehung',
      type: 'text',
      hint: 'z.B. «zusammen seit 2010» oder «getrennt»',
      maxLength: 500
    });
    relation.append(check, noteField);

    form.append(hint, personFieldSet(), relation, errorEl);

    let handle = null;
    const submit = async () => {
      errorEl.hidden = true;
      const data = readPersonFields(form);
      if (!data.firstName) {
        fail(errorEl, form, 'Bitte einen Vornamen angeben.');
        return;
      }
      if (!normalizeDateFields(form, data)) return;
      try {
        const res = await API.post('/api/unions', {
          personId: person.id,
          side,
          isCurrent: box.checked,
          note: (form.elements.unionNote && form.elements.unionNote.value || '').trim(),
          partner: data
        });
        await Store.load();
        if (handle) handle.close();
        const created = res && res.partner;
        App.toast((created ? Store.displayName(created) : 'Partner:in') +
          ' wurde hinzugefügt.', 'success');
        if (created && created.id != null) TreeView.focusPerson(created.id);
      } catch (err) {
        fail(errorEl, form, (err && err.message) || 'Speichern fehlgeschlagen.');
      }
    };

    handle = App.modal({
      title: 'Partner:in hinzufügen',
      body: form,
      actions: [
        { label: 'Abbrechen', variant: 'secondary' },
        { label: 'Hinzufügen', variant: 'primary', onClick: submit }
      ]
    });

    form.addEventListener('submit', (ev) => { ev.preventDefault(); submit(); });
  }

  function fail(errorEl, form, message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    const input = form.elements.firstName;
    if (input) input.focus();
  }

  function personFieldSet() {
    const wrap = el('div', 'stack');

    const grid = el('div', 'field-grid field-grid--2');
    grid.append(
      fieldEl({ name: 'firstName', label: 'Vorname', type: 'text', required: true, maxLength: 60 }),
      fieldEl({ name: 'lastName', label: 'Nachname', type: 'text', maxLength: 500 }),
      fieldEl({
        name: 'birthDate', label: 'Geburtsdatum', type: 'text',
        hint: App.DATE_HINT, placeholder: '01.01.2000', error: true, maxLength: 500
      }),
      // Dezent und optional — nur nötig, wenn jemand Verstorbenes erfasst wird
      fieldEl({
        name: 'deathDate', label: 'Todesdatum', type: 'text',
        hint: App.DATE_HINT, placeholder: '01.01.2000', error: true, maxLength: 500
      }),
      fieldEl({ name: 'phone', label: 'Telefon', type: 'tel', maxLength: 500 }),
      fieldEl({ name: 'email', label: 'E-Mail', type: 'email', maxLength: 500 }),
      fieldEl({ name: 'address', label: 'Adresse', type: 'text', maxLength: 2000 })
    );

    wrap.append(grid, fieldEl({
      name: 'notes', label: 'Notizen', textarea: true, maxLength: 2000
    }));
    return wrap;
  }

  function fieldEl(opts) {
    const id = 'tree-f' + (++fieldSeq);
    const field = el('div', 'field');

    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = opts.label + (opts.required ? ' *' : '');

    const input = document.createElement(opts.textarea ? 'textarea' : 'input');
    input.id = id;
    input.name = opts.name;
    if (!opts.textarea) input.type = opts.type || 'text';
    if (opts.maxLength) input.maxLength = opts.maxLength;
    if (opts.required) input.required = true;
    if (opts.placeholder) input.placeholder = opts.placeholder;

    field.append(label, input);
    const described = [];
    if (opts.hint) {
      const hint = el('p', 'field__hint', opts.hint);
      hint.id = id + '-hint';
      described.push(hint.id);
      field.appendChild(hint);
    }
    if (opts.error) {
      // Feldeigene Meldung — bleibt leer und ausgeblendet, bis etwas schiefgeht
      const err = el('p', 'field__error');
      err.id = id + '-error';
      err.setAttribute('role', 'alert');
      err.hidden = true;
      described.push(err.id);
      field.appendChild(err);
    }
    if (described.length) input.setAttribute('aria-describedby', described.join(' '));
    return field;
  }

  // --- Datumsfelder ---------------------------------------------------------

  const DATE_FIELDS = ['birthDate', 'deathDate'];

  function dateFieldParts(form, name) {
    const input = form.elements[name];
    if (!input) return null;
    const field = input.closest('.field');
    return { input, field, errEl: field ? field.querySelector('.field__error') : null };
  }

  function clearDateErrors(form) {
    for (const name of DATE_FIELDS) {
      const parts = dateFieldParts(form, name);
      if (!parts || !parts.field) continue;
      parts.field.classList.remove('field--invalid');
      if (parts.errEl) {
        parts.errEl.textContent = '';
        parts.errEl.hidden = true;
      }
    }
  }

  /**
   * Rechnet die Datumsfelder von `data` (Schweizer Schreibweise) nach ISO um.
   * Gespeichert wird immer ISO — angezeigt und eingetippt wird TT.MM.JJJJ.
   * Bei ungültiger Eingabe erscheint die Meldung direkt am Feld und es wird
   * nichts abgesendet.
   * @returns {boolean} true, wenn alle Felder umgewandelt werden konnten
   */
  function normalizeDateFields(form, data) {
    clearDateErrors(form);
    let firstBad = null;

    for (const name of DATE_FIELDS) {
      if (!(name in data)) continue;
      const res = App.parseDateInput(data[name]);
      if (res.ok) {
        data[name] = res.value;
        continue;
      }
      const parts = dateFieldParts(form, name);
      if (parts && parts.field) parts.field.classList.add('field--invalid');
      if (parts && parts.errEl) {
        parts.errEl.textContent = res.message;
        parts.errEl.hidden = false;
      }
      if (!firstBad && parts) firstBad = parts.input;
    }

    if (firstBad) {
      firstBad.focus();
      return false;
    }
    return true;
  }

  function readPersonFields(form) {
    const get = (name) => {
      const node = form.elements[name];
      return node ? String(node.value || '').trim() : '';
    };
    return {
      firstName: get('firstName'),
      lastName: get('lastName'),
      birthDate: get('birthDate'),
      deathDate: get('deathDate'),
      address: get('address'),
      phone: get('phone'),
      email: get('email'),
      notes: get('notes')
    };
  }

  // ==========================================================================
  // Helfer
  // ==========================================================================

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  window.TreeView = TreeView;
})();
