/* Test di logica CSVXpressSmart — eseguibile con: node tests/logic.test.js
   Carica app.js dentro un DOM minimo simulato e verifica calcoli, report,
   export TXT e riconoscimento file. Non fa parte dell'app pubblicata. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

let passed = 0, failed = 0;
const results = [];
function check(name, cond, extra) {
  if (cond) { passed++; results.push(`  PASS  ${name}`); }
  else { failed++; results.push(`  FAIL  ${name}${extra ? ' -> ' + extra : ''}`); }
}

/* ---------------- DOM stub ---------------- */
const created = { anchors: [] };

function makeEl(tag = 'div', id = '') {
  const el = {
    tagName: String(tag).toUpperCase(),
    id,
    style: {},
    dataset: {},
    children: [],
    value: '',
    checked: false,
    textContent: '',
    innerHTML: '',
    disabled: false,
    clicked: 0,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    insertAdjacentElement() {},
    removeChild() {},
    remove() { this.removed = true; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {},
    getAttribute() { return null; },
    click() { this.clicked++; }
  };
  if (String(tag).toLowerCase() === 'a') { el.download = ''; el.href = ''; created.anchors.push(el); }
  return el;
}

const els = {
  toggleMostraServizi: Object.assign(makeEl('input', 'toggleMostraServizi'), { checked: true }),
  toggleCosti: Object.assign(makeEl('input', 'toggleCosti'), { checked: true }),
  reportPreview: makeEl('div', 'reportPreview'),
  csvError: makeEl('p', 'csvError'),
  csvLoadStatus: makeEl('p', 'csvLoadStatus'),
  smartEquivalentDiscount: makeEl('span', 'smartEquivalentDiscount'),
  savedCsvInfo: makeEl('div', 'savedCsvInfo'),
  listinoSelect: makeEl('select', 'listinoSelect'),
  searchListino: makeEl('input', 'searchListino')
};

const document_ = {
  documentElement: { getAttribute: () => '1.2.0' },
  body: makeEl('body'),
  addEventListener() {},
  getElementById: (id) => els[id] || null,
  createElement: (tag) => makeEl(tag),
  createDocumentFragment: () => makeEl('fragment'),
  querySelector: () => null,
  querySelectorAll: () => []
};

const revoked = [];
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  performance: { now: () => 0 },
  alert: () => {},
  document: document_,
  navigator: {},                     // niente serviceWorker: registrazione saltata
  indexedDB: undefined,
  Blob: class Blob { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } },
  URL: { createObjectURL: () => 'blob:fake-url', revokeObjectURL: (u) => revoked.push(u) },
  localStorage: {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
  },
  sessionStorage: { getItem: () => null, setItem() {} },
  FileReader: class FileReader {
    readAsArrayBuffer(blob) {
      const buf = blob && blob.__bytes ? blob.__bytes : new Uint8Array([0x63, 0x6f, 0x64]);
      setTimeout(() => this.onload && this.onload({ target: { result: buf.buffer } }), 0);
    }
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* ---------------- Test code, eseguito nello stesso scope di app.js ---------------- */
const TESTS = `
/* --- parseDec: formati EU / USA / misti --- */
check('parseDec "4.380,00" (EU) = 4380', parseDec('4.380,00') === 4380, parseDec('4.380,00'));
check('parseDec "4,380.00" (USA) = 4380', parseDec('4,380.00') === 4380, parseDec('4,380.00'));
check('parseDec "60,43" = 60.43', parseDec('60,43') === 60.43, parseDec('60,43'));
check('parseDec "60.43" = 60.43', parseDec('60.43') === 60.43, parseDec('60.43'));
check('parseDec "10.850" = 10850 (migliaia)', parseDec('10.850') === 10850, parseDec('10.850'));
check('parseDec "1.234.567" = 1234567', parseDec('1.234.567') === 1234567, parseDec('1.234.567'));
check('parseDec numero Excel 1234.56', parseDec(1234.56) === 1234.56, parseDec(1234.56));
check('parseDec vuoto = 0', parseDec('') === 0 && parseDec(null) === 0 && parseDec(undefined) === 0);
check('parseDec testo non numerico = 0', parseDec('abc') === 0, parseDec('abc'));

/* --- escapeHtml --- */
check('escapeHtml neutralizza tag', escapeHtml('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;', escapeHtml('<img src=x>'));
check('escapeHtml gestisce virgolette', escapeHtml('a"b') === 'a&quot;b');

/* --- normalizeListino: alias colonne IT/EN, case-insensitive --- */
var righe = [
  { Codice: 'A1', Descrizione: 'Art uno', Prezzo: '1.000,00', Trasporto: '50', Installazione: '25' },
  { code: 'B2', description: 'Art due', price: '250.50' },
  { CODICE: 'C3', DESCRIZIONE: 'Art tre', 'PREZZO LORDO': '99,90' },
  { Codice: '', Prezzo: '10' },
  { Codice: 'D4' },
  { Codice: 'E5', Prezzo: '0' }
];
var norm = normalizeListino(righe);
check('normalizeListino accetta 3 righe valide', norm.length === 3, norm.length);
check('normalizeListino prezzo EU 1.000,00 -> 1000', norm[0].prezzoLordo === 1000, norm[0].prezzoLordo);
check('normalizeListino alias inglesi', norm[1].codice === 'B2' && norm[1].prezzoLordo === 250.5);
check('normalizeListino alias con spazio "PREZZO LORDO"', norm[2].prezzoLordo === 99.9, norm[2].prezzoLordo);
check('normalizeListino trasporto/installazione', norm[0].costoTrasporto === 50 && norm[0].costoInstallazione === 25);
check('normalizeListino scarta codice vuoto / prezzo mancante / prezzo 0', norm.length === 3);
check('normalizeListino descrizione mancante -> placeholder', normalizeListino([{Codice:'X',Prezzo:'5'}])[0].descrizione === '(senza descrizione)');

/* --- computeRow: sconti, margine, servizi, quantità --- */
smartSettings.showClientDiscount = false;
var art = { prezzoLordo: 1000, sconto: 20, sconto2: 10, margine: 25, costoTrasporto: 50, costoInstallazione: 30, quantita: 2, venduto: 0 };
var r = computeRow(art);
check('computeRow netto 1000 -20% -10% = 720', r.totaleNettoUnit === 720, r.totaleNettoUnit);
check('computeRow con margine 25% = 960', r.conMargineUnit === 960, r.conMargineUnit);
check('computeRow servizi = 80', r.serviziUnit === 80, r.serviziUnit);
check('computeRow totale riga (960+80)*2 = 2080', r.granTotRiga === 2080, r.granTotRiga);
check('computeRow qta minima 1', computeRow({prezzoLordo:100, quantita:0}).qta === 1);
check('computeRow sconto >100 viene limitato', computeRow({prezzoLordo:100, sconto:150}).totaleNettoUnit === 0);
check('computeRow differenza venduto', computeRow({prezzoLordo:100, quantita:1, venduto:150}).differenza === 50);

/* --- modalità Sconto Cliente: prezzo finale invariato --- */
var eqDisc = computeClientDiscountFromCurrent(art);
smartSettings.showClientDiscount = true;
var r2 = computeRow({ ...art, scontoCliente: eqDisc, sconto: 0, sconto2: 0, margine: 0 });
check('sconto cliente equivalente mantiene il prezzo (960)', Math.abs(r2.conMargineUnit - 960) < 0.01, r2.conMargineUnit);
check('sconto cliente equivalente = 4%', Math.abs(eqDisc - 4) < 0.001, eqDisc);
smartSettings.showClientDiscount = false;

/* --- report standard --- */
articoliAggiunti = [
  { codice: 'A1', descrizione: 'Articolo uno', prezzoLordo: 1000, sconto: 20, sconto2: 10, margine: 25,
    costoTrasporto: 50, costoInstallazione: 30, quantita: 2, venduto: 0, scontoCliente: 0 }
];
autoPopolaCosti = true;
smartSettings.smartMode = false;
smartSettings.hideDiscounts = false;
smartSettings.hideVenduto = true;
smartSettings.hideDiff = true;

var rep = generaReportTesto();
check('report contiene il codice', rep.includes('Codice: A1'), '');
check('report contiene prezzo netto 720', rep.includes('720.00'), '');
check('report contiene totale riga 2080', rep.includes('2080.00'), '');
check('report contiene sconti', rep.includes('Sconto 1: 20%') && rep.includes('Sconto 2: 10%'));
check('report contiene trasporto/installazione', rep.includes('Trasporto: 50.00') && rep.includes('Installazione: 30.00'));

/* --- report senza margine --- */
var repNM = generaReportTestoSenzaMargine();
check('report senza margine: intestazione', repNM.includes('senza Margine'));
check('report senza margine: netto 720 (nessun ricarico)', repNM.includes('Prezzo netto: 720.00'));
check('report senza margine: totale (720+80)*2 = 1600', repNM.includes('1600.00'), repNM.split('\\n').find(l=>l.startsWith('Totale:')));
check('report senza margine != report standard', repNM !== rep);

/* --- report smart cliente --- */
smartSettings.smartMode = true;
smartSettings.showVAT = true;
smartSettings.vatRate = 22;
var repSmart = generaReportTesto();
check('report smart: intestazione preventivo', repSmart.includes('PREVENTIVO / ORDINE'));
check('report smart: nessun margine esposto', !repSmart.toLowerCase().includes('margine'));
check('report smart: nessuno sconto esposto', !repSmart.toLowerCase().includes('sconto'));
check('report smart: IVA 22% su 2080 = 457.60', repSmart.includes('457.60'), repSmart);
check('report smart: totale + IVA 2537.60', repSmart.includes('2537.60'));
smartSettings.smartMode = false;
smartSettings.showVAT = false;

/* --- export TXT: comportamento Android-safe --- */
var okTxt = downloadTextFile('report.txt', rep);
var a = created.anchors[created.anchors.length - 1];
check('downloadTextFile ritorna true', okTxt === true);
check('download: anchor con attributo download corretto', a && a.download === 'report.txt', a && a.download);
check('download: click effettivamente invocato', a && a.clicked === 1, a && a.clicked);
check('download: href = object URL', a && a.href === 'blob:fake-url');
check('download: object URL NON revocato subito (fix Android)', revoked.length === 0, JSON.stringify(revoked));

/* --- anteprima report in pagina --- */
mostraAnteprimaReport(rep);
check('anteprima report popolata', els_reportPreview.textContent === rep && els_reportPreview.style.display === 'block');

/* --- WhatsApp: URL e fallback --- */
var opened = null, hrefSet = null;
window.open = function(u){ opened = u; return null; };            // popup bloccato
Object.defineProperty(window, 'location', { value: { set href(v){ hrefSet = v; }, get href(){ return hrefSet; } }, configurable: true });
apriWhatsAppConTesto('ciao mondo & test');
check('whatsapp: endpoint wa.me', opened && opened.startsWith('https://wa.me/?text='), opened);
check('whatsapp: testo codificato', opened.includes('ciao%20mondo%20%26%20test'), opened);
check('whatsapp: fallback su popup bloccato', hrefSet === opened, hrefSet);

/* --- riconoscimento formato file (picker Android senza estensione) --- */
function fakeFile(name, bytes){ return { name: name, size: bytes.length, lastModified: 0, slice: function(){ var b = new Blob([]); b.__bytes = bytes; return b; }, __bytes: bytes }; }
var chiamate = [];
parseExcelFile = function(){ chiamate.push('excel'); };
parseCsvFile = function(){ chiamate.push('csv'); };
`;

// parseExcelFile/parseCsvFile sono function declaration: le sovrascriviamo dopo il caricamento
const TESTS_ASYNC = `
sniffAndParse(fakeFile('documento', new Uint8Array([0x50,0x4B,0x03,0x04,0,0,0,0])));   // xlsx
sniffAndParse(fakeFile('documento2', new Uint8Array([0xD0,0xCF,0x11,0xE0,0,0,0,0])));  // xls
sniffAndParse(fakeFile('documento3', new Uint8Array([0x63,0x6f,0x64,0x3b,0,0,0,0])));  // csv "cod;"
setTimeout(function(){
  check('sniffing: PK -> Excel', chiamate[0] === 'excel', chiamate[0]);
  check('sniffing: OLE2 -> Excel', chiamate[1] === 'excel', chiamate[1]);
  check('sniffing: testo -> CSV', chiamate[2] === 'csv', chiamate[2]);
  __done();
}, 30);
`;

sandbox.check = check;
sandbox.created = created;
sandbox.revoked = revoked;
sandbox.els_reportPreview = els.reportPreview;
sandbox.__done = () => {
  console.log('\n' + results.join('\n'));
  console.log(`\n  ${passed} passati, ${failed} falliti\n`);
  process.exit(failed ? 1 : 0);
};

vm.runInContext(APP + '\n' + TESTS + '\n' + TESTS_ASYNC, sandbox, { filename: 'app.js' });
