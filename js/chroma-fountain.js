// qcolortrasfer MAIN COLOR optical codec v3.1 (MIT).
//
// A MAIN COLOR frame is a real QR V40-L in luminance. Every non-reserved QR
// module additionally carries one chroma bit in the same physical cell:
//   dark + chroma0 = red,   dark + chroma1 = blue
//   light + chroma0 = magenta, light + chroma1 = cyan
// Finder/timing/alignment/format/version modules remain pure B/W. Therefore a
// camera that loses chroma still sees an ordinary standards-valid QR.
//
// The chroma plane is not a second QR. It is a native fountain packet protected
// by interleaved Hamming(15,11) plus the normal QCT2 CRC. Both luma and chroma
// packets use the same 2678-byte fountain geometry and can feed one decoder.

import { crc32 } from './crc32.js';
import { encodeOpticalPacketV2, MAGIC_V2 } from './protocol.js';

export const CHROMA_VERSION = 40;
export const CHROMA_MODULES = 177;
export const CHROMA_QUIET = 4;
export const CHROMA_RASTER = CHROMA_MODULES + CHROMA_QUIET * 2;
export const CHROMA_QR_ECC = 'L';
export const CHROMA_QR_MASK = 4;
export const CHROMA_CALIBRATION_CELLS = 128;
export const CHROMA_V40_DATA_MODULES = 29648;
export const CHROMA_PAYLOAD_CELLS = CHROMA_V40_DATA_MODULES - CHROMA_CALIBRATION_CELLS;
export const CHROMA_CHUNK_BYTES = 2678;
export const CHROMA_QCT_PACKET_BYTES = 24 + CHROMA_CHUNK_BYTES + 4;
export const CHROMA_RAW_BITS = CHROMA_QCT_PACKET_BYTES * 8;
export const CHROMA_HAMMING_WORDS = CHROMA_RAW_BITS / 11;
export const CHROMA_CODE_BITS = CHROMA_HAMMING_WORDS * 15;
export const CHROMA_CODE_CELLS = CHROMA_CODE_BITS;
export const CHROMA_BIT_PERMUTATION = 7919;
export const FLAG_V2_NATIVE_CHROMA = 4;

// Indexes: dark0, dark1, light0, light1. No yellow by design.
export const CHROMA_PALETTE = Object.freeze([
  Object.freeze([150, 20, 20]),    // dark red: chroma 0
  Object.freeze([0, 55, 145]),     // dark blue: chroma 1
  Object.freeze([245, 180, 195]),  // light magenta: chroma 0
  Object.freeze([100, 235, 245]),  // light cyan: chroma 1
]);
const DATA_POSITIONS = Object.freeze([3,5,6,7,9,10,11,12,13,14,15]);

if (!Number.isInteger(CHROMA_HAMMING_WORDS) ||
    CHROMA_CODE_CELLS !== CHROMA_PAYLOAD_CELLS) {
  throw new Error('MAIN COLOR capacity constants are inconsistent');
}

let qrPromise = null;
let templatePromise = null;

async function getQrCode() {
  if (!qrPromise) qrPromise = import('https://esm.sh/qrcode@1.5.4?bundle').then(mod => mod.default || mod);
  return qrPromise;
}

function bitAt(bytes,index){return(bytes[index>>3]>>(7-(index&7)))&1;}
function setBit(bytes,index,value){if(value)bytes[index>>3]|=1<<(7-(index&7));}

export function hammingEncodeBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Hamming input must be Uint8Array');
  const rawBits=bytes.length*8,words=Math.ceil(rawBits/11),out=new Uint8Array(words*15);
  let src=0;
  for(let word=0;word<words;word++){
    const bits=new Uint8Array(16);
    for(const position of DATA_POSITIONS)bits[position]=src<rawBits?bitAt(bytes,src++):0;
    for(const parity of [1,2,4,8]){
      let value=0;
      for(let position=1;position<=15;position++)if(position!==parity&&(position&parity))value^=bits[position];
      bits[parity]=value;
    }
    for(let position=1;position<=15;position++)out[word*15+position-1]=bits[position];
  }
  return out;
}

export function hammingDecodeBits(coded,expectedBytes) {
  if (!(coded instanceof Uint8Array)) throw new TypeError('Hamming code must be Uint8Array');
  const expectedBits=Math.max(0,Math.floor(Number(expectedBytes)||0))*8,words=Math.ceil(expectedBits/11);
  if(coded.length<words*15)throw new Error('Truncated Hamming code');
  const out=new Uint8Array(expectedBytes);let dst=0,corrected=0;
  for(let word=0;word<words;word++){
    const bits=new Uint8Array(16);let syndrome=0;
    for(let position=1;position<=15;position++){
      const value=coded[word*15+position-1]&1;bits[position]=value;if(value)syndrome^=position;
    }
    if(syndrome>=1&&syndrome<=15){bits[syndrome]^=1;corrected++;}
    for(const position of DATA_POSITIONS){if(dst>=expectedBits)break;setBit(out,dst++,bits[position]);}
  }
  return{bytes:out,corrected};
}

function scrambleBits(coded){
  const n=coded.length,out=new Uint8Array(n);
  for(let i=0;i<n;i++)out[(i*CHROMA_BIT_PERMUTATION)%n]=coded[i]&1;
  return out;
}
function unscrambleBits(scrambled){
  const n=scrambled.length,out=new Uint8Array(n);
  for(let i=0;i<n;i++)out[i]=scrambled[(i*CHROMA_BIT_PERMUTATION)%n]&1;
  return out;
}

export function packetToChromaStates(packet) {
  if (!(packet instanceof Uint8Array) || packet.length!==CHROMA_QCT_PACKET_BYTES)
    throw new Error(`MAIN COLOR packet must be exactly ${CHROMA_QCT_PACKET_BYTES} B`);
  const coded=hammingEncodeBytes(packet);
  if(coded.length!==CHROMA_CODE_BITS)throw new Error('Unexpected MAIN COLOR Hamming length');
  return scrambleBits(coded);
}

export function chromaStatesToPacket(states) {
  if (!(states instanceof Uint8Array) || states.length!==CHROMA_CODE_CELLS)
    throw new Error(`MAIN COLOR chroma bit count must be ${CHROMA_CODE_CELLS}`);
  for(const state of states)if(state>1)throw new Error('Invalid MAIN COLOR chroma bit');
  return hammingDecodeBits(unscrambleBits(states),CHROMA_QCT_PACKET_BYTES);
}

export function encodeChromaOpticalPacket(meta,symbolId,payload) {
  const packet=encodeOpticalPacketV2({...meta,visualStates:2},symbolId,payload);
  packet[5]|=FLAG_V2_NATIVE_CHROMA;
  const end=packet.length-4;
  new DataView(packet.buffer,packet.byteOffset,packet.byteLength).setUint32(end,crc32(packet.subarray(0,end)));
  return packet;
}

export function isNativeChromaPacket(bytes) {
  if(!(bytes instanceof Uint8Array)||bytes.length<8)return false;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  return view.getUint32(0)===MAGIC_V2&&Boolean(bytes[5]&FLAG_V2_NATIVE_CHROMA);
}

export async function prepareChromaTemplate() {
  if(!templatePromise)templatePromise=(async()=>{
    const QRCode=await getQrCode();
    const qr=QRCode.create([{data:Uint8Array.of(0),mode:'byte'}],{
      version:CHROMA_VERSION,errorCorrectionLevel:CHROMA_QR_ECC,maskPattern:CHROMA_QR_MASK
    });
    if(qr.modules.size!==CHROMA_MODULES||typeof qr.modules.isReserved!=='function')
      throw new Error('V40 reserved-module template unavailable');
    const total=CHROMA_MODULES*CHROMA_MODULES,reserved=new Uint8Array(total),dataIndices=[];
    for(let y=0;y<CHROMA_MODULES;y++)for(let x=0;x<CHROMA_MODULES;x++){
      const index=y*CHROMA_MODULES+x,isReserved=qr.modules.isReserved(y,x);
      reserved[index]=isReserved?1:0;if(!isReserved)dataIndices.push(index);
    }
    if(dataIndices.length!==CHROMA_V40_DATA_MODULES)
      throw new Error(`V40 data-module count ${dataIndices.length} != ${CHROMA_V40_DATA_MODULES}`);
    const calibration=new Map(),calibrationEntries=[];
    for(let i=0;i<CHROMA_CALIBRATION_CELLS;i++){
      let at=Math.floor((i+.5)*dataIndices.length/CHROMA_CALIBRATION_CELLS);
      at=Math.max(0,Math.min(dataIndices.length-1,at));
      while(calibration.has(dataIndices[at])&&at+1<dataIndices.length)at++;
      const moduleIndex=dataIndices[at],state=i&1;
      calibration.set(moduleIndex,state);
      calibrationEntries.push({moduleIndex,state,x:moduleIndex%CHROMA_MODULES,y:Math.floor(moduleIndex/CHROMA_MODULES)});
    }
    const payloadPositions=dataIndices.filter(index=>!calibration.has(index)).map(index=>({
      moduleIndex:index,x:index%CHROMA_MODULES,y:Math.floor(index/CHROMA_MODULES)
    }));
    if(payloadPositions.length!==CHROMA_CODE_CELLS)
      throw new Error(`MAIN COLOR payload cells ${payloadPositions.length} != ${CHROMA_CODE_CELLS}`);
    return{reserved,calibration,calibrationEntries,payloadPositions};
  })();
  return templatePromise;
}

function paintPixel(pixels,size,x,y,rgb){
  const off=(y*size+x)*4;pixels[off]=rgb[0];pixels[off+1]=rgb[1];pixels[off+2]=rgb[2];pixels[off+3]=255;
}

export function rgbForMainColor(baseDark,chromaBit){
  return CHROMA_PALETTE[baseDark?(chromaBit?1:0):(chromaBit?3:2)];
}

export async function createChromaRaster(basePacket,chromaPacket) {
  if(!isNativeChromaPacket(basePacket)||!isNativeChromaPacket(chromaPacket))
    throw new Error('MAIN COLOR requires native-chroma QCT2 packets');
  if(basePacket.length!==CHROMA_QCT_PACKET_BYTES||chromaPacket.length!==CHROMA_QCT_PACKET_BYTES)
    throw new Error('MAIN COLOR packet length mismatch');
  const QRCode=await getQrCode(),template=await prepareChromaTemplate(),chromaBits=packetToChromaStates(chromaPacket);
  const qr=QRCode.create([{data:basePacket,mode:'byte'}],{
    version:CHROMA_VERSION,errorCorrectionLevel:CHROMA_QR_ECC,maskPattern:CHROMA_QR_MASK
  });
  if(qr.modules.size!==CHROMA_MODULES)throw new Error('MAIN COLOR base QR is not V40');
  const pixels=new Uint8ClampedArray(CHROMA_RASTER*CHROMA_RASTER*4);pixels.fill(255);
  let cursor=0;
  for(let y=0;y<CHROMA_MODULES;y++)for(let x=0;x<CHROMA_MODULES;x++){
    const index=y*CHROMA_MODULES+x,baseDark=Boolean(qr.modules.get(y,x));let rgb;
    if(template.reserved[index])rgb=baseDark?[0,0,0]:[255,255,255];
    else{
      const chromaBit=template.calibration.has(index)?template.calibration.get(index):chromaBits[cursor++];
      rgb=rgbForMainColor(baseDark,chromaBit);
    }
    paintPixel(pixels,CHROMA_RASTER,x+CHROMA_QUIET,y+CHROMA_QUIET,rgb);
  }
  if(cursor!==chromaBits.length)throw new Error('MAIN COLOR chroma cursor mismatch');
  return{pixels,size:CHROMA_RASTER,modules:CHROMA_MODULES,version:CHROMA_VERSION,visualStates:4,baseQrValid:true};
}
