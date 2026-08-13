# qcolortrasfer

**PWA open source per trasferire file da uno schermo alla fotocamera di un altro dispositivo, senza backend.**

## Stato attuale: baseline QR affidabile

La prima matrice colore custom è stata rimossa dalla pipeline di riferimento perché i test reali su più dispositivi non producevano frame validi. La baseline attuale adotta deliberatamente l'approccio collaudato di **Decimen Optical Transfer v0.3.0 (MIT)** per il livello ottico:

- QR standard bianco/nero con quiet zone;
- ECC QR livello L;
- acquisizione dell'intero fotogramma camera;
- decodifica QR con **ZXing-C++ via zxing-wasm**;
- due Web Worker paralleli;
- se i worker sono occupati il frame viene perso senza ritrasmissione;
- il fountain code assorbe le perdite.

qcolortrasfer mantiene invece i propri layer `QCT1`, CRC32, SHA-256 e fountain LT-style sperimentale.

```text
FILE
  -> SHA-256
  -> chunk 320 B
  -> fountain symbols
  -> QCT1 + CRC32
  -> QR standard ECC L
  -> DISPLAY
  -> CAMERA full-frame
  -> ZXing-WASM workers
  -> QCT1 / CRC32
  -> fountain decoder
  -> SHA-256
  -> FILE
```

## Perché questa baseline

Decimen v0.3.0 usa `qrcode` per generare QR standard e `zxing-wasm`/ZXing-C++ per decodificarli nei worker. In questo modo localizzazione, prospettiva, finder, timing pattern ed error correction sono gestiti da una libreria QR matura anziché da un decoder geometrico custom.

Il colore verrà reintrodotto solo dopo aver misurato una baseline stabile su telefoni reali. L'obiettivo del progetto resta sperimentare un canale ottico multi-stato più veloce, ma senza reinventare le parti che il QR standard risolve già bene.

## Web app / PWA

URL GitHub Pages:

`https://alessandrogabe.github.io/qcolortrasfer/`

La web app non invia il contenuto del file a server. Per caricare il motore QR al primo utilizzo usa dipendenze statiche pubbliche (`esm.sh` e `jsDelivr`); il service worker prova a conservarle in cache per gli usi successivi.

## Prima prova

1. Apri la PWA su due dispositivi.
2. Sul trasmettitore scegli un file piccolo (10-100 KiB).
3. Parti da **3 fps**.
4. Sul ricevitore premi **CAMERA START** e inquadra il QR: non serve una guida di allineamento precisa.
5. La diagnostica distingue frame camera, QR realmente decodificati, pacchetti QCT1 rifiutati e simboli fountain utili.
6. A ricostruzione completata viene verificato SHA-256 prima di abilitare il download.

## Test

```bash
npm test
npm run check
```

## Licenza e provenienza

Il codice qcolortrasfer è MIT. La baseline ottica è ispirata/adattata dall'architettura di **Decimen Optical Transfer v0.3.0**, anch'essa MIT. Non viene incorporato codice delle versioni Decimen >= v0.4.0 (AGPL).

Le dipendenze runtime sono permissive ma non tutte MIT: `qrcode` è MIT; `zxing-wasm` è MIT e incorpora ZXing-C++ sotto Apache-2.0. Vedi `THIRD_PARTY_NOTICES.md`.
