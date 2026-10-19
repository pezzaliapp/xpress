/* ===========================
   Xpress — pdf-listino.js
   Listino PDF con immagini, tutto sul dispositivo dell'utente.

   - Il PDF viene letto nel browser con pdf.js (servito localmente da vendor/)
     e salvato in IndexedDB su QUESTO dispositivo: nessun upload, nessun server.
   - Alla prima apertura il PDF viene indicizzato: per ogni pagina si leggono
     i codici articolo (testo) e la posizione delle immagini.
   - Per un codice si sceglie l'immagine giusta della pagina:
       1) immagine sulla stessa riga, a sinistra del codice (tabelle accessori)
       2) immagine appena sopra al codice usato come didascalia
       3) immagine "principale" sopra la riga prezzi (grande e vicina)
   - Le miniature ritagliate vengono messe in cache (IndexedDB) per codice.

   Agganci con app.js (logica originale invariata):
     XpressPDF.onTableRendered()  -> miniature nella colonna Codice
     XpressPDF.stampa(senzaMargine) -> stampa / PDF con immagini
   =========================== */

(function () {
  'use strict';

  // -------------------- STORAGE (IndexedDB, solo locale) --------------------
  const DB_NAME = 'xpress_pdf_db_v1';
  const STORE_KV = 'kv';
  const STORE_THUMBS = 'thumbs';
  const KEY_PDF = 'last_pdf_bytes';
  const KEY_META = 'last_pdf_meta';
  const KEY_INDEX = 'last_pdf_index';
  const REMEMBER_KEY = 'xpress_remember_pdf_v1';
  const INDEX_VERSION = 9; // bump se cambia l'algoritmo di indicizzazione

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window) || !window.indexedDB) {
        reject(new Error('IndexedDB non disponibile'));
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
        if (!db.objectStoreNames.contains(STORE_THUMBS)) db.createObjectStore(STORE_THUMBS);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onclose = () => { dbPromise = null; };
        db.onversionchange = () => { try { db.close(); } catch (_) {} dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB bloccato'));
    });
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  async function dbOp(store, mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const os = tx.objectStore(store);
      let result;
      const req = fn(os);
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transazione annullata'));
    });
  }

  const kvGet = (k) => dbOp(STORE_KV, 'readonly', os => os.get(k));
  const kvSet = (k, v) => dbOp(STORE_KV, 'readwrite', os => os.put(v, k));
  const kvDel = (k) => dbOp(STORE_KV, 'readwrite', os => os.delete(k));
  const thumbGet = (k) => dbOp(STORE_THUMBS, 'readonly', os => os.get(k));
  const thumbSet = (k, v) => dbOp(STORE_THUMBS, 'readwrite', os => os.put(v, k));
  const thumbClear = () => dbOp(STORE_THUMBS, 'readwrite', os => os.clear());

  // -------------------- STATO --------------------
  const state = {
    bytes: null,      // Uint8Array del PDF (copia locale)
    meta: null,       // { name, size, lastModified, fp, pages, savedAt, codes }
    index: null,      // { v, fp, pages:[{w,h,imgs}], codes:{ key: [occ] } }
    doc: null,        // PDFDocumentProxy
    docPromise: null,
    thumbMem: new Map(),   // key -> dataURL | null
    pending: new Map(),    // key -> Promise
    busy: false
  };

  // -------------------- UTIL --------------------
  // Chiave di confronto codice: maiuscolo, solo lettere/cifre, senza zeri iniziali
  // (Excel spesso toglie gli zeri iniziali: 01100313 -> 1100313)
  function normCode(c) {
    const s = String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return s.replace(/^0+(?=.)/, '');
  }

  function pdfLib() {
    const lib = window.pdfjsLib;
    if (!lib) return null;
    try {
      if (!lib.GlobalWorkerOptions.workerSrc) {
        lib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
      }
    } catch (_) {}
    return lib;
  }

  function fingerprint(file) {
    return `${file.name}|${file.size}|${file.lastModified}`;
  }

  function el(id) { return document.getElementById(id); }

  function setStatus(text, color) {
    const s = el('pdfLoadStatus');
    if (!s) return;
    s.textContent = text || '';
    s.style.display = text ? 'block' : 'none';
    s.style.color = color || '#555';
  }

  function updateInfoUI() {
    const info = el('savedPdfInfo');
    if (!info) return;
    if (!state.meta) { info.textContent = 'Nessun listino PDF caricato.'; return; }
    const m = state.meta;
    const when = m.savedAt ? new Date(m.savedAt).toLocaleString('it-IT') : '';
    info.textContent = `In uso: “${m.name}” • Pagine: ${m.pages || '?'} • Codici trovati: ${m.codes || 0}${when ? ' • ' + when : ''}`;
  }

  function rememberEnabled() {
    const chk = el('toggleRememberPDF');
    return !chk || chk.checked;
  }

  // -------------------- DOCUMENTO --------------------
  async function getDoc() {
    if (state.doc) return state.doc;
    if (state.docPromise) return state.docPromise;
    const lib = pdfLib();
    if (!lib || !state.bytes) return null;

    state.docPromise = lib.getDocument({
      data: state.bytes.slice(), // copia: il worker "consuma" il buffer
      isEvalSupported: false,    // compatibile con la CSP (niente eval)
      disableFontFace: true,     // nessun font caricato nel documento
      useSystemFonts: false,
      isOffscreenCanvasSupported: false // pixel delle immagini leggibili (foto vs disegno)
    }).promise.then(doc => { state.doc = doc; return doc; })
      .catch(err => { state.docPromise = null; throw err; });

    return state.docPromise;
  }

  async function closeDoc() {
    const d = state.doc;
    state.doc = null;
    state.docPromise = null;
    if (d) { try { await d.destroy(); } catch (_) {} }
  }

  // -------------------- INDICIZZAZIONE --------------------
  const PRICE_RE = /\d{1,3}(?:\.\d{3})*,\d{2}|€/;

  // Un "codice" plausibile: 4-24 caratteri alfanumerici (con - . /), almeno 3 cifre,
  // e non un prezzo/misura (niente virgole, niente €).
  function isCodeToken(tok) {
    if (tok.length < 4 || tok.length > 24) return false;
    if (/[,€%]/.test(tok)) return false;
    if (!/^[A-Za-z0-9][A-Za-z0-9.\-\/]*[A-Za-z0-9]$/.test(tok)) return false;
    const digits = (tok.match(/\d/g) || []).length;
    if (digits < 3) return false;
    // scarta numeri con separatore migliaia tipo 1.120 o 3.940
    if (/^\d{1,3}(\.\d{3})+$/.test(tok)) return false;
    return true;
  }

  function mulMat(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  }

  function applyMat(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  // Foto o disegno tecnico? Si divide l'immagine in blocchi e se ne fa la media:
  // in un disegno le linee sono sottili, quindi quasi nessun blocco risulta scuro
  // o colorato; in una foto ci sono zone piene (scure o colorate).
  function imageLooksLikeDrawing(img) {
    try {
      if (!img || !img.data || !img.width || !img.height) return false;
      const { width: w, height: h, data, kind } = img;
      if (kind === 1) return false; // 1 bit: non classificabile
      const ch = kind === 3 ? 4 : 3;
      if (data.length < w * h * ch) return false;
      const GX = Math.min(40, w), GY = Math.min(40, h);
      const bw = w / GX, bh = h / GY;
      let blocks = 0, dark = 0, colorful = 0;
      for (let gy = 0; gy < GY; gy++) {
        for (let gx = 0; gx < GX; gx++) {
          let n = 0, lum = 0, sat = 0;
          for (let sy = 0; sy < 4; sy++) {
            const y = Math.min(h - 1, Math.floor(gy * bh + (sy + 0.5) * bh / 4));
            for (let sx = 0; sx < 4; sx++) {
              const x = Math.min(w - 1, Math.floor(gx * bw + (sx + 0.5) * bw / 4));
              const o = (y * w + x) * ch;
              let r = data[o], g = data[o + 1], b = data[o + 2];
              if (ch === 4 && data[o + 3] < 128) { r = g = b = 255; }
              lum += 0.299 * r + 0.587 * g + 0.114 * b;
              sat += (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
              n++;
            }
          }
          blocks++;
          if (lum / n < 170) dark++;
          if (sat / n > 0.25) colorful++;
        }
      }
      return dark / blocks < 0.04 && colorful / blocks < 0.03;
    } catch (_) { return false; }
  }

  function getImgObj(page, args) {
    try {
      const a0 = args && args[0];
      if (a0 && typeof a0 === 'object') return a0;          // immagine inline
      if (typeof a0 !== 'string') return null;
      const store = a0.startsWith('g_') ? page.commonObjs : page.objs;
      return store.has(a0) ? store.get(a0) : null;
    } catch (_) { return null; }
  }

  // Box delle immagini disegnate sulla pagina (coordinate viewport, origine in alto a sx)
  async function pageImageBoxes(lib, page, viewport) {
    const OPS = lib.OPS;
    const ops = await page.getOperatorList();
    const stack = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const boxes = [];
    const vec = [];            // forme vettoriali piene (icone disegnate)
    let pendingPath = null;    // ultimo tracciato costruito, in attesa di riempimento
    let fillWhite = false;     // colore di riempimento corrente bianco/quasi bianco
    const FILL_OPS = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke,
      OPS.closeFillStroke, OPS.closeEOFillStroke].filter(v => v !== undefined));

    const isWhiteColor = (a) => {
      try {
        let r, g, b;
        if (typeof a?.[0] === 'string' && a[0][0] === '#') {
          const h = a[0]; r = parseInt(h.substr(1, 2), 16); g = parseInt(h.substr(3, 2), 16); b = parseInt(h.substr(5, 2), 16);
        } else if (Array.isArray(a) && a.length >= 3) { [r, g, b] = a.map(v => v <= 1 ? v * 255 : v); }
        else return false;
        return r > 235 && g > 235 && b > 235;
      } catch (_) { return false; }
    };

    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i];
      if (fn === OPS.setFillRGBColor) { fillWhite = isWhiteColor(args); continue; }
      if (fn === OPS.setFillGray) { fillWhite = (args?.[0] ?? 0) > 0.92; continue; }
      if (fn === OPS.constructPath) {
        const pathOps = args?.[0] || [];
        const mm = args?.[2];
        const rectOnly = pathOps.length > 0 && pathOps.every(o => o === OPS.rectangle);
        if (mm && isFinite(mm[0]) && isFinite(mm[2]) && !rectOnly) {
          const m = mulMat(viewport.transform, ctm);
          const pts = [applyMat(m, mm[0], mm[2]), applyMat(m, mm[1], mm[2]), applyMat(m, mm[0], mm[3]), applyMat(m, mm[1], mm[3])];
          const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
          pendingPath = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        } else pendingPath = null;
        continue;
      }
      if (FILL_OPS.has(fn)) {
        if (pendingPath && !fillWhite) vec.push(pendingPath);
        pendingPath = null;
        continue;
      }
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = mulMat(ctm, args);
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        if (Array.isArray(args?.[0]) && args[0].length === 6) ctm = mulMat(ctm, args[0]);
      } else if (fn === OPS.paintFormXObjectEnd) {
        ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      } else if (
        fn === OPS.paintImageXObject ||
        fn === OPS.paintInlineImageXObject ||
        fn === OPS.paintImageMaskXObject ||
        fn === OPS.paintImageXObjectRepeat
      ) {
        const m = mulMat(viewport.transform, ctm);
        const pts = [applyMat(m, 0, 0), applyMat(m, 1, 0), applyMat(m, 0, 1), applyMat(m, 1, 1)];
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        const drawing = fn === OPS.paintImageMaskXObject ? true : imageLooksLikeDrawing(getImgObj(page, args));
        const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        b.drawing = drawing;
        boxes.push(b);
      }
    }

    const W = viewport.width, H = viewport.height;
    // filtro: niente sfondi a pagina intera, loghi in testata, icone, fasce
    let list = boxes
      .map(b => { const c = [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(W, b[2]), Math.min(H, b[3])]; c.drawing = b.drawing; return c; })
      .filter(b => {
        const w = b[2] - b[0], h = b[3] - b[1];
        if (Math.min(w, h) < 6 || Math.max(w, h) < 30) return false;
        if (w * h < 500) return false;
        if (w * h > W * H * 0.5) return false;
        const ar = w / h;
        if (ar > 15 || ar < 1 / 15) return false;
        // linguette di sezione sul bordo pagina (SOLLEVATORI, SMONTAGOMME, ...)
        if ((ar > 3 || ar < 1 / 3) && (b[0] < 18 || b[2] > W - 18)) return false;
        if (b[3] < H * 0.085) return false;   // testata (logo, titolo)
        if (b[1] > H * 0.955) return false;   // piè di pagina
        return true;
      });

    // unisci immagini sovrapposte (immagine + maschera, foto composte da più pezzi)
    let merged = true;
    while (merged) {
      merged = false;
      outer:
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          const ix = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
          const iy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
          if (ix > 2 && iy > 2) {
            const areaA = (a[2] - a[0]) * (a[3] - a[1]);
            const areaB = (b[2] - b[0]) * (b[3] - b[1]);
            const inter = ix * iy;
            // si uniscono solo se si sovrappongono davvero (non per un bordo)
            if (inter > 0.25 * Math.min(areaA, areaB)) {
              const u = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
              u.drawing = !!(a.drawing && b.drawing); // basta una foto perché sia foto
              list[i] = u;
              list.splice(j, 1);
              merged = true;
              break outer;
            }
          }
        }
      }
    }

    // icone vettoriali: si raggruppano le forme vicine (es. cerchio giallo + onde)
    let groups = vec
      .filter(b => (b[2] - b[0]) < 260 && (b[3] - b[1]) < 260)
      .map(b => b.slice());
    let joined = true;
    while (joined) {
      joined = false;
      outerV:
      for (let i = 0; i < groups.length; i++) {
        for (let j = i + 1; j < groups.length; j++) {
          const a = groups[i], b = groups[j];
          if (a[0] - 2 <= b[2] && b[0] - 2 <= a[2] && a[1] - 2 <= b[3] && b[1] - 2 <= a[3]) {
            groups[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
            groups.splice(j, 1);
            joined = true;
            break outerV;
          }
        }
      }
    }
    const icons = groups.filter(b => {
      const w = b[2] - b[0], h = b[3] - b[1];
      if (w < 14 || h < 14 || w > 220 || h > 220) return false;
      if (w / h > 4 || w / h < 0.25) return false;          // fasce e linguette, non icone
      if (b[0] < 18 || b[2] > W - 18) return false;          // bordo pagina
      if (b[3] < H * 0.085 || b[1] > H * 0.955) return false;
      // non se coincide con una foto già presente
      return !list.some(p => b[0] >= p[0] - 2 && b[2] <= p[2] + 2 && b[1] >= p[1] - 2 && b[3] <= p[3] + 2);
    });

    // formato salvato: [x0, y0, x1, y1, tipo] — tipo 0 foto, 1 disegno tecnico, 2 icona vettoriale
    return [
      ...list.map(b => {
        const w = b[2] - b[0], h = b[3] - b[1], ar = w / h;
        // tipo 3: immagine stretta e lunga (leve, aste, ma anche fasce e linguette)
        const tipo = (ar > 5 || ar < 0.2) ? 3 : (b.drawing ? 1 : 0);
        return [...b.slice(0, 4).map(v => Math.round(v * 10) / 10), tipo];
      }),
      ...icons.map(b => [...b.map(v => Math.round(v * 10) / 10), 2])
    ];
  }

  async function pageCodes(page, viewport, lib) {
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const t = lib.Util.transform(viewport.transform, it.transform);
      const fh = Math.hypot(t[2], t[3]) || 8;
      items.push({ str: it.str, x: t[4], y: t[5], w: it.width || 0, h: fh });
    }

    // righe: elementi con baseline simile (per capire se la riga ha un prezzo)
    const rows = [];
    items.forEach(it => {
      let row = rows.find(r => Math.abs(r.y - it.y) < 3.5);
      if (!row) { row = { y: it.y, text: '' }; rows.push(row); }
      row.text += ' ' + it.str;
    });
    const rowHasPrice = (y) => rows.some(r => Math.abs(r.y - y) < 3.5 && PRICE_RE.test(r.text));

    const out = [];
    for (const it of items) {
      const re = /\S+/g;
      let m;
      const len = it.str.length || 1;
      while ((m = re.exec(it.str))) {
        const tok = m[0];
        if (!isCodeToken(tok)) continue;
        const x0 = it.x + it.w * (m.index / len);
        const x1 = it.x + it.w * ((m.index + tok.length) / len);
        out.push({
          key: normCode(tok),
          box: [x0, it.y - it.h, x1, it.y].map(v => Math.round(v * 10) / 10),
          price: rowHasPrice(it.y)
        });
      }
    }
    return out;
  }

  async function buildIndex(onProgress) {
    const lib = pdfLib();
    const doc = await getDoc();
    if (!lib || !doc) throw new Error('pdf.js non disponibile');

    const index = { v: INDEX_VERSION, fp: state.meta.fp, pages: [], codes: {} };

    for (let p = 1; p <= doc.numPages; p++) {
      if (onProgress) onProgress(p, doc.numPages);
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      let imgs = [];
      try { imgs = await pageImageBoxes(lib, page, viewport); } catch (e) { console.warn('[PDF] immagini pag.', p, e); }
      const codes = await pageCodes(page, viewport, lib);
      // righe prezzo della pagina: servono a delimitare le "sezioni" prodotto
      const prRows = [];
      codes.forEach(c => { if (c.price) prRows.push([c.box[1], c.box[3]]); });
      prRows.sort((a, b) => a[0] - b[0]);
      index.pages.push({ w: viewport.width, h: viewport.height, imgs, pr: prRows });

      codes.forEach(c => {
        if (!index.codes[c.key]) index.codes[c.key] = [];
        index.codes[c.key].push({ p, b: c.box, pr: c.price ? 1 : 0 });
      });

      try { page.cleanup(); } catch (_) {}
    }
    return index;
  }

  // -------------------- SCELTA IMMAGINE PER UN CODICE --------------------
  function chooseImage(pageInfo, occ) {
    const imgs = pageInfo.imgs || [];
    if (!imgs.length) return null;

    const [cx0, cy0, cx1, cy1] = occ.b;
    const ccx = (cx0 + cx1) / 2;
    const ccy = (cy0 + cy1) / 2;
    const area = b => (b[2] - b[0]) * (b[3] - b[1]);

    // 1) tabella: immagine sulla stessa riga, a sinistra del codice
    let best = null, bestGap = Infinity;
    imgs.forEach(b => {
      const sameRow = ccy >= b[1] - 6 && ccy <= b[3] + 6;
      const gap = cx0 - b[2];
      // solo immagini attaccate alla cella del codice (tabelle accessori),
      // non foto di un altro riquadro più a sinistra
      if (sameRow && gap >= -6 && gap < 60 && gap < bestGap) { best = b; bestGap = gap; }
    });
    if (best) return { box: best, conf: 3 };

    // 2) didascalia: codice appena sotto l'immagine (non sulle righe prezzo)
    if (!occ.pr) {
      best = null; let bestD = Infinity;
      imgs.forEach(b => {
        const d = cy0 - b[3];
        const inX = ccx >= b[0] - 45 && ccx <= b[2] + 45;
        if (inX && d >= -8 && d < 34 && d < bestD) { best = b; bestD = d; }
      });
      if (best) return { box: best, conf: 3 };
    }

    // 3) immagine principale della sezione, sopra al codice
    const weight = b => area(b) * (b[4] === 1 ? 0.12 : 1); // i disegni tecnici pesano poco
    // icone (2) e immagini strette (3) non fanno mai da foto principale
    const photos = imgs.filter(b => b[4] === 0 || b[4] === 1);
    let above = photos.filter(b => b[3] <= cy0 + 6);

    if (occ.pr) {
      // sezione = dalla tabella prezzi precedente (se c'è) fino alla riga del codice
      const rowsPr = (pageInfo.pr || []).slice().sort((a, b) => a[0] - b[0]);
      let blockTop = cy0;
      for (let i = rowsPr.length - 1; i >= 0; i--) {
        const r = rowsPr[i];
        if (r[0] > cy0 + 1) continue;
        if (blockTop - r[1] < 40) blockTop = Math.min(blockTop, r[0]);
        else break;
      }
      const prevRows = rowsPr.filter(r => r[1] < blockTop - 40);
      const sectionTop = prevRows.length ? Math.max(...prevRows.map(r => r[1])) : -1;
      const inSection = above.filter(b => b[1] >= sectionTop - 5);
      if (inSection.length) above = inSection;

      if (above.length) {
        const maxW = Math.max(...above.map(weight));
        const big = above.filter(b => weight(b) >= maxW * 0.45).sort((a, b) => a[1] - b[1]);
        const main = big[0];
        // famiglia: altre foto affiancate alla principale (stessa altezza e allineamento)
        const h = main[3] - main[1];
        const fam = above.filter(b => b[4] === 0 && Math.abs(b[1] - main[1]) < 20 &&
          (b[3] - b[1]) > h * 0.6 && (b[3] - b[1]) < h * 1.6);
        const box = fam.length > 1
          ? [Math.min(...fam.map(b => b[0])), Math.min(...fam.map(b => b[1])), Math.max(...fam.map(b => b[2])), Math.max(...fam.map(b => b[3]))]
          : main;
        return { box, conf: 2 };
      }
    } else {
      best = null; let bestScore = -1;
      above.forEach(b => {
        const d = cy0 - b[3];
        const score = weight(b) / (d + 60);
        if (score > bestScore) { best = b; bestScore = score; }
      });
      if (best) return { box: best, conf: 1 };
    }

    // 4) ripiego: l'immagine più grande della pagina
    best = photos.slice().sort((a, b) => weight(b) - weight(a))[0];
    return best ? { box: best, conf: 0.5 } : null;
  }

  // Pagine "tabella accessori": molte righe prezzo con l'immagine accanto.
  // Lì, se una riga non ha un'immagine sua, meglio nessuna immagine che una sbagliata.
  let tablePagesCache = null;
  function isTablePage(p) {
    if (!state.index) return false;
    if (!tablePagesCache || tablePagesCache.fp !== state.index.fp) {
      const counts = {};
      Object.values(state.index.codes).forEach(list => list.forEach(o => {
        if (!o.pr) return;
        const pi = state.index.pages[o.p - 1];
        const ch = pi ? chooseImage(pi, o) : null;
        if (ch && ch.conf >= 3) counts[o.p] = (counts[o.p] || 0) + 1;
      }));
      tablePagesCache = { fp: state.index.fp, counts };
    }
    return (tablePagesCache.counts[p] || 0) >= 3;
  }

  function resolve(code, pagine) {
    if (!state.index) return null;
    const occs = state.index.codes[normCode(code)];
    if (!occs || !occs.length) return null;

    // pagina indicata nel CSV (colonna "Pagine"): preferita se presente
    const hinted = new Set(String(pagine || '').match(/\d+/g) || []);

    let best = null;
    occs.forEach((o, i) => {
      const pi = state.index.pages[o.p - 1];
      if (!pi) return;
      let ch = chooseImage(pi, o);
      if (ch && ch.conf < 3 && o.pr && isTablePage(o.p)) ch = null;
      let score = ch ? ch.conf : 0;
      if (hinted.has(String(o.p))) score += 0.75;
      // a parità di certezza vince la riga con il prezzo (tabella listino)
      if (o.pr && ch && ch.conf >= 3) score += 0.4;
      score -= i * 0.001; // a parità vince la prima occorrenza
      if (!best || score > best.score) best = { score, p: o.p, box: ch ? ch.box : null };
    });
    return best;
  }

  // -------------------- RENDER (coda seriale) --------------------
  let renderChain = Promise.resolve();
  function enqueue(job) {
    const p = renderChain.then(job, job);
    renderChain = p.catch(() => {});
    return p;
  }

  async function renderRegion(pageNum, box, maxSide, quality) {
    const lib = pdfLib();
    const doc = await getDoc();
    if (!lib || !doc) return null;
    const page = await doc.getPage(pageNum);
    const base = page.getViewport({ scale: 1 });

    const pad = 4;
    const x0 = Math.max(0, box[0] - pad), y0 = Math.max(0, box[1] - pad);
    const x1 = Math.min(base.width, box[2] + pad), y1 = Math.min(base.height, box[3] + pad);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 1 || h <= 1) return null;

    const scale = Math.min(4, Math.max(1, maxSide / Math.max(w, h)));
    const vp = page.getViewport({ scale, offsetX: -x0 * scale, offsetY: -y0 * scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const url = canvas.toDataURL('image/jpeg', quality || 0.85);
    canvas.width = canvas.height = 0; // libera memoria (iOS)
    try { page.cleanup(); } catch (_) {}
    return url;
  }

  // Miniatura del prodotto per un codice -> dataURL o null
  function getThumb(code, pagine) {
    if (!state.index || !state.meta) return Promise.resolve(null);
    const key = normCode(code);
    if (!key) return Promise.resolve(null);
    const cacheKey = `${state.meta.fp}|r6|${key}`; // r6: regole di scelta aggiornate

    if (state.thumbMem.has(cacheKey)) return Promise.resolve(state.thumbMem.get(cacheKey));
    if (state.pending.has(cacheKey)) return state.pending.get(cacheKey);

    const job = (async () => {
      try {
        const cached = await thumbGet(cacheKey).catch(() => undefined);
        if (cached !== undefined) { state.thumbMem.set(cacheKey, cached); return cached; }

        const r = resolve(code, pagine);
        if (!r || !r.box) { state.thumbMem.set(cacheKey, null); return null; }

        const url = await enqueue(() => renderRegion(r.p, r.box, 520, 0.85));
        state.thumbMem.set(cacheKey, url);
        if (rememberEnabled()) thumbSet(cacheKey, url).catch(() => {});
        return url;
      } catch (e) {
        console.warn('[PDF] miniatura non disponibile per', code, e);
        return null;
      } finally {
        state.pending.delete(cacheKey);
      }
    })();

    state.pending.set(cacheKey, job);
    return job;
  }

  function pageOf(code, pagine) {
    const r = resolve(code, pagine);
    return r ? r.p : null;
  }

  async function getPageImage(pageNum) {
    const info = state.index?.pages[pageNum - 1];
    if (!info) return null;
    return enqueue(() => renderRegion(pageNum, [0, 0, info.w, info.h], 1400, 0.82));
  }

  // -------------------- CARICAMENTO / MEMORIA --------------------
  async function loadFromFile(file) {
    if (!file) return;
    const lib = pdfLib();
    if (!lib) { setStatus('Libreria PDF non disponibile. Ricarica la pagina.', '#b71c1c'); return; }
    if (state.busy) return;
    state.busy = true;

    try {
      setStatus('Lettura del PDF…');
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
        setStatus('Il file scelto non è un PDF valido.', '#b71c1c');
        return;
      }

      await closeDoc();
      state.bytes = bytes;
      state.meta = { name: file.name, size: file.size, lastModified: file.lastModified, fp: fingerprint(file) };
      state.index = null;
      state.thumbMem.clear();

      const doc = await getDoc();
      state.meta.pages = doc.numPages;

      const index = await buildIndex((p, n) => setStatus(`Indicizzazione listino PDF: pagina ${p} di ${n}…`));
      state.index = index;
      state.meta.codes = Object.keys(index.codes).length;
      state.meta.savedAt = Date.now();

      if (rememberEnabled()) {
        try {
          await thumbClear();
          await kvSet(KEY_PDF, bytes);
          await kvSet(KEY_META, state.meta);
          await kvSet(KEY_INDEX, index);
        } catch (e) {
          console.warn('[PDF] salvataggio locale non riuscito', e);
          setStatus('PDF caricato, ma non è stato possibile salvarlo sul dispositivo (spazio insufficiente?).', '#e65100');
        }
      }

      updateInfoUI();
      setStatus(`Listino PDF pronto: ${doc.numPages} pagine, ${state.meta.codes} codici trovati.`);
      refreshAll();
    } catch (e) {
      console.error('[PDF] errore caricamento', e);
      setStatus('Errore nella lettura del PDF.', '#b71c1c');
    } finally {
      state.busy = false;
    }
  }

  async function restore() {
    try {
      const [meta, bytes, index] = await Promise.all([kvGet(KEY_META), kvGet(KEY_PDF), kvGet(KEY_INDEX)]);
      if (!meta || !bytes) { updateInfoUI(); return; }
      state.meta = meta;
      state.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

      if (index && index.v === INDEX_VERSION && index.fp === meta.fp) {
        state.index = index;
      } else {
        // indice assente o di una versione precedente: si ricostruisce
        state.index = await buildIndex((p, n) => setStatus(`Aggiornamento indice PDF: pagina ${p} di ${n}…`));
        meta.codes = Object.keys(state.index.codes).length;
        await thumbClear().catch(() => {});
        await kvSet(KEY_INDEX, state.index).catch(() => {});
        await kvSet(KEY_META, meta).catch(() => {});
        setStatus('');
      }
      updateInfoUI();
      refreshAll();
    } catch (e) {
      console.warn('[PDF] ripristino non riuscito', e);
      updateInfoUI();
    }
  }

  async function clearSaved() {
    try { await kvDel(KEY_PDF); await kvDel(KEY_META); await kvDel(KEY_INDEX); await thumbClear(); }
    catch (e) { console.warn('[PDF] cancellazione non riuscita', e); }
  }

  async function unload() {
    await clearSaved();
    await closeDoc();
    state.bytes = null; state.meta = null; state.index = null;
    state.thumbMem.clear();
    updateInfoUI();
    setStatus('');
    refreshAll();
  }

  // -------------------- UI: MINIATURE --------------------
  function placeholderThumb(container) {
    container.innerHTML = '';
    container.classList.add('xp-thumb--empty');
  }

  function fillThumb(imgWrap, code, pagine) {
    if (!imgWrap) return;
    if (!state.index) { imgWrap.hidden = true; return; }
    imgWrap.hidden = false;
    imgWrap.classList.add('xp-thumb--loading');
    getThumb(code, pagine).then(url => {
      imgWrap.classList.remove('xp-thumb--loading');
      if (!url) { imgWrap.hidden = true; return; }
      imgWrap.classList.remove('xp-thumb--empty');
      imgWrap.innerHTML = '';
      const img = new Image();
      img.alt = `Immagine ${code}`;
      img.src = url;
      img.decoding = 'async';
      imgWrap.appendChild(img);
      imgWrap.dataset.code = code;
      imgWrap.dataset.pagine = pagine || '';
    });
  }

  function makeThumbButton(code, pagine) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'xp-thumb';
    b.title = 'Apri immagine dal listino PDF';
    b.setAttribute('aria-label', `Immagine articolo ${code}`);
    b.addEventListener('click', () => openLightbox(code, pagine));
    placeholderThumb(b);
    fillThumb(b, code, pagine);
    return b;
  }

  // chiamata da renderTabellaArticoli() in app.js
  function onTableRendered() {
    const rows = document.querySelectorAll('#articoli-table tbody tr[data-index]');
    const items = (typeof articoliAggiunti !== 'undefined') ? articoliAggiunti : [];
    rows.forEach(tr => {
      const idx = parseInt(tr.dataset.index, 10);
      const art = items[idx];
      const td = tr.querySelector('td[data-col="codice"]');
      if (!art || !td || td.querySelector('.xp-code')) return;

      const code = String(art.codice ?? '');
      const wrap = document.createElement('span');
      wrap.className = 'xp-code';
      const txt = document.createElement('span');
      txt.className = 'xp-code-txt';
      txt.textContent = code;
      td.textContent = '';
      wrap.appendChild(txt);
      if (state.index && code) wrap.appendChild(makeThumbButton(code, art.pagine));
      td.appendChild(wrap);
    });
  }

  function refreshSelectPreview() {
    const box = el('pdfPreview');
    const select = el('listinoSelect');
    if (!box || !select) return;
    const code = select.value;
    if (!state.index || !code) { box.hidden = true; box.innerHTML = ''; return; }

    const art = (typeof listino !== 'undefined') ? listino.find(i => i.codice === code) : null;
    const pagine = art ? art.pagine : '';
    box.hidden = false;
    box.innerHTML = '';
    const btn = makeThumbButton(code, pagine);
    btn.classList.add('xp-thumb--big');
    const cap = document.createElement('div');
    cap.className = 'xp-preview-cap';
    const p = pageOf(code, pagine);
    cap.textContent = p ? `${code} • listino PDF pag. ${p}` : `${code} • non trovato nel listino PDF`;
    box.appendChild(btn);
    box.appendChild(cap);
  }

  function refreshAll() {
    // ridisegna le miniature della tabella senza toccare dati o calcoli
    document.querySelectorAll('#articoli-table td[data-col="codice"] .xp-code').forEach(w => {
      const td = w.parentElement;
      const txt = w.querySelector('.xp-code-txt');
      td.textContent = txt ? txt.textContent : '';
    });
    onTableRendered();
    refreshSelectPreview();
  }

  // -------------------- LIGHTBOX --------------------
  async function openLightbox(code, pagine) {
    const lb = el('xpLightbox');
    if (!lb) return;
    const img = el('xpLightboxImg');
    const cap = el('xpLightboxCap');
    const btnPage = el('xpLightboxPage');
    const p = pageOf(code, pagine);

    img.removeAttribute('src');
    cap.textContent = `${code}${p ? ' • pag. ' + p : ''}`;
    btnPage.hidden = !p;
    btnPage.textContent = 'Vedi pagina intera';
    btnPage.onclick = async () => {
      btnPage.textContent = 'Caricamento…';
      const url = await getPageImage(p);
      if (url) img.src = url;
      btnPage.hidden = true;
    };

    lb.hidden = false;
    document.body.classList.add('xp-noscroll');
    const url = await getThumb(code, pagine);
    if (url) img.src = url;
  }

  function closeLightbox() {
    const lb = el('xpLightbox');
    if (lb) lb.hidden = true;
    document.body.classList.remove('xp-noscroll');
  }

  // -------------------- STAMPA CON IMMAGINI --------------------
  // Usa ESATTAMENTE il testo dei report di app.js (stessa logica del TXT),
  // spezzato per articolo, e affianca a ogni articolo la sua immagine.
  // App iOS (Capacitor): il WKWebView non sa stampare. Si genera un file PDF
  // (stesso contenuto della stampa) che si apre nel pannello Condividi di iOS,
  // da cui si può stampare, salvare in File, inviare per Mail/WhatsApp.
  function isNativeApp() {
    try {
      if (window.__CAPACITOR_NATIVE__) return true;
      return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
    } catch (_) { return false; }
  }

  function imgSize(url) {
    return new Promise(res => {
      const im = new Image();
      im.onload = () => res({ w: im.naturalWidth || 1, h: im.naturalHeight || 1 });
      im.onerror = () => res(null);
      im.src = url;
    });
  }

  async function stampaComePDF(report, items, parts, splitOk, senzaMargine) {
    const JsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!JsPDF) { alert('Generazione PDF non disponibile.'); return; }

    const doc = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const M = 12, W = 210, H = 297, PIC = 38, GAP = 6, LH = 4.6;
    const textX = M + PIC + GAP, textW = W - M - textX;
    let y = M;

    // intestazione
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
    doc.text(splitOk ? parts[0].replace(/:$/, '') : 'Report', M, y + 5);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    doc.text(new Date().toLocaleDateString('it-IT'), W - M, y + 5, { align: 'right' });
    y += 9;
    doc.setLineWidth(0.6); doc.line(M, y, W - M, y);
    y += 5;

    doc.setFontSize(10.5);

    if (!splitOk) {
      doc.splitTextToSize(report, W - 2 * M).forEach(line => {
        if (y + LH > H - M) { doc.addPage(); y = M; }
        doc.text(line, M, y + 3.5); y += LH;
      });
    } else {
      const n = items.length;
      for (let i = 0; i < n; i++) {
        const url = state.index ? await getThumb(items[i].codice, items[i].pagine).catch(() => null) : null;
        const lines = doc.splitTextToSize(parts[i + 1], textW);
        const rowH = Math.max(PIC, lines.length * LH) + 6;
        if (y + rowH > H - M) { doc.addPage(); y = M; }

        if (url) {
          const sz = await imgSize(url);
          if (sz) {
            const k = Math.min(PIC / sz.w, PIC / sz.h);
            const w = sz.w * k, h = sz.h * k;
            try { doc.addImage(url, 'JPEG', M + (PIC - w) / 2, y + (PIC - h) / 2, w, h); } catch (_) {}
          }
        }
        doc.setFont('helvetica', 'normal');
        lines.forEach((line, k) => doc.text(line, textX, y + 3.5 + k * LH));
        y += rowH;
        doc.setLineWidth(0.2); doc.setDrawColor(200);
        doc.line(M, y - 3, W - M, y - 3);
        doc.setDrawColor(0);
      }

      const tot = parts.slice(n + 1).join('\n\n');
      if (tot.trim()) {
        doc.setFont('helvetica', 'bold');
        const tl = doc.splitTextToSize(tot, W - 2 * M);
        if (y + tl.length * LH > H - M) { doc.addPage(); y = M; }
        y += 2;
        tl.forEach(line => { doc.text(line, M, y + 3.5); y += LH; });
      }
    }

    const nome = senzaMargine ? 'preventivo_immagini_senza_margine.pdf' : 'preventivo_immagini.pdf';
    const blob = doc.output('blob');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nome;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click(); // su iOS lo intercetta ios-share-shim.js e apre il pannello Condividi
    setTimeout(() => { try { a.remove(); URL.revokeObjectURL(url); } catch (_) {} }, 60000);
  }

  async function stampa(senzaMargine) {
    if (typeof reportVuoto === 'function' && reportVuoto()) return;

    const report = senzaMargine ? generaReportTestoSenzaMargine() : generaReportTesto();
    if (typeof mostraAnteprimaReport === 'function') mostraAnteprimaReport(report);

    const items = (typeof articoliAggiunti !== 'undefined') ? articoliAggiunti : [];
    const parts = report.replace(/\n+$/, '').split('\n\n');
    const n = items.length;
    const splitOk = parts.length >= n + 1;

    // Opzione solo-stampa: aggiunge il Prezzo Lordo sotto descrizione/codice.
    // I report TXT/WhatsApp e i calcoli non vengono toccati.
    if (splitOk && printShowLordo()) {
      for (let i = 0; i < n; i++) {
        const a = items[i] || {};
        let lordo;
        try { lordo = roundTwo(parseDec(a.prezzoLordo || 0)).toFixed(2); }
        catch (_) { lordo = Number(a.prezzoLordo || 0).toFixed(2); }
        const riga = `Prezzo lordo: ${lordo}€`;
        const lines = parts[i + 1].split('\n');
        let at = lines.findIndex(l => l.startsWith('Descrizione:'));
        if (at < 0) at = lines.findIndex(l => l.startsWith('Codice:'));
        if (at < 0) at = 0;
        lines.splice(at + 1, 0, riga);
        parts[i + 1] = lines.join('\n');
      }
    }

    if (isNativeApp()) {
      try { await stampaComePDF(report, items, parts, splitOk, senzaMargine); }
      catch (e) { console.error('[PDF] generazione non riuscita', e); alert('Impossibile generare il PDF.'); }
      return;
    }

    let area = el('xpPrintArea');
    if (!area) {
      area = document.createElement('div');
      area.id = 'xpPrintArea';
      document.body.appendChild(area);
    }
    area.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'xp-print-head';
    const h = document.createElement('div');
    h.className = 'xp-print-title';
    h.textContent = splitOk ? parts[0].replace(/:$/, '') : 'Report';
    const d = document.createElement('div');
    d.className = 'xp-print-date';
    d.textContent = new Date().toLocaleDateString('it-IT');
    head.appendChild(h); head.appendChild(d);
    area.appendChild(head);

    if (!splitOk) {
      const pre = document.createElement('pre');
      pre.textContent = report;
      area.appendChild(pre);
    } else {
      const thumbs = await Promise.all(items.map(a =>
        state.index ? getThumb(a.codice, a.pagine).catch(() => null) : Promise.resolve(null)));

      for (let i = 0; i < n; i++) {
        const row = document.createElement('div');
        row.className = 'xp-print-row';
        const pic = document.createElement('div');
        pic.className = 'xp-print-pic';
        if (thumbs[i]) {
          const img = new Image();
          img.src = thumbs[i];
          img.alt = '';
          pic.appendChild(img);
        }
        const pre = document.createElement('pre');
        pre.textContent = parts[i + 1];
        row.appendChild(pic);
        row.appendChild(pre);
        area.appendChild(row);
      }

      const tot = document.createElement('pre');
      tot.className = 'xp-print-tot';
      tot.textContent = parts.slice(n + 1).join('\n\n');
      area.appendChild(tot);
    }

    // attende il decode delle immagini prima della stampa
    await Promise.all(Array.from(area.querySelectorAll('img')).map(img =>
      (img.decode ? img.decode() : Promise.resolve()).catch(() => {})));

    document.body.classList.add('xp-printing');
    const done = () => {
      document.body.classList.remove('xp-printing');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    setTimeout(() => {
      try { window.print(); } catch (e) { console.warn('Stampa non disponibile', e); }
      // alcuni browser mobili non emettono afterprint
      setTimeout(done, 1500);
    }, 50);
  }

  // -------------------- OPZIONE STAMPA: PREZZO LORDO --------------------
  const PRINT_LORDO_KEY = 'xpress_print_show_lordo_v1';
  function printShowLordo() {
    const chk = el('togglePrintLordo');
    if (chk) return !!chk.checked;
    try { return localStorage.getItem(PRINT_LORDO_KEY) === '1'; } catch (_) { return false; }
  }

  // -------------------- INIT --------------------
  function bindUI() {
    const input = el('pdfFileInput');
    if (input) input.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      try { e.target.value = ''; } catch (_) {}
      if (f) loadFromFile(f);
    });

    const chk = el('toggleRememberPDF');
    if (chk) {
      try {
        const saved = localStorage.getItem(REMEMBER_KEY);
        if (saved !== null) chk.checked = saved === '1';
      } catch (_) {}
      chk.addEventListener('change', async () => {
        try { localStorage.setItem(REMEMBER_KEY, chk.checked ? '1' : '0'); } catch (_) {}
        if (!chk.checked) {
          await clearSaved(); // privacy: niente copia sul dispositivo
        } else if (state.bytes && state.meta) {
          try {
            await kvSet(KEY_PDF, state.bytes);
            await kvSet(KEY_META, state.meta);
            await kvSet(KEY_INDEX, state.index);
          } catch (_) {}
        }
      });
    }

    const btnClear = el('btnClearSavedPDF');
    if (btnClear) btnClear.addEventListener('click', async () => {
      await unload();
      alert('Listino PDF rimosso da questo dispositivo.');
    });

    const select = el('listinoSelect');
    if (select) {
      select.addEventListener('change', refreshSelectPreview);
      select.addEventListener('input', refreshSelectPreview);
    }
    const search = el('searchListino');
    if (search) search.addEventListener('input', () => setTimeout(refreshSelectPreview, 0));

    // il listino CSV viene caricato da app.js in modo asincrono: aggiorna l'anteprima
    const csvInput = el('csvFileInput');
    if (csvInput) csvInput.addEventListener('change', () => setTimeout(refreshSelectPreview, 800));
    const btnLoadCsv = el('btnLoadSavedCSV');
    if (btnLoadCsv) btnLoadCsv.addEventListener('click', () => setTimeout(refreshSelectPreview, 300));
    if (select && 'MutationObserver' in window) {
      new MutationObserver(() => refreshSelectPreview()).observe(select, { childList: true });
    }

    const lb = el('xpLightbox');
    if (lb) {
      lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });
      const x = el('xpLightboxClose');
      if (x) x.addEventListener('click', closeLightbox);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
    }

    const chkLordo = el('togglePrintLordo');
    if (chkLordo) {
      try { chkLordo.checked = localStorage.getItem(PRINT_LORDO_KEY) === '1'; } catch (_) {}
      chkLordo.addEventListener('change', () => {
        try { localStorage.setItem(PRINT_LORDO_KEY, chkLordo.checked ? '1' : '0'); } catch (_) {}
      });
    }

    const b1 = el('btnPrint');
    if (b1) b1.addEventListener('click', () => stampa(false));
    const b2 = el('btnPrintSenzaMargine');
    if (b2) b2.addEventListener('click', () => stampa(true));

    updateInfoUI();
    restore();
  }

  window.XpressPDF = {
    normCode, onTableRendered, stampa, getThumb, pageOf, loadFromFile, unload,
    _state: state, _resolve: resolve
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindUI);
  else bindUI();
})();
