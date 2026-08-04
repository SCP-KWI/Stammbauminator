/* Stammbauminator — Adminbereich
   Globals: window.AdminView   Mountpoint: #tab-admin
   Arbeitsbereiche: App-Name, Fotos verwalten, Personen verwalten,
   Passwörter ändern.
   Der Bereich ist zusätzlich durch das Admin-Passwort geschützt. */
(function () {
  'use strict';

  // --- Konstanten -----------------------------------------------------------

  const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;   // Serverlimit
  const SKIP_RESIZE_BYTES = 800 * 1024;        // darunter unverändert senden
  const MAX_EDGE = 2000;                       // längste Kante nach dem Verkleinern
  const JPEG_QUALITY = 0.85;
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const CONFIRM_NAME_THRESHOLD = 3;            // ab wie vielen Personen der Vorname getippt werden muss
  const MAX_FAMILY_NAME = 40;                  // Serverlimit für den Familiennamen
  const MIN_PASSWORD_LENGTH = 12;              // wie MIN_PASSWORD_LENGTH auf dem Server

  // --- Modulzustand ---------------------------------------------------------

  let rootEl = null;
  let unsubscribeStore = null;
  let unsubscribeSettings = null;

  const state = {
    stats: null,
    statsError: null,
    statsLoading: false,
    photos: null,
    photosError: null,
    photosLoading: false,
    personQuery: '',
    queue: []          // vorbereitete Uploads
  };

  // Referenzen auf die aktuell gerenderten Container (nur im Adminmodus gesetzt)
  const refs = {};

  // ==========================================================================
  // Kleine DOM-Helfer
  // ==========================================================================

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, className, onClick) {
    const b = el('button', className, label);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function field(labelText, input, hintText) {
    const wrap = el('div', 'field');
    const lab = el('label', null, labelText);
    if (!input.id) input.id = 'adm-f-' + Math.random().toString(36).slice(2, 9);
    lab.htmlFor = input.id;
    wrap.append(lab, input);
    if (hintText) wrap.appendChild(el('p', 'field__hint', hintText));
    const err = el('p', 'field__error');
    err.hidden = true;
    err.setAttribute('role', 'alert');
    wrap.appendChild(err);
    wrap.__error = err;
    return wrap;
  }

  function setFieldError(fieldWrap, message) {
    if (!fieldWrap || !fieldWrap.__error) return;
    if (message) {
      fieldWrap.__error.textContent = message;
      fieldWrap.__error.hidden = false;
      fieldWrap.classList.add('field--invalid');
    } else {
      fieldWrap.__error.hidden = true;
      fieldWrap.__error.textContent = '';
      fieldWrap.classList.remove('field--invalid');
    }
  }

  function loadingBlock(text) {
    const wrap = el('div', 'adm-loading');
    wrap.append(el('div', 'spinner'), el('span', 'small muted', text || 'Wird geladen …'));
    return wrap;
  }

  function errorBlock(message, onRetry) {
    const wrap = el('div', 'adm-error');
    wrap.append(el('span', null, '⚠️'), el('span', 'small', message));
    if (onRetry) wrap.appendChild(button('Nochmals versuchen', 'btn btn--secondary btn--sm', onRetry));
    return wrap;
  }

  function emptyBlock(icon, text) {
    const wrap = el('div', 'empty');
    wrap.append(el('div', 'empty__icon', icon), el('p', 'small', text));
    return wrap;
  }

  function formatNumber(n) {
    return Number(n || 0).toLocaleString('de-CH');
  }

  /**
   * Datum-Eingabefeld als Textfeld in Schweizer Schreibweise.
   *
   * Bewusst kein `<input type="date">`: das zeigt das Format des Betriebssystems
   * (auf einem englischen System also MM/TT/JJJJ) und kann keine Teilangaben wie
   * «2010» aufnehmen — dafür brauchte es einen Feldwechsel mitten im Tippen.
   * Ein Textfeld mit `App.parseDateInput` verhält sich überall gleich und deckt
   * volle Daten und Teilangaben mit demselben Feld ab.
   *
   * @param {string} value ISO-Wert aus dem Backend; angezeigt wird `TT.MM.JJJJ`.
   */
  function dateInput(value) {
    const input = el('input');
    input.type = 'text';
    input.value = App.formatDate(value) || '';
    input.placeholder = 'TT.MM.JJJJ';
    input.autocomplete = 'off';
    input.inputMode = 'numeric';
    return input;
  }

  // ==========================================================================
  // Einstieg / Zugangs-Gate
  // ==========================================================================

  const AdminView = {
    mount(element) {
      rootEl = element;
      App.onRoleChange(render);
      render();
    }
  };

  function render() {
    if (!rootEl) return;
    clear(rootEl);
    for (const key of Object.keys(refs)) delete refs[key];

    if (unsubscribeStore) { unsubscribeStore(); unsubscribeStore = null; }
    if (unsubscribeSettings) { unsubscribeSettings(); unsubscribeSettings = null; }

    if (!App.isAdmin()) {
      renderLocked();
      return;
    }
    renderAdmin();
  }

  function renderLocked() {
    const page = el('div', 'page');
    const card = el('div', 'card adm-lock');

    card.appendChild(el('div', 'adm-lock__mark', '🔒'));
    card.appendChild(el('h1', 'adm-lock__title', 'Adminbereich'));
    card.appendChild(el('p', 'adm-lock__text',
      'Dieser Bereich ist zusätzlich geschützt. Hier werden Fotos hochgeladen, '
      + 'Personen gelöscht und die Passwörter gewechselt.'));

    const unlock = button('Admin-Bereich freischalten', 'btn btn--sun btn--lg', async () => {
      unlock.disabled = true;
      try {
        await App.requestAdmin();
        // Bei Erfolg löst App.setRole den Rollen-Listener aus → render()
      } finally {
        unlock.disabled = false;
      }
    });
    unlock.prepend(document.createTextNode('🔑 '));
    card.appendChild(unlock);

    page.appendChild(card);
    rootEl.appendChild(page);
  }

  function renderAdmin() {
    const page = el('div', 'page adm');

    // Kopfzeile
    const head = el('div', 'adm-head');
    const titleBox = el('div');
    titleBox.append(el('h1', null, 'Adminbereich'),
      el('p', 'small muted mb-0', 'App-Name, Fotos, Personen und Passwörter verwalten.'));
    head.append(titleBox, el('div', 'spacer'));

    const leaveBtn = button('Admin-Modus verlassen', 'btn btn--secondary', async () => {
      leaveBtn.disabled = true;
      try {
        await API.post('/api/auth/admin/leave');
        App.setRole('family');
        App.toast('Admin-Modus verlassen.', 'info');
      } catch (err) {
        App.toast('Konnte den Admin-Modus nicht verlassen: ' + err.message, 'error');
        leaveBtn.disabled = false;
      }
    });
    head.appendChild(leaveBtn);
    page.appendChild(head);

    // Statistik
    refs.stats = el('section', 'adm-section');
    page.appendChild(refs.stats);
    renderStats();
    loadStats();

    // App-Name
    page.appendChild(buildNameSection());

    // Fotos
    page.appendChild(buildPhotoSection());
    loadPhotos();

    // Personen
    page.appendChild(buildPersonSection());

    // Passwörter
    page.appendChild(buildPasswordSection());

    rootEl.appendChild(page);

    unsubscribeStore = Store.subscribe(() => renderPersonList());
    renderPersonList();
  }

  // ==========================================================================
  // 1. Statistik
  // ==========================================================================

  async function loadStats() {
    state.statsLoading = true;
    state.statsError = null;
    renderStats();
    try {
      state.stats = await API.get('/api/admin/stats');
    } catch (err) {
      state.stats = null;
      state.statsError = err.message;
    } finally {
      state.statsLoading = false;
      renderStats();
    }
  }

  function renderStats() {
    const host = refs.stats;
    if (!host) return;
    clear(host);

    const card = el('div', 'card adm-stats');
    if (state.statsLoading && !state.stats) {
      card.appendChild(loadingBlock('Zahlen werden geholt …'));
    } else if (state.statsError) {
      card.appendChild(errorBlock('Statistik nicht verfügbar: ' + state.statsError, loadStats));
    } else if (state.stats) {
      const s = state.stats;
      const items = [
        ['👥', 'Personen', formatNumber(s.persons)],
        ['💞', 'Partner:innen', formatNumber(s.partners)],
        ['📸', 'Fotos', formatNumber(s.photos)],
        ['📍', 'Markierungen', formatNumber(s.tags)],
        ['💾', 'Datenbank', ImageTools.formatBytes(s.dbSizeBytes)]
      ];
      const grid = el('div', 'adm-stats__grid');
      for (const [icon, label, value] of items) {
        const cell = el('div', 'adm-stat');
        cell.append(
          el('div', 'adm-stat__icon', icon),
          el('div', 'adm-stat__value', value),
          el('div', 'adm-stat__label', label)
        );
        grid.appendChild(cell);
      }
      card.appendChild(grid);
    }
    host.appendChild(card);
  }

  // ==========================================================================
  // 2. App-Name (Familienname)
  // ==========================================================================

  /** Gleiche Regel wie auf dem Server — nur für die Vorschau vor dem Speichern. */
  function previewTitle(name) {
    const trimmed = (name || '').trim();
    return trimmed ? trimmed + ' Stammbaum' : 'Stammbaum';
  }

  function buildNameSection() {
    const section = el('section', 'adm-section');
    const card = el('div', 'card card--flush');

    const header = el('div', 'card__header');
    header.appendChild(el('h2', 'section-title mb-0', '🏷️ App-Name'));
    card.appendChild(header);

    const body = el('div', 'card__body');
    const form = el('form', 'stack');
    form.autocomplete = 'off';
    form.noValidate = true;

    // --- Eingabefeld ---
    const input = el('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'z.B. Muster';
    const nameField = field('Familienname', input,
      'Der Name steht in der Kopfzeile und im Browser-Tab. '
      + 'Leer lassen ergibt nur «Stammbaum».');

    nameField.classList.add('adm-name__field');

    const counter = el('p', 'adm-name__count tiny faint');
    nameField.insertBefore(counter, nameField.__error);
    form.appendChild(nameField);

    // --- Live-Vorschau ---
    const preview = el('div', 'adm-name__preview');
    preview.appendChild(el('p', 'adm-name__caption tiny faint mb-0', 'So sieht die Kopfzeile aus'));
    const bar = el('div', 'adm-name__bar');
    const mark = el('span', 'adm-name__mark', '🌳');
    mark.setAttribute('aria-hidden', 'true');
    const texts = el('div', 'adm-name__texts');
    const previewTitleEl = el('div', 'adm-name__title', 'Stammbaum');
    texts.append(previewTitleEl, el('div', 'adm-name__sub tiny faint', 'Unsere Familie auf einen Blick'));
    bar.append(mark, texts);
    preview.appendChild(bar);
    form.appendChild(preview);

    // --- Aktionen ---
    const actions = el('div', 'row row--end');
    const submit = el('button', 'btn btn--primary', 'Speichern');
    submit.type = 'submit';
    actions.appendChild(submit);
    form.appendChild(actions);

    // --- Zustand --------------------------------------------------------
    let saved = '';        // zuletzt bekannter Serverwert (getrimmt)
    let saving = false;
    let loading = false;

    const currentValue = () => input.value.trim();

    function refresh() {
      const value = currentValue();
      previewTitleEl.textContent = previewTitle(value);

      const over = value.length - MAX_FAMILY_NAME;
      if (loading) {
        counter.textContent = 'Aktuelle Einstellung wird geladen …';
        counter.classList.remove('adm-name__count--over');
      } else if (over > 0) {
        counter.textContent = over === 1
          ? '1 Zeichen zu viel — höchstens ' + MAX_FAMILY_NAME + '.'
          : over + ' Zeichen zu viel — höchstens ' + MAX_FAMILY_NAME + '.';
        counter.classList.add('adm-name__count--over');
      } else {
        counter.textContent = 'Noch ' + (MAX_FAMILY_NAME - value.length)
          + ' von ' + MAX_FAMILY_NAME + ' Zeichen frei';
        counter.classList.remove('adm-name__count--over');
      }

      submit.disabled = saving || loading || over > 0 || value === saved;
    }

    /** Serverwert übernehmen — ohne ungespeicherte Eingaben zu überschreiben. */
    function adoptExternal(name) {
      const wasClean = currentValue() === saved;
      saved = String(name == null ? '' : name).trim();
      if (wasClean || saving) {
        input.value = saved;
        setFieldError(nameField, null);
      }
      refresh();
    }

    input.addEventListener('input', () => {
      if (currentValue().length <= MAX_FAMILY_NAME) setFieldError(nameField, null);
      refresh();
    });

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (saving || loading) return;

      const value = currentValue();
      setFieldError(nameField, null);

      if (value.length > MAX_FAMILY_NAME) {
        setFieldError(nameField,
          'Höchstens ' + MAX_FAMILY_NAME + ' Zeichen — momentan sind es ' + value.length + '.');
        input.focus();
        refresh();
        return;
      }

      saving = true;
      const label = submit.textContent;
      submit.textContent = 'Moment …';
      refresh();
      try {
        const res = await API.post('/api/admin/settings', { familyName: value });
        const nextName = (res && typeof res.familyName === 'string') ? res.familyName.trim() : value;
        saved = nextName;
        input.value = saved;
        if (typeof App.applySettings === 'function') {
          App.applySettings(res && typeof res === 'object'
            ? res
            : { familyName: saved, appTitle: previewTitle(saved) });
        }
        App.toast(saved
          ? 'App heisst jetzt «' + previewTitle(saved) + '».'
          : 'Familienname entfernt — die App heisst jetzt nur «Stammbaum».', 'success');
      } catch (err) {
        setFieldError(nameField, err && err.message ? err.message : 'Speichern fehlgeschlagen.');
        input.focus();
      } finally {
        saving = false;
        submit.textContent = label;
        refresh();
      }
    });

    // --- Startwert ------------------------------------------------------
    const known = App.settings;
    if (known && typeof known.familyName === 'string') {
      adoptExternal(known.familyName);
    } else {
      // App.settings ist direkt nach dem Login noch null → selber nachfragen.
      loading = true;
      input.disabled = true;
      refresh();
      API.get('/api/settings').then((res) => {
        loading = false;
        input.disabled = false;
        adoptExternal(res && res.familyName);
        if (!App.settings && res && typeof App.applySettings === 'function') App.applySettings(res);
      }).catch((err) => {
        loading = false;
        input.disabled = false;
        refresh();
        setFieldError(nameField, 'Aktueller Name konnte nicht geladen werden: '
          + (err && err.message ? err.message : 'unbekannter Fehler'));
      });
    }

    if (typeof App.onSettingsChange === 'function') {
      unsubscribeSettings = App.onSettingsChange((s) => {
        if (s && typeof s.familyName === 'string') adoptExternal(s.familyName);
      });
    }

    body.appendChild(form);
    card.appendChild(body);
    section.appendChild(card);
    return section;
  }

  // ==========================================================================
  // 3. Fotos verwalten
  // ==========================================================================

  function buildPhotoSection() {
    const section = el('section', 'adm-section');
    const card = el('div', 'card card--flush');

    const header = el('div', 'card__header');
    header.appendChild(el('h2', 'section-title mb-0', '📸 Fotos verwalten'));
    const reload = button('Aktualisieren', 'btn btn--ghost btn--sm', loadPhotos);
    header.appendChild(reload);
    card.appendChild(header);

    const body = el('div', 'card__body stack');

    // --- Ablagefläche & Dateiauswahl ---
    const drop = el('div', 'adm-drop');
    drop.tabIndex = 0;
    drop.setAttribute('role', 'button');
    drop.setAttribute('aria-label', 'Fotos auswählen oder hierher ziehen');
    drop.append(
      el('div', 'adm-drop__icon', '⬆️'),
      el('p', 'adm-drop__title', 'Fotos hierher ziehen'),
      el('p', 'adm-drop__hint small muted',
        'oder tippen zum Auswählen — JPEG, PNG oder WebP, max. 15 MB pro Bild. '
        + 'Grosse Bilder werden vor dem Hochladen automatisch verkleinert.')
    );

    const fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = ALLOWED_TYPES.join(',');
    fileInput.multiple = true;
    fileInput.className = 'sr-only';
    fileInput.addEventListener('change', () => {
      addFiles(fileInput.files);
      fileInput.value = '';
    });

    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fileInput.click(); }
    });
    for (const type of ['dragenter', 'dragover']) {
      drop.addEventListener(type, (ev) => {
        ev.preventDefault();
        drop.classList.add('adm-drop--over');
      });
    }
    for (const type of ['dragleave', 'dragend']) {
      drop.addEventListener(type, () => drop.classList.remove('adm-drop--over'));
    }
    drop.addEventListener('drop', (ev) => {
      ev.preventDefault();
      drop.classList.remove('adm-drop--over');
      if (ev.dataTransfer && ev.dataTransfer.files) addFiles(ev.dataTransfer.files);
    });

    body.append(drop, fileInput);

    // --- Warteschlange ---
    refs.queue = el('div', 'adm-queue');
    body.appendChild(refs.queue);

    // --- Liste ---
    refs.photoList = el('div', 'adm-photos');
    body.appendChild(refs.photoList);

    card.appendChild(body);
    section.appendChild(card);
    return section;
  }

  // --- Liste laden & zeichnen ----------------------------------------------

  /**
   * Die aktuelle Fotoliste ans Portrait-Modul durchreichen. Portrait hält einen
   * eigenen Zwischenspeicher; ohne diesen Aufruf bleibt der Ausschnitt-Index
   * nach Upload, Löschen oder Datumsänderung veraltet. `setPhotos` baut den
   * Index sofort neu auf — kein zusätzlicher Request.
   */
  function syncPortrait() {
    if (window.Portrait && typeof Portrait.setPhotos === 'function') {
      Portrait.setPhotos(state.photos || []);
    }
  }

  async function loadPhotos() {
    state.photosLoading = true;
    state.photosError = null;
    renderPhotoList();
    try {
      const data = await API.get('/api/photos');
      state.photos = Array.isArray(data) ? data : [];
      syncPortrait();
    } catch (err) {
      state.photosError = err.message;
    } finally {
      state.photosLoading = false;
      renderPhotoList();
    }
  }

  function renderPhotoList() {
    const host = refs.photoList;
    if (!host) return;
    clear(host);

    if (state.photosLoading && !state.photos) {
      host.appendChild(loadingBlock('Fotos werden geladen …'));
      return;
    }
    if (state.photosError) {
      host.appendChild(errorBlock('Fotos konnten nicht geladen werden: ' + state.photosError, loadPhotos));
      return;
    }
    if (!state.photos || !state.photos.length) {
      host.appendChild(emptyBlock('🖼️', 'Noch keine Fotos hochgeladen.'));
      return;
    }

    const count = el('p', 'small muted mb-0',
      state.photos.length === 1 ? '1 Foto' : state.photos.length + ' Fotos');
    host.appendChild(count);

    for (const photo of state.photos) host.appendChild(buildPhotoRow(photo));
  }

  function buildPhotoRow(photo) {
    const row = el('div', 'adm-photo');

    // Vorschaubild
    const thumbWrap = el('div', 'adm-photo__thumb');
    if (photo.url) {
      const img = el('img');
      img.src = photo.url;
      img.alt = photo.title ? 'Vorschau: ' + photo.title : 'Vorschau';
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        clear(thumbWrap);
        thumbWrap.appendChild(el('span', 'adm-photo__fallback', '🖼️'));
      });
      thumbWrap.appendChild(img);
    } else {
      thumbWrap.appendChild(el('span', 'adm-photo__fallback', '🖼️'));
    }
    row.appendChild(thumbWrap);

    // Felder
    const fields = el('div', 'adm-photo__fields');

    const titleInput = el('input');
    titleInput.type = 'text';
    titleInput.value = photo.title || '';
    titleInput.placeholder = 'Ohne Titel';
    titleInput.maxLength = 200;
    const titleField = field('Titel', titleInput);

    const dInput = dateInput(photo.takenAt);
    const dateField = field('Aufnahmedatum', dInput, App.DATE_HINT);

    fields.append(titleField, dateField);

    const status = el('p', 'adm-photo__status tiny muted mb-0');
    fields.appendChild(status);

    // Gespeichert wird ISO, im Feld steht Schweizer Schreibweise.
    const resetDate = () => { dInput.value = App.formatDate(photo.takenAt) || ''; };

    const savePatch = async () => {
      const parsed = App.parseDateInput(dInput.value);
      if (!parsed.ok) {
        setFieldError(dateField, parsed.message);
        status.textContent = '';
        status.classList.remove('adm-photo__status--error');
        return;
      }
      setFieldError(dateField, '');

      const next = {
        title: titleInput.value.trim(),
        takenAt: parsed.value
      };
      if (next.title === (photo.title || '') && next.takenAt === (photo.takenAt || '')) {
        resetDate();
        return;
      }
      status.textContent = 'Wird gespeichert …';
      status.classList.remove('adm-photo__status--error');
      try {
        const updated = await API.patch('/api/photos/' + photo.id, next);
        photo.title = (updated && updated.title != null) ? updated.title : next.title;
        photo.takenAt = (updated && updated.takenAt != null) ? updated.takenAt : next.takenAt;
        // Das Aufnahmedatum bestimmt, aus welchem Foto ein Ausschnitt stammt.
        syncPortrait();
        resetDate();
        status.textContent = 'Gespeichert ✓';
        setTimeout(() => { if (status.textContent === 'Gespeichert ✓') status.textContent = ''; }, 2500);
      } catch (err) {
        status.textContent = 'Nicht gespeichert: ' + err.message;
        status.classList.add('adm-photo__status--error');
        // Werte zurücksetzen, damit die Liste dem Server entspricht
        titleInput.value = photo.title || '';
        resetDate();
      }
    };

    titleInput.addEventListener('change', savePatch);
    dInput.addEventListener('change', savePatch);
    dInput.addEventListener('input', () => setFieldError(dateField, ''));
    titleInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') titleInput.blur(); });
    dInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') dInput.blur(); });

    row.appendChild(fields);

    // Meta & Aktionen
    const side = el('div', 'adm-photo__side');
    const tagCount = (photo.tags && photo.tags.length) || 0;
    const pill = el('span', 'pill pill--lav',
      tagCount === 1 ? '1 Markierung' : tagCount + ' Markierungen');
    side.appendChild(pill);

    if (photo.width && photo.height) {
      side.appendChild(el('span', 'tiny faint', photo.width + ' × ' + photo.height + ' px'));
    }

    const delBtn = button('Löschen', 'btn btn--danger btn--sm', () => deletePhoto(photo, delBtn));
    side.appendChild(delBtn);
    row.appendChild(side);

    return row;
  }

  async function deletePhoto(photo, btn) {
    const name = photo.title ? '«' + photo.title + '»' : 'dieses Foto';
    const tagCount = (photo.tags && photo.tags.length) || 0;
    const ok = await App.confirm({
      title: 'Foto löschen?',
      message: 'Das Foto ' + name + ' wird endgültig gelöscht — auch die Bilddatei. '
        + (tagCount
          ? 'Die ' + tagCount + ' Markierung' + (tagCount === 1 ? '' : 'en') + ' darauf verschwind'
            + (tagCount === 1 ? 'et' : 'en') + ' mit. '
          : 'Alle Markierungen darauf verschwinden mit. ')
        + 'Das lässt sich nicht rückgängig machen.',
      confirmLabel: 'Endgültig löschen',
      danger: true
    });
    if (!ok) return;

    btn.disabled = true;
    try {
      await API.del('/api/photos/' + photo.id);
      state.photos = (state.photos || []).filter((p) => p.id !== photo.id);
      syncPortrait();
      renderPhotoList();
      App.toast('Foto gelöscht.', 'success');
      loadStats();
    } catch (err) {
      App.toast('Löschen fehlgeschlagen: ' + err.message, 'error');
      btn.disabled = false;
    }
  }

  // --- Upload ---------------------------------------------------------------

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    for (const file of files) {
      if (!ALLOWED_TYPES.includes(file.type)) {
        App.toast('«' + file.name + '» ist kein JPEG, PNG oder WebP und wurde übersprungen.', 'error');
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        App.toast('«' + file.name + '» ist ' + ImageTools.formatBytes(file.size)
          + ' gross — erlaubt sind 15 MB. Übersprungen.', 'error');
        continue;
      }
      state.queue.push({
        key: 'q' + Date.now() + Math.random().toString(36).slice(2, 7),
        file,
        title: file.name.replace(/\.[^.]+$/, ''),
        takenAt: '',      // ISO — so geht es ans Backend
        takenAtText: '',  // was im Feld steht (Schweizer Schreibweise)
        dateError: '',
        status: 'wartet',
        message: '',
        done: false
      });
    }
    renderQueue();
  }

  function renderQueue() {
    const host = refs.queue;
    if (!host) return;
    clear(host);
    if (!state.queue.length) return;

    const box = el('div', 'adm-queue__box');
    const head = el('div', 'adm-queue__head');
    head.appendChild(el('h3', 'mb-0', 'Bereit zum Hochladen'));
    head.appendChild(el('span', 'pill', state.queue.length + ' '
      + (state.queue.length === 1 ? 'Bild' : 'Bilder')));
    box.appendChild(head);

    const list = el('div', 'adm-queue__list');
    for (const item of state.queue) list.appendChild(buildQueueItem(item));
    box.appendChild(list);

    const actions = el('div', 'row row--end adm-queue__actions');
    const clearBtn = button('Alle verwerfen', 'btn btn--ghost btn--sm', () => {
      for (const item of state.queue) releasePreview(item);
      state.queue = [];
      renderQueue();
    });
    const uploadBtn = button(
      state.queue.length === 1 ? 'Foto hochladen' : state.queue.length + ' Fotos hochladen',
      'btn btn--primary',
      () => runUploads(uploadBtn, clearBtn)
    );
    refs.uploadBtn = uploadBtn;
    actions.append(clearBtn, uploadBtn);
    box.appendChild(actions);

    host.appendChild(box);
  }

  function buildQueueItem(item) {
    const row = el('div', 'adm-queue__item');
    if (item.done) row.classList.add('adm-queue__item--done');
    if (item.status === 'fehler') row.classList.add('adm-queue__item--error');

    // Vorschau
    const thumb = el('div', 'adm-queue__thumb');
    if (!item.previewUrl) item.previewUrl = URL.createObjectURL(item.file);
    const img = el('img');
    img.src = item.previewUrl;
    img.alt = '';
    thumb.appendChild(img);
    row.appendChild(thumb);

    const fields = el('div', 'adm-queue__fields');

    const titleInput = el('input');
    titleInput.type = 'text';
    titleInput.value = item.title;
    titleInput.placeholder = 'Titel des Fotos';
    titleInput.maxLength = 200;
    titleInput.disabled = item.done;
    titleInput.addEventListener('input', () => { item.title = titleInput.value; });
    fields.appendChild(field('Titel', titleInput));

    const dInput = dateInput('');
    dInput.value = item.takenAtText || '';
    dInput.disabled = item.done;
    const dateField = field('Aufnahmedatum (optional)', dInput, App.DATE_HINT);
    if (item.dateError) setFieldError(dateField, item.dateError);
    dInput.addEventListener('input', () => {
      item.takenAtText = dInput.value;
      if (item.dateError) { item.dateError = ''; setFieldError(dateField, ''); }
    });
    dInput.addEventListener('change', () => {
      const parsed = App.parseDateInput(dInput.value);
      if (parsed.ok) {
        item.takenAt = parsed.value;
        item.dateError = '';
        setFieldError(dateField, '');
        dInput.value = App.formatDate(parsed.value) || '';
      } else {
        item.takenAt = '';
        item.dateError = parsed.message;
        setFieldError(dateField, parsed.message);
      }
      item.takenAtText = dInput.value;
    });
    fields.appendChild(dateField);

    const meta = el('p', 'tiny faint mb-0');
    meta.textContent = item.file.name + ' · ' + ImageTools.formatBytes(item.file.size);
    fields.appendChild(meta);
    row.appendChild(fields);

    // Status
    const side = el('div', 'adm-queue__side');
    const statusRow = el('div', 'adm-queue__status');
    if (item.status === 'läuft' || item.status === 'verkleinern') {
      statusRow.appendChild(el('div', 'spinner'));
    }
    const statusText = el('span', 'tiny',
      item.message || statusLabel(item.status));
    if (item.status === 'fehler') statusText.classList.add('adm-queue__status--error');
    if (item.status === 'fertig') statusText.classList.add('adm-queue__status--ok');
    statusRow.appendChild(statusText);
    side.appendChild(statusRow);

    if (item.status !== 'läuft' && item.status !== 'verkleinern') {
      side.appendChild(button('Entfernen', 'btn btn--ghost btn--sm', () => {
        releasePreview(item);
        state.queue = state.queue.filter((q) => q !== item);
        renderQueue();
      }));
    }
    row.appendChild(side);

    return row;
  }

  function statusLabel(status) {
    switch (status) {
      case 'verkleinern': return 'Wird verkleinert …';
      case 'läuft': return 'Wird hochgeladen …';
      case 'fertig': return 'Hochgeladen ✓';
      case 'fehler': return 'Fehlgeschlagen';
      default: return 'Wartet';
    }
  }

  function releasePreview(item) {
    if (item && item.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
      item.previewUrl = null;
    }
  }

  async function runUploads(uploadBtn, clearBtn) {
    const pending = state.queue.filter((i) => !i.done);
    if (!pending.length) return;

    // Datumsangaben erst nach ISO wandeln — bei einem Fehler gar nicht senden.
    let hasDateError = false;
    for (const item of pending) {
      const parsed = App.parseDateInput(item.takenAtText || '');
      if (parsed.ok) {
        item.takenAt = parsed.value;
        item.dateError = '';
      } else {
        item.takenAt = '';
        item.dateError = parsed.message;
        hasDateError = true;
      }
    }
    if (hasDateError) {
      renderQueue();
      App.toast('Bitte das Aufnahmedatum prüfen. ' + App.DATE_HINT, 'error');
      return;
    }

    uploadBtn.disabled = true;
    clearBtn.disabled = true;
    let okCount = 0;

    for (const item of pending) {
      item.status = 'verkleinern';
      item.message = '';
      renderQueue();
      try {
        const prepared = await ImageTools.resizeToFit(item.file, {
          maxEdge: MAX_EDGE,
          quality: JPEG_QUALITY,
          skipUnderBytes: SKIP_RESIZE_BYTES
        });

        item.status = 'läuft';
        item.message = prepared.resized
          ? 'Verkleinert auf ' + prepared.width + ' × ' + prepared.height + ' — wird hochgeladen …'
          : 'Wird hochgeladen …';
        renderQueue();

        const fd = new FormData();
        fd.append('file', prepared.blob, prepared.filename);
        fd.append('title', (item.title || '').trim());
        fd.append('takenAt', (item.takenAt || '').trim());
        fd.append('width', String(prepared.width));
        fd.append('height', String(prepared.height));

        await API.post('/api/photos', fd);
        item.status = 'fertig';
        item.message = '';
        item.done = true;
        okCount++;
      } catch (err) {
        item.status = 'fehler';
        item.message = err && err.message ? err.message : 'Unbekannter Fehler';
      }
      renderQueue();
    }

    // Erfolgreiche Einträge aus der Warteschlange nehmen, Fehler stehen lassen
    for (const item of state.queue.filter((i) => i.done)) releasePreview(item);
    state.queue = state.queue.filter((i) => !i.done);
    renderQueue();

    if (okCount) {
      App.toast(okCount === 1 ? 'Foto hochgeladen.' : okCount + ' Fotos hochgeladen.', 'success');
      loadPhotos();
      loadStats();
    }
    const failed = pending.length - okCount;
    if (failed) {
      App.toast(failed === 1
        ? '1 Foto konnte nicht hochgeladen werden.'
        : failed + ' Fotos konnten nicht hochgeladen werden.', 'error');
    }
  }

  // ==========================================================================
  // 4. Personen verwalten
  // ==========================================================================

  function buildPersonSection() {
    const section = el('section', 'adm-section');
    const card = el('div', 'card card--flush');

    const header = el('div', 'card__header');
    header.appendChild(el('h2', 'section-title mb-0', '👥 Personen verwalten'));
    card.appendChild(header);

    const body = el('div', 'card__body stack');

    const search = el('input');
    search.type = 'search';
    search.placeholder = 'Nach Namen suchen …';
    search.value = state.personQuery;
    search.setAttribute('aria-label', 'Personen durchsuchen');
    search.addEventListener('input', () => {
      state.personQuery = search.value;
      renderPersonList();
    });
    body.appendChild(field('Suche', search));

    refs.personList = el('div', 'adm-persons');
    body.appendChild(refs.personList);

    card.appendChild(body);
    section.appendChild(card);
    return section;
  }

  /** Anzahl Kinder — für Blutlinien-Personen wie auch für eingeheiratete Partner:innen. */
  function childCount(person) {
    const unions = (Store.data.unions || []).filter(
      (u) => Number(u.personId) === Number(person.id) || Number(u.partnerId) === Number(person.id)
    );
    let sum = 0;
    for (const u of unions) sum += Store.childrenOf(u.id).length;
    return sum;
  }

  function renderPersonList() {
    const host = refs.personList;
    if (!host) return;
    clear(host);

    if (!Store.loaded) {
      host.appendChild(loadingBlock('Personen werden geladen …'));
      return;
    }

    const all = Store.allPersons();
    const query = state.personQuery.trim().toLowerCase();
    const persons = query
      ? all.filter((p) => {
        const haystack = [p.firstName, p.lastName, p.maidenName]
          .filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(query);
      })
      : all;

    const info = el('p', 'small muted mb-0');
    info.textContent = query
      ? persons.length + ' von ' + all.length + ' Personen'
      : all.length + (all.length === 1 ? ' Person' : ' Personen');
    host.appendChild(info);

    if (!persons.length) {
      host.appendChild(emptyBlock('🔍', 'Niemand gefunden. Andere Schreibweise versuchen?'));
      return;
    }

    // Kopfzeile nur auf dem Desktop sichtbar
    const head = el('div', 'adm-person adm-person--head');
    head.setAttribute('aria-hidden', 'true');
    head.append(
      el('div', 'adm-person__main', 'Name'),
      el('div', 'adm-person__role', 'Rolle'),
      el('div', 'adm-person__life', 'Lebensdaten'),
      el('div', 'adm-person__kids', 'Kinder'),
      el('div', 'adm-person__actions', '')
    );
    host.appendChild(head);

    const list = el('div', 'adm-persons__list');
    for (const person of persons) list.appendChild(buildPersonRow(person));
    host.appendChild(list);
  }

  function buildPersonRow(person) {
    const isRoot = Number(person.id) === Number(Store.data.rootPersonId);
    const row = el('div', 'adm-person');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', 'Details zu ' + Store.displayName(person) + ' öffnen');

    const open = () => {
      if (window.PersonPanel && typeof PersonPanel.open === 'function') {
        PersonPanel.open(person.id);
      } else {
        App.toast('Das Personen-Panel ist gerade nicht verfügbar.', 'info');
      }
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
    });

    // Name + Avatar
    const main = el('div', 'adm-person__main');
    const avatar = el('div', 'avatar avatar--sm ' + Store.avatarClass(person), Store.initials(person));
    avatar.setAttribute('aria-hidden', 'true');
    const names = el('div', 'adm-person__names');
    names.appendChild(el('div', 'adm-person__name truncate', Store.displayName(person)));
    if (person.maidenName) {
      names.appendChild(el('div', 'tiny faint truncate', 'geb. ' + person.maidenName));
    }
    main.append(avatar, names);
    row.appendChild(main);

    // Rolle
    const role = el('div', 'adm-person__role');
    if (isRoot) {
      role.appendChild(el('span', 'pill pill--sun', 'Stammperson'));
    } else if (person.isPartner) {
      role.appendChild(el('span', 'pill pill--sky', 'eingeheiratet'));
    } else {
      role.appendChild(el('span', 'pill pill--mint', 'Blutlinie'));
    }
    row.appendChild(role);

    // Lebensdaten
    const life = el('div', 'adm-person__life');
    life.dataset.label = 'Lebensdaten';
    life.appendChild(el('span', 'small', Store.lifeSpan(person) || '—'));
    row.appendChild(life);

    // Kinder
    const kids = el('div', 'adm-person__kids');
    kids.dataset.label = 'Kinder';
    const n = childCount(person);
    kids.appendChild(el('span', 'small', String(n)));
    row.appendChild(kids);

    // Aktionen
    const actions = el('div', 'adm-person__actions');
    if (!isRoot) {
      const delBtn = button('Löschen', 'btn btn--danger btn--sm', (ev) => {
        ev.stopPropagation();
        askDeletePerson(person, delBtn);
      });
      actions.appendChild(delBtn);
    }
    row.appendChild(actions);

    return row;
  }

  async function askDeletePerson(person, btn) {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Prüfe …';

    let impact;
    try {
      impact = await API.get('/api/persons/' + person.id + '/impact');
    } catch (err) {
      App.toast('Auswirkung konnte nicht ermittelt werden: ' + err.message, 'error');
      btn.disabled = false;
      btn.textContent = original;
      return;
    }
    btn.disabled = false;
    btn.textContent = original;

    const personCount = Number(impact && impact.persons) || 1;
    const tagCount = Number(impact && impact.tags) || 0;
    const names = (impact && Array.isArray(impact.names)) ? impact.names : [];
    const needsTyping = personCount > CONFIRM_NAME_THRESHOLD;

    const body = el('div', 'stack--sm adm-danger');

    const lead = el('p');
    lead.textContent = personCount > 1
      ? 'Wenn du ' + Store.displayName(person) + ' löschst, verschwinden auch alle Nachkommen '
        + 'und deren Partner:innen — insgesamt ' + personCount + ' Personen.'
      : Store.displayName(person) + ' wird endgültig gelöscht.';
    body.appendChild(lead);

    const counts = el('div', 'adm-danger__counts');
    const c1 = el('div', 'adm-danger__count');
    c1.append(el('strong', null, String(personCount)),
      el('span', 'tiny', personCount === 1 ? 'Person' : 'Personen'));
    const c2 = el('div', 'adm-danger__count');
    c2.append(el('strong', null, String(tagCount)),
      el('span', 'tiny', tagCount === 1 ? 'Foto-Markierung' : 'Foto-Markierungen'));
    counts.append(c1, c2);
    body.appendChild(counts);

    if (names.length) {
      const details = el('details', 'adm-danger__names');
      details.open = names.length <= 12;
      details.appendChild(el('summary', 'small',
        'Betroffene Personen anzeigen (' + names.length + ')'));
      const ul = el('ul', 'adm-danger__list');
      for (const name of names) ul.appendChild(el('li', null, String(name)));
      details.appendChild(ul);
      body.appendChild(details);
    }

    body.appendChild(el('p', 'small adm-danger__final',
      'Das lässt sich nicht rückgängig machen.'));

    let confirmInput = null;
    let confirmField = null;
    if (needsTyping) {
      confirmInput = el('input');
      confirmInput.type = 'text';
      confirmInput.autocomplete = 'off';
      confirmInput.placeholder = person.firstName || '';
      confirmField = field(
        'Zur Bestätigung «' + (person.firstName || '') + '» eintippen',
        confirmInput
      );
      body.appendChild(confirmField);
    }

    const handle = App.modal({
      title: 'Person löschen?',
      body,
      actions: [
        { label: 'Abbrechen', variant: 'secondary' },
        {
          label: 'Endgültig löschen',
          variant: 'danger',
          onClick: async (h) => {
            if (needsTyping) {
              const typed = (confirmInput.value || '').trim().toLowerCase();
              const expected = (person.firstName || '').trim().toLowerCase();
              if (typed !== expected) {
                setFieldError(confirmField,
                  'Bitte «' + (person.firstName || '') + '» genau so eintippen.');
                confirmInput.focus();
                return;
              }
              setFieldError(confirmField, null);
            }
            await doDeletePerson(person, h);
          }
        }
      ]
    });

    if (needsTyping) setTimeout(() => confirmInput.focus(), 80);
    return handle;
  }

  async function doDeletePerson(person, handle) {
    try {
      const res = await API.del('/api/persons/' + person.id);
      const deleted = Number(res && res.deleted) || 1;
      handle.close();
      await Store.load();
      renderPersonList();
      loadStats();
      loadPhotos();
      App.toast(deleted === 1
        ? '1 Person gelöscht.'
        : deleted + ' Personen gelöscht.', 'success');
    } catch (err) {
      App.toast('Löschen fehlgeschlagen: ' + err.message, 'error');
    }
  }

  // ==========================================================================
  // 5. Passwörter ändern
  // ==========================================================================

  function passwordInput(autocomplete) {
    const input = el('input');
    input.type = 'password';
    input.autocomplete = autocomplete || 'new-password';
    input.spellcheck = false;
    return input;
  }

  /** Feld mit Auge-Knopf zum Anzeigen des Passworts. */
  function passwordField(labelText, input, hint) {
    const wrap = field(labelText, input, hint);
    const shell = el('div', 'adm-pw');
    input.parentNode.insertBefore(shell, input);
    shell.appendChild(input);

    const eye = button('👁', 'btn btn--ghost btn--icon btn--sm adm-pw__eye', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.textContent = show ? '🙈' : '👁';
      eye.setAttribute('aria-label', show ? 'Passwort verbergen' : 'Passwort anzeigen');
      eye.setAttribute('aria-pressed', String(show));
      input.focus();
    });
    eye.setAttribute('aria-label', 'Passwort anzeigen');
    eye.setAttribute('aria-pressed', 'false');
    eye.title = 'Passwort anzeigen';
    shell.appendChild(eye);
    return wrap;
  }

  function strengthOf(pw) {
    if (!pw) return { score: 0, label: '' };
    let variety = 0;
    if (/[a-zäöüàéèç]/.test(pw)) variety++;
    if (/[A-ZÄÖÜÀÉÈÇ]/.test(pw)) variety++;
    if (/\d/.test(pw)) variety++;
    if (/[^\p{L}\p{N}]/u.test(pw)) variety++;

    let score = 1;
    if (pw.length >= 8 && variety >= 2) score = 2;
    if (pw.length >= 12 || (pw.length >= 10 && variety >= 3)) score = 3;
    if (pw.length >= 16 || (pw.length >= 12 && variety >= 3)) score = 4;
    if (pw.length < MIN_PASSWORD_LENGTH) score = 1;

    const labels = ['', 'kurz', 'brauchbar', 'gut', 'sehr gut'];
    return { score, label: labels[score] };
  }

  function strengthMeter() {
    const wrap = el('div', 'adm-strength');
    const bars = el('div', 'adm-strength__bars');
    const segments = [];
    for (let i = 0; i < 4; i++) {
      const seg = el('span', 'adm-strength__seg');
      segments.push(seg);
      bars.appendChild(seg);
    }
    const label = el('span', 'tiny faint', 'Länge zählt mehr als Sonderzeichen.');
    wrap.append(bars, label);
    wrap.update = (pw) => {
      const { score, label: text } = strengthOf(pw);
      segments.forEach((seg, i) => {
        seg.dataset.on = String(i < score);
      });
      wrap.dataset.score = String(score);
      label.textContent = pw
        ? 'Stärke: ' + text
        : 'Länge zählt mehr als Sonderzeichen.';
    };
    wrap.update('');
    return wrap;
  }

  function buildPasswordSection() {
    const section = el('section', 'adm-section');
    const card = el('div', 'card card--flush');

    const header = el('div', 'card__header');
    header.appendChild(el('h2', 'section-title mb-0', '🔑 Passwörter ändern'));
    card.appendChild(header);

    const body = el('div', 'card__body');
    const form = el('form', 'stack');
    form.autocomplete = 'off';
    form.noValidate = true;

    form.appendChild(el('p', 'small muted',
      'Zum Ändern brauchst du immer das aktuelle Admin-Passwort. '
      + 'Du kannst eines von beiden neuen Passwörtern leer lassen — dann bleibt es, wie es ist. '
      + 'Mindestens ' + MIN_PASSWORD_LENGTH + ' Zeichen.'));

    // Aktuelles Admin-Passwort
    const currentInput = passwordInput('current-password');
    const currentField = passwordField('Aktuelles Admin-Passwort', currentInput);
    form.appendChild(currentField);

    form.appendChild(el('hr', 'divider'));

    // Familien-Passwort
    const famGroup = el('div', 'stack--sm adm-pwgroup');
    famGroup.appendChild(el('h3', 'adm-pwgroup__title', 'Neues Familien-Passwort'));
    famGroup.appendChild(el('p', 'tiny faint mb-0',
      'Damit kommt die Familie in die App. Leer lassen = unverändert.'));
    const famInput = passwordInput();
    const famField = passwordField('Neues Passwort', famInput);
    const famMeter = strengthMeter();
    famField.insertBefore(famMeter, famField.__error);
    const famRepeatInput = passwordInput();
    const famRepeatField = passwordField('Wiederholen', famRepeatInput);
    famGroup.append(famField, famRepeatField);
    form.appendChild(famGroup);

    // Admin-Passwort
    const admGroup = el('div', 'stack--sm adm-pwgroup');
    admGroup.appendChild(el('h3', 'adm-pwgroup__title', 'Neues Admin-Passwort'));
    admGroup.appendChild(el('p', 'tiny faint mb-0',
      'Schützt diesen Bereich. Leer lassen = unverändert.'));
    const admInput = passwordInput();
    const admField = passwordField('Neues Passwort', admInput);
    const admMeter = strengthMeter();
    admField.insertBefore(admMeter, admField.__error);
    const admRepeatInput = passwordInput();
    const admRepeatField = passwordField('Wiederholen', admRepeatInput);
    admGroup.append(admField, admRepeatField);
    form.appendChild(admGroup);

    // Überall abmelden — der Server räumt dann alle anderen Sitzungen weg.
    const logoutGroup = el('div', 'stack--sm adm-pwgroup');
    const logoutLine = el('label', 'checkline');
    const logoutBox = el('input');
    logoutBox.type = 'checkbox';
    logoutBox.id = 'adm-logout-everywhere';
    logoutLine.htmlFor = logoutBox.id;
    logoutLine.append(logoutBox, el('span', null, 'Alle anderen Geräte abmelden'));
    logoutGroup.append(logoutLine, el('p', 'tiny faint mb-0',
      'Sinnvoll, wenn ein Passwort in falsche Hände geraten ist. '
      + 'Deine eigene Anmeldung bleibt bestehen.'));
    form.appendChild(logoutGroup);

    famInput.addEventListener('input', () => famMeter.update(famInput.value));
    admInput.addEventListener('input', () => admMeter.update(admInput.value));

    const formError = el('p', 'field__error');
    formError.setAttribute('role', 'alert');
    formError.hidden = true;
    form.appendChild(formError);

    const note = el('div', 'adm-note');
    note.hidden = true;
    form.appendChild(note);

    const actions = el('div', 'row row--end');
    const submit = el('button', 'btn btn--primary', 'Passwörter speichern');
    submit.type = 'submit';
    actions.appendChild(submit);
    form.appendChild(actions);

    const allFields = [currentField, famField, famRepeatField, admField, admRepeatField];

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      for (const f of allFields) setFieldError(f, null);
      formError.hidden = true;
      note.hidden = true;

      const current = currentInput.value;
      const fam = famInput.value;
      const famRepeat = famRepeatInput.value;
      const adm = admInput.value;
      const admRepeat = admRepeatInput.value;

      let firstBad = null;
      const fail = (fieldWrap, message, input) => {
        setFieldError(fieldWrap, message);
        if (!firstBad) firstBad = input;
      };

      if (!current) fail(currentField, 'Bitte das aktuelle Admin-Passwort eingeben.', currentInput);

      if (!fam && !adm) {
        formError.textContent = 'Bitte mindestens ein neues Passwort setzen.';
        formError.hidden = false;
        if (!firstBad) firstBad = famInput;
      }

      if (fam) {
        if (fam.length < MIN_PASSWORD_LENGTH) {
          fail(famField, 'Mindestens ' + MIN_PASSWORD_LENGTH + ' Zeichen.', famInput);
        } else if (fam !== famRepeat) {
          fail(famRepeatField, 'Die Wiederholung stimmt nicht überein.', famRepeatInput);
        }
      } else if (famRepeat) {
        fail(famField, 'Oben fehlt das neue Familien-Passwort.', famInput);
      }

      if (adm) {
        if (adm.length < MIN_PASSWORD_LENGTH) {
          fail(admField, 'Mindestens ' + MIN_PASSWORD_LENGTH + ' Zeichen.', admInput);
        } else if (adm !== admRepeat) {
          fail(admRepeatField, 'Die Wiederholung stimmt nicht überein.', admRepeatInput);
        }
      } else if (admRepeat) {
        fail(admField, 'Oben fehlt das neue Admin-Passwort.', admInput);
      }

      if (firstBad) { firstBad.focus(); return; }

      const payload = { currentAdminPassword: current };
      if (fam) payload.familyPassword = fam;
      if (adm) payload.adminPassword = adm;
      // Nur mitschicken, wenn wirklich angehakt — sonst bleibt alles angemeldet.
      if (logoutBox.checked) payload.logoutEverywhere = true;

      submit.disabled = true;
      const label = submit.textContent;
      submit.textContent = 'Moment …';
      try {
        const res = await API.post('/api/admin/passwords', payload);
        form.reset();
        famMeter.update('');
        admMeter.update('');

        // Der Server meldet, wie viele fremde Sitzungen er geräumt hat.
        const revoked = Number(res && res.sessionsRevoked) || 0;
        const sessionNote = revoked > 0
          ? (revoked === 1
            ? '1 anderes Gerät wurde abgemeldet.'
            : revoked + ' andere Geräte wurden abgemeldet.')
          : 'Bestehende Anmeldungen bleiben bestehen.';

        clear(note);
        note.appendChild(el('span', 'adm-note__icon', '✅'));
        const noteText = el('div');
        noteText.appendChild(el('strong', null, 'Gespeichert.'));
        noteText.appendChild(el('p', 'small mb-0',
          (fam ? 'Neues Familien-Passwort im Familien-Chat verteilen. ' : '') + sessionNote));
        note.appendChild(noteText);
        note.hidden = false;

        App.toast('Passwörter aktualisiert.', 'success');
      } catch (err) {
        // 403 kommt aus zwei Richtungen: falsches aktuelles Passwort
        // ('wrong_password') oder abgelaufener Adminmodus ('forbidden').
        // Nur der erste Fall gehört ans Passwortfeld.
        if (err && err.code === 'wrong_password') {
          setFieldError(currentField, 'Das aktuelle Admin-Passwort stimmt nicht.');
          currentInput.focus();
        } else {
          formError.textContent = err && err.message ? err.message : 'Speichern fehlgeschlagen.';
          formError.hidden = false;
        }
      } finally {
        submit.disabled = false;
        submit.textContent = label;
      }
    });

    body.appendChild(form);
    card.appendChild(body);
    section.appendChild(card);
    return section;
  }

  window.AdminView = AdminView;
})();
