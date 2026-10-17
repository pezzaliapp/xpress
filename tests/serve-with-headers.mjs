/* Server statico locale che applica le regole del file _headers, per verificare
   la configurazione Cloudflare Pages (CSP compresa) prima della pubblicazione.
   Uso: node tests/serve-with-headers.mjs [porta] [cartella]
   Non fa parte dell'app pubblicata. */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] || 8898);
const ROOT = path.resolve(process.argv[3] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

/* --- parsing minimale di _headers (sintassi Cloudflare Pages) --- */
function parseHeaders(file) {
  if (!fs.existsSync(file)) return [];
  const regole = [];
  let corrente = null;
  for (const rigaRaw of fs.readFileSync(file, 'utf8').split('\n')) {
    const riga = rigaRaw.replace(/\r$/, '');
    if (!riga.trim() || riga.trim().startsWith('#')) continue;
    if (!/^\s/.test(riga)) {
      corrente = { pattern: riga.trim(), headers: [] };
      regole.push(corrente);
    } else if (corrente) {
      const i = riga.indexOf(':');
      if (i > 0) corrente.headers.push([riga.slice(0, i).trim(), riga.slice(i + 1).trim()]);
    }
  }
  return regole;
}

const REGOLE = parseHeaders(path.join(ROOT, '_headers'));

function combacia(pattern, pathname) {
  if (pattern === pathname) return true;
  if (pattern.endsWith('/*')) return pathname.startsWith(pattern.slice(0, -1));
  if (pattern === '/*') return true;
  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  let file = path.join(ROOT, pathname);

  if (pathname.endsWith('/')) file = path.join(file, 'index.html');
  if (!path.resolve(file).startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end('not found'); return; }

  const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' };
  for (const r of REGOLE) {
    if (combacia(r.pattern, pathname)) for (const [k, v] of r.headers) headers[k] = v;
  }

  res.writeHead(200, headers);
  res.end(fs.readFileSync(file));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`server con _headers attivo su http://127.0.0.1:${PORT} (root: ${ROOT})`);
  console.log(`regole caricate: ${REGOLE.length}`);
});
