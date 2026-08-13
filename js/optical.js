export const GRID = 48;
export const ANALYSIS_SIZE = 320;
export const ANALYSIS_CELL_PX = ANALYSIS_SIZE / GRID;
export const PALETTE = [
  { name: 'red', css: '#ef3340' },
  { name: 'green', css: '#00a651' },
  { name: 'blue', css: '#1877f2' },
  { name: 'yellow', css: '#ffd400' }
];

const FINDER_SIZE = 7;
const FINDER_CENTER = 3.5;
const FAR_FINDER_CENTER = GRID - FINDER_CENTER;
const FINDER_GRID_SPAN = FAR_FINDER_CENTER - FINDER_CENTER;
const FINDER_MIN_CONTRAST = 30;
const CALIBRATION_MIN_SEPARATION = 0.006;

function inFinder(x, y) {
  return (x < FINDER_SIZE && y < FINDER_SIZE)
    || (x >= GRID - FINDER_SIZE && y < FINDER_SIZE)
    || (x < FINDER_SIZE && y >= GRID - FINDER_SIZE)
    || (x >= GRID - FINDER_SIZE && y >= GRID - FINDER_SIZE);
}

function reserved(x, y) {
  if (x === 0 || y === 0 || x === GRID - 1 || y === GRID - 1) return true;
  if (inFinder(x, y)) return true;
  if (y === 1 && x >= 8 && x < 12) return true;
  return false;
}

export const DATA_POSITIONS = (() => {
  const positions = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (!reserved(x, y)) positions.push([x, y]);
    }
  }
  return positions;
})();

export const CAPACITY_BYTES = Math.floor(DATA_POSITIONS.length * 2 / 8);

function drawFinder(ctx, x0, y0, cell) {
  ctx.fillStyle = '#000';
  ctx.fillRect(x0 * cell, y0 * cell, 7 * cell, 7 * cell);
  ctx.fillStyle = '#fff';
  ctx.fillRect((x0 + 1) * cell, (y0 + 1) * cell, 5 * cell, 5 * cell);
  ctx.fillStyle = '#000';
  ctx.fillRect((x0 + 2) * cell, (y0 + 2) * cell, 3 * cell, 3 * cell);
}

export function renderFrame(canvas, bytes) {
  if (bytes.length > CAPACITY_BYTES) throw new Error(`Optical payload exceeds ${CAPACITY_BYTES} bytes`);
  const cssSize = Math.max(320, Math.floor(Math.min(canvas.clientWidth || 768, canvas.clientHeight || canvas.clientWidth || 768)));
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
  const physical = Math.max(480, Math.floor(cssSize * ratio));
  canvas.width = physical;
  canvas.height = physical;
  const ctx = canvas.getContext('2d', { alpha: false });
  const cell = physical / GRID;
  ctx.imageSmoothingEnabled = false;

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, physical, physical);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, physical, cell);
  ctx.fillRect(0, physical - cell, physical, cell);
  ctx.fillRect(0, 0, cell, physical);
  ctx.fillRect(physical - cell, 0, cell, physical);

  drawFinder(ctx, 0, 0, cell);
  drawFinder(ctx, GRID - 7, 0, cell);
  drawFinder(ctx, 0, GRID - 7, cell);
  drawFinder(ctx, GRID - 7, GRID - 7, cell);

  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = PALETTE[i].css;
    ctx.fillRect((8 + i) * cell, cell, cell, cell);
  }

  let bitOffset = 0;
  for (const [x, y] of DATA_POSITIONS) {
    const byteIndex = bitOffset >> 3;
    const shift = 6 - (bitOffset & 7);
    const value = byteIndex < bytes.length ? ((bytes[byteIndex] >> shift) & 0b11) : 0;
    ctx.fillStyle = PALETTE[value].css;
    ctx.fillRect(x * cell, y * cell, Math.ceil(cell), Math.ceil(cell));
    bitOffset += 2;
  }
}

function makeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rgbToGray(r, g, b) {
  return (77 * r + 150 * g + 29 * b) >> 8;
}

function buildGray(data, width, height) {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = rgbToGray(data[p], data[p + 1], data[p + 2]);
  }
  return gray;
}

function grayAt(gray, width, height, x, y) {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const a = gray[y0 * width + x0] * (1 - fx) + gray[y0 * width + x1] * fx;
  const b = gray[y1 * width + x0] * (1 - fx) + gray[y1 * width + x1] * fx;
  return a * (1 - fy) + b * fy;
}

function finderExpectedBlack(mx, my) {
  return mx === 0 || my === 0 || mx === 6 || my === 6
    || (mx >= 2 && mx <= 4 && my >= 2 && my <= 4);
}

function scoreFinder(gray, width, height, cx, cy, cell) {
  let black = 0;
  let white = 0;
  let blackCount = 0;
  let whiteCount = 0;
  let residual = 0;

  for (let my = 0; my < 7; my++) {
    for (let mx = 0; mx < 7; mx++) {
      const x = cx + (mx - 3) * cell;
      const y = cy + (my - 3) * cell;
      if (x < 1 || x >= width - 1 || y < 1 || y >= height - 1) return null;
      const value = grayAt(gray, width, height, x, y);
      if (finderExpectedBlack(mx, my)) {
        black += value;
        blackCount++;
      } else {
        white += value;
        whiteCount++;
      }
    }
  }

  const blackMean = black / blackCount;
  const whiteMean = white / whiteCount;
  const contrast = whiteMean - blackMean;
  if (contrast <= 0) return null;
  const midpoint = (whiteMean + blackMean) / 2;

  for (let my = 0; my < 7; my++) {
    for (let mx = 0; mx < 7; mx++) {
      const value = grayAt(gray, width, height, cx + (mx - 3) * cell, cy + (my - 3) * cell);
      const expected = finderExpectedBlack(mx, my) ? blackMean : whiteMean;
      const span = Math.max(24, contrast);
      const delta = (value - expected) / span;
      residual += delta * delta;
      const wrongSide = finderExpectedBlack(mx, my) ? value > midpoint : value < midpoint;
      if (wrongSide) residual += 0.75;
    }
  }

  const mse = residual / 49;
  const score = contrast / (1 + mse * 4);
  return { cx, cy, cell, contrast, score, blackMean, whiteMean };
}

function scoreFinderDense(gray, width, height, cx, cy, cell) {
  const offsets = [[0, 0], [-0.42, 0], [0.42, 0], [0, -0.42], [0, 0.42]];
  let black = 0, white = 0, blackCount = 0, whiteCount = 0;
  const samples = [];

  for (let my = 0; my < 7; my++) {
    for (let mx = 0; mx < 7; mx++) {
      const isBlack = finderExpectedBlack(mx, my);
      for (const [ox, oy] of offsets) {
        const x = cx + (mx - 3 + ox) * cell;
        const y = cy + (my - 3 + oy) * cell;
        if (x < 1 || x >= width - 1 || y < 1 || y >= height - 1) return null;
        const value = grayAt(gray, width, height, x, y);
        samples.push([value, isBlack]);
        if (isBlack) { black += value; blackCount++; }
        else { white += value; whiteCount++; }
      }
    }
  }

  const blackMean = black / blackCount;
  const whiteMean = white / whiteCount;
  const contrast = whiteMean - blackMean;
  if (contrast <= 0) return null;
  const midpoint = (whiteMean + blackMean) / 2;
  const span = Math.max(24, contrast);
  let residual = 0;
  for (const [value, isBlack] of samples) {
    const expected = isBlack ? blackMean : whiteMean;
    const delta = (value - expected) / span;
    residual += delta * delta;
    const wrongSide = isBlack ? value > midpoint : value < midpoint;
    if (wrongSide) residual += 1.25;
  }
  const mse = residual / samples.length;
  return { cx, cy, cell, contrast, score: contrast / (1 + mse * 6), blackMean, whiteMean };
}

function refineFinderDense(gray, width, height, coarse) {
  let best = null;
  const centerRange = coarse.cell * 0.65;
  const centerStep = Math.max(0.28, coarse.cell / 18);

  for (let cy = coarse.cy - centerRange; cy <= coarse.cy + centerRange; cy += centerStep) {
    for (let cx = coarse.cx - centerRange; cx <= coarse.cx + centerRange; cx += centerStep) {
      const candidate = scoreFinderDense(gray, width, height, cx, cy, coarse.cell);
      if (candidate && (!best || candidate.score > best.score)) best = candidate;
    }
  }

  if (!best) return coarse;
  const base = best;
  for (let cell = Math.max(2.5, coarse.cell - 0.9); cell <= coarse.cell + 0.9; cell += 0.10) {
    const candidate = scoreFinderDense(gray, width, height, base.cx, base.cy, cell);
    if (candidate && candidate.score > best.score) best = candidate;
  }

  const finalBase = best;
  for (let cy = finalBase.cy - 0.5; cy <= finalBase.cy + 0.5; cy += 0.12) {
    for (let cx = finalBase.cx - 0.5; cx <= finalBase.cx + 0.5; cx += 0.12) {
      const candidate = scoreFinderDense(gray, width, height, cx, cy, finalBase.cell);
      if (candidate && candidate.score > best.score) best = candidate;
    }
  }
  return best;
}

function finderSearchBounds(width, height, corner) {
  const ranges = {
    tl: [0.045, 0.29, 0.045, 0.29],
    tr: [0.71, 0.955, 0.045, 0.29],
    bl: [0.045, 0.29, 0.71, 0.955],
    br: [0.71, 0.955, 0.71, 0.955]
  };
  const [x0, x1, y0, y1] = ranges[corner];
  return {
    minX: width * x0, maxX: width * x1,
    minY: height * y0, maxY: height * y1
  };
}

function detectFinder(gray, width, height, corner) {
  const bounds = finderSearchBounds(width, height, corner);
  const minDim = Math.min(width, height);
  const minCell = minDim / 82;
  const maxCell = minDim / 39;
  const coarseXY = Math.max(2, Math.round(minDim / 160));
  const coarseCell = Math.max(0.5, minDim / 640);
  let best = null;

  for (let cell = minCell; cell <= maxCell + 1e-6; cell += coarseCell) {
    for (let cy = bounds.minY; cy <= bounds.maxY; cy += coarseXY) {
      for (let cx = bounds.minX; cx <= bounds.maxX; cx += coarseXY) {
        const candidate = scoreFinder(gray, width, height, cx, cy, cell);
        if (candidate && (!best || candidate.score > best.score)) best = candidate;
      }
    }
  }

  if (!best) return null;
  return refineFinderDense(gray, width, height, best);
}

function distance(a, b) {
  return Math.hypot(a.cx - b.cx, a.cy - b.cy);
}

function validateFinders(finders) {
  const list = [finders.tl, finders.tr, finders.bl, finders.br];
  if (list.some(f => !f || f.contrast < FINDER_MIN_CONTRAST)) {
    const minContrast = Math.min(...list.filter(Boolean).map(f => f.contrast), 0);
    throw makeError('FINDER', `Finder non agganciati (contrasto ${Math.round(minContrast)})`);
  }

  const cells = list.map(f => f.cell);
  const minCell = Math.min(...cells);
  const maxCell = Math.max(...cells);
  if (maxCell / minCell > 1.65) throw makeError('FINDER', 'Finder con scala incoerente');

  const top = distance(finders.tl, finders.tr);
  const bottom = distance(finders.bl, finders.br);
  const left = distance(finders.tl, finders.bl);
  const right = distance(finders.tr, finders.br);
  const expected = FINDER_GRID_SPAN * ((cells.reduce((a, b) => a + b, 0)) / cells.length);
  for (const span of [top, bottom, left, right]) {
    if (span < expected * 0.62 || span > expected * 1.55) {
      throw makeError('FINDER', 'Geometria finder incoerente');
    }
  }

  const cross1 = (finders.tr.cx - finders.tl.cx) * (finders.bl.cy - finders.tl.cy)
    - (finders.tr.cy - finders.tl.cy) * (finders.bl.cx - finders.tl.cx);
  const cross2 = (finders.br.cx - finders.tr.cx) * (finders.bl.cy - finders.tr.cy)
    - (finders.br.cy - finders.tr.cy) * (finders.bl.cx - finders.tr.cx);
  if (cross1 <= 0 || cross2 <= 0) throw makeError('FINDER', 'Orientamento finder non valido');
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-9) throw makeError('FINDER', 'Trasformazione prospettica degenerata');
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

function homographyFromFour(src, dst) {
  const matrix = [];
  const vector = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    vector.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    vector.push(v);
  }
  const h = solveLinearSystem(matrix, vector);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function mapPoint(h, x, y) {
  const d = h[6] * x + h[7] * y + h[8];
  return [
    (h[0] * x + h[1] * y + h[2]) / d,
    (h[3] * x + h[4] * y + h[5]) / d
  ];
}

function sampleRgb(data, width, height, x, y, radius) {
  const cx = Math.round(x);
  const cy = Math.round(y);
  const r0 = Math.max(0, Math.floor(radius));
  let r = 0, g = 0, b = 0, count = 0;
  for (let yy = Math.max(0, cy - r0); yy <= Math.min(height - 1, cy + r0); yy++) {
    for (let xx = Math.max(0, cx - r0); xx <= Math.min(width - 1, cx + r0); xx++) {
      const offset = (yy * width + xx) * 4;
      r += data[offset];
      g += data[offset + 1];
      b += data[offset + 2];
      count++;
    }
  }
  return [r / count, g / count, b / count];
}

function chroma(rgb) {
  const sum = Math.max(1, rgb[0] + rgb[1] + rgb[2]);
  return [rgb[0] / sum, rgb[1] / sum, rgb[2] / sum];
}

function dist2(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function calibrationQuality(refs) {
  const normalized = refs.map(chroma);
  let minDistance = Infinity;
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      minDistance = Math.min(minDistance, dist2(normalized[i], normalized[j]));
    }
  }
  return minDistance;
}

function averageFinderCell(finders) {
  return (finders.tl.cell + finders.tr.cell + finders.bl.cell + finders.br.cell) / 4;
}

export function detectFrameGeometry(data, width, height) {
  if (width !== height || width < 160) throw makeError('FINDER', 'Analysis canvas must be square and at least 160 px');
  const gray = buildGray(data, width, height);
  const finders = {
    tl: detectFinder(gray, width, height, 'tl'),
    tr: detectFinder(gray, width, height, 'tr'),
    bl: detectFinder(gray, width, height, 'bl'),
    br: detectFinder(gray, width, height, 'br')
  };
  validateFinders(finders);

  const src = [
    [FINDER_CENTER, FINDER_CENTER],
    [FAR_FINDER_CENTER, FINDER_CENTER],
    [FINDER_CENTER, FAR_FINDER_CENTER],
    [FAR_FINDER_CENTER, FAR_FINDER_CENTER]
  ];
  const dst = [
    [finders.tl.cx, finders.tl.cy],
    [finders.tr.cx, finders.tr.cy],
    [finders.bl.cx, finders.bl.cy],
    [finders.br.cx, finders.br.cy]
  ];
  return {
    finders,
    homography: homographyFromFour(src, dst),
    meanCell: averageFinderCell(finders),
    minFinderContrast: Math.min(finders.tl.contrast, finders.tr.contrast, finders.bl.contrast, finders.br.contrast)
  };
}

export function decodeFramePixels(data, width, height, diagnostics = null, geometryHint = null) {
  const geometry = geometryHint || detectFrameGeometry(data, width, height);
  const { homography, meanCell } = geometry;
  const radius = Math.max(1, Math.min(2, Math.round(meanCell * 0.18)));

  const refs = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = mapPoint(homography, 8.5 + i, 1.5);
    refs.push(sampleRgb(data, width, height, x, y, radius));
  }

  const separation = calibrationQuality(refs);
  if (separation < CALIBRATION_MIN_SEPARATION) {
    throw makeError('COLOR', `Colori non separabili (${separation.toFixed(4)})`);
  }

  const normalizedRefs = refs.map(chroma);
  const out = new Uint8Array(CAPACITY_BYTES);
  let bitOffset = 0;
  let distanceSum = 0;
  let marginSum = 0;

  for (const [gx, gy] of DATA_POSITIONS) {
    const [x, y] = mapPoint(homography, gx + 0.5, gy + 0.5);
    const sample = chroma(sampleRgb(data, width, height, x, y, radius));
    let best = 0;
    let bestDistance = Infinity;
    let secondDistance = Infinity;
    for (let i = 0; i < normalizedRefs.length; i++) {
      const d = dist2(sample, normalizedRefs[i]);
      if (d < bestDistance) {
        secondDistance = bestDistance;
        bestDistance = d;
        best = i;
      } else if (d < secondDistance) {
        secondDistance = d;
      }
    }
    distanceSum += bestDistance;
    marginSum += Math.max(0, secondDistance - bestDistance);
    const byteIndex = bitOffset >> 3;
    const shift = 6 - (bitOffset & 7);
    out[byteIndex] |= best << shift;
    bitOffset += 2;
  }

  if (diagnostics) {
    diagnostics.finderContrast = geometry.minFinderContrast;
    diagnostics.colorSeparation = separation;
    diagnostics.meanCell = meanCell;
    diagnostics.meanColorDistance = distanceSum / DATA_POSITIONS.length;
    diagnostics.meanColorMargin = marginSum / DATA_POSITIONS.length;
    diagnostics.finders = geometry.finders;
    diagnostics.geometry = geometry;
  }
  return out;
}

export function decodeFrameFromCanvas(sourceCanvas, diagnostics = null, geometryHint = null) {
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, width, height);
  return decodeFramePixels(image.data, width, height, diagnostics, geometryHint);
}
