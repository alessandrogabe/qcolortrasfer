# qcolortrasfer specification

## Goal
Static installable PWA for one-way screen-to-camera file transfer with no mandatory return channel or backend. Primary direction: reproduce the proven high-throughput QR/fountain architecture independently under MIT and add qcolortrasfer's chromatic second channel.

## v2 architecture
1. Read file and compute SHA-256.
2. Pack once into QCF2: filename + SHA-256 + raw file bytes.
3. LT robust-soliton fountain over the complete QCF2 container.
4. QCT2 frame: 24-byte header + fountain payload + CRC32.
5. Maximum QCT2 fountain payload = 2925 B so complete QR bytes = 2953 B.
6. Base optical channel: ordinary byte-mode QR, ECC L, fixed mask 4.
7. 4-state default: base QR bit in luminance + independent C1 QR bit in chroma.
8. Reserved/function modules remain pure B/W and must match between logical QR layers.
9. Production UI exposes AUTO 4/6, forced 4 and forced 6 only. AUTO never selects fewer than 4 physical QR.
10. AUTO 6 criterion uses viewport, DPR and actual raster size; six codes require >=2.5 device pixels per raster cell, otherwise four larger QR are used.
11. Internal 1/2 layout primitives may remain only for compatibility/unit tests and are not production v2 modes.
12. Default TX target = 24 fps/physical QR; selectable 8/12/24/30/60.
13. Non-adaptive TX raster generation is moved to 2–4 workers, with lookahead target = 3 raster frames per visible slot.
14. Painting uses requestAnimationFrame and staggered phases; a long rAF stall resets cadence rather than replaying invisible backlog.
15. Camera target = 1280-wide, exact 60 fps first, exact 30 fallback, then ideal 60.
16. RX pool = 2–6 workers, bounded by logical hardware concurrency.
17. Full-frame ZXing is acquisition/recovery. Crop decode is the hot path.
18. Crop ZXing disables tryHarder/rotation/inversion/downscale and searches one QR.
19. Full scan returns both decoded detections and plausible position-only sightings; unconfirmed sightings are probationary and cannot move a confirmed ROI.
20. ROI TTL = 1600 ms; full scan cadence ~100 ms acquisition, 250 ms degraded, 1500 ms locked.
21. Crop padding = 30% of detected QR side, clamped to frame boundaries.
22. C1 reuses base-QR geometry. Reconstructed C1 is rendered as a clean QR and decoded with ZXing `isPure=true`, fixed threshold, no second finder search.
23. Dedupe + LT peeling reconstruct QCF2; unpack QCF2; verify raw-file SHA-256; expose one download.
24. Finalization remains guarded by `rxFinalizing/rxComplete`.

## QCT2 frame layout
All multi-byte numeric fields are encoded **big-endian**, matching JavaScript `DataView.get/setUint*` default behavior used by QCT1 and QCT2.

```text
0   u32 magic "QCT2"
4   u8  version = 2
5   u8  flags (bit0 = 8-state experimental)
6   u16 headerBytes = 24
8   u32 streamId
12  u32 symbolId
16  u16 sourceCount
18  u16 chunkSize
20  u32 containerLength
24  chunkSize bytes fountain payload
... u32 CRC32 over header + payload
```

`sourceCount == ceil(containerLength/chunkSize)` is mandatory. QCT2 sourceCount is u16; UI must reject a payload/file combination that exceeds it.

## QCF2 container
All multi-byte QCF2 numeric fields are likewise big-endian.

```text
0   u32 magic "QCF2"
4   u8  version = 1
5   u8  flags (bit0 = SHA present)
6   u16 total header bytes
8   u32 raw file length
12  u16 UTF-8 filename length
14  u16 reserved = 0
16  32 bytes SHA-256
48  filename bytes
... raw file bytes
```

Metadata is fountain-protected once rather than repeated in every optical frame.

## Compatibility
- TX v2 emits QCT2.
- RX v2 decodes QCT2 and legacy QCT1.
- QCT1 remains unchanged.
- 4-state chromatic semantics remain unchanged.
- 8-state remains experimental and is not the performance baseline.

## Performance contracts
- UI must show QR version, payload, visible physical QR count, requested fps, theoretical fountain KiB/s, generated logical symbols/s, raster generation EMA, lookahead occupancy and queue misses.
- RX must show base/C1/C2 counts, unique/duplicate fountain symbols, live fountain KiB/s, active/peak ROI, crop hit ratio, full scans, worker occupancy, saturated captures and peeling state.
- Completion must report raw-file elapsed time and effective file KiB/s.
- Theoretical TX capacity is not presented as measured goodput.

## Licensing boundary
- Decimen Optical Transfer v0.3.0 MIT is directly attributable source for the robust-soliton adaptation and baseline QR/fountain approach.
- Decimen >=0.4 is AGPL. Its public benchmark results and general architectural ideas may be studied, but its source is not copied/adapted into qcolortrasfer MIT.
- V2 high-throughput scheduler, QCT2/QCF2, raster-worker pool, AUTO 4/6 policy, ROI tracker and chromatic layer are qcolortrasfer implementations.

## Test contract
CI runs `npm test` and `npm run check` for every push/PR. Tests must pin QCT1 compatibility, QCT2/QCF2 validation, CRC, fountain correctness, 2953-byte envelope, AUTO 4/6 decisions, stagger timing math, TX/RX worker bounds, ROI behavior, fast ZXing wiring, PWA cache and atomic finalization.
