// Standards-compliant QR optical layer. The single-QR baseline follows the
// architecture used by Decimen Optical Transfer v0.3.0 (MIT). Multi-QR tiling
// in qcolortrasfer is an independent implementation: each tile is an ordinary
// QR carrying one independent fountain symbol.

export const CAPACITY_BYTES = 1465;
export const QR_ECC = 'L';
export const QR_MARGIN = 4;
export const QR_MASK = 4;
export const MAX_GRID_CODES = 6;
export const MIN_AUTO_QR_SIDE = 150;

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

export async function createQrRaster(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('QR payload must be Uint8Array');
  if (bytes.length > CAPACITY_BYTES) throw new Error(`QR payload exceeds conservative ${CAPACITY_BYTES} byte limit`);
  const QRCode = await getQrCode();
  const qr = QRCode.create([{ data: bytes, mode: 'byte' }], { errorCorrectionLevel: QR_ECC, maskPattern: QR_MASK });
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
