import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeOpticalPacket, decodeOpticalPacket } from '../js/protocol.js';

test('packet round trip', () => {
  const meta = { streamId: 123, sourceCount: 9, chunkSize: 32, fileLength: 257, fileName: 'demo.bin', sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' };
  const payload = Uint8Array.from({ length: 32 }, (_, i) => i);
  const decoded = decodeOpticalPacket(encodeOpticalPacket(meta, 14, payload));
  assert.equal(decoded.streamId, 123);
  assert.equal(decoded.symbolId, 14);
  assert.equal(decoded.sourceCount, 9);
  assert.equal(decoded.fileName, 'demo.bin');
  assert.equal(decoded.sha256, meta.sha256);
  assert.deepEqual(decoded.payload, payload);
});

test('CRC rejects corruption', () => {
  const meta = { streamId: 1, sourceCount: 1, chunkSize: 4, fileLength: 4, fileName: 'x', sha256: '0'.repeat(64) };
  const packet = encodeOpticalPacket(meta, 0, Uint8Array.of(1, 2, 3, 4));
  packet[packet.length - 5] ^= 0xff;
  assert.throws(() => decodeOpticalPacket(packet), /CRC mismatch/);
});
