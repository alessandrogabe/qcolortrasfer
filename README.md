# qcolortrasfer

PWA open source MIT per trasferire file direttamente dallo schermo di un dispositivo alla fotocamera di un altro, senza Wi‑Fi, Bluetooth, account o backend dati.

## v2.1 UI: launcher INVIA / RICEVI

La v2.1 aggiunge una schermata iniziale separata dal motore ottico. All'avvio l'utente sceglie il ruolo del dispositivo con due azioni principali:

- **INVIA** apre il workspace TX high-throughput;
- **RICEVI** apre il workspace RX ROI/crop.

Il launcher usa un modulo dedicato `js/ui-shell.js`: non implementa protocollo, fountain, QR, camera o decoder. La logica tecnica resta in `app.js` e nei moduli v2. Quando una vista viene nascosta, `ui-shell.js` usa i normali controlli STOP già esistenti per non lasciare trasmissione o camera attive in background.

Le statistiche dettagliate non vengono semplificate: `txFrame`, `rxStats`, progress, stato, autotest, diagnostica e log restano disponibili nei workspace. La nuova UI cambia soltanto presentazione e navigazione.

## v2 beta: high-throughput QR + colore

La v2 riallinea l'architettura all'obiettivo principale del progetto: partire dal metodo QR/fountain ad alto throughput dimostrato da Decimen e **migliorarlo con un secondo QR logico nella crominanza**.

```text
FILE
 ↓
QCF2 container: nome + SHA-256 + bytes
 ↓
LT robust-soliton
 ↓
QCT2 compact frame
 ↓
┌───────────────────────────────┐
│ QR fisico                     │
│  luminanza = QR base          │
│  crominanza = QR C1           │
└───────────────────────────────┘
 × 4/6 codici fisici
 ↓
CAMERA 1280@60 target
 ↓
full acquisition → ROI/crop → ZXing base → C1 pure decode
 ↓
LT peeling → QCF2 → SHA-256 → FILE
```

### Trasmettitore

Il profilo principale è **4 stati / 2 canali HIGH THROUGHPUT**.

- QR standard byte-mode, ECC L, mask 4 fissata.
- Envelope massimo: **2953 byte per QR**.
- QCT2 usa un header di **24 byte** + CRC32 di 4 byte.
- Payload fountain massimo: **2925 byte per canale**.
- Ogni QR fisico porta quindi fino a **2925 B base + 2925 B colore**.
- Il file name e SHA-256 non vengono più ripetuti in ogni frame: sono nel container QCF2 protetto dal fountain.
- I raster QR vengono pre-generati in **2–4 Web Worker**.
- Lookahead = **3 raster per posizione**.
- I repaint sono sfalsati via `requestAnimationFrame`: ogni posizione aggiorna alla frequenza richiesta, ma le celle non cambiano tutte nello stesso istante.
- Target selezionabili: 8 / 12 / **24 default** / 30 / 60 fps per QR.

### AUTO 4/6 QR

La UI v2 espone soltanto **AUTO 4/6**, **4 QR** e **6 QR**. AUTO non scende a 2 QR.

La scelta usa dimensione viewport, DPR e dimensione reale del raster QR. Se una griglia 2×3 / 3×2 mantiene almeno circa 2,5 device-pixel per cella raster, vengono mostrati 6 QR; altrimenti 4 QR più grandi.

Le primitive interne per layout più piccoli restano soltanto per retrocompatibilità e test, non come modalità produttiva della v2.

### Ricevitore

La v2 mantiene il tracker ROI introdotto in v1.6 e lo rende più vicino al profilo high-throughput:

- camera ideale **1280×960 @ 60 fps exact**, fallback 30 fps;
- **2–6 worker RX**, usando fino ai core logici disponibili;
- full scan rapido per acquisizione e recupero;
- regioni con TTL breve;
- full scan rallentato quando la griglia è completa e accelerato se manca un QR;
- crop con padding più largo per assorbire movimento mano/camera;
- sui crop ZXing disabilita `tryHarder`, rotazioni, inversione e downscale;
- i full scan possono usare anche le posizioni di rilevamenti non decodificati come regioni probationary, senza lasciare che spostino una ROI già confermata;
- il layer C1 riusa la geometria ottenuta dal QR base;
- il QR cromatico sintetico viene passato a ZXing con `isPure=true`, `FixedThreshold` e senza seconda ricerca del finder.

## Compatibilità

Il trasmettitore v2 usa QCT2. Il ricevitore continua a leggere **QCT1**, quindi i flussi v1.x non vengono resi illeggibili.

QCT2 porta la metadata del file in QCF2, ma il fountain wire model resta lo stesso: simboli indipendenti, fuori ordine, duplicabili e perdibili.

## Prestazioni

Il tetto nominale del profilo default `2925 B × 24 fps × 4 QR × 2 canali` è circa **548 KiB/s fountain**. Con 6 QR supera 820 KiB/s nominali. Sono valori di capacità del trasmettitore, non promesse di goodput: il limite reale è la percentuale di simboli che camera, ZXing, C1 e CPU riescono a recuperare.

Il benchmark da inseguire è il goodput reale `KiB/s file`. Il riferimento pubblico di Decimen v0.4 ha dimostrato circa **199 KB/s phone→phone** con 2 QR B/N; qcolortrasfer mira a raggiungere prima quell'ordine di grandezza e poi superarlo sfruttando C1.

## Licenza e provenienza

qcolortrasfer è MIT.

Il robust-soliton LT è adattato direttamente da **Decimen Optical Transfer v0.3.0 MIT**, con attribuzione. Le release Decimen >=0.4 sono AGPL: il loro codice non viene copiato o adattato nella v2.

Principi architetturali generali osservabili nelle release successive — QR densi, mask fissata, lookahead, repaint sfalsati, ROI/crop e worker pool — sono reimplementati indipendentemente in qcolortrasfer/MIT. Il layer cromatico dual-QR, QCT2/QCF2, il TX raster worker pool e il tracker sono codice qcolortrasfer.

Vedi `THIRD_PARTY_NOTICES.md`.

## Test

La CI GitHub esegue ad ogni push/PR:

```text
npm test
npm run check
```

La suite copre QCT1/QCT2, QCF2, CRC, fountain, palette, AUTO 4/6, lookahead math, worker scaling, ROI, PWA, launcher UI e finalizzazione atomica. La validazione display→camera resta necessariamente fisica.

## GitHub Pages

`https://alessandrogabe.github.io/qcolortrasfer/`
