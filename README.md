# qcolortrasfer

PWA open source MIT per trasferire file direttamente dallo schermo di un dispositivo alla fotocamera di un altro, senza Wi‑Fi, Bluetooth, account o backend dati.

## v1.4 beta: payload maggiore + terzo canale ottico

La baseline affidabile resta un QR standard letto da ZXing. qcolortrasfer sovrappone informazioni cromatiche ai soli moduli dati/ECC, lasciando finder/timing/alignment e moduli funzione in bianco/nero puro.

- **4 stati / 2 canali (stabile):** luminanza + 1 bit cromatico = 2 QR logici nello stesso quadrato.
- **8 stati / 3 canali (sperimentale):** luminanza + 2 assi cromatici = 3 QR logici nello stesso quadrato.
- Ogni canale cromatico viene ricostruito come un vero QR e passato nuovamente a ZXing, quindi conserva ECC QR.
- Payload selezionabile: **512 / 768 / 1024 / 1280 byte** per simbolo fountain; default 1024 B.
- Velocità: **3 / 5 / 8 / 12 / 20 fps per QR**.
- Griglia: 1 / 2 / 4 / 6 QR. AUTO riduce la densità nei profili 12/20 fps più pesanti; la scelta manuale è sempre rispettata.

```text
FILE → SHA-256/QCT1 → LT robust-soliton → QR base + C1 [+ C2] → CAMERA
     → ZXing base → rettifica cromatica → ZXing C1/C2 → LT peeling → SHA-256 → FILE
```

## Ricezione e diagnostica

La diagnostica separa base, C1 e C2, mostra separazione cromatica, simboli distinti/duplicati, frame saltati e goodput fountain in KiB/s. A completamento viene mostrato anche il goodput effettivo del file. La finalizzazione è atomica: SHA-256, download e log `RX completo` vengono eseguiti una sola volta anche con più worker ancora in volo.

## Fountain

Il robust-soliton LT è adattato da Decimen Optical Transfer v0.3.0 (MIT), con attribuzione a Evan Crawley / Bash Alarmist. I frame possono mancare, arrivare fuori ordine o essere riletti: la perdita rallenta il trasferimento ma non crea un “frame obbligatorio” mancante.

## GitHub Pages

`https://alessandrogabe.github.io/qcolortrasfer/`

## Licenza

qcolortrasfer è MIT. Vedi `THIRD_PARTY_NOTICES.md` per Decimen, qrcode, zxing-wasm e ZXing-C++.
