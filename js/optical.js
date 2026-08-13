export const GRID = 48;
export const PALETTE = [
  { name: 'red', css: '#ef3340', rgb: [239, 51, 64] },
  { name: 'green', css: '#00a651', rgb: [0, 166, 81] },
  { name: 'blue', css: '#1877f2', rgb: [24, 119, 242] },
  { name: 'yellow', css: '#ffd400', rgb: [255, 212, 0] }
];

function inFinder(x, y) {
  const s = 7;
  const tl = x < s && y < s;
  const tr = x >= GRID - s && y < s;
  const bl = x < s && y >= GRID - s;
  const br = x >= GRID - s && y >= GRID - s;
  return tl || tr || bl || br;
}

function reserved(x, y) {
  if (x === 0 || y === 0 || x === GRID - 1 || y === GRID - 1) return true;
  if (inFinder(x, y)) return true;
  if (y === 1 && x >= 8 && x < 12) return true;
  return false;
}

export const DATA_POSITIONS = (() => {
  const positions = [];
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) if (!reserved(x, y)) positions.push([x, y]);
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
  const size = Math.min(canvas.clientWidth || 768, canvas.clientHeight || canvas.clientWidth || 768);
  const physical = Math.max(480, Math.floor(size * (devicePixelRatio || 1)));
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

function dist2(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function sample(ctx, sx, sy, sw, sh, gx, gy) {
  const px = sx + (gx + 0.5) * sw / GRID;
  const py = sy + (gy + 0.5) * sh / GRID;
  const radius = Math.max(1, Math.floor(Math.min(sw, sh) / GRID * 0.18));
  const image = ctx.getImageData(Math.floor(px - radius), Math.floor(py - radius), radius * 2 + 1, radius * 2 + 1).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < image.length; i += 4) { r += image[i]; g += image[i + 1]; b += image[i + 2]; n++; }
  return [r / n, g / n, b / n];
}

export function decodeFrameFromCanvas(sourceCanvas, crop = null) {
  const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const sx = crop?.x ?? 0;
  const sy = crop?.y ?? 0;
  const sw = crop?.size ?? sourceCanvas.width;
  const sh = crop?.size ?? sourceCanvas.height;
  const refs = [];
  for (let i = 0; i < 4; i++) refs.push(sample(ctx, sx, sy, sw, sh, 8 + i, 1));

  const out = new Uint8Array(CAPACITY_BYTES);
  let bitOffset = 0;
  for (const [x, y] of DATA_POSITIONS) {
    const rgb = sample(ctx, sx, sy, sw, sh, x, y);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < refs.length; i++) {
      const d = dist2(rgb, refs[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    const byteIndex = bitOffset >> 3;
    const shift = 6 - (bitOffset & 7);
    out[byteIndex] |= best << shift;
    bitOffset += 2;
  }
  return out;
}
