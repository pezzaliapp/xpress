/* Test aggiornamento PWA: pubblicazione di una nuova versione mentre la vecchia
   è installata. Verifica swap della cache, rimozione delle cache vecchie e
   assenza di blocchi permanenti del service worker.
   Uso: node tests/update.test.mjs   (server statico su 127.0.0.1:8899 attivo)
   Non fa parte dell'app pubblicata. */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = process.env.ORIGIN || 'http://127.0.0.1:8899';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9335;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'csvx-upd-'));

const out = [];
let passed = 0, failed = 0;
const ok = (n, c, e) => { if (c) { passed++; out.push(`  PASS  ${n}`); } else { failed++; out.push(`  FAIL  ${n}${e !== undefined ? ' -> ' + JSON.stringify(e) : ''}`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SW = path.join(ROOT, 'service-worker.js');
const HTML = path.join(ROOT, 'index.html');
const CSS = path.join(ROOT, 'style.css');
const backup = { sw: fs.readFileSync(SW, 'utf8'), html: fs.readFileSync(HTML, 'utf8'), css: fs.readFileSync(CSS, 'utf8') };
const restore = () => {
  fs.writeFileSync(SW, backup.sw); fs.writeFileSync(HTML, backup.html); fs.writeFileSync(CSS, backup.css);
};

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });

let ws, id = 0; const pend = new Map(); const handlers = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + method)); } }, 30000);
});
const on = (m, fn) => { if (!handlers.has(m)) handlers.set(m, []); handlers.get(m).push(fn); };
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'JS error');
  return r.result.value;
};
// Conta i caricamenti di pagina: quando il nuovo SW prende il controllo l'app
// si ricarica da sola, quindi l'aggiornamento è osservabile come UN secondo
// evento di load dopo il reload manuale.
let loadCount = 0;
const attendiReloadAutomatico = async (daQuota, timeoutMs = 25000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (loadCount >= daQuota) { await sleep(600); return { ok: true, ms: Date.now() - t0 }; }
    await sleep(100);
  }
  return { ok: false, ms: Date.now() - t0, loadCount };
};

const load = async (url) => {
  const done = new Promise(res => on('Page.loadEventFired', res));
  await send(url ? 'Page.navigate' : 'Page.reload', url ? { url } : { ignoreCache: false });
  await done; await sleep(1200);
};

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch (_) {} await sleep(250); }
  const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method) (handlers.get(m.method) || []).forEach(f => f(m.params));
  };
  await send('Page.enable'); await send('Runtime.enable');
  on('Page.loadEventFired', () => { loadCount++; });

  /* ---------- v1: installazione ---------- */
  await load(ORIGIN + '/');
  await evaluate('navigator.serviceWorker.ready');
  await sleep(500);

  const v1 = await evaluate('caches.keys()');
  ok('v1 installata: una sola cache', v1.length === 1, v1);

  const manifestInfo = await send('Page.getAppManifest');
  ok('manifest interpretato da Chrome senza errori', (manifestInfo.errors || []).length === 0, manifestInfo.errors);
  ok('manifest riconosciuto (url presente)', !!manifestInfo.url, manifestInfo.url);

  const headerColorV1 = await evaluate(`getComputedStyle(document.querySelector('header')).backgroundColor`);
  ok('v1: CSS originale attivo', headerColorV1 === 'rgb(33, 150, 243)', headerColorV1);

  /* ---------- pubblicazione v2 ---------- */
  // versioni lette dai file, così il test non scade ad ogni rilascio
  fs.writeFileSync(SW, backup.sw.replace(/const CACHE_VERSION = '[^']+';/, "const CACHE_VERSION = 'v9.9.9-test';"));
  fs.writeFileSync(HTML, backup.html.replace(/data-ver="[^"]+"/, 'data-ver="9.9.9-test"'));
  fs.writeFileSync(CSS, backup.css.replace('--brand:#2196f3;', '--brand:#123456;'));
  await sleep(300);

  // reload: la pagina scarica il nuovo index/SW; il SW installa la nuova shell,
  // si attiva (skipWaiting) e la pagina si ricarica DA SOLA (2° load event)
  const quotaPrima = loadCount;
  await load();
  const auto = await attendiReloadAutomatico(quotaPrima + 2);
  ok(`aggiornamento: reload automatico eseguito dal service worker (${auto.ms} ms)`, auto.ok, auto);

  const cssV2 = await evaluate(`getComputedStyle(document.querySelector('header')).backgroundColor`);
  ok('aggiornamento: nuovo CSS effettivamente servito', cssV2 === 'rgb(18, 52, 86)', cssV2);

  const v2 = await evaluate('caches.keys()');
  ok('aggiornamento: nuova cache creata', v2.includes('csvxpresssmart-v9.9.9-test'), v2);
  ok('aggiornamento: vecchie cache eliminate', v2.length === 1, v2);

  const swState = await evaluate(`
    navigator.serviceWorker.getRegistration().then(r => ({
      active: r && r.active && r.active.state,
      waiting: !!(r && r.waiting),
      controlled: !!navigator.serviceWorker.controller
    }))`);
  ok('aggiornamento: nuovo SW attivo', swState.active === 'activated', swState);
  ok('aggiornamento: nessun SW bloccato in "waiting"', swState.waiting === false, swState);
  ok('aggiornamento: pagina controllata dal SW', swState.controlled === true, swState);

  const verV2 = await evaluate(`document.documentElement.getAttribute('data-ver')`);
  ok('aggiornamento: nuovo index.html servito', verV2 === '9.9.9-test', verV2);

  const appOk = await evaluate(`typeof Papa !== 'undefined' && typeof XLSX !== 'undefined' && typeof generaPDFReport === 'function'`);
  ok('aggiornamento: app pienamente funzionante dopo lo swap', appOk === true);

  /* ---------- rollback alla v1: nessun blocco permanente ----------
     Simula un SECONDO aggiornamento nella stessa sessione: deve essere
     applicato come il primo (l'attesa supera la finestra anti-loop di 10s). */
  restore();
  await sleep(11000);
  const quotaPrima2 = loadCount;
  await load();
  const auto2 = await attendiReloadAutomatico(quotaPrima2 + 2);
  ok(`secondo aggiornamento nella stessa sessione: reload automatico (${auto2.ms} ms)`, auto2.ok, auto2);

  const cssV3 = await evaluate(`getComputedStyle(document.querySelector('header')).backgroundColor`);
  ok('secondo aggiornamento: CSS aggiornato senza intervento manuale', cssV3 === 'rgb(33, 150, 243)', cssV3);

  const v3 = await evaluate('caches.keys()');
  const versionePubblicata = (backup.sw.match(/const CACHE_VERSION = '([^']+)';/) || [])[1];
  ok('rollback: cache riportata alla versione pubblicata', v3.includes('csvxpresssmart-' + versionePubblicata), { attesa: versionePubblicata, trovate: v3 });
  ok('rollback: nessuna cache residua', v3.length === 1, v3);
  ok('rollback: app funzionante (nessun blocco permanente del SW)',
    await evaluate(`typeof generaPDFReport === 'function' && typeof XLSX !== 'undefined'`) === true);

} catch (err) {
  failed++; out.push('  FAIL  eccezione: ' + err.message);
} finally {
  restore();
  console.log('\n' + out.join('\n'));
  console.log(`\n  ${passed} passati, ${failed} falliti\n`);
  chrome.kill();
  process.exit(failed ? 1 : 0);
}
