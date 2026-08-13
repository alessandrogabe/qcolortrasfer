# v2.2 — B/N baseline + TX fullscreen

## B/N baseline

The `B/N · 1 canale BASELINE` profile uses the same QCF2, robust-soliton fountain, QCT2, 2925-byte payload, AUTO 4/6 layout, TX worker/lookahead scheduler and RX ROI/crop pipeline as the color profile. Each physical tile carries one ordinary black/white QR instead of a luminance QR plus chromatic C1. QCT2 marks this profile with the MONO flag so the receiver can stop requesting chromatic work after the stream is identified.

This is the A/B reference for measuring the benefit and cost of qcolor. Compare the same file with the same payload, fps and AUTO 4/6 settings.

At 2925 B and 24 fps, nominal TX capacity is about 274 KiB/s with 4 B/N QR and 411 KiB/s with 6 B/N QR. The 4-state two-channel profile has twice that nominal offered capacity. These are not measured goodput values; use the final `KiB/s file` result.

## TX fullscreen

Fullscreen targets `txFullscreenShell`, which contains only the barcode stage and a compact bottom control strip. The controls are ordered START, STOP, RESET, EXIT, with START anchored on the left. The fullscreen/immersive layout uses the complete viewport, hides overflow and page panning, and gives the QR stage all available room except the small control strip. AUTO recalculates 4/6 QR after the viewport changes.

If the native Fullscreen API is unavailable, the UI uses an equivalent fixed immersive fallback. RESET rebuilds the selected file stream and resumes automatically when TX was running.
