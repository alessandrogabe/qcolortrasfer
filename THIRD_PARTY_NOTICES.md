# Third-party notices

qcolortrasfer è distribuito sotto licenza MIT. Le seguenti opere hanno influenzato o sono usate dalla pipeline ottica.

## Decimen Optical Transfer v0.3.0
Repository: https://github.com/bashalarmistalt/decimen-optical-transfer

MIT License — Copyright (c) 2026 Evan Crawley (Bash Alarmist).

qcolortrasfer adotta deliberatamente dalla release MIT v0.3.0 i principi di QR standard, fountain stream, acquisizione camera e decodifica ZXing-WASM in worker. Il robust-soliton LT di qcolortrasfer è adattato da quella release, con attribuzione.

## Decimen Optical Transfer >= v0.4.0

Le release Decimen >= v0.4.0 e il progetto `decimen-codec` sono AGPL-3.0-or-later. qcolortrasfer può citarne benchmark pubblici e studiarne comportamento e architettura a livello concettuale, ma **nessun sorgente AGPL viene copiato, tradotto, adattato o incorporato** nel progetto MIT.

La v2 di qcolortrasfer reimplementa indipendentemente principi generali di ricezione/trasmissione ottica ad alto throughput — QR densi, mask fissata, lookahead, repaint sfalsati, full-frame acquisition, ROI/crop e worker pool — usando codice originale qcolortrasfer.

La pipeline tracked-decoding introdotta nella v2.5 e raffinata nella v2.8 è un'implementazione indipendente ispirata dall'analisi dell'architettura e del comportamento pubblicamente osservabili di Decimen >=0.4. La v2.8 accredita in particolare come ispirazione concettuale: persistenza e riuso della geometria, riallineamento economico sui finder prima del campionamento completo, soglie luminanza locali, uso degli alignment pattern per tollerare distorsione ottica, aggiornamento della geometria a ogni tracked hit, fallback sul decoder ordinario dello stesso crop, priorità dei full scan di recupero, drop dei frame quando il pool è saturo e richiesta capability-gated dell'autofocus continuo.

**Nessun codice `decimen-codec`, `readTracked` o altro sorgente AGPL di Decimen >=0.4 è copiato, tradotto, adattato o incorporato.** Gli algoritmi JS di riallineamento, soglia locale, compensazione geometrica, scheduler e telemetria di qcolortrasfer sono codice originale MIT e usano le API pubbliche di ZXing-WASM/ZXing-C++.

Sono inoltre implementazioni originali qcolortrasfer/MIT:

- QCT2, il frame ottico compatto da 24 byte + CRC32;
- QCF2, il container fountain-protected per nome file, SHA-256 e contenuto;
- QAR1 / AUX Repair, il side-channel sistematico a stripe introdotto nella v2.6;
- QAR2, il mini-fountain GF(2) a equazioni da 256 byte introdotto nella v2.8 per rendere il repair channel tollerante alla perdita;
- il pool di Web Worker per la generazione dei raster TX;
- la policy AUTO 4/6 e la policy AUX AUTO basate sulla densità fisica display/raster;
- il tracker RX ROI e la relativa logica acquisition/degraded/locked;
- il sampler prospettico tracked e il detector bypass;
- la modulazione dual-QR a 4 stati;
- la ricostruzione del QR cromatico C1 dalla geometria del QR base;
- il profilo sperimentale 8 stati / 3 canali;
- MAIN COLOR, in cui la luminanza resta un QR standard valido e un bit fountain aggiuntivo è modulato cromaticamente nelle stesse celle;
- OPTICAL MODEM v3.2, inclusi formato 192×108, fiducial SYNC, detector dedicato, calibrazione colore per frame, header di controllo, classificatore cromatico, interleaving/FEC e pipeline RX/TX dedicata.

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

Riferimento concettuale per codici ottici a colori. In particolare, durante la progettazione di OPTICAL MODEM v3.2 sono stati studiati a livello architetturale i concetti generali di griglia di tile/celle cromatiche, protezione FEC, interleaving e combinazione con un fountain code. **Nessun sorgente MPL-2.0 di libcimbar è copiato, tradotto, adattato o incorporato** nel motore qcolortrasfer.

## Complementary Color Barcode / Optical Camera Communication research

La letteratura pubblica sui Complementary Color Barcode e sui sistemi Optical Camera Communication è stata usata come riferimento concettuale per l'impiego di simboli/pilot noti, stima del canale e calibrazione cromatica per-frame nelle comunicazioni display→camera.

OPTICAL MODEM implementa autonomamente tali principi con fiducial, sequenza SYNC e patch R/G/B/M proprie. Nessun sorgente di implementazioni di terzi è incorporato.

## ChromaCode

ChromaCode è stato studiato come ulteriore riferimento concettuale per la modulazione cromatica nelle comunicazioni screen-to-camera e per i relativi obiettivi di throughput.

La codifica, il formato frame, il detector, il FEC, la palette e il decoder di OPTICAL MODEM v3.2 sono implementazioni originali qcolortrasfer/MIT; nessun codice ChromaCode è copiato o adattato.
