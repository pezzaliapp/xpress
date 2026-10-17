/* Test end-to-end CSVXpressSmart in Chrome headless via CDP.
   Uso:  node tests/browser.test.mjs            (server statico su 127.0.0.1:8899 già attivo)
   Non fa parte dell'app pubblicata. */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORIGIN = process.env.ORIGIN || 'http://127.0.0.1:8899';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'csvx-chrome-'));
const DOWNLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'csvx-dl-'));

const out = [];
let passed = 0, failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed++; out.push(`  PASS  ${name}`); }
  else { failed++; out.push(`  FAIL  ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- avvio Chrome ---------- */
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--disable-features=Translate', '--window-size=412,915',
  'about:blank'
], { stdio: 'ignore' });

async function waitForChrome() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch (_) {}
    await sleep(250);
  }
  throw new Error('Chrome non raggiungibile');
}

/* ---------- client CDP minimale ---------- */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        (this.handlers.get(msg.method) || []).forEach(fn => fn(msg.params));
      }
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    return new CDP(ws);
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 30000);
    });
  }
  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture: true
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'JS error');
    return r.result.value;
  }
}

const consoleErrors = [];

async function main() {
  await waitForChrome();

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');

  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'error') consoleErrors.push(entry.text);
  });
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    consoleErrors.push(exceptionDetails.exception?.description || exceptionDetails.text);
  });

  // richieste esterne all'origine locale: devono essere ZERO
  const external = [];
  cdp.on('Network.requestWillBeSent', ({ request }) => {
    if (!request.url.startsWith(ORIGIN) && !request.url.startsWith('data:') && !request.url.startsWith('blob:')) {
      external.push(request.url);
    }
  });

  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });

  /* ============ 1. Caricamento pagina ============ */
  await cdp.send('Page.navigate', { url: ORIGIN + '/' });
  await new Promise(res => cdp.on('Page.loadEventFired', res));
  await sleep(800);

  ok('pagina caricata (title)', await cdp.eval('document.title') === 'CSVXpressSmart');
  ok('PapaParse disponibile (locale)', await cdp.eval("typeof Papa !== 'undefined'"));
  ok('SheetJS disponibile (locale)', await cdp.eval("typeof XLSX !== 'undefined'"));
  ok('nessun errore JS al caricamento', consoleErrors.length === 0, consoleErrors);
  ok('nessuna richiesta a domini esterni', external.length === 0, external);
  ok('window.Android NON richiesto', await cdp.eval("typeof window.Android === 'undefined'"));
  ok('nessun tracker (gtag/clarity/track) presente', await cdp.eval(
    "typeof window.gtag === 'undefined' && typeof window.clarity === 'undefined' && typeof window.track === 'undefined'"));

  /* ============ 2. Service Worker + manifest ============ */
  const swReg = await cdp.eval(`
    (async () => {
      const r = await navigator.serviceWorker.ready;
      return { active: !!r.active, scope: r.scope };
    })()`);
  ok('service worker attivo', swReg && swReg.active === true, swReg);
  ok('scope service worker = root', swReg && swReg.scope.endsWith('/'), swReg && swReg.scope);

  const manifest = await cdp.eval(`fetch('manifest.json').then(r=>r.json())`);
  ok('manifest: display standalone', manifest.display === 'standalone');
  ok('manifest: start_url relativo', manifest.start_url === './');
  ok('manifest: scope relativo', manifest.scope === './');
  ok('manifest: icone 192 e 512 presenti',
    manifest.icons.some(i => i.sizes === '192x192') && manifest.icons.some(i => i.sizes === '512x512'));
  ok('manifest: theme_color = meta theme-color', await cdp.eval(
    `document.querySelector('meta[name="theme-color"]').content`) === manifest.theme_color);

  const iconsOk = await cdp.eval(`
    Promise.all(${JSON.stringify(manifest.icons.map(i => i.src))}.map(src =>
      new Promise(res => { const im = new Image(); im.onload = () => res(im.naturalWidth); im.onerror = () => res(0); im.src = src; })
    ))`);
  ok('icone manifest caricabili', iconsOk.every(w => w > 0), iconsOk);

  /* ============ 3. Import CSV (input file reale) ============ */
  const csvText = [
    'Codice;Descrizione;Prezzo;Trasporto;Installazione',
    'ART-001;Compressore rotativo 10 HP;4.380,00;120,00;250,00',
    'ART-002;Essiccatore a ciclo frigorifero;1.250,50;80,00;0',
    'ART-003;Filtro linea 1";320,00;0;0',
    'ART-004;Serbatoio 500 lt <test>;890,00;150,00;100,00',
    'ART-005;Riga senza prezzo;;0;0'
  ].join('\n');

  const importCsv = await cdp.eval(`
    (async () => {
      const csv = ${JSON.stringify(csvText)};
      const file = new File([csv], 'listino.csv', { type: 'text/csv' });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.getElementById('csvFileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 700));
      return {
        options: document.getElementById('listinoSelect').options.length,
        status: document.getElementById('csvLoadStatus').textContent,
        errorVisible: document.getElementById('csvError').style.display !== 'none',
        inputReset: document.getElementById('csvFileInput').value === '',
        primo: listino[0]
      };
    })()`);

  ok('CSV: 4 articoli validi importati', importCsv.options === 4, importCsv);
  ok('CSV: riga senza prezzo scartata e segnalata', /1 riga ignorata/.test(importCsv.status), importCsv.status);
  ok('CSV: nessun errore mostrato', importCsv.errorVisible === false);
  ok('CSV: input resettato (ri-selezione stesso file possibile)', importCsv.inputReset === true);
  ok('CSV: prezzo EU "4.380,00" -> 4380', importCsv.primo.prezzoLordo === 4380, importCsv.primo.prezzoLordo);
  ok('CSV: trasporto "120,00" -> 120', importCsv.primo.costoTrasporto === 120, importCsv.primo.costoTrasporto);

  /* ============ 4. Ricerca ============ */
  const ricerca = await cdp.eval(`
    (() => {
      const s = document.getElementById('searchListino');
      s.value = 'essicc'; s.dispatchEvent(new Event('input', { bubbles: true }));
      const n1 = document.getElementById('listinoSelect').options.length;
      const t1 = document.getElementById('listinoSelect').options[0].textContent;
      s.value = 'ART-00'; s.dispatchEvent(new Event('input', { bubbles: true }));
      const n2 = document.getElementById('listinoSelect').options.length;
      s.value = 'zzzz'; s.dispatchEvent(new Event('input', { bubbles: true }));
      const n3 = document.getElementById('listinoSelect').options[0].textContent;
      s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true }));
      return { n1, t1, n2, n3, n4: document.getElementById('listinoSelect').options.length };
    })()`);
  ok('ricerca per descrizione', ricerca.n1 === 1 && ricerca.t1.includes('ART-002'), ricerca);
  ok('ricerca per codice', ricerca.n2 === 4, ricerca.n2);
  ok('ricerca senza risultati: messaggio', ricerca.n3 === 'Nessun articolo trovato', ricerca.n3);
  ok('ricerca svuotata: torna completa', ricerca.n4 === 4, ricerca.n4);

  /* ============ 5. Aggiunta articolo + calcoli in tabella ============ */
  const calcoli = await cdp.eval(`
    (() => {
      const sel = document.getElementById('listinoSelect');
      sel.value = 'ART-001';
      aggiungiArticoloDaListino();

      const setVal = (field, v) => {
        const inp = document.querySelector('#articoli-table tbody input[data-field="' + field + '"]');
        inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setVal('sconto', '20');
      setVal('sconto2', '10');
      setVal('margine', '25');
      setVal('quantita', '2');

      const row = document.querySelector('#articoli-table tbody tr');
      return {
        righe: document.querySelectorAll('#articoli-table tbody tr').length,
        netto: row.querySelector('.cell-totaleNetto').textContent,
        granTot: row.querySelector('.cell-granTot').textContent,
        totali: document.getElementById('totaleGenerale').textContent,
        eqDisc: document.getElementById('smartEquivalentDiscount').textContent,
        descrizioneEscapata: row.querySelector('td[data-col="descrizione"]').textContent
      };
    })()`);
  ok('articolo aggiunto in tabella', calcoli.righe === 1, calcoli.righe);
  ok('calcolo netto 4380 -20% -10% = 3153.60', calcoli.netto === '3153.60€', calcoli.netto);
  ok('calcolo totale (4204.80+370)*2 = 9149.60', calcoli.granTot === '9149.60€', calcoli.granTot);
  ok('totali generali aggiornati', calcoli.totali.includes('9149.60'), calcoli.totali);
  ok('sconto equivalente cliente calcolato', /%$/.test(calcoli.eqDisc.trim()), calcoli.eqDisc);

  /* ============ 6. Sicurezza: descrizione con HTML non interpretata ============ */
  const xss = await cdp.eval(`
    (() => {
      const sel = document.getElementById('listinoSelect');
      sel.value = 'ART-004'; aggiungiArticoloDaListino();
      const tds = [...document.querySelectorAll('#articoli-table td[data-col="descrizione"]')];
      const td = tds[tds.length - 1];
      return { testo: td.textContent, figli: td.children.length };
    })()`);
  ok('descrizione con <test> resa come testo', xss.testo.includes('<test>') && xss.figli === 0, xss);

  /* ============ 7. Generazione TXT (file realmente scritto su disco) ============ */
  const txt = await cdp.eval(`(() => { generaPDFReport(); return document.getElementById('reportPreview').style.display; })()`);
  await sleep(1500);
  const files1 = fs.readdirSync(DOWNLOADS).filter(f => f.endsWith('.txt'));
  ok('TXT: file scaricato su disco', files1.includes('report.txt'), fs.readdirSync(DOWNLOADS));
  ok('TXT: anteprima report mostrata in pagina', txt === 'block', txt);

  let contenuto = '';
  if (files1.includes('report.txt')) {
    contenuto = fs.readFileSync(path.join(DOWNLOADS, 'report.txt'), 'utf8');
  }
  ok('TXT: contenuto non vuoto', contenuto.length > 50, contenuto.length);
  ok('TXT: contiene codice articolo', contenuto.includes('ART-001'));
  ok('TXT: contiene totale 9149.60', contenuto.includes('9149.60'), contenuto.slice(0, 200));
  ok('TXT: euro leggibile (UTF-8)', contenuto.includes('€'));

  /* ============ 8. TXT senza margine ============ */
  await cdp.eval('generaTXTReportSenzaMargine()');
  await sleep(1500);
  const files2 = fs.readdirSync(DOWNLOADS);
  ok('TXT senza margine: file scaricato', files2.includes('report_senza_margine.txt'), files2);

  let contenutoNM = '';
  if (files2.includes('report_senza_margine.txt')) {
    contenutoNM = fs.readFileSync(path.join(DOWNLOADS, 'report_senza_margine.txt'), 'utf8');
  }
  ok('TXT senza margine: intestazione corretta', contenutoNM.includes('senza Margine'), contenutoNM.slice(0, 60));
  ok('TXT senza margine: netto senza ricarico (3153.60)', contenutoNM.includes('Prezzo netto: 3153.60'), contenutoNM.slice(0, 300));
  ok('TXT senza margine: totale riga 7047.20', contenutoNM.includes('7047.20'), contenutoNM.slice(0, 400));

  /* ============ 9. Object URL non revocato troppo presto ============ */
  const blobLive = await cdp.eval(`
    (async () => {
      const b = new Blob(['x'], { type: 'text/plain;charset=utf-8' });
      const u = URL.createObjectURL(b);
      const a = document.createElement('a'); a.href = u; a.download = 'probe.txt';
      document.body.appendChild(a); a.click();
      await new Promise(r => setTimeout(r, 400));
      const res = await fetch(u).then(r => r.ok).catch(() => false);
      URL.revokeObjectURL(u); a.remove();
      return res;
    })()`);
  ok('object URL ancora valido dopo il click (nessuna revoca precoce)', blobLive === true);

  /* ============ 10. WhatsApp ============ */
  const wa = await cdp.eval(`
    (() => {
      const orig = window.open; let captured = null;
      window.open = (u) => { captured = u; return { closed: false }; };
      inviaReportWhatsApp();
      window.open = orig;
      return captured;
    })()`);
  ok('WhatsApp: apre wa.me con testo', typeof wa === 'string' && wa.startsWith('https://wa.me/?text='), wa && wa.slice(0, 60));
  ok('WhatsApp: report codificato nel link', typeof wa === 'string' && decodeURIComponent(wa.split('text=')[1]).includes('ART-001'));

  /* ============ 11. Import Excel .xlsx reale ============ */
  const xlsxTest = await cdp.eval(`
    (async () => {
      const ws = XLSX.utils.aoa_to_sheet([
        ['Codice','Descrizione','Prezzo','CostoTrasporto'],
        ['XL-1','Articolo Excel uno', 1500.5, 60],
        ['XL-2','Articolo Excel due', 2400, 0],
        ['XL-3','Senza prezzo', '', 0]
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Listino');
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const file = new File([buf], 'listino.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.getElementById('csvFileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 900));
      return { options: document.getElementById('listinoSelect').options.length, status: document.getElementById('csvLoadStatus').textContent, primo: listino[0] };
    })()`);
  ok('Excel .xlsx: 2 articoli validi importati', xlsxTest.options === 2, xlsxTest);
  ok('Excel .xlsx: numeri nativi corretti (1500.5)', xlsxTest.primo.prezzoLordo === 1500.5, xlsxTest.primo);
  ok('Excel .xlsx: riga senza prezzo scartata', /1 riga ignorata/.test(xlsxTest.status), xlsxTest.status);

  /* ============ 12. Excel .xls (BIFF8) ============ */
  const xlsTest = await cdp.eval(`
    (async () => {
      try {
        const ws = XLSX.utils.aoa_to_sheet([['Codice','Descrizione','Prezzo'],['OLD-1','Articolo xls', 777]]);
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S1');
        const buf = XLSX.write(wb, { bookType: 'biff8', type: 'array' });
        const file = new File([buf], 'vecchio.xls', { type: 'application/vnd.ms-excel' });
        const dt = new DataTransfer(); dt.items.add(file);
        const input = document.getElementById('csvFileInput');
        input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 900));
        return { options: document.getElementById('listinoSelect').options.length, primo: listino[0] };
      } catch (e) { return { error: String(e) }; }
    })()`);
  ok('Excel .xls (BIFF8): importato', xlsTest.options === 1 && xlsTest.primo.prezzoLordo === 777, xlsTest);

  /* ============ 13. File senza estensione (picker Android) ============ */
  const sniffTest = await cdp.eval(`
    (async () => {
      const ws = XLSX.utils.aoa_to_sheet([['Codice','Descrizione','Prezzo'],['SNIFF-1','Da Google Drive', 55]]);
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S1');
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const file = new File([buf], 'documento', { type: '' });   // nessuna estensione, nessun MIME
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.getElementById('csvFileInput');
      input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1000));
      return { options: document.getElementById('listinoSelect').options.length, primo: listino[0] };
    })()`);
  ok('file senza estensione riconosciuto come Excel', sniffTest.options === 1 && sniffTest.primo.codice === 'SNIFF-1', sniffTest);

  /* ============ 14. IndexedDB: memoria listino ============ */
  const idb = await cdp.eval(`
    new Promise(res => {
      const rq = indexedDB.open('csvxpresssmart_db_v1', 1);
      rq.onsuccess = () => {
        const db = rq.result;
        const r2 = db.transaction('kv','readonly').objectStore('kv').get('last_csv_payload');
        r2.onsuccess = () => res({ righe: r2.result?.listino?.length ?? -1, nome: r2.result?.meta?.name ?? null });
        r2.onerror = () => res({ righe: -1 });
      };
      rq.onerror = () => res({ righe: -2 });
    })`);
  ok('IndexedDB: listino salvato', idb.righe === 1 && idb.nome === 'documento', idb);

  /* ============ 15. Reload: ripristino automatico listino + persistenza impostazioni ============ */
  await cdp.eval(`document.getElementById('toggleSmartMode').checked = true; document.getElementById('toggleSmartMode').dispatchEvent(new Event('change',{bubbles:true}));`);
  await sleep(200);
  await cdp.send('Page.reload');
  await new Promise(res => cdp.on('Page.loadEventFired', res));
  await sleep(1000);

  const dopoReload = await cdp.eval(`
    (async () => {
      await new Promise(r => setTimeout(r, 500));
      return {
        opzioni: document.getElementById('listinoSelect').options.length,
        info: document.getElementById('savedCsvInfo').textContent,
        smart: document.getElementById('toggleSmartMode').checked,
        prezzoLordoNascosto: document.querySelector('th[data-col="prezzoLordo"]').classList.contains('col-hidden')
      };
    })()`);
  ok('reload: listino ricaricato da IndexedDB', dopoReload.opzioni === 1, dopoReload);
  ok('reload: info listino salvato mostrata', /Righe: 1/.test(dopoReload.info), dopoReload.info);
  ok('reload: impostazione Smart persistita', dopoReload.smart === true);
  ok('modalità Smart nasconde il prezzo lordo', dopoReload.prezzoLordoNascosto === true);

  await cdp.eval(`document.getElementById('toggleSmartMode').checked = false; document.getElementById('toggleSmartMode').dispatchEvent(new Event('change',{bubbles:true}));`);

  /* ============ 16. Responsive: nessun overflow orizzontale ============ */
  const viewports = [
    { nome: 'Galaxy Fold chiuso 280x653', w: 280, h: 653 },
    { nome: 'Android piccolo 360x800', w: 360, h: 800 },
    { nome: 'Pixel 412x915', w: 412, h: 915 },
    { nome: 'Fold aperto 717x512', w: 717, h: 512 },
    { nome: 'Desktop 1280x800', w: 1280, h: 800 }
  ];

  for (const v of viewports) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: v.w, height: v.h, deviceScaleFactor: 2, mobile: v.w < 720
    });
    await sleep(400);

    const layout = await cdp.eval(`
      (() => {
        const sel = document.getElementById('listinoSelect');
        if (sel.options.length && !document.querySelector('#articoli-table tbody tr')) { sel.selectedIndex = 0; aggiungiArticoloDaListino(); }
        const docW = document.documentElement.scrollWidth;
        const winW = window.innerWidth;

        // un elemento può essere più largo dello schermo SOLO se sta dentro un
        // contenitore con scroll orizzontale esplicito (la tabella su desktop)
        const inScroller = (el) => {
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const ox = getComputedStyle(p).overflowX;
            if (ox === 'auto' || ox === 'scroll') return true;
          }
          return false;
        };

        let fuori = [];
        document.querySelectorAll('main *').forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && (r.right > winW + 1 || r.left < -1) && !inScroller(el)) {
            fuori.push(el.tagName + (el.id ? '#' + el.id : '') + (el.dataset.col ? '[' + el.dataset.col + ']' : ''));
          }
        });

        // il contenitore scrollabile, invece, non deve MAI sforare
        const sec = document.getElementById('articoli-section').getBoundingClientRect();
        if (sec.right > winW + 1) fuori.push('SECTION#articoli-section');
        const btn = document.getElementById('btnTXT').getBoundingClientRect();
        const inp = document.querySelector('#articoli-table tbody input');
        return { docW, winW, fuori: [...new Set(fuori)].slice(0, 6), btnH: Math.round(btn.height), btnW: Math.round(btn.width), inpH: inp ? Math.round(inp.getBoundingClientRect().height) : null };
      })()`);

    ok(`responsive ${v.nome}: nessuno scroll orizzontale di pagina`, layout.docW <= v.w + 1, layout);
    ok(`responsive ${v.nome}: nessun elemento fuori schermo`, layout.fuori.length === 0, layout.fuori);
    ok(`responsive ${v.nome}: pulsante TXT touch-friendly (>=44px)`, layout.btnH >= 44, layout.btnH);
    if (layout.inpH !== null && v.w < 720) {
      ok(`responsive ${v.nome}: input tabella touch-friendly (>=40px)`, layout.inpH >= 40, layout.inpH);
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  /* ============ 17. Offline ============ */
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0
  });
  await sleep(300);
  await cdp.send('Page.reload');
  await new Promise(res => cdp.on('Page.loadEventFired', res));
  await sleep(1200);

  const offline = await cdp.eval(`
    (() => ({
      title: document.title,
      papa: typeof Papa !== 'undefined',
      xlsx: typeof XLSX !== 'undefined',
      css: getComputedStyle(document.querySelector('header')).backgroundColor,
      opzioni: document.getElementById('listinoSelect').options.length
    }))()`);
  ok('offline: pagina servita dal service worker', offline.title === 'CSVXpressSmart', offline);
  ok('offline: PapaParse dalla cache', offline.papa === true);
  ok('offline: SheetJS dalla cache', offline.xlsx === true);
  ok('offline: CSS applicato', offline.css === 'rgb(33, 150, 243)', offline.css);
  ok('offline: listino da IndexedDB disponibile', offline.opzioni >= 1, offline.opzioni);

  const offlineTxt = await cdp.eval(`
    (() => {
      const sel = document.getElementById('listinoSelect');
      sel.selectedIndex = 0; aggiungiArticoloDaListino();
      generaPDFReport();
      return document.getElementById('reportPreview').textContent.length;
    })()`);
  await sleep(1200);
  ok('offline: generazione TXT funzionante', offlineTxt > 50, offlineTxt);
  ok('offline: file TXT scritto anche senza rete',
    fs.readdirSync(DOWNLOADS).filter(f => f.startsWith('report')).length >= 2, fs.readdirSync(DOWNLOADS));

  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  /* ============ 18. Aggiornamento PWA (nuova versione SW) ============ */
  const cacheInfo = await cdp.eval(`caches.keys()`);
  ok('cache PWA presente e versionata', Array.isArray(cacheInfo) && cacheInfo.some(c => c.startsWith('csvxpresssmart-v')), cacheInfo);
  ok('nessuna cache orfana di versioni precedenti', cacheInfo.length === 1, cacheInfo);

  const cached = await cdp.eval(`
    caches.open(${JSON.stringify(await cdp.eval('caches.keys().then(k=>k[0])'))}).then(c => c.keys()).then(ks => ks.map(r => new URL(r.url).pathname).sort())`);
  ok('cache contiene tutti gli asset di shell',
    ['/app.js', '/index.html', '/manifest.json', '/style.css', '/style.mobile.cards.rev.v3.css',
     '/vendor/papaparse.min.js', '/vendor/xlsx.full.min.js'].every(p => cached.includes(p)), cached);

  ok('nessun errore JS durante tutti i test', consoleErrors.filter(e => !/favicon/i.test(e)).length === 0, consoleErrors);
  ok('nessuna richiesta esterna in tutta la sessione', external.length === 0, external);

  console.log('\n' + out.join('\n'));
  console.log(`\n  ${passed} passati, ${failed} falliti\n`);

  chrome.kill();
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error('ERRORE TEST:', err);
  console.log(out.join('\n'));
  chrome.kill();
  process.exit(2);
});
