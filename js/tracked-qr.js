// qcolortrasfer tracked QR sampler (MIT).
//
// This is an independent implementation of a general optical-decoding idea:
// after a normal QR decode has established the four corners and QR dimension,
// subsequent frames can reuse that geometry. We perspective-sample the known
// module grid and hand a clean synthetic matrix to the ordinary QR decoder.
// The expensive finder/detector stage is therefore skipped on the hot path.
//
// No Decimen >=0.4 source is incorporated here. The math is ordinary planar
// homography + adaptive two-cluster luminance thresholding.

export const TRACKED_SAMPLE_OFFSETS = Object.freeze([
  [0.50, 0.50],
  [0.38, 0.50], [0.62, 0.50],
  [0.50, 0.38], [0.50, 0.62],
]);
export const TRACKED_MIN_LUMA_SEPARATION = 18;

export function modulesFromVersion(version) {
  const v = Math.floor(Number(version) || 0);
  return v >= 1 && v <= 40 ? 17 + 4 * v : 0;
}

export function versionFromModules(modules) {
  const m = Math.floor(Number(modules) || 0);
  const version = (m - 17) / 4;
  return Number.isInteger(version) && version >= 1 && version <= 40 ? version : 0;
}

export function shiftQuad(quad, dx = 0, dy = 0) {
  if (!quad?.topLeft || !quad?.topRight || !quad?.bottomLeft || !quad?.bottomRight) return null;
  const shift = point => ({ x: Number(point.x) + dx, y: Number(point.y) + dy });
  const out = {
    topLeft: shift(quad.topLeft), topRight: shift(quad.topRight),
    bottomLeft: shift(quad.bottomLeft), bottomRight: shift(quad.bottomRight),
  };
  return Object.values(out).every(p => Number.isFinite(p.x) && Number.isFinite(p.y)) ? out : null;
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    for (let j = col; j <= n; j++) a[col][j] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map(row => row[n]);
}

export function homographyForQr(modules, quad) {
  const q = shiftQuad(quad, 0, 0);
  if (!q || !(modules > 0)) return null;
  const src = [[0, 0], [modules, 0], [0, modules], [modules, modules]];
  const dst = [
    [q.topLeft.x, q.topLeft.y], [q.topRight.x, q.topRight.y],
    [q.bottomLeft.x, q.bottomLeft.y], [q.bottomRight.x, q.bottomRight.y],
  ];
  const matrix = [], vector = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); vector.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]); vector.push(v);
  }
  const h = solveLinearSystem(matrix, vector);
  return h ? [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1] : null;
}

export function mapHomography(h, x, y) {
  if (!h) return null;
  const d = h[6] * x + h[7] * y + h[8];
  if (Math.abs(d) < 1e-9) return null;
  return [
    (h[0] * x + h[1] * y + h[2]) / d,
    (h[3] * x + h[4] * y + h[5]) / d,
  ];
}

function lumaAt(image, x, y) {
  const xx = Math.round(x), yy = Math.round(y);
  if (xx < 0 || yy < 0 || xx >= image.width || yy >= image.height) return null;
  const offset = (yy * image.width + xx) * 4;
  const r = image.data[offset], g = image.data[offset + 1], b = image.data[offset + 2];
  // BT.601-ish integer luminance. Exact colorimetry is irrelevant; we only
  // need the two QR luminance populations to separate consistently.
  return (77 * r + 150 * g + 29 * b) / 256;
}

export function clusterLuma(values, minSeparation = TRACKED_MIN_LUMA_SEPARATION) {
  if (!values?.length) return null;
  let dark = 255, light = 0;
  for (const value of values) { if (value < dark) dark = value; if (value > light) light = value; }
  if (!(light > dark)) return null;
  for (let iteration = 0; iteration < 6; iteration++) {
    const mid = (dark + light) / 2;
    let darkSum = 0, darkN = 0, lightSum = 0, lightN = 0;
    for (const value of values) {
      if (value <= mid) { darkSum += value; darkN++; }
      else { lightSum += value; lightN++; }
    }
    if (!darkN || !lightN) return null;
    dark = darkSum / darkN; light = lightSum / lightN;
  }
  const separation = light - dark;
  if (separation < minSeparation) return null;
  return { dark, light, threshold: (dark + light) / 2, separation };
}

export function sampleTrackedQr(image, quad, modules) {
  if (!image?.data || !(image.width > 0) || !(image.height > 0) || !(modules > 0)) return null;
  const h = homographyForQr(modules, quad);
  if (!h) return null;
  const values = new Float32Array(modules * modules);
  let index = 0;
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      let sum = 0;
      for (const [ox, oy] of TRACKED_SAMPLE_OFFSETS) {
        const point = mapHomography(h, x + ox, y + oy);
        if (!point) return null;
        const luma = lumaAt(image, point[0], point[1]);
        if (luma == null) return null;
        sum += luma;
      }
      values[index++] = sum / TRACKED_SAMPLE_OFFSETS.length;
    }
  }
  const clusters = clusterLuma(values);
  if (!clusters) return null;
  const bits = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) bits[i] = values[i] <= clusters.threshold ? 1 : 0;
  return { bits, modules, separation: clusters.separation, threshold: clusters.threshold };
}
