// qcolortrasfer CHROMA FOUNTAIN v2.9 (MIT).
//
// One large V40-shaped optical matrix. Standard QR function modules remain
// black/white so ZXing can acquire finder/timing/alignment geometry, but every
// non-reserved data module is a native four-color symbol. There is no second
// overlaid QR and ZXing never decodes the payload.
//
// Four calibrated colors carry two bits/cell. QCT2 stays the packet/fountain
// protocol, so the existing receiver/fountain/file verification path remains
// unchanged. Hamming(15,11) is interleaved across the matrix; the frame CRC then
// turns any residual corruption into a clean fountain erasure.

import { decodeOpticalPacket, HEADER_BYTES_V2 } from './protocol.js';
import {
  homographyForQr, mapHomography, buildLocalThresholdGrid, findAlignmentResiduals
} from './tracked-qr.js';

export const CHROMA_VERSION = 40;
export const CHROMA_MODULES = 177;
export const CHROMA_QUIET = 4;
export const CHROMA_RASTER = CHROMA_MODULES + CHROMA_QUIET * 2;
export const CHROMA_QR_ECC = 'L';
export const CHROMA_QR_MASK = 4;
export const CHROMA_CALIBRATION_CELLS = 128;
export const CHROMA_V40_DATA_MODULES = 29648;
export const CHROMA_PAYLOAD_CELLS = CHROMA_V40_DATA_MODULES - CHROMA_CALIBRATION_CELLS;
export const CHROMA_CHUNK_BYTES = 5384;
export const CHROMA_QCT_PACKET_BYTES = HEADER_BYTES_V2 + CHROMA_CHUNK_BYTES + 4;
export const CHROMA_RAW_BITS = CHROMA_QCT_PACKET_BYTES * 8;
export const CHROMA_HAMMING_WORDS = CHROMA_RAW_BITS / 11;
export const CHROMA_CODE_BITS = CHROMA_HAMMING_WORDS * 15;
export const CHROMA_CODE_CELLS = CHROMA_CODE_BITS / 2;
export const CHROMA_BIT_PERMUTATION = 7919;

// Gray adjacency:
// 00 red -> 01 blue -> 11 cyan -> 10 magenta.
// Same-luminance neighbours differ by one bit; yellow is deliberately absent.
export const CHROMA_PALETTE = Object.freeze([
  Object.freeze([168, 24, 48]),   // dark red
  Object.freeze([24, 72, 184]),   // dark blue
  Object.freeze([72, 226, 236]),  // light cyan
  Object.freeze([236, 134, 218]), // light magenta
]);
const PAIR_TO_PALETTE = Object.freeze([0, 1, 3, 2]);
const PALETTE_TO_PAIR = Object.freeze([0, 1, 3, 2]);
const DATA_POSITIONS = Object.freeze([3,5,6,7,9,10,11,12,13,14,15]);
const COLOR_SAMPLE_OFFSETS = Object.freeze([[.5,.5],[.34,.5],[.66,.5],[.5,.34],[.5,.66]]);
const MIN_CALIBRATION_SEPARATION = 0.075;
const RESAMPLE_MARGIN = 0.012;

if (!Number.isInteger(CHROMA_HAMMING_WORDS) ||
    CHROMA_CODE_CELLS !== CHROMA_PAYLOAD_CELLS) {
  throw new Error('CHROMA FOUNTAIN capacity constants are inconsistent');
}

let qrPromise = null;
let templatePromise = null;

async function getQrCode() {
  if (!qrPromise) qrPromise = import('https://esm.sh/qrcode@1.5.4?bundle').then(mod => mod.default || mod);
  return qrPromise;
}

function bitAt(bytes, index) {
  return (bytes[index >> 3] >> (7 - (index & 7))) & 1;
}
function setBit(bytes, index, value) {
  if (value) bytes[index >> 3] |= 1 << (7 - (index & 7));
}

export function hammingEncodeBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Hamming input must be Uint8Array');
  const rawBits = bytes.length * 8;
  const words = Math.ceil(rawBits / 11);
  const out = new Uint8Array(words * 15);
  let src = 0;
  for (let word = 0; word < words; word++) {
    const bits = new Uint8Array(16);
    for (const position of DATA_POSITIONS) bits[position] = src < rawBits ? bitAt(bytes, src++) : 0;
    for (const parity of [1,2,4,8]) {
      let value = 0;
      for (let position = 1; position <= 15; position++) {
        if (position !== parity && (position & parity)) value ^= bits[position];
      }
      bits[parity] = value;
    }
    for (let position = 1; position <= 15; position++) out[word * 15 + position - 1] = bits[position];
  }
  return out;
}

export function hammingDecodeBits(coded, expectedBytes) {
  if (!(coded instanceof Uint8Array)) throw new TypeError('Hamming code must be Uint8Array');
  const expectedBits = Math.max(0, Math.floor(Number(expectedBytes) || 0)) * 8;
  const words = Math.ceil(expectedBits / 11);
  if (coded.length < words * 15) throw new Error('Truncated Hamming code');
  const out = new Uint8Array(expectedBytes);
  let dst = 0, corrected = 0;
  for (let word = 0; word < words; word++) {
    const bits = new Uint8Array(16);
    let syndrome = 0;
    for (let position = 1; position <= 15; position++) {
      const value = coded[word * 15 + position - 1] & 1;
      bits[position] = value;
      if (value) syndrome ^= position;
    }
    if (syndrome >= 1 && syndrome <= 15) {
      bits[syndrome] ^= 1;
      corrected++;
    }
    for (const position of DATA_POSITIONS) {
      if (dst >= expectedBits) break;
      setBit(out, dst++, bits[position]);
    }
  }
  return { bytes: out, corrected };
}

function scrambleBits(coded) {
  const n = coded.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[(i * CHROMA_BIT_PERMUTATION) % n] = coded[i] & 1;
  return out;
}
function unscrambleBits(scrambled) {
  const n = scrambled.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = scrambled[(i * CHROMA_BIT_PERMUTATION) % n] & 1;
  return out;
}

export function packetToChromaStates(packet) {
  if (!(packet instanceof Uint8Array) || packet.length !== CHROMA_QCT_PACKET_BYTES) {
    throw new Error(`CHROMA packet must be exactly ${CHROMA_QCT_PACKET_BYTES} B`);
  }
  const coded = hammingEncodeBytes(packet);
  if (coded.length !== CHROMA_CODE_BITS) throw new Error('Unexpected CHROMA Hamming length');
  const scrambled = scrambleBits(coded);
  const half = CHROMA_CODE_CELLS;
  const states = new Uint8Array(half);
  for (let i = 0; i < half; i++) {
    const pair = (scrambled[i] << 1) | scrambled[i + half];
    states[i] = PAIR_TO_PALETTE[pair];
  }
  return states;
}

export function chromaStatesToPacket(states) {
  if (!(states instanceof Uint8Array) || states.length !== CHROMA_CODE_CELLS) {
    throw new Error(`CHROMA state count must be ${CHROMA_CODE_CELLS}`);
  }
  const scrambled = new Uint8Array(CHROMA_CODE_BITS);
  const half = CHROMA_CODE_CELLS;
  for (let i = 0; i < half; i++) {
    const state = states[i];
    if (state > 3) throw new Error('Invalid CHROMA palette state');
    const pair = PALETTE_TO_PAIR[state];
    scrambled[i] = (pair >> 1) & 1;
    scrambled[i + half] = pair & 1;
  }
  return hammingDecodeBits(unscrambleBits(scrambled), CHROMA_QCT_PACKET_BYTES);
}

export async function prepareChromaTemplate() {
  if (!templatePromise) templatePromise = (async () => {
    const QRCode = await getQrCode();
    const qr = QRCode.create([{data:Uint8Array.of(0),mode:'byte'}], {
      version: CHROMA_VERSION, errorCorrectionLevel: CHROMA_QR_ECC, maskPattern: CHROMA_QR_MASK
    });
    if (qr.modules.size !== CHROMA_MODULES || typeof qr.modules.isReserved !== 'function') {
      throw new Error('V40 reserved-module template unavailable');
    }
    const total = CHROMA_MODULES * CHROMA_MODULES;
    const reserved = new Uint8Array(total);
    const functionBits = new Uint8Array(total);
    const dataIndices = [];
    for (let y=0; y<CHROMA_MODULES; y++) for (let x=0; x<CHROMA_MODULES; x++) {
      const index = y * CHROMA_MODULES + x;
      const isReserved = qr.modules.isReserved(y,x);
      reserved[index] = isReserved ? 1 : 0;
      functionBits[index] = qr.modules.get(y,x) ? 1 : 0;
      if (!isReserved) dataIndices.push(index);
    }
    if (dataIndices.length !== CHROMA_V40_DATA_MODULES) {
      throw new Error(`V40 data-module count ${dataIndices.length} != ${CHROMA_V40_DATA_MODULES}`);
    }
    const calibration = new Map();
    const calibrationEntries = [];
    for (let i=0; i<CHROMA_CALIBRATION_CELLS; i++) {
      let at = Math.floor((i + 0.5) * dataIndices.length / CHROMA_CALIBRATION_CELLS);
      at = Math.max(0, Math.min(dataIndices.length - 1, at));
      while (calibration.has(dataIndices[at]) && at + 1 < dataIndices.length) at++;
      const moduleIndex = dataIndices[at], state = i & 3;
      calibration.set(moduleIndex, state);
      calibrationEntries.push({moduleIndex,state,x:moduleIndex%CHROMA_MODULES,y:Math.floor(moduleIndex/CHROMA_MODULES)});
    }
    const payloadPositions = dataIndices.filter(index => !calibration.has(index)).map(index => ({
      moduleIndex:index, x:index%CHROMA_MODULES, y:Math.floor(index/CHROMA_MODULES)
    }));
    if (payloadPositions.length !== CHROMA_CODE_CELLS) {
      throw new Error(`CHROMA payload cells ${payloadPositions.length} != ${CHROMA_CODE_CELLS}`);
    }
    return {reserved,functionBits,calibration,calibrationEntries,payloadPositions};
  })();
  return templatePromise;
}

function paintPixel(pixels,size,x,y,rgb) {
  const off=(y*size+x)*4;
  pixels[off]=rgb[0]; pixels[off+1]=rgb[1]; pixels[off+2]=rgb[2]; pixels[off+3]=255;
}

export async function createChromaRaster(packet) {
  const states = packetToChromaStates(packet);
  const template = await prepareChromaTemplate();
  const pixels = new Uint8ClampedArray(CHROMA_RASTER * CHROMA_RASTER * 4);
  pixels.fill(255);
  let payloadCursor = 0;
  for (let y=0; y<CHROMA_MODULES; y++) for (let x=0; x<CHROMA_MODULES; x++) {
    const index=y*CHROMA_MODULES+x;
    let rgb;
    if (template.reserved[index]) {
      rgb = template.functionBits[index] ? [0,0,0] : [255,255,255];
    } else if (template.calibration.has(index)) {
      rgb = CHROMA_PALETTE[template.calibration.get(index)];
    } else {
      rgb = CHROMA_PALETTE[states[payloadCursor++]];
    }
    paintPixel(pixels,CHROMA_RASTER,x+CHROMA_QUIET,y+CHROMA_QUIET,rgb);
  }
  if (payloadCursor !== states.length) throw new Error('CHROMA raster payload cursor mismatch');
  return {pixels,size:CHROMA_RASTER,modules:CHROMA_MODULES,version:CHROMA_VERSION,visualStates:4};
}

function correctionAt(mx,my,anchors) {
  if (!anchors?.length) return {x:0,y:0};
  let sumW=.35,sumX=0,sumY=0;
  for (const anchor of anchors) {
    const d2=(mx-anchor.mx)**2+(my-anchor.my)**2;
    const w=1/(1+d2/400);
    sumW+=w; sumX+=anchor.dx*w; sumY+=anchor.dy*w;
  }
  return {x:sumX/sumW,y:sumY/sumW};
}
function rgbAt(image,x,y) {
  const xx=Math.round(x),yy=Math.round(y);
  if (xx<0||yy<0||xx>=image.width||yy>=image.height) return null;
  const off=(yy*image.width+xx)*4;
  return [image.data[off],image.data[off+1],image.data[off+2]];
}
function sampleModuleRgb(image,h,mx,my,anchors,multi=false) {
  const correction=correctionAt(mx+.5,my+.5,anchors);
  const offsets=multi?COLOR_SAMPLE_OFFSETS:[[.5,.5]];
  let r=0,g=0,b=0,n=0;
  for (const [ox,oy] of offsets) {
    const p=mapHomography(h,mx+ox,my+oy);
    if(!p)continue;
    const rgb=rgbAt(image,p[0]+correction.x,p[1]+correction.y);
    if(!rgb)continue;
    r+=rgb[0];g+=rgb[1];b+=rgb[2];n++;
  }
  return n?[r/n,g/n,b/n]:null;
}
function feature(rgb) {
  const [r,g,b]=rgb, sum=Math.max(32,r+g+b);
  const l=(77*r+150*g+29*b)/(256*255);
  return [l,(r-g)/sum,(b-g)/sum];
}
function centroid(features) {
  const out=[0,0,0];
  for(const f of features){out[0]+=f[0];out[1]+=f[1];out[2]+=f[2];}
  const n=Math.max(1,features.length);
  return out.map(v=>v/n);
}
function colorDistance(a,b) {
  const dl=(a[0]-b[0])*1.45, da=(a[1]-b[1])*2.35, db=(a[2]-b[2])*2.35;
  return dl*dl+da*da+db*db;
}
function minimumCentroidSeparation(centroids) {
  let min=Infinity;
  for(let i=0;i<centroids.length;i++)for(let j=i+1;j<centroids.length;j++)min=Math.min(min,Math.sqrt(colorDistance(centroids[i],centroids[j])));
  return min;
}
function classifyFeature(value,centroids) {
  let best=-1,bestD=Infinity,second=Infinity;
  for(let i=0;i<centroids.length;i++){
    const d=colorDistance(value,centroids[i]);
    if(d<bestD){second=bestD;bestD=d;best=i;}else if(d<second)second=d;
  }
  return {state:best,margin:Math.max(0,second-bestD)};
}

export async function decodeChromaRaster(image,quad) {
  if(!image?.data||!(image.width>0)||!(image.height>0)||!quad)return null;
  const started=globalThis.performance?.now?.()??Date.now();
  const template=await prepareChromaTemplate();
  const h=homographyForQr(CHROMA_MODULES,quad); if(!h)return null;
  const thresholdGrid=buildLocalThresholdGrid(image,h,CHROMA_MODULES,{x:0,y:0});
  const anchors=thresholdGrid?findAlignmentResiduals(image,h,thresholdGrid,CHROMA_MODULES,{x:0,y:0}):[];

  const groups=[[],[],[],[]];
  for(const entry of template.calibrationEntries){
    const rgb=sampleModuleRgb(image,h,entry.x,entry.y,anchors,true); if(!rgb)return null;
    groups[entry.state].push(feature(rgb));
  }
  if(groups.some(group=>group.length<8))return null;
  const centroids=groups.map(centroid);
  const calibrationSeparation=minimumCentroidSeparation(centroids);
  if(!(calibrationSeparation>=MIN_CALIBRATION_SEPARATION))return null;

  const states=new Uint8Array(CHROMA_CODE_CELLS);
  let marginSum=0,resampled=0;
  for(let i=0;i<template.payloadPositions.length;i++){
    const pos=template.payloadPositions[i];
    let rgb=sampleModuleRgb(image,h,pos.x,pos.y,anchors,false); if(!rgb)return null;
    let classified=classifyFeature(feature(rgb),centroids);
    if(classified.margin<RESAMPLE_MARGIN){
      const refined=sampleModuleRgb(image,h,pos.x,pos.y,anchors,true);
      if(refined){classified=classifyFeature(feature(refined),centroids);resampled++;}
    }
    states[i]=classified.state; marginSum+=classified.margin;
  }

  const decoded=chromaStatesToPacket(states);
  let packet;
  try{packet=decodeOpticalPacket(decoded.bytes);}catch{return null;}
  // QCT2 intentionally carries the MONO flag: CHROMA is a different physical
  // transport, not the legacy overlaid C1/C2 decoder. This keeps app.js from
  // spending fallback time reconstructing the old layered color channels.
  if(packet.protocolVersion!==2||packet.chunkSize!==CHROMA_CHUNK_BYTES||packet.visualStates!==2)return null;
  const ended=globalThis.performance?.now?.()??Date.now();
  return {
    bytes:decoded.bytes,packet,corrected:decoded.corrected,
    margin:marginSum/CHROMA_CODE_CELLS,calibrationSeparation,
    alignmentAnchors:anchors.length,resampled,decodeMs:ended-started
  };
}