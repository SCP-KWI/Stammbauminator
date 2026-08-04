/* Stammbauminator — App-Shell
   Globals: window.App
   Zuständig für Login-Gate, Rollen, Tab-Routing, Toasts, Modals. */
(function () {
  'use strict';

  const TABS = ['tree', 'photos', 'quiz', 'admin'];
  const PRODUCT_NAME = 'Stammbauminator';   // Produktname, familienunabhängig
  const roleSubscribers = new Set();
  const tabSubscribers = new Set();
  const settingsSubscribers = new Set();
  let modalStack = [];
  let mounted = false;

  const App = {
    role: null,

    // --- Start ------------------------------------------------------------

    async start() {
      wireGate();
      wireTabs();
      wireHelp();
      wireLogout();

      // Einstellungen zuerst und ohne Session — die Anmeldeseite zeigt den
      // Familiennamen. Fehlschlag ist unkritisch: dann bleibt der Produktname.
      try {
        App.applySettings(await API.get('/api/settings'));
      } catch (err) {
        console.warn('Einstellungen nicht ladbar', err);
      }

      try {
        const session = await API.get('/api/auth/session');
        if (session && session.authenticated) {
          App.role = session.role;
          await enterApp();
          return;
        }
      } catch (err) {
        // Netzwerkfehler beim Start: trotzdem das Gate zeigen
        console.warn('Session-Prüfung fehlgeschlagen', err);
      }
      showGate();
    },

    // --- Rollen -----------------------------------------------------------

    isAdmin: () => App.role === 'admin',

    onRoleChange(fn) {
      roleSubscribers.add(fn);
      return () => roleSubscribers.delete(fn);
    },

    setRole(role) {
      if (App.role === role) return;
      App.role = role;
      document.body.dataset.role = role || '';
      for (const fn of roleSubscribers) {
        try { fn(role); }
        catch (err) { console.error('Rollen-Subscriber fehlgeschlagen', err); }
      }
    },

    /**
     * Wird von api.js bei einem 403 mit Code 'forbidden' aufgerufen: Der
     * Adminmodus ist nach 30 Minuten abgelaufen. Die Anmeldung selbst bleibt
     * bestehen — es fällt nur die Rolle zurück, damit keine Adminknöpfe
     * stehenbleiben, die ohnehin ins Leere laufen.
     */
    handleAdminExpired() {
      if (App.role !== 'admin') return;
      App.setRole('family');
      App.toast('Der Adminmodus ist abgelaufen — bitte neu freischalten.', 'info');
    },

    /** Wird von api.js bei 401 aufgerufen. */
    handleUnauthorized() {
      if (document.getElementById('gate').hidden === false) return;
      App.setRole(null);
      closeAllModals();
      if (window.PersonPanel) PersonPanel.close();
      showGate();
      App.toast('Sitzung abgelaufen — bitte neu anmelden.', 'info');
    },

    // --- Tabs -------------------------------------------------------------

    showTab(name) {
      for (const btn of document.querySelectorAll('.tab')) {
        btn.setAttribute('aria-selected', String(btn.dataset.tab === name));
      }
      for (const panel of document.querySelectorAll('.tabpanel')) {
        if (panel.id === 'tab-' + name) panel.dataset.active = 'true';
        else delete panel.dataset.active;
      }
      if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);

      App.activeTab = name;
      for (const fn of tabSubscribers) {
        try { fn(name); }
        catch (err) { console.error('Tab-Subscriber fehlgeschlagen', err); }
      }
    },

    activeTab: 'tree',

    /** Wird aufgerufen, sobald ein Tab sichtbar wird — Module können darauf
        ihre Daten auffrischen, statt beim Mount alles vorzuladen. */
    onTabChange(fn) {
      tabSubscribers.add(fn);
      return () => tabSubscribers.delete(fn);
    },

    // --- Einstellungen ----------------------------------------------------

    /** { familyName, appTitle } — erst nach dem Login gefüllt, vorher null. */
    settings: null,

    /**
     * Übernimmt Kopfzeile und Browser-Titel. `appTitle` kommt vom Server, damit
     * die Regel "<Familienname> Stammbaum" nur an einer Stelle steht.
     */
    applySettings(settings) {
      if (!settings) return;
      App.settings = {
        familyName: settings.familyName || '',
        appTitle: settings.appTitle || 'Stammbaum'
      };

      const titleEl = document.getElementById('app-title');
      if (titleEl) titleEl.textContent = App.settings.appTitle;
      document.title = App.settings.appTitle;

      // Auch auf der Anmeldeseite: Die Familie soll sofort sehen, dass sie am
      // richtigen Ort ist. Ohne gesetzten Namen bleibt dort der Produktname
      // stehen — "Stammbaum" allein waere als Begruessung zu nichtssagend.
      const gateTitleEl = document.getElementById('gate-title');
      if (gateTitleEl) {
        gateTitleEl.textContent = App.settings.familyName
          ? App.settings.appTitle
          : PRODUCT_NAME;
      }

      for (const fn of settingsSubscribers) {
        try { fn(App.settings); }
        catch (err) { console.error('Einstellungs-Subscriber fehlgeschlagen', err); }
      }
    },

    onSettingsChange(fn) {
      settingsSubscribers.add(fn);
      return () => settingsSubscribers.delete(fn);
    },

    // --- Toasts -----------------------------------------------------------

    toast(message, type) {
      const host = document.getElementById('toasts');
      const el = document.createElement('div');
      el.className = 'toast toast--' + (type || 'info');
      el.setAttribute('role', type === 'error' ? 'alert' : 'status');
      el.textContent = message;
      host.appendChild(el);

      const remove = () => {
        el.classList.add('toast--out');
        el.addEventListener('animationend', () => el.remove(), { once: true });
        setTimeout(() => el.remove(), 600);
      };
      setTimeout(remove, type === 'error' ? 5200 : 3400);
      el.addEventListener('click', remove);
    },

    // --- Modal ------------------------------------------------------------

    /**
     * @param {{title:string, body:HTMLElement, actions?:Array, onClose?:Function,
     *          size?:'sm'|'md'|'lg'}} opts
     * @returns {{close:Function, element:HTMLElement}}
     */
    modal(opts) {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';

      const box = document.createElement('div');
      box.className = 'modal';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-label', opts.title || 'Dialog');
      if (opts.size === 'lg') box.style.width = 'min(880px, 100%)';

      const header = document.createElement('div');
      header.className = 'modal__header';
      const h2 = document.createElement('h2');
      h2.textContent = opts.title || '';
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'modal__close';
      closeBtn.setAttribute('aria-label', 'Schliessen');
      closeBtn.textContent = '✕';
      header.append(h2, closeBtn);

      const body = document.createElement('div');
      body.className = 'modal__body';
      if (opts.body) body.appendChild(opts.body);

      box.append(header, body);

      const handle = { element: box, close };

      if (opts.actions && opts.actions.length) {
        const footer = document.createElement('div');
        footer.className = 'modal__footer';
        for (const action of opts.actions) {
          const btn = document.createElement('button');
          btn.type = action.type || 'button';
          btn.className = 'btn btn--' + (action.variant || 'secondary');
          btn.textContent = action.label;
          if (action.onClick) {
            btn.addEventListener('click', async () => {
              btn.disabled = true;
              try { await action.onClick(handle); }
              finally { btn.disabled = false; }
            });
          } else {
            btn.addEventListener('click', close);
          }
          footer.appendChild(btn);
        }
        box.appendChild(footer);
      }

      backdrop.appendChild(box);
      document.getElementById('modals').appendChild(backdrop);
      modalStack.push({ backdrop, onClose: opts.onClose });

      closeBtn.addEventListener('click', close);
      backdrop.addEventListener('mousedown', (ev) => { if (ev.target === backdrop) close(); });

      const focusable = box.querySelector(
        'input:not([type=hidden]), textarea, select, button.btn'
      );
      setTimeout(() => (focusable || closeBtn).focus(), 60);

      function close() {
        const idx = modalStack.findIndex((m) => m.backdrop === backdrop);
        if (idx === -1) return;
        modalStack.splice(idx, 1);
        backdrop.remove();
        if (opts.onClose) opts.onClose();
      }

      return handle;
    },

    confirm({ title, message, confirmLabel, cancelLabel, danger }) {
      return new Promise((resolve) => {
        const body = document.createElement('div');
        const p = document.createElement('p');
        p.textContent = message;
        body.appendChild(p);

        let settled = false;
        const finish = (value, handle) => {
          if (settled) return;
          settled = true;
          resolve(value);
          if (handle) handle.close();
        };

        App.modal({
          title: title || 'Bist du sicher?',
          body,
          onClose: () => finish(false),
          actions: [
            { label: cancelLabel || 'Abbrechen', variant: 'secondary',
              onClick: (h) => finish(false, h) },
            { label: confirmLabel || 'Ja, weiter', variant: danger ? 'danger' : 'primary',
              onClick: (h) => finish(true, h) }
          ]
        });
      });
    },

    // --- Utilities --------------------------------------------------------

    escapeHtml(str) {
      return String(str == null ? '' : str).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[ch]));
    },

    /**
     * Gespeichert wird immer ISO (`2000-01-01`) — nur so lässt sich sortieren
     * und vergleichen. Angezeigt wird Schweizer Schreibweise `01.01.2000`.
     * Teilangaben bleiben Teilangaben: `01.2000`, `2000`.
     */
    formatDate(value) {
      if (!value) return '';
      const m = String(value).match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
      if (!m) return String(value);
      const [, y, mo, d] = m;
      if (d && mo) return `${d}.${mo}.${y}`;
      if (mo) return `${mo}.${y}`;
      return y;
    },

    /**
     * Auge-Knopf an einem Passwortfeld: schaltet zwischen Punkten und Klartext.
     * Lange Passwörter lassen sich sonst nicht kontrollieren — gerade auf dem
     * Handy, wo man sich leicht vertippt.
     */
    wirePasswordEye(input, button) {
      if (!input || !button) return;
      button.addEventListener('click', () => {
        const zeigen = input.type === 'password';
        input.type = zeigen ? 'text' : 'password';
        button.firstElementChild.textContent = zeigen ? '🙈' : '👁';
        const label = zeigen ? 'Passwort verbergen' : 'Passwort anzeigen';
        button.setAttribute('aria-label', label);
        button.title = label;
        button.setAttribute('aria-pressed', String(zeigen));
        input.focus();
      });
    },

    /** Eingabehinweis — überall dieselbe Formulierung verwenden. */
    DATE_HINT: 'Format: 01.01.2000, 01.2000 oder 2000',

    /**
     * Eingabe im Format `TT.MM.JJJJ` (auch `1.1.2000`), `MM.JJJJ` oder `JJJJ`
     * nach ISO umrechnen. ISO-Eingaben werden ebenfalls akzeptiert, damit
     * kopierte Werte nicht abgewiesen werden.
     *
     * @returns {{ok: true, value: string} | {ok: false, message: string}}
     *          `value` ist '' bei leerer Eingabe (Feld leeren ist erlaubt).
     */
    parseDateInput(raw) {
      const text = String(raw == null ? '' : raw).trim();
      if (!text) return { ok: true, value: '' };

      const invalid = { ok: false, message: 'Bitte ein Datum wie 01.01.2000 eingeben.' };

      // Bereits ISO — unverändert übernehmen, wenn plausibel.
      const iso = text.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
      if (iso) {
        return plausible(iso[1], iso[2], iso[3])
          ? { ok: true, value: text }
          : invalid;
      }

      const parts = text.split('.').map((s) => s.trim()).filter((s) => s !== '');
      if (!parts.length || parts.length > 3 || parts.some((s) => !/^\d+$/.test(s))) {
        return invalid;
      }

      let y, mo, d;
      if (parts.length === 3) [d, mo, y] = parts;
      else if (parts.length === 2) [mo, y] = parts;
      else [y] = parts;

      if (y.length !== 4) return invalid;
      const pad = (v) => String(v).padStart(2, '0');
      if (!plausible(y, mo && pad(mo), d && pad(d))) return invalid;

      if (d) return { ok: true, value: `${y}-${pad(mo)}-${pad(d)}` };
      if (mo) return { ok: true, value: `${y}-${pad(mo)}` };
      return { ok: true, value: y };
    },

    /** Admin-Freischaltung anfragen; löst true auf, wenn danach Admin aktiv ist. */
    requestAdmin() {
      if (App.isAdmin()) return Promise.resolve(true);

      return new Promise((resolve) => {
        const form = document.createElement('form');
        form.autocomplete = 'off';
        form.innerHTML = `
          <div class="field">
            <label for="admin-pw">Admin-Passwort</label>
            <div class="pw-field">
              <input type="password" id="admin-pw" autocomplete="current-password" required>
              <button type="button" class="btn btn--ghost btn--icon btn--sm pw-field__eye"
                      id="admin-pw-eye" title="Passwort anzeigen"
                      aria-label="Passwort anzeigen" aria-pressed="false">
                <span aria-hidden="true">👁</span>
              </button>
            </div>
            <p class="field__error" id="admin-pw-error" role="alert" hidden></p>
          </div>`;
        App.wirePasswordEye(form.querySelector('#admin-pw'), form.querySelector('#admin-pw-eye'));

        let settled = false;
        const done = (value, handle) => {
          if (settled) return;
          settled = true;
          resolve(value);
          if (handle) handle.close();
        };

        const submit = async (handle) => {
          const input = form.querySelector('#admin-pw');
          const errorEl = form.querySelector('#admin-pw-error');
          errorEl.hidden = true;
          try {
            const res = await API.post('/api/auth/admin', { password: input.value });
            App.setRole(res.role);
            App.toast('Admin-Bereich freigeschaltet.', 'success');
            done(true, handle);
          } catch (err) {
            errorEl.textContent = err.message;
            errorEl.hidden = false;
            input.value = '';
            input.focus();
            form.classList.remove('shake');
            void form.offsetWidth;
            form.classList.add('shake');
          }
        };

        const handle = App.modal({
          title: 'Admin-Bereich',
          body: form,
          onClose: () => done(false),
          actions: [
            { label: 'Abbrechen', variant: 'secondary', onClick: (h) => done(false, h) },
            { label: 'Freischalten', variant: 'primary', onClick: submit }
          ]
        });

        form.addEventListener('submit', (ev) => { ev.preventDefault(); submit(handle); });
      });
    }
  };

  // --- Gate ---------------------------------------------------------------

  function showGate() {
    document.getElementById('gate').hidden = false;
    document.getElementById('app').hidden = true;
    // Der Familienname steht auch vor dem Login im Browser-Titel.
    document.title = (App.settings && App.settings.appTitle) || PRODUCT_NAME;
    const input = document.getElementById('gate-password');
    input.value = '';

    // Beim Abmelden wieder verbergen — sonst stuende das naechste Passwort
    // offen auf dem Bildschirm, ohne dass jemand damit rechnet.
    const eye = document.getElementById('gate-password-eye');
    if (input.type === 'text' && eye) eye.click();

    setTimeout(() => input.focus(), 80);
  }

  function wireGate() {
    const form = document.getElementById('gate-form');
    const input = document.getElementById('gate-password');
    const errorEl = document.getElementById('gate-error');
    const submitBtn = document.getElementById('gate-submit');

    App.wirePasswordEye(input, document.getElementById('gate-password-eye'));

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      errorEl.hidden = true;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Moment …';

      try {
        const res = await API.post('/api/auth/login', { password: input.value });
        App.role = res.role;
        await enterApp();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        input.value = '';
        input.focus();
        const card = form.closest('.gate-card');
        card.classList.remove('shake');
        void card.offsetWidth;
        card.classList.add('shake');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Reinschauen';
      }
    });
  }

  async function enterApp() {
    document.getElementById('gate').hidden = true;
    document.getElementById('app').hidden = false;
    document.body.dataset.role = App.role || '';

    try {
      await Store.load();
    } catch (err) {
      App.toast('Stammbaum konnte nicht geladen werden: ' + err.message, 'error');
    }

    // Fotos im Hintergrund holen — daraus entstehen die Portrait-Ausschnitte.
    if (window.Portrait) Portrait.load();

    if (!mounted) {
      mounted = true;
      mountModule(window.TreeView,   'tab-tree');
      mountModule(window.PhotoAlbum, 'tab-photos');
      mountModule(window.QuizView,   'tab-quiz');
      mountModule(window.AdminView,  'tab-admin');
      mountModule(window.PersonPanel, 'person-panel');
    }

    const hash = (location.hash || '').replace('#', '');
    App.showTab(TABS.includes(hash) ? hash : 'tree');
  }

  function mountModule(module, elementId) {
    const el = document.getElementById(elementId);
    if (!module || typeof module.mount !== 'function' || !el) {
      if (!module) console.warn('Modul für #' + elementId + ' fehlt.');
      return;
    }
    try { module.mount(el); }
    catch (err) { console.error('Mount von #' + elementId + ' fehlgeschlagen', err); }
  }

  // --- Tabs & Logout ------------------------------------------------------

  function wireTabs() {
    for (const btn of document.querySelectorAll('.tab')) {
      btn.addEventListener('click', () => App.showTab(btn.dataset.tab));
    }
  }

  function wireHelp() {
    const btn = document.getElementById('help-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (window.HelpView) HelpView.open();
    });
  }

  function wireLogout() {
    document.getElementById('logout-btn').addEventListener('click', async () => {
      const ok = await App.confirm({
        title: 'Abmelden?',
        message: 'Du musst das Familien-Passwort danach neu eingeben.',
        confirmLabel: 'Abmelden'
      });
      if (!ok) return;
      try { await API.post('/api/auth/logout'); } catch (err) { /* egal */ }
      App.setRole(null);
      showGate();
    });
  }

  /**
   * Kalendarische Pruefung — nicht nur Bereichsgrenzen, sonst ginge der
   * 31. Februar durch. Schaltjahre nach gregorianischer Regel.
   */
  function plausible(year, month, day) {
    const y = Number(year);
    if (!(y >= 1000 && y <= 2999)) return false;

    let m = null;
    if (month != null) {
      m = Number(month);
      if (!(m >= 1 && m <= 12)) return false;
    }

    if (day != null) {
      if (m == null) return false;       // Tag ohne Monat ergibt keinen Sinn
      const d = Number(day);
      if (!(d >= 1 && d <= daysInMonth(y, m))) return false;
    }
    return true;
  }

  function daysInMonth(year, month) {
    if (month === 2) {
      const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
      return leap ? 29 : 28;
    }
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
  }

  function closeAllModals() {
    for (const entry of modalStack.slice()) entry.backdrop.remove();
    modalStack = [];
  }

  // Escape schliesst das oberste Modal
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !modalStack.length) return;
    const top = modalStack[modalStack.length - 1];
    modalStack.pop();
    top.backdrop.remove();
    if (top.onClose) top.onClose();
  });

  window.App = App;
})();
