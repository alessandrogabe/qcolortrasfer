# qcolortrasfer specification

## Goal
Static installable PWA for one-way screen-to-camera file transfer, resilient to optical loss and with no mandatory return channel or backend.

## v1.2 architecture
1. File: filename, length, SHA-256.
2. Fountain: 512-byte source blocks, robust-soliton LT.
3. Packet: QCT1 + CRC32.
4. Optical: standard QR byte-mode, ECC L, quiet zone, pinned mask.
5. Display: adaptive 1/2/4/6 QR grid, one independent symbol per tile.
6. Capture: full frame to two ZXing-WASM workers.
7. Decode: up to 8 QR symbols from one camera frame.
8. Reconstruction: dedupe, LT peeling, trim, SHA-256.

## Fountain
Adapted from Decimen Optical Transfer v0.3.0 MIT: robust-soliton distribution, deterministic dlog, splitmix32, subset selection from QCT1 streamId + symbolId and peeling decoder. Missing frames are erasures, not fatal gaps. Fountain behavior is now a compatibility surface and requires golden-vector tests for changes.

## Multi-QR display
Supported counts: 1,2,4,6. Two uses 2×1 landscape/1×2 portrait; four 2×2; six 3×2 landscape/2×3 portrait. AUTO selects the highest count with theoretical cell side >=150 CSS px. Each tile refreshes at selected fps/QR and changes are round-robin/staggered. Aggregate rate is approximately grid_codes × fps_per_qr.

## Receiver
Camera target ideal 1920-wide @30 fps. Two workers. ZXing max 8 QR per captured image. If both workers are busy the frame is dropped; fountain absorbs the loss.

## Progress
User progress is based on distinct fountain frames collected, not only solvedCount/K, because peeling is back-loaded. Completion is authoritative only after fountain completion and SHA-256 verification.

## Next experiment
Reintroduce color without replacing QR geometry: standard finder/timing/alignment/ECC remain the fallback channel and a calibrated chromatic side-channel adds information to data modules.
