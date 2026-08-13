# qcolortrasfer

PWA open source per trasferire file direttamente dallo schermo di un dispositivo alla fotocamera di un altro, senza Wi‑Fi, Bluetooth, account o backend per i dati del file.

## Stato attuale: multi-QR a 4 colori / 2 canali

La versione 1.3 mantiene il QR standard come canale ottico affidabile e aggiunge un secondo QR nello stesso quadrato tramite il colore.

```text
FILE → SHA-256/QCT1 → LT robust-soliton →
  [QR base: luminanza] + [QR secondario: crominanza]
  → 1/2/4/6 quadrati simultanei → CAMERA
  → ZXing base → rettifica cromatica → ZXing secondario
  → LT peeling → SHA-256 → FILE
```

### Quattro stati per modulo
I moduli dati usano quattro colori: due scuri e due chiari. La coppia scuro/chiaro conserva il bit QR standard; la scelta warm/cool aggiunge un secondo bit. Finder, timing, alignment e altri moduli riservati restano nero/bianco puro.

Il secondo bit non è un flusso grezzo: ricostruisce un secondo QR standard della stessa versione, ECC e mask. Il ricevitore usa la posizione trovata da ZXing per campionare il colore, ricostruisce la matrice binaria secondaria e la passa di nuovo a ZXing. Anche il canale cromatico beneficia quindi dell'ECC QR.

Se il canale colore non è leggibile, il QR base continua a funzionare: il sistema degrada alla velocità della v1.2 invece di perdere l'intero frame.

### Griglia adattiva
AUTO sceglie la griglia più densa tra 1, 2, 4 e 6 QR mantenendo circa 150 CSS px per codice. Sei QR diventano 3×2 in orizzontale e 2×3 in verticale. Ogni posizione cambia a fasi sfalsate.

Ogni quadrato porta 2 simboli fountain indipendenti. Con 6 QR a 3 fps/QR il limite teorico passa da 18 a 36 nuovi simboli fountain al secondo quando entrambi i canali vengono decodificati.

### Fountain e perdita di frame
Il robust-soliton LT è adattato da Decimen Optical Transfer v0.3.0 (MIT). I frame possono arrivare in qualunque ordine; quelli mancanti rallentano soltanto la ricezione e le riletture vengono deduplicate.

### Diagnostica ricevitore
La UI mostra separatamente:
- simboli fountain distinti e duplicati;
- QR base decodificati;
- QR colore ricostruiti / candidati;
- separazione cromatica stimata;
- frame camera e frame saltati;
- peeling LT e target stimato.

## GitHub Pages
`https://alessandrogabe.github.io/qcolortrasfer/`

## Test
`npm test` e `npm run check` coprono fountain, perdita simulata, frame fuori ordine, duplicati, griglia adattiva e proprietà della palette a 4 stati. Il canale fisico colore richiede comunque prova reale display→camera.

## Licenza
qcolortrasfer è MIT. Il fountain robust-soliton è adattato da Decimen Optical Transfer v0.3.0, MIT, Copyright (c) 2026 Evan Crawley (Bash Alarmist). Le release Decimen successive AGPL non vengono incorporate. Vedi `THIRD_PARTY_NOTICES.md`.
