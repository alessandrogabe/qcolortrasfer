import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeOpticalPacket, decodeOpticalPacket, HEADER_BYTES } from '../js/protocol.js';

test('packet round trip preserves metadata, full SHA-256 and payload', () => {
  const meta = { streamId: 123, sourceCount: 9, chunkSize: 32, fileLength: 257, fileName: 'demo-è.bin', sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' };
  const payload = Uint8Array.from({ length: 32 }, (_, i) => i); const decoded = decodeOpticalPacket(encodeOpticalPacket(meta, 14, payload));
  assert.equal(decoded.streamId, 123); assert.equal(decoded.symbolId, 14); assert.equal(decoded.sourceCount, 9); assert.equal(decoded.fileName, 'demo-è.bin'); assert.equal(decoded.sha256, meta.sha256); assert.deepEqual(decoded.payload, payload);
});
test('packet supports explicit absence of SHA-256', () => { const meta = { streamId: 1, sourceCount: 1, chunkSize: 32, fileLength: 3, fileName: 'x', sha256: null }; assert.equal(decodeOpticalPacket(encodeOpticalPacket(meta, 0, new Uint8Array(32))).sha256, null); });
test('CRC rejects corruption', () => { const meta = { streamId: 1, sourceCount: 1, chunkSize: 32, fileLength: 4, fileName: 'x', sha256: '0'.repeat(64) }; const packet = encodeOpticalPacket(meta, 0, new Uint8Array(32)); packet[HEADER_BYTES + 2] ^= 0xff; assert.throws(() => decodeOpticalPacket(packet), /CRC mismatch/); });
test('metadata consistency is validated', () => { const meta = { streamId: 1, sourceCount: 3, chunkSize: 32, fileLength: 4, fileName: 'x', sha256: null }; const packet = encodeOpticalPacket(meta, 0, new Uint8Array(32)); assert.throws(() => decodeOpticalPacket(packet), /Inconsistent source count/); });
