// service-worker.js
// Xpress — Service Worker
// PWA statica: nessuna richiesta a servizi esterni, tutto same-origin.
// Versione: bumpare SEMPRE quando cambiano gli asset.
const CACHE_VERSION = 'v2.0.0';
const CACHE_NAME = `xpress-${CACHE_VERSION}`;

// Asset locali da cacheare (app shell)
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './style.mobile.cards.rev.v3.css',
  './xpress.css',
  './app.js',
  './pdf-listino.js',
  './manifest.json',
  './icon/CSVXpressSmart-192.png',
  './icon/CSVXpressSmart-512.png',
  './icon/CSVXpressSmart-1024.png',
  './vendor/papaparse.min.js',
  './vendor/xlsx.full.min.js',
  './vendor/pdfjs/pdf.min.js',
  './vendor/pdfjs/pdf.worker.min.js'
];

/* =========================
   INSTALL
   ========================= */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // addAll() fallirebbe TUTTO se un singolo file mancasse: qui ogni asset
    // viene messo in cache singolarmente, così l'installazione non si blocca.
    await Promise.all(APP_SHELL.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res && res.ok) await cache.put(url, res.clone());
        else console.warn('[SW] asset non cacheato:', url, res && res.status);
      } catch (err) {
        console.warn('[SW] asset non raggiungibile:', url, err);
      }
    }));

    await self.skipWaiting();
  })());
});

/* =========================
   ACTIVATE
   ========================= */
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // elimina tutte le cache delle versioni precedenti
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(name => name.startsWith('xpress-') && name !== CACHE_NAME)
        .map(name => caches.delete(name))
    );

    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (_) {}
    }

    await self.clients.claim();
  })());
});

/* =========================
   FETCH
   ========================= */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Ignora tutto ciò che non è http/https (es. estensioni del browser)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // NAVIGAZIONI / HTML: network-first, così un aggiornamento pubblicato
  // viene visto subito; offline si ricade sull'index in cache.
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(navigationHandler(event));
    return;
  }

  // Asset same-origin: cache-first (la cache è versionata, niente stallo)
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Qualsiasi altra origine: passa alla rete, senza cache e senza fallback.
  // (L'app non dipende da risorse esterne.)
});

/* =========================
   STRATEGIE
   ========================= */
function cacheable(response) {
  return response && response.ok && response.type === 'basic';
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (cacheable(response)) {
      const cache = await caches.open(CACHE_NAME);
      // clone PRIMA di restituire: il body si consuma una volta sola
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    // offline e non in cache: fallback all'app shell per le richieste HTML
    const fallback = await caches.match('./index.html');
    if (fallback && request.destination === 'document') return fallback;
    throw err;
  }
}

async function navigationHandler(event) {
  const request = event.request;
  const cache = await caches.open(CACHE_NAME);

  // navigation preload: se il browser ha già avviato la richiesta, la si usa
  try {
    const preload = await event.preloadResponse;
    if (preload) {
      if (cacheable(preload)) cache.put('./index.html', preload.clone()).catch(() => {});
      return preload;
    }
  } catch (_) { /* preload non disponibile o fallito: si prosegue con fetch */ }

  try {
    const response = await fetch(request);
    if (cacheable(response)) cache.put('./index.html', response.clone()).catch(() => {});
    return response;
  } catch (_) {
    const cached = await cache.match('./index.html') || await caches.match('./index.html');
    if (cached) return cached;

    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Xpress</title>' +
      '<p style="font-family:Arial,sans-serif;padding:2em">App non disponibile offline: ' +
      'apri Xpress una volta con la connessione attiva.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

/* =========================
   MESSAGGI DALLA PAGINA
   ========================= */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;

  // attivazione immediata del nuovo SW
  if (data.type === 'SKIP_WAITING') self.skipWaiting();

  // svuota completamente le cache (utile per reset manuale)
  if (data.type === 'CLEAR_CACHES') {
    event.waitUntil((async () => {
      const names = await caches.keys();
      await Promise.all(names.map(n => caches.delete(n)));
    })());
  }
});
