/* ===========================
   Xpress — welcome.js
   1) Recupero automatico da CSVXpressSmart (stesso dominio):
      se in Xpress non c'è ancora un listino, si copia quello salvato da
      CSVXpressSmart su questo dispositivo, insieme alle impostazioni.
      Tutto avviene in locale: nessun dato lascia il dispositivo.
   2) Messaggio di benvenuto alla prima apertura.
   Deve essere caricato DOPO app.js (usa le sue funzioni globali).
   =========================== */

(function () {
  'use strict';

  const OLD_DB = 'csvxpresssmart_db_v1';
  const OLD_STORE = 'kv';
  const OLD_CSV_KEY = 'last_csv_payload';
  const WELCOME_KEY = 'xpress_welcome_seen_v1';
  const MIGRATED_KEY = 'xpress_migrated_from_csvx_v1';

  // ---- impostazioni (sincrono: prima che app.js le legga al DOMContentLoaded) ----
  try {
    const pairs = [
      ['csvxpresssmart_settings_v1', 'xpress_settings_v1'],
      ['csvxpresssmart_remember_csv_v1', 'xpress_remember_csv_v1']
    ];
    pairs.forEach(([from, to]) => {
      if (localStorage.getItem(to) === null) {
        const v = localStorage.getItem(from);
        if (v !== null) localStorage.setItem(to, v);
      }
    });
  } catch (_) { /* storage non disponibile */ }

  // Apre il DB di CSVXpressSmart SOLO se esiste già (non ne crea uno vuoto)
  function readOldCsvPayload() {
    return new Promise((resolve) => {
      try {
        if (!window.indexedDB) return resolve(null);
        const req = indexedDB.open(OLD_DB);
        req.onupgradeneeded = (e) => {
          // il DB non esisteva: annulla la creazione
          if (e.oldVersion === 0) { try { req.transaction.abort(); } catch (_) {} }
        };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
        req.onsuccess = () => {
          const db = req.result;
          try {
            if (!db.objectStoreNames.contains(OLD_STORE)) { db.close(); return resolve(null); }
            const tx = db.transaction(OLD_STORE, 'readonly');
            const g = tx.objectStore(OLD_STORE).get(OLD_CSV_KEY);
            g.onsuccess = () => { const v = g.result; db.close(); resolve(v || null); };
            g.onerror = () => { db.close(); resolve(null); };
          } catch (_) { try { db.close(); } catch (__) {} resolve(null); }
        };
      } catch (_) { resolve(null); }
    });
  }

  async function migrateCsv() {
    try {
      if (localStorage.getItem(MIGRATED_KEY)) return null;
    } catch (_) {}

    try {
      if (typeof loadLastCsvPayload !== 'function' || typeof idbSet !== 'function') return null;
      const current = await loadLastCsvPayload();
      if (current && current.listino && current.listino.length) {
        try { localStorage.setItem(MIGRATED_KEY, 'skip'); } catch (_) {}
        return null; // Xpress ha già un suo listino
      }

      const old = await readOldCsvPayload();
      if (!old || !Array.isArray(old.listino) || !old.listino.length) return null;

      const payload = { ...old, meta: { ...(old.meta || {}), from: 'CSVXpressSmart' } };
      await idbSet(CSV_KEY, payload);
      try { localStorage.setItem(MIGRATED_KEY, String(Date.now())); } catch (_) {}

      // mostra subito il listino recuperato (stesse funzioni dell'app)
      if (typeof listino !== 'undefined' && !listino.length) {
        listino = payload.listino;
        if (typeof aggiornaListinoSelect === 'function') aggiornaListinoSelect();
      }
      if (typeof updateSavedCsvInfoUI === 'function') updateSavedCsvInfoUI(payload);
      return payload;
    } catch (e) {
      console.warn('[Xpress] recupero listino da CSVXpressSmart non riuscito', e);
      return null;
    }
  }

  // ---- messaggio di benvenuto ----
  function showWelcome(migrated) {
    try { if (localStorage.getItem(WELCOME_KEY)) return; } catch (_) {}

    const wrap = document.createElement('div');
    wrap.className = 'xp-welcome';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'xpWelcomeTitle');

    const box = document.createElement('div');
    box.className = 'xp-welcome-box';

    const h = document.createElement('h2');
    h.id = 'xpWelcomeTitle';
    h.textContent = 'Benvenuto in Xpress';

    const p1 = document.createElement('p');
    p1.textContent = 'Xpress è la nuova versione di CSVXpressSmart: trovi tutto quello che già usi, ' +
      'cioè sconti, margini, trasporto e installazione, modalità Smart e report WhatsApp e TXT.';

    const p2 = document.createElement('p');
    p2.innerHTML = '<strong>La novità:</strong> carica anche il <strong>listino PDF</strong>. ' +
      'Accanto a ogni codice comparirà la foto dell’articolo, e potrai stampare o salvare in PDF ' +
      'il preventivo con le immagini.';

    box.appendChild(h);
    box.appendChild(p1);
    box.appendChild(p2);

    if (migrated) {
      const p3 = document.createElement('p');
      p3.className = 'xp-welcome-ok';
      const name = migrated.meta && migrated.meta.name ? `“${migrated.meta.name}” ` : '';
      p3.textContent = `✓ Abbiamo ritrovato il listino ${name}che usavi in CSVXpressSmart: è già pronto, non devi ricaricarlo.`;
      box.appendChild(p3);
    }

    const p4 = document.createElement('p');
    p4.className = 'xp-welcome-small';
    p4.textContent = 'Come sempre, listini e preventivi restano solo su questo dispositivo.';
    box.appendChild(p4);

    const actions = document.createElement('div');
    actions.className = 'xp-welcome-actions';

    const close = () => {
      try { localStorage.setItem(WELCOME_KEY, String(Date.now())); } catch (_) {}
      wrap.remove();
      document.body.classList.remove('xp-noscroll');
    };

    const bPdf = document.createElement('button');
    bPdf.type = 'button';
    bPdf.textContent = 'Carica il listino PDF';
    bPdf.addEventListener('click', () => {
      close();
      const sec = document.getElementById('pdf-section');
      if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const input = document.getElementById('pdfFileInput');
      if (input) { try { input.click(); } catch (_) {} }
    });

    const bGo = document.createElement('button');
    bGo.type = 'button';
    bGo.className = 'xp-welcome-secondary';
    bGo.textContent = 'Inizia';
    bGo.addEventListener('click', close);

    actions.appendChild(bPdf);
    actions.appendChild(bGo);
    box.appendChild(actions);
    wrap.appendChild(box);
    document.body.appendChild(wrap);
    document.body.classList.add('xp-noscroll');
  }

  async function start() {
    const migrated = await migrateCsv();
    showWelcome(migrated);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
