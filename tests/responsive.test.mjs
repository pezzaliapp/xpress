/* Verifica responsive mirata: nessun elemento della scheda articolo deve
   uscire dalla viewport, su tutte le larghezze critiche.
   Uso: ORIGIN=http://127.0.0.1:8899 node tests/responsive.test.mjs
   Non fa parte dell'app pubblicata. */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORIGIN = process.env.ORIGIN || 'http://127.0.0.1:8899';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT || 9360);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'resp-'));

// larghezze richieste: bordi delle media query + dispositivi reali
const VIEWPORT = [320, 340, 341, 344, 345, 352, 360, 390, 412, 717, 720, 721, 1280];

const out = [];
let passed = 0, failed = 0;
const ok = (n, c, e) => { if (c) { passed++; out.push(`  PASS  ${n}`); } else { failed++; out.push(`  FAIL  ${n}${e !== undefined ? ' -> ' + JSON.stringify(e) : ''}`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });

for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch (_) {} await sleep(250); }
const target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map(); const h = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } else if (m.method) (h.get(m.method) || []).forEach(f => f(m.params)); };
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + m)); } }, 30000); });
const on = (m, f) => { if (!h.has(m)) h.set(m, []); h.get(m).push(f); };
const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };

await send('Page.enable'); await send('Runtime.enable');

// stesso articolo delle segnalazioni reali (codice e descrizione lunghi)
const ARTICOLO = `
  listino = [{codice:'0110037',descrizione:'Touch MEC 822VDL-P SONAR conNLS, e Laser 1ph 230V-50/60Hz',prezzoLordo:10850,sconto:0,sconto2:0,margine:0,scontoCliente:0,costoTrasporto:0,costoInstallazione:0,quantita:1,venduto:0}];
  articoliAggiunti = [];
  aggiornaListinoSelect();
  document.getElementById('listinoSelect').selectedIndex = 0;
  aggiungiArticoloDaListino();
  'ok'`;

const MISURA = `
  (() => {
    const win = window.innerWidth;
    const R = el => el.getBoundingClientRect();
    const dentro = el => R(el).right <= win + 0.5 && R(el).left >= -0.5;

    const sezione = document.getElementById('articoli-section');
    const card = document.querySelector('#articoli-table tbody tr');
    const tabella = document.getElementById('articoli-table');
    const bottone = document.querySelector('#articoli-table td[data-col="azioni"] button');
    const totali = document.getElementById('totaleGenerale');
    const pulsantiReport = [...document.querySelectorAll('.report-actions button')];

    // celle il cui contenuto risulta troncato dal ritaglio della card
    const tagliate = [];
    document.querySelectorAll('#articoli-table tbody td').forEach(td => {
      if (getComputedStyle(td).display === 'none') return;
      const rt = R(td);
      if (rt.right > win + 0.5) tagliate.push(td.dataset.col);
      td.querySelectorAll('input').forEach(inp => {
        if (R(inp).right > win + 0.5) tagliate.push(td.dataset.col + ':input');
      });
    });

    const beforeAzioni = getComputedStyle(document.querySelector('#articoli-table td[data-col="azioni"]'), '::before');

    return {
      viewport: win,
      scrollWidth: document.documentElement.scrollWidth,
      scrollOrizzontale: document.documentElement.scrollWidth > win,
      sezione: { largh: Math.round(R(sezione).width), destra: Math.round(R(sezione).right), dentro: dentro(sezione) },
      tabella: { largh: Math.round(R(tabella).width), destra: Math.round(R(tabella).right), display: getComputedStyle(tabella).display },
      card: { largh: Math.round(R(card).width), destra: Math.round(R(card).right), dentro: dentro(card) },
      bottoneRimuovi: { x: Math.round(R(bottone).left), largh: Math.round(R(bottone).width), destra: Math.round(R(bottone).right), dentro: dentro(bottone), altezza: Math.round(R(bottone).height) },
      etichettaAzioni: beforeAzioni.flexBasis,
      celleTagliate: [...new Set(tagliate)],
      totali: { dentro: dentro(totali), largh: Math.round(R(totali).width) },
      reportTuttiDentro: pulsantiReport.every(dentro),
      reportAltezzaMin: Math.min(...pulsantiReport.map(b => Math.round(R(b).height))),
      inputSc1: Math.round(R(document.querySelector('#articoli-table td[data-col="sconto1"] input')).width)
    };
  })()`;

const misure = {};

for (const w of VIEWPORT) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: w < 720 ? 2.625 : 1, mobile: w < 720 });
  const caricata = new Promise(res => on('Page.loadEventFired', res));
  await send('Page.navigate', { url: ORIGIN + '/?vp=' + w });
  await caricata; await sleep(700);
  await ev(ARTICOLO);
  await sleep(300);

  const m = await ev(MISURA);
  misure[w] = m;

  const cardOk = m.card.dentro || w > 720;  // >720 la tabella scorre nel suo contenitore
  ok(`${w}px: nessuno scroll orizzontale di pagina`, !m.scrollOrizzontale, { scrollWidth: m.scrollWidth, viewport: m.viewport });
  ok(`${w}px: #articoli-section dentro la viewport`, m.sezione.dentro, m.sezione);
  ok(`${w}px: card articolo interamente visibile`, cardOk, m.card);
  if (w <= 720) {
    ok(`${w}px: nessuna cella/input tagliato`, m.celleTagliate.length === 0, m.celleTagliate);
    ok(`${w}px: pulsante Rimuovi interamente visibile`, m.bottoneRimuovi.dentro, m.bottoneRimuovi);
  }
  ok(`${w}px: riquadro totali dentro la viewport`, m.totali.dentro, m.totali);
  ok(`${w}px: pulsanti Report tutti dentro la viewport`, m.reportTuttiDentro);
}

console.log('\n' + out.join('\n'));

console.log('\n=== dettaglio 344px (Galaxy Z Fold chiuso) ===');
console.log(JSON.stringify(misure[344], null, 1));

console.log('\n=== quadro sintetico ===');
console.log('vp    scrollW  tabella(display)  card  destraCard  input  Rimuovi(x,largh)  tagliate');
for (const w of VIEWPORT) {
  const m = misure[w];
  console.log(
    String(w).padEnd(6) +
    String(m.scrollWidth).padEnd(9) +
    (m.tabella.display + ' ' + m.tabella.largh).padEnd(18) +
    String(m.card.largh).padEnd(6) +
    String(m.card.destra).padEnd(12) +
    String(m.inputSc1).padEnd(7) +
    (m.bottoneRimuovi.x + ',' + m.bottoneRimuovi.largh).padEnd(18) +
    (m.celleTagliate.length ? m.celleTagliate.join(',') : '-')
  );
}

console.log(`\n  ${passed} passati, ${failed} falliti\n`);
chrome.kill();
process.exit(failed ? 1 : 0);
