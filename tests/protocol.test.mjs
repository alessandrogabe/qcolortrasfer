import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeOpticalPacket, encodeOpticalPacketV2, decodeOpticalPacket,
  packFileContainerV2, unpackFileContainerV2,
  HEADER_BYTES, HEADER_BYTES_V2, FLAG_COLOR_8, FLAG_V2_COLOR_8
} from '../js/protocol.js';

test('QCT1 legacy packet round trip remains readable', () => {
  const meta = { streamId: 123, sourceCount: 9, chunkSize: 32, fileLength: 257, fileName: 'demo-è.bin', sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', visualStates: 4 };
  const payload = Uint8Array.from({ length: 32 }, (_, i) => i); const decoded = decodeOpticalPacket(encodeOpticalPacket(meta, 14, payload));
  assert.equal(decoded.protocolVersion, 1); assert.equal(decoded.streamId, 123); assert.equal(decoded.symbolId, 14); assert.equal(decoded.sourceCount, 9); assert.equal(decoded.fileName, 'demo-è.bin'); assert.equal(decoded.sha256, meta.sha256); assert.equal(decoded.visualStates, 4); assert.deepEqual(decoded.payload, payload);
});

test('QCT1 CRC still rejects corruption', () => {
  const meta = { streamId: 1, sourceCount: 1, chunkSize: 32, fileLength: 4, fileName: 'x', sha256: '0'.repeat(64), visualStates: 4 };
  const packet = encodeOpticalPacket(meta, 0, new Uint8Array(32)); packet[HEADER_BYTES + 2] ^= 0xff; assert.throws(() => decodeOpticalPacket(packet), /CRC mismatch/);
});

test('QCF2 container preserves filename, bytes and SHA once per transfer', () => {
  const bytes = Uint8Array.from({ length: 4096 }, (_, i) => (i * 29 + 7) & 255); const sha = 'ab'.repeat(32);
  const packed = packFileContainerV2('foto-è.jpg', bytes, sha); const unpacked = unpackFileContainerV2(packed);
  assert.equal(unpacked.fileName, 'foto-è.jpg'); assert.equal(unpacked.sha256, sha); assert.equal(unpacked.fileLength, bytes.length); assert.deepEqual(unpacked.bytes, bytes);
});

test('QCT2 compact packet uses 24-byte header and round-trips fountain metadata', () => {
  const chunkSize = 2925; const containerLength = 5000; const sourceCount = Math.ceil(containerLength / chunkSize);
  const meta = { streamId: 0x12345678, sourceCount, chunkSize, containerLength, visualStates: 4 };
  const payload = Uint8Array.from({ length: chunkSize }, (_, i) => i & 255); const packet = encodeOpticalPacketV2(meta, 77, payload); const decoded = decodeOpticalPacket(packet);
  assert.equal(HEADER_BYTES_V2, 24); assert.equal(packet.length, 2953); assert.equal(decoded.protocolVersion, 2); assert.equal(decoded.containerized, true); assert.equal(decoded.streamId, meta.streamId); assert.equal(decoded.symbolId, 77); assert.equal(decoded.transferLength, containerLength); assert.equal(decoded.chunkSize, chunkSize); assert.deepEqual(decoded.payload, payload);
});

test('QCT2 CRC rejects corruption', () => {
  const chunkSize = 64, containerLength = 64; const meta = { streamId: 1, sourceCount: 1, chunkSize, containerLength, visualStates: 4 };
  const packet = encodeOpticalPacketV2(meta, 0, new Uint8Array(chunkSize)); packet[HEADER_BYTES_V2 + 1] ^= 0xff; assert.throws(() => decodeOpticalPacket(packet), /CRC mismatch/);
});

test('8-state flags remain distinct in QCT1 and QCT2', () => {
  const qct1 = encodeOpticalPacket({streamId:1,sourceCount:1,chunkSize:32,fileLength:3,fileName:'x',sha256:null,visualStates:8},0,new Uint8Array(32));
  assert.ok(qct1[5] & FLAG_COLOR_8); assert.equal(decodeOpticalPacket(qct1).visualStates, 8);
  const qct2 = encodeOpticalPacketV2({streamId:1,sourceCount:1,chunkSize:32,containerLength:3,visualStates:8},0,new Uint8Array(32));
  assert.ok(qct2[5] & FLAG_V2_COLOR_8); assert.equal(decodeOpticalPacket(qct2).visualStates, 8);
});

test('QCT2 source-count consistency is validated', () => {
  assert.throws(() => encodeOpticalPacketV2({streamId:1,sourceCount:2,chunkSize:32,containerLength:3,visualStates:4},0,new Uint8Array(31)), /Invalid QCT2 payload/);
});
