// qcolortrasfer OPTICAL MODEM display layout policy (MIT).
//
// Phones need to use almost all available screen area because camera pixels per
// cell are scarce. Desktop/laptop displays are the opposite: blindly filling a
// 16:9 monitor pushes the four SYNC fiducials very far apart and can force the
// receiver to move back until individual cells become too small. Desktop mode
// therefore caps the optical field to a camera-friendly centered rectangle.

export const MODEM_DESKTOP_MIN_WIDTH = 900;
export const MODEM_DESKTOP_MIN_HEIGHT = 480;
export const MODEM_DESKTOP_MAX_CSS_WIDTH = 1040;
export const MODEM_DESKTOP_MAX_CSS_HEIGHT = 680;
export const MODEM_DESKTOP_MAX_CELL_CSS = 5;

function finitePositive(value, fallback = 1) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function isDesktopModemViewport(width, height) {
  return finitePositive(width) >= MODEM_DESKTOP_MIN_WIDTH && finitePositive(height) >= MODEM_DESKTOP_MIN_HEIGHT;
}

function normalizedInputs({ width, height, dpr = 1, rasterWidth, rasterHeight }) {
  return {
    width: finitePositive(width),
    height: finitePositive(height),
    dpr: Math.max(1, finitePositive(dpr)),
    rasterWidth: Math.max(1, Math.floor(finitePositive(rasterWidth))),
    rasterHeight: Math.max(1, Math.floor(finitePositive(rasterHeight))),
  };
}

function orientationCandidate({ width, height, dpr, rasterWidth, rasterHeight, rotated, desktop }) {
  const rw = rotated ? rasterHeight : rasterWidth;
  const rh = rotated ? rasterWidth : rasterHeight;
  let budgetW = width;
  let budgetH = height;
  let scaleCap = Infinity;

  if (desktop) {
    // Keep a white surround inside the stage and limit absolute marker
    // separation. The backing raster remains integer-scaled for crisp cells.
    budgetW = Math.min(width * 0.92, MODEM_DESKTOP_MAX_CSS_WIDTH);
    budgetH = Math.min(height * 0.94, MODEM_DESKTOP_MAX_CSS_HEIGHT);
    scaleCap = Math.max(1, Math.floor(MODEM_DESKTOP_MAX_CELL_CSS * dpr));
  }

  const fitScale = Math.floor(Math.min((budgetW * dpr) / rw, (budgetH * dpr) / rh));
  const scale = Math.max(1, Math.min(fitScale || 1, scaleCap));
  const cssWidth = (rw * scale) / dpr;
  const cssHeight = (rh * scale) / dpr;
  const fill = (cssWidth * cssHeight) / Math.max(1, width * height);
  return { rotated, scale, cssWidth, cssHeight, rasterWidth: rw, rasterHeight: rh, fill };
}

export function fitModemRaster(args) {
  const n = normalizedInputs(args);
  const desktop = isDesktopModemViewport(n.width, n.height);
  const fitted = orientationCandidate({ ...n, rotated: false, desktop });
  return {
    ...fitted,
    desktop,
    viewportWidth: n.width,
    viewportHeight: n.height,
    dpr: n.dpr,
  };
}

export function computeModemDisplayLayout(args) {
  const n = normalizedInputs(args);
  const desktop = isDesktopModemViewport(n.width, n.height);
  const landscape = orientationCandidate({ ...n, rotated: false, desktop });
  const portrait = orientationCandidate({ ...n, rotated: true, desktop });

  // Primary objective is module size (scale). If tied, use the orientation that
  // occupies more of the available optical area; final tie follows viewport.
  let chosen;
  if (portrait.scale !== landscape.scale) chosen = portrait.scale > landscape.scale ? portrait : landscape;
  else if (Math.abs(portrait.fill - landscape.fill) > 1e-6) chosen = portrait.fill > landscape.fill ? portrait : landscape;
  else chosen = n.height > n.width ? portrait : landscape;

  return {
    ...chosen,
    desktop,
    viewportWidth: n.width,
    viewportHeight: n.height,
    dpr: n.dpr,
    maxCssWidth: desktop ? MODEM_DESKTOP_MAX_CSS_WIDTH : n.width,
    maxCssHeight: desktop ? MODEM_DESKTOP_MAX_CSS_HEIGHT : n.height,
  };
}
