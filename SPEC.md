# qcolortrasfer specification

## 1. Goal

Create a universal static web app for offline screen-to-camera file transfer using high-density colored visual frames, with graceful tolerance of lost frames and no mandatory return channel.

## 2. Product constraints

- Public web app, mobile-first.
- Static hosting compatible with GitHub Pages.
- No upload of file contents to a server.
- MIT license for qcolortrasfer-owned source.
- Explicit attribution to relevant prior projects.
- Browser-only baseline; native/WASM acceleration may be optional later.

## 3. Layering

1. File layer: metadata, size, MIME, SHA-256.
2. Fountain layer: source chunks + unbounded deterministic repair symbols.
3. Packet layer: stream id, symbol id, chunk metadata, CRC32.
4. Optical layer: fixed matrix geometry, sync cells, calibration palette, 4-color data cells.
5. Camera layer: frame capture, crop/alignment, color classification.
6. Reconstruction: reject bad packets, deduplicate, fountain peeling, trim file length, verify SHA-256.

## 4. v0.1 protocol

### Fountain

- Original qcolortrasfer LT-style experimental implementation.
- Systematic symbols are sent first.
- Repair symbols are deterministic XOR equations over source chunks.
- Repair degree is selected deterministically from a small robust distribution.
- Decoder uses iterative peeling/substitution.
- This is not Wirehair, RaptorQ or a standards claim.

### Optical matrix

- Matrix: 48 x 48 cells.
- Outer border and corner markers are non-data sync geometry.
- Four calibration cells are repeated in the frame.
- Four data colors represent dibits 00, 01, 10, 11.
- Data positions are deterministic and identical for transmitter/receiver.
- Packets are padded to the fixed optical capacity.

### Integrity

- CRC32 protects each optical packet.
- Invalid frames are discarded before entering the fountain decoder.
- Full SHA-256 digest protects the reconstructed file when Web Crypto is available.

## 5. v0.1 receiver limitation

The camera decoder uses an alignment crop and color calibration rather than full projective geometry. It is expected to work best screen-to-phone with the optical square approximately frontal and filling the on-screen guide. Automatic finder/perspective correction is a planned protocol-compatible improvement.

## 6. Planned experiments

- Compare 2-state, 4-state and 8-state cell alphabets.
- Per-frame adaptive color calibration.
- Region-level ECC so a partially damaged frame can yield valid sub-packets.
- Reed-Solomon or equivalent local ECC.
- Perspective correction and automatic finder detection.
- WebAssembly/SIMD/GPU decoding.
- Multiple independent symbols per optical frame.
- Optional Wirehair backend with BSD-3-Clause notice.
- Color + geometric-symbol modulation.
- Temporal/differential modulation.
- Measured throughput, frame loss, BER and device compatibility benchmark suite.
