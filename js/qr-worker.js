// Portable multi-QR + chromatic decoder worker.
//
// RX v1.6 adds two task modes without changing the optical protocol:
// - full: locate up to 8 base QR on the whole camera frame; color decoding is
//   normally skipped because this task exists mainly to acquire/reacquire ROIs.
// - crop: decode one small tracked region; color reconstruction is enabled, so
//   most CPU time is spent where a QR is already known to be.
//
// 4-state: one chroma axis reconstructs a second standard QR.
// 8-state: two independent chroma axes reconstruct second + third standard QR.
// Every recovered chroma matrix is passed through ZXing again, retaining QR ECC.

import {
  chromaScoreA, chromaScoreB, clusterColorScores, classifyColorScore
} from './color-code.js';
import { FLAG_COLOR_8 } from './protocol.js';
import { detectionBoxFromPosition } from './rx-roi.js';

const ZXING_MODULE_URL = 'https://esm.sh/zxing-wasm@2.0.0/reader?bundle';
const ZXING_WASM_URL = 'https://cdn.jsdelivr.net/npm/zxing-wasm@2.0.0/dist/reader/zxing_reader.wasm';
const QR_MODULE_URL = 'https://esm.sh/qrcode@1.5.4?bundle';
const MAX_FULL_SYMBOLS = 8;
const MAX_CROP_SYMBOLS = 2;
const QR_ECC = 'L';
const QR_MASK = 4;
const SYNTH_MARGIN = 4;
const SYNTH_SCALE = 3;
const COLOR_MIN_SEPARATION_A = 0.06;
const COLOR_MIN_SEPARATION_B = 0.06;

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

function isQct1(bytes) {
  return bytes?.length >= 6 && bytes[0] === 0x51 && bytes[1] === 0x43 && bytes[2] === 0x54 && bytes[3] === 0x31;
}
function usesEightStates(bytes) { return isQct1(bytes) && Boolean(bytes[5] & FLAG_COLOR_8); }

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
  const qr = QRCode.create([{ data: Uint8Array.of(0), mode: 'byte' }], { errorCorrectionLevel: QR_ECC, maskPattern: QR_MASK, version });
  const modules = qr.modules.size;
  const reserved = new Uint8Array(modules * modules);
  const bits = new Uint8Array(modules * modules);
  if (typeof qr.modules.isReserved !== 'function') throw new Error('qrcode reserved-module API unavailable');
  for (let y = 0; y < modules; y++) for (let x = 0; x < modules; x++) {
    const index = y * modules + x;
    reserved[index] = qr.modules.isReserved(y, x) ? 1 : 0;
    bits[index] = qr.modules.get(y, x) ? 1 : 0;
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
  const matrix = [], vector = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
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
function pixelScores(image, x, y) {
  const xx = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  const yy = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  const offset = (yy * image.width + xx) * 4;
  const r = image.data[offset], g = image.data[offset + 1], b = image.data[offset + 2];
  return [chromaScoreA(r, g, b), chromaScoreB(r, g, b)];
}
function moduleColorScores(image, h, gx, gy) {
  const offsets = [[0.50,0.50],[0.37,0.50],[0.63,0.50],[0.50,0.37],[0.50,0.63]];
  let sumA = 0, sumB = 0;
  for (const [ox, oy] of offsets) {
    const p = mapPoint(h, gx + ox, gy + oy);
    if (!p || p[0] < 0 || p[0] >= image.width || p[1] < 0 || p[1] >= image.height) return null;
    const [a,b] = pixelScores(image, p[0], p[1]); sumA += a; sumB += b;
  }
  return [sumA / offsets.length, sumB / offsets.length];
}

function resultDetection(result, originX = 0, originY = 0) {
  const box = detectionBoxFromPosition(result?.position, originX, originY);
  return box ? { ...box, version: versionOf(result) } : null;
}

async function reconstructChroma(result, image) {
  if (!isQct1(result.bytes)) return null;
  const version = versionOf(result);
  if (!version || !result.position) return null;
  const template = await templateFor(version);
  const modules = template.modules;
  const p = result.position;
  const h = homography(
    [[0,0],[modules,0],[0,modules],[modules,modules]],
    [[p.topLeft.x,p.topLeft.y],[p.topRight.x,p.topRight.y],[p.bottomLeft.x,p.bottomLeft.y],[p.bottomRight.x,p.bottomRight.y]]
  );
  if (!h) return null;

  const scoresA = [], scoresB = [], dataIndices = [];
  for (let y = 0; y < modules; y++) for (let x = 0; x < modules; x++) {
    const index = y * modules + x;
    if (template.reserved[index]) continue;
    const scores = moduleColorScores(image, h, x, y);
    if (!scores) return null;
    scoresA.push(scores[0]); scoresB.push(scores[1]); dataIndices.push(index);
  }

  const clustersA = clusterColorScores(scoresA, COLOR_MIN_SEPARATION_A);
  const eight = usesEightStates(result.bytes);
  const clustersB = eight ? clusterColorScores(scoresB, COLOR_MIN_SEPARATION_B) : null;
  const bitsA = clustersA ? template.bits.slice() : null;
  const bitsB = clustersB ? template.bits.slice() : null;
  if (bitsA) for (let i = 0; i < dataIndices.length; i++) bitsA[dataIndices[i]] = classifyColorScore(scoresA[i], clustersA);
  if (bitsB) for (let i = 0; i < dataIndices.length; i++) bitsB[dataIndices[i]] = classifyColorScore(scoresB[i], clustersB);
  return {
    modules,
    a: bitsA ? { bits: bitsA, modules, separation: clustersA.separation } : null,
    b: bitsB ? { bits: bitsB, modules, separation: clustersB.separation } : null,
    eight
  };
}

function syntheticGrid(matrices) {
  if (!matrices.length) return null;
  const maxModules = Math.max(...matrices.map(item => item.modules));
  const cols = Math.min(3, matrices.length), rows = Math.ceil(matrices.length / cols);
  const qrPx = (maxModules + SYNTH_MARGIN * 2) * SYNTH_SCALE, gap = 12;
  const width = cols * qrPx + (cols - 1) * gap, height = rows * qrPx + (rows - 1) * gap;
  const data = new Uint8ClampedArray(width * height * 4); data.fill(255);
  const setBlack = (x, y) => { const off = (y * width + x) * 4; data[off]=0; data[off+1]=0; data[off+2]=0; data[off+3]=255; };
  matrices.forEach((item, i) => {
    const col=i%cols,row=Math.floor(i/cols); const ownPx=(item.modules+SYNTH_MARGIN*2)*SYNTH_SCALE;
    const baseX=col*(qrPx+gap)+Math.floor((qrPx-ownPx)/2), baseY=row*(qrPx+gap)+Math.floor((qrPx-ownPx)/2);
    for (let y=0;y<item.modules;y++) for (let x=0;x<item.modules;x++) {
      if (!item.bits[y*item.modules+x]) continue;
      const px0=baseX+(x+SYNTH_MARGIN)*SYNTH_SCALE, py0=baseY+(y+SYNTH_MARGIN)*SYNTH_SCALE;
      for (let yy=0;yy<SYNTH_SCALE;yy++) for (let xx=0;xx<SYNTH_SCALE;xx++) setBlack(px0+xx,py0+yy);
    }
  });
  return new ImageData(data,width,height);
}

async function decodeSynthetic(reader, matrices) {
  if (!matrices.length) return [];
  const image = syntheticGrid(matrices);
  const results = await reader.readBarcodes(image, { formats: ['QRCode'], maxNumberOfSymbols: matrices.length });
  return results.filter(item => item.isValid && item.bytes?.length > 0).map(item => item.bytes);
}

self.onmessage = async event => {
  const {
    id, buf, w, h,
    mode = 'full', regionId = null, originX = 0, originY = 0,
    decodeColor = mode === 'crop'
  } = event.data || {};
  try {
    const reader = await getReader();
    const image = new ImageData(new Uint8ClampedArray(buf), w, h);
    const maxNumberOfSymbols = mode === 'crop' ? MAX_CROP_SYMBOLS : MAX_FULL_SYMBOLS;
    const results = await reader.readBarcodes(image, { formats: ['QRCode'], maxNumberOfSymbols });
    const base = results.filter(item => item.isValid && item.bytes?.length > 0 && isQct1(item.bytes));
    const symbols = base.map(item => item.bytes);
    const detections = base.map(item => resultDetection(item, originX, originY)).filter(Boolean);

    const matricesA = [], matricesB = [];
    let sepA = 0, sepB = 0, eightBase = 0;
    if (decodeColor) {
      for (const result of base) {
        const reconstructed = await reconstructChroma(result, image);
        if (!reconstructed) continue;
        if (reconstructed.eight) eightBase++;
        if (reconstructed.a) { matricesA.push(reconstructed.a); sepA += reconstructed.a.separation; }
        if (reconstructed.b) { matricesB.push(reconstructed.b); sepB += reconstructed.b.separation; }
      }
    } else {
      eightBase = base.reduce((count, item) => count + (usesEightStates(item.bytes) ? 1 : 0), 0);
    }

    const colorA = decodeColor ? await decodeSynthetic(reader, matricesA) : [];
    const colorB = decodeColor ? await decodeSynthetic(reader, matricesB) : [];
    symbols.push(...colorA, ...colorB);

    self.postMessage({
      id, mode, regionId, detections, symbols,
      baseCount: base.length,
      eightBase,
      color1Candidates: matricesA.length,
      color1Count: colorA.length,
      color1Separation: matricesA.length ? sepA / matricesA.length : 0,
      color2Candidates: matricesB.length,
      color2Count: colorB.length,
      color2Separation: matricesB.length ? sepB / matricesB.length : 0,
      error: null
    });
  } catch (error) {
    self.postMessage({
      id, mode, regionId, detections: [], symbols: [], baseCount: 0, eightBase: 0,
      color1Candidates: 0, color1Count: 0, color1Separation: 0,
      color2Candidates: 0, color2Count: 0, color2Separation: 0,
      error: error?.message || String(error)
    });
  }
};

void Promise.all([getReader(), getQrCode()])
  .then(() => self.postMessage({ id: -1, ready: true, symbols: [], detections: [], error: null }))
  .catch(error => self.postMessage({ id: -1, ready: false, symbols: [], detections: [], error: error?.message || String(error) }));
