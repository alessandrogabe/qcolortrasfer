# qcolortrasfer specification

## Goal
Static installable PWA for one-way screen-to-camera file transfer, resilient to optical loss and with no mandatory return channel or backend.

## v1.3 architecture
1. File: filename, length, SHA-256.
2. Fountain: 512-byte source blocks, robust-soliton LT.
3. Packet: QCT1 + CRC32.
4. Primary optical channel: standard QR byte-mode, ECC L, quiet zone, pinned mask 4.
5. Secondary optical channel: second standard QR of identical version/ECC/mask encoded in chroma.
6. Display: adaptive 1/2/4/6 physical QR tiles, two independent fountain symbols per tile.
7. Capture: full frame to two ZXing-WASM workers.
8. Decode A: ZXing finds and decodes up to 8 primary QR symbols.
9. Decode B: ZXing quad rectifies each primary; data-module chroma reconstructs secondary QR matrices; reconstructed matrices are decoded by ZXing again.
10. Reconstruction: dedupe, LT peeling, trim, SHA-256.

## Four-state modulation
Each non-reserved module combines two bits:
- primary bit: dark/light luminance, compatible with ordinary QR decoding;
- secondary bit: warm/cool chroma.

Palette v1:
- dark warm: RGB 150,20,20;
- dark cool: RGB 0,55,145;
- light warm: RGB 250,235,90;
- light cool: RGB 120,235,245.

Reserved/function modules are pure B/W. Because both logical QR symbols use equal version, ECC and mask, their reserved modules are identical and the secondary decoder can synthesize them from a deterministic template.

## Color decoding
ZXing supplies the detected QR quadrilateral and version. The worker computes a projective transform from QR module coordinates to camera pixels and samples five points inside each non-reserved module. A normalized `(B-R)/(R+G+B)` score separates warm/cool states. Two-cluster adaptive thresholding handles exposure and white-balance changes. If the clusters are not sufficiently separated, the secondary channel is discarded while the primary remains valid.

The reconstructed secondary module matrix is rendered as a clean synthetic B/W QR and decoded by ZXing. This gives the chromatic channel normal QR ECC and avoids all-or-nothing raw color packets.

## Fountain
Adapted from Decimen Optical Transfer v0.3.0 MIT: robust-soliton distribution, deterministic dlog, splitmix32, subset selection from QCT1 streamId + symbolId and peeling decoder. Missing frames are erasures, not fatal gaps.

## Multi-QR display
Supported counts: 1,2,4,6. Two uses 2×1 landscape/1×2 portrait; four 2×2; six 3×2 landscape/2×3 portrait. AUTO selects the highest count with theoretical cell side >=150 CSS px. Each tile refreshes at selected fps/QR and changes are round-robin/staggered.

With two logical channels per physical tile, theoretical symbol rate is `grid_codes × fps_per_qr × 2` when the color channel is recovered.

## Receiver
Camera target ideal 1920-wide @30 fps. Two workers. ZXing max 8 primary QR per captured image. If both workers are busy the frame is dropped; fountain absorbs the loss. Color recovery is opportunistic and never blocks the primary channel.

## Progress
User progress is based on distinct fountain frames collected, not only solvedCount/K, because peeling is back-loaded. Completion is authoritative only after fountain completion and SHA-256 verification.
