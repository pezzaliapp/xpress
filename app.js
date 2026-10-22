/* ===========================
   Xpress — app.js (clone di CSVXpressSmart, logica invariata)
   + Listino PDF con immagini: vedi pdf-listino.js (unico aggancio: onTableRendered)
   Fix: decimali con virgola + report smart formattato + tabella stabile
   + Feature: "Sconto Cliente" (flag) che sostituisce sconto1/sconto2/margine mantenendo invariato il prezzo finale
   =========================== */

// Registra il Service Worker (PWA) — update robusto (iOS/Android/Desktop)
// - registra con cache-bust (?v=...)
// - check update ad ogni apertura
// - attiva subito la nuova versione (skipWaiting via message)
// - ricarica automaticamente quando il nuovo SW prende il controllo
if ('serviceWorker' in navigator) {
  // true solo se la pagina è GIÀ controllata: al primissimo avvio non serve reload
  const HAD_CONTROLLER = !!navigator.serviceWorker.controller;
  let swReloading = false;

  // Ricarica per usare subito i nuovi asset:
  // - prima installazione (pagina non controllata): nessun reload a sorpresa;
  // - un solo reload per istanza di pagina;
  // - anti-loop: al massimo un reload automatico ogni 10 secondi.
  function onSwControllerChange() {
    if (!HAD_CONTROLLER || swReloading) return;

    try {
      const last = Number(sessionStorage.getItem('sw_reload_at') || 0);
      if (Date.now() - last < 10000) return;
      sessionStorage.setItem('sw_reload_at', String(Date.now()));
    } catch (_) { /* storage non disponibile: si procede comunque */ }

    swReloading = true;

    // Ricaricare nell'istante esatto del cambio controller fa ripartire la
    // pagina SENZA service worker (registrazione ancora in assestamento):
    // l'app resterebbe senza offline e potrebbe pescare asset dalla cache HTTP.
    // Si attende che la registrazione sia pronta, poi si ricarica.
    const ricarica = () => window.location.reload();
    navigator.serviceWorker.ready.then(() => setTimeout(ricarica, 250)).catch(ricarica);
  }

  // IMPORTANTE: in ascolto PRIMA di registrare. Un SW nuovo con skipWaiting
  // può prendere il controllo mentre register()/update() sono ancora in corso:
  // agganciando l'evento dopo, l'aggiornamento passerebbe inosservato e
  // l'utente resterebbe su CSS/JS vecchi fino al riavvio successivo.
  navigator.serviceWorker.addEventListener('controllerchange', onSwControllerChange);

  window.addEventListener('load', async () => {
    const VER = document.documentElement.getAttribute('data-ver') || 'dev';
    const SW_URL = `service-worker.js?v=${encodeURIComponent(VER)}`;

    try {
      const reg = await navigator.serviceWorker.register(SW_URL);

      // SW già in attesa (installato ma non attivo) -> sbloccalo subito
      if (reg.waiting) {
        try { reg.waiting.postMessage({ type: 'SKIP_WAITING' }); } catch (_) {}
      }

      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          // nuovo SW pronto e c'è già un controller -> forza attivazione
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            try { nw.postMessage({ type: 'SKIP_WAITING' }); } catch (_) {}
          }
        });
      });

      try { await reg.update(); } catch (_) {}
    } catch (err) {
      // Nessun SW = app comunque funzionante (solo senza offline)
      console.warn('Service Worker non registrato', err);
    }
  });
}


// Variabili globali
let listino = [];
let articoliAggiunti = [];
let autoPopolaCosti = false; // Xpress: di default trasporto/installazione non popolati
let mostraDettagliServizi = true;

// -------------------- HELPERS NUMERICI (virgola/decimali) --------------------
// parseDec(val) -> number
// Accetta: numeri JS (Excel), stringhe in formato IT/USA/misto.
//   - EU:  "4.380,00" -> 4380   "60,43" -> 60.43   "1.234.567" -> 1234567
//   - USA: "4,380.00" -> 4380   "60.43" -> 60.43   "1,234,567" -> 1234567
//   - IT abbreviato: " 10.850 " -> 10850 (1 separatore + 3 cifre = migliaia)
//   - "" / null / non valido -> 0
// Regole: separatori multipli dello stesso tipo = migliaia; con entrambi i
// tipi l'ULTIMO è il decimale; con un solo separatore + 3 cifre dopo = migliaia.
function parseDec(val) {
  // Se è già un numero (es. da Excel/SheetJS), restituiscilo direttamente
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;

  let s = String(val ?? '').trim().replace(/\s+/g, '');
  if (!s) return 0;

  const commaCount = (s.match(/,/g) || []).length;
  const dotCount = (s.match(/\./g) || []).length;

  if (commaCount === 0 && dotCount === 0) {
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  }

  // Multipli separatori dello stesso tipo: sono separatori migliaia
  if (commaCount > 1 && dotCount === 0) {
    // Es. "1,234,567" formato USA senza decimali
    s = s.replace(/,/g, '');
  } else if (dotCount > 1 && commaCount === 0) {
    // Es. "1.234.567" formato IT senza decimali
    s = s.replace(/\./g, '');
  } else if (commaCount >= 1 && dotCount >= 1) {
    // Entrambi presenti: l'ULTIMO separatore è il decimale, gli altri migliaia
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > lastDot) {
      // Es. "4.380,00" → "4380.00"
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // Es. "4,380.00" → "4380.00"
      s = s.replace(/,/g, '');
    }
  } else {
    // UN solo separatore: ambiguo. Euristica:
    // - "10.850" (3 cifre dopo) → migliaia, formato italiano abbreviato
    // - "60.43" / "60,43" / "1.5" → decimale
    const sep = commaCount > 0 ? ',' : '.';
    const parts = s.split(sep);
    if (parts.length === 2 && parts[1].length === 3 && /^\d+$/.test(parts[1])) {
      // 3 cifre dopo separatore = migliaia (convenzione internazionale)
      s = s.replace(sep, '');
    } else {
      // Decimale: normalizza a punto
      if (sep === ',') s = s.replace(',', '.');
    }
  }

  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function fmtDec(num, decimals = 2, trim = true) {
  if (!Number.isFinite(num)) return '';
  let s = Number(num).toFixed(decimals);
  if (trim) s = s.replace(/\.?0+$/, '');
  return s.replace('.', ',');
}

function roundTwo(num) { return Math.round(num * 100) / 100; }
function clamp(num, min, max) { return Math.max(min, Math.min(max, num)); }

// Mantiene il valore "in digitazione" senza forzare formati mentre scrivi (evita che la virgola venga “mangiata”)
function sanitizeDecimalTyping(str) {
  let s = String(str ?? '');
  // consenti solo numeri, - (inizio), virgola/punto
  s = s.replace(/[^\d,.\-]/g, '');
  // solo un eventuale '-' all’inizio
  s = s.replace(/(?!^)-/g, '');
  // se ci sono più separatori, tieni il primo e rimuovi gli altri
  const firstSep = s.search(/[.,]/);
  if (firstSep !== -1) {
    const head = s.slice(0, firstSep + 1);
    const tail = s.slice(firstSep + 1).replace(/[.,]/g, '');
    s = head + tail;
  }
  return s;
}

// -------------------- SICUREZZA OUTPUT --------------------
// I dati arrivano da CSV/Excel dell'utente: vanno inseriti come testo, mai come HTML.
function escapeHtml(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// -------------------- EXPORT FILE (Android-safe) --------------------
// Scarica un file di testo funzionando su Chrome Android, Samsung Internet,
// Firefox Android, iOS Safari e desktop.
// Note importanti:
//  - l'Object URL NON va revocato subito: su Android il download parte in modo
//    asincrono e revocare troppo presto lo annulla (file vuoto / "download fallito");
//  - il bridge nativo window.Android è OPZIONALE: se manca si usa il browser.
function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });

  // 1) Bridge app nativa (facoltativo, mai obbligatorio per il web)
  try {
    const bridge = window.Android;
    if (bridge) {
      if (typeof bridge.saveTextFile === 'function') { bridge.saveTextFile(filename, text); return true; }
      if (typeof bridge.saveFile === 'function') { bridge.saveFile(filename, text); return true; }
    }
  } catch (_) { /* bridge assente o non compatibile: si prosegue col browser */ }

  // 2) Percorso standard browser: <a download> + Object URL
  const supportsDownload = typeof document.createElement('a').download !== 'undefined';
  if (supportsDownload) {
    try {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.rel = 'noopener';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();

      // Pulizia ritardata: il download deve avere il tempo di partire
      setTimeout(() => {
        try { link.remove(); } catch (_) {}
        try { URL.revokeObjectURL(url); } catch (_) {}
      }, 60000);

      return true;
    } catch (err) {
      console.warn('Download via <a download> non riuscito, provo il fallback:', err);
    }
  }

  // 3) Fallback: apri il contenuto in una nuova scheda (l'utente salva/condivide)
  try {
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    if (!win) window.location.href = url;
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);
    return true;
  } catch (err) {
    console.error('Impossibile generare il file:', err);
    alert('Impossibile generare il file su questo browser. Il report resta visibile qui sotto: puoi selezionarlo e copiarlo.');
    return false;
  }
}

// Mostra il report generato in pagina (utile su Android dove il download è silenzioso)
function mostraAnteprimaReport(text) {
  const el = document.getElementById('reportPreview');
  if (!el) return;
  el.textContent = text;
  el.style.display = 'block';
}

// -------------------- WHATSAPP (Android-safe) --------------------
function apriWhatsAppConTesto(testo) {
  // wa.me è l'endpoint ufficiale: su Android apre direttamente l'app WhatsApp
  const url = 'https://wa.me/?text=' + encodeURIComponent(testo);

  try {
    const win = window.open(url, '_blank', 'noopener');
    // popup bloccato (frequente in PWA standalone): naviga nella stessa scheda
    if (!win || win.closed || typeof win.closed === 'undefined') {
      window.location.href = url;
    }
  } catch (_) {
    window.location.href = url;
  }
}

// -------------------- CSV MEMORY (IndexedDB) --------------------
const CSV_DB_NAME = 'xpress_db_v1';
const CSV_STORE = 'kv';
const CSV_KEY = 'last_csv_payload';
const CSV_REMEMBER_KEY = 'xpress_remember_csv_v1';

// Connessione riusata (evita di aprire una connessione IndexedDB per ogni operazione)
let csvDbPromise = null;

function openCsvDB() {
  if (csvDbPromise) return csvDbPromise;

  csvDbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window) || !window.indexedDB) {
      reject(new Error('IndexedDB non disponibile'));
      return;
    }
    const req = indexedDB.open(CSV_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CSV_STORE)) db.createObjectStore(CSV_STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      // se il DB viene chiuso/aggiornato altrove, la prossima apertura riparte pulita
      db.onclose = () => { csvDbPromise = null; };
      db.onversionchange = () => { try { db.close(); } catch (_) {} csvDbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB bloccato'));
  });

  // in caso di errore (es. modalità privata) permetti un nuovo tentativo
  csvDbPromise.catch(() => { csvDbPromise = null; });

  return csvDbPromise;
}

async function idbSet(key, value) {
  const db = await openCsvDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CSV_STORE, 'readwrite');
    tx.objectStore(CSV_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openCsvDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CSV_STORE, 'readonly');
    const req = tx.objectStore(CSV_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDel(key) {
  const db = await openCsvDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CSV_STORE, 'readwrite');
    tx.objectStore(CSV_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function csvFingerprintFromFile(file) {
  if (!file) return null;
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function formatDateTime(ts) {
  try { return new Date(ts).toLocaleString('it-IT'); } catch (_) { return ''; }
}

function updateSavedCsvInfoUI(payload) {
  const info = document.getElementById('savedCsvInfo');
  if (!info) return;

  if (!payload || !payload.listino?.length) {
    info.textContent = 'Nessun CSV salvato.';
    return;
  }

  const name = payload.meta?.name ? `“${payload.meta.name}”` : 'CSV';
  const when = payload.savedAt ? formatDateTime(payload.savedAt) : '';
  const rows = payload.listino?.length || 0;

  info.textContent = `Salvato: ${name} • Righe: ${rows}${when ? ' • ' + when : ''}`;
}

async function saveLastCsvPayload({ listinoRows, meta }) {
  const remember = document.getElementById('toggleRememberCSV');
  if (remember && !remember.checked) return;

  const payload = { savedAt: Date.now(), meta: meta || {}, listino: listinoRows || [] };

  try {
    await idbSet(CSV_KEY, payload);
    updateSavedCsvInfoUI(payload);
  } catch (e) {
    console.warn('Impossibile salvare CSV in IndexedDB:', e);
  }
}

async function loadLastCsvPayload() {
  try { return await idbGet(CSV_KEY); }
  catch (e) { console.warn('Impossibile leggere CSV da IndexedDB:', e); return null; }
}

async function clearLastCsvPayload() {
  try { await idbDel(CSV_KEY); }
  catch (e) { console.warn('Impossibile cancellare CSV da IndexedDB:', e); }
  updateSavedCsvInfoUI(null);
}

async function tryAutoLoadSavedCsvOnStart() {
  const payload = await loadLastCsvPayload();
  updateSavedCsvInfoUI(payload);

  if (payload && Array.isArray(payload.listino) && payload.listino.length) {
    listino = payload.listino;
    const err = document.getElementById("csvError");
    if (err) err.style.display = "none";
    aggiornaListinoSelect();
  }
}

function bindCsvMemoryUI() {
  const btnLoad = document.getElementById('btnLoadSavedCSV');
  const btnClear = document.getElementById('btnClearSavedCSV');
  const chkRemember = document.getElementById('toggleRememberCSV');

  // La preferenza "ricorda listino" ora sopravvive alla chiusura dell'app
  if (chkRemember) {
    try {
      const saved = localStorage.getItem(CSV_REMEMBER_KEY);
      if (saved !== null) chkRemember.checked = (saved === '1');
    } catch (_) {}

    chkRemember.addEventListener('change', async () => {
      try { localStorage.setItem(CSV_REMEMBER_KEY, chkRemember.checked ? '1' : '0'); } catch (_) {}

      if (!chkRemember.checked) {
        // privacy: se l'utente disattiva la memoria, il listino salvato viene rimosso subito
        await clearLastCsvPayload();
      } else if (listino.length) {
        await saveLastCsvPayload({ listinoRows: listino, meta: { name: 'listino in uso' } });
      }
    });
  }

  if (btnLoad) {
    btnLoad.addEventListener('click', async () => {
      const payload = await loadLastCsvPayload();
      if (!payload || !payload.listino?.length) {
        alert('Nessun CSV salvato trovato.');
        return;
      }
      listino = payload.listino;
      const err = document.getElementById("csvError");
      if (err) err.style.display = "none";
      aggiornaListinoSelect();
      updateSavedCsvInfoUI(payload);
    });
  }

  if (btnClear) {
    btnClear.addEventListener('click', async () => {
      await clearLastCsvPayload();
      alert('CSV salvato cancellato.');
    });
  }

  loadLastCsvPayload().then(updateSavedCsvInfoUI).catch(() => {});
}

// ALIAS COLONNE — case-insensitive, accetta italiano/inglese/varianti
const LISTINO_ALIASES = {
  codice:             ["codice", "code", "codiceart", "codarticolo", "id"],
  descrizione:        ["descrizione", "description", "desc", "articolo"],
  prezzoLordo:        ["prezzolordo", "prezzo", "prezzo_eur", "price", "importo", "listino", "prezzo lordo"],
  costoTrasporto:     ["costotrasporto", "trasporto", "shipping", "spedizione"],
  costoInstallazione: ["costoinstallazione", "installazione", "installation", "montaggio"],
  famiglia:           ["famiglia", "family", "linea"],
  categoria:          ["categoria", "category", "tipo"],
  pagine:             ["pagine", "pages", "pagina", "page", "catalogo"]
};

// Storage warning ultima normalizzazione (per debug console)
let lastNormalizeWarnings = [];

function pickByAlias(row, aliases) {
  // normalizza chiavi del row: trim + lowercase
  const normRow = {};
  for (const k in row) {
    if (Object.prototype.hasOwnProperty.call(row, k)) {
      normRow[String(k).trim().toLowerCase()] = row[k];
    }
  }
  for (const alias of aliases) {
    const v = normRow[alias];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

function normalizeListino(rows) {
  lastNormalizeWarnings = [];
  const out = [];
  rows.forEach((row, idx) => {
    const codiceRaw = pickByAlias(row, LISTINO_ALIASES.codice);
    const prezzoRaw = pickByAlias(row, LISTINO_ALIASES.prezzoLordo);

    // Validazione: codice e prezzo obbligatori
    if (codiceRaw === undefined || prezzoRaw === undefined) {
      lastNormalizeWarnings.push({
        row: idx + 1,
        reason: codiceRaw === undefined ? "manca codice" : "manca prezzo"
      });
      return;
    }

    const codice = String(codiceRaw).trim();
    if (!codice) {
      lastNormalizeWarnings.push({ row: idx + 1, reason: "codice vuoto" });
      return;
    }

    const prezzoLordo = parseDec(String(prezzoRaw));
    if (!isFinite(prezzoLordo) || prezzoLordo <= 0) {
      lastNormalizeWarnings.push({ row: idx + 1, reason: "prezzo non valido" });
      return;
    }

    const descrizioneRaw = pickByAlias(row, LISTINO_ALIASES.descrizione);
    const descrizione = descrizioneRaw !== undefined
      ? String(descrizioneRaw).trim()
      : "(senza descrizione)";

    const costoTrasportoRaw = pickByAlias(row, LISTINO_ALIASES.costoTrasporto);
    const costoInstallazioneRaw = pickByAlias(row, LISTINO_ALIASES.costoInstallazione);
    const famigliaRaw = pickByAlias(row, LISTINO_ALIASES.famiglia);
    const categoriaRaw = pickByAlias(row, LISTINO_ALIASES.categoria);
    const pagineRaw = pickByAlias(row, LISTINO_ALIASES.pagine);

    out.push({
      codice,
      descrizione,
      prezzoLordo,
      sconto: 0,
      sconto2: 0,
      margine: 0,
      scontoCliente: 0,
      costoTrasporto: costoTrasportoRaw !== undefined ? parseDec(String(costoTrasportoRaw)) : 0,
      costoInstallazione: costoInstallazioneRaw !== undefined ? parseDec(String(costoInstallazioneRaw)) : 0,
      // Campi nuovi (persistiti per future versioni, non usati in UI ora)
      famiglia: famigliaRaw !== undefined ? String(famigliaRaw).trim() : "",
      categoria: categoriaRaw !== undefined ? String(categoriaRaw).trim() : "",
      pagine: pagineRaw !== undefined ? String(pagineRaw).trim() : "",
      quantita: 1,
      venduto: 0
    });
  });

  if (lastNormalizeWarnings.length) {
    console.warn(`[normalizeListino] ${lastNormalizeWarnings.length} righe ignorate:`, lastNormalizeWarnings);
  }

  return out;
}

// --- SMART SETTINGS
const SMART_KEY = 'xpress_settings_v1';
let smartSettings = {
  smartMode: false,
  showVAT: false,
  vatRate: 22,
  hideVenduto: true,
  hideDiff: true,
  hideDiscounts: true,
  showClientDiscount: false // flag "Sconto Cliente"
};

function loadSmartSettings() {
  try {
    const raw = localStorage.getItem(SMART_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    smartSettings = { ...smartSettings, ...obj };
  } catch (_) {}
}

function saveSmartSettings() {
  try { localStorage.setItem(SMART_KEY, JSON.stringify(smartSettings)); } catch (_) {}
}

// -------------------- SCONTO CLIENTE (MODE SWITCH) --------------------
function computeClientDiscountFromCurrent(articolo) {
  const prezzoLordo = parseDec(articolo.prezzoLordo || 0);
  if (prezzoLordo <= 0) return 0;

  // prezzo "venduto al cliente" (senza servizi) = conMargineUnit
  // uso __ignoreClientDiscount per leggere il valore reale anche se il flag è attivo
  const r = computeRow({ ...articolo, __ignoreClientDiscount: true });
  const target = parseDec(r.conMargineUnit || 0);

  const eq = (1 - (target / prezzoLordo)) * 100;
  return clamp(eq, 0, 100);
}

function applyClientDiscountMode(enabled) {
  articoliAggiunti = articoliAggiunti.map(a => {
    const item = { ...a };

    if (enabled) {
      // backup dei valori originali (una sola volta)
      if (item._bakSconto === undefined) item._bakSconto = parseDec(item.sconto || 0);
      if (item._bakSconto2 === undefined) item._bakSconto2 = parseDec(item.sconto2 || 0);
      if (item._bakMargine === undefined) item._bakMargine = parseDec(item.margine || 0);

      // calcola sconto cliente equivalente per mantenere invariato il prezzo finale
      item.scontoCliente = computeClientDiscountFromCurrent(item);

      // azzera i campi "interni" (restano in backup)
      item.sconto = 0;
      item.sconto2 = 0;
      item.margine = 0;

    } else {
      // ripristina i valori originali
      if (item._bakSconto !== undefined) item.sconto = item._bakSconto;
      if (item._bakSconto2 !== undefined) item.sconto2 = item._bakSconto2;
      if (item._bakMargine !== undefined) item.margine = item._bakMargine;
      // lascio item.scontoCliente come memoria
    }

    return item;
  });

  renderTabellaArticoli();
  aggiornaTotaliGenerali();
  updateEquivalentDiscountDisplay();
}

// -------------------- SCONTO EQUIVALENTE CLIENTE (UI) --------------------
function updateEquivalentDiscountDisplay() {
  const el = document.getElementById('smartEquivalentDiscount');
  if (!el) return;

  let base = 0;
  let final = 0;

  articoliAggiunti.forEach(a => {
    const qta = a.quantita || 1;
    const prezzoLordo = a.prezzoLordo || 0;
    const r = computeRow(a);
    base += (prezzoLordo * qta);
    final += (r.conMargineUnit * qta);
  });

  base = roundTwo(base);
  final = roundTwo(final);

  if (!base || base <= 0) {
    el.textContent = '—';
    return;
  }

  let eq = (1 - (final / base)) * 100;
  eq = clamp(eq, -9999, 9999);

  el.textContent = `${eq.toFixed(2)}%`;
}

// -------------------- INIT --------------------
document.addEventListener("DOMContentLoaded", function () {
  loadSmartSettings();

  // Micro-fix layout tabella (stabilizza allineamento colonne anche senza toccare style.css)
  const table = document.getElementById('articoli-table');
  if (table) {
    table.style.width = '100%';
    table.style.tableLayout = 'fixed';
    table.style.borderCollapse = 'collapse';
  }

  bindCsvMemoryUI();
  tryAutoLoadSavedCsvOnStart();

  const fileInput = document.getElementById("csvFileInput");
  if (fileInput) fileInput.addEventListener("change", handleCSVUpload);

  const searchInput = document.getElementById("searchListino");
  if (searchInput) searchInput.addEventListener("input", aggiornaListinoSelect);

  // Checkboxes (già presenti)
  const checkbox1 = document.createElement("label");
  checkbox1.innerHTML = `
    <input type="checkbox" id="toggleCosti" onchange="togglePopolaCosti()"> Popola automaticamente Trasporto e Installazione
  `;
  document.getElementById("upload-section").appendChild(checkbox1);

  const checkbox2 = document.createElement("label");
  checkbox2.innerHTML = `
    <br><input type="checkbox" id="toggleMostraServizi" checked disabled> Mostra dettagli Trasporto/Installazione nel report
  `;
  document.getElementById("upload-section").appendChild(checkbox2);

  // Bottone manuale
  const manualButton = document.createElement("button");
  manualButton.textContent = "Aggiungi Articolo Manualmente";
  manualButton.onclick = mostraFormArticoloManuale;
  document.getElementById("listino-section").appendChild(manualButton);

  bindSmartControls();

  // Se l'utente aveva già attivo il flag, applicalo alla tabella caricata
  if (smartSettings.showClientDiscount) applyClientDiscountMode(true);

  // Prima render
  renderTabellaArticoli();          // crea righe e input una sola volta
  aggiornaTotaliGenerali();
  applyColumnVisibility();
  updateEquivalentDiscountDisplay();
});

// -------------------- SMART CONTROLS --------------------
function bindSmartControls() {
  const elSmart = document.getElementById('toggleSmartMode');
  const elVat = document.getElementById('toggleShowVAT');
  const elVatRate = document.getElementById('vatRate');
  const elHideVenduto = document.getElementById('toggleHideVenduto');
  const elHideDiff = document.getElementById('toggleHideDiff');
  const elHideDiscounts = document.getElementById('toggleHideDiscounts');
  const elShowClientDiscount = document.getElementById('toggleShowClientDiscount');

  if (elSmart) elSmart.checked = !!smartSettings.smartMode;
  if (elVat) elVat.checked = !!smartSettings.showVAT;
  if (elVatRate) elVatRate.value = smartSettings.vatRate ?? 22;
  if (elHideVenduto) elHideVenduto.checked = !!smartSettings.hideVenduto;
  if (elHideDiff) elHideDiff.checked = !!smartSettings.hideDiff;
  if (elHideDiscounts) elHideDiscounts.checked = !!smartSettings.hideDiscounts;
  if (elShowClientDiscount) elShowClientDiscount.checked = !!smartSettings.showClientDiscount;

  const onChange = () => {
    const prevClient = !!smartSettings.showClientDiscount;

    smartSettings.smartMode = !!elSmart?.checked;
    smartSettings.showVAT = !!elVat?.checked;

    const rate = parseDec(elVatRate?.value || '22');
    smartSettings.vatRate = clamp(rate, 0, 100);

    smartSettings.hideVenduto = !!elHideVenduto?.checked;
    smartSettings.hideDiff = !!elHideDiff?.checked;
    smartSettings.hideDiscounts = !!elHideDiscounts?.checked;
    smartSettings.showClientDiscount = !!elShowClientDiscount?.checked;

    // Se smart attivo: forza alcune scelte (e allinea le checkbox a video)
    if (smartSettings.smartMode) {
      smartSettings.hideVenduto = true;
      smartSettings.hideDiff = true;
      smartSettings.hideDiscounts = true;
      if (elHideVenduto) elHideVenduto.checked = true;
      if (elHideDiff) elHideDiff.checked = true;
      if (elHideDiscounts) elHideDiscounts.checked = true;
    }

    saveSmartSettings();

    // Se cambia la modalità sconto cliente -> switch completo (mantiene invariato prezzo finale)
    if (prevClient !== !!smartSettings.showClientDiscount) {
      applyClientDiscountMode(!!smartSettings.showClientDiscount);
      return; // applyClientDiscountMode già fa render + totali
    }

    applyColumnVisibility();
    aggiornaCalcoliRighe();   // aggiorna SOLO celle numeriche, senza ricreare input
    aggiornaTotaliGenerali();
    updateEquivalentDiscountDisplay();
  };

  [elSmart, elVat, elVatRate, elHideVenduto, elHideDiff, elHideDiscounts, elShowClientDiscount]
    .filter(Boolean)
    .forEach(el => el.addEventListener('change', onChange));
}

function applyColumnVisibility() {
  const hideVenduto = smartSettings.smartMode ? true : smartSettings.hideVenduto;
  const hideDiff = smartSettings.smartMode ? true : smartSettings.hideDiff;

  setColHidden('venduto', hideVenduto);
  setColHidden('diff', hideDiff);

  const clientMode = !!smartSettings.showClientDiscount;

  // modalità sconto cliente: sostituisce input in tabella
  setColHidden('sconto1', clientMode);
  setColHidden('sconto2', clientMode);
  setColHidden('margine', smartSettings.smartMode || clientMode);
  setColHidden('scontoCliente', !clientMode);

  // smart: nascondo prezzo lordo (interno)
  setColHidden('prezzoLordo', smartSettings.smartMode);
}

function setColHidden(colKey, hidden) {
  document.querySelectorAll(`th[data-col="${colKey}"]`).forEach(th => th.classList.toggle('col-hidden', !!hidden));
  document.querySelectorAll(`td[data-col="${colKey}"]`).forEach(td => td.classList.toggle('col-hidden', !!hidden));
}

// -------------------- POPOLA COSTI --------------------
function togglePopolaCosti() {
  autoPopolaCosti = document.getElementById("toggleCosti").checked;
  const secondCheckbox = document.getElementById("toggleMostraServizi");
  secondCheckbox.disabled = !autoPopolaCosti;
  mostraDettagliServizi = secondCheckbox.checked;

  articoliAggiunti = articoliAggiunti.map(articolo => {
    const listinoOriginale = listino.find(item => item.codice === articolo.codice);
    return {
      ...articolo,
      costoTrasporto: autoPopolaCosti && listinoOriginale ? listinoOriginale.costoTrasporto : 0,
      costoInstallazione: autoPopolaCosti && listinoOriginale ? listinoOriginale.costoInstallazione : 0
    };
  });

  renderTabellaArticoli();
  aggiornaTotaliGenerali();
  updateEquivalentDiscountDisplay();
}

// -------------------- CSV UPLOAD --------------------
function handleCSVUpload(event) {
  const input = event.target;
  const file = input.files && input.files[0];

  // reset immediato: permette di riselezionare lo STESSO file una seconda volta
  // (su Android senza questo reset il secondo tentativo non genera l'evento change)
  const resetInput = () => { try { input.value = ''; } catch (_) {} };

  if (!file) { resetInput(); return; }

  hideCsvError();

  const fileName = (file.name || "").toLowerCase();

  if (/\.(xlsx|xlsm|xls)$/.test(fileName)) {
    parseExcelFile(file);
    resetInput();
    return;
  }

  if (/\.(csv|txt|tsv)$/.test(fileName)) {
    parseCsvFile(file);
    resetInput();
    return;
  }

  // Nome senza estensione riconoscibile: succede con alcuni picker Android
  // (Google Drive, Documenti, allegati). Si riconosce il formato dai primi byte.
  sniffAndParse(file);
  resetInput();
}

// Riconoscimento formato dai magic bytes:
//  - "PK"   (50 4B)             -> xlsx / xlsm (contenitore ZIP)
//  - OLE2   (D0 CF 11 E0)       -> xls (Excel 97-2003)
//  - altro                      -> trattato come testo/CSV
function sniffAndParse(file) {
  let reader;
  try { reader = new FileReader(); } catch (_) { parseCsvFile(file); return; }

  reader.onload = (e) => {
    try {
      const b = new Uint8Array(e.target.result || new ArrayBuffer(0));
      const isZip = b[0] === 0x50 && b[1] === 0x4B;
      const isOle = b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0;
      if (isZip || isOle) parseExcelFile(file);
      else parseCsvFile(file);
    } catch (_) {
      parseCsvFile(file);
    }
  };
  reader.onerror = () => parseCsvFile(file);

  try { reader.readAsArrayBuffer(file.slice(0, 8)); }
  catch (_) { parseCsvFile(file); }
}

function parseCsvFile(file) {
  if (typeof Papa === 'undefined') {
    console.error("PapaParse non caricato");
    showCsvError("Libreria CSV non disponibile. Ricarica la pagina.");
    return;
  }

  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: function(results) {
      if (!results.data.length) {
        showCsvError("Il file non contiene righe leggibili.");
        return;
      }
      finalizeListino(results.data, file);
    },
    error: function(err) {
      console.error("Errore CSV:", err);
      showCsvError();
    }
  });
}

function parseExcelFile(file) {
  if (typeof XLSX === 'undefined') {
    console.error("SheetJS non caricato");
    showCsvError("Libreria Excel non disponibile. Ricarica la pagina.");
    return;
  }

  const reader = new FileReader();

  reader.onload = function(e) {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const rows = XLSX.utils.sheet_to_json(worksheet, { defval: "", blankrows: false });

      if (!rows.length) {
        showCsvError("Il file Excel non contiene righe valide.");
        return;
      }

      finalizeListino(rows, file);
    } catch (err) {
      console.error("Errore parsing Excel:", err);
      showCsvError("Errore nel caricamento del file Excel.");
    }
  };

  reader.onerror = function() {
    console.error("Errore lettura file Excel");
    showCsvError("Impossibile leggere il file.");
  };

  reader.readAsArrayBuffer(file);
}

function finalizeListino(rawRows, file) {
  listino = normalizeListino(rawRows);

  const loaded = listino.length;
  const ignored = rawRows.length - loaded;

  if (!loaded) {
    updateCsvLoadStatus(0, ignored);
    showCsvError("Nessun articolo valido: servono almeno le colonne “Codice” e “Prezzo”.");
    aggiornaListinoSelect();
    return;
  }

  saveLastCsvPayload({
    listinoRows: listino,
    meta: { name: file.name, size: file.size, lastModified: file.lastModified, fp: csvFingerprintFromFile(file) }
  });

  hideCsvError();
  updateCsvLoadStatus(loaded, ignored);
  aggiornaListinoSelect();
}

const CSV_ERROR_DEFAULT = "Errore nel caricamento del file. Formati supportati: CSV, XLSX, XLSM, XLS.";

function showCsvError(message) {
  const el = document.getElementById("csvError");
  if (!el) return;
  el.textContent = message || CSV_ERROR_DEFAULT;
  el.style.display = "block";
}

function hideCsvError() {
  const el = document.getElementById("csvError");
  if (el) el.style.display = "none";
}

function updateCsvLoadStatus(loaded, ignored) {
  const el = document.getElementById("csvLoadStatus");
  if (!el) return;
  const artW = loaded === 1 ? "articolo" : "articoli";
  if (ignored > 0) {
    const rigW = ignored === 1 ? "riga ignorata" : "righe ignorate";
    el.textContent = `Caricati ${loaded} ${artW} su ${loaded + ignored} (${ignored} ${rigW})`;
    el.style.color = "#e65100";
  } else {
    el.textContent = `Caricati ${loaded} ${artW}`;
    el.style.color = "#555";
  }
  el.style.display = "block";
}

function aggiornaListinoSelect() {
  const select = document.getElementById("listinoSelect");
  const search = document.getElementById("searchListino");
  if (!select) return;

  const searchTerm = (search ? search.value : "").trim().toLowerCase();

  // fragment: un solo reflow anche con listini da migliaia di righe (mobile)
  const frag = document.createDocumentFragment();
  let trovati = 0;

  listino.forEach((item) => {
    if (!searchTerm
      || item.codice.toLowerCase().includes(searchTerm)
      || item.descrizione.toLowerCase().includes(searchTerm)) {
      const option = document.createElement("option");
      option.value = item.codice;
      option.textContent = `${item.codice} - ${item.descrizione} - €${roundTwo(item.prezzoLordo).toFixed(2)}`;
      frag.appendChild(option);
      trovati++;
    }
  });

  select.innerHTML = "";

  if (!trovati) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = listino.length ? "Nessun articolo trovato" : "Nessun listino caricato";
    option.disabled = true;
    select.appendChild(option);
    return;
  }

  select.appendChild(frag);
}

function aggiungiArticoloDaListino() {

  const select = document.getElementById("listinoSelect");
  if (!select.value) return;

  const articolo = listino.find(item => item.codice === select.value);
  if (!articolo) {
    alert("Errore: articolo non trovato nel listino.");
    return;
  }

  const nuovoArticolo = { ...articolo };
  if (!autoPopolaCosti) {
    nuovoArticolo.costoTrasporto = 0;
    nuovoArticolo.costoInstallazione = 0;
  }

  // se modalità sconto cliente è attiva, inizializza con sconto cliente equivalente
  if (smartSettings.showClientDiscount) {
    nuovoArticolo.scontoCliente = computeClientDiscountFromCurrent(nuovoArticolo);
  }

  articoliAggiunti.push(nuovoArticolo);
  renderTabellaArticoli();
  aggiornaTotaliGenerali();
  updateEquivalentDiscountDisplay();
}

// -------------------- CALCOLI RIGA --------------------
function computeRow(articolo) {
  const prezzoLordo = parseDec(articolo.prezzoLordo || 0);
  const qta = Math.max(1, parseInt(articolo.quantita || 1, 10) || 1);

  // modalità "Sconto Cliente" attiva (salvo override interno)
  const useClientDiscount = !!smartSettings.showClientDiscount && !articolo.__ignoreClientDiscount;

  let sconto1 = 0;
  let sconto2 = 0;
  let margine = 0;

  let totaleNettoUnit = 0;   // valore mostrato come "Prezzo netto" (tabella/report)
  let conMargineUnit = 0;    // prezzo venduto al cliente (senza servizi)

  if (useClientDiscount) {
    const scontoCliente = clamp(parseDec(articolo.scontoCliente || 0), 0, 100);
    conMargineUnit = roundTwo(prezzoLordo * (1 - scontoCliente / 100));
    totaleNettoUnit = conMargineUnit;

  } else {
    sconto1 = clamp(parseDec(articolo.sconto || 0), 0, 100);
    sconto2 = clamp(parseDec(articolo.sconto2 || 0), 0, 100);

    const prezzoScontato = prezzoLordo * (1 - sconto1 / 100) * (1 - sconto2 / 100);
    totaleNettoUnit = roundTwo(prezzoScontato);

    margine = clamp(parseDec(articolo.margine || 0), 0, 99.99);
    conMargineUnit = roundTwo(totaleNettoUnit / (1 - margine / 100));
  }

  const serviziUnit = roundTwo(parseDec(articolo.costoTrasporto || 0) + parseDec(articolo.costoInstallazione || 0));
  const granTotRiga = roundTwo((conMargineUnit + serviziUnit) * qta);

  const venduto = parseDec(articolo.venduto || 0);
  const differenza = roundTwo(venduto - granTotRiga);

  const nettoCadSmart = roundTwo(granTotRiga / qta);

  return { sconto1, sconto2, totaleNettoUnit, conMargineUnit, qta, serviziUnit, granTotRiga, venduto, differenza, nettoCadSmart };
}

// -------------------- TABELLA: RENDER 1 VOLTA + UPDATE CELLE --------------------
function renderTabellaArticoli() {
  const tableBody = document.querySelector("#articoli-table tbody");
  if (!tableBody) return;
  tableBody.innerHTML = "";

  articoliAggiunti.forEach((articolo, index) => {
    const r = computeRow(articolo);

    const row = document.createElement("tr");
    row.dataset.index = String(index);

    row.innerHTML = `
      <td data-col="codice">${escapeHtml(articolo.codice)}</td>
      <td data-col="descrizione">${escapeHtml(articolo.descrizione)}</td>

      <td data-col="prezzoLordo" class="cell-prezzoLordo">${roundTwo(parseDec(articolo.prezzoLordo)).toFixed(2)}€</td>

      <td data-col="sconto1">
        <input class="cell-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
          value="${fmtDec(r.sconto1, 2, true)}"
          data-index="${index}" data-field="sconto" />
      </td>

      <td data-col="sconto2">
        <input class="cell-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
          value="${fmtDec(r.sconto2, 2, true)}"
          data-index="${index}" data-field="sconto2" />
      </td>

      <td data-col="scontoCliente">
        <input class="cell-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
          value="${fmtDec(parseDec(articolo.scontoCliente || 0), 2, true)}"
          data-index="${index}" data-field="scontoCliente" />
      </td>

      <td data-col="margine">
        <input class="cell-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
          value="${fmtDec(parseDec(articolo.margine || 0), 2, true)}"
          data-index="${index}" data-field="margine" />
      </td>

      <td data-col="totaleNetto" class="cell-totaleNetto">${r.totaleNettoUnit.toFixed(2)}€</td>

      <td data-col="trasporto">
        <input class="cell-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
          value="${fmtDec(parseDec(articolo.costoTrasporto || 0), 2, true)}"
          data-index="${index}" data-field="costoTrasporto" />
      </td>

      <td data-col="installazione">
        <input class="cell-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
          value="${fmtDec(parseDec(articolo.costoInstallazione || 0), 2, true)}"
          data-index="${index}" data-field="costoInstallazione" />
      </td>

      <td data-col="qta">
        <input class="cell-input" type="number" min="1" step="1"
          value="${r.qta}"
          data-index="${index}" data-field="quantita" />
      </td>

      <td data-col="granTot" class="cell-granTot">${r.granTotRiga.toFixed(2)}€</td>

      <td data-col="venduto">
        <input class="cell-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
          value="${fmtDec(r.venduto, 2, true)}"
          data-index="${index}" data-field="venduto" />
      </td>

      <td data-col="diff" class="cell-diff">${r.differenza.toFixed(2)}€</td>

      <td data-col="azioni"><button onclick="rimuoviArticolo(${index})">Rimuovi</button></td>
    `;

    tableBody.appendChild(row);
  });

  // Delegation: una sola volta (ma sicuro) — rimuovo prima per evitare doppioni
  tableBody.removeEventListener('input', onTableInput, true);
  tableBody.addEventListener('input', onTableInput, true);

  // Micro stile input (stabilizza layout)
  tableBody.querySelectorAll('input.cell-input').forEach(inp => {
    // Evita width inline: la larghezza su mobile è gestita da CSS (cards)
    inp.style.boxSizing = 'border-box';
  });

  applyColumnVisibility();

  // Xpress: miniature dal listino PDF accanto al codice (solo visualizzazione)
  if (typeof window !== 'undefined' && window.XpressPDF && typeof window.XpressPDF.onTableRendered === 'function') {
    try { window.XpressPDF.onTableRendered(); } catch (e) { console.warn('[PDF] miniature', e); }
  }
}

function onTableInput(e) {
  const target = e.target;
  if (!(target instanceof HTMLInputElement)) return;

  const idx = parseInt(target.dataset.index || '-1', 10);
  const field = target.dataset.field || '';
  if (idx < 0 || !field) return;

  // Per i campi testuali decimali: permetti virgola e non distruggere il testo mentre digita
  if (field !== 'quantita') {
    const cleaned = sanitizeDecimalTyping(target.value);
    if (cleaned !== target.value) {
      const pos = target.selectionStart ?? cleaned.length;
      target.value = cleaned;
      try { target.setSelectionRange(pos, pos); } catch (_) {}
    }
  }

  // Aggiorna solo il dato in memoria (senza re-render della tabella)
  if (field === 'quantita') {
    let v = parseInt(String(target.value || '1'), 10) || 1;
    if (v < 1) v = 1;
    articoliAggiunti[idx][field] = v;
  } else {
    let v = parseDec(target.value);
    if (field === "sconto" || field === "sconto2" || field === "scontoCliente") v = clamp(v, 0, 100);
    if (field === "margine") v = clamp(v, 0, 99.99);
    if (field === "costoTrasporto" || field === "costoInstallazione" || field === "venduto") v = Math.max(0, v);

    articoliAggiunti[idx][field] = v;

    // se l'utente cambia sconto1/sconto2/margine mentre client mode è OFF,
    // aggiorno "sconto cliente" mostrato sopra come equivalente (non tocco la tabella)
    if (!smartSettings.showClientDiscount && (field === 'sconto' || field === 'sconto2' || field === 'margine')) {
      articoliAggiunti[idx].scontoCliente = computeClientDiscountFromCurrent(articoliAggiunti[idx]);
    }
  }

  // Aggiorna SOLO celle calcolate della riga (mantieni focus e caret)
  aggiornaCalcoliRiga(idx);

  // Totali e sconto equivalente
  aggiornaTotaliGenerali();
  updateEquivalentDiscountDisplay();
}

function aggiornaCalcoliRiga(index) {
  const row = document.querySelector(`#articoli-table tbody tr[data-index="${index}"]`);
  if (!row) return;

  const articolo = articoliAggiunti[index];
  const r = computeRow(articolo);

  const tdTotaleNetto = row.querySelector('.cell-totaleNetto');
  const tdGranTot = row.querySelector('.cell-granTot');
  const tdDiff = row.querySelector('.cell-diff');
  const tdPrezzoLordo = row.querySelector('.cell-prezzoLordo');

  if (tdPrezzoLordo) tdPrezzoLordo.textContent = `${roundTwo(parseDec(articolo.prezzoLordo)).toFixed(2)}€`;
  if (tdTotaleNetto) tdTotaleNetto.textContent = `${r.totaleNettoUnit.toFixed(2)}€`;
  if (tdGranTot) tdGranTot.textContent = `${r.granTotRiga.toFixed(2)}€`;
  if (tdDiff) tdDiff.textContent = `${r.differenza.toFixed(2)}€`;
}

function aggiornaCalcoliRighe() {
  for (let i = 0; i < articoliAggiunti.length; i++) aggiornaCalcoliRiga(i);
}

// -------------------- RIMOZIONE --------------------
function rimuoviArticolo(index) {
  articoliAggiunti.splice(index, 1);
  renderTabellaArticoli();
  aggiornaTotaliGenerali();
  updateEquivalentDiscountDisplay();
}

// -------------------- TOTALI --------------------
function aggiornaTotaliGenerali() {
  let totaleSenzaServizi = 0;
  let totaleConServizi = 0;
  let totaleVenduto = 0;
  let totaleDifferenzaSconto = 0;

  articoliAggiunti.forEach(articolo => {
    const r = computeRow(articolo);
    totaleSenzaServizi += r.conMargineUnit * r.qta;
    totaleConServizi += r.granTotRiga;
    totaleVenduto += r.venduto;
    totaleDifferenzaSconto += r.differenza;
  });

  const imponibile = autoPopolaCosti ? roundTwo(totaleConServizi) : roundTwo(totaleSenzaServizi);
  const vatRate = clamp(parseDec(smartSettings.vatRate ?? 22), 0, 100);
  const iva = roundTwo(imponibile * (vatRate / 100));
  const totaleIvato = roundTwo(imponibile + iva);

  let totaleDiv = document.getElementById("totaleGenerale");
  if (!totaleDiv) {
    totaleDiv = document.createElement("div");
    totaleDiv.id = "totaleGenerale";
    totaleDiv.style.padding = "1em";
    document.getElementById("report-section").insertAdjacentElement("beforebegin", totaleDiv);
  }

  const smart = !!smartSettings.smartMode;

  let html = "";
  if (!smart) {
    html += `<strong>Totale Netto (senza Trasporto/Installazione):</strong> ${totaleSenzaServizi.toFixed(2)}€<br>`;
    html += `<strong>Totale Complessivo (inclusi Trasporto/Installazione):</strong> ${totaleConServizi.toFixed(2)}€<br>`;
    html += `<strong>Totale Venduto:</strong> ${totaleVenduto.toFixed(2)}€<br>`;
    html += `<strong>Totale Differenza Sconto:</strong> ${totaleDifferenzaSconto.toFixed(2)}€`;
  } else {
    html += `<strong>Imponibile:</strong> ${imponibile.toFixed(2)}€<br>`;
    if (smartSettings.showVAT) {
      html += `<strong>IVA (${vatRate.toFixed(1)}%):</strong> ${iva.toFixed(2)}€<br>`;
      html += `<strong>Totale + IVA:</strong> ${totaleIvato.toFixed(2)}€`;
    } else {
      html += `<strong>Totale:</strong> ${imponibile.toFixed(2)}€`;
    }
  }

  if (!smart && smartSettings.showVAT) {
    html += `<br><br><strong>Imponibile:</strong> ${imponibile.toFixed(2)}€<br>`;
    html += `<strong>IVA (${vatRate.toFixed(1)}%):</strong> ${iva.toFixed(2)}€<br>`;
    html += `<strong>Totale + IVA:</strong> ${totaleIvato.toFixed(2)}€`;
  }

  totaleDiv.innerHTML = html;
}

// -------------------- MANUALE --------------------
function mostraFormArticoloManuale() {
  const tableBody = document.querySelector("#articoli-table tbody");
  if (!tableBody) return;
  if (document.getElementById("manual-input-row")) return;

  const row = document.createElement("tr");
  row.id = "manual-input-row";

  row.innerHTML = `
    <td data-col="codice"><input type="text" id="manualCodice" placeholder="Codice" /></td>
    <td data-col="descrizione"><input type="text" id="manualDescrizione" placeholder="Descrizione" /></td>

    <td data-col="prezzoLordo"><input type="text" inputmode="decimal" id="manualPrezzo" placeholder="€" value="0" /></td>

    <td data-col="sconto1"><input type="text" inputmode="decimal" id="manualSconto1" placeholder="%" value="0" /></td>
    <td data-col="sconto2"><input type="text" inputmode="decimal" id="manualSconto2" placeholder="%" value="0" /></td>

    <td data-col="scontoCliente"><input type="text" inputmode="decimal" id="manualScontoCliente" placeholder="%" value="0" /></td>

    <td data-col="margine"><input type="text" inputmode="decimal" id="manualMargine" placeholder="%" value="0" /></td>

    <td data-col="totaleNetto"><span id="manualTotale">—</span></td>

    <td data-col="trasporto"><input type="text" inputmode="decimal" id="manualTrasporto" placeholder="€" value="0" /></td>
    <td data-col="installazione"><input type="text" inputmode="decimal" id="manualInstallazione" placeholder="€" value="0" /></td>

    <td data-col="qta"><input type="number" id="manualQuantita" placeholder="1" value="1" min="1" step="1" /></td>

    <td data-col="granTot"><span id="manualGranTotale">—</span></td>

    <td data-col="venduto"><input type="text" inputmode="decimal" id="manualVenduto" placeholder="€" value="0" /></td>
    <td data-col="diff"><span id="manualDifferenza">—</span></td>

    <td data-col="azioni">
      <button onclick="aggiungiArticoloManuale()">✅</button>
      <button onclick="annullaArticoloManuale()">❌</button>
    </td>
  `;

  tableBody.appendChild(row);

  [
    "manualPrezzo", "manualSconto1", "manualSconto2", "manualScontoCliente", "manualMargine",
    "manualTrasporto", "manualInstallazione", "manualQuantita", "manualVenduto"
  ].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", () => {
      if (el.type === 'text') el.value = sanitizeDecimalTyping(el.value);
      calcolaRigaManuale();
    });
  });

  applyColumnVisibility();
  calcolaRigaManuale();
}

function calcolaRigaManuale() {
  const prezzoLordo = parseDec(document.getElementById("manualPrezzo").value);

  const sconto1 = clamp(parseDec(document.getElementById("manualSconto1").value), 0, 100);
  const sconto2 = clamp(parseDec(document.getElementById("manualSconto2").value), 0, 100);
  const scontoCliente = clamp(parseDec(document.getElementById("manualScontoCliente").value), 0, 100);

  const margine = clamp(parseDec(document.getElementById("manualMargine").value), 0, 99.99);

  const trasporto = Math.max(0, parseDec(document.getElementById("manualTrasporto").value));
  const installazione = Math.max(0, parseDec(document.getElementById("manualInstallazione").value));
  const quantita = Math.max(1, parseInt(document.getElementById("manualQuantita").value || '1', 10) || 1);
  const venduto = Math.max(0, parseDec(document.getElementById("manualVenduto").value));

  let conMargine = 0;
  let nettoMostrato = 0;

  if (smartSettings.showClientDiscount) {
    conMargine = roundTwo(prezzoLordo * (1 - scontoCliente / 100));
    nettoMostrato = conMargine;
  } else {
    const scontato = roundTwo(prezzoLordo * (1 - sconto1 / 100) * (1 - sconto2 / 100));
    conMargine = roundTwo(scontato / (1 - margine / 100));
    nettoMostrato = scontato;
  }

  const granTot = roundTwo((conMargine + trasporto + installazione) * quantita);
  const differenza = roundTwo(venduto - granTot);

  document.getElementById("manualTotale").textContent = nettoMostrato.toFixed(2) + "€";
  document.getElementById("manualGranTotale").textContent = granTot.toFixed(2) + "€";
  document.getElementById("manualDifferenza").textContent = differenza.toFixed(2) + "€";
}

function aggiungiArticoloManuale() {

  const codice = document.getElementById("manualCodice").value.trim();
  const descrizione = document.getElementById("manualDescrizione").value.trim();

  const prezzoLordo = parseDec(document.getElementById("manualPrezzo").value);
  const sconto = clamp(parseDec(document.getElementById("manualSconto1").value), 0, 100);
  const sconto2 = clamp(parseDec(document.getElementById("manualSconto2").value), 0, 100);
  const scontoCliente = clamp(parseDec(document.getElementById("manualScontoCliente").value), 0, 100);
  const margine = clamp(parseDec(document.getElementById("manualMargine").value), 0, 99.99);

  const costoTrasporto = Math.max(0, parseDec(document.getElementById("manualTrasporto").value));
  const costoInstallazione = Math.max(0, parseDec(document.getElementById("manualInstallazione").value));
  const quantita = Math.max(1, parseInt(document.getElementById("manualQuantita").value || '1', 10) || 1);
  const venduto = Math.max(0, parseDec(document.getElementById("manualVenduto").value));

  const nuovoArticolo = {
    codice,
    descrizione,
    prezzoLordo,
    sconto,
    sconto2,
    margine,
    scontoCliente,
    costoTrasporto,
    costoInstallazione,
    quantita,
    venduto
  };

  // se la modalità è attiva, allinea scontoCliente equivalente
  if (smartSettings.showClientDiscount) {
    nuovoArticolo.scontoCliente = computeClientDiscountFromCurrent(nuovoArticolo);
    nuovoArticolo.sconto = 0;
    nuovoArticolo.sconto2 = 0;
    nuovoArticolo.margine = 0;
  }

  articoliAggiunti.push(nuovoArticolo);

  annullaArticoloManuale();
  renderTabellaArticoli();
  aggiornaTotaliGenerali();
  updateEquivalentDiscountDisplay();
}

function annullaArticoloManuale() {
  const row = document.getElementById("manual-input-row");
  if (row) row.remove();
}

// -------------------- REPORTS --------------------
function generaReportSmartCliente() {
  let report = "PREVENTIVO / ORDINE\n\n";
  let imponibile = 0;

  const checkboxServizi = document.getElementById("toggleMostraServizi");
  const mostraServizi = checkboxServizi && checkboxServizi.checked && autoPopolaCosti;

  articoliAggiunti.forEach((articolo, index) => {
    const r = computeRow(articolo);

    const nettoCad = r.nettoCadSmart;
    const qta = r.qta;
    const totRiga = r.granTotRiga;

    imponibile += totRiga;

    report += `${index + 1}) ${articolo.descrizione}\n`;
    report += `Codice: ${articolo.codice}\n`;
    report += `Q.tà: ${qta}\n`;
    report += `Netto/cad: ${nettoCad.toFixed(2)}€\n`;

    if (mostraServizi) {
      const tr = roundTwo(parseDec(articolo.costoTrasporto || 0));
      const ins = roundTwo(parseDec(articolo.costoInstallazione || 0));
      if (tr !== 0 || ins !== 0) {
        report += `Servizi:\n`;
        report += `Trasporto ${tr.toFixed(2)}€\n`;
        report += `Installazione ${ins.toFixed(2)}€\n`;
      }
    }

    report += `Totale riga: ${totRiga.toFixed(2)}€\n\n`;
  });

  imponibile = roundTwo(imponibile);

  const vatRate = clamp(parseDec(smartSettings.vatRate ?? 22), 0, 100);
  const iva = roundTwo(imponibile * (vatRate / 100));
  const totaleIvato = roundTwo(imponibile + iva);

  report += `RIEPILOGO\n`;
  report += `Imponibile: ${imponibile.toFixed(2)}€\n`;

  if (smartSettings.showVAT) {
    report += `IVA (${vatRate.toFixed(1)}%): ${iva.toFixed(2)}€\n`;
    report += `Totale + IVA: ${totaleIvato.toFixed(2)}€\n`;
  } else {
    report += `Totale: ${imponibile.toFixed(2)}€\n`;
  }

  return report;
}

function generaReportTesto() {
  if (smartSettings.smartMode) return generaReportSmartCliente();

  let report = "Report Articoli:\n\n";
  let totaleSenzaServizi = 0;
  let totaleConServizi = 0;
  let sommaDifferenze = 0;
  let totaleVenduto = 0;

  const checkboxServizi = document.getElementById("toggleMostraServizi");
  mostraDettagliServizi = checkboxServizi && checkboxServizi.checked;

  const clientMode = !!smartSettings.showClientDiscount;

  articoliAggiunti.forEach((articolo, index) => {
    const r = computeRow(articolo);

    sommaDifferenze += r.differenza;
    totaleVenduto += r.venduto;
    totaleSenzaServizi += r.conMargineUnit * r.qta;
    totaleConServizi += r.granTotRiga;

    report += `${index + 1}. Codice: ${articolo.codice}\n`;
    report += `Descrizione: ${articolo.descrizione}\n`;
    report += `Prezzo netto: ${r.totaleNettoUnit.toFixed(2)}€\n`;

    if (!smartSettings.hideDiscounts) {
      if (clientMode) {
        report += `Sconto cliente: ${clamp(parseDec(articolo.scontoCliente || 0), 0, 100).toFixed(2)}%\n`;
      } else {
        report += `Sconto 1: ${r.sconto1}%\n`;
        report += `Sconto 2: ${r.sconto2}%\n`;
      }
    }

    report += `Quantità: ${r.qta}\n`;

    if (mostraDettagliServizi && autoPopolaCosti) {
      report += `Trasporto: ${roundTwo(parseDec(articolo.costoTrasporto || 0)).toFixed(2)}€\n`;
      report += `Installazione: ${roundTwo(parseDec(articolo.costoInstallazione || 0)).toFixed(2)}€\n`;
    }

    report += `Totale: ${r.granTotRiga.toFixed(2)}€\n`;

    if (!smartSettings.hideVenduto) report += `Venduto A: ${(r.venduto || 0).toFixed(2)}€\n`;
    if (!smartSettings.hideDiff) report += `Differenza sconto: ${r.differenza.toFixed(2)}€\n`;

    report += `\n`;
  });

  report += `Totale Netto (senza Trasporto/Installazione): ${totaleSenzaServizi.toFixed(2)}€\n`;
  if (autoPopolaCosti) report += `Totale Complessivo (inclusi Trasporto/Installazione): ${totaleConServizi.toFixed(2)}€\n`;

  if (!smartSettings.hideVenduto) report += `Totale Venduto: ${totaleVenduto.toFixed(2)}€\n`;
  if (!smartSettings.hideDiff) report += `Totale Differenza Sconto: ${sommaDifferenze.toFixed(2)}€\n`;

  if (smartSettings.showVAT) {
    const imponibile = autoPopolaCosti ? roundTwo(totaleConServizi) : roundTwo(totaleSenzaServizi);
    const vatRate = clamp(parseDec(smartSettings.vatRate ?? 22), 0, 100);
    const iva = roundTwo(imponibile * (vatRate / 100));
    const totaleIvato = roundTwo(imponibile + iva);

    report += `\nRIEPILOGO IVA\n`;
    report += `Imponibile: ${imponibile.toFixed(2)}€\n`;
    report += `IVA (${vatRate.toFixed(1)}%): ${iva.toFixed(2)}€\n`;
    report += `Totale + IVA: ${totaleIvato.toFixed(2)}€\n`;
  }

  return report;
}

function reportVuoto() {
  if (articoliAggiunti.length) return false;
  alert("Nessun articolo nel preventivo: aggiungi almeno un articolo.");
  return true;
}

function inviaReportWhatsApp() {
  if (reportVuoto()) return;
  const report = generaReportTesto();
  mostraAnteprimaReport(report);
  apriWhatsAppConTesto(report);
}

// Nome storico mantenuto (usato dall'onclick in index.html): genera il TXT
function generaPDFReport() {
  if (reportVuoto()) return;
  const report = generaReportTesto();
  mostraAnteprimaReport(report);
  downloadTextFile(smartSettings.smartMode ? "preventivo_smart.txt" : "report.txt", report);
}

function generaReportTestoSenzaMargine() {
  if (smartSettings.smartMode) return generaReportSmartCliente();

  let report = "Report Articoli (senza Margine):\n\n";
  let totaleSenzaServizi = 0;
  let totaleConServizi = 0;

  const checkboxServizi = document.getElementById("toggleMostraServizi");
  const mostraServizi = checkboxServizi && checkboxServizi.checked;

  const clientMode = !!smartSettings.showClientDiscount;

  articoliAggiunti.forEach((articolo, index) => {
    const prezzoLordo = parseDec(articolo.prezzoLordo || 0);
    const quantita = Math.max(1, parseInt(articolo.quantita || 1, 10) || 1);

    let prezzoNetto = 0;

    if (clientMode) {
      const sc = clamp(parseDec(articolo.scontoCliente || 0), 0, 100);
      prezzoNetto = roundTwo(prezzoLordo * (1 - sc / 100));
    } else {
      const sconto1 = clamp(parseDec(articolo.sconto || 0), 0, 100);
      const sconto2 = clamp(parseDec(articolo.sconto2 || 0), 0, 100);
      prezzoNetto = roundTwo(prezzoLordo * (1 - sconto1 / 100) * (1 - sconto2 / 100));
    }

    const granTotale =
      (prezzoNetto + Math.max(0, parseDec(articolo.costoTrasporto || 0)) + Math.max(0, parseDec(articolo.costoInstallazione || 0)))
      * quantita;

    const granTotaleFinal = roundTwo(granTotale);

    totaleSenzaServizi += prezzoNetto * quantita;
    totaleConServizi += granTotaleFinal;

    report += `${index + 1}. Codice: ${articolo.codice}\n`;
    report += `Descrizione: ${articolo.descrizione}\n`;
    report += `Prezzo netto: ${prezzoNetto.toFixed(2)}€\n`;

    if (!smartSettings.hideDiscounts) {
      if (clientMode) {
        report += `Sconto cliente: ${clamp(parseDec(articolo.scontoCliente || 0), 0, 100).toFixed(2)}%\n`;
      } else {
        report += `Sconto 1: ${clamp(parseDec(articolo.sconto || 0), 0, 100)}%\n`;
        report += `Sconto 2: ${clamp(parseDec(articolo.sconto2 || 0), 0, 100)}%\n`;
      }
    }

    report += `Quantità: ${quantita}\n`;

    if (mostraServizi && autoPopolaCosti) {
      report += `Trasporto: ${roundTwo(parseDec(articolo.costoTrasporto || 0)).toFixed(2)}€\n`;
      report += `Installazione: ${roundTwo(parseDec(articolo.costoInstallazione || 0)).toFixed(2)}€\n`;
    }

    report += `Totale: ${granTotaleFinal.toFixed(2)}€\n\n`;
  });

  report += `Totale Netto (senza Trasporto/Installazione): ${totaleSenzaServizi.toFixed(2)}€\n`;
  if (autoPopolaCosti) report += `Totale Complessivo (inclusi Trasporto/Installazione): ${totaleConServizi.toFixed(2)}€\n`;

  if (smartSettings.showVAT) {
    const imponibile = autoPopolaCosti ? roundTwo(totaleConServizi) : roundTwo(totaleSenzaServizi);
    const vatRate = clamp(parseDec(smartSettings.vatRate ?? 22), 0, 100);
    const iva = roundTwo(imponibile * (vatRate / 100));
    const totaleIvato = roundTwo(imponibile + iva);

    report += `\nRIEPILOGO IVA\n`;
    report += `Imponibile: ${imponibile.toFixed(2)}€\n`;
    report += `IVA (${vatRate.toFixed(1)}%): ${iva.toFixed(2)}€\n`;
    report += `Totale + IVA: ${totaleIvato.toFixed(2)}€\n`;
  }

  return report;
}

function inviaReportWhatsAppSenzaMargine() {
  if (reportVuoto()) return;
  const report = generaReportTestoSenzaMargine();
  mostraAnteprimaReport(report);
  apriWhatsAppConTesto(report);
}

function generaTXTReportSenzaMargine() {
  if (reportVuoto()) return;
  const report = generaReportTestoSenzaMargine();
  mostraAnteprimaReport(report);
  downloadTextFile(smartSettings.smartMode ? "preventivo_smart.txt" : "report_senza_margine.txt", report);
}
