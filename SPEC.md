# qcolortrasfer specification

## Goal
Static installable PWA for one-way screen-to-camera file transfer with no mandatory return channel or backend.

## v1.6 architecture
1. File metadata + SHA-256.
2. LT robust-soliton fountain; payload configurable 512/768/1024/1280 B, default 1024 B.
3. QCT1 packet + CRC32. 4-state STABILE is the default; 4-state ADAPTIVE shares the same wire format; 8-state is experimental.
4. Base optical channel: ordinary QR byte-mode, ECC L, pinned mask 4.
5. Chromatic modulation only on non-reserved QR modules.
6. Display grid: 1/2/4/6 physical QR tiles with staggered refresh.
7. Camera target: ideal 1920-wide; first request exact 60 fps, fallback exact 30, then ideal 60.
8. RX acquisition: occasional full-frame ZXing scan, max 8 base QR. Full-scan color reconstruction is disabled to reduce occupancy.
9. RX tracking: valid QCT1 detections become short-lived ROIs. Matching uses IoU plus normalized center distance; detections are mildly smoothed.
10. RX crop scheduling: crop = detected box + bounded padding; one in-flight task max per ROI; oldest-submitted ROI gets priority.
11. Worker pool: 2/3/4 module workers selected from hardware concurrency. Full-scan task gets priority when due; remaining workers process ROI crops.
12. Crop decode: ZXing base → local homography → chroma C1/C2 → synthetic QR → ZXing; coordinates returned by a crop are translated back into full-frame coordinates.
13. Recovery: no ROI = acquisition full scan every ~120 ms; degraded ROI count = ~300 ms; locked set = ~1200 ms. Regions expire after ~1800 ms.
14. Reconstruction: dedupe, LT peeling, trim, SHA-256.
15. Finalization guarded by `rxFinalizing/rxComplete`; completion side effects execute once.

## ROI invariants
- Only valid QCT1 QR results create/update regions.
- ROI state is performance-only; loss of all ROI cannot make a transfer permanently fail because full-frame acquisition continues.
- A worker cannot hold the same `regionId` concurrently with another worker.
- Crop origin is part of the worker task; detected crop coordinates are translated back to camera-frame coordinates before tracker update.
- Full scan remains authoritative for reacquisition; ROI is not a replacement for ZXing localization.

## Performance telemetry
TX shows optical settings and theoretical fountain rate. RX shows base/C1/C2, unique/duplicate fountain symbols, live goodput, ROI active/peak, crop hit rate, full-scan count, busy/total workers, saturated camera frames and peeling state. Completion reports elapsed seconds and effective file KiB/s.

## Licensing boundary
The ROI/crop scheduler is original qcolortrasfer MIT code. Decimen v0.3.0 MIT remains the source for the adapted fountain and baseline QR/worker approach. Decimen >=0.4 AGPL may be referenced only for public benchmark/architectural comparison; no AGPL source is copied or adapted into qcolortrasfer.

## Compatibility
QCT1 and fountain wire behavior are unchanged by RX ROI. Existing 4-state streams remain compatible. RX ROI is a receiver-side performance optimization only.
