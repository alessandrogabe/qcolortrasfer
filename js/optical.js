// Standards-compliant QR optical layer. The base channel follows the proven
// Decimen v0.3.0 approach (ordinary QR + ZXing). qcolortrasfer can transmit the
// same ordinary B/W baseline or overlay one/two additional QR channels in
// chroma while preserving base QR luminance.

import {
  COLOR_MODE_4, COLOR_MODE_8, rgbForState, rgbForState8
} from './color-code.js';

// V2 intentionally uses the full QR V40-L byte-mode envelope. QCT2 keeps its
// own compact header inside this limit, leaving 2925 fountain bytes per layer.
export const CAPACITY_BYTES = 2953;
export const QR_ECC = 'L';
// Two quiet modules are baked into each tile. Two adjacent tiles therefore
// share a four-module white separator (2 + 2), while the optical stage adds a
// larger external safe margin. This avoids wasting eight modules between every
// pair of QR codes while preserving a clean four-module physical gap.
export const QR_MARGIN = 2;
export const QR_MASK = 4;
export const MAX_GRID_CODES = 6;
export const MIN_AUTO_QR_SIDE = 150;
export const VISUAL_STATES = 4;
export const VISUAL_STATES_MONO = 2;
export const VISUAL_STATES_4 = 4;
export const VISUAL_STATES_8 = 8;
export const COLOR_MODE = COLOR_MODE_4;
export { COLOR_MODE_4, COLOR_MODE_8 };

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
  if (bytes.length > CAPACITY_BYTES) throw new Error(`${label} QR payload exceeds ${CAPACITY_BYTES} byte V40-L limit`);
}

function makeQr(QRCode, bytes, version) {
  return QRCode.create([{ data: bytes, mode: 'byte' }], {
    errorCorrectionLevel: QR_ECC,
    maskPattern: QR_MASK,
    ...(version ? { version } : {})
  });
}

async function createLayeredQrRaster(primaryBytes, chromaBytes) {
  validateBytes(primaryBytes, 'Primary');
  if (!Array.isArray(chromaBytes) || chromaBytes.length < 1 || chromaBytes.length > 2) throw new Error('Layered QR requires one or two chroma channels');
  chromaBytes.forEach((bytes, index) => validateBytes(bytes, `Color ${index + 1}`));

  const QRCode = await getQrCode();
  const primary = makeQr(QRCode, primaryBytes);
  const chroma = chromaBytes.map(bytes => makeQr(QRCode, bytes, primary.version));
  for (const qr of chroma) {
    if (qr.version !== primary.version || qr.modules.size !== primary.modules.size) throw new Error('Layered QR channels did not lock to the same QR version');
  }
  if (typeof primary.modules.isReserved !== 'function') throw new Error('qrcode 1.5.4 reserved-module API unavailable');

  const modules = primary.modules.size;
  const size = modules + QR_MARGIN * 2;
  const pixels = new Uint8ClampedArray(size * size * 4);
  pixels.fill(255);
  let coloredModules = 0;

  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      const primaryDark = Boolean(primary.modules.get(y, x));
      const bits = chroma.map(qr => Boolean(qr.modules.get(y, x)));
      const reserved = Boolean(primary.modules.isReserved(y, x));
      if (reserved) {
        for (const bit of bits) if (primaryDark !== bit) throw new Error(`QR function module mismatch at ${x},${y}`);
      }
      let rgb;
      if (reserved) rgb = primaryDark ? [0, 0, 0] : [255, 255, 255];
      else if (chroma.length === 1) { rgb = rgbForState(primaryDark, bits[0] ? 1 : 0); coloredModules++; }
      else { rgb = rgbForState8(primaryDark, bits[0] ? 1 : 0, bits[1] ? 1 : 0); coloredModules++; }
      const offset = ((y + QR_MARGIN) * size + x + QR_MARGIN) * 4;
      pixels[offset] = rgb[0]; pixels[offset + 1] = rgb[1]; pixels[offset + 2] = rgb[2]; pixels[offset + 3] = 255;
    }
  }

  const visualStates = chroma.length === 2 ? VISUAL_STATES_8 : VISUAL_STATES_4;
  return {
    pixels, size, version: primary.version, modules, totalModules: size, ecc: QR_ECC,
    colorMode: visualStates === 8 ? COLOR_MODE_8 : COLOR_MODE_4,
    visualStates, channels: chroma.length + 1, coloredModules
  };
}

export function createDualQrRaster(primaryBytes, secondaryBytes) {
  return createLayeredQrRaster(primaryBytes, [secondaryBytes]);
}

export function createTripleQrRaster(primaryBytes, secondaryBytes, tertiaryBytes) {
  return createLayeredQrRaster(primaryBytes, [secondaryBytes, tertiaryBytes]);
}

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
  return {
    pixels, size, version: qr.version, modules, totalModules: size, ecc: QR_ECC,
    visualStates: VISUAL_STATES_MONO, channels: 1, coloredModules: 0, colorMode: 'mono'
  };
}

export async function renderFrame(canvas, bytes) {
  const raster = await createQrRaster(bytes);
  const cssBudget = Math.max(280, Math.floor(Math.min(canvas.clientWidth || 760, canvas.clientHeight || canvas.clientWidth || 760)));
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 4);
  const scale = Math.max(2, Math.floor((cssBudget * dpr) / raster.size));
  canvas.width = raster.size * scale;
  canvas.height = raster.size * scale;
  canvas.style.width = `${canvas.width / dpr}px`;
  canvas.style.height = `${canvas.height / dpr}px`;
  canvas.style.imageRendering = 'pixelated';
  const staging = document.createElement('canvas');
  staging.width = raster.size; staging.height = raster.size;
  staging.getContext('2d', { alpha: false }).putImageData(new ImageData(raster.pixels, raster.size, raster.size), 0, 0);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
  return { ...raster, scale };
}
