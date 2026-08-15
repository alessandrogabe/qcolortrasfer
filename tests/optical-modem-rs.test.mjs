import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeOpticalPacket } from '../js/protocol.js';
import { MODEM_PAYLOAD_CELLS } from '../js/optical-modem-codec.js';
import {
  RS_N,RS_K,RS_T,RS_BLOCKS,RS_DATA_BYTES,RS_CODE_BYTES,
  rsEncodeBlock,rsDecodeBlock,rsEncodeInterleaved,rsDecodeInterleaved
} from '../js/optical-modem-rs.js';
import {
  MODEM_RS_VERSION,MODEM_RS_PACKET_BYTES,MODEM_RS_CHUNK_BYTES,MODEM_RS_CODE_CELLS,
  encodeRsModemPacket,packetToRsModemStates,rsModemStatesToPacket
} from '../js/optical-modem-rs-codec.js';

function deterministicBytes(n,seed=17){return Uint8Array.from({length:n},(_,i)=>(i*73+seed*29+(i>>>3)*11)&255);}
function samplePacket(symbolId=77){const payload=deterministicBytes(MODEM_RS_CHUNK_BYTES,symbolId),containerLength=MODEM_RS_CHUNK_BYTES*4+123,meta={streamId:0x13572468,sourceCount:Math.ceil(containerLength/MODEM_RS_CHUNK_BYTES),chunkSize:MODEM_RS_CHUNK_BYTES,containerLength,visualStates:4};return{packet:encodeRsModemPacket(meta,symbolId,payload),payload,meta};}

test('RS255/191 constants fit the four-color modem and keep 150 KiB/s target feasible',()=>{
  assert.equal(RS_N,255);assert.equal(RS_K,191);assert.equal(RS_T,32);assert.equal(RS_BLOCKS,18);assert.equal(RS_DATA_BYTES,3438);assert.equal(RS_CODE_BYTES,4590);
  assert.equal(MODEM_RS_VERSION,3);assert.equal(MODEM_RS_PACKET_BYTES,3438);assert.equal(MODEM_RS_CHUNK_BYTES,3410);assert.equal(MODEM_RS_CODE_CELLS,18360);assert.ok(MODEM_RS_CODE_CELLS<=MODEM_PAYLOAD_CELLS);assert.ok(MODEM_RS_CHUNK_BYTES*60/1024>195);
});

test('one strong RS block corrects thirty-two arbitrary byte errors',()=>{
  const data=deterministicBytes(RS_K,5),code=rsEncodeBlock(data);for(let i=0;i<RS_T;i++){const pos=(i*37+11)%RS_N;code[pos]^=(i*19+1)&255||1;}const decoded=rsDecodeBlock(code);assert.deepEqual(decoded.data,data);assert.equal(decoded.corrected,RS_T);
});

test('byte-interleaved strong RS spreads a severe spatial burst across independent blocks',()=>{
  const data=deterministicBytes(RS_DATA_BYTES,9),code=rsEncodeInterleaved(data);
  // 540 adjacent coded bytes become exactly 30 byte errors in each of the 18
  // independent RS words, below the 32-symbol correction radius.
  for(let i=1260;i<1800;i++)code[i]^=((i*13)&255)||0x5a;
  const decoded=rsDecodeInterleaved(code);assert.deepEqual(decoded.data,data);assert.equal(decoded.corrected,540);
});

test('RS modem packet round-trips through four-state cells and QCT2 CRC',()=>{
  const{packet}=samplePacket(77),states=packetToRsModemStates(packet),decoded=rsModemStatesToPacket(states);assert.deepEqual(decoded.bytes,packet);assert.equal(decoded.corrected,0);const q=decodeOpticalPacket(decoded.bytes);assert.equal(q.symbolId,77);assert.equal(q.chunkSize,MODEM_RS_CHUNK_BYTES);
});
