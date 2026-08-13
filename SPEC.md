# qcolortrasfer specification

## Goal
Static installable PWA for one-way screen-to-camera file transfer with no mandatory return channel or backend.

## v1.4 architecture
1. File metadata + SHA-256.
2. LT robust-soliton fountain; payload configurable 512/768/1024/1280 B, default 1024 B.
3. QCT1 packet + CRC32. Flag bit 1 (`FLAG_COLOR_8`) declares 8-state/3-channel mode; absent means backward-compatible 4-state mode.
4. Base optical channel: ordinary QR byte-mode, ECC L, pinned mask 4.
5. Chromatic modulation only on non-reserved QR modules.
6. 4-state mode: base luminance QR + chroma axis A QR.
7. 8-state experimental mode: base luminance QR + chroma axis A QR + chroma axis B QR.
8. Display grid: 1/2/4/6 physical QR tiles, round-robin staggered refresh.
9. TX rates: 3/5/8/12/20 fps per physical QR. AUTO caps grid density at high CPU rates; manual grid overrides the cap.
10. Camera: ideal 1920-wide @30 fps, two ZXing-WASM workers.
11. Worker: ZXing base decode → homography → five samples/module → adaptive binary clustering per chroma axis → synthesize QR matrices → ZXing C1/C2.
12. Reconstruction: dedupe, LT peeling, trim, SHA-256.
13. Finalization guarded by `rxFinalizing/rxComplete`; completion side effects execute once.

## 8-state palette
Dark and light luminance bands remain separated by >90 luma units. Two normalized opponent axes are used:
- A = `(B-R)/(R+G+B)`
- B = `(2G-R-B)/(R+G+B)`
Each axis is clustered independently per detected QR, making thresholds adaptive to exposure/white balance.

## Performance telemetry
TX shows theoretical logical symbols/s and theoretical fountain KiB/s. RX shows base/C1/C2 decode counts, chroma separations, unique/duplicate fountain symbols, dropped frames, peeling state and live fountain KiB/s. Completion reports elapsed seconds and effective file KiB/s.

## Compatibility
4-state mode remains the proven fallback. The QCT1 version remains 1; the new color mode is an additive flag. Fountain wire behavior is unchanged.
