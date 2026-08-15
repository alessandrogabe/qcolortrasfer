// qcolortrasfer OPTICAL MODEM display layout policy (MIT).
//
// Phones need to use almost all available screen area because camera pixels per
// cell are scarce. Desktop/laptop displays are the opposite: filling the stage
// pushes the four SYNC fiducials too far apart and may place them close to the
// browser/control edges. Desktop mode therefore targets a compact ~800x464 CSS
// optical field (4 CSS px/logical raster cell at DPR 1), centered inside a
// generous white surround. Backing scale always remains an integer.

export const MODEM_DESKTOP_MIN_WIDTH = 900;
export const MODEM_DESKTOP_MIN_HEIGHT = 480;
export const MODEM_DESKTOP_MAX_CSS_WIDTH = 880;
export const MODEM_DESKTOP_MAX_CSS_HEIGHT = 540;
export const MODEM_DESKTOP_MAX_CELL_CSS = 4;
export const MODEM_DESKTOP_VIEWPORT_FRACTION = 0.82;

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
    // A monitor is viewed by a camera from farther away than a phone display.
    // Keeping the modem compact lets all four outer SYNC markers stay visible
    // without forcing the receiver so far back that each color cell becomes
    // sub-pixel. The white stage around the canvas is part of the optical safe
    // area and must not be consumed by the raster.
    budgetW = Math.min(width * MODEM_DESKTOP_VIEWPORT_FRACTION, MODEM_DESKTOP_MAX_CSS_WIDTH);
    budgetH = Math.min(height * MODEM_DESKTOP_VIEWPORT_FRACTION, MODEM_DESKTOP_MAX_CSS_HEIGHT);
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

  // Primary objective is module size. If tied, use the orientation that leaves
  // the largest valid optical raster; final tie follows viewport orientation.
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
