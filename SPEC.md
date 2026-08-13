# qcolortrasfer specification

## Goal
Universal static PWA for offline screen-to-camera file transfer using colored visual frames, with tolerance of lost frames and no mandatory return channel.

## Product constraints
- Public mobile-first web app.
- Static hosting compatible with GitHub Pages project paths.
- Installable PWA and offline-capable after first load.
- No upload of file contents to a server.
- No mandatory backend or account.
- MIT license for qcolortrasfer-owned source.
- Explicit attribution to relevant prior projects.

## Layering
1. File layer: filename, size, SHA-256.
2. Fountain layer: source chunks + deterministic unbounded repair symbols.
3. Packet layer: QCT1 stream id, symbol id, chunk metadata, CRC32.
4. Optical layer: matrix geometry, finder cells, calibration palette, 4-color data cells.
5. Camera layer: centered user-guided crop, downscale, per-frame color classification.
6. Reconstruction: reject bad packets, deduplicate, fountain peeling, trim file length, verify SHA-256.
7. PWA layer: manifest, service worker cache, install/standalone support.

## Protocol v1
### Fountain
- Original qcolortrasfer LT-style experimental implementation.
- Source chunk size: 320 bytes.
- Systematic symbols first, then deterministic repair symbols.
- Repair symbols are XOR equations with deterministic degree selection.
- Decoder uses iterative peeling/substitution.
- Duplicate symbol ids are ignored.
- This is not Wirehair, RaptorQ or a standards claim.

### Optical matrix
- 48 × 48 logical cells.
- Outer black border and four 7 × 7 finder-like markers reserved.
- Four in-frame calibration cells reserved.
- Four colors represent dibits `00`, `01`, `10`, `11`.
- Analysis canvas: 240 × 240 (5 pixels per logical cell).
- One `getImageData()` per scan.

### Color classification
- References sampled from the same captured frame.
- Cells compared in normalized RGB chromaticity space.
- Minimum palette-separation rejects unusable frames.

### Integrity
- CRC32 protects every QCT1 packet.
- Invalid frames never enter fountain decode.
- SHA-256 is carried when Web Crypto is available.
- Completed files are withheld if SHA-256 differs.

### Mid-stream initialization
Every packet includes stream id, symbol id, source block count, chunk size, original file length, UTF-8 filename prefix and optional SHA-256.

## Receiver alignment
v1 uses a user-adjustable centered square crop rather than automatic homography. The guide/crop is adjustable from 62% to 94% of the visible square.

## PWA behavior
- Relative paths support GitHub Pages project hosting.
- Service worker caches only qcolortrasfer-owned static resources.
- Navigation is network-first with cached fallback; static assets cache-first.
- Camera access is user-initiated.
- No analytics, tracking or third-party runtime scripts.

## Planned improvements
Automatic finder/perspective correction, region ECC, 2/4/8-state experiments, WASM/SIMD/GPU, multiple symbols/frame, optional Wirehair backend, color+shape and temporal modulation, throughput/BER/device benchmarks.
