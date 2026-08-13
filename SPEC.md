# qcolortrasfer specification

## Goal
Static installable PWA for one-way screen-to-camera file transfer with no mandatory return channel or backend.

## v1.5 architecture
1. File metadata + SHA-256.
2. LT robust-soliton fountain; payload configurable 512/768/1024/1280 B, default 1024 B.
3. QCT1 packet + CRC32. Flag bit 1 (`FLAG_COLOR_8`) declares 8-state/3-channel mode; absent means backward-compatible 4-state mode.
4. Base optical channel: ordinary QR byte-mode, ECC L, pinned mask 4.
5. Chromatic modulation only on non-reserved QR modules.
6. 4-state mode: base luminance QR + chroma axis A QR.
7. 8-state experimental mode: base luminance QR + chroma axis A QR + chroma axis B QR.
8. Display grid: 1/2/4/6 physical QR tiles, round-robin staggered refresh.
9. TX modes: 4-state STABLE, 4-state ADAPTIVE, 8-state EXP.
10. TX targets: 3/5/8/12/20 fps per physical QR. STABLE/EXP use the legacy interval scheduler. ADAPTIVE uses per-tile optical dwell scheduling.
11. Camera: ideal 1920-wide @30 fps, two ZXing-WASM workers.
12. Worker: ZXing base decode → homography → five samples/module → adaptive binary clustering per chroma axis → synthesize QR matrices → ZXing C1/C2.
13. Reconstruction: dedupe, LT peeling, trim, SHA-256.
14. Finalization guarded by `rxFinalizing/rxComplete`; completion side effects execute once.

## 4-state ADAPTIVE scheduler

ADAPTIVE intentionally does not introduce a return channel. qcolortrasfer remains one-way; therefore no transmitter claim may state that it measures receiver decode performance directly.

The scheduler addresses optical stability on the sender:

- encoding is unchanged from 4-state STABLE: 2 logical QR channels in one physical tile;
- each tile stores the monotonic timestamp of its last visible repaint;
- the next fountain symbol/QR is generated before the scheduler waits for the tile deadline, so QR-generation CPU cost overlaps the current tile's visible dwell;
- the next tile repaint is allowed only after `max(1000 / requested_fps, 75 ms)`;
- 75 ms is derived from `2.25 × 1000 / 30`, i.e. roughly 2.25 observation frames for a nominal 30 fps camera;
- at 20 fps requested, the optical per-tile ceiling is therefore about 13.33 fps even if the sender can generate faster;
- actual measured generation time may reduce the achieved rate further and is exposed in TX telemetry;
- AUTO grid cap in ADAPTIVE is 6 QR through 12 fps target and 4 QR at 20 fps target; manual 1/2/4/6 selection always overrides AUTO.

This mode does not change QCT1, receiver logic, fountain compatibility or the optical palette. A receiver cannot distinguish STABLE from ADAPTIVE from packet contents, by design.

## 8-state palette
Dark and light luminance bands remain separated by >90 luma units. Two normalized opponent axes are used:
- A = `(B-R)/(R+G+B)`
- B = `(2G-R-B)/(R+G+B)`
Each axis is clustered independently per detected QR, making thresholds adaptive to exposure/white balance.

## Performance telemetry
TX shows target fps, optical ceiling when ADAPTIVE is active, rolling QR-generation time, logical symbols/s and theoretical fountain KiB/s. RX shows base/C1/C2 decode counts, chroma separations, unique/duplicate fountain symbols, dropped frames, peeling state and live fountain KiB/s. Completion reports elapsed seconds and effective file KiB/s.

## Compatibility
4-state STABLE remains the proven fallback. 4-state ADAPTIVE is wire-identical to it. The QCT1 version remains 1; 8-state is still an additive flag. Fountain wire behavior is unchanged.

## Tests
`tests/adaptive-scheduler.test.mjs` pins the ADAPTIVE dwell, 20-fps ceiling, AUTO cap and repaint deadline. Existing tests continue to cover fountain loss/out-of-order behavior, protocol/CRC/SHA, color separation, multi-grid, PWA wiring and atomic completion.
