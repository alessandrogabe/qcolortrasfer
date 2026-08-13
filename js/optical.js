// QR optical layer based on the proven approach used by Decimen Optical Transfer v0.3.0 (MIT).
// qcolortrasfer keeps its own QCT1 packet/fountain layers; this module only turns packet bytes into
// a standards-compliant monochrome QR code. The camera side is decoded by ZXing-WASM in workers.

export const CAPACITY_BYTES = 1465;
export const QR_ECC = 'L';
export const QR_MARGIN = 4;
export const QR_MASK = 4;

const QR_MODULE_URL = 'https://esm.sh/qrcode@1.5.4?bundle';
let qrModulePromise = null;

async function getQrCode() {
  if (!qrModulePromise) qrModulePromise = import(QR_MODULE_URL).then(mod => mod.default || mod);
  return qrModulePromise;
}

export async function renderFrame(canvas, bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('QR payload must be Uint8Array');
  if (bytes.length > CAPACITY_BYTES) throw new Error(`QR payload exceeds conservative ${CAPACITY_BYTES} byte baseline`);

  const QRCode = await getQrCode();
  const qr = QRCode.create([{ data: bytes, mode: 'byte' }], {
    errorCorrectionLevel: QR_ECC,
    maskPattern: QR_MASK,
  });

  const modules = qr.modules.size;
  const totalModules = modules + QR_MARGIN * 2;
  const cssBudget = Math.max(300, Math.floor(Math.min(canvas.clientWidth || 760, canvas.clientHeight || canvas.clientWidth || 760)));
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
  const scale = Math.max(2, Math.floor((cssBudget * dpr) / totalModules));
  const physical = totalModules * scale;

  canvas.width = physical;
  canvas.height = physical;
  canvas.style.width = `${physical / dpr}px`;
  canvas.style.height = `${physical / dpr}px`;

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, physical, physical);
  ctx.fillStyle = '#000';
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      if (!qr.modules.get(y, x)) continue;
      ctx.fillRect((x + QR_MARGIN) * scale, (y + QR_MARGIN) * scale, scale, scale);
    }
  }
  return { version: qr.version, modules, totalModules, scale, ecc: QR_ECC };
}
