# Third-party notices

qcolortrasfer è distribuito sotto licenza MIT. Le seguenti opere hanno influenzato o sono usate dalla baseline ottica.

## Decimen Optical Transfer v0.3.0
Repository: https://github.com/bashalarmistalt/decimen-optical-transfer

MIT License — Copyright (c) 2026 Evan Crawley (Bash Alarmist).

La baseline qcolortrasfer v1.1 adotta deliberatamente l'architettura ottica usata da Decimen v0.3.0: QR standard, fountain stream, acquisizione camera full-frame e decodifica ZXing-WASM in worker. Le release Decimen >= v0.4.0 sono AGPL e non sono sorgente per questa baseline MIT.

## qrcode 1.5.4
Repository: https://github.com/soldair/node-qrcode
License: MIT.

Usato per generare QR standard in byte mode.

## zxing-wasm 2.0.0
Repository: https://github.com/Sec-ant/zxing-wasm
License wrapper: MIT.

Usato per eseguire il decoder ZXing in WebAssembly nel browser.

### ZXing-C++
Repository: https://github.com/zxing-cpp/zxing-cpp
License: Apache License 2.0.

`zxing-wasm` incorpora ZXing-C++; pertanto la distribuzione/runtime include anche una dipendenza Apache-2.0. Apache-2.0 è permissiva e compatibile con un progetto MIT, ma non è una licenza MIT.

## libcimbar
Repository: https://github.com/sz3/libcimbar
License: MPL-2.0.

Riferimento concettuale per futuri esperimenti su codici ottici a colori. Nessun sorgente MPL viene incorporato nella baseline MIT.
