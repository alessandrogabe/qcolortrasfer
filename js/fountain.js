function xorInto(target, source) {
  for (let i = 0; i < target.length; i++) target[i] ^= source[i];
}
function xorshift32(seed) {
  let x = seed >>> 0 || 0x9e3779b9;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0; };
}
function degreeFor(random, k) {
  if (k <= 1) return 1;
  const r = random() % 100;
  if (r < 20) return 1;
  if (r < 56) return Math.min(2, k);
  if (r < 78) return Math.min(3, k);
  if (r < 90) return Math.min(4, k);
  if (r < 97) return Math.min(5, k);
  return Math.min(8, k);
}
export function indicesForSymbol(symbolId, sourceCount) {
  if (!Number.isInteger(symbolId) || symbolId < 0) throw new Error('Invalid symbol id');
  if (!Number.isInteger(sourceCount) || sourceCount < 1) throw new Error('Invalid source count');
  if (symbolId < sourceCount) return [symbolId];
  const random = xorshift32((symbolId ^ Math.imul(sourceCount, 0x45d9f3b)) >>> 0);
  const degree = degreeFor(random, sourceCount);
  const selected = new Set();
  while (selected.size < degree) selected.add(random() % sourceCount);
  return [...selected].sort((a, b) => a - b);
}
export class FountainEncoder {
  constructor(bytes, chunkSize = 320) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be Uint8Array');
    if (!Number.isInteger(chunkSize) || chunkSize < 32 || chunkSize > 65535) throw new Error('Invalid chunk size');
    this.length = bytes.length;
    this.chunkSize = chunkSize;
    this.sourceCount = Math.max(1, Math.ceil(bytes.length / chunkSize));
    this.blocks = Array.from({ length: this.sourceCount }, (_, index) => {
      const block = new Uint8Array(chunkSize);
      block.set(bytes.subarray(index * chunkSize, Math.min(bytes.length, (index + 1) * chunkSize)));
      return block;
    });
  }
  symbol(symbolId) {
    const indices = indicesForSymbol(symbolId, this.sourceCount);
    const data = new Uint8Array(this.chunkSize);
    for (const index of indices) xorInto(data, this.blocks[index]);
    return { symbolId, indices, data };
  }
}
export class FountainDecoder {
  constructor(sourceCount, chunkSize, fileLength) {
    if (!Number.isInteger(sourceCount) || sourceCount < 1) throw new Error('Invalid source count');
    if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('Invalid chunk size');
    if (!Number.isSafeInteger(fileLength) || fileLength < 0) throw new Error('Invalid file length');
    this.sourceCount = sourceCount; this.chunkSize = chunkSize; this.fileLength = fileLength;
    this.solved = new Map(); this.equations = new Map(); this.seenSymbols = new Set();
  }
  get solvedCount() { return this.solved.size; }
  get complete() { return this.solved.size === this.sourceCount; }
  get progress() { return this.sourceCount ? this.solved.size / this.sourceCount : 0; }
  addSymbol(symbolId, data) {
    if (!(data instanceof Uint8Array) || data.length !== this.chunkSize) return false;
    if (this.seenSymbols.has(symbolId)) return false;
    this.seenSymbols.add(symbolId);
    const indices = new Set(indicesForSymbol(symbolId, this.sourceCount));
    const payload = new Uint8Array(data);
    for (const [index, solved] of this.solved) if (indices.delete(index)) xorInto(payload, solved);
    if (!indices.size) return false;
    this.equations.set(symbolId, { indices, data: payload });
    this.#peel();
    return true;
  }
  #peel() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, equation] of [...this.equations]) {
        if (equation.indices.size !== 1) continue;
        const index = equation.indices.values().next().value;
        this.equations.delete(id);
        if (this.solved.has(index)) continue;
        const solvedData = equation.data;
        this.solved.set(index, solvedData);
        changed = true;
        for (const [otherId, other] of [...this.equations]) {
          if (!other.indices.delete(index)) continue;
          xorInto(other.data, solvedData);
          if (!other.indices.size) this.equations.delete(otherId);
        }
      }
    }
  }
  reconstruct() {
    if (!this.complete) throw new Error('Fountain decode is incomplete');
    const joined = new Uint8Array(this.sourceCount * this.chunkSize);
    for (let i = 0; i < this.sourceCount; i++) joined.set(this.solved.get(i), i * this.chunkSize);
    return joined.subarray(0, this.fileLength);
  }
}
