# Third-party notices

qcolortrasfer è distribuito sotto licenza MIT. Le seguenti opere hanno influenzato o sono usate dalla pipeline ottica.

## Decimen Optical Transfer v0.3.0
Repository: https://github.com/bashalarmistalt/decimen-optical-transfer

MIT License — Copyright (c) 2026 Evan Crawley (Bash Alarmist).

qcolortrasfer adotta deliberatamente dalla release MIT v0.3.0 i principi di QR standard, fountain stream, acquisizione camera e decodifica ZXing-WASM in worker. Il robust-soliton LT di qcolortrasfer è adattato da quella release.

Le release Decimen >= v0.4.0 sono AGPL. Possono essere citate nella documentazione per benchmark pubblici o per confrontare principi architetturali generali, ma **nessun loro sorgente viene copiato o adattato** nel progetto MIT. Il tracker ROI/crop e il relativo scheduler di qcolortrasfer sono implementazioni originali di questo progetto.

La modulazione dual-QR a 4 colori, la ricostruzione dei QR da crominanza, la griglia qcolortrasfer e il tracker RX ROI sono estensioni qcolortrasfer.

## qrcode 1.5.4
Repository: https://github.com/soldair/node-qrcode
License: MIT.

Usato per generare i QR standard in byte mode. qcolortrasfer usa anche la matrice `reservedBit`/`isReserved` della versione fissata 1.5.4 per lasciare B/W puro il pattern funzionale del QR.

## zxing-wasm 2.0.0
Repository: https://github.com/Sec-ant/zxing-wasm
License wrapper: MIT.

Usato per eseguire il decoder ZXing in WebAssembly nel browser sia sul QR base acquisito dalla camera sia sui QR cromatici ricostruiti.

### ZXing-C++
Repository: https://github.com/zxing-cpp/zxing-cpp
License: Apache License 2.0.

`zxing-wasm` incorpora ZXing-C++; pertanto la distribuzione/runtime include anche una dipendenza Apache-2.0. Apache-2.0 è permissiva e compatibile con un progetto MIT, ma non è una licenza MIT.

## libcimbar
Repository: https://github.com/sz3/libcimbar
License: MPL-2.0.

Riferimento concettuale per codici ottici a colori. Nessun sorgente MPL viene incorporato nel progetto MIT.
