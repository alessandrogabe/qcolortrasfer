export const GRID = 48;
export const ANALYSIS_CELL_PX = 5;
export const ANALYSIS_SIZE = GRID * ANALYSIS_CELL_PX;
export const PALETTE = [{ name: 'red', css: '#ef3340' }, { name: 'green', css: '#00a651' }, { name: 'blue', css: '#1877f2' }, { name: 'yellow', css: '#ffd400' }];
function inFinder(x, y) { const s = 7; return (x < s && y < s) || (x >= GRID - s && y < s) || (x < s && y >= GRID - s) || (x >= GRID - s && y >= GRID - s); }
function reserved(x, y) { if (x === 0 || y === 0 || x === GRID - 1 || y === GRID - 1) return true; if (inFinder(x, y)) return true; if (y === 1 && x >= 8 && x < 12) return true; return false; }
export const DATA_POSITIONS = (() => { const positions = []; for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) if (!reserved(x, y)) positions.push([x, y]); return positions; })();
export const CAPACITY_BYTES = Math.floor(DATA_POSITIONS.length * 2 / 8);
function drawFinder(ctx, x0, y0, cell) { ctx.fillStyle = '#000'; ctx.fillRect(x0 * cell, y0 * cell, 7 * cell, 7 * cell); ctx.fillStyle = '#fff'; ctx.fillRect((x0 + 1) * cell, (y0 + 1) * cell, 5 * cell, 5 * cell); ctx.fillStyle = '#000'; ctx.fillRect((x0 + 2) * cell, (y0 + 2) * cell, 3 * cell, 3 * cell); }
export function renderFrame(canvas, bytes) {
  if (bytes.length > CAPACITY_BYTES) throw new Error(`Optical payload exceeds ${CAPACITY_BYTES} bytes`);
  const cssSize = Math.max(320, Math.floor(Math.min(canvas.clientWidth || 768, canvas.clientHeight || canvas.clientWidth || 768)));
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2); const physical = Math.max(480, Math.floor(cssSize * ratio));
  canvas.width = physical; canvas.height = physical;
  const ctx = canvas.getContext('2d', { alpha: false }); const cell = physical / GRID; ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, physical, physical); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, physical, cell); ctx.fillRect(0, physical - cell, physical, cell); ctx.fillRect(0, 0, cell, physical); ctx.fillRect(physical - cell, 0, cell, physical);
  drawFinder(ctx, 0, 0, cell); drawFinder(ctx, GRID - 7, 0, cell); drawFinder(ctx, 0, GRID - 7, cell); drawFinder(ctx, GRID - 7, GRID - 7, cell);
  for (let i = 0; i < 4; i++) { ctx.fillStyle = PALETTE[i].css; ctx.fillRect((8 + i) * cell, cell, cell, cell); }
  let bitOffset = 0;
  for (const [x, y] of DATA_POSITIONS) { const byteIndex = bitOffset >> 3; const shift = 6 - (bitOffset & 7); const value = byteIndex < bytes.length ? ((bytes[byteIndex] >> shift) & 0b11) : 0; ctx.fillStyle = PALETTE[value].css; ctx.fillRect(x * cell, y * cell, Math.ceil(cell), Math.ceil(cell)); bitOffset += 2; }
}
function averageCell(data, width, gx, gy) {
  const cell = width / GRID; const cx = Math.floor((gx + 0.5) * cell); const cy = Math.floor((gy + 0.5) * cell); const radius = Math.max(1, Math.floor(cell * 0.23));
  let r = 0, g = 0, b = 0, count = 0;
  for (let y = Math.max(0, cy - radius); y <= Math.min(width - 1, cy + radius); y++) for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x++) { const offset = (y * width + x) * 4; r += data[offset]; g += data[offset + 1]; b += data[offset + 2]; count++; }
  return [r / count, g / count, b / count];
}
function chroma(rgb) { const sum = Math.max(1, rgb[0] + rgb[1] + rgb[2]); return [rgb[0] / sum, rgb[1] / sum, rgb[2] / sum]; }
function dist2(a, b) { const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2]; return dr * dr + dg * dg + db * db; }
function calibrationQuality(refs) { const normalized = refs.map(chroma); let minDistance = Infinity; for (let i = 0; i < normalized.length; i++) for (let j = i + 1; j < normalized.length; j++) minDistance = Math.min(minDistance, dist2(normalized[i], normalized[j])); return minDistance; }
export function decodeFrameFromCanvas(sourceCanvas) {
  const width = sourceCanvas.width; const height = sourceCanvas.height;
  if (width !== height || width < GRID) throw new Error('Analysis canvas must be square');
  const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true }); const image = ctx.getImageData(0, 0, width, height);
  const refs = []; for (let i = 0; i < 4; i++) refs.push(averageCell(image.data, width, 8 + i, 1));
  if (calibrationQuality(refs) < 0.018) throw new Error('Color calibration not separable');
  const normalizedRefs = refs.map(chroma); const out = new Uint8Array(CAPACITY_BYTES); let bitOffset = 0;
  for (const [x, y] of DATA_POSITIONS) { const sample = chroma(averageCell(image.data, width, x, y)); let best = 0, bestDistance = Infinity; for (let i = 0; i < normalizedRefs.length; i++) { const distance = dist2(sample, normalizedRefs[i]); if (distance < bestDistance) { bestDistance = distance; best = i; } } const byteIndex = bitOffset >> 3; const shift = 6 - (bitOffset & 7); out[byteIndex] |= best << shift; bitOffset += 2; }
  return out;
}
