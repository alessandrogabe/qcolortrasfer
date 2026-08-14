import { crc32 } from './crc32.js';

// QAR1 remains readable for backward compatibility with cached v2.6/v2.7
// senders. QAR2 is the production helper protocol from v2.8: smaller 256-byte
// stripes plus independent GF(2) repair equations. Losing one helper QR no
// longer makes every other stripe of that source block useless.
export const AUX_MAGIC = 0x51415231; // "QAR1"
export const AUX_MAGIC_V2 = 0x51415232; // "QAR2"
export const AUX_VERSION = 1;
export const AUX_VERSION_V2 = 2;
export const AUX_HEADER_BYTES = 32;
export const AUX_STRIPE_BYTES = 512;
export const AUX2_HEADER_BYTES = 40;
export const AUX2_STRIPE_BYTES = 256;
export const AUX2_MAX_STRIPES = 16;
export const AUX2_PACKET_BYTES = AUX2_HEADER_BYTES + AUX2_STRIPE_BYTES + 4;

function magicOf(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return 0;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
}

export function isAuxRepairPacket(bytes) {
  const magic = magicOf(bytes);
  return magic === AUX_MAGIC || magic === AUX_MAGIC_V2;
}

function validateSourceMeta(meta, blockIndex, blockBytes) {
  if (!(blockBytes instanceof Uint8Array) || blockBytes.length !== meta.chunkSize) throw new Error('AUX source block size mismatch');
  if (!Number.isInteger(meta.sourceCount) || meta.sourceCount < 1 || meta.sourceCount > 0xffff) throw new Error('AUX source count out of range');
  if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= meta.sourceCount) throw new Error('AUX block index out of range');
}

// Legacy systematic QAR1 encoder.
export function encodeAuxRepairPacket(meta, blockIndex, stripeIndex, blockBytes) {
  validateSourceMeta(meta, blockIndex, blockBytes);
  const stripeSize = Math.max(64, Math.min(2048, Number(meta.stripeSize) || AUX_STRIPE_BYTES));
  const stripeCount = Math.ceil(meta.chunkSize / stripeSize);
  if (!Number.isInteger(stripeIndex) || stripeIndex < 0 || stripeIndex >= stripeCount || stripeCount > 255) throw new Error('AUX stripe index out of range');
  const start = stripeIndex * stripeSize;
  const payload = blockBytes.subarray(start, Math.min(meta.chunkSize, start + stripeSize));
  const out = new Uint8Array(AUX_HEADER_BYTES + payload.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, AUX_MAGIC);
  view.setUint8(4, AUX_VERSION);
  view.setUint8(5, 0);
  view.setUint16(6, AUX_HEADER_BYTES);
  view.setUint32(8, meta.auxSessionId >>> 0);
  view.setUint16(12, meta.sourceCount);
  view.setUint16(14, blockIndex);
  view.setUint16(16, meta.chunkSize);
  view.setUint8(18, stripeIndex);
  view.setUint8(19, stripeCount);
  view.setUint16(20, payload.length);
  view.setUint16(22, stripeSize);
  view.setUint32(24, meta.containerLength >>> 0);
  view.setUint32(28, crc32(blockBytes));
  out.set(payload, AUX_HEADER_BYTES);
  const end = AUX_HEADER_BYTES + payload.length;
  view.setUint32(end, crc32(out.subarray(0, end)));
  return out;
}

function xorshift32(value) {
  let x = value >>> 0;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  return x >>> 0;
}

export function qar2EquationMask(stripeCount, repairIndex, seed = 0) {
  const n = Math.floor(Number(stripeCount) || 0);
  const index = Math.floor(Number(repairIndex) || 0);
  if (n < 1 || n > AUX2_MAX_STRIPES || index < 0) throw new Error('QAR2 equation parameters out of range');
  if (index < n) return 1 << index; // systematic first pass

  let state = (seed ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(n, 0x85ebca6b)) >>> 0;
  state = xorshift32(state || 0x6d2b79f5);
  const roll = state % 100;
  const degree = Math.min(n, roll < 58 ? 2 : roll < 88 ? 3 : 4);
  let mask = 0;
  while (popcount16(mask) < degree) {
    state = xorshift32(state || 0xa341316c);
    mask |= 1 << (state % n);
  }
  return mask & 0xffff;
}

function popcount16(value) {
  let v = value & 0xffff, count = 0;
  while (v) { v &= v - 1; count++; }
  return count;
}

function sourceStripe(blockBytes, stripeSize, stripeIndex) {
  const out = new Uint8Array(stripeSize);
  const start = stripeIndex * stripeSize;
  out.set(blockBytes.subarray(start, Math.min(blockBytes.length, start + stripeSize)));
  return out;
}

function xorInto(target, source) {
  for (let i = 0; i < target.length; i++) target[i] ^= source[i];
}

export function encodeAuxRepairPacketV2(meta, blockIndex, repairIndex, blockBytes) {
  validateSourceMeta(meta, blockIndex, blockBytes);
  const stripeSize = AUX2_STRIPE_BYTES;
  const stripeCount = Math.ceil(meta.chunkSize / stripeSize);
  if (stripeCount < 1 || stripeCount > AUX2_MAX_STRIPES) throw new Error('QAR2 source block needs too many stripes');
  const seed = (meta.auxSessionId ^ Math.imul(blockIndex + 1, 0x27d4eb2d)) >>> 0;
  const equationMask = qar2EquationMask(stripeCount, repairIndex, seed);
  const payload = new Uint8Array(stripeSize);
  for (let stripe = 0; stripe < stripeCount; stripe++) {
    if (equationMask & (1 << stripe)) xorInto(payload, sourceStripe(blockBytes, stripeSize, stripe));
  }

  const out = new Uint8Array(AUX2_PACKET_BYTES);
  const view = new DataView(out.buffer);
  view.setUint32(0, AUX_MAGIC_V2);
  view.setUint8(4, AUX_VERSION_V2);
  view.setUint8(5, 0);
  view.setUint16(6, AUX2_HEADER_BYTES);
  view.setUint32(8, meta.auxSessionId >>> 0);
  view.setUint16(12, meta.sourceCount);
  view.setUint16(14, blockIndex);
  view.setUint16(16, meta.chunkSize);
  view.setUint8(18, stripeCount);
  view.setUint8(19, popcount16(equationMask));
  view.setUint16(20, stripeSize);
  view.setUint16(22, equationMask);
  view.setUint32(24, repairIndex >>> 0);
  view.setUint32(28, meta.containerLength >>> 0);
  view.setUint32(32, crc32(blockBytes));
  view.setUint16(36, payload.length);
  view.setUint16(38, 0);
  out.set(payload, AUX2_HEADER_BYTES);
  view.setUint32(AUX2_HEADER_BYTES + payload.length, crc32(out.subarray(0, AUX2_HEADER_BYTES + payload.length)));
  return out;
}

function decodeQar1(bytes) {
  if (bytes.length < AUX_HEADER_BYTES + 4) throw new Error('AUX packet too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(4) !== AUX_VERSION || view.getUint16(6) !== AUX_HEADER_BYTES) throw new Error('Invalid AUX header');
  const sourceCount=view.getUint16(12), blockIndex=view.getUint16(14), chunkSize=view.getUint16(16);
  const stripeIndex=view.getUint8(18), stripeCount=view.getUint8(19), payloadLength=view.getUint16(20), stripeSize=view.getUint16(22);
  const containerLength=view.getUint32(24), blockCrc32=view.getUint32(28), end=AUX_HEADER_BYTES+payloadLength;
  if(sourceCount<1||blockIndex>=sourceCount||chunkSize<1||stripeSize<1||stripeCount<1||stripeIndex>=stripeCount||containerLength<1) throw new Error('Invalid AUX metadata');
  if(stripeCount!==Math.ceil(chunkSize/stripeSize)) throw new Error('Inconsistent AUX stripe count');
  const expectedPayload=Math.min(stripeSize,chunkSize-stripeIndex*stripeSize);
  if(payloadLength!==expectedPayload||bytes.length<end+4) throw new Error('Invalid AUX payload length');
  if(view.getUint32(end)!==crc32(bytes.subarray(0,end))) throw new Error('AUX packet CRC mismatch');
  return {protocol:'QAR1',auxSessionId:view.getUint32(8),sourceCount,blockIndex,chunkSize,stripeIndex,stripeCount,stripeSize,containerLength,blockCrc32,payload:bytes.slice(AUX_HEADER_BYTES,end)};
}

function decodeQar2(bytes) {
  if (bytes.length < AUX2_PACKET_BYTES) throw new Error('QAR2 packet too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if(view.getUint8(4)!==AUX_VERSION_V2||view.getUint16(6)!==AUX2_HEADER_BYTES) throw new Error('Invalid QAR2 header');
  const sourceCount=view.getUint16(12),blockIndex=view.getUint16(14),chunkSize=view.getUint16(16);
  const stripeCount=view.getUint8(18),degree=view.getUint8(19),stripeSize=view.getUint16(20),equationMask=view.getUint16(22);
  const repairIndex=view.getUint32(24),containerLength=view.getUint32(28),blockCrc32=view.getUint32(32),payloadLength=view.getUint16(36);
  const end=AUX2_HEADER_BYTES+payloadLength;
  if(sourceCount<1||blockIndex>=sourceCount||chunkSize<1||containerLength<1) throw new Error('Invalid QAR2 metadata');
  if(stripeSize!==AUX2_STRIPE_BYTES||stripeCount!==Math.ceil(chunkSize/stripeSize)||stripeCount>AUX2_MAX_STRIPES) throw new Error('Invalid QAR2 stripe geometry');
  const allowedMask=(1<<stripeCount)-1;
  if(!equationMask||(equationMask&~allowedMask)||degree!==popcount16(equationMask)) throw new Error('Invalid QAR2 equation');
  if(payloadLength!==stripeSize||bytes.length<end+4) throw new Error('Invalid QAR2 payload length');
  if(view.getUint32(end)!==crc32(bytes.subarray(0,end))) throw new Error('QAR2 packet CRC mismatch');
  return {protocol:'QAR2',auxSessionId:view.getUint32(8),sourceCount,blockIndex,chunkSize,stripeCount,stripeSize,equationMask,degree,repairIndex,containerLength,blockCrc32,payload:bytes.slice(AUX2_HEADER_BYTES,end)};
}

export function decodeAuxRepairPacket(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('AUX packet must be Uint8Array');
  const magic=magicOf(bytes);
  if(magic===AUX_MAGIC) return decodeQar1(bytes);
  if(magic===AUX_MAGIC_V2) return decodeQar2(bytes);
  throw new Error('Invalid AUX magic');
}

function lowestBitIndex(mask) {
  for(let i=0;i<16;i++) if(mask&(1<<i)) return i;
  return -1;
}

export class AuxRepairAssembler {
  constructor(){this.reset();}
  reset(){
    this.blocks=new Map(); this.completed=new Set();
    this.packetsNew=0; this.packetsDup=0; this.blocksCompleted=0; this.crcFailures=0;
    this.equationsRedundant=0; this.rankPeak=0; this.rankTotal=0;
  }

  add(packet) {
    const p=packet instanceof Uint8Array?decodeAuxRepairPacket(packet):packet;
    return p.protocol==='QAR2'?this.addQar2(p):this.addQar1(p);
  }

  addQar1(p) {
    const blockKey=`1:${p.auxSessionId}:${p.sourceCount}:${p.chunkSize}:${p.containerLength}:${p.blockIndex}`;
    if(this.completed.has(blockKey)){this.packetsDup++;return null;}
    let entry=this.blocks.get(blockKey);
    if(!entry){entry={...p,stripes:new Array(p.stripeCount).fill(null),seen:0};this.blocks.set(blockKey,entry);}
    if(entry.stripeCount!==p.stripeCount||entry.stripeSize!==p.stripeSize||entry.blockCrc32!==p.blockCrc32) throw new Error('AUX block metadata changed mid-stream');
    if(entry.stripes[p.stripeIndex]){this.packetsDup++;return null;}
    entry.stripes[p.stripeIndex]=p.payload; entry.seen++; this.packetsNew++;
    if(entry.seen!==entry.stripeCount)return null;
    const block=new Uint8Array(entry.chunkSize);
    for(let i=0;i<entry.stripeCount;i++)block.set(entry.stripes[i],i*entry.stripeSize);
    return this.finishBlock(blockKey,entry,block);
  }

  addQar2(p) {
    const blockKey=`2:${p.auxSessionId}:${p.sourceCount}:${p.chunkSize}:${p.containerLength}:${p.blockIndex}`;
    if(this.completed.has(blockKey)){this.packetsDup++;return null;}
    let entry=this.blocks.get(blockKey);
    if(!entry){entry={...p,basis:new Array(p.stripeCount).fill(null),rank:0,seenRepair:new Set()};this.blocks.set(blockKey,entry);}
    if(entry.stripeCount!==p.stripeCount||entry.stripeSize!==p.stripeSize||entry.blockCrc32!==p.blockCrc32) throw new Error('QAR2 block metadata changed mid-stream');
    if(entry.seenRepair.has(p.repairIndex)){this.packetsDup++;return null;}
    entry.seenRepair.add(p.repairIndex);

    let mask=p.equationMask;
    const data=p.payload.slice();
    for(let pivot=0;pivot<entry.stripeCount;pivot++) {
      const row=entry.basis[pivot];
      if((mask&(1<<pivot))&&row){mask^=row.mask;xorInto(data,row.data);}
    }
    this.packetsNew++;
    if(mask===0){this.equationsRedundant++;return null;}
    const pivot=lowestBitIndex(mask);
    const newRow={mask,data};
    for(let i=0;i<entry.stripeCount;i++) {
      const row=entry.basis[i];
      if(row&&(row.mask&(1<<pivot))){row.mask^=mask;xorInto(row.data,data);}
    }
    entry.basis[pivot]=newRow; entry.rank++;
    this.rankPeak=Math.max(this.rankPeak,entry.rank);
    this.rankTotal=[...this.blocks.values()].reduce((sum,item)=>sum+(item.rank||0),0);
    if(entry.rank!==entry.stripeCount)return null;

    const block=new Uint8Array(entry.chunkSize);
    for(let i=0;i<entry.stripeCount;i++) {
      const row=entry.basis[i];
      if(!row||row.mask!==(1<<i)) throw new Error('QAR2 basis did not reduce to identity');
      block.set(row.data.subarray(0,Math.min(entry.stripeSize,entry.chunkSize-i*entry.stripeSize)),i*entry.stripeSize);
    }
    return this.finishBlock(blockKey,entry,block);
  }

  finishBlock(blockKey,entry,block) {
    if(crc32(block)!==entry.blockCrc32){this.crcFailures++;this.blocks.delete(blockKey);return null;}
    this.blocks.delete(blockKey); this.completed.add(blockKey); this.blocksCompleted++;
    this.rankTotal=[...this.blocks.values()].reduce((sum,item)=>sum+(item.rank||0),0);
    return {auxSessionId:entry.auxSessionId,sourceCount:entry.sourceCount,chunkSize:entry.chunkSize,containerLength:entry.containerLength,blockIndex:entry.blockIndex,block};
  }
}
