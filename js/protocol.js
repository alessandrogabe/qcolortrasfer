import { crc32 } from './crc32.js';

// QCT1 remains readable for backward compatibility with every v1.x transfer.
export const MAGIC = 0x51435431;
export const VERSION = 1;
export const HEADER_BYTES = 96;
export const FLAG_SHA256 = 1;
export const FLAG_COLOR_8 = 2;

// QCT2 moves file metadata into the fountain-protected container instead of
// repeating it in every QR. The optical frame header therefore drops from 96
// bytes to 24 bytes while keeping stream identity, fountain geometry and CRC.
export const MAGIC_V2 = 0x51435432; // "QCT2"
export const VERSION_V2 = 2;
export const HEADER_BYTES_V2 = 24;
export const FLAG_V2_COLOR_8 = 1;
export const FLAG_V2_MONO = 2;

// File container carried by the fountain in QCT2.
export const FILE_MAGIC_V2 = 0x51434632; // "QCF2"
export const FILE_VERSION_V2 = 1;
export const FILE_HEADER_BASE_V2 = 48;
export const MAX_FILE_NAME_BYTES_V2 = 255;

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
  const flags = (meta.sha256 ? FLAG_SHA256 : 0) | (meta.visualStates === 8 ? FLAG_COLOR_8 : 0);
  view.setUint32(0, MAGIC); view.setUint8(4, VERSION); view.setUint8(5, flags); view.setUint16(6, HEADER_BYTES);
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

function decodeOpticalPacketV1(bytes) {
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
  return {
    protocolVersion: 1, containerized: false,
    streamId: view.getUint32(8), symbolId: view.getUint32(12), sourceCount, chunkSize,
    transferLength: fileLength, fileLength, fileName,
    sha256: (flags & FLAG_SHA256) ? bytesToHex(bytes.subarray(60, 92)) : null,
    visualStates: (flags & FLAG_COLOR_8) ? 8 : 4,
    payload: bytes.slice(HEADER_BYTES, end)
  };
}

export function packFileContainerV2(fileName, fileBytes, sha256 = null) {
  if (!(fileBytes instanceof Uint8Array)) throw new TypeError('fileBytes must be Uint8Array');
  if (fileBytes.length > 0xffffffff) throw new Error('File too large for QCF2');
  const nameBytes = utf8Prefix(fileName || 'file.bin', MAX_FILE_NAME_BYTES_V2);
  const headerBytes = FILE_HEADER_BASE_V2 + nameBytes.length;
  const out = new Uint8Array(headerBytes + fileBytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, FILE_MAGIC_V2);
  view.setUint8(4, FILE_VERSION_V2);
  view.setUint8(5, sha256 ? 1 : 0);
  view.setUint16(6, headerBytes);
  view.setUint32(8, fileBytes.length >>> 0);
  view.setUint16(12, nameBytes.length);
  view.setUint16(14, 0);
  if (sha256) out.set(hexToBytes(sha256), 16);
  out.set(nameBytes, FILE_HEADER_BASE_V2);
  out.set(fileBytes, headerBytes);
  return out;
}

export function unpackFileContainerV2(container) {
  if (!(container instanceof Uint8Array) || container.length < FILE_HEADER_BASE_V2) throw new Error('QCF2 container too short');
  const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
  if (view.getUint32(0) !== FILE_MAGIC_V2 || view.getUint8(4) !== FILE_VERSION_V2) throw new Error('Invalid QCF2 container');
  const flags = view.getUint8(5); const headerBytes = view.getUint16(6); const fileLength = view.getUint32(8); const nameLength = view.getUint16(12);
  if (headerBytes !== FILE_HEADER_BASE_V2 + nameLength || headerBytes > container.length) throw new Error('Invalid QCF2 header');
  if (headerBytes + fileLength !== container.length) throw new Error('Invalid QCF2 file length');
  const fileName = decoder.decode(container.subarray(FILE_HEADER_BASE_V2, FILE_HEADER_BASE_V2 + nameLength)) || 'qcolortrasfer.bin';
  return { fileName, fileLength, sha256: (flags & 1) ? bytesToHex(container.subarray(16, 48)) : null, bytes: container.slice(headerBytes) };
}

export function encodeOpticalPacketV2(meta, symbolId, payload) {
  if (!(payload instanceof Uint8Array) || payload.length !== meta.chunkSize) throw new Error('Invalid QCT2 payload');
  if (!Number.isInteger(meta.sourceCount) || meta.sourceCount < 1 || meta.sourceCount > 0xffff) throw new Error('QCT2 source count out of range');
  if (!Number.isInteger(meta.containerLength) || meta.containerLength < 1 || meta.containerLength > 0xffffffff) throw new Error('Invalid QCT2 container length');
  if (![2, 4, 8].includes(meta.visualStates)) throw new Error('Invalid QCT2 visual state count');
  const out = new Uint8Array(HEADER_BYTES_V2 + payload.length + 4);
  const view = new DataView(out.buffer);
  const flags = (meta.visualStates === 8 ? FLAG_V2_COLOR_8 : 0) | (meta.visualStates === 2 ? FLAG_V2_MONO : 0);
  view.setUint32(0, MAGIC_V2); view.setUint8(4, VERSION_V2); view.setUint8(5, flags); view.setUint16(6, HEADER_BYTES_V2);
  view.setUint32(8, meta.streamId >>> 0); view.setUint32(12, symbolId >>> 0); view.setUint16(16, meta.sourceCount); view.setUint16(18, meta.chunkSize); view.setUint32(20, meta.containerLength >>> 0);
  out.set(payload, HEADER_BYTES_V2);
  const end = HEADER_BYTES_V2 + payload.length;
  view.setUint32(end, crc32(out.subarray(0, end)));
  return out;
}

function decodeOpticalPacketV2(bytes) {
  if (bytes.length < HEADER_BYTES_V2 + 4) throw new Error('QCT2 packet too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== MAGIC_V2 || view.getUint8(4) !== VERSION_V2 || view.getUint16(6) !== HEADER_BYTES_V2) throw new Error('Invalid QCT2 header');
  const flags = view.getUint8(5); const sourceCount = view.getUint16(16); const chunkSize = view.getUint16(18); const containerLength = view.getUint32(20);
  if ((flags & FLAG_V2_COLOR_8) && (flags & FLAG_V2_MONO)) throw new Error('Invalid QCT2 visual flags');
  const end = HEADER_BYTES_V2 + chunkSize;
  if (sourceCount < 1 || chunkSize < 1 || containerLength < 1 || bytes.length < end + 4) throw new Error('Invalid QCT2 fountain metadata');
  if (sourceCount !== Math.max(1, Math.ceil(containerLength / chunkSize))) throw new Error('Inconsistent QCT2 source count');
  const expected = view.getUint32(end); const actual = crc32(bytes.subarray(0, end));
  if (expected !== actual) throw new Error('CRC mismatch');
  return {
    protocolVersion: 2, containerized: true,
    streamId: view.getUint32(8), symbolId: view.getUint32(12), sourceCount, chunkSize,
    transferLength: containerLength, containerLength,
    fileLength: null, fileName: null, sha256: null,
    visualStates: (flags & FLAG_V2_MONO) ? 2 : (flags & FLAG_V2_COLOR_8) ? 8 : 4,
    payload: bytes.slice(HEADER_BYTES_V2, end)
  };
}

export function decodeOpticalPacket(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) throw new Error('Packet too short');
  const magic = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (magic === MAGIC_V2) return decodeOpticalPacketV2(bytes);
  if (magic === MAGIC) return decodeOpticalPacketV1(bytes);
  throw new Error('Bad magic');
}
