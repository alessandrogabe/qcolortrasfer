# qcolortrasfer

**PWA open source per trasferire file direttamente da uno schermo alla fotocamera di un altro dispositivo.**

qcolortrasfer non usa Wi-Fi, Bluetooth, account, pairing o backend per i dati del file. Il trasmettitore converte il file in una sequenza potenzialmente illimitata di frame ottici a quattro colori; il ricevitore usa una fotocamera, scarta le letture corrotte con CRC32 e ricostruisce i blocchi mancanti tramite un fountain code LT-style originale.

> Stato: beta sperimentale. La pipeline software è testata automaticamente; il canale fisico display→camera dipende da fotocamera, display, distanza, messa a fuoco e illuminazione. Non usare qcolortrasfer come unica copia di dati importanti.

## Web app / PWA

Il progetto è completamente statico ed è progettato per GitHub Pages.

Dopo aver abilitato **Settings → Pages → Deploy from a branch → `main` / `(root)`**, l'URL standard del repository è:

`https://alessandrogabe.github.io/qcolortrasfer/`

GitHub Pages serve i siti `github.io` via HTTPS, requisito necessario per l'accesso alla fotocamera e per il service worker.

La PWA include manifest installabile, icone 192×192/512×512/Apple Touch, cache offline, nessuna dipendenza JavaScript esterna, nessun upload dei file, Content Security Policy, modalità standalone, schermo intero trasmettitore, wake lock quando supportato e autotest encode→render→decode nel browser.

## Protocollo v1

```text
FILE
  ↓
SHA-256 + metadati
  ↓
chunk sorgente da 320 byte
  ↓
fountain encoder LT-style
  ├─ simboli sistematici
  └─ simboli repair deterministici e illimitati
  ↓
header QCT1 + payload + CRC32
  ↓
matrice 48×48 · 4 colori = 2 bit/cella
  ↓
DISPLAY → CAMERA
  ↓
calibrazione colore per-frame → CRC32 → fountain peeling decoder
  ↓
SHA-256 finale → DOWNLOAD
```

Il decoder riduce ogni frame camera a 240×240 e usa una singola operazione `getImageData()`. I quattro riferimenti colore sono nello stesso frame dei dati.

## Prima prova consigliata

1. Apri qcolortrasfer su due dispositivi.
2. Scegli un file piccolo, ad esempio 10–100 KiB.
3. Imposta 5 o 8 fps e premi **START**.
4. Sul ricevitore premi **CAMERA START**.
5. Inquadra quasi frontalmente e regola **Area codice** finché il bordo coincide con la guida.
6. Al 100% qcolortrasfer verifica SHA-256 e abilita il download.

Se il ricevitore parte tardi, i repair symbols possono comunque ricostruire il file; **RIPARTI** riporta il trasmettitore ai simboli sistematici iniziali.

## Sviluppo locale

```bash
python -m http.server 8080
```

Poi apri `http://localhost:8080`.

## Test

```bash
npm test
npm run check
```

I test coprono fountain reconstruction, perdite, join tardivo, duplicati, determinismo, packet round-trip, CRC e struttura PWA.

## Architettura

- `js/fountain.js` — fountain encoder/decoder;
- `js/protocol.js` — packet QCT1 e integrità;
- `js/optical.js` — layout e modulazione ottica;
- `js/app.js` — UI, fotocamera e PWA runtime.

## Roadmap tecnica

Correzione prospettica/finder automatica, ECC locale, confronto 2/4/8 colori, colore+simbolo, più fountain symbols per frame, benchmark BER/fps/throughput ed eventuale Wirehair BSD-3-Clause via WASM.

## Licenza e attribuzioni

qcolortrasfer è MIT. Vedi [LICENSE](LICENSE) e [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Il progetto riconosce esplicitamente **Decimen Optical Transfer**, **libcimbar** e **Wirehair**; la baseline non incorpora sorgente AGPL di Decimen, MPL di libcimbar o Wirehair.
