// qcolortrasfer v2/v2.3 high-throughput policy.
//
// This module contains only original qcolortrasfer/MIT scheduling/math. The
// architecture deliberately follows proven optical-transfer principles:
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

// AUTO is based on the physical pixels available to each QR raster cell. B/N
// tolerates a little less sampling density; chromatic modes need more pixels so
// that demosaicing/display sub-pixels do not collapse the chroma classification.
export const TX_MIN_DEVICE_PX_MONO = 3.1;
export const TX_MIN_DEVICE_PX_COLOR = 3.8;
export const TX_MAX_EFFECTIVE_DPR = 4;

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

export function effectiveDisplayDpr(requestedDpr = 1) {
  const requested = Math.max(1, Number(requestedDpr) || 1);
  const actual = Math.max(1, Number(globalThis.devicePixelRatio) || 1);
  return Math.min(TX_MAX_EFFECTIVE_DPR, Math.max(requested, actual));
}

export function minDevicePxForVisualStates(visualStates = 2) {
  return Number(visualStates) === 2 ? TX_MIN_DEVICE_PX_MONO : TX_MIN_DEVICE_PX_COLOR;
}

function inferredVisualStates() {
  const mode = globalThis.document?.getElementById?.('colorMode')?.value;
  if (!mode) return 2; // deterministic non-DOM/test default
  return mode === 'bw' ? 2 : mode === '8' ? 8 : 4;
}

export function devicePixelsPerRasterCell(count, widthCss, heightCss, dpr, rasterSize) {
  const { cols, rows } = gridDims46(count, widthCss, heightCss);
  const sideCss = Math.min(widthCss / cols, heightCss / rows);
  return (sideCss * effectiveDisplayDpr(dpr)) / Math.max(1, rasterSize);
}

// Production AUTO is intentionally 4-or-6 only. Six is selected only when a
// physical V40 raster cell remains large enough for the active optical profile;
// otherwise four larger QR win. `minPx` can be pinned by tests/experiments. In
// the browser, when omitted, it follows the selected B/N or chromatic profile.
export function chooseHighThroughputGrid(widthCss, heightCss, dpr, rasterSize, minPx = null) {
  const threshold = Number.isFinite(Number(minPx))
    ? Number(minPx)
    : minDevicePxForVisualStates(inferredVisualStates());
  const sixPx = devicePixelsPerRasterCell(6, widthCss, heightCss, dpr, rasterSize);
  return sixPx >= threshold ? 6 : 4;
}

export function staggerSubIntervalMs(fpsPerCode, codeCount) {
  const fps = Math.max(1, Number(fpsPerCode) || 1);
  const count = Math.max(1, Number(codeCount) || 1);
  return 1000 / (fps * count);
}

export function theoreticalFountainKiBs(chunkBytes, fpsPerCode, codeCount, channelsPerCode = 2) {
  return (Math.max(0, chunkBytes) * Math.max(0, fpsPerCode) * Math.max(0, codeCount) * Math.max(0, channelsPerCode)) / 1024;
}
