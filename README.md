# qcolortrasfer

PWA open source per trasferire file direttamente dallo schermo di un dispositivo alla fotocamera di un altro, senza Wi‑Fi, Bluetooth, account o backend per i dati del file.

## Stato attuale: multi-QR baseline

La versione 1.2 usa QR standard bianco/nero come canale ottico affidabile e concentra più QR indipendenti nello stesso fotogramma. Il colore resta il passo successivo: prima fissiamo una baseline multi-QR realmente robusta su dispositivi diversi.

```text
FILE → SHA-256/QCT1 → blocchi 512 B → LT robust-soliton → 1/2/4/6 QR → CAMERA → ZXing multi-QR → LT peeling → SHA-256 → FILE
```

### Griglia adattiva
AUTO sceglie la griglia più densa tra 1, 2, 4 e 6 QR mantenendo circa 150 CSS px per codice. Sei QR diventano 3×2 in orizzontale e 2×3 in verticale. Ogni posizione cambia a fasi sfalsate. Con 6 QR a 3 fps/QR il display può mostrare fino a 18 nuovi simboli fountain al secondo.

### Perdita di frame
La v1.2 sostituisce il precedente LT sperimentale con il robust-soliton LT di Decimen Optical Transfer v0.3.0 (MIT), adattato al QCT1 streamId. I frame possono arrivare in qualunque ordine; i mancanti rallentano soltanto la ricezione e le riletture vengono deduplicate. La barra di avanzamento usa i simboli distinti raccolti; il peeling può restare basso e crescere rapidamente verso la fine.

### Ricevitore
Due Web Worker eseguono zxing-wasm/ZXing-C++ sull'intero frame e cercano fino a 8 QR contemporaneamente. La diagnostica mostra QR distinti, duplicati, QR letti, frame camera, frame saltati, pacchetti rifiutati e stato peeling.

## GitHub Pages
`https://alessandrogabe.github.io/qcolortrasfer/`

## Test
`npm test` e `npm run check` coprono vettori deterministici del fountain, perdita simulata del 30%, frame fuori ordine, duplicati e scelta automatica della griglia.

## Licenza
qcolortrasfer è MIT. Il fountain robust-soliton è adattato da Decimen Optical Transfer v0.3.0, MIT, Copyright (c) 2026 Evan Crawley (Bash Alarmist). Le release Decimen successive AGPL non vengono incorporate. Vedi `THIRD_PARTY_NOTICES.md`.
