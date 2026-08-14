# qcolortrasfer v2.6 — DECIMEN + AUX REPAIR

La v2.6 aggiunge una variante separata del trasmettitore Decimen-style:

- `CLASSIC · solo QR principale`
- `CLASSIC + AUX REPAIR · QR helper`

Il QR principale resta il normale flusso QCT2/fountain della modalità Classic. Il secondo QR è volutamente più piccolo e usa il protocollo QAR1.

## QAR1

Il helper non ripete semplicemente metadati: porta informazione sorgente indipendente.

Ogni source block fountain viene diviso in stripe sistematiche da 512 byte. QAR1 trasporta:

- sessione AUX;
- geometria fountain (`sourceCount`, `chunkSize`, `containerLength`);
- indice del source block;
- indice/numero delle stripe;
- CRC32 dell'intero source block;
- payload della stripe;
- CRC32 del pacchetto QAR1.

Quando tutte le stripe di un blocco sono state ricevute, il blocco viene ricostruito e verificato. Se esiste un decoder fountain attivo con la stessa geometria, il blocco viene iniettato direttamente nel peeling decoder tramite `injectSourceBlock()`.

Questo può risolvere immediatamente altre equazioni già pendenti: la telemetria RX mostra `injected` e `peeling +N`.

## Geometria ottica

Il helper usa:

- QR B/N;
- ECC M;
- mask 4;
- quiet zone 4;
- raster e scaling interi/pixel-exact;
- frequenza helper circa metà della frequenza del main, limitata a 8–24 fps.

Il layout riserva lo spazio normalmente inutilizzato sotto al main QR in portrait e a destra in landscape. La riserva entra nel calcolo del budget del Classic: il QR principale viene quindi ricalcolato, non stirato via CSS.

## Ricezione

`qr-worker.js` distingue QCT1/QCT2 da QAR1. I QAR1 vengono restituiti in `auxSymbols`, separati dai normali `symbols`, quindi il parser QCT esistente non viene modificato.

Il tracker v2.5 può acquisire e seguire anche il piccolo helper. Il percorso tracked/pure resta disponibile anche per QAR1.

## Licenza/provenienza

QAR1, la stripe assembler e l'iniezione sistematica nel peeling decoder sono implementazioni originali qcolortrasfer/MIT.

La documentazione dei third-party credits è stata aggiornata per attribuire esplicitamente a Decimen >=0.4 l'ispirazione architetturale della pipeline tracked, mantenendo la separazione netta dal codice AGPL: nessun sorgente `decimen-codec` o altro codice AGPL è incorporato.
