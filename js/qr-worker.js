// Portable multi-QR + color-layer decoder worker.
// Base channel: ordinary QR decoded from the camera image by ZXing-WASM.
// Color channel: ZXing's detected quad rectifies the same symbol; warm/cool
// chroma reconstructs a SECOND standard QR matrix, then ZXing decodes that
// synthetic QR too. Thus the color layer gets normal QR ECC instead of relying
// on a fragile raw bitstream.

import { chromaScore, clusterColorScores, classifyColorScore } from './color-code.js';

const ZXING_MODULE_URL = 'https://esm.sh/zxing-wasm@2.0.0/reader?bundle';
const ZXING_WASM_URL = 'https://cdn.jsdelivr.net/npm/zxing-wasm@2.0.0/dist/reader/zxing_reader.wasm';
const QR_MODULE_URL = 'https://esm.sh/qrcode@1.5.4?bundle';
const MAX_SYMBOLS = 8;
const QR_ECC = 'L';
const QR_MASK = 4;
const SYNTH_MARGIN = 4;
const SYNTH_SCALE = 3;
const COLOR_MIN_SEPARATION = 0.08;

let readerPromise = null;
let qrPromise = null;
const templateCache = new Map();

async function getReader() {
  if (!readerPromise) {
    readerPromise = (async () => {
      const mod = await import(ZXING_MODULE_URL);
      mod.prepareZXingModule({ overrides: { locateFile(path, prefix) { return path.endsWith('.wasm') ? ZXING_WASM_URL : prefix + path; } } });
      await mod.readBarcodes(new ImageData(8, 8), { formats: ['QRCode'], maxNumberOfSymbols: 1 }).catch(() => undefined);
      return mod;
    })();
  }
  return readerPromise;
}

async function getQrCode() {
  if (!qrPromise) qrPromise = import(QR_MODULE_URL).then(mod => mod.default || mod);
  return qrPromise;
}

function parsePositiveInt(value) {
  if (Number.isInteger(value) && value > 0) return value;
  const match = String(value ?? '').match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function versionFromModules(modules) {
  const version = (modules - 17) / 4;
  return Number.isInteger(version) && version >= 1 && version <= 40 ? version : 0;
}

function versionOf(result) {
  let version = parsePositiveInt(result.version);
  if (version >= 1 && version <= 40) return version;
  try {
    const extra = JSON.parse(result.extra || '{}');
    version = parsePositiveInt(extra.Version);
    if (version >= 1 && version <= 40) return version;
  } catch {}
  return versionFromModules(Number(result.symbol?.width || 0));
}

async function templateFor(version) {
  if (templateCache.has(version)) return templateCache.get(version);
  const QRCode = await getQrCode();
  const qr = QRCode.create([{ data: Uint8Array.of(0), mode: 'byte' }], {
    errorCorrectionLevel: QR_ECC,
    maskPattern: QR_MASK,
    version
  });
  const modules = qr.modules.size;
  const reserved = new Uint8Array(modules * modules);
  const bits = new Uint8Array(modules * modules);
  if (typeof qr.modules.isReserved !== 'function') throw new Error('qrcode reserved-module API unavailable');
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      const index = y * modules + x;
      reserved[index] = qr.modules.isReserved(y, x) ? 1 : 0;
      bits[index] = qr.modules.get(y, x) ? 1 : 0;
    }
  }
  const template = { modules, reserved, bits };
  templateCache.set(version, template);
  return template;
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const d = a[col][col];
    for (let j = col; j <= n; j++) a[col][j] /= d;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = a[row][col];
      for (let j = col; j <= n; j++) a[row][j] -= f * a[col][j];
    }
  }
  return a.map(row => row[n]);
}

function homography(src, dst) {
  const matrix = [];
  const vector = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); vector.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]); vector.push(v);
  }
  const h = solveLinearSystem(matrix, vector);
  return h ? [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1] : null;
}

function mapPoint(h, x, y) {
  const d = h[6] * x + h[7] * y + h[8];
  if (Math.abs(d) < 1e-9) return null;
  return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
}

function pixelScore(image, x, y) {
  const xx = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  const yy = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  const offset = (yy * image.width + xx) * 4;
  return chromaScore(image.data[offset], image.data[offset + 1], image.data[offset + 2]);
}

function moduleColorScore(image, h, gx, gy) {
  const offsets = [[0.50, 0.50], [0.37, 0.50], [0.63, 0.50], [0.50, 0.37], [0.50, 0.63]];
  let sum = 0;
  for (const [ox, oy] of offsets) {
    const p = mapPoint(h, gx + ox, gy + oy);
    if (!p || p[0] < 0 || p[0] >= image.width || p[1] < 0 || p[1] >= image.height) return null;
    sum += pixelScore(image, p[0], p[1]);
  }
  return sum / offsets.length;
}

async function reconstructColorQr(result, image) {
  const version = versionOf(result);
  if (!version || !result.position) return null;
  const template = await templateFor(version);
  const modules = template.modules;
  const p = result.position;
  const h = homography(
    [[0, 0], [modules, 0], [0, modules], [modules, modules]],
    [[p.topLeft.x, p.topLeft.y], [p.topRight.x, p.topRight.y], [p.bottomLeft.x, p.bottomLeft.y], [p.bottomRight.x, p.bottomRight.y]]
  );
  if (!h) return null;

  const scores = [];
  const dataIndices = [];
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      const index = y * modules + x;
      if (template.reserved[index]) continue;
      const score = moduleColorScore(image, h, x, y);
      if (score === null) return null;
      scores.push(score);
      dataIndices.push(index);
    }
  }
  const clusters = clusterColorScores(scores, COLOR_MIN_SEPARATION);
  if (!clusters) return null;

  const bits = template.bits.slice();
  for (let i = 0; i < dataIndices.length; i++) bits[dataIndices[i]] = classifyColorScore(scores[i], clusters);
  return { bits, modules, separation: clusters.separation };
}

function syntheticGrid(matrices) {
  if (!matrices.length) return null;
  const maxModules = Math.max(...matrices.map(item => item.modules));
  const cols = Math.min(3, matrices.length);
  const rows = Math.ceil(matrices.length / cols);
  const qrPx = (maxModules + SYNTH_MARGIN * 2) * SYNTH_SCALE;
  const gap = 12;
  const width = cols * qrPx + (cols - 1) * gap;
  const height = rows * qrPx + (rows - 1) * gap;
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  const setBlack = (x, y) => {
    const off = (y * width + x) * 4;
    data[off] = 0; data[off + 1] = 0; data[off + 2] = 0; data[off + 3] = 255;
  };
  matrices.forEach((item, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const ownPx = (item.modules + SYNTH_MARGIN * 2) * SYNTH_SCALE;
    const baseX = col * (qrPx + gap) + Math.floor((qrPx - ownPx) / 2);
    const baseY = row * (qrPx + gap) + Math.floor((qrPx - ownPx) / 2);
    for (let y = 0; y < item.modules; y++) {
      for (let x = 0; x < item.modules; x++) {
        if (!item.bits[y * item.modules + x]) continue;
        const px0 = baseX + (x + SYNTH_MARGIN) * SYNTH_SCALE;
        const py0 = baseY + (y + SYNTH_MARGIN) * SYNTH_SCALE;
        for (let yy = 0; yy < SYNTH_SCALE; yy++) for (let xx = 0; xx < SYNTH_SCALE; xx++) setBlack(px0 + xx, py0 + yy);
      }
    }
  });
  return new ImageData(data, width, height);
}

self.onmessage = async event => {
  const { id, buf, w, h } = event.data;
  try {
    const reader = await getReader();
    const image = new ImageData(new Uint8ClampedArray(buf), w, h);
    const results = await reader.readBarcodes(image, { formats: ['QRCode'], maxNumberOfSymbols: MAX_SYMBOLS });
    const base = results.filter(item => item.isValid && item.bytes?.length > 0);
    const symbols = base.map(item => item.bytes);

    const colorMatrices = [];
    let separationSum = 0;
    for (const result of base) {
      const reconstructed = await reconstructColorQr(result, image);
      if (reconstructed) { colorMatrices.push(reconstructed); separationSum += reconstructed.separation; }
    }

    let colorCount = 0;
    if (colorMatrices.length) {
      const synthetic = syntheticGrid(colorMatrices);
      const colorResults = await reader.readBarcodes(synthetic, { formats: ['QRCode'], maxNumberOfSymbols: colorMatrices.length });
      for (const item of colorResults) {
        if (!item.isValid || !item.bytes?.length) continue;
        symbols.push(item.bytes);
        colorCount++;
      }
    }

    self.postMessage({
      id,
      symbols,
      baseCount: base.length,
      colorCandidates: colorMatrices.length,
      colorCount,
      colorSeparation: colorMatrices.length ? separationSum / colorMatrices.length : 0,
      error: null
    });
  } catch (error) {
    self.postMessage({ id, symbols: [], baseCount: 0, colorCandidates: 0, colorCount: 0, colorSeparation: 0, error: error?.message || String(error) });
  }
};

void Promise.all([getReader(), getQrCode()])
  .then(() => self.postMessage({ id: -1, ready: true, symbols: [], error: null }))
  .catch(error => self.postMessage({ id: -1, ready: false, symbols: [], error: error?.message || String(error) }));
