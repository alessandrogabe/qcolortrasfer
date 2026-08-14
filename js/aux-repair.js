import { crc32 } from './crc32.js';

// QAR1 = qcolor AUX Repair v1.
// Small systematic stripes travel in a second, low-density QR next to the
// Decimen-style main QR. A completed source block can be injected directly into
// the main LT peeling decoder, potentially resolving several pending equations.
export const AUX_MAGIC = 0x51415231; // "QAR1"
export const AUX_VERSION = 1;
export const AUX_HEADER_BYTES = 32;
export const AUX_STRIPE_BYTES = 512;

export function isAuxRepairPacket(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) return false;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) === AUX_MAGIC;
}

export function encodeAuxRepairPacket(meta, blockIndex, stripeIndex, blockBytes) {
  if (!(blockBytes instanceof Uint8Array) || blockBytes.length !== meta.chunkSize) throw new Error('AUX source block size mismatch');
  if (!Number.isInteger(meta.sourceCount) || meta.sourceCount < 1 || meta.sourceCount > 0xffff) throw new Error('AUX source count out of range');
  if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= meta.sourceCount) throw new Error('AUX block index out of range');
  const stripeSize = Math.max(64, Math.min(2048, Number(meta.stripeSize) || AUX_STRIPE_BYTES));
  const stripeCount = Math.ceil(meta.chunkSize / stripeSize);
  if (!Number.isInteger(stripeIndex) || stripeIndex < 0 || stripeIndex >= stripeCount || stripeCount > 255) throw new Error('AUX stripe index out of range');
  const start = stripeIndex * stripeSize;
  const payload = blockBytes.subarray(start, Math.min(meta.chunkSize, start + stripeSize));
  const out = new Uint8Array(AUX_HEADER_BYTES + payload.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, AUX_MAGIC);
  view.setUint8(4, AUX_VERSION);
  view.setUint8(5, 0);
  view.setUint16(6, AUX_HEADER_BYTES);
  view.setUint32(8, meta.auxSessionId >>> 0);
  view.setUint16(12, meta.sourceCount);
  view.setUint16(14, blockIndex);
  view.setUint16(16, meta.chunkSize);
  view.setUint8(18, stripeIndex);
  view.setUint8(19, stripeCount);
  view.setUint16(20, payload.length);
  view.setUint16(22, stripeSize);
  view.setUint32(24, meta.containerLength >>> 0);
  view.setUint32(28, crc32(blockBytes));
  out.set(payload, AUX_HEADER_BYTES);
  const end = AUX_HEADER_BYTES + payload.length;
  view.setUint32(end, crc32(out.subarray(0, end)));
  return out;
}

export function decodeAuxRepairPacket(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < AUX_HEADER_BYTES + 4) throw new Error('AUX packet too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== AUX_MAGIC || view.getUint8(4) !== AUX_VERSION || view.getUint16(6) !== AUX_HEADER_BYTES) throw new Error('Invalid AUX header');
  const sourceCount = view.getUint16(12);
  const blockIndex = view.getUint16(14);
  const chunkSize = view.getUint16(16);
  const stripeIndex = view.getUint8(18);
  const stripeCount = view.getUint8(19);
  const payloadLength = view.getUint16(20);
  const stripeSize = view.getUint16(22);
  const containerLength = view.getUint32(24);
  const blockCrc32 = view.getUint32(28);
  const end = AUX_HEADER_BYTES + payloadLength;
  if (sourceCount < 1 || blockIndex >= sourceCount || chunkSize < 1 || stripeSize < 1 || stripeCount < 1 || stripeIndex >= stripeCount || containerLength < 1) throw new Error('Invalid AUX metadata');
  if (stripeCount !== Math.ceil(chunkSize / stripeSize)) throw new Error('Inconsistent AUX stripe count');
  const expectedPayload = Math.min(stripeSize, chunkSize - stripeIndex * stripeSize);
  if (payloadLength !== expectedPayload || bytes.length < end + 4) throw new Error('Invalid AUX payload length');
  const expectedCrc = view.getUint32(end);
  const actualCrc = crc32(bytes.subarray(0, end));
  if (expectedCrc !== actualCrc) throw new Error('AUX packet CRC mismatch');
  return {
    protocol: 'QAR1',
    auxSessionId: view.getUint32(8),
    sourceCount, blockIndex, chunkSize, stripeIndex, stripeCount, stripeSize,
    containerLength, blockCrc32,
    payload: bytes.slice(AUX_HEADER_BYTES, end),
  };
}

export class AuxRepairAssembler {
  constructor() { this.reset(); }
  reset() {
    this.blocks = new Map();
    this.completed = new Set();
    this.packetsNew = 0;
    this.packetsDup = 0;
    this.blocksCompleted = 0;
    this.crcFailures = 0;
  }
  add(packet) {
    const p = packet instanceof Uint8Array ? decodeAuxRepairPacket(packet) : packet;
    const blockKey = `${p.auxSessionId}:${p.sourceCount}:${p.chunkSize}:${p.containerLength}:${p.blockIndex}`;
    if (this.completed.has(blockKey)) { this.packetsDup++; return null; }
    let entry = this.blocks.get(blockKey);
    if (!entry) {
      entry = {
        ...p,
        stripes: new Array(p.stripeCount).fill(null),
        seen: 0,
      };
      this.blocks.set(blockKey, entry);
    }
    if (entry.stripeCount !== p.stripeCount || entry.stripeSize !== p.stripeSize || entry.blockCrc32 !== p.blockCrc32) throw new Error('AUX block metadata changed mid-stream');
    if (entry.stripes[p.stripeIndex]) { this.packetsDup++; return null; }
    entry.stripes[p.stripeIndex] = p.payload;
    entry.seen++;
    this.packetsNew++;
    if (entry.seen !== entry.stripeCount) return null;

    const block = new Uint8Array(entry.chunkSize);
    for (let i = 0; i < entry.stripeCount; i++) block.set(entry.stripes[i], i * entry.stripeSize);
    if (crc32(block) !== entry.blockCrc32) {
      this.crcFailures++;
      this.blocks.delete(blockKey);
      return null;
    }
    this.blocks.delete(blockKey);
    this.completed.add(blockKey);
    this.blocksCompleted++;
    return {
      auxSessionId: entry.auxSessionId,
      sourceCount: entry.sourceCount,
      chunkSize: entry.chunkSize,
      containerLength: entry.containerLength,
      blockIndex: entry.blockIndex,
      block,
    };
  }
}
