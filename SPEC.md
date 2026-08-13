# qcolortrasfer specification

## Goal
PWA pubblica per trasferimento file screen-to-camera senza backend, tollerante alla perdita di frame e con fountain coding.

## Baseline optical architecture (v1.1)
La baseline affidabile usa QR standard invece della precedente matrice colore custom.

1. File: nome, dimensione, SHA-256.
2. Fountain: chunk sorgente da 320 byte + repair symbols deterministici.
3. Packet: QCT1, stream id, symbol id, metadati, CRC32.
4. Optical TX: QR standard, byte mode, ECC L, quiet zone 4 moduli, mask 4.
5. Camera RX: fotogramma intero, preferenza 1280 px / 30 fps.
6. Decode: pool di 2 Web Worker con ZXing-C++ tramite `zxing-wasm`.
7. Erasure handling: quando tutti i worker sono occupati il frame viene semplicemente scartato.
8. Reconstruction: fountain decoder + verifica SHA-256 finale.

## Design decision
Non implementare finder, omografia, timing o correzione di errori QR custom nella baseline. Questi compiti sono delegati a un decoder QR maturo. La precedente matrice 48x48 rimane una linea sperimentale, non la pipeline di riferimento.

## Color roadmap
Il colore verrà reintrodotto incrementalmente solo dopo una baseline B/N misurata:

- fase A: QR B/N standard, misurare decode rate e goodput;
- fase B: colorazione che preserva la luminanza/decodificabilità QR, senza payload extra;
- fase C: canale colore addizionale per modulo o regione con calibrazione;
- fase D: ECC dedicato del canale colore e soft decisions;
- fase E: confronto throughput/BER con QR B/N baseline.

Il QR B/N deve poter continuare a trasportare metadati/sincronizzazione anche quando il canale colore fallisce.

## Licensing constraint
- qcolortrasfer-owned code: MIT.
- Decimen source/architecture: solo riferimento o adattamenti dalla release v0.3.0 MIT.
- Nessun codice Decimen >= v0.4.0 AGPL.
- `qrcode`: MIT.
- `zxing-wasm`: MIT wrapper; ZXing-C++ incluso è Apache-2.0.
