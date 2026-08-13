# v2.2 / v2.2.1 — B/N baseline + TX optical view

## B/N baseline

The `B/N · 1 canale BASELINE` profile uses the same QCF2, robust-soliton fountain, QCT2, 2925-byte payload, AUTO 4/6 layout, TX worker/lookahead scheduler and RX ROI/crop pipeline as the color profile. Each physical tile carries one ordinary black/white QR instead of a luminance QR plus chromatic C1. QCT2 marks this profile with the MONO flag so the receiver can stop requesting chromatic work after the stream is identified.

This is the A/B reference for measuring the benefit and cost of qcolor. Compare the same file with the same payload, fps and AUTO 4/6 settings.

At 2925 B and 24 fps, nominal TX capacity is about 274 KiB/s with 4 B/N QR and 411 KiB/s with 6 B/N QR. The 4-state two-channel profile has twice that nominal offered capacity. These are not measured goodput values; use the final `KiB/s file` result.

## v2.2.1 TX optical view

The first v2.2 fullscreen implementation still depended on element fullscreen / a fixed fallback inside the page layout. On iPhone this could leave the document wider than the visible viewport and allow sideways dragging.

v2.2.1 replaces the mobile behavior with a dedicated optical view in `js/tx-optical-view.js`:

- pressing `QR A TUTTO SCHERMO` portals `txFullscreenShell` directly under `<body>`;
- the shell is pinned to `window.visualViewport`, not to the panel/document width;
- only the barcode stage and the compact START / STOP / RESET / ESCI strip are visible;
- the document is locked against horizontal/vertical pan, overscroll, rubber-band and gesture movement while the optical view is active;
- visual viewport resize/orientation changes reuse the existing TX resize path, so AUTO 4/6 and QR scaling are recalculated;
- exiting restores the shell to its original place and restores the previous scroll position.

The normal workspace is also width-clamped: the long capacity badge can wrap, controls have `min-width:0/max-width:100%`, and the document cannot create horizontal overflow. The optical engine/protocol is unchanged by this UI fix.

Native element Fullscreen remains only as legacy/desktop compatibility code in `app.js`; the iOS optical-view button intercepts that old handler in capture phase and does not depend on it.
