// Robust LT fountain code adapted from Decimen Optical Transfer v0.3.0 (MIT).
// Original: Copyright (c) 2026 Evan Crawley (Bash Alarmist).
// qcolortrasfer keeps this implementation deterministic across JS engines and
// binds the degree/index PRNG to the QCT1 streamId.

const LN2 = 0.6931471805599453;
const SOLITON_C = 0.1;
const SOLITON_DELTA = 0.5;
const decoderRegistry = new Set();

export function splitmix32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let t = s ^ (s >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

export function dlog(x) {
  let e = 0;
  let m = x;
  while (m >= 1.5) { m /= 2; e++; }
  while (m < 0.75) { m *= 2; e--; }
  const z = (m - 1) / (m + 1);
  const z2 = z * z;
  let term = z;
  let sum = 0;
  for (let n = 1; n <= 21; n += 2) {
    sum += term / n;
    term *= z2;
  }
  return e * LN2 + 2 * sum;
}

export function solitonCdf(k) {
  if (!Number.isInteger(k) || k < 1) throw new Error('Invalid source count');
  const cdf = new Float64Array(k);
  if (k === 1) { cdf[0] = 1; return cdf; }
  const R = Math.max(1, SOLITON_C * dlog(k / SOLITON_DELTA) * Math.sqrt(k));
  const spike = Math.min(k, Math.ceil(k / R));
  let total = 0;
  for (let d = 1; d <= k; d++) {
    const rho = d === 1 ? 1 / k : 1 / (d * (d - 1));
    let tau = 0;
    if (d < spike) tau = R / (d * k);
    else if (d === spike) tau = (R * Math.max(0, dlog(R / SOLITON_DELTA))) / k;
    total += rho + tau;
    cdf[d - 1] = total;
  }
  for (let i = 0; i < k; i++) cdf[i] /= total;
  cdf[k - 1] = 1;
  return cdf;
}

function frameSeed(sessionId, seq) {
  let h = (Math.imul((sessionId >>> 0) + 1, 0x9e3779b1) ^ ((seq >>> 0) + 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) | 0;
}

export function frameIndices(k, cdf, sessionId, seq) {
  const rnd = splitmix32(frameSeed(sessionId, seq));
  const u = rnd() * 2 ** -32;
  let lo = 0;
  let hi = k - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] >= u) hi = mid;
    else lo = mid + 1;
  }
  const degree = Math.min(k, lo + 1);
  if (degree > (k >> 3)) {
    const scratch = new Uint32Array(k);
    for (let i = 0; i < k; i++) scratch[i] = i;
    const out = new Array(degree);
    for (let i = 0; i < degree; i++) {
      const j = i + (rnd() % (k - i));
      const t = scratch[i]; scratch[i] = scratch[j]; scratch[j] = t;
      out[i] = scratch[i];
    }
    return out;
  }
  const selected = new Set();
  while (selected.size < degree) selected.add(rnd() % k);
  return [...selected];
}

export function indicesForSymbol(symbolId, sourceCount, sessionId = 0) {
  return frameIndices(sourceCount, solitonCdf(sourceCount), sessionId >>> 0, symbolId >>> 0);
}

function xorInto(dst, src) {
  for (let i = 0; i < dst.length; i++) dst[i] = (dst[i] ^ src[i]) >>> 0;
}

export class FountainEncoder {
  constructor(bytes, chunkSize = 512, sessionId = 0) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be Uint8Array');
    if (!Number.isInteger(chunkSize) || chunkSize < 32 || chunkSize > 65535) throw new Error('Invalid chunk size');
    this.length = bytes.length;
    this.chunkSize = chunkSize;
    this.sessionId = sessionId >>> 0;
    this.sourceCount = Math.max(1, Math.ceil(bytes.length / chunkSize));
    this.words = Math.ceil(chunkSize / 4);
    this.blocks = new Uint32Array(this.sourceCount * this.words);
    const blockBytes = new Uint8Array(this.blocks.buffer);
    for (let b = 0; b < this.sourceCount; b++) {
      const src = bytes.subarray(b * chunkSize, Math.min((b + 1) * chunkSize, bytes.length));
      blockBytes.set(src, b * this.words * 4);
    }
    this.cdf = solitonCdf(this.sourceCount);
  }

  sourceBlock(blockIndex) {
    if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= this.sourceCount) throw new Error('Source block index out of range');
    const out = new Uint8Array(this.chunkSize);
    const source = new Uint8Array(this.blocks.buffer, blockIndex * this.words * 4, this.chunkSize);
    out.set(source);
    return out;
  }

  symbol(symbolId) {
    const indices = frameIndices(this.sourceCount, this.cdf, this.sessionId, symbolId >>> 0);
    const out = new Uint32Array(this.words);
    for (const block of indices) {
      const offset = block * this.words;
      for (let w = 0; w < this.words; w++) out[w] = (out[w] ^ this.blocks[offset + w]) >>> 0;
    }
    return { symbolId: symbolId >>> 0, indices, data: new Uint8Array(out.buffer, 0, this.chunkSize) };
  }
}

export class FountainDecoder {
  constructor(sourceCount, chunkSize, fileLength, sessionId = 0) {
    if (!Number.isInteger(sourceCount) || sourceCount < 1) throw new Error('Invalid source count');
    if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('Invalid chunk size');
    if (!Number.isSafeInteger(fileLength) || fileLength < 0) throw new Error('Invalid file length');
    this.sourceCount = sourceCount;
    this.chunkSize = chunkSize;
    this.fileLength = fileLength;
    this.sessionId = sessionId >>> 0;
    this.words = Math.ceil(chunkSize / 4);
    this.cdf = solitonCdf(sourceCount);
    this.solved = new Array(sourceCount).fill(null);
    this.byBlock = new Map();
    this.seenSymbols = new Set();
    this.solvedCount = 0;
    this.framesNew = 0;
    this.framesDup = 0;
    this.createdAt = globalThis.performance?.now?.() ?? Date.now();
    decoderRegistry.add(this);
  }

  get complete() { return this.solvedCount >= this.sourceCount; }
  get progress() { return this.sourceCount ? this.solvedCount / this.sourceCount : 0; }

  addSymbol(symbolId, data) {
    symbolId >>>= 0;
    if (!(data instanceof Uint8Array) || data.length !== this.chunkSize) return false;
    if (this.seenSymbols.has(symbolId)) { this.framesDup++; return false; }
    this.seenSymbols.add(symbolId);
    this.framesNew++;
    if (this.complete) return true;
    const idx = new Set(frameIndices(this.sourceCount, this.cdf, this.sessionId, symbolId));
    const words = new Uint32Array(this.words);
    new Uint8Array(words.buffer).set(data.subarray(0, this.chunkSize));
    for (const block of [...idx]) {
      const solved = this.solved[block];
      if (solved) { xorInto(words, solved); idx.delete(block); }
    }
    if (idx.size === 0) return true;
    if (idx.size === 1) { this.#resolve(idx.values().next().value, words); return true; }
    const pending = { idx, words };
    for (const block of idx) {
      let waiting = this.byBlock.get(block);
      if (!waiting) { waiting = new Set(); this.byBlock.set(block, waiting); }
      waiting.add(pending);
    }
    return true;
  }

  injectSourceBlock(blockIndex, data) {
    if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= this.sourceCount) return false;
    if (!(data instanceof Uint8Array) || data.length !== this.chunkSize) return false;
    if (this.solved[blockIndex]) return false;
    const words = new Uint32Array(this.words);
    new Uint8Array(words.buffer).set(data);
    this.#resolve(blockIndex, words);
    return true;
  }

  #resolve(firstBlock, firstWords) {
    const queue = [[firstBlock, firstWords]];
    while (queue.length) {
      const [block, words] = queue.pop();
      if (this.solved[block]) continue;
      this.solved[block] = words;
      this.solvedCount++;
      const waiting = this.byBlock.get(block);
      if (!waiting) continue;
      this.byBlock.delete(block);
      for (const pending of waiting) {
        xorInto(pending.words, words);
        pending.idx.delete(block);
        if (pending.idx.size === 1) {
          const remaining = pending.idx.values().next().value;
          this.byBlock.get(remaining)?.delete(pending);
          if (!this.solved[remaining]) queue.push([remaining, pending.words]);
        }
      }
    }
  }

  reconstruct() {
    if (!this.complete) throw new Error('Fountain decode is incomplete');
    const out = new Uint8Array(this.fileLength);
    for (let block = 0; block < this.sourceCount; block++) {
      const start = block * this.chunkSize;
      const len = Math.min(this.chunkSize, this.fileLength - start);
      if (len > 0) out.set(new Uint8Array(this.solved[block].buffer, 0, len), start);
    }
    return out;
  }
}

export function findCompatibleFountainDecoder(sourceCount, chunkSize, fileLength, minCreatedAt = -Infinity) {
  let best = null;
  for (const decoder of decoderRegistry) {
    if (decoder.sourceCount !== sourceCount || decoder.chunkSize !== chunkSize || decoder.fileLength !== fileLength) continue;
    if (decoder.createdAt < minCreatedAt) continue;
    if (!best || decoder.createdAt > best.createdAt) best = decoder;
  }
  return best;
}
