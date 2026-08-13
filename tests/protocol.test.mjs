import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeOpticalPacket, decodeOpticalPacket, HEADER_BYTES, FLAG_COLOR_8 } from '../js/protocol.js';

test('packet round trip preserves metadata, full SHA-256 and payload', () => {
  const meta = { streamId: 123, sourceCount: 9, chunkSize: 32, fileLength: 257, fileName: 'demo-è.bin', sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', visualStates: 4 };
  const payload = Uint8Array.from({ length: 32 }, (_, i) => i); const decoded = decodeOpticalPacket(encodeOpticalPacket(meta, 14, payload));
  assert.equal(decoded.streamId, 123); assert.equal(decoded.symbolId, 14); assert.equal(decoded.sourceCount, 9); assert.equal(decoded.fileName, 'demo-è.bin'); assert.equal(decoded.sha256, meta.sha256); assert.equal(decoded.visualStates, 4); assert.deepEqual(decoded.payload, payload);
});

test('packet supports explicit absence of SHA-256', () => {
  const meta = { streamId: 1, sourceCount: 1, chunkSize: 32, fileLength: 3, fileName: 'x', sha256: null, visualStates: 4 };
  assert.equal(decodeOpticalPacket(encodeOpticalPacket(meta, 0, new Uint8Array(32))).sha256, null);
});

test('CRC rejects corruption', () => {
  const meta = { streamId: 1, sourceCount: 1, chunkSize: 32, fileLength: 4, fileName: 'x', sha256: '0'.repeat(64), visualStates: 4 };
  const packet = encodeOpticalPacket(meta, 0, new Uint8Array(32)); packet[HEADER_BYTES + 2] ^= 0xff; assert.throws(() => decodeOpticalPacket(packet), /CRC mismatch/);
});

test('metadata consistency is validated', () => {
  const meta = { streamId: 1, sourceCount: 3, chunkSize: 32, fileLength: 4, fileName: 'x', sha256: null, visualStates: 4 };
  const packet = encodeOpticalPacket(meta, 0, new Uint8Array(32)); assert.throws(() => decodeOpticalPacket(packet), /Inconsistent source count/);
});

test('8-state flag round-trips without changing QCT1 version',()=>{
  const meta={streamId:123,sourceCount:1,chunkSize:1024,fileLength:1000,fileName:'x.bin',sha256:'ab'.repeat(32),visualStates:8};
  const packet=encodeOpticalPacket(meta,7,new Uint8Array(1024)); assert.ok(packet[5]&FLAG_COLOR_8);
  const decoded=decodeOpticalPacket(packet); assert.equal(decoded.visualStates,8); assert.equal(decoded.symbolId,7); assert.equal(decoded.chunkSize,1024);
});

test('4-state is backward-compatible default when flag is absent',()=>{
  const meta={streamId:1,sourceCount:1,chunkSize:512,fileLength:3,fileName:'x',sha256:null,visualStates:4};
  const decoded=decodeOpticalPacket(encodeOpticalPacket(meta,0,new Uint8Array(512))); assert.equal(decoded.visualStates,4);
});

test('1280-byte payload still fits packet envelope under configured 1465-byte optical ceiling',()=>{
  const meta={streamId:1,sourceCount:1,chunkSize:1280,fileLength:1280,fileName:'x',sha256:null,visualStates:8};
  const packet=encodeOpticalPacket(meta,0,new Uint8Array(1280)); assert.equal(packet.length,HEADER_BYTES+1280+4); assert.ok(packet.length<=1465);
});
