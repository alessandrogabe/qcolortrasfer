import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeOpticalPacket, decodeOpticalPacket, HEADER_BYTES, FLAG_COLOR_8 } from '../js/protocol.js';

test('8-state flag round-trips without changing QCT1 version',()=>{
  const meta={streamId:123,sourceCount:1,chunkSize:1024,fileLength:1000,fileName:'x.bin',sha256:'ab'.repeat(32),visualStates:8};
  const packet=encodeOpticalPacket(meta,7,new Uint8Array(1024));
  assert.ok(packet[5]&FLAG_COLOR_8);
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
