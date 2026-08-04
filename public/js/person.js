/* Stammbauminator — Personen-Detailpanel
   Globals: window.PersonPanel
   Zeigt eine Person im seitlichen Panel (mobil: Bottom-Sheet), erlaubt
   Bearbeiten und Löschen mit Auswirkungs-Warnung (Vorname eintippen). */
(function () {
  'use strict';

  // --- Modulzustand ---------------------------------------------------------

  let root = null;                 // Mountpoint (#person-panel)
  let backdrop = null;             // .panel-backdrop
  let panel = null;                // .panel
  let bodyEl = null;               // scrollender Inhaltsbereich
  let headEl = null;               // Kopfbereich
  let footEl = null;               // Fussbereich

  let currentId = null;            // aktuell gezeigte Person
  let navStack = [];               // Verlauf für die Zurück-Navigation
  let isOpen = false;
  let editing = false;
  let lastFocused = null;          // auslösendes Element
  let prevBodyOverflow = '';

  let photosCache = null;          // Photo[] | null
  let photosPromise = null;

  const SWIPE_CLOSE_PX = 90;

  // --- Portrait -------------------------------------------------------------

  const PORTRAIT_SIZE = 104;                        // Kantenlänge des Avatars im Kopf
  const PORTRAIT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const PORTRAIT_MAX_BYTES = 15 * 1024 * 1024;      // wie das Serverlimit
  const PORTRAIT_MAX_EDGE = 600;                    // längste Kante nach dem Zuschneiden
  const PORTRAIT_QUALITY = 0.85;

  // --- Öffentliche API ------------------------------------------------------

  const PersonPanel = {
    mount(rootElement) {
      root = rootElement;
      // Die Panel-Styles kommen aus css/person.css (in index.html eingebunden).
      // Frueher wurden sie hier zur Laufzeit als <style>-Block eingehaengt —
      // das verlangte 'unsafe-inline' in der style-src-Richtlinie der CSP.
      buildShell();

      Store.subscribe(() => {
        // Fotos können sich geändert haben (neue Markierungen, neue Bilder)
        photosCache = null;
        photosPromise = null;
        if (!isOpen) return;
        if (!Store.person(currentId)) { PersonPanel.close(); return; }
        if (!editing) render();
      });
      // Kein App.onRoleChange mehr: Der Fussbereich hängt nicht mehr von der
      // Rolle ab — Bearbeiten und Löschen stehen allen Angemeldeten offen.
    },

    open(personId) {
      const id = Number(personId);
      const person = Store.person(id);
      if (!person) {
        App.toast('Diese Person ist nicht (mehr) im Stammbaum.', 'info');
        return;
      }

      if (isOpen && currentId != null && currentId !== id) {
        navStack.push(currentId);      // Sprung innerhalb des Panels merken
      } else if (!isOpen) {
        navStack = [];
        lastFocused = document.activeElement;
      }

      currentId = id;
      editing = false;

      if (!isOpen) showShell();
      render();

      if (bodyEl) bodyEl.scrollTop = 0;
      setTimeout(() => { if (panel) panel.focus(); }, 40);
    },

    close() {
      if (!isOpen) return;
      isOpen = false;
      editing = false;
      currentId = null;
      navStack = [];

      // Inline-display statt [hidden]: `.panel { display: flex }` aus tokens.css
      // hätte höhere Priorität als die UA-Regel `[hidden] { display: none }`.
      hide(backdrop);
      hide(panel);
      panel.style.transform = '';
      document.body.style.overflow = prevBodyOverflow;

      if (lastFocused && document.contains(lastFocused)) {
        try { lastFocused.focus(); } catch (err) { /* egal */ }
      }
      lastFocused = null;
    }
  };

  // --- Grundgerüst ----------------------------------------------------------

  function buildShell() {
    backdrop = document.createElement('div');
    backdrop.className = 'panel-backdrop pp-backdrop';
    backdrop.addEventListener('mousedown', (ev) => {
      if (ev.target === backdrop) PersonPanel.close();
    });

    panel = document.createElement('aside');
    panel.className = 'panel pp';
    panel.tabIndex = -1;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Personendetails');

    const grip = document.createElement('div');
    grip.className = 'pp-grip';
    grip.setAttribute('aria-hidden', 'true');

    headEl = document.createElement('header');
    headEl.className = 'pp-head';

    bodyEl = document.createElement('div');
    bodyEl.className = 'pp-body';

    footEl = document.createElement('footer');
    footEl.className = 'pp-foot';

    panel.append(grip, headEl, bodyEl, footEl);
    hide(backdrop);
    hide(panel);
    root.append(backdrop, panel);

    panel.addEventListener('keydown', onPanelKeydown);
    document.addEventListener('keydown', onDocumentKeydown);
    wireSwipe();
  }

  function showShell() {
    isOpen = true;
    prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    show(backdrop);
    show(panel);
    // Animationen aus tokens.css erneut auslösen
    panel.style.animation = 'none';
    void panel.offsetWidth;
    panel.style.animation = '';
  }

  // --- Tastatur & Fokus -----------------------------------------------------

  function onDocumentKeydown(ev) {
    if (ev.key !== 'Escape' || !isOpen) return;
    // Liegt ein Modal darüber, gehört Escape dem Modal (App regelt das selbst).
    if (document.querySelector('#modals .modal-backdrop')) return;
    ev.preventDefault();
    PersonPanel.close();
  }

  function onPanelKeydown(ev) {
    if (ev.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) { ev.preventDefault(); panel.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;

    if (ev.shiftKey && (active === first || active === panel || !panel.contains(active))) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  function focusables() {
    return Array.from(panel.querySelectorAll(
      'a[href], button:not(:disabled), input:not(:disabled):not([type=hidden]),' +
      'textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )).filter((el) => el.offsetParent !== null || el === document.activeElement);
  }

  // --- Wisch-Geste (mobiles Bottom-Sheet) -----------------------------------

  function wireSwipe() {
    let startY = 0;
    let delta = 0;
    let active = false;

    const isSheet = () => window.matchMedia('(max-width: 767px)').matches;

    panel.addEventListener('touchstart', (ev) => {
      if (!isSheet() || ev.touches.length !== 1) return;
      // Nur ziehen, wenn der Inhalt oben steht — sonst scrollt man normal.
      if (bodyEl.contains(ev.target) && bodyEl.scrollTop > 0) return;
      active = true;
      startY = ev.touches[0].clientY;
      delta = 0;
      panel.style.transition = 'none';
    }, { passive: true });

    panel.addEventListener('touchmove', (ev) => {
      if (!active) return;
      delta = ev.touches[0].clientY - startY;
      if (delta <= 0) { panel.style.transform = ''; return; }
      if (ev.cancelable) ev.preventDefault();
      panel.style.transform = 'translateY(' + delta + 'px)';
    }, { passive: false });

    const end = () => {
      if (!active) return;
      active = false;
      panel.style.transition = '';
      if (delta > SWIPE_CLOSE_PX) {
        PersonPanel.close();
      } else {
        panel.style.transform = '';
      }
      delta = 0;
    };

    panel.addEventListener('touchend', end);
    panel.addEventListener('touchcancel', end);
  }

  // --- Rendern --------------------------------------------------------------

  function render() {
    const person = Store.person(currentId);
    if (!person) { PersonPanel.close(); return; }

    panel.setAttribute('aria-label', 'Details zu ' + Store.displayName(person));
    renderHeader(person);
    if (editing) renderEditForm(person);
    else renderReadView(person);
    renderFooter();
  }

  function renderHeader(person) {
    headEl.textContent = '';

    const bar = el('div', 'pp-head__bar');
    if (navStack.length) {
      const back = button('← Zurück', 'btn btn--ghost btn--sm');
      back.setAttribute('aria-label', 'Zurück zur vorherigen Person');
      back.addEventListener('click', goBack);
      bar.append(back);
    } else {
      bar.append(el('span', 'pp-head__spacer'));
    }
    bar.append(el('span', 'spacer'));

    const close = button('✕', 'btn btn--ghost btn--icon btn--sm');
    close.setAttribute('aria-label', 'Panel schliessen');
    close.addEventListener('click', () => PersonPanel.close());
    bar.append(close);
    headEl.append(bar);

    const ident = el('div', 'pp-ident');
    const avatar = el('div', 'avatar pp-avatar ' + Store.avatarClass(person));
    const source = applyPortrait(avatar, person);
    avatar.setAttribute('aria-hidden', 'true');

    const names = el('div', 'pp-ident__text');
    names.append(el('h2', 'pp-name', Store.displayName(person)));

    if (person.maidenName) {
      names.append(el('div', 'pp-sub small muted', 'geborene ' + person.maidenName));
    }
    const span = Store.lifeSpan(person);
    if (span) names.append(el('div', 'pp-sub small muted', span));

    const pills = el('div', 'pp-pills');
    if (person.isPartner) pills.append(el('span', 'pill pill--sky', 'eingeheiratet'));
    if (Number(Store.data.rootPersonId) === Number(person.id)) {
      pills.append(el('span', 'pill pill--sun', 'Stammperson'));
    }
    if (Store.isDeceased(person)) pills.append(el('span', 'pill', 'verstorben'));
    if (pills.childNodes.length) names.append(pills);

    ident.append(avatar, names);
    headEl.append(ident);
    headEl.append(portraitControls(person, source));
  }

  // --- Portrait pflegen -----------------------------------------------------

  /** Setzt Bild bzw. Initialen auf den Avatar und liefert die verwendete Quelle. */
  function applyPortrait(avatar, person) {
    if (window.Portrait && typeof Portrait.apply === 'function') {
      return Portrait.apply(avatar, person, PORTRAIT_SIZE);
    }
    avatar.textContent = Store.initials(person);
    return { kind: 'initials' };
  }

  /**
   * Knöpfe und Hinweistext unter dem Avatar: hochladen, ersetzen, entfernen.
   * `source` ist das Ergebnis von Portrait.apply — daraus ergibt sich der Hinweis.
   */
  function portraitControls(person, source) {
    const box = el('div', 'pp-portrait');

    const status = el('p', 'pp-portrait__status tiny faint');
    status.setAttribute('role', 'status');

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = PORTRAIT_TYPES.join(',');
    input.hidden = true;                 // display:none — bleibt aus der Fokus-Falle draussen

    const hasOwn = Boolean(person.portraitUrl);
    const actions = el('div', 'pp-portrait__actions');

    const upload = button(hasOwn ? 'Portrait ersetzen' : 'Portrait hochladen',
      'btn btn--secondary');
    upload.addEventListener('click', () => input.click());
    actions.append(upload);

    let remove = null;
    if (hasOwn) {
      remove = button('Entfernen', 'btn btn--ghost');
      remove.addEventListener('click', () =>
        handlePortraitRemove(person, upload, remove, status));
      actions.append(remove);
    }

    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.value = '';                  // gleiche Datei erneut wählbar machen
      if (file) handlePortraitUpload(person, file, upload, remove, status);
    });

    box.append(actions, input, status);
    setPortraitHint(status, person, source);
    return box;
  }

  function setPortraitHint(status, person, source) {
    const kind = (source && source.kind) || 'initials';
    if (kind === 'crop') {
      const photo = window.Portrait ? Portrait.sourcePhoto(person) : null;
      const title = (photo && photo.title) || '';
      setStatus(status, title
        ? 'Ausschnitt aus dem Gruppenfoto «' + title + '».'
        : 'Ausschnitt aus einem Gruppenfoto.', false);
    } else if (kind === 'initials') {
      setStatus(status, 'Noch kein Bild — lade ein Portrait hoch oder markiere '
        + Store.displayName(person) + ' auf einem Gruppenfoto.', false);
    } else {
      setStatus(status, '', false);
    }
  }

  function setStatus(status, message, isError) {
    status.textContent = message || '';
    status.hidden = !message;
    status.classList.toggle('pp-portrait__status--error', Boolean(isError));
  }

  async function handlePortraitUpload(person, file, upload, remove, status) {
    const problem = validatePortraitFile(file);
    if (problem) {
      setStatus(status, problem, true);
      App.toast(problem, 'error');
      return;
    }

    const label = upload.textContent;
    upload.disabled = true;
    if (remove) remove.disabled = true;
    upload.textContent = 'Lädt hoch …';
    setStatus(status, 'Bild wird vorbereitet …', false);

    try {
      const prepared = await ImageTools.squareCrop(file, {
        maxEdge: PORTRAIT_MAX_EDGE,
        quality: PORTRAIT_QUALITY
      });
      const formData = new FormData();
      formData.append('file', prepared.blob, prepared.filename);
      await API.post('/api/persons/' + person.id + '/portrait', formData);
      await refreshAfterPortraitChange();
      App.toast('Portrait gespeichert.', 'success');
    } catch (err) {
      const message = (err && err.message) || 'Hochladen fehlgeschlagen.';
      if (status.isConnected) setStatus(status, message, true);
      App.toast(message, 'error');
    } finally {
      if (upload.isConnected) {
        upload.disabled = false;
        upload.textContent = label;
      }
      if (remove && remove.isConnected) remove.disabled = false;
    }
  }

  async function handlePortraitRemove(person, upload, remove, status) {
    // Nach dem Entfernen greift automatisch der Ausschnitt aus dem Gruppenfoto,
    // sofern es einen gibt — `sourcePhoto` kennt ihn unabhängig vom Portrait.
    const photo = window.Portrait ? Portrait.sourcePhoto(person) : null;
    const fallback = photo
      ? ' Angezeigt wird danach der Ausschnitt aus dem Gruppenfoto «'
        + (photo.title || 'ohne Titel') + '».'
      : ' Angezeigt werden danach wieder die Initialen.';

    const ok = await App.confirm({
      title: 'Portrait entfernen?',
      message: 'Das hochgeladene Portrait von ' + Store.displayName(person)
        + ' wird gelöscht.' + fallback,
      confirmLabel: 'Entfernen',
      danger: true
    });
    if (!ok) return;

    const label = remove.textContent;
    remove.disabled = true;
    upload.disabled = true;
    remove.textContent = 'Entfernt …';

    try {
      await API.del('/api/persons/' + person.id + '/portrait');
      await refreshAfterPortraitChange();
      App.toast('Portrait entfernt.', 'success');
    } catch (err) {
      const message = (err && err.message) || 'Entfernen fehlgeschlagen.';
      if (status.isConnected) setStatus(status, message, true);
      App.toast(message, 'error');
    } finally {
      if (remove.isConnected) {
        remove.disabled = false;
        remove.textContent = label;
      }
      if (upload.isConnected) upload.disabled = false;
    }
  }

  /** Fotos und Stammbaum neu laden, danach das Panel aktualisieren. */
  async function refreshAfterPortraitChange() {
    if (window.Portrait) {
      Portrait.invalidate();
      await Portrait.load(true);
    }
    photosCache = null;
    photosPromise = null;
    await Store.load();          // der Store-Subscriber rendert das Panel neu
    if (!isOpen) return;
    const fresh = Store.person(currentId);
    if (!fresh) { PersonPanel.close(); return; }
    // Im Formularmodus rendert der Subscriber nicht — Kopfbereich selbst auffrischen.
    if (editing) renderHeader(fresh);
  }

  function validatePortraitFile(file) {
    if (!file) return 'Es wurde keine Datei ausgewählt.';
    if (!PORTRAIT_TYPES.includes(file.type)) {
      return 'Nur JPEG, PNG oder WebP sind als Portrait erlaubt.';
    }
    if (file.size > PORTRAIT_MAX_BYTES) {
      return 'Das Bild ist ' + ImageTools.formatBytes(file.size)
        + ' gross — erlaubt sind höchstens 15 MB.';
    }
    return null;
  }

  function goBack() {
    const prev = navStack.pop();
    if (prev == null) return;
    if (!Store.person(prev)) { render(); return; }
    currentId = Number(prev);
    editing = false;
    render();
    bodyEl.scrollTop = 0;
  }

  // --- Leseansicht ----------------------------------------------------------

  function renderReadView(person) {
    bodyEl.textContent = '';
    bodyEl.append(contactSection(person));

    const dates = datesSection(person);
    if (dates) bodyEl.append(dates);

    if (person.notes) {
      const sec = section('Notizen');
      const p = el('p', 'pp-notes', person.notes);
      sec.append(p);
      bodyEl.append(sec);
    }

    bodyEl.append(familySection(person));

    const photoSec = section('Auf Fotos');
    const placeholder = el('p', 'small faint', 'Fotos werden geladen …');
    photoSec.append(placeholder);
    bodyEl.append(photoSec);
    fillPhotos(photoSec, person.id);
  }

  function contactSection(person) {
    const sec = section('Kontakt');
    const list = el('div', 'pp-list');
    let any = false;

    if (person.address) {
      any = true;
      const a = link(
        'https://www.openstreetmap.org/search?query=' + encodeURIComponent(person.address),
        person.address
      );
      a.target = '_blank';
      // `noreferrer` zusätzlich zu `noopener`: ohne das erführe OpenStreetMap über
      // den Referer die Adresse dieser Instanz. In der App stehen Daten von
      // Minderjährigen — wo die Familie ihren Stammbaum betreibt, geht Dritte
      // nichts an.
      a.rel = 'noopener noreferrer';
      list.append(infoRow('🏠', 'Adresse', a));
    }
    if (person.phone) {
      any = true;
      list.append(infoRow('📞', 'Telefon',
        link('tel:' + person.phone.replace(/\s+/g, ''), person.phone)));
    }
    if (person.email) {
      any = true;
      list.append(infoRow('✉️', 'E-Mail', link('mailto:' + person.email, person.email)));
    }

    if (!any) {
      sec.append(el('p', 'small faint',
        'Noch keine Kontaktdaten erfasst. Über «Bearbeiten» kannst du sie ergänzen.'));
    } else {
      sec.append(list);
    }
    return sec;
  }

  function datesSection(person) {
    if (!person.birthDate && !person.deathDate) return null;
    const sec = section('Daten');
    const list = el('div', 'pp-list');
    if (person.birthDate) {
      list.append(infoRow('🎂', 'Geboren', text(App.formatDate(person.birthDate))));
    }
    if (person.deathDate) {
      list.append(infoRow('🕯️', 'Gestorben', text(App.formatDate(person.deathDate))));
    }
    sec.append(list);
    return sec;
  }

  function familySection(person) {
    const sec = section('Familie');
    let any = false;

    const parents = Store.parentsOf(person.id);
    if (parents.length) {
      any = true;
      sec.append(subTitle('Eltern'));
      const box = el('div', 'stack--sm');
      for (const p of parents) box.append(personRow(p));
      sec.append(box);
    }

    // `unionsInvolving` statt `unionsOf`: findet auch die Unions, in denen die
    // Person die eingeheiratete Partner:in ist — sonst hätte sie hier weder
    // Partner:in noch Kinder.
    const unions = Store.unionsInvolving(person.id);
    const partnerRows = [];
    for (const u of unions) {
      const other = Store.spouseIn(u, person.id);
      if (!other && !u.note) continue;
      const meta = [];
      meta.push(u.isCurrent
        ? { pill: 'pill--mint', label: 'aktuelle Partnerschaft' }
        : { pill: '', label: 'frühere Partnerschaft' });
      const row = other
        ? personRow(other, meta, u.note)
        : noteOnlyRow(u.note, meta);
      partnerRows.push(row);
    }
    if (partnerRows.length) {
      any = true;
      sec.append(subTitle(partnerRows.length > 1 ? 'Partnerschaften' : 'Partnerschaft'));
      const box = el('div', 'stack--sm');
      for (const r of partnerRows) box.append(r);
      sec.append(box);
    }

    const childBoxes = [];
    for (const u of unions) {
      const kids = Store.childrenOf(u.id);
      if (!kids.length) continue;
      // Die Überschrift nennt die jeweils andere Person der Partnerschaft —
      // aus Sicht der angezeigten Person, nie sie selbst.
      const other = Store.spouseIn(u, person.id);
      const box = el('div', 'pp-childgroup stack--sm');
      if (other) box.append(el('div', 'tiny faint', 'mit ' + Store.displayName(other)));
      for (const k of kids) box.append(personRow(k));
      childBoxes.push(box);
    }
    if (childBoxes.length) {
      any = true;
      sec.append(subTitle(
        Store.childrenOfPerson(person.id).length === 1 ? 'Kind' : 'Kinder'));
      for (const b of childBoxes) sec.append(b);
    }

    if (!any) {
      sec.append(el('p', 'small faint', 'Keine Familienangaben hinterlegt.'));
    }
    return sec;
  }

  function personRow(person, meta, note) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pp-person';

    const avatar = el('span', 'avatar avatar--sm ' + Store.avatarClass(person),
      Store.initials(person));
    avatar.setAttribute('aria-hidden', 'true');

    const textBox = el('span', 'pp-person__text');
    const line = el('span', 'pp-person__name', Store.displayName(person));
    textBox.append(line);

    const sub = [];
    const span = Store.lifeSpan(person);
    if (span) sub.push(span);
    if (note) sub.push(note);
    if (sub.length) textBox.append(el('span', 'pp-person__sub tiny muted', sub.join(' · ')));

    btn.append(avatar, textBox);

    if (meta && meta.length) {
      const pillBox = el('span', 'pp-person__pills');
      for (const m of meta) pillBox.append(el('span', 'pill ' + m.pill, m.label));
      btn.append(pillBox);
    }

    btn.addEventListener('click', () => PersonPanel.open(person.id));
    return btn;
  }

  function noteOnlyRow(note, meta) {
    const row = el('div', 'pp-person pp-person--static');
    const textBox = el('span', 'pp-person__text');
    textBox.append(el('span', 'pp-person__name muted', 'Partner:in nicht erfasst'));
    if (note) textBox.append(el('span', 'pp-person__sub tiny muted', note));
    row.append(textBox);
    if (meta && meta.length) {
      const pillBox = el('span', 'pp-person__pills');
      for (const m of meta) pillBox.append(el('span', 'pill ' + m.pill, m.label));
      row.append(pillBox);
    }
    return row;
  }

  // --- Fotos ----------------------------------------------------------------

  function loadPhotos() {
    if (photosCache) return Promise.resolve(photosCache);
    if (photosPromise) return photosPromise;
    photosPromise = API.get('/api/photos')
      .then((list) => {
        photosCache = Array.isArray(list) ? list : [];
        photosPromise = null;
        return photosCache;
      })
      .catch((err) => {
        photosPromise = null;
        throw err;
      });
    return photosPromise;
  }

  function fillPhotos(sec, personId) {
    const targetId = Number(personId);
    loadPhotos().then((photos) => {
      // Panel könnte inzwischen geschlossen oder umgeschaltet worden sein
      if (!isOpen || Number(currentId) !== targetId || !sec.isConnected) return;
      const hits = photos.filter((ph) =>
        (ph.tags || []).some((t) => Number(t.personId) === targetId));

      const old = sec.querySelector('.pp-photos, p');
      if (old) old.remove();

      if (!hits.length) {
        sec.append(el('p', 'small faint', 'Auf noch keinem Foto markiert.'));
        return;
      }

      const grid = el('div', 'pp-photos');
      for (const ph of hits) grid.append(photoThumb(ph, targetId));
      sec.append(grid);
    }).catch(() => {
      if (!sec.isConnected) return;
      const old = sec.querySelector('p');
      if (old) old.remove();
      sec.append(el('p', 'small faint', 'Fotos konnten nicht geladen werden.'));
    });
  }

  function photoThumb(photo, personId) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pp-photo';
    btn.title = photo.title || 'Foto öffnen';

    const img = document.createElement('img');
    img.src = photo.url;
    img.alt = photo.title || 'Foto';
    img.loading = 'lazy';
    btn.append(img);

    btn.addEventListener('click', () => {
      PersonPanel.close();
      App.showTab('photos');
      if (window.PhotoAlbum && typeof window.PhotoAlbum.openPhoto === 'function') {
        try { window.PhotoAlbum.openPhoto(photo.id, personId); }
        catch (err) { console.warn('Foto konnte nicht geöffnet werden', err); }
      }
    });
    return btn;
  }

  // --- Fussbereich ----------------------------------------------------------

  function renderFooter() {
    footEl.textContent = '';
    if (editing) return;                      // Aktionen stehen im Formular

    const person = Store.person(currentId);
    if (!person) return;

    const editBtn = button('Bearbeiten', 'btn btn--sun');
    editBtn.addEventListener('click', () => {
      editing = true;
      render();
      const first = bodyEl.querySelector('input');
      if (first) first.focus();
    });
    footEl.append(editBtn);

    // Kontaktkarte nur anbieten, wenn sie im Adressbuch etwas wert ist: eine
    // Karte mit blossem Namen (und vielleicht einem Geburtstag) erspart
    // niemandem das Abtippen. Entscheidend sind Telefon, E-Mail oder Adresse.
    if (hasContactData(person)) {
      const vcf = button('Zu Kontakten hinzufügen', 'btn btn--secondary');
      vcf.setAttribute('aria-label',
        Store.displayName(person) + ' zu den Kontakten des Geräts hinzufügen');
      vcf.title = 'Kontaktkarte (.vcf) erzeugen und ans Gerät übergeben';
      vcf.addEventListener('click', () => handleContactExport(person, vcf));
      footEl.append(vcf);
    }

    // Löschen darf jede:r mit gültiger Familien-Session — nur die Wurzelperson
    // bleibt geschützt (sie trägt im Kopfbereich die Pille «Stammperson»).
    const isRoot = Number(Store.data.rootPersonId) === Number(person.id);
    if (!isRoot) {
      // Kein `.spacer`-Element mehr: Der Fussbereich darf jetzt umbrechen, und
      // ein wachsender Platzhalter landete dann als Geisterzeile im Umbruch.
      // `margin-left: auto` hält den Löschen-Knopf in jeder Zeile rechts.
      const del = button('Person löschen', 'btn btn--danger pp-foot__end');
      del.addEventListener('click', () => handleDelete(person, del));
      footEl.append(del);
    }
  }

  // --- Kontakt-Export (vCard) -----------------------------------------------

  /*
   * Version 3.0 statt 4.0: iOS-Kontakte und die Android-Kontakte-App lesen 3.0
   * zuverlässig, 4.0 wird von älteren Geräten teils gar nicht erkannt. 3.0 hat
   * ausserdem `LABEL` für die Adresse als lesbaren Fliesstext — genau das, was
   * hier vorliegt (siehe `addressParts`).
   */
  const VCARD_VERSION = '3.0';
  const VCARD_FOLD_OCTETS = 75;                 // RFC 2426: höchstens 75 Oktette je Zeile
  const VCARD_PHOTO_MAX_EDGE = 240;             // reicht für die Kontaktliste
  const VCARD_PHOTO_QUALITY = 0.7;
  const VCARD_PHOTO_MAX_BASE64 = 64 * 1024;     // darüber bleibt das Bild weg

  /** Lohnt sich eine Kontaktkarte? Nur mit Telefon, E-Mail oder Adresse. */
  function hasContactData(person) {
    if (!person) return false;
    return Boolean(String(person.phone || '').trim()
      || String(person.email || '').trim()
      || String(person.address || '').trim());
  }

  /**
   * Sonderzeichen nach RFC 2426 maskieren. Reihenfolge zwingend: zuerst der
   * Backslash, sonst würde er die danach erzeugten Escapes selbst verdoppeln.
   */
  function vcEscape(value) {
    return String(value == null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/\r\n|\r|\n/g, '\\n')
      .replace(/,/g, '\\,')
      .replace(/;/g, '\\;');
  }

  /**
   * Lange Zeilen falten: Fortsetzungszeilen beginnen mit einem Leerzeichen.
   * Gezählt werden Oktette (UTF-8), nicht Zeichen — sonst sprengt ein Umlaut
   * die Grenze. Umbrochen wird nur zwischen ganzen Zeichen.
   */
  function vcFold(line) {
    const encoder = new TextEncoder();
    if (encoder.encode(line).length <= VCARD_FOLD_OCTETS) return line;

    const out = [];
    let current = '';
    let octets = 0;
    for (const ch of line) {
      const size = encoder.encode(ch).length;
      if (octets + size > VCARD_FOLD_OCTETS) {
        out.push(current);
        current = ' ' + ch;
        octets = 1 + size;
      } else {
        current += ch;
        octets += size;
      }
    }
    out.push(current);
    return out.join('\r\n');
  }

  /**
   * Freitext-Adresse auf die ADR-Bestandteile verteilen. Zerlegt wird nur, was
   * sich sicher erkennen lässt: eine Landangabe am Schluss und eine Zeile
   * «PLZ Ort». Alles andere bleibt zusammen in der Strassenzeile — lieber
   * ungeteilt als falsch geteilt. Der volle Text steht zusätzlich in `LABEL`.
   */
  const ADDRESS_COUNTRIES = ['schweiz', 'suisse', 'svizzera', 'switzerland',
    'deutschland', 'germany', 'österreich', 'oesterreich', 'austria',
    'liechtenstein', 'frankreich', 'france', 'italien', 'italia'];

  function addressParts(raw) {
    const text = String(raw || '').trim();
    const source = /\r|\n/.test(text) ? text.split(/\r\n|\r|\n/) : text.split(',');
    const parts = source.map((s) => s.trim()).filter(Boolean);
    const result = { street: text, locality: '', code: '', country: '' };
    if (!parts.length) return result;

    if (parts.length > 1
      && ADDRESS_COUNTRIES.includes(parts[parts.length - 1].toLocaleLowerCase('de-CH'))) {
      result.country = parts.pop();
    }
    // «1234 Musterstadt», «CH-1234 Musterstadt», «D-12345 Musterdorf»
    const zip = parts.length > 1
      ? parts[parts.length - 1].match(/^(?:[A-Za-z]{1,3}-)?(\d{4,6})\s+(.+)$/)
      : null;
    if (zip) {
      parts.pop();
      result.code = zip[1];
      result.locality = zip[2].trim();
      result.street = parts.join(', ');
    } else if (result.country) {
      result.street = parts.join(', ');
    }
    return result;
  }

  /** Erkennt Schweizer Mobilnummern (07x) — sonst gilt die Nummer als Festnetz. */
  function phoneType(phone) {
    const digits = String(phone || '').replace(/[^\d+]/g, '');
    return /^(?:\+41|0041|0)7[5-9]/.test(digits) ? 'CELL,VOICE' : 'HOME,VOICE';
  }

  /**
   * Baut die vCard. `photoLine` ist eine fertige PHOTO-Zeile oder null.
   * @returns {string} vollständige vCard, Zeilen mit CRLF abgeschlossen
   */
  function buildVCard(person, photoLine) {
    const first = String(person.firstName || '').trim();
    const last = String(person.lastName || '').trim();
    const lines = [];

    lines.push('BEGIN:VCARD');
    lines.push('VERSION:' + VCARD_VERSION);      // muss direkt auf BEGIN folgen
    // N: Nachname;Vorname;weitere Namen;Präfix;Suffix
    lines.push('N:' + vcEscape(last) + ';' + vcEscape(first) + ';;;');
    lines.push('FN:' + vcEscape(Store.displayName(person)));

    // Ledigname: `X-MAIDENNAME` kennen Apple- und Android-Kontakte, unbekannte
    // X-Eigenschaften ignorieren alle anderen. Damit die Angabe garantiert
    // sichtbar ankommt, steht sie zusätzlich in der Notiz.
    const maiden = String(person.maidenName || '').trim();
    if (maiden) lines.push('X-MAIDENNAME:' + vcEscape(maiden));

    const phone = String(person.phone || '').trim();
    if (phone) lines.push('TEL;TYPE=' + phoneType(phone) + ':' + vcEscape(phone));

    const email = String(person.email || '').trim();
    if (email) lines.push('EMAIL;TYPE=INTERNET,HOME:' + vcEscape(email));

    const address = String(person.address || '').trim();
    if (address) {
      const adr = addressParts(address);
      lines.push('ADR;TYPE=HOME:;;' + vcEscape(adr.street) + ';'
        + vcEscape(adr.locality) + ';;' + vcEscape(adr.code) + ';'
        + vcEscape(adr.country));
      // LABEL trägt den Freitext so, wie er erfasst wurde — Adressbücher zeigen
      // ihn unverändert an, auch wenn die Zerlegung oben nichts hergab.
      lines.push('LABEL;TYPE=HOME:' + vcEscape(address));
    }

    // BDAY nur bei vollständigem Datum: vCard 3.0 kennt keine Teilangaben,
    // ein «2000» oder «2000-01» landete im Adressbuch als 1. Januar oder
    // würde ganz verworfen. Unvollständige Daten gehen deshalb in die Notiz.
    const birth = String(person.birthDate || '').trim();
    const noteParts = [];
    if (maiden) noteParts.push('geborene ' + maiden);
    if (/^\d{4}-\d{2}-\d{2}$/.test(birth)) {
      lines.push('BDAY:' + birth);
    } else if (birth) {
      noteParts.push('Geburtsdatum: ' + App.formatDate(birth) + ' (unvollständig)');
    }

    const notes = String(person.notes || '').trim();
    if (notes) noteParts.push(notes);
    if (noteParts.length) lines.push('NOTE:' + vcEscape(noteParts.join('\n')));

    if (photoLine) lines.push(photoLine);

    lines.push('PRODID:-//Stammbauminator//Kontakt-Export//DE');
    lines.push('REV:' + new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
    lines.push('END:VCARD');

    return lines.map(vcFold).join('\r\n') + '\r\n';
  }

  /**
   * PHOTO-Zeile aus dem hochgeladenen Portrait — verkleinert auf 240 px und
   * base64-kodiert. Bewusst nur beim eigenen Portrait: Ein Ausschnitt aus einem
   * Gruppenfoto ist unscharf und zeigt oft halbe Nachbarn. Wird die Karte zu
   * gross oder klappt etwas nicht, entfällt das Bild stillschweigend — eine
   * Kontaktkarte ohne Foto ist besser als gar keine.
   */
  async function portraitPhotoLine(person) {
    const url = person && person.portraitUrl;
    if (!url) return null;
    try {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) return null;
      let blob = await response.blob();
      if (window.ImageTools && typeof ImageTools.squareCrop === 'function') {
        const small = await ImageTools.squareCrop(blob, {
          maxEdge: VCARD_PHOTO_MAX_EDGE,
          quality: VCARD_PHOTO_QUALITY
        });
        if (small && small.blob) blob = small.blob;
      }
      const base64 = await blobToBase64(blob);
      if (!base64 || base64.length > VCARD_PHOTO_MAX_BASE64) return null;
      const type = blob.type === 'image/png' ? 'PNG' : 'JPEG';
      if (blob.type && blob.type !== 'image/png' && blob.type !== 'image/jpeg') return null;
      return 'PHOTO;ENCODING=b;TYPE=' + type + ':' + base64;
    } catch (err) {
      return null;
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result || '');
        const comma = value.indexOf(',');
        resolve(comma < 0 ? '' : value.slice(comma + 1));
      };
      reader.onerror = () => reject(new Error('Portrait nicht lesbar'));
      reader.readAsDataURL(blob);
    });
  }

  /** Dateiname aus dem Namen: «Anna Müller» → «Anna-Mueller.vcf». */
  function vcardFilename(person) {
    const umlauts = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss' };
    const base = Store.displayName(person)
      .replace(/[äöüÄÖÜß]/g, (c) => umlauts[c])
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // Akzente wegwerfen
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    return (base || 'kontakt') + '.vcf';
  }

  /**
   * Übergabe ans Gerät: auf dem Handy der Teilen-Dialog (dort landet die Karte
   * direkt in den Kontakten), sonst der Download der .vcf-Datei. Auch wenn
   * `navigator.share` scheitert — z.B. weil das Vorbereiten des Bildes die
   * Nutzergeste hat verfallen lassen — greift der Download.
   * @returns {Promise<'shared'|'aborted'|'downloaded'>}
   */
  async function deliverVCard(text, filename, person) {
    const blob = new Blob([text], { type: 'text/vcard;charset=utf-8' });
    const file = typeof File === 'function'
      ? new File([blob], filename, { type: 'text/vcard' })
      : null;

    if (file && navigator.share && navigator.canShare
      && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: Store.displayName(person) });
        return 'shared';
      } catch (err) {
        if (err && err.name === 'AbortError') return 'aborted';
        // alles andere: stillschweigend auf den Download zurückfallen
      }
    }

    // Blob-URL statt data:-URL — die Content-Security-Policy (`default-src
    // 'self'`) betrifft Downloads über a[download] nicht, data:-URLs blockieren
    // Browser hier dagegen von sich aus.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    // Ausserhalb des Panels: so bleibt der Link aus dessen Fokus-Falle heraus.
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return 'downloaded';
  }

  async function handleContactExport(person, trigger) {
    const label = trigger.textContent;
    trigger.disabled = true;
    trigger.textContent = 'Karte wird erstellt …';

    try {
      const photoLine = await portraitPhotoLine(person);
      const filename = vcardFilename(person);
      const result = await deliverVCard(buildVCard(person, photoLine), filename, person);
      if (result === 'aborted') return;
      App.toast(result === 'shared'
        ? 'Kontaktkarte von ' + Store.displayName(person) + ' geteilt.'
        : 'Kontaktkarte «' + filename + '» gespeichert — zum Übernehmen '
          + 'die Datei öffnen.', 'success');
    } catch (err) {
      App.toast((err && err.message)
        || 'Die Kontaktkarte konnte nicht erstellt werden.', 'error');
    } finally {
      if (trigger.isConnected) {
        trigger.disabled = false;
        trigger.textContent = label;
      }
    }
  }

  // --- Bearbeiten -----------------------------------------------------------

  // `maxLength` entspricht dem, was der Server tatsächlich annimmt — sonst
  // kürzte das Formular Eingaben stillschweigend. Datumsfelder brauchen keins.
  const PERSON_FIELDS = [
    { key: 'firstName',  label: 'Vorname *', type: 'text', maxLength: 60 },
    { key: 'lastName',   label: 'Nachname',  type: 'text', maxLength: 500 },
    { key: 'maidenName', label: 'Ledigname', type: 'text', maxLength: 500 },
    { key: 'birthDate',  label: 'Geburtsdatum', type: 'text',
      date: true, placeholder: '01.01.2000', hint: App.DATE_HINT },
    { key: 'deathDate',  label: 'Todesdatum', type: 'text',
      date: true, placeholder: '01.01.2000',
      hint: App.DATE_HINT + ' — leer lassen, wenn die Person lebt' },
    { key: 'address',    label: 'Adresse',   type: 'text',     maxLength: 2000 },
    { key: 'phone',      label: 'Telefon',   type: 'tel',      maxLength: 500 },
    { key: 'email',      label: 'E-Mail',    type: 'email',    maxLength: 500 },
    { key: 'notes',      label: 'Notizen',   type: 'textarea', maxLength: 2000 }
  ];

  function renderEditForm(person) {
    bodyEl.textContent = '';

    const form = document.createElement('form');
    form.className = 'pp-form stack';
    form.noValidate = true;

    const formError = el('p', 'field__error');
    formError.setAttribute('role', 'alert');
    formError.hidden = true;
    form.append(formError);

    const inputs = {};
    for (const f of PERSON_FIELDS) {
      const field = el('div', 'field');
      const id = 'pp-f-' + f.key;
      const label = el('label', null, f.label);
      label.htmlFor = id;

      const input = f.type === 'textarea'
        ? document.createElement('textarea')
        : document.createElement('input');
      if (f.type !== 'textarea') input.type = f.type;
      input.id = id;
      input.name = f.key;
      // Datumsfelder werden in Schweizer Schreibweise vorbelegt, damit niemand
      // gegen ein ISO-Datum antippt. Gespeichert wird beim Absenden wieder ISO.
      input.value = f.date
        ? App.formatDate(person[f.key])
        : (person[f.key] || '');
      if (f.placeholder) input.placeholder = f.placeholder;
      if (f.key === 'firstName') input.required = true;
      if (f.maxLength) input.maxLength = f.maxLength;

      field.append(label, input);
      if (f.hint) field.append(el('p', 'field__hint', f.hint));
      const errEl = el('p', 'field__error');
      errEl.hidden = true;
      field.append(errEl);

      form.append(field);
      inputs[f.key] = { input, field, errEl };
    }

    // Partnerschaften bearbeiten — auch aus der Rolle der eingeheirateten Person
    const unions = Store.unionsInvolving(person.id);
    const noteInputs = [];
    const statusEntries = [];        // Zweifach-Auswahl je Partnerschaft
    if (unions.length) {
      form.append(el('hr', 'divider'));
      form.append(el('h3', 'pp-subtitle', unions.length > 1 ? 'Partnerschaften' : 'Partnerschaft'));
      if (unions.length > 1) {
        form.append(el('p', 'pp-union__hint tiny faint',
          'Höchstens eine Partnerschaft kann «aktuell» sein — die andere wechselt '
          + 'dann automatisch auf «früher». Beide dürfen «früher» sein.'));
      }

      for (const u of unions) {
        const other = Store.spouseIn(u, person.id);
        const partnerLabel = other ? Store.displayName(other) : 'Partner:in nicht erfasst';
        const box = el('div', 'pp-union');
        box.append(el('div', 'pp-union__name', partnerLabel));

        // Status wird sofort gespeichert (eigener PATCH) — nicht erst beim
        // Absenden des Formulars. Gezeichnet wird immer aus dem Store.
        const host = el('div', 'pp-union__status');
        const msg = el('p', 'pp-union__msg tiny');
        msg.setAttribute('role', 'status');
        msg.hidden = true;
        box.append(host, msg);
        statusEntries.push({ unionId: u.id, host, msg, partnerLabel });

        const field = el('div', 'field');
        const nid = 'pp-union-note-' + u.id;
        const nlabel = el('label', null, 'Beziehungsnotiz');
        nlabel.htmlFor = nid;
        const note = document.createElement('input');
        note.type = 'text';
        note.id = nid;
        note.value = u.note || '';
        note.placeholder = 'z.B. zusammen seit 2010';
        field.append(nlabel, note);
        box.append(field);

        noteInputs.push({ unionId: u.id, input: note, original: u.note || '' });
        form.append(box);
      }

      for (const entry of statusEntries) drawUnionStatus(entry, null);
    }

    const actions = el('div', 'row row--end pp-form__actions');
    const cancel = button('Abbrechen', 'btn btn--secondary');
    cancel.addEventListener('click', () => { editing = false; render(); });
    const save = button('Speichern', 'btn btn--primary');
    save.type = 'submit';
    actions.append(cancel, save);
    form.append(actions);

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      clearErrors();

      const payload = {};
      for (const f of PERSON_FIELDS) payload[f.key] = inputs[f.key].input.value.trim();

      if (!payload.firstName) {
        showFieldError('firstName', 'Der Vorname darf nicht leer sein.');
        inputs.firstName.field.scrollIntoView({ block: 'center' });
        inputs.firstName.input.focus();
        return;
      }

      // Eingetippt wird TT.MM.JJJJ, gespeichert wird ISO. Ein leeres Feld
      // bleibt leer ('') — so lässt sich ein Datum auch wieder entfernen.
      let badDate = null;
      for (const f of PERSON_FIELDS) {
        if (!f.date) continue;
        const res = App.parseDateInput(payload[f.key]);
        if (res.ok) {
          payload[f.key] = res.value;
          continue;
        }
        showFieldError(f.key, res.message);
        if (!badDate) badDate = f.key;
      }
      if (badDate) {
        inputs[badDate].field.scrollIntoView({ block: 'center' });
        inputs[badDate].input.focus();
        return;
      }

      save.disabled = true;
      cancel.disabled = true;
      const label = save.textContent;
      save.textContent = 'Speichert …';

      try {
        await API.patch('/api/persons/' + person.id, payload);

        for (const n of noteInputs) {
          const value = n.input.value.trim();
          if (value !== n.original) {
            await API.patch('/api/unions/' + n.unionId, { note: value });
          }
        }

        await Store.load();
        editing = false;
        if (!Store.person(currentId)) { PersonPanel.close(); return; }
        render();
        App.toast('Änderungen gespeichert.', 'success');
      } catch (err) {
        formError.textContent = err.message || 'Speichern fehlgeschlagen.';
        formError.hidden = false;
        if (/vorname/i.test(err.message || '')) {
          showFieldError('firstName', err.message);
        }
        formError.scrollIntoView({ block: 'nearest' });
      } finally {
        save.disabled = false;
        cancel.disabled = false;
        save.textContent = label;
      }
    });

    bodyEl.append(form);

    function clearErrors() {
      formError.hidden = true;
      formError.textContent = '';
      for (const key of Object.keys(inputs)) {
        inputs[key].field.classList.remove('field--invalid');
        inputs[key].errEl.hidden = true;
        inputs[key].errEl.textContent = '';
      }
    }

    function showFieldError(key, message) {
      const entry = inputs[key];
      if (!entry) return;
      entry.field.classList.add('field--invalid');
      entry.errEl.textContent = message;
      entry.errEl.hidden = false;
    }

    /**
     * Zeichnet die Zweifach-Auswahl «aktuell» / «früher» einer Partnerschaft
     * ausschliesslich aus dem aktuellen Store-Zustand.
     * Jede Partnerschaft hat eine eigene Radiogruppe — dadurch lässt sich jede
     * unabhängig umstellen, auch die einzige Partnerschaft einer Person.
     * @param {object} entry        Eintrag aus statusEntries
     * @param {string|null} focusOn 'current' | 'past' — Fokus nach dem Neuzeichnen
     */
    function drawUnionStatus(entry, focusOn) {
      entry.host.textContent = '';

      const union = Store.union(entry.unionId);
      if (!union) {
        entry.host.append(el('span', 'tiny faint', 'Diese Partnerschaft gibt es nicht mehr.'));
        return;
      }

      entry.host.setAttribute('role', 'radiogroup');
      entry.host.setAttribute('aria-label',
        'Status der Partnerschaft mit ' + entry.partnerLabel);

      const options = [
        { value: 'current', label: 'aktuell', on: Boolean(union.isCurrent) },
        { value: 'past',    label: 'früher',  on: !union.isCurrent }
      ];

      for (const opt of options) {
        const box = el('label', 'checkline pp-union__opt'
          + (opt.on ? ' pp-union__opt--on' : ''));
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'pp-union-status-' + entry.unionId;
        radio.value = opt.value;
        radio.checked = opt.on;
        radio.addEventListener('change', () => {
          if (radio.checked) saveUnionStatus(entry, opt.value === 'current');
        });
        box.append(radio, document.createTextNode(opt.label));
        entry.host.append(box);
        if (focusOn === opt.value) radio.focus();
      }
    }

    /** Alle Statusgruppen aus dem frischen Store-Zustand neu zeichnen. */
    function redrawUnionStatuses(activeEntry, focusOn) {
      for (const entry of statusEntries) {
        drawUnionStatus(entry, entry === activeEntry ? focusOn : null);
      }
    }

    function setStatusMessage(entry, message, isError) {
      entry.msg.textContent = message || '';
      entry.msg.hidden = !message;
      entry.msg.classList.toggle('pp-union__msg--error', Boolean(isError));
      entry.msg.classList.toggle('faint', !isError);
    }

    function setStatusBusy(busy) {
      for (const entry of statusEntries) {
        for (const r of entry.host.querySelectorAll('input[type="radio"]')) {
          r.disabled = busy;
        }
      }
    }

    /**
     * Speichert den Status einer Partnerschaft und zeichnet danach alle
     * Statusgruppen aus dem frisch geladenen Zustand neu — der Server setzt beim
     * Aktivieren die andere Partnerschaft derselben Person selbst auf «früher».
     */
    async function saveUnionStatus(entry, makeCurrent) {
      const hadFocus = entry.host.contains(document.activeElement);
      const focusOn = makeCurrent ? 'current' : 'past';
      setStatusMessage(entry, '', false);
      setStatusBusy(true);

      try {
        await API.patch('/api/unions/' + entry.unionId, { isCurrent: makeCurrent });
        await Store.load();
        if (!entry.host.isConnected) return;
        redrawUnionStatuses(entry, hadFocus ? focusOn : null);
        App.toast(makeCurrent
          ? 'Als aktuelle Partnerschaft gespeichert.'
          : 'Als frühere Partnerschaft gespeichert.', 'success');
      } catch (err) {
        const message = (err && err.message) || 'Änderung fehlgeschlagen.';
        // Der Store ist unverändert — Neuzeichnen stellt den vorherigen Stand her.
        if (entry.host.isConnected) {
          redrawUnionStatuses(entry, null);
          setStatusMessage(entry, message, true);
          if (hadFocus) {
            const back = entry.host.querySelector('input[type="radio"]:checked');
            if (back) back.focus();
          }
        }
        App.toast(message, 'error');
      } finally {
        setStatusBusy(false);
      }
    }
  }

  // --- Löschen --------------------------------------------------------------

  /** Vergleichsform für die Tipp-Bestätigung: Rand-Leerzeichen und Gross-/
      Kleinschreibung spielen keine Rolle, innere Abstände werden vereinheitlicht. */
  function normalizeName(value) {
    return String(value == null ? '' : value)
      .trim()
      .replace(/\s+/g, ' ')
      .toLocaleLowerCase('de-CH');
  }

  async function handleDelete(person, trigger) {
    const label = trigger ? trigger.textContent : null;
    if (trigger) {
      trigger.disabled = true;
      trigger.textContent = 'Prüfe …';
    }

    let impact;
    try {
      impact = await API.get('/api/persons/' + person.id + '/impact');
    } catch (err) {
      App.toast(err.message || 'Auswirkung konnte nicht ermittelt werden.', 'error');
      return;
    } finally {
      if (trigger && trigger.isConnected) {
        trigger.disabled = false;
        trigger.textContent = label;
      }
    }

    const count = Number(impact && impact.persons) || 1;
    const tags = Number(impact && impact.tags) || 0;
    const names = (impact && Array.isArray(impact.names)) ? impact.names : [];
    const many = count > 1;

    const body = el('div', 'stack--sm pp-del');

    // Bei mehr als einer betroffenen Person muss sofort ins Auge springen, dass
    // die ganze Nachkommenschaft mitgeht — nicht nur die angeklickte Person.
    if (many) {
      body.append(el('p', 'pp-del__alarm',
        '⚠️ Es bleibt nicht bei dieser Person: Alle Nachkommen und deren '
        + 'Partner:innen verschwinden mit — insgesamt ' + count + ' Personen.'));

      // Damit die Admin-Abfrage nicht ueberraschend kommt, wenn schon alles
      // ausgefuellt ist.
      if (impact && impact.adminRequired && !App.isAdmin()) {
        body.append(el('p', 'pp-del__adminhint',
          '🔑 So viele Personen auf einmal darf nur der Adminbereich entfernen. '
          + 'Nach dem Bestätigen wird das Admin-Passwort verlangt.'));
      }
    } else {
      body.append(el('p', null,
        Store.displayName(person) + ' wird aus dem Stammbaum entfernt.'));
    }

    const counts = el('div', 'pp-del__counts');
    counts.append(countBox(count, count === 1 ? 'Person' : 'Personen'));
    counts.append(countBox(tags, tags === 1 ? 'Foto-Markierung' : 'Foto-Markierungen'));
    body.append(counts);

    if (names.length) {
      const details = el('details', 'pp-del__names');
      details.open = names.length <= 12;      // kurze Listen gleich offen zeigen
      details.append(el('summary', 'small',
        'Betroffene Personen anzeigen (' + names.length + ')'));
      const list = el('ul', 'pp-namelist');
      for (const n of names) list.append(el('li', null, String(n)));
      details.append(list);
      body.append(details);
    }

    body.append(el('p', 'pp-warn', 'Das lässt sich nicht rückgängig machen.'));

    // Der Vorname wird immer verlangt — auch bei einer einzigen Person. So
    // rutscht niemand mit einem Fehlklick durch den Dialog.
    const wanted = String(person.firstName || '').trim();
    const field = el('div', 'field pp-del__confirm');
    const fieldLabel = el('label', null,
      'Tippe zur Bestätigung «' + wanted + '» ein');
    fieldLabel.htmlFor = 'pp-del-confirm';
    const confirmInput = document.createElement('input');
    confirmInput.type = 'text';
    confirmInput.id = 'pp-del-confirm';
    confirmInput.autocomplete = 'off';
    confirmInput.spellcheck = false;
    confirmInput.setAttribute('aria-describedby', 'pp-del-hint');
    const hint = el('p', 'field__hint', 'Gross- und Kleinschreibung ist egal.');
    hint.id = 'pp-del-hint';
    field.append(fieldLabel, confirmInput, hint);
    body.append(field);

    const handle = App.modal({
      title: Store.displayName(person) + ' löschen?',
      body,
      actions: [
        { label: 'Abbrechen', variant: 'secondary' },
        {
          label: 'Unwiderruflich löschen',
          variant: 'danger',
          onClick: async (h) => {
            if (!matches()) { confirmInput.focus(); return; }

            // Ab zwei betroffenen Personen ist es eine Massenloeschung — dafuer
            // verlangt der Server den Adminmodus. Lieber hier freischalten als
            // den Nutzer in einen 403 laufen lassen.
            if (impact && impact.adminRequired && !App.isAdmin()) {
              const freigeschaltet = await App.requestAdmin();
              if (!freigeschaltet) {
                App.toast('Ohne Admin-Passwort bleibt die Person bestehen.', 'info');
                return;
              }
            }

            h.close();
            await doDelete(person, impact);
          }
        }
      ]
    });

    // App.modal baut die Knöpfe selbst — der Bestätigen-Knopf wird hier
    // nachträglich gesperrt und erst beim passenden Vornamen freigegeben.
    const confirmBtn = handle.element.querySelector('.modal__footer .btn--danger');

    const matches = () => normalizeName(confirmInput.value) === normalizeName(wanted);

    const sync = () => {
      if (!confirmBtn) return;
      const ok = matches();
      confirmBtn.disabled = !ok;
      confirmBtn.setAttribute('aria-disabled', String(!ok));
      confirmBtn.title = ok
        ? ''
        : 'Erst den Vornamen «' + wanted + '» eintippen.';
    };

    confirmInput.addEventListener('input', sync);
    confirmInput.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || !matches() || !confirmBtn) return;
      ev.preventDefault();
      confirmBtn.click();
    });
    sync();
  }

  function countBox(value, label) {
    const box = el('div', 'pp-del__count');
    box.append(el('strong', null, String(value)), el('span', 'tiny', label));
    return box;
  }

  async function doDelete(person, impact) {
    // Portraits und Foto-Ausschnitte hängen an den gelöschten Personen. Wie
    // beim Portrait-Wechsel wird der Portrait-Index verworfen und neu geladen —
    // sonst zeigten Baum und Album weiterhin Markierungen, die es nicht mehr gibt.
    const tags = Number(impact && impact.tags) || 0;
    const count = Number(impact && impact.persons) || 1;
    const touchesImages = tags > 0 || Boolean(person.portraitUrl) || count > 1;

    try {
      const res = await API.del('/api/persons/' + person.id);

      if (touchesImages && window.Portrait) {
        Portrait.invalidate();
        await Portrait.load(true);
      }
      photosCache = null;
      photosPromise = null;

      await Store.load();
      PersonPanel.close();
      const n = Number(res && res.deleted) || 1;
      App.toast(n > 1
        ? n + ' Personen wurden gelöscht.'
        : Store.displayName(person) + ' wurde gelöscht.', 'success');
    } catch (err) {
      App.toast(err.message || 'Löschen fehlgeschlagen.', 'error');
    }
  }

  // --- kleine DOM-Helfer ----------------------------------------------------

  function hide(node) {
    node.style.display = 'none';
    node.setAttribute('aria-hidden', 'true');
  }

  function show(node) {
    node.style.display = '';
    node.removeAttribute('aria-hidden');
  }

  function el(tag, className, textValue) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (textValue != null) node.textContent = textValue;
    return node;
  }

  function text(value) {
    return document.createTextNode(value == null ? '' : String(value));
  }

  function link(href, label) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = label;
    return a;
  }

  function button(label, className) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    return b;
  }

  function section(title) {
    const sec = el('section', 'pp-section');
    sec.append(el('h3', 'pp-section__title', title));
    return sec;
  }

  function subTitle(label) {
    return el('h4', 'pp-subtitle', label);
  }

  function infoRow(icon, label, value) {
    const row = el('div', 'pp-info');
    const ico = el('span', 'pp-info__icon', icon);
    ico.setAttribute('aria-hidden', 'true');
    const box = el('span', 'pp-info__text');
    box.append(el('span', 'pp-info__label tiny faint', label));
    const val = el('span', 'pp-info__value');
    val.append(value);
    box.append(val);
    row.append(ico, box);
    return row;
  }


  window.PersonPanel = PersonPanel;
})();
