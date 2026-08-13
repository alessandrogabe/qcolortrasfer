// qcolortrasfer v2 high-throughput policy.
//
// This module contains only original qcolortrasfer/MIT scheduling/math. The
// architecture deliberately follows the proven optical-transfer principles:
// dense ordinary QR, fixed geometry, lookahead, staggered cell flips and a
// receiver that is allowed to miss symbols because the fountain code repairs
// erasures. No Decimen >=0.4 source is incorporated here.

export const QR_MAX_PACKET_BYTES = 2953; // QR V40-L byte-mode ceiling used by qcolortrasfer.
export const QCT2_HEADER_BYTES = 24;
export const QCT2_CRC_BYTES = 4;
export const MAX_HIGH_THROUGHPUT_CHUNK = QR_MAX_PACKET_BYTES - QCT2_HEADER_BYTES - QCT2_CRC_BYTES; // 2925 B

export const TX_LOOKAHEAD_PER_SLOT = 3;
export const TX_MIN_AUTO_CODES = 4;
export const TX_MAX_AUTO_CODES = 6;
export const TX_MIN_DEVICE_PX_PER_CELL = 2.5;

export function txWorkerCountForHardware(hardwareConcurrency) {
  const hc = Math.max(1, Math.floor(Number(hardwareConcurrency) || 4));
  return Math.max(2, Math.min(4, Math.floor(hc / 2) || 1));
}

export function gridDims46(count, width = 1, height = 1) {
  const portrait = height > width;
  if (count === 4) return { cols: 2, rows: 2 };
  if (count === 6) return portrait ? { cols: 2, rows: 3 } : { cols: 3, rows: 2 };
  throw new Error(`Unsupported high-throughput grid: ${count}`);
}

export function devicePixelsPerRasterCell(count, widthCss, heightCss, dpr, rasterSize) {
  const { cols, rows } = gridDims46(count, widthCss, heightCss);
  const sideCss = Math.min(widthCss / cols, heightCss / rows);
  return (sideCss * Math.max(1, Number(dpr) || 1)) / Math.max(1, rasterSize);
}

// Production AUTO is intentionally 4-or-6 only. Six is selected only when it
// does not make each QR optically too small; otherwise four larger QRs win.
// Lower-count grid primitives live in optical.js solely for legacy/internal
// compatibility tests and are not exposed by the v2 production UI.
export function chooseHighThroughputGrid(widthCss, heightCss, dpr, rasterSize, minPx = TX_MIN_DEVICE_PX_PER_CELL) {
  const sixPx = devicePixelsPerRasterCell(6, widthCss, heightCss, dpr, rasterSize);
  return sixPx >= minPx ? 6 : 4;
}

export function staggerSubIntervalMs(fpsPerCode, codeCount) {
  const fps = Math.max(1, Number(fpsPerCode) || 1);
  const count = Math.max(1, Number(codeCount) || 1);
  return 1000 / (fps * count);
}

export function theoreticalFountainKiBs(chunkBytes, fpsPerCode, codeCount, channelsPerCode = 2) {
  return (Math.max(0, chunkBytes) * Math.max(0, fpsPerCode) * Math.max(0, codeCount) * Math.max(0, channelsPerCode)) / 1024;
}
