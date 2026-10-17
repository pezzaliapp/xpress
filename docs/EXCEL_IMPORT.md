# Import Excel — Note tecniche

## Libreria

SheetJS Community Edition v0.20.3 (`vendor/xlsx.full.min.js`, ~930 KB).
Servita localmente perché non più disponibile su cdnjs (rimossa dalla CDN nel 2023).

## Formati supportati

- `.xlsx` (Office Open XML, standard moderno)
- `.xlsm` (Excel con macro — le macro vengono ignorate, parsing solo dati)
- `.xls` (Excel 97-2003 binario)
- `.csv` (gestito ancora da PapaParse, parser dedicato per fluidità)

## Parsing

```javascript
const workbook = XLSX.read(arrayBuffer, { type: 'array' });
const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "", blankrows: false });
```

Solo il primo foglio viene letto (gli altri vengono ignorati).
`defval: ""` previene `undefined` su celle vuote.
`blankrows: false` salta righe completamente vuote.

## Validazione

In `normalizeListino()`:
- Una riga è valida se contiene **codice** + **prezzoLordo > 0**
- Descrizione mancante → "(senza descrizione)"
- Righe scartate vengono loggate in `lastNormalizeWarnings` e console.warn

## Service Worker

Quando si aggiorna `xlsx.full.min.js` o si bumpano file di app, ricordare di:
1. Incrementare `CACHE_VERSION` in `service-worker.js`
2. Verificare che il file sia incluso in `APP_SHELL`

Senza bump, gli utenti con PWA installata vedono la versione vecchia in cache.

## Privacy / Offline

Tutto il parsing avviene **client-side** dentro il browser dell'utente.
Nessun file viene mai inviato a server esterni.
Nessun tracker analytics riceve il contenuto dei file (solo metadati: nome, size, conteggio righe).
