/* Stammbauminator — API-Wrapper
   Globals: window.API
   Alle Requests laufen same-origin mit Session-Cookie. */
(function () {
  'use strict';

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message || 'Unbekannter Fehler');
      this.name = 'ApiError';
      this.status = status;
      this.code = code || 'error';
    }
  }

  async function request(method, path, body) {
    const opts = {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    };

    if (body instanceof FormData) {
      opts.body = body; // Content-Type setzt der Browser inkl. boundary
    } else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(path, opts);
    } catch (err) {
      throw new ApiError(0, 'network', 'Keine Verbindung zum Server.');
    }

    if (res.status === 204) return null;

    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const payload = isJson ? await res.json().catch(() => null) : null;

    if (!res.ok) {
      const err = new ApiError(
        res.status,
        payload && payload.error,
        (payload && payload.message) || defaultMessage(res.status)
      );
      // Session abgelaufen → App zurück aufs Login-Gate schicken
      if (res.status === 401 && window.App && typeof App.handleUnauthorized === 'function') {
        App.handleUnauthorized();
      }
      // Der Adminmodus läuft nach 30 Minuten von selbst ab; der Server antwortet
      // dann mit 403 und dem Code 'forbidden'. Nur dieser Code bedeutet «keine
      // Adminrechte» — ein falsches Adminpasswort liefert 'wrong_password' und
      // darf die Rolle nicht anfassen.
      if (res.status === 403 && err.code === 'forbidden'
          && window.App && typeof App.handleAdminExpired === 'function') {
        App.handleAdminExpired();
      }
      throw err;
    }

    return payload;
  }

  function defaultMessage(status) {
    switch (status) {
      case 400: return 'Die Eingabe ist ungültig.';
      case 401: return 'Bitte neu anmelden.';
      case 403: return 'Dafür brauchst du Admin-Rechte.';
      case 404: return 'Nicht gefunden.';
      case 409: return 'Das geht so nicht — es gibt einen Konflikt.';
      case 413: return 'Die Datei ist zu gross.';
      case 429: return 'Zu viele Versuche. Bitte kurz warten.';
      case 503: return 'Der Server ist gerade ausgelastet. Bitte gleich nochmals versuchen.';
      default:  return 'Serverfehler. Bitte später nochmals versuchen.';
    }
  }

  window.API = {
    get:   (path)       => request('GET', path),
    post:  (path, body) => request('POST', path, body === undefined ? {} : body),
    patch: (path, body) => request('PATCH', path, body === undefined ? {} : body),
    del:   (path)       => request('DELETE', path),
    ApiError
  };
})();
