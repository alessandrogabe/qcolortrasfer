import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUX2_PACKET_BYTES, AUX2_STRIPE_BYTES, AuxRepairAssembler,
  decodeAuxRepairPacket, encodeAuxRepairPacketV2, qar2EquationMask
} from '../js/aux-repair.js';

function blockOf(size){const b=new Uint8Array(size);for(let i=0;i<size;i++)b[i]=(i*73+19)&255;return b;}
const meta={auxSessionId:0x12345678,sourceCount:297,chunkSize:2925,containerLength:866123};

test('QAR2 uses a fixed compact 256-byte repair envelope',()=>{
  const packet=encodeAuxRepairPacketV2(meta,17,0,blockOf(meta.chunkSize));
  assert.equal(packet.length,AUX2_PACKET_BYTES);
  const decoded=decodeAuxRepairPacket(packet);
  assert.equal(decoded.protocol,'QAR2');
  assert.equal(decoded.stripeSize,AUX2_STRIPE_BYTES);
  assert.equal(decoded.stripeCount,12);
  assert.equal(decoded.equationMask,1);
});

test('QAR2 parity masks continue after systematic equations',()=>{
  const n=12;
  for(let i=0;i<n;i++)assert.equal(qar2EquationMask(n,i,123),1<<i);
  const masks=new Set(Array.from({length:24},(_,i)=>qar2EquationMask(n,n+i,123)));
  assert.ok(masks.size>12);
  for(const mask of masks)assert.ok(mask>0&&mask<(1<<n));
});

test('QAR2 mini-fountain completes a block despite dropped helper symbols',()=>{
  const block=blockOf(meta.chunkSize),assembler=new AuxRepairAssembler();
  let completed=null;
  // Deliberately drop several systematic symbols and one third of all later
  // repair equations. Enough independent equations must still recover block 17.
  for(let repair=0;repair<120&&!completed;repair++){
    if([2,5,8,10].includes(repair)||repair%3===1)continue;
    completed=assembler.add(encodeAuxRepairPacketV2(meta,17,repair,block));
  }
  assert.ok(completed,'repair equations should reach full rank');
  assert.equal(completed.blockIndex,17);
  assert.deepEqual(completed.block,block);
  assert.equal(assembler.blocksCompleted,1);
  assert.ok(assembler.rankPeak>=12);
});

test('QAR2 CRC rejects a damaged optical packet',()=>{
  const packet=encodeAuxRepairPacketV2(meta,3,22,blockOf(meta.chunkSize));
  packet[80]^=0xff;
  assert.throws(()=>decodeAuxRepairPacket(packet),/CRC/);
});
