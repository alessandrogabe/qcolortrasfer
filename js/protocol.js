import { crc32 } from './crc32.js';
export const MAGIC = 0x51435431;
export const VERSION = 1;
export const HEADER_BYTES = 96;
export const FLAG_SHA256 = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function writeU64(view, offset, value) {
  const big = BigInt(value);
  view.setUint32(offset, Number((big >> 32n) & 0xffffffffn));
  view.setUint32(offset + 4, Number(big & 0xffffffffn));
}
function readU64(view, offset) { return Number((BigInt(view.getUint32(offset)) << 32n) | BigInt(view.getUint32(offset + 4))); }
function hexToBytes(hex) {
  if (!hex || hex.length !== 64) return new Uint8Array(32);
  return Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}
function bytesToHex(bytes) { return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
function utf8Prefix(text, maxBytes) {
  let result = new Uint8Array();
  for (const char of text) {
    const next = encoder.encode(char);
    if (result.length + next.length > maxBytes) break;
    const joined = new Uint8Array(result.length + next.length);
    joined.set(result); joined.set(next, result.length); result = joined;
  }
  return result;
}
export function randomStreamId() { const array = new Uint32Array(1); crypto.getRandomValues(array); return array[0] >>> 0; }
export async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function encodeOpticalPacket(meta, symbolId, payload) {
  if (payload.length > 65535) throw new Error('Payload too large');
  const out = new Uint8Array(HEADER_BYTES + payload.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC); view.setUint8(4, VERSION); view.setUint8(5, meta.sha256 ? FLAG_SHA256 : 0); view.setUint16(6, HEADER_BYTES);
  view.setUint32(8, meta.streamId >>> 0); view.setUint32(12, symbolId >>> 0); view.setUint32(16, meta.sourceCount >>> 0); view.setUint16(20, meta.chunkSize); view.setUint16(22, payload.length);
  writeU64(view, 24, meta.fileLength);
  const nameBytes = utf8Prefix(meta.fileName || 'file.bin', 27);
  view.setUint8(32, nameBytes.length); out.set(nameBytes, 33);
  if (meta.sha256) out.set(hexToBytes(meta.sha256), 60);
  out.set(payload, HEADER_BYTES);
  const end = HEADER_BYTES + payload.length;
  view.setUint32(end, crc32(out.subarray(0, end)));
  return out;
}
export function decodeOpticalPacket(bytes) {
  if (bytes.length < HEADER_BYTES + 4) throw new Error('Packet too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== MAGIC) throw new Error('Bad magic');
  if (view.getUint8(4) !== VERSION) throw new Error('Unsupported protocol version');
  if (view.getUint16(6) !== HEADER_BYTES) throw new Error('Bad header size');
  const flags = view.getUint8(5); const payloadLength = view.getUint16(22); const end = HEADER_BYTES + payloadLength;
  if (bytes.length < end + 4) throw new Error('Truncated packet');
  const expected = view.getUint32(end); const actual = crc32(bytes.subarray(0, end));
  if (actual !== expected) throw new Error('CRC mismatch');
  const sourceCount = view.getUint32(16); const chunkSize = view.getUint16(20); const fileLength = readU64(view, 24);
  if (sourceCount < 1 || chunkSize < 1 || payloadLength !== chunkSize) throw new Error('Invalid fountain metadata');
  if (!Number.isSafeInteger(fileLength) || fileLength < 0) throw new Error('Invalid file length');
  if (sourceCount !== Math.max(1, Math.ceil(fileLength / chunkSize))) throw new Error('Inconsistent source count');
  const nameLength = Math.min(view.getUint8(32), 27);
  const fileName = decoder.decode(bytes.subarray(33, 33 + nameLength)) || 'file.bin';
  return { streamId: view.getUint32(8), symbolId: view.getUint32(12), sourceCount, chunkSize, fileLength, fileName, sha256: (flags & FLAG_SHA256) ? bytesToHex(bytes.subarray(60, 92)) : null, payload: bytes.slice(HEADER_BYTES, end) };
}
