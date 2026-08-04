/* Stammbauminator — Fotoalbum mit Personen-Markierung
   Globals: window.PhotoAlbum
   Galerie aller Fotos, Detailansicht mit Markierungen (setzen, verschieben,
   entfernen) und Anlegen neuer Personen direkt aus dem Bild heraus. */
(function () {
  'use strict';

  // --- Konstanten -----------------------------------------------------------

  const DRAG_THRESHOLD = 6;      // px, darunter gilt es als Klick
  const HIGHLIGHT_MS   = 2600;   // Dauer der Hervorhebung via openPhoto()
  const SOLO_ECHO_MS   = 400;    // Nachhall beim Umschalten, siehe togglePersonFocus
  const STAGE_MARGIN   = 10;     // px Luft rund um das Bild

  // Zoom in festen Hunderterschritten: 100 %, 200 %, 300 %, 400 %.
  //
  // Bewusst NICHT auf die native Auflösung gedeckelt. Das war die erste
  // Fassung, führte aber zu willkürlich wirkenden Obergrenzen: Auf einem
  // grossen Bildschirm füllt ein Foto die Höhe schon fast aus, und von der
  // nativen Auflösung blieb ein einziger Schritt auf 121 % oder 144 % übrig.
  // Über die native Auflösung hinaus wird das Bild zwar weich — ein
  // vergrössertes Gesicht aus einem Gruppenbild aus der Distanz ist trotzdem
  // besser zu erkennen als ein winziges scharfes.
  const ZOOM_MAX     = 4;        // 400 %
  const ZOOM_DOUBLE  = 2;        // Stufe bei Doppelklick/Doppeltipp
  const DOUBLE_MS    = 320;      // Zeitfenster für Doppelklick
  const DOUBLE_SLOP  = 24;       // px, in denen zwei Klicks als Doppelklick zählen
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), ' +
                    'select:not([disabled]), textarea:not([disabled]), ' +
                    '[tabindex]:not([tabindex="-1"])';

  const HINT_ZOOM    = ' Mit ＋ / －, Mausrad, Doppelklick oder zwei Fingern ' +
                       'zoomst du ins Bild — Punkte und Namen bleiben gleich gross. ' +
                       'Gezoomt verschiebt Ziehen den Ausschnitt.';
  const HINT_DEFAULT = 'Tippe ins Bild, um jemanden zu markieren. ' +
                       'Marker lassen sich verschieben.' + HINT_ZOOM;
  const HINT_HIDDEN  = 'Markierungen sind ausgeblendet — fahre über eine Stelle ' +
                       'im Bild, um sie zu sehen. Verschieben geht so nicht; ' +
                       'Tippen ins Bild markiert weiterhin jemanden.' + HINT_ZOOM;
  const HINT_EDIT    = 'Bearbeiten ist an: Markierungen lassen sich ziehen und ' +
                       'mit ✕ entfernen. Ein Tipp auf eine Markierung öffnet die ' +
                       'Person erst wieder, wenn du das Bearbeiten beendest. ' +
                       'Tippen ins Bild markiert weiterhin jemanden.' + HINT_ZOOM;

  // --- Zustand --------------------------------------------------------------

  const state = {
    root: null,
    gridHost: null,
    countHost: null,
    photos: [],
    status: 'idle',        // 'idle' | 'loading' | 'ready' | 'error'
    errorMessage: '',
    // Auf schmalen Geräten sind die Namensfahnen zu dicht — dort startet die
    // Ansicht mit ausgeblendeten Namen, die Namensliste steht unter dem Bild.
    showNames: !window.matchMedia || window.matchMedia('(min-width: 768px)').matches,
    pendingOpen: null      // { photoId, personId } solange noch geladen wird
  };

  let viewer = null;       // siehe openViewer()

  // --- kleine Helfer --------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function clamp01(value) {
    return Math.min(1, Math.max(0, value));
  }

  function personName(personId) {
    const person = Store.person(personId);
    return person ? Store.displayName(person) : 'Unbekannte Person';
  }

  /** Fotos ohne Markierungen liefern trotzdem ein Array. */
  function tagsOf(photo) {
    return (photo && Array.isArray(photo.tags)) ? photo.tags : [];
  }

  function photoIndex(photoId) {
    return state.photos.findIndex((p) => Number(p.id) === Number(photoId));
  }

  function altTextFor(photo) {
    const names = tagsOf(photo).map((t) => personName(t.personId));
    const base = photo.title ? 'Foto: ' + photo.title : 'Familienfoto';
    if (!names.length) return base;
    return base + ' — markiert: ' + names.join(', ');
  }

  /** true, wenn gerade ein App-Modal (z.B. App.confirm) offen ist. */
  function modalOpen() {
    return Boolean(document.querySelector('#modals .modal-backdrop'));
  }

  function apiMessage(err) {
    return (err && err.message) ? err.message : 'Unbekannter Fehler.';
  }

  /**
   * Die aktuelle Fotoliste ans Portrait-Modul durchreichen.
   *
   * Portrait hält einen eigenen Zwischenspeicher. Ohne diesen Aufruf bleibt der
   * Ausschnitt-Index veraltet und eine eben gesetzte Markierung erzeugt weder im
   * Quiz noch im Personen-Panel ein Bild, bis die Seite neu geladen wird.
   * `setPhotos` baut den Index sofort neu auf — kein zusätzlicher Request.
   */
  function syncPortrait() {
    if (window.Portrait && typeof Portrait.setPhotos === 'function') {
      Portrait.setPhotos(state.photos);
    }
  }

  // --- Laden ----------------------------------------------------------------

  async function loadPhotos(options) {
    const silent = Boolean(options && options.silent);
    if (!silent) {
      state.status = 'loading';
      renderGallery();
    }
    try {
      const list = await API.get('/api/photos');
      state.photos = Array.isArray(list) ? list : [];
      state.status = 'ready';
      state.errorMessage = '';
      // Deckt alle Wege ab: Markierung setzen, verschieben, löschen,
      // neue Person anlegen, Tab-Wechsel, Sichtbarkeitswechsel.
      syncPortrait();
    } catch (err) {
      state.status = state.photos.length ? 'ready' : 'error';
      state.errorMessage = apiMessage(err);
      if (silent) return;   // im Hintergrund nicht mit Fehlern nerven
    }
    renderGallery();
    syncViewerAfterReload();
    flushPendingOpen();
  }

  function flushPendingOpen() {
    const pending = state.pendingOpen;
    if (!pending || state.status !== 'ready') return;
    state.pendingOpen = null;
    const idx = photoIndex(pending.photoId);
    if (idx >= 0) openViewer(idx, pending.personId);
    else App.toast('Dieses Foto gibt es nicht mehr.', 'info');
  }

  /** Nach einem Reload das offene Foto aktualisieren (falls noch vorhanden). */
  function syncViewerAfterReload() {
    if (!viewer) return;
    const idx = photoIndex(viewer.photoId);
    if (idx < 0) { closeViewer(); return; }
    viewer.index = idx;
    if (!viewer.popover) renderViewerContent();
  }

  // --- Galerie --------------------------------------------------------------

  function mount(root) {
    state.root = root;
    root.textContent = '';

    const page = el('div', 'page pa-page');

    const head = el('div', 'pa-head');
    const titleWrap = el('div');
    const h1 = el('h1', null, 'Fotoalbum');
    const sub = el('p', 'muted small mb-0',
      'Tippe auf ein Foto, um es gross zu sehen und Personen zu markieren.');
    titleWrap.append(h1, sub);
    state.countHost = el('span', 'pill pill--sun');
    state.countHost.hidden = true;
    head.append(titleWrap, el('span', 'spacer'), state.countHost);

    state.gridHost = el('div', 'pa-gallery');

    page.append(head, state.gridHost);
    root.appendChild(page);

    Store.subscribe(onStoreChange);
    document.addEventListener('visibilitychange', onVisibilityChange);

    loadPhotos();
  }

  function onStoreChange() {
    // Neue/geänderte Personen → Namen in Galerie und Detailansicht auffrischen
    renderGallery();
    if (viewer && !viewer.popover) renderViewerContent();
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible' && state.status !== 'loading') {
      loadPhotos({ silent: true });
    }
  }

  function renderGallery() {
    const host = state.gridHost;
    if (!host) return;
    host.textContent = '';

    if (state.countHost) {
      const n = state.photos.length;
      state.countHost.hidden = state.status !== 'ready' || n === 0;
      state.countHost.textContent = n === 1 ? '1 Foto' : n + ' Fotos';
    }

    if (state.status === 'loading' && !state.photos.length) {
      const grid = el('div', 'pa-grid');
      for (let i = 0; i < 6; i++) grid.appendChild(el('div', 'skeleton pa-skeleton'));
      host.appendChild(grid);
      return;
    }

    if (state.status === 'error') {
      const box = el('div', 'card');
      const empty = el('div', 'empty');
      empty.appendChild(el('div', 'empty__icon', '⚠️'));
      empty.appendChild(el('p', null, 'Die Fotos konnten nicht geladen werden.'));
      empty.appendChild(el('p', 'small faint', state.errorMessage));
      const retry = el('button', 'btn btn--secondary', 'Nochmals versuchen');
      retry.type = 'button';
      retry.addEventListener('click', () => loadPhotos());
      empty.appendChild(retry);
      box.appendChild(empty);
      host.appendChild(box);
      return;
    }

    if (!state.photos.length) {
      const box = el('div', 'card');
      const empty = el('div', 'empty');
      empty.appendChild(el('div', 'empty__icon', '📷'));
      const h = el('h3', null, 'Noch keine Fotos da');
      const p1 = el('p', null,
        'Sobald Bilder hochgeladen sind, erscheinen sie hier — und ihr könnt ' +
        'Personen direkt im Bild markieren.');
      const p2 = el('p', 'small faint mb-0',
        'Fotos werden im Admin-Bereich hochgeladen.');
      empty.append(h, p1, p2);

      const goAdmin = el('button', 'btn btn--sun', 'Zum Admin-Bereich');
      goAdmin.type = 'button';
      goAdmin.addEventListener('click', () => App.showTab('admin'));
      empty.appendChild(goAdmin);

      box.appendChild(empty);
      host.appendChild(box);
      return;
    }

    const grid = el('div', 'pa-grid');
    state.photos.forEach((photo, index) => grid.appendChild(photoCard(photo, index)));
    host.appendChild(grid);
  }

  function photoCard(photo, index) {
    const card = el('button', 'card card--flush pa-card');
    card.type = 'button';

    const figure = el('div', 'pa-card__figure');
    const img = el('img', 'pa-card__img');
    img.src = photo.url || '';
    img.alt = altTextFor(photo);
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => figure.classList.add('is-broken'));
    figure.appendChild(img);

    const body = el('div', 'pa-card__body');
    const title = el('div', 'pa-card__title', photo.title || 'Ohne Titel');
    const meta = el('div', 'pa-card__meta');

    const date = App.formatDate(photo.takenAt);
    if (date) meta.appendChild(el('span', 'small muted', date));

    const count = tagsOf(photo).length;
    const pill = el('span', 'pill ' + (count ? 'pill--lav' : ''),
      count === 0 ? 'Noch niemand markiert'
        : count === 1 ? '1 Person markiert'
          : count + ' Personen markiert');
    meta.appendChild(pill);

    body.append(title, meta);
    card.append(figure, body);
    card.addEventListener('click', () => openViewer(index));
    return card;
  }

  // --- Detailansicht --------------------------------------------------------

  function openViewer(index, highlightPersonId) {
    if (viewer) { showPhotoAt(index, highlightPersonId); return; }
    if (!state.photos.length) return;

    const root = el('div', 'pa-viewer');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Foto-Detailansicht');

    // Kopfleiste
    const bar = el('div', 'pa-bar');
    const closeBtn = el('button', 'btn btn--ghost btn--icon pa-bar__close', '✕');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Detailansicht schliessen');
    closeBtn.addEventListener('click', closeViewer);

    const meta = el('div', 'pa-bar__meta');
    const titleEl = el('div', 'pa-bar__title');
    const dateEl = el('div', 'pa-bar__date small');
    meta.append(titleEl, dateEl);

    const counterEl = el('span', 'pill pa-bar__counter');

    const namesBtn = el('button', 'btn btn--secondary btn--sm pa-bar__names');
    namesBtn.type = 'button';
    namesBtn.addEventListener('click', toggleNames);

    // Bearbeiten-Modus: Aus bleibt der Tipp auf eine Markierung das Oeffnen der
    // Person — die haeufigste Handlung, ein Tipp. An werden alle Markierungen
    // beweglich und zeigen ihr ✕. Bewusst ein sichtbarer Schalter statt Hover
    // oder Langdruck: Hover gibt es auf Touch nicht, und einen Langdruck findet
    // niemand von selbst.
    const editBtn = el('button', 'btn btn--secondary btn--sm pa-bar__edit');
    editBtn.type = 'button';
    editBtn.addEventListener('click', toggleEditing);

    bar.append(closeBtn, meta, el('span', 'spacer'), counterEl, editBtn, namesBtn);

    // Bühne
    const stage = el('div', 'pa-stage');
    const prevBtn = navButton('prev', '‹', 'Vorheriges Foto');
    const nextBtn = navButton('next', '›', 'Nächstes Foto');

    const frame = el('div', 'pa-frame');
    const img = el('img', 'pa-frame__img');
    frame.appendChild(img);

    // Zoom-Bedienung — Trefferflächen 44×44 px
    const zoomWrap = el('div', 'pa-zoom');
    zoomWrap.setAttribute('role', 'group');
    zoomWrap.setAttribute('aria-label', 'Zoom');
    const zoomIn = zoomButton('＋', 'Vergrössern');
    const zoomOut = zoomButton('－', 'Verkleinern');
    const zoomReset = zoomButton('⟲', 'Ansicht zurücksetzen');
    const zoomLevel = el('span', 'pa-zoom__level', '100 %');
    zoomLevel.setAttribute('aria-hidden', 'true');
    zoomIn.addEventListener('click', () => zoomByStep(1));
    zoomOut.addEventListener('click', () => zoomByStep(-1));
    zoomReset.addEventListener('click', () => resetZoom(true));
    zoomWrap.append(zoomIn, zoomLevel, zoomOut, zoomReset);

    stage.append(prevBtn, frame, nextBtn, zoomWrap);

    // Fusszeile
    const foot = el('div', 'pa-foot');
    const hint = el('p', 'pa-foot__hint small muted mb-0', HINT_DEFAULT);
    const people = el('div', 'pa-people');
    foot.append(people, hint);

    root.append(bar, stage, foot);

    viewer = {
      root, bar, titleEl, dateEl, counterEl, namesBtn, editBtn,
      stage, frame, img, prevBtn, nextBtn, people, hint,
      zoomWrap, zoomIn, zoomOut, zoomReset, zoomLevel,
      index: 0, photoId: null, ratio: 3 / 2,
      markers: new Map(), popover: null, draft: null,
      highlightTimer: 0, prevFocus: document.activeElement,
      suppressFrameClick: false,
      // Hervorhebung einer einzelnen Person (Klick auf Namenspille/Marker):
      // nur deren Markierung bleibt sichtbar, das Detailpanel liegt darüber.
      soloPersonId: null, panelWatch: null, lastSolo: null,
      // Zoom: fitW/fitH = eingepasste Grösse (Stufe 1), zoom = Faktor darauf,
      // panX/panY = Verschiebung des Rahmens in px (nur translate, nie scale).
      fitW: 0, fitH: 0, zoom: 1, maxZoom: 1, panX: 0, panY: 0,
      // Bearbeiten-Modus. Bewusst nur in der Ansicht und nicht in der
      // Datenbank: Das ist ein Schutz vor dem Verrutschen, kein Datenfeld —
      // nach dem Schliessen ist wieder alles fixiert.
      editing: false,
      pointers: new Map(), pan: null, pinch: null, lastClick: null
    };

    img.addEventListener('load', () => {
      if (!viewer) return;
      if (img.naturalWidth && img.naturalHeight) {
        viewer.ratio = img.naturalWidth / img.naturalHeight;
      }
      frame.classList.remove('is-loading', 'is-broken');
      layoutFrame();
    });
    img.addEventListener('error', () => {
      if (!viewer) return;
      frame.classList.remove('is-loading');
      frame.classList.add('is-broken');
    });

    frame.addEventListener('click', onFrameClick);
    frame.addEventListener('pointerdown', onFramePointerDown);
    frame.addEventListener('pointermove', onFramePointerMove);
    frame.addEventListener('pointerup', onFramePointerUp);
    frame.addEventListener('pointercancel', onFramePointerUp);
    stage.addEventListener('wheel', onStageWheel, { passive: false });

    document.body.appendChild(root);
    document.body.classList.add('pa-lock');

    viewer.keyHandler = onViewerKeydown;
    document.addEventListener('keydown', viewer.keyHandler, true);

    if (typeof ResizeObserver === 'function') {
      viewer.ro = new ResizeObserver(() => layoutFrame());
      viewer.ro.observe(stage);
    }
    viewer.resizeHandler = () => {
      layoutFrame();
      // Beim Drehen wechselt die Leiste zwischen Lang- und Kurzform.
      updateNamesButton();
      updateEditButton();
    };
    window.addEventListener('resize', viewer.resizeHandler);
    window.addEventListener('orientationchange', viewer.resizeHandler);

    showPhotoAt(index, highlightPersonId);
    setTimeout(() => closeBtn.focus(), 60);
  }

  /** Wie im Stammbaum: Icon-Knopf aus dem Design-System, 44×44 px Trefferfläche. */
  function zoomButton(glyph, label) {
    const btn = el('button', 'btn btn--secondary btn--icon pa-zoom__btn');
    btn.type = 'button';
    btn.title = label;
    const icon = el('span', 'pa-zoom__icon', glyph);
    icon.setAttribute('aria-hidden', 'true');
    btn.append(icon, el('span', 'sr-only', label));
    return btn;
  }

  function navButton(kind, glyph, label) {
    const btn = el('button', 'pa-nav pa-nav--' + kind, glyph);
    btn.type = 'button';
    btn.setAttribute('aria-label', label);
    btn.addEventListener('click', () => step(kind === 'prev' ? -1 : 1));
    return btn;
  }

  function closeViewer() {
    if (!viewer) return;
    closePopover();
    clearSolo();          // Hervorhebung nie über die Detailansicht hinaus halten
    document.removeEventListener('keydown', viewer.keyHandler, true);
    window.removeEventListener('resize', viewer.resizeHandler);
    window.removeEventListener('orientationchange', viewer.resizeHandler);
    if (viewer.ro) viewer.ro.disconnect();
    if (viewer.highlightTimer) clearTimeout(viewer.highlightTimer);
    viewer.root.remove();
    document.body.classList.remove('pa-lock');
    const prev = viewer.prevFocus;
    viewer = null;
    if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus();
  }

  function step(delta) {
    if (!viewer || state.photos.length < 2) return;
    const next = (viewer.index + delta + state.photos.length) % state.photos.length;
    showPhotoAt(next);
  }

  function showPhotoAt(index, highlightPersonId) {
    if (!viewer) return;
    const total = state.photos.length;
    if (!total) { closeViewer(); return; }
    viewer.index = Math.min(Math.max(0, index), total - 1);
    const photo = state.photos[viewer.index];
    viewer.photoId = photo.id;
    viewer.ratio = (photo.width > 0 && photo.height > 0)
      ? photo.width / photo.height
      : viewer.ratio;
    closePopover();
    // Weder Zoomstufe noch Hervorhebung dürfen von einem Foto aufs nächste
    // überschwappen.
    clearSolo();
    clearGestures();
    viewer.zoom = 1;
    viewer.panX = 0;
    viewer.panY = 0;
    viewer.frame.classList.add('is-loading');
    viewer.img.src = photo.url || '';
    viewer.img.alt = altTextFor(photo);
    renderViewerContent();
    layoutFrame();
    if (highlightPersonId != null) highlightPerson(highlightPersonId);
  }

  function currentPhoto() {
    return viewer ? state.photos[viewer.index] : null;
  }

  /** Kopfzeile, Marker und Namensliste neu aufbauen. */
  function renderViewerContent() {
    if (!viewer) return;
    const photo = currentPhoto();
    if (!photo) return;

    viewer.titleEl.textContent = photo.title || 'Ohne Titel';
    const date = App.formatDate(photo.takenAt);
    viewer.dateEl.textContent = date || '';
    viewer.dateEl.hidden = !date;
    viewer.counterEl.textContent = (viewer.index + 1) + ' von ' + state.photos.length;
    const many = state.photos.length > 1;
    viewer.prevBtn.hidden = !many;
    viewer.nextBtn.hidden = !many;
    updateNamesButton();
    updateEditButton();

    renderMarkers();
    renderPeopleList();
    // Marker und Pillen sind neu gebaut — eine laufende Hervorhebung wieder
    // anlegen (bzw. verwerfen, wenn es die Markierung nicht mehr gibt).
    applySolo();
  }

  /**
   * Auf einem Handy stehen jetzt zwei Knoepfe neben Titel und Datum — die
   * langen Beschriftungen passen dort nicht mehr. Bewusst ueber matchMedia
   * statt zwei `span` mit CSS-Umschaltung: die Knoepfe tragen ohnehin schon
   * `aria-pressed`, und ein zweites verstecktes Label liest der Screenreader
   * sonst mit vor.
   */
  function schmaleLeiste() {
    return Boolean(window.matchMedia && window.matchMedia('(max-width: 639px)').matches);
  }

  function updateNamesButton() {
    if (!viewer) return;
    // Der Knopf schaltet die ganze Markierungsebene (Punkte und Namensschilder),
    // darum «Markierungen» statt «Namen».
    const kurz = schmaleLeiste();
    viewer.namesBtn.textContent = state.showNames
      ? (kurz ? 'Ausblenden' : 'Markierungen ausblenden')
      : (kurz ? 'Einblenden' : 'Markierungen einblenden');
    // Der Kurztext allein sagt nicht, worum es geht — der Titel schon.
    viewer.namesBtn.title = state.showNames
      ? 'Markierungen ausblenden'
      : 'Markierungen einblenden';
    viewer.namesBtn.setAttribute('aria-pressed', String(state.showNames));
    viewer.frame.classList.toggle('pa-frame--no-names', !state.showNames);
    // Im Bearbeiten-Modus gehört der Hinweis updateEditButton().
    if (!viewer.editing) {
      viewer.hint.textContent = state.showNames ? HINT_DEFAULT : HINT_HIDDEN;
    }
  }

  function toggleNames() {
    // Der Knopf ist eine Aussage über die ganze Ebene — eine laufende
    // Einzel-Hervorhebung endet damit, sonst überlagern sich zwei Zustände.
    clearSolo();
    // Ausblenden beendet auch das Bearbeiten: ✕-Knöpfe an unsichtbaren
    // Markierungen wären nur verwirrend.
    if (state.showNames) setEditing(false);
    state.showNames = !state.showNames;
    updateNamesButton();
  }

  function updateEditButton() {
    if (!viewer) return;
    const an = viewer.editing;
    const kurz = schmaleLeiste();
    viewer.editBtn.textContent = an
      ? (kurz ? 'Fertig' : 'Bearbeiten beenden')
      : (kurz ? 'Bearbeiten' : 'Markierungen bearbeiten');
    viewer.editBtn.title = an ? 'Bearbeiten beenden' : 'Markierungen bearbeiten';
    viewer.editBtn.setAttribute('aria-pressed', String(an));
    viewer.frame.classList.toggle('pa-frame--editing', an);
    viewer.hint.textContent = an
      ? HINT_EDIT
      : (state.showNames ? HINT_DEFAULT : HINT_HIDDEN);
  }

  function toggleEditing() {
    setEditing(!viewer || !viewer.editing);
  }

  function setEditing(an) {
    if (!viewer || viewer.editing === Boolean(an)) return;
    viewer.editing = Boolean(an);
    // Beim Umschalten darf kein Zustand aus dem anderen Modus liegen bleiben:
    // die Hervorhebung samt Personen-Panel gehört zum Ansehen, nicht zum
    // Bearbeiten.
    clearSolo();
    closePopover();
    // Bearbeiten bei ausgeblendeten Markierungen ergibt keinen Sinn — der
    // Punkt wäre unsichtbar und laut markerLocked() ohnehin unbeweglich.
    if (viewer.editing && !state.showNames) {
      state.showNames = true;
      updateNamesButton();
    }
    updateEditButton();
    // Die Beschriftungen der Punkte sagen im Bearbeiten-Modus etwas anderes.
    for (const marker of viewer.frame.querySelectorAll('.pa-marker[data-tag-id]')) {
      syncMarkerLabel(marker);
    }
  }

  // --- Einzelne Person hervorheben ------------------------------------------
  /* Klick auf eine Namenspille (oder auf einen Marker): Nur die Markierung
     dieser Person bleibt sichtbar, das Personen-Panel geht darüber auf. Die
     Fotoansicht bleibt offen — die Stapelung regelt photos.css. */

  function personPanelNode() {
    return document.querySelector('#person-panel .panel');
  }

  /** person.js blendet Panel und Hintergrund über `style.display` ein und aus. */
  function personPanelOpen() {
    const node = personPanelNode();
    return Boolean(node) && node.style.display !== 'none';
  }

  function hasMarkerForPerson(personId) {
    if (!viewer) return false;
    for (const marker of viewer.markers.values()) {
      if (Number(marker.dataset.personId) === Number(personId)) return true;
    }
    return false;
  }

  /** Klassen an Rahmen, Markern und Pillen an `viewer.soloPersonId` angleichen. */
  function applySolo() {
    if (!viewer) return;
    // Ist die Markierung inzwischen weg (gelöscht, anderes Foto), fällt die
    // Hervorhebung weg — sonst bliebe kein einziger Marker sichtbar.
    if (viewer.soloPersonId != null && !hasMarkerForPerson(viewer.soloPersonId)) {
      viewer.soloPersonId = null;
      stopPanelWatch();
    }
    const id = viewer.soloPersonId;
    viewer.frame.classList.toggle('pa-frame--solo', id != null);
    for (const marker of viewer.markers.values()) {
      marker.classList.toggle('is-solo',
        id != null && Number(marker.dataset.personId) === Number(id));
    }
    for (const pill of viewer.people.querySelectorAll('.pa-person')) {
      const on = id != null && Number(pill.dataset.personId) === Number(id);
      pill.classList.toggle('is-solo', on);
      pill.setAttribute('aria-pressed', String(on));
    }
  }

  /**
   * @param {boolean} [remember]  Nur beim Schliessen des Panels: kurz merken,
   *                              welche Person es war (siehe togglePersonFocus).
   */
  function clearSolo(remember) {
    if (!viewer) return;
    stopPanelWatch();
    if (viewer.soloPersonId == null) return;
    viewer.lastSolo = remember ? { id: viewer.soloPersonId, t: Date.now() } : null;
    viewer.soloPersonId = null;
    applySolo();
  }

  /* Das Panel meldet sein Schliessen nicht zurück. Es wird aber ausnahmslos
     über `style.display` ein- und ausgeblendet — ein MutationObserver auf dem
     Mountpunkt bemerkt darum jeden Weg (✕, Escape, Klick daneben, Wischen,
     gelöschte Person) genau einmal, ohne Abfrageschleife und ohne dass die
     Hervorhebung bis zum nächsten Zeigerereignis stehen bleibt. */
  function startPanelWatch() {
    if (!viewer || viewer.panelWatch) return;
    const host = document.getElementById('person-panel');
    if (!host || typeof MutationObserver !== 'function') return;
    viewer.panelWatch = new MutationObserver(() => {
      if (!viewer || viewer.soloPersonId == null) return;
      if (!personPanelOpen()) clearSolo(true);
    });
    viewer.panelWatch.observe(host, {
      subtree: true, attributes: true, attributeFilter: ['style']
    });
  }

  function stopPanelWatch() {
    if (viewer && viewer.panelWatch) {
      viewer.panelWatch.disconnect();
      viewer.panelWatch = null;
    }
  }

  /**
   * Umschalten auf derselben Person: Hervorhebung und Panel gehen weg.
   *
   * Der durchsichtige Panel-Hintergrund schliesst das Panel schon beim Drücken
   * (mousedown); der zugehörige Klick trifft danach die Pille darunter. Ohne
   * das kurze Gedächtnis aus `clearSolo(true)` würde dieser zweite Klick sofort
   * wieder öffnen, statt umzuschalten.
   */
  function togglePersonFocus(personId) {
    if (!viewer) return;
    const id = Number(personId);
    const echo = viewer.lastSolo;
    const justCleared = Boolean(echo) && Number(echo.id) === id &&
                        (Date.now() - echo.t) < SOLO_ECHO_MS;
    if ((viewer.soloPersonId != null && Number(viewer.soloPersonId) === id) || justCleared) {
      viewer.lastSolo = null;
      clearSolo();                       // zweiter Klick → zurück zum Normalzustand
      if (window.PersonPanel && typeof PersonPanel.close === 'function') {
        PersonPanel.close();
      }
      return;
    }
    viewer.lastSolo = null;
    viewer.soloPersonId = id;
    applySolo();
    if (viewer.soloPersonId == null) return;   // keine Markierung zu dieser Person
    if (window.PersonPanel && typeof PersonPanel.open === 'function') {
      PersonPanel.open(id);
      startPanelWatch();
      if (!personPanelOpen()) clearSolo();     // Person nicht (mehr) im Stammbaum
    } else {
      App.toast(personName(id), 'info');
    }
  }

  // --- Marker ---------------------------------------------------------------

  function renderMarkers() {
    if (!viewer) return;
    for (const node of viewer.frame.querySelectorAll('.pa-marker:not(.pa-marker--draft)')) {
      node.remove();
    }
    viewer.markers.clear();

    const photo = currentPhoto();
    if (!photo) return;

    for (const tag of tagsOf(photo)) {
      const marker = buildMarker(tag);
      viewer.markers.set(Number(tag.id), marker);
      viewer.frame.appendChild(marker);
    }
  }

  function buildMarker(tag) {
    const name = personName(tag.personId);

    const marker = el('div', 'pa-marker');
    marker.dataset.tagId = String(tag.id);
    marker.dataset.personId = String(tag.personId);
    positionNode(marker, tag.x, tag.y);

    const dot = el('button', 'pa-marker__dot');
    dot.type = 'button';

    const label = el('button', 'pa-marker__name');
    label.type = 'button';
    label.textContent = name;

    const del = el('button', 'pa-marker__del', '✕');
    del.type = 'button';
    del.setAttribute('aria-label', 'Markierung von ' + name + ' entfernen');
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeTag(tag);
    });

    marker.append(dot, label, del);
    // Sitzt die Markierung ganz oben, wuerde das ✕ darueber aus dem Rahmen
    // ragen — `.pa-stage` schneidet ab. Dann wandert es neben den Punkt.
    marker.classList.toggle('pa-marker--edge-top', clamp01(tag.y) < 0.12);
    syncMarkerLabel(marker);

    const openPerson = (ev) => {
      ev.stopPropagation();
      if (marker.dataset.suppressClick === '1') {
        delete marker.dataset.suppressClick;
        return;
      }
      // Im Bearbeiten-Modus gehoert der Tipp dem Verschieben, nicht der Person.
      if (viewer && viewer.editing) return;
      togglePersonFocus(tag.personId);
    };
    // Der Punkt ist im ausgeblendeten Zustand unsichtbar — dort gehört sein
    // Klick dem Bild (neue Markierung / Ansicht verschieben), nicht der Person.
    dot.addEventListener('click', (ev) => {
      if (markerLocked(marker)) return;
      openPerson(ev);
    });
    label.addEventListener('click', openPerson);

    attachDrag(marker, dot, tag);
    return marker;
  }

  /** Die Beschriftung des Punktes haengt am Bearbeiten-Modus. */
  function syncMarkerLabel(marker) {
    const dot = marker.querySelector('.pa-marker__dot');
    const label = marker.querySelector('.pa-marker__name');
    if (!dot) return;
    const name = (label && label.textContent) || 'Person';
    dot.setAttribute('aria-label', (viewer && viewer.editing)
      ? name + ' — markiert. Ziehen zum Verschieben.'
      : name + ' — markiert. Antippen zeigt die Person.');
  }

  function positionNode(node, x, y) {
    node.style.left = (clamp01(x) * 100) + '%';
    node.style.top = (clamp01(y) * 100) + '%';
  }

  /**
   * Ist diese Markierung beweglich? Nur im Bearbeiten-Modus — sonst verrutschte
   * sie beim Zoomen oder Verschieben der Ansicht. Ein frisch gesetzter Entwurf
   * haengt ohnehin am Zeiger.
   */
  function markerUnlocked(marker) {
    if (!viewer || !marker) return false;
    if (marker.classList.contains('pa-marker--draft')) return true;
    return viewer.editing;
  }

  /**
   * Eine Markierung ist gesperrt, solange sie unsichtbar ist: ausgeblendete
   * Markierungen (Umschalter in der Kopfleiste) lassen sich nicht verschieben.
   * Sonst verrutschen sie beim Verschieben der Ansicht, ohne dass man den
   * Schaden sieht. Die hervorgehobene Markierung bleibt sichtbar und beweglich.
   */
  function markerLocked(marker) {
    if (!marker || marker.classList.contains('pa-marker--draft')) return false;
    return !state.showNames && !marker.classList.contains('is-solo');
  }

  /**
   * true, wenn das Zeigerereignis NICHT als Ereignis auf dem Bild gelten darf.
   * Gesperrte Markierungen sind durchlässig — nur ihre sichtbaren Bedienteile
   * (Namensschild, ✕) behalten dann ihre eigene Funktion.
   */
  function blocksFrameGesture(ev) {
    if (!ev.target.closest) return false;
    if (ev.target.closest('.pa-popover')) return true;
    const marker = ev.target.closest('.pa-marker');
    if (!marker) return false;
    if (!markerLocked(marker)) return true;
    return Boolean(ev.target.closest('.pa-marker__name, .pa-marker__del'));
  }

  /** Maus- und Touch-Ziehen eines bestehenden Markers. */
  function attachDrag(marker, handle, tag) {
    let pointerId = null;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let pos = { x: tag.x, y: tag.y };

    handle.addEventListener('pointerdown', (ev) => {
      if (ev.button != null && ev.button > 0) return;   // Rechtsklick → contextmenu
      // Ausgeblendet: kein Verschieben. Das Ereignis steigt zum Rahmen auf und
      // wird dort wie ein Druck aufs Bild behandelt.
      if (markerLocked(marker)) return;
      // Ausserhalb des Bearbeiten-Modus bleibt der Marker liegen; der Tipp
      // gehört dann der Person.
      if (!markerUnlocked(marker)) return;
      pointerId = ev.pointerId;
      moved = false;
      startX = ev.clientX;
      startY = ev.clientY;
      pos = { x: tag.x, y: tag.y };
      try { handle.setPointerCapture(pointerId); } catch (err) { /* egal */ }
      marker.classList.add('is-dragging');
      closePopover();
    });

    handle.addEventListener('pointermove', (ev) => {
      if (pointerId === null || ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      moved = true;
      ev.preventDefault();
      const rect = viewer.frame.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      pos = {
        x: clamp01((ev.clientX - rect.left) / rect.width),
        y: clamp01((ev.clientY - rect.top) / rect.height)
      };
      positionNode(marker, pos.x, pos.y);
    });

    const finish = async (ev) => {
      if (pointerId === null || (ev && ev.pointerId !== pointerId)) return;
      pointerId = null;
      marker.classList.remove('is-dragging');
      if (!moved) return;
      marker.dataset.suppressClick = '1';
      const before = { x: tag.x, y: tag.y };
      tag.x = pos.x;
      tag.y = pos.y;
      try {
        await API.patch('/api/tags/' + tag.id, { x: pos.x, y: pos.y });
      } catch (err) {
        tag.x = before.x;
        tag.y = before.y;
        positionNode(marker, before.x, before.y);
        App.toast('Markierung konnte nicht verschoben werden: ' + apiMessage(err), 'error');
      }
    };

    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', (ev) => {
      if (pointerId === null || ev.pointerId !== pointerId) return;
      pointerId = null;
      marker.classList.remove('is-dragging');
      positionNode(marker, tag.x, tag.y);
    });
  }

  async function removeTag(tag) {
    const name = personName(tag.personId);
    const ok = await App.confirm({
      title: 'Markierung entfernen?',
      message: 'Die Markierung von ' + name + ' wird von diesem Foto entfernt. ' +
               'Die Person selbst bleibt im Stammbaum.',
      confirmLabel: 'Entfernen',
      danger: true
    });
    if (!ok) return;

    try {
      await API.del('/api/tags/' + tag.id);
    } catch (err) {
      App.toast('Entfernen fehlgeschlagen: ' + apiMessage(err), 'error');
      return;
    }

    const photo = currentPhoto();
    if (photo) photo.tags = tagsOf(photo).filter((t) => Number(t.id) !== Number(tag.id));
    syncPortrait();
    renderViewerContent();
    renderGallery();
    App.toast('Markierung entfernt.', 'success');
    loadPhotos({ silent: true });
  }

  // --- Namensliste unter dem Bild -------------------------------------------

  function renderPeopleList() {
    if (!viewer) return;
    const host = viewer.people;
    host.textContent = '';
    const photo = currentPhoto();
    const tags = tagsOf(photo);

    if (!tags.length) {
      host.appendChild(el('span', 'small faint', 'Noch niemand markiert.'));
      return;
    }

    const sorted = tags.slice().sort((a, b) =>
      personName(a.personId).localeCompare(personName(b.personId), 'de-CH'));

    for (const tag of sorted) {
      const pill = el('button', 'pill pill--lav pa-person');
      pill.type = 'button';
      pill.dataset.personId = String(tag.personId);
      pill.setAttribute('aria-pressed', 'false');
      pill.textContent = personName(tag.personId);
      const marker = () => viewer && viewer.markers.get(Number(tag.id));
      const on = () => { const m = marker(); if (m) m.classList.add('is-hover'); };
      const off = () => { const m = marker(); if (m) m.classList.remove('is-hover'); };
      pill.addEventListener('mouseenter', on);
      pill.addEventListener('mouseleave', off);
      pill.addEventListener('focus', on);
      pill.addEventListener('blur', off);
      pill.addEventListener('click', () => togglePersonFocus(tag.personId));
      host.appendChild(pill);
    }
  }

  function highlightPerson(personId) {
    if (!viewer) return;
    const photo = currentPhoto();
    const tag = tagsOf(photo).find((t) => Number(t.personId) === Number(personId));
    if (!tag) return;
    const marker = viewer.markers.get(Number(tag.id));
    if (!marker) return;
    marker.classList.add('is-highlight');
    if (viewer.highlightTimer) clearTimeout(viewer.highlightTimer);
    viewer.highlightTimer = setTimeout(() => {
      marker.classList.remove('is-highlight');
    }, HIGHLIGHT_MS);
  }

  // --- Layout: Rahmen deckt sich exakt mit der dargestellten Bildfläche ------

  function layoutFrame() {
    if (!viewer) return;
    const stage = viewer.stage;
    const availW = Math.max(0, stage.clientWidth - STAGE_MARGIN * 2);
    const availH = Math.max(0, stage.clientHeight - STAGE_MARGIN * 2);
    if (!availW || !availH) return;

    const ratio = viewer.ratio > 0 ? viewer.ratio : 3 / 2;
    let w = availW;
    let h = w / ratio;
    if (h > availH) { h = availH; w = h * ratio; }

    viewer.fitW = w;
    viewer.fitH = h;
    // Marker skalieren mit der EINGEPASSTEN Bildgrösse (Zoomstufe 1), niemals
    // mit der gezoomten: Beim Hineinzoomen sollen Punkte und Namensschilder
    // gleich gross bleiben, sonst verdecken sie genau die Gesichter, die man
    // sehen will. (Trefferfläche des Punkts bleibt ohnehin 44 px.)
    const scale = Math.min(1, Math.max(0.6, w / 900));
    viewer.frame.style.setProperty('--pa-scale', scale.toFixed(3));

    viewer.maxZoom = computeMaxZoom(w);
    applyZoom(false);
  }

  // --- Zoom -----------------------------------------------------------------
  /* Bewusst KEIN CSS-`transform: scale()` auf dem Rahmen: das würde Marker und
     Namen mitvergrössern. Stattdessen wächst nur die Pixelgrösse von .pa-frame;
     die Marker sitzen prozentual darin und behalten ihre feste Grösse.
     Verschieben (Pan) darf `translate()` sein — das ändert keine Grössen. */

  /** Jedes Foto lässt sich gleich weit zoomen — unabhängig von seiner Auflösung. */
  function computeMaxZoom() {
    return ZOOM_MAX;
  }

  function clampZoom(z) {
    return Math.min(ZOOM_MAX, Math.max(1, Number(z) || 1));
  }

  function isZoomed() {
    return Boolean(viewer) && viewer.zoom > 1.001;
  }

  /** Der Rahmen darf die Bühne nie verlassen — es bleibt immer Bild zu sehen. */
  function clampPan(fw, fh) {
    const limX = Math.max(0, (fw - viewer.stage.clientWidth) / 2);
    const limY = Math.max(0, (fh - viewer.stage.clientHeight) / 2);
    viewer.panX = Math.min(limX, Math.max(-limX, viewer.panX || 0));
    viewer.panY = Math.min(limY, Math.max(-limY, viewer.panY || 0));
  }

  function writeTransform() {
    viewer.frame.style.transform = (viewer.panX || viewer.panY)
      ? 'translate(' + viewer.panX.toFixed(2) + 'px, ' + viewer.panY.toFixed(2) + 'px)'
      : '';
  }

  /** Rahmengrösse = eingepasste Grösse × Zoomfaktor. */
  function applyZoom(animate) {
    if (!viewer || !viewer.fitW) return;
    viewer.zoom = clampZoom(viewer.zoom);
    const fw = Math.round(viewer.fitW * viewer.zoom);
    const fh = Math.round(viewer.fitH * viewer.zoom);
    // Weiche Bewegung nur bei Knopf/Doppelklick; prefers-reduced-motion schaltet
    // die Übergänge global ab (tokens.css).
    viewer.frame.classList.toggle('pa-frame--smooth', Boolean(animate));
    viewer.frame.style.width = fw + 'px';
    viewer.frame.style.height = fh + 'px';
    clampPan(fw, fh);
    writeTransform();
    viewer.stage.classList.toggle('is-zoomed', isZoomed());
    updateZoomUi();
    if (viewer.popover) placePopover();
  }

  /** Nur verschieben — Grösse bleibt, darum kein applyZoom nötig. */
  function applyPan() {
    if (!viewer || !viewer.fitW) return;
    clampPan(Math.round(viewer.fitW * viewer.zoom), Math.round(viewer.fitH * viewer.zoom));
    writeTransform();
    if (viewer.popover) placePopover();
  }

  function updateZoomUi() {
    if (!viewer || !viewer.zoomIn) return;
    const canZoom = viewer.maxZoom > 1.001;
    viewer.zoomIn.disabled = !canZoom || viewer.zoom >= viewer.maxZoom - 0.001;
    viewer.zoomOut.disabled = !isZoomed();
    viewer.zoomReset.disabled = !isZoomed();
    viewer.zoomLevel.textContent = Math.round(viewer.zoom * 100) + ' %';
  }

  /** Normierte Bildkoordinaten (0..1) eines Punktes in Fensterkoordinaten. */
  function framePoint(clientX, clientY) {
    const rect = viewer.frame.getBoundingClientRect();
    if (!rect.width || !rect.height) return { u: 0.5, v: 0.5 };
    return {
      u: (clientX - rect.left) / rect.width,
      v: (clientY - rect.top) / rect.height
    };
  }

  /**
   * Auf `nextZoom` gehen und dabei den Bildpunkt (u, v) unter (clientX, clientY)
   * festhalten. Der Rahmen ist in der Bühne zentriert, die Verschiebung setzt
   * genau die Differenz dazu.
   */
  function zoomAnchored(nextZoom, u, v, clientX, clientY, animate) {
    if (!viewer || !viewer.fitW) return;
    viewer.zoom = clampZoom(nextZoom);
    const fw = Math.round(viewer.fitW * viewer.zoom);
    const fh = Math.round(viewer.fitH * viewer.zoom);
    const sr = viewer.stage.getBoundingClientRect();
    viewer.panX = clientX - sr.left - (sr.width - fw) / 2 - u * fw;
    viewer.panY = clientY - sr.top - (sr.height - fh) / 2 - v * fh;
    applyZoom(animate);
  }

  function zoomAt(nextZoom, clientX, clientY, animate) {
    if (!viewer) return;
    const p = framePoint(clientX, clientY);
    zoomAnchored(nextZoom, p.u, p.v, clientX, clientY, animate);
  }

  /**
   * Eine ganze Hunderterstufe hoch oder runter, gemessen von der Bildmitte.
   *
   * Rad und Pinch dürfen zwischendrin landen (etwa 135 %). Dann führt „+" auf
   * die nächste volle Stufe (200 %) und „−" auf die vorherige (100 %), statt den
   * krummen Wert mitzuschleppen.
   *
   * @param {number} richtung  +1 oder -1
   */
  function zoomByStep(richtung) {
    if (!viewer) return;
    const jetzt = viewer.zoom;
    const ziel = richtung > 0
      ? Math.floor(jetzt + 1e-6) + 1
      : Math.ceil(jetzt - 1e-6) - 1;
    const r = viewer.stage.getBoundingClientRect();
    zoomAt(ziel, r.left + r.width / 2, r.top + r.height / 2, true);
  }

  function resetZoom(animate) {
    if (!viewer) return;
    viewer.zoom = 1;
    viewer.panX = 0;
    viewer.panY = 0;
    applyZoom(Boolean(animate));
  }

  function toggleZoomAt(clientX, clientY) {
    if (isZoomed()) { resetZoom(true); return; }
    zoomAt(Math.min(ZOOM_DOUBLE, viewer.maxZoom), clientX, clientY, true);
  }

  function clearGestures() {
    if (!viewer) return;
    viewer.pointers.clear();
    viewer.pan = null;
    viewer.pinch = null;
    viewer.lastClick = null;
    viewer.frame.classList.remove('is-panning');
  }

  // --- Zeigergesten auf dem Bild -------------------------------------------
  /* Drei Gesten teilen sich denselben Rahmen und dürfen sich nicht in die Quere
     kommen:
       – Ziehen auf einem Marker  → Marker verschieben (attachDrag, eigene
         Handler auf dem Punkt; hier wird darum sofort ausgestiegen)
       – Ziehen auf dem Bild      → Ansicht verschieben (nur gezoomt)
       – Klick ohne Ziehen        → neue Markierung setzen
     Unterschieden wird über DRAG_THRESHOLD; sobald gezogen wurde, unterdrückt
     `suppressFrameClick` den anschliessenden Klick. */

  function onFramePointerDown(ev) {
    if (!viewer) return;
    if (ev.button != null && ev.button > 0) return;      // Rechtsklick
    if (blocksFrameGesture(ev)) return;

    viewer.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (viewer.pointers.size >= 2) { startPinch(); return; }

    viewer.pan = {
      id: ev.pointerId,
      startX: ev.clientX, startY: ev.clientY,
      panX: viewer.panX, panY: viewer.panY,
      moved: false, captured: false
    };
  }

  function onFramePointerMove(ev) {
    if (!viewer) return;
    const known = viewer.pointers.get(ev.pointerId);
    if (known) { known.x = ev.clientX; known.y = ev.clientY; }

    if (viewer.pinch && viewer.pointers.size >= 2) { movePinch(); return; }

    const pan = viewer.pan;
    if (!pan || pan.id !== ev.pointerId) return;
    const dx = ev.clientX - pan.startX;
    const dy = ev.clientY - pan.startY;
    if (!pan.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

    if (!pan.moved) {
      pan.moved = true;
      pan.captured = true;
      try { viewer.frame.setPointerCapture(pan.id); } catch (err) { /* egal */ }
      if (isZoomed()) viewer.frame.classList.add('is-panning');
    }
    if (!isZoomed()) return;      // eingepasst gibt es nichts zu verschieben
    ev.preventDefault();
    viewer.panX = pan.panX + dx;
    viewer.panY = pan.panY + dy;
    viewer.frame.classList.remove('pa-frame--smooth');
    applyPan();
  }

  function onFramePointerUp(ev) {
    if (!viewer) return;
    viewer.pointers.delete(ev.pointerId);
    if (viewer.pinch && viewer.pointers.size < 2) {
      viewer.pinch = null;
      viewer.suppressFrameClick = true;
    }
    const pan = viewer.pan;
    if (!pan || pan.id !== ev.pointerId) return;
    viewer.pan = null;
    viewer.frame.classList.remove('is-panning');
    if (pan.captured) {
      try { viewer.frame.releasePointerCapture(pan.id); } catch (err) { /* egal */ }
    }
    // Gezogen heisst: kein Klick, also auch keine neue Markierung.
    if (pan.moved) viewer.suppressFrameClick = true;
  }

  function pinchPoints() {
    return Array.from(viewer.pointers.values()).slice(0, 2);
  }

  function startPinch() {
    const pts = pinchPoints();
    if (pts.length < 2) return;
    const midX = (pts[0].x + pts[1].x) / 2;
    const midY = (pts[0].y + pts[1].y) / 2;
    const p = framePoint(midX, midY);
    viewer.pinch = {
      dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
      zoom: viewer.zoom,
      u: p.u, v: p.v
    };
    viewer.pan = null;                       // Pinch ist weder Klick noch Pan
    viewer.suppressFrameClick = true;
    viewer.frame.classList.remove('is-panning', 'pa-frame--smooth');
  }

  function movePinch() {
    const pts = pinchPoints();
    if (pts.length < 2) return;
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const pinch = viewer.pinch;
    // Auf die Mitte der beiden Finger zentriert; wandert die Mitte, wandert
    // der Ausschnitt mit.
    zoomAnchored(pinch.zoom * (dist / pinch.dist), pinch.u, pinch.v,
      (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, false);
  }

  /** Mausrad zoomt, zentriert auf den Zeiger. */
  function onStageWheel(ev) {
    if (!viewer) return;
    if (ev.target.closest && ev.target.closest('.pa-popover')) return;
    if (viewer.maxZoom <= 1.001 && !isZoomed()) return;
    ev.preventDefault();
    let delta = ev.deltaY;
    if (ev.deltaMode === 1) delta *= 16;        // Zeilen
    else if (ev.deltaMode === 2) delta *= 400;  // Seiten
    if (!delta) return;
    viewer.frame.classList.remove('pa-frame--smooth');
    zoomAt(viewer.zoom * Math.exp(-delta * 0.0022), ev.clientX, ev.clientY, false);
  }

  // --- Neue Markierung setzen ----------------------------------------------

  function onFrameClick(ev) {
    if (!viewer) return;
    if (viewer.suppressFrameClick) { viewer.suppressFrameClick = false; return; }
    if (blocksFrameGesture(ev)) return;

    // Doppelklick/Doppeltipp schaltet zwischen eingepasst und einer nahen Stufe
    // um. Der erste Klick hat gerade das Markieren gestartet — das wird hier
    // wieder zurückgenommen. Bewusst kein Warten auf ein Doppelklick-Fenster:
    // das Markieren ist die häufigere Geste und soll ohne Verzögerung reagieren.
    const now = Date.now();
    const last = viewer.lastClick;
    if (last && now - last.t < DOUBLE_MS &&
        Math.hypot(ev.clientX - last.x, ev.clientY - last.y) < DOUBLE_SLOP) {
      viewer.lastClick = null;
      closePopover();
      toggleZoomAt(ev.clientX, ev.clientY);
      return;
    }
    viewer.lastClick = { t: now, x: ev.clientX, y: ev.clientY };

    // Die Rahmenmasse enthalten den Zoomfaktor bereits — der Bruch ergibt
    // darum in jeder Zoomstufe dieselben normierten Koordinaten.
    const rect = viewer.frame.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = clamp01((ev.clientX - rect.left) / rect.width);
    const y = clamp01((ev.clientY - rect.top) / rect.height);
    startTagging(x, y);
  }

  function startTagging(x, y) {
    closePopover();
    const draft = el('div', 'pa-marker pa-marker--draft');
    positionNode(draft, x, y);
    draft.appendChild(el('span', 'pa-marker__dot pa-marker__dot--draft'));
    draft.appendChild(el('span', 'pa-marker__name', 'Wer ist das?'));
    viewer.frame.appendChild(draft);
    viewer.draft = draft;
    openPopover(x, y);
  }

  function closePopover() {
    if (!viewer) return;
    if (viewer.popover) { viewer.popover.remove(); viewer.popover = null; }
    if (viewer.draft) { viewer.draft.remove(); viewer.draft = null; }
    viewer.stage.classList.remove('is-tagging');
  }

  function openPopover(x, y) {
    const pop = el('div', 'pa-popover');
    pop.dataset.x = String(x);
    pop.dataset.y = String(y);
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Person markieren');
    pop.addEventListener('click', (ev) => ev.stopPropagation());

    viewer.popover = pop;
    viewer.stage.classList.add('is-tagging');
    viewer.frame.appendChild(pop);
    renderPickView(pop, x, y);
    placePopover();
  }

  /**
   * Popover positionieren. Schmale Geräte bekommen ein Blatt am unteren Rand
   * der Bühne — so bleibt der provisorische Marker im Bild sichtbar.
   */
  function placePopover() {
    const pop = viewer && viewer.popover;
    if (!pop) return;

    const sheet = window.innerWidth < 620;
    const parent = sheet ? viewer.stage : viewer.frame;
    if (pop.parentNode !== parent) parent.appendChild(pop);
    pop.classList.toggle('pa-popover--sheet', sheet);

    if (sheet) {
      pop.style.left = '';
      pop.style.top = '';
      pop.style.transform = '';
      return;
    }

    const x = Number(pop.dataset.x);
    const y = Number(pop.dataset.y);

    pop.style.left = (x * 100) + '%';
    pop.style.top = (y * 100) + '%';
    pop.style.transform = 'translate(-50%, 0)';   // Basislage vor dem Messen

    const stageRect = viewer.stage.getBoundingClientRect();
    const rect = pop.getBoundingClientRect();

    let shiftX = 0;
    if (rect.left < stageRect.left + 8) shiftX = stageRect.left + 8 - rect.left;
    else if (rect.right > stageRect.right - 8) shiftX = stageRect.right - 8 - rect.right;

    let shiftY = 0;
    // Unter dem Klickpunkt zu wenig Platz → über den Punkt klappen
    if (rect.bottom > stageRect.bottom - 8) {
      const flipped = rect.height + 56;
      if (rect.top - flipped >= stageRect.top + 8) shiftY = -flipped;
      else shiftY = Math.max(stageRect.top + 8 - rect.top, stageRect.bottom - 8 - rect.bottom);
    }
    pop.style.transform = 'translate(calc(-50% + ' + shiftX + 'px), ' + shiftY + 'px)';
  }

  function taggedPersonIds() {
    return new Set(tagsOf(currentPhoto()).map((t) => Number(t.personId)));
  }

  function renderPickView(pop, x, y) {
    pop.textContent = '';

    const head = el('div', 'pa-popover__head');
    head.appendChild(el('strong', 'small', 'Wer ist das?'));
    const cancel = el('button', 'pa-popover__close', '✕');
    cancel.type = 'button';
    cancel.setAttribute('aria-label', 'Markierung abbrechen');
    cancel.addEventListener('click', closePopover);
    head.append(el('span', 'spacer'), cancel);

    const field = el('div', 'field');
    const label = el('label', null, 'Person suchen');
    const inputId = 'pa-search-' + Date.now();
    label.setAttribute('for', inputId);
    const input = el('input');
    input.type = 'search';
    input.id = inputId;
    input.placeholder = 'Name tippen …';
    input.autocomplete = 'off';
    field.append(label, input);

    const list = el('div', 'pa-options');
    list.setAttribute('role', 'listbox');

    const already = taggedPersonIds();

    const paint = () => {
      list.textContent = '';
      const needle = input.value.trim().toLowerCase();
      const persons = Store.allPersons().filter((p) => {
        if (!needle) return true;
        return Store.displayName(p).toLowerCase().includes(needle);
      });

      if (!persons.length) {
        list.appendChild(el('p', 'small faint pa-options__empty',
          'Niemand gefunden. Lege die Person unten neu an.'));
        return;
      }

      for (const person of persons.slice(0, 40)) {
        const isTagged = already.has(Number(person.id));
        const option = el('button', 'pa-option' + (isTagged ? ' is-disabled' : ''));
        option.type = 'button';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        option.appendChild(el('span', 'pa-option__name', Store.displayName(person)));
        const span = Store.lifeSpan(person);
        if (isTagged) option.appendChild(el('span', 'tiny faint', 'bereits markiert'));
        else if (span) option.appendChild(el('span', 'tiny faint', span));
        if (isTagged) {
          option.disabled = true;
        } else {
          option.addEventListener('click', () => createTag(person.id, x, y));
        }
        list.appendChild(option);
      }
    };

    input.addEventListener('input', paint);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        const first = list.querySelector('.pa-option:not([disabled])');
        if (first) first.focus();
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        const first = list.querySelector('.pa-option:not([disabled])');
        if (first) first.click();
      }
    });

    list.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      ev.preventDefault();
      const options = Array.from(list.querySelectorAll('.pa-option:not([disabled])'));
      const idx = options.indexOf(document.activeElement);
      if (ev.key === 'ArrowUp' && idx <= 0) { input.focus(); return; }
      const next = options[idx + (ev.key === 'ArrowDown' ? 1 : -1)];
      if (next) next.focus();
    });

    const newBtn = el('button', 'btn btn--sun btn--sm btn--block pa-popover__new',
      '＋ Neue Person anlegen');
    newBtn.type = 'button';
    newBtn.addEventListener('click', () => renderCreateView(pop, x, y, input.value.trim()));

    pop.append(head, field, list, newBtn);
    paint();
    setTimeout(() => input.focus(), 40);
  }

  function renderCreateView(pop, x, y, prefill) {
    pop.textContent = '';

    const head = el('div', 'pa-popover__head');
    head.appendChild(el('strong', 'small', 'Neue Person anlegen'));
    const cancel = el('button', 'pa-popover__close', '✕');
    cancel.type = 'button';
    cancel.setAttribute('aria-label', 'Abbrechen');
    cancel.addEventListener('click', closePopover);
    head.append(el('span', 'spacer'), cancel);
    pop.appendChild(head);

    const options = Store.parentUnionOptions();
    const form = el('form', 'stack--sm');
    form.autocomplete = 'off';

    const parts = (prefill || '').split(/\s+/).filter(Boolean);

    const first = fieldInput('Vorname *', 'text', parts[0] || '');
    const last = fieldInput('Nachname', 'text', parts.slice(1).join(' '));

    const parentField = el('div', 'field');
    const parentLabel = el('label', null, 'Kind von');
    const select = el('select');
    parentLabel.setAttribute('for', 'pa-parent');
    select.id = 'pa-parent';
    for (const opt of options) {
      const o = el('option', null, opt.label);
      o.value = String(opt.unionId);
      select.appendChild(o);
    }
    parentField.append(parentLabel, select);

    const error = el('p', 'field__error');
    error.setAttribute('role', 'alert');
    error.hidden = true;

    form.append(first.field, last.field, parentField, error);

    if (!options.length) {
      select.disabled = true;
      parentField.appendChild(el('p', 'field__hint',
        'Es gibt noch kein Elternpaar zur Auswahl — lege die Person zuerst im ' +
        'Stammbaum an.'));
    }

    const actions = el('div', 'row row--end pa-popover__actions');
    const back = el('button', 'btn btn--ghost btn--sm', 'Zurück');
    back.type = 'button';
    back.addEventListener('click', () => renderPickView(pop, x, y));
    const save = el('button', 'btn btn--primary btn--sm', 'Anlegen & markieren');
    save.type = 'submit';
    save.disabled = !options.length;
    actions.append(back, save);
    form.appendChild(actions);

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      error.hidden = true;
      const firstName = first.input.value.trim();
      if (!firstName) {
        error.textContent = 'Bitte einen Vornamen eingeben.';
        error.hidden = false;
        first.input.focus();
        return;
      }
      save.disabled = true;
      save.textContent = 'Moment …';
      try {
        await createPersonAndTag({
          parentUnionId: Number(select.value),
          firstName,
          lastName: last.input.value.trim()
        }, x, y);
      } catch (err) {
        error.textContent = apiMessage(err);
        error.hidden = false;
        save.disabled = false;
        save.textContent = 'Anlegen & markieren';
      }
    });

    pop.appendChild(form);
    placePopover();
    setTimeout(() => first.input.focus(), 40);
  }

  function fieldInput(labelText, type, value) {
    const field = el('div', 'field');
    const label = el('label', null, labelText);
    const input = el('input');
    input.type = type;
    input.value = value || '';
    const id = 'pa-f-' + Math.random().toString(36).slice(2, 8);
    input.id = id;
    label.setAttribute('for', id);
    field.append(label, input);
    return { field, input, label };
  }

  // --- Schreiboperationen ---------------------------------------------------

  async function createTag(personId, x, y) {
    const photo = currentPhoto();
    if (!photo) return;
    try {
      const tag = await API.post('/api/photos/' + photo.id + '/tags',
        { personId: Number(personId), x, y });
      applyNewTag(photo, tag, personId, x, y);
      App.toast(personName(personId) + ' markiert.', 'success');
    } catch (err) {
      // Nur `tag_exists` ist harmlos. Seit es eine Obergrenze pro Foto gibt,
      // kommt auch `tag_limit` als 409 — dessen Meldung darf nicht verschluckt
      // werden, sonst sucht man den Fehler an der falschen Stelle.
      if (err && err.code === 'tag_exists') {
        App.toast('Diese Person ist auf dem Foto schon markiert.', 'info');
      } else {
        App.toast('Markieren fehlgeschlagen: ' + apiMessage(err), 'error');
      }
      return;
    }
    closePopover();
    renderViewerContent();
    renderGallery();
    loadPhotos({ silent: true });
  }

  function applyNewTag(photo, tag, personId, x, y) {
    const entry = (tag && tag.id != null)
      ? tag
      : { id: 'tmp-' + Date.now(), personId: Number(personId), x, y };
    if (!Array.isArray(photo.tags)) photo.tags = [];
    photo.tags.push(entry);
    // Sofort, ohne auf das stille Neuladen zu warten: Quiz und Personen-Panel
    // sollen die Person direkt mit Bild zeigen.
    syncPortrait();
  }

  async function createPersonAndTag(personFields, x, y) {
    const photo = currentPhoto();
    if (!photo) return;

    const person = await API.post('/api/persons', personFields);
    if (!person || person.id == null) throw new Error('Die Person konnte nicht angelegt werden.');

    let tag = null;
    try {
      tag = await API.post('/api/photos/' + photo.id + '/tags',
        { personId: person.id, x, y });
    } catch (err) {
      // Person existiert bereits — Stammbaum trotzdem auffrischen
      try { await Store.load(); } catch (e) { /* egal */ }
      throw err;
    }

    applyNewTag(photo, tag, person.id, x, y);
    closePopover();

    try {
      await Store.load();           // neue Person erscheint im Stammbaum
    } catch (err) {
      App.toast('Stammbaum konnte nicht aufgefrischt werden.', 'error');
    }

    renderViewerContent();
    renderGallery();
    App.toast(Store.displayName(person) + ' angelegt und markiert.', 'success');
    loadPhotos({ silent: true });
  }

  // --- Tastatur -------------------------------------------------------------

  function onViewerKeydown(ev) {
    if (!viewer) return;
    if (modalOpen()) return;   // App.confirm hat Vorrang
    // Liegt das Personen-Panel darüber, gehören Escape und Tab ihm — sonst
    // zöge die Fokus-Falle der Fotoansicht den Fokus wieder heraus.
    if (personPanelOpen()) return;

    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      if (viewer.popover) closePopover();
      else if (viewer.editing) setEditing(false);
      else closeViewer();
      return;
    }

    if (ev.key === 'Tab') { trapFocus(ev); return; }

    if (viewer.popover) return;                       // im Popover nicht blättern
    const tag = (ev.target && ev.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if (ev.key === 'ArrowLeft') { ev.preventDefault(); step(-1); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); step(1); }
    else if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); zoomByStep(1); }
    else if (ev.key === '-' || ev.key === '_') { ev.preventDefault(); zoomByStep(-1); }
    else if (ev.key === '0') { ev.preventDefault(); resetZoom(true); }
  }

  function trapFocus(ev) {
    const nodes = Array.from(viewer.root.querySelectorAll(FOCUSABLE))
      .filter((n) => !n.hidden && n.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;

    if (!viewer.root.contains(active)) {
      ev.preventDefault();
      first.focus();
      return;
    }
    if (ev.shiftKey && active === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
  }

  // --- Öffentliche API ------------------------------------------------------

  window.PhotoAlbum = {
    mount,

    /** Foto gross öffnen; optional eine markierte Person hervorheben. */
    openPhoto(photoId, highlightPersonId) {
      App.showTab('photos');
      const idx = photoIndex(photoId);
      if (idx >= 0) { openViewer(idx, highlightPersonId); return; }
      state.pendingOpen = { photoId, personId: highlightPersonId };
      loadPhotos();
    },

    closePhoto: closeViewer
  };
})();
