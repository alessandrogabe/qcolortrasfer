# Third-party notices

qcolortrasfer è distribuito sotto licenza MIT. Le seguenti opere hanno influenzato o sono usate dalla pipeline ottica.

## Decimen Optical Transfer v0.3.0
Repository: https://github.com/bashalarmistalt/decimen-optical-transfer

MIT License — Copyright (c) 2026 Evan Crawley (Bash Alarmist).

qcolortrasfer adotta deliberatamente dalla release MIT v0.3.0 i principi di QR standard, fountain stream, acquisizione camera e decodifica ZXing-WASM in worker. Il robust-soliton LT di qcolortrasfer è adattato da quella release, con attribuzione.

## Decimen Optical Transfer >= v0.4.0

Le release Decimen >= v0.4.0 sono AGPL-3.0-or-later. qcolortrasfer può citarne benchmark pubblici e studiarne il comportamento/architettura a livello concettuale, ma **nessun sorgente AGPL viene copiato, adattato o incorporato** nel progetto MIT.

La v2 di qcolortrasfer reimplementa indipendentemente principi generali di ricezione/trasmissione ottica ad alto throughput — QR densi, mask fissata, lookahead, repaint sfalsati, full-frame acquisition, ROI/crop e worker pool — usando codice originale qcolortrasfer.

La pipeline tracked-decoding introdotta in qcolortrasfer v2.5 è inoltre un'implementazione indipendente ispirata dall'analisi dell'architettura e del comportamento pubblicamente osservabili di Decimen >=0.4: persistenza della geometria del QR, crop predittivi, campionamento prospettico della griglia nota, percorso detector-free e cadence differenziata dei full scan. **Nessun codice `decimen-codec`, `readTracked` o altro sorgente AGPL di Decimen >=0.4 è copiato, tradotto, adattato o incorporato.** Il sampler tracked di qcolortrasfer è codice originale MIT e usa le API pubbliche di ZXing-WASM/ZXing-C++.

Sono inoltre implementazioni originali qcolortrasfer/MIT:

- QCT2, il frame ottico compatto da 24 byte + CRC32;
- QCF2, il container fountain-protected per nome file, SHA-256 e contenuto;
- QAR1 / AUX Repair, il side-channel sistematico a stripe introdotto nella v2.6;
- il pool di Web Worker per la generazione dei raster TX;
- la policy AUTO 4/6 basata su dimensione fisica del raster/display;
- il tracker RX ROI e la relativa logica acquisition/degraded/locked;
- il sampler prospettico tracked e il detector bypass v2.5;
- la modulazione dual-QR a 4 stati;
- la ricostruzione del QR cromatico C1 dalla geometria del QR base;
- il profilo sperimentale 8 stati / 3 canali.

## qrcode 1.5.4
Repository: https://github.com/soldair/node-qrcode
License: MIT.

Usato per generare i QR standard in byte mode. qcolortrasfer usa anche la matrice `reservedBit`/`isReserved` della versione fissata 1.5.4 per lasciare B/W puro il pattern funzionale del QR e sovrapporre crominanza soltanto sui moduli non riservati.

## zxing-wasm 2.0.0
Repository: https://github.com/Sec-ant/zxing-wasm
License wrapper: MIT.

Usato per eseguire ZXing in WebAssembly nel browser sul QR base, sui QR helper e sui QR cromatici ricostruiti. La v2 usa inoltre opzioni pubbliche di `ReaderOptions` quali `tryHarder`, `tryRotate`, `tryDownscale`, `returnErrors`, `isPure` e `binarizer` per separare la scansione full-frame dal percorso veloce sui crop.

### ZXing-C++
Repository: https://github.com/zxing-cpp/zxing-cpp
License: Apache License 2.0.

`zxing-wasm` incorpora ZXing-C++; pertanto la distribuzione/runtime include anche una dipendenza Apache-2.0. Apache-2.0 è permissiva e compatibile con un progetto MIT, ma non è una licenza MIT.

## libcimbar
Repository: https://github.com/sz3/libcimbar
License: MPL-2.0.

Riferimento concettuale per codici ottici a colori. Nessun sorgente MPL viene incorporato nel progetto MIT.
