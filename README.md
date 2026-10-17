# Xpress

PWA per agenti di vendita derivata da [CSVXpressSmart](https://github.com/pezzaliapp/CSVXpressSmart):
stessa logica e stesse funzioni (sconti, margini, trasporto/installazione, modalità Smart,
report TXT/WhatsApp), **più il listino PDF con le immagini degli articoli**.

## Novità rispetto a CSVXpressSmart: listino PDF con immagini

- Si carica il listino PDF (es. il listino Cormach) accanto al listino CSV/Excel.
- Il PDF viene letto **nel browser** con PDF.js e indicizzato: per ogni codice articolo
  l'app trova la pagina e ritaglia la foto del prodotto.
- La miniatura compare **accanto al codice** nella tabella articoli e nell'anteprima
  dell'articolo selezionato; toccandola si apre l'immagine grande e la pagina intera.
- Nuovi pulsanti **"Stampa / PDF con immagini"** e **"Stampa (No Marg.)"**: stesso testo dei
  report TXT, con la foto a fianco di ogni articolo (dal dialogo di stampa si può salvare in PDF).
- I codici si riconoscono anche se Excel ha tolto gli zeri iniziali (1100313 = 01100313);
  se il CSV ha la colonna *Pagine*, quella pagina ha la precedenza.
- **Riservatezza**: il PDF non viene mai inviato a nessun server. Resta nella memoria locale
  (IndexedDB) di quel dispositivo, insieme all'indice e alle miniature, e si rimuove con
  "Rimuovi listino PDF" o togliendo la spunta "Ricorda il listino PDF". Il `.gitignore`
  esclude PDF/CSV/Excel perché nessun listino finisca nel repository.

Report WhatsApp e TXT restano solo testo (come nell'originale): le immagini sono nella stampa.

## Caratteristiche

- **Import CSV o Excel** (.csv, .xlsx, .xlsm, .xls)
- Riconoscimento intelligente colonne (italiano/inglese, varianti case-insensitive)
- Calcolo prezzo netto, margine percentuale, sconto equivalente cliente
- Trasporto e installazione opzionali
- Memoria locale (IndexedDB): l'ultimo listino caricato resta disponibile
- Export report TXT e WhatsApp
- **Offline-first**: funziona senza connessione dopo il primo caricamento
- **Privacy first**: nessun account, nessun tracker, nessuna telemetria, nessuna richiesta
  a servizi esterni. Listini e preventivi restano sul dispositivo

## Pubblicazione su Cloudflare Pages

PWA completamente statica: nessun build, nessun npm, nessun Worker o Function.

1. Genera/usa uno ZIP del progetto (index.html alla radice dello ZIP)
2. Cloudflare Pages → Create project → **Direct Upload** → trascina lo ZIP

Il file `_headers` applica CSP, header di sicurezza e le regole di cache
(`service-worker.js` e `index.html` sempre rivalidati, `vendor/` e `icon/` a cache lunga).

Ad ogni nuova pubblicazione ricordarsi di:
1. incrementare `CACHE_VERSION` in `service-worker.js`
2. incrementare `data-ver` in `index.html`

Così il service worker installa la nuova shell, elimina le cache vecchie e la pagina
si aggiorna da sola.

## Test

Richiedono Google Chrome installato e un server statico locale:

```bash
python3 -m http.server 8899 --bind 127.0.0.1   # oppure: node tests/serve-with-headers.mjs 8898
node tests/logic.test.js       # calcoli, report, export, parsing
node tests/browser.test.mjs    # end-to-end in Chrome headless (import, TXT, offline, responsive)
node tests/update.test.mjs     # aggiornamento PWA e pulizia cache
```


## Colonne supportate

Campi obbligatori:
- **Codice** (alias: code, codiceArt, codArticolo, id)
- **Prezzo** (alias: prezzo, prezzoLordo, prezzo_EUR, price, importo, listino)

Campi opzionali:
- **Descrizione** (alias: description, desc, articolo)
- **CostoTrasporto** (alias: trasporto, shipping, spedizione)
- **CostoInstallazione** (alias: installazione, installation, montaggio)
- **Famiglia, Categoria, Pagine** (preparati per futuri filtri)

Tutti i nomi sono riconosciuti **senza maiuscole/minuscole** e con o senza spazi.

## Licenza

MIT — vedi [LICENSE](LICENSE).

## Autore

Alessandro Pezzali — https://www.alessandropezzali.it
