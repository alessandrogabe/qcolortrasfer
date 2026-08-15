import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeOpticalPacket } from '../js/protocol.js';
import {
  MODEM_CHUNK_BYTES, MODEM_FEC_PERMUTATION, encodeModemPacket,
  packetToModemStates, modemStatesToPacket
} from '../js/optical-modem-codec.js';
import { repairModemPacketWithCrc } from '../js/optical-modem-crc-repair.js';

function samplePacket(symbolId=44){
  const payload=Uint8Array.from({length:MODEM_CHUNK_BYTES},(_,i)=>(i*43+symbolId*29)&255),containerLength=MODEM_CHUNK_BYTES*3+91;
  const meta={streamId:0xabcdef12,sourceCount:Math.ceil(containerLength/MODEM_CHUNK_BYTES),chunkSize:MODEM_CHUNK_BYTES,containerLength,visualStates:4};
  return encodeModemPacket(meta,symbolId,payload);
}

function flipCodedBit(states,codedIndex){
  const scrambledIndex=(codedIndex*MODEM_FEC_PERMUTATION)%(Math.ceil(3460*8/11)*15);
  const cell=Math.floor(scrambledIndex/2),which=scrambledIndex&1;
  states[cell]^=which?1:2;
  return cell;
}
function crcValid(bytes){try{decodeOpticalPacket(bytes);return true;}catch{return false;}}

test('CRC list repair restores one Hamming word containing two optical bit errors',()=>{
  const packet=samplePacket(44),states=packetToModemStates(packet),confidence=new Float32Array(states.length).fill(.4);
  const word=120,base=word*15,cells=[flipCodedBit(states,base+3),flipCodedBit(states,base+11)];for(const c of cells)confidence[c]=.0001;
  const baseline=modemStatesToPacket(states);assert.equal(crcValid(baseline.bytes),false,'ordinary Hamming must miscorrect this double-error word');
  const repaired=repairModemPacketWithCrc(states,confidence,baseline.bytes);assert.ok(repaired?.packet);assert.deepEqual(repaired.bytes,packet);assert.equal(repaired.listWords,1);
});

test('CRC list repair restores two low-confidence double-error words',()=>{
  const packet=samplePacket(45),states=packetToModemStates(packet),confidence=new Float32Array(states.length).fill(.5);
  for(const [word,a,b] of [[75,2,9],[810,4,13]]){const base=word*15;confidence[flipCodedBit(states,base+a)]=.0001;confidence[flipCodedBit(states,base+b)]=.0001;}
  const baseline=modemStatesToPacket(states);assert.equal(crcValid(baseline.bytes),false);
  const repaired=repairModemPacketWithCrc(states,confidence,baseline.bytes,{maxDoubleWords:8});assert.ok(repaired?.packet);assert.deepEqual(repaired.bytes,packet);assert.equal(repaired.listWords,2);
});
