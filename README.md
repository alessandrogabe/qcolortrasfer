# qcolortrasfer

PWA open source MIT per trasferire file direttamente dallo schermo di un dispositivo alla fotocamera di un altro, senza Wi‑Fi, Bluetooth, account o backend dati.

## v1.5 beta: 4 stati ADAPTIVE

La baseline affidabile resta un QR standard letto da ZXing. qcolortrasfer sovrappone informazioni cromatiche ai soli moduli dati/ECC, lasciando finder/timing/alignment e moduli funzione in bianco/nero puro.

Modalità disponibili:

- **4 stati / 2 canali STABILE:** il profilo già verificato fisicamente. Luminanza + 1 bit cromatico = 2 QR logici nello stesso quadrato.
- **4 stati / 2 canali ADAPTIVE:** stesso identico encoding ottico del profilo stabile, ma con scheduler TX observation-aware. È il nuovo default.
- **8 stati / 3 canali EXP:** luminanza + 2 assi cromatici = 3 QR logici nello stesso quadrato. Resta disponibile per confronto sperimentale.

Ogni canale cromatico viene ricostruito come un vero QR e passato nuovamente a ZXing, quindi conserva ECC QR. Payload selezionabile: **512 / 768 / 1024 / 1280 byte** per simbolo fountain; default 1024 B. Target velocità: **3 / 5 / 8 / 12 / 20 fps per QR**. Griglia: 1 / 2 / 4 / 6 QR.

```text
FILE → SHA-256/QCT1 → LT robust-soliton → QR base + C1 [+ C2] → CAMERA
     → ZXing base → rettifica cromatica → ZXing C1/C2 → LT peeling → SHA-256 → FILE
```

## Come funziona ADAPTIVE

qcolortrasfer è un collegamento ottico **unidirezionale**: il trasmettitore non riceve telemetria dalla fotocamera remota. Il termine ADAPTIVE indica quindi adattamento lato trasmettitore, non un feedback channel nascosto.

Il problema che risolve è semplice: nella modalità tradizionale il tempo necessario a generare un QR molto denso può consumare parte della finestra durante la quale quel QR dovrebbe restare stabile sul display. ADAPTIVE separa le due cose:

1. il prossimo QR viene generato in background mentre il QR corrente resta visibile;
2. ogni posizione della griglia conserva un timestamp dell'ultimo repaint;
3. il nuovo QR viene dipinto soltanto quando quella specifica posizione ha rispettato il dwell minimo;
4. il dwell vale `max(1000/fps_target, 75 ms)`; 75 ms corrispondono a circa **2,25 frame di una camera da 30 fps**;
5. a 20 fps target ADAPTIVE non forza quindi la stessa cella a cambiare ogni 50 ms: il ceiling ottico è circa 13,3 fps/QR, mentre il costo reale di generazione può abbassarlo ulteriormente;
6. AUTO mantiene fino a 6 QR nel profilo ADAPTIVE fino a 12 fps target e passa a 4 QR a 20 fps. La griglia manuale resta sempre libera.

Questo scheduler non cambia QCT1, fountain code o decoder: un ricevitore vede semplicemente QR più stabili e non deve sapere se il trasmettitore sta usando STABILE o ADAPTIVE.

## Ricezione e diagnostica

La diagnostica separa base, C1 e C2, mostra separazione cromatica, simboli distinti/duplicati, frame saltati e goodput fountain in KiB/s. Sul TX vengono mostrati anche target fps, ceiling ottico ADAPTIVE e tempo medio di generazione QR. A completamento viene mostrato il goodput effettivo del file. La finalizzazione è atomica: SHA-256, download e log `RX completo` vengono eseguiti una sola volta anche con più worker ancora in volo.

## Fountain

Il robust-soliton LT è adattato da Decimen Optical Transfer v0.3.0 (MIT), con attribuzione a Evan Crawley / Bash Alarmist. I frame possono mancare, arrivare fuori ordine o essere riletti: la perdita rallenta il trasferimento ma non crea un “frame obbligatorio” mancante.

## Test

`npm test` / `npm run check` includono ora anche test deterministici dello scheduler ADAPTIVE: dwell a 5/8/20 fps, ceiling ottico, cap AUTO e deadline di repaint. Restano i test precedenti su fountain, perdita simulata, ordine arbitrario, duplicati, QCT1/CRC/SHA, griglia, palette 4/8 stati e PWA.

## GitHub Pages

`https://alessandrogabe.github.io/qcolortrasfer/`

## Licenza

qcolortrasfer è MIT. Vedi `THIRD_PARTY_NOTICES.md` per Decimen, qrcode, zxing-wasm e ZXing-C++.
