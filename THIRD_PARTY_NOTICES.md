# Third-party notices

qcolortrasfer è distribuito sotto licenza MIT.

## Decimen Optical Transfer v0.3.0
Repository: https://github.com/bashalarmistalt/decimen-optical-transfer

MIT License — Copyright (c) 2026 Evan Crawley (Bash Alarmist).

qcolortrasfer usa come baseline l'architettura di acquisizione ottica resa pubblica in Decimen v0.3.0: QR standard, stream fountain, camera full-frame e ZXing-WASM in worker. Dalla v1.2 adatta inoltre il fountain LT robust-soliton di Decimen v0.3.0 (distribuzione robust-soliton, log deterministico, PRNG/subset selection e peeling decoder) al formato QCT1 e al suo streamId.

Il layout multi-QR di qcolortrasfer è implementato indipendentemente. Le release Decimen >= v0.4.0 sono AGPL e il loro sorgente non viene incorporato nei file MIT di qcolortrasfer.

## qrcode 1.5.4
Repository: https://github.com/soldair/node-qrcode — MIT. Usato per generare QR standard in byte mode.

## zxing-wasm 2.0.0
Repository: https://github.com/Sec-ant/zxing-wasm — wrapper MIT. Usato per eseguire ZXing in WebAssembly.

### ZXing-C++
Repository: https://github.com/zxing-cpp/zxing-cpp — Apache-2.0. Dipendenza transitiva di zxing-wasm.

## libcimbar
Repository: https://github.com/sz3/libcimbar — MPL-2.0. Riferimento concettuale per futuri esperimenti cromatici; nessun sorgente MPL è incorporato nei file MIT.
