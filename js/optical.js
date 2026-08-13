// Standards-compliant QR optical layer. The base channel follows the proven
// Decimen v0.3.0 idea (ordinary QR + ZXing). qcolortrasfer adds a second QR
// channel in chroma while preserving the first QR's luminance.

import { COLOR_MODE, rgbForState } from './color-code.js';

export const CAPACITY_BYTES = 1465;
export const QR_ECC = 'L';
export const QR_MARGIN = 4;
export const QR_MASK = 4;
export const MAX_GRID_CODES = 6;
export const MIN_AUTO_QR_SIDE = 150;
export const VISUAL_STATES = 4;
export { COLOR_MODE };

const QR_MODULE_URL = 'https://esm.sh/qrcode@1.5.4?bundle';
let qrModulePromise = null;

async function getQrCode() {
  if (!qrModulePromise) qrModulePromise = import(QR_MODULE_URL).then(mod => mod.default || mod);
  return qrModulePromise;
}

export function gridDims(count, width = 1, height = 1) {
  const portrait = height > width;
  switch (count) {
    case 1: return { cols: 1, rows: 1 };
    case 2: return portrait ? { cols: 1, rows: 2 } : { cols: 2, rows: 1 };
    case 4: return { cols: 2, rows: 2 };
    case 6: return portrait ? { cols: 2, rows: 3 } : { cols: 3, rows: 2 };
    default: throw new Error(`Unsupported QR grid: ${count}`);
  }
}

export function codeSideFor(count, width, height) {
  const { cols, rows } = gridDims(count, width, height);
  return Math.min(width / cols, height / rows);
}

export function chooseGridCount(width, height, minSide = MIN_AUTO_QR_SIDE) {
  if (!(width > 0) || !(height > 0)) return 1;
  for (const count of [6, 4, 2, 1]) {
    if (codeSideFor(count, width, height) >= minSide) return count;
  }
  return 1;
}

function validateBytes(bytes, label) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError(`${label} QR payload must be Uint8Array`);
  if (bytes.length > CAPACITY_BYTES) throw new Error(`${label} QR payload exceeds conservative ${CAPACITY_BYTES} byte limit`);
}

function makeQr(QRCode, bytes, version) {
  return QRCode.create([{ data: bytes, mode: 'byte' }], {
    errorCorrectionLevel: QR_ECC,
    maskPattern: QR_MASK,
    ...(version ? { version } : {})
  });
}

// Two independent ordinary QR symbols share one visual matrix. The primary QR
// controls luminance and is directly readable by ZXing. On non-reserved modules
// the secondary QR chooses warm/cool chroma. Reserved/function modules stay
// pure black/white; with identical version/ECC/mask they are identical in both
// QR symbols and therefore can be synthesized by the receiver.
export async function createDualQrRaster(primaryBytes, secondaryBytes) {
  validateBytes(primaryBytes, 'Primary');
  validateBytes(secondaryBytes, 'Color');
  const QRCode = await getQrCode();
  const primary = makeQr(QRCode, primaryBytes);
  const secondary = makeQr(QRCode, secondaryBytes, primary.version);
  if (primary.version !== secondary.version || primary.modules.size !== secondary.modules.size) {
    throw new Error('Dual QR channels did not lock to the same QR version');
  }
  if (typeof primary.modules.isReserved !== 'function') {
    throw new Error('qrcode 1.5.4 reserved-module API unavailable');
  }

  const modules = primary.modules.size;
  const size = modules + QR_MARGIN * 2;
  const pixels = new Uint8ClampedArray(size * size * 4);
  pixels.fill(255);
  let coloredModules = 0;

  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      const primaryDark = Boolean(primary.modules.get(y, x));
      const secondaryDark = Boolean(secondary.modules.get(y, x));
      const reserved = Boolean(primary.modules.isReserved(y, x));
      if (reserved && primaryDark !== secondaryDark) {
        throw new Error(`QR function module mismatch at ${x},${y}`);
      }
      let rgb;
      if (reserved) rgb = primaryDark ? [0, 0, 0] : [255, 255, 255];
      else { rgb = rgbForState(primaryDark, secondaryDark ? 1 : 0); coloredModules++; }
      const offset = ((y + QR_MARGIN) * size + x + QR_MARGIN) * 4;
      pixels[offset] = rgb[0];
      pixels[offset + 1] = rgb[1];
      pixels[offset + 2] = rgb[2];
      pixels[offset + 3] = 255;
    }
  }

  return {
    pixels,
    size,
    version: primary.version,
    modules,
    totalModules: size,
    ecc: QR_ECC,
    colorMode: COLOR_MODE,
    visualStates: VISUAL_STATES,
    coloredModules
  };
}

// Kept for diagnostics/backward-compatible tests: an ordinary monochrome QR.
export async function createQrRaster(bytes) {
  validateBytes(bytes, 'QR');
  const QRCode = await getQrCode();
  const qr = makeQr(QRCode, bytes);
  const modules = qr.modules.size;
  const size = modules + QR_MARGIN * 2;
  const pixels = new Uint8ClampedArray(size * size * 4);
  pixels.fill(255);
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      if (!qr.modules.get(y, x)) continue;
      const offset = ((y + QR_MARGIN) * size + x + QR_MARGIN) * 4;
      pixels[offset] = 0; pixels[offset + 1] = 0; pixels[offset + 2] = 0; pixels[offset + 3] = 255;
    }
  }
  return { pixels, size, version: qr.version, modules, totalModules: size, ecc: QR_ECC };
}

export async function renderFrame(canvas, bytes) {
  const raster = await createQrRaster(bytes);
  const cssBudget = Math.max(280, Math.floor(Math.min(canvas.clientWidth || 760, canvas.clientHeight || canvas.clientWidth || 760)));
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
  const scale = Math.max(2, Math.floor((cssBudget * dpr) / raster.size));
  canvas.width = raster.size * scale;
  canvas.height = raster.size * scale;
  canvas.style.width = `${canvas.width / dpr}px`;
  canvas.style.height = `${canvas.height / dpr}px`;
  const staging = document.createElement('canvas');
  staging.width = raster.size; staging.height = raster.size;
  staging.getContext('2d', { alpha: false }).putImageData(new ImageData(raster.pixels, raster.size, raster.size), 0, 0);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
  return { ...raster, scale };
}
