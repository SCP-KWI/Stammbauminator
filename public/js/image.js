/* Stammbauminator — Bildwerkzeuge
   Globals: window.ImageTools
   Gemeinsame Bildaufbereitung für den Adminbereich (Fotos verkleinern) und
   das Personen-Panel (Portrait zuschneiden). Beide Wege arbeiten nach denselben
   Regeln: PNG/WebP mit Alphakanal behalten ihr Format, alles andere wird JPEG.
   Lässt sich ein Bild nicht lesen oder liefert `canvas.toBlob` nichts, geht die
   Originaldatei raus — der Server entscheidet dann. */
(function () {
  'use strict';

  // --- Konstanten -----------------------------------------------------------

  const ALPHA_PROBE_EDGE = 96;        // Kantenlänge der Transparenzprobe
  const ALPHA_THRESHOLD = 250;        // darunter gilt ein Pixel als durchscheinend

  // --- Bildquelle laden und freigeben ---------------------------------------

  /**
   * Lädt eine Datei als zeichenbare Bildquelle.
   * Bevorzugt `createImageBitmap`, fällt auf ein `<img>` mit Object-URL zurück.
   * @param {File|Blob} file
   * @returns {Promise<ImageBitmap|HTMLImageElement>}
   */
  function load(file) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file).catch(() => loadViaElement(file));
    }
    return loadViaElement(file);
  }

  function loadViaElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        img.__objectUrl = url;
        // naturalWidth/Height sind als width/height verfügbar
        resolve(img);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild nicht lesbar')); };
      img.src = url;
    });
  }

  /** Gibt eine mit `load` geholte Bildquelle wieder frei. */
  function release(source) {
    if (source && typeof source.close === 'function') source.close();
    if (source && source.__objectUrl) URL.revokeObjectURL(source.__objectUrl);
  }

  // --- Transparenz ----------------------------------------------------------

  /** Transparenzprobe auf einer kleinen Kopie — schnell und genau genug. */
  function hasAlpha(source, width, height) {
    try {
      const scale = Math.min(1, ALPHA_PROBE_EDGE / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(source, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < ALPHA_THRESHOLD) return true;
      }
      return false;
    } catch (err) {
      return true;                     // im Zweifel Format behalten
    }
  }

  // --- Namen und Grössen ----------------------------------------------------

  /**
   * Dateiname mit der Endung, die zum ausgegebenen Format passt.
   * @param {string} name        ursprünglicher Dateiname
   * @param {string} mimeType    Zieltyp, z.B. 'image/jpeg'
   * @param {{fallback?: string, maxBase?: number}} [options]
   *        `fallback` ist der Name ohne Endung, wenn keiner brauchbar ist;
   *        `maxBase` kürzt den Basisnamen auf so viele Zeichen (0 = unbegrenzt).
   */
  function renameFor(name, mimeType, options) {
    const opts = options || {};
    const fallback = opts.fallback || 'bild';
    const maxBase = Number(opts.maxBase) || 0;
    let base = String(name || fallback).replace(/\.[^.]+$/, '') || fallback;
    if (maxBase > 0) base = base.slice(0, maxBase);
    const ext = mimeType === 'image/png'
      ? '.png'
      : (mimeType === 'image/webp' ? '.webp' : '.jpg');
    return base + ext;
  }

  /** Bytes hübsch: 1234567 → "1,2 MB" */
  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = n;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    const decimals = i === 0 ? 0 : (value < 10 ? 1 : 0);
    return value.toLocaleString('de-CH', {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals
    }) + ' ' + units[i];
  }

  // --- Ausgabeformat --------------------------------------------------------

  /** JPEG — ausser bei PNG/WebP, die tatsächlich einen Alphakanal nutzen. */
  function outputType(file, source, width, height) {
    const mayHaveAlpha = file.type === 'image/png' || file.type === 'image/webp';
    return (mayHaveAlpha && hasAlpha(source, width, height)) ? file.type : 'image/jpeg';
  }

  function toBlob(canvas, type, quality) {
    return new Promise((resolve) => {
      try { canvas.toBlob(resolve, type, quality); }
      catch (err) { resolve(null); }
    });
  }

  function newCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return { canvas, ctx };
  }

  // --- Verkleinern (längste Kante begrenzen) --------------------------------

  /**
   * Verkleinert ein Bild clientseitig auf eine maximale Kantenlänge.
   * Unverändert bleibt es, wenn es kleiner als `skipUnderBytes` ist und die
   * längste Kante `maxEdge` nicht überschreitet — oder wenn das Verkleinern
   * nichts einbringt.
   * @param {File} file
   * @param {{maxEdge: number, quality: number, skipUnderBytes?: number}} options
   * @returns {Promise<{blob: Blob, width: number, height: number,
   *                    filename: string, resized: boolean}>}
   */
  async function resizeToFit(file, options) {
    const opts = options || {};
    const maxEdge = Number(opts.maxEdge) || 0;
    const quality = Number(opts.quality) || 0.85;
    const skipUnderBytes = Number(opts.skipUnderBytes) || 0;

    let source;
    try {
      source = await load(file);
    } catch (err) {
      // Kein Zugriff aufs Bild (z.B. defekte Datei) → unverändert senden
      return { blob: file, width: 0, height: 0, filename: file.name, resized: false };
    }

    const width = source.width;
    const height = source.height;
    const longest = Math.max(width, height);

    if (file.size < skipUnderBytes && longest <= maxEdge) {
      release(source);
      return { blob: file, width, height, filename: file.name, resized: false };
    }

    const scale = longest > maxEdge ? maxEdge / longest : 1;
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const outType = outputType(file, source, width, height);
    const { canvas, ctx } = newCanvas(targetW, targetH);
    ctx.drawImage(source, 0, 0, targetW, targetH);
    release(source);

    const blob = await toBlob(canvas, outType, quality);

    // Kein Blob oder nichts gewonnen → Original nehmen (nur wenn nicht skaliert wurde)
    if (!blob || (scale === 1 && blob.size >= file.size)) {
      return { blob: file, width, height, filename: file.name, resized: false };
    }

    return {
      blob,
      width: targetW,
      height: targetH,
      filename: renameFor(file.name, blob.type || outType, { fallback: 'foto' }),
      resized: true
    };
  }

  // --- Quadratischer Mittenausschnitt ---------------------------------------

  /**
   * Schneidet einen quadratischen Ausschnitt aus der Bildmitte, Kante höchstens
   * `maxEdge`. Ein kleineres Bild wird nicht hochgerechnet.
   * @param {File} file
   * @param {{maxEdge: number, quality: number}} options
   * @returns {Promise<{blob: Blob, width: number, height: number, filename: string}>}
   */
  async function squareCrop(file, options) {
    const opts = options || {};
    const maxEdge = Number(opts.maxEdge) || 0;
    const quality = Number(opts.quality) || 0.85;

    let source;
    try {
      source = await load(file);
    } catch (err) {
      return { blob: file, width: 0, height: 0, filename: file.name };
    }

    const width = source.width;
    const height = source.height;
    if (!width || !height) {
      release(source);
      return { blob: file, width: 0, height: 0, filename: file.name };
    }

    const side = Math.min(width, height);
    const target = Math.max(1, Math.min(maxEdge, Math.round(side)));
    const sx = Math.round((width - side) / 2);
    const sy = Math.round((height - side) / 2);

    const outType = outputType(file, source, width, height);
    const { canvas, ctx } = newCanvas(target, target);
    ctx.drawImage(source, sx, sy, side, side, 0, 0, target, target);
    release(source);

    const blob = await toBlob(canvas, outType, quality);
    if (!blob) return { blob: file, width, height, filename: file.name };

    return {
      blob,
      width: target,
      height: target,
      filename: renameFor(file.name, blob.type || outType,
        { fallback: 'portrait', maxBase: 60 })
    };
  }

  window.ImageTools = {
    load,
    release,
    hasAlpha,
    renameFor,
    formatBytes,
    resizeToFit,
    squareCrop
  };
})();
