# qcolortrasfer

PWA open source MIT per trasferire file direttamente dallo schermo di un dispositivo alla fotocamera di un altro, senza Wi‑Fi, Bluetooth, account o backend dati.

## v1.6 beta: RX ROI / crop tracking

La baseline affidabile resta un QR standard letto da ZXing. qcolortrasfer sovrappone informazioni cromatiche ai soli moduli dati/ECC, lasciando finder/timing/alignment e moduli funzione in bianco/nero puro.

Modalità TX disponibili:

- **4 stati / 2 canali STABILE — default:** profilo fisicamente verificato e, nei test reali del progetto, più veloce di ADAPTIVE.
- **4 stati / 2 canali ADAPTIVE:** stesso encoding ottico, scheduler TX con dwell minimo; resta disponibile come fallback sperimentale per coppie di dispositivi che ne beneficiano.
- **8 stati / 3 canali EXP:** luminanza + 2 assi cromatici = 3 QR logici nello stesso quadrato; resta sperimentale.

Payload selezionabile: **512 / 768 / 1024 / 1280 byte** per simbolo fountain; default 1024 B. Target TX: **3 / 5 / 8 / 12 / 20 fps per QR**. Griglia: 1 / 2 / 4 / 6 QR.

```text
FILE → SHA-256/QCT1 → LT robust-soliton → QR base + C1 [+ C2] → CAMERA
     → acquisizione full-frame → tracking ROI → crop paralleli
     → ZXing base + crominanza C1/C2 → LT peeling → SHA-256 → FILE
```

## Perché RX ROI

La versione precedente passava l'intero frame della fotocamera a ZXing quasi a ogni frame. Con più QR sullo schermo questo spreca gran parte del lavoro su pixel che non appartengono ad alcun codice.

La v1.6 separa **acquisizione** e **tracking**:

1. un full scan trova i QR QCT1 e restituisce le loro coordinate;
2. le coordinate vengono fuse in regioni persistenti con TTL breve;
3. nei frame successivi il main thread estrae piccoli crop attorno alle regioni note;
4. ogni regione può essere in-flight su un solo worker, così più worker non decodificano inutilmente lo stesso QR;
5. i crop vengono distribuiti su **2–4 worker** in base a `navigator.hardwareConcurrency`;
6. un full scan periodico riacquisisce QR mossi, nascosti o persi;
7. quando il numero di regioni scende sotto il massimo osservato, il full scan accelera temporaneamente;
8. i full scan saltano la ricostruzione cromatica per liberare prima il worker; C1/C2 vengono recuperati sui crop, che sono molto più piccoli.

Il tracker è una implementazione originale qcolortrasfer/MIT. Le release Decimen >=0.4 sono AGPL: nessun loro sorgente è copiato o adattato. L'idea generale di usare localizzazione + crop è trattata come principio architetturale, non come sorgente.

## Worker pool e camera

Il pool sceglie automaticamente:

- 2 worker fino a 5 CPU logiche;
- 3 worker da 6–7;
- 4 worker da 8 in su.

La camera prova prima **60 fps exact** con risoluzione ideale 1920×1080, poi ricade a 30 fps exact e infine a 60 fps ideal. Se il browser espone `focusMode=continuous`, viene richiesto il focus continuo. La UI mostra la modalità effettivamente ottenuta.

## Diagnostica RX

Oltre a base/C1/C2, simboli distinti/duplicati e goodput, la UI mostra:

- `ROI attive / picco`;
- `crop hit / crop inviati`;
- numero di full scan;
- worker occupati / worker totali;
- frame camera arrivati mentre tutti i worker erano saturi;
- stato del peeling fountain.

A completamento viene mostrato il goodput effettivo del file. La finalizzazione resta atomica: SHA-256, download e log `RX completo` vengono eseguiti una sola volta.

## Fountain

Il robust-soliton LT è adattato da Decimen Optical Transfer v0.3.0 (MIT), con attribuzione a Evan Crawley / Bash Alarmist. I frame possono mancare, arrivare fuori ordine o essere riletti: la perdita rallenta il trasferimento ma non crea un frame obbligatorio mancante.

## Test

`npm test` / `npm run check` includono i test precedenti e i nuovi test puri del tracker ROI: conversione coordinate ZXing→frame, matching/IoU, padding crop, deduplica regioni, scheduling full-scan acquisition/degraded/locked e dimensionamento 2–4 worker.

Il canale fisico display→camera richiede comunque una prova reale sui dispositivi: il benchmark importante resta il `KiB/s file` finale.

## GitHub Pages

`https://alessandrogabe.github.io/qcolortrasfer/`

## Licenza

qcolortrasfer è MIT. Vedi `THIRD_PARTY_NOTICES.md` per Decimen, qrcode, zxing-wasm e ZXing-C++.
