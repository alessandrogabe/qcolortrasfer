// Portable multi-QR + chromatic decoder worker.
//
// V2.8 keeps three decode paths:
// - full: occasional whole-frame ZXing acquisition, including sightings;
// - crop fallback: one ROI through ordinary ZXing;
// - tracked: refine cached geometry against finder/alignment structure, sample
//   the known module grid, then decode a clean synthetic QR in isPure mode.
//
// QAR1 and QAR2 helper packets are returned separately so app.js continues to
// process only QCT1/QCT2 symbols. Tracked misses always fall back on the same
// crop, and fallback decodes re-anchor geometry for the next frame.
//
// The tracked sampler is original qcolortrasfer/MIT code. It independently
// implements general high-throughput optical principles; no Decimen >=0.4 AGPL
// source is incorporated.

import {
  chromaScoreA, chromaScoreB, clusterColorScores, classifyColorScore
} from './color-code.js';
import { FLAG_COLOR_8, FLAG_V2_COLOR_8, MAGIC, MAGIC_V2 } from './protocol.js';
import { isAuxRepairPacket } from './aux-repair.js';
import { detectionBoxFromPosition } from './rx-roi.js';
import { sampleTrackedQrCandidates, shiftQuad, modulesFromVersion, versionFromModules } from './tracked-qr.js';

const ZXING_MODULE_URL = 'https://esm.sh/zxing-wasm@2.0.0/reader?bundle';
const ZXING_WASM_URL = 'https://cdn.jsdelivr.net/npm/zxing-wasm@2.0.0/dist/reader/zxing_reader.wasm';
const QR_MODULE_URL = 'https://esm.sh/qrcode@1.5.4?bundle';
const MAX_FULL_SYMBOLS = 12;
const QR_ECC = 'L';
const QR_MASK = 4;
const SYNTH_MARGIN = 4;
const SYNTH_SCALE = 2;
const COLOR_MIN_SEPARATION_A = 0.06;
const COLOR_MIN_SEPARATION_B = 0.06;

const FULL_OPTIONS = {
  formats: ['QRCode'], maxNumberOfSymbols: MAX_FULL_SYMBOLS,
  tryHarder: true, tryRotate: false, tryInvert: false, tryDownscale: true,
  returnErrors: true
};
const CROP_OPTIONS = {
  formats: ['QRCode'], maxNumberOfSymbols: 1,
  tryHarder: true, tryRotate: false, tryInvert: false, tryDownscale: true,
  returnErrors: false
};
const PURE_OPTIONS = {
  formats: ['QRCode'], maxNumberOfSymbols: 1,
  tryHarder: false, tryRotate: false, tryInvert: false, tryDownscale: false,
  isPure: true, binarizer: 'FixedThreshold', returnErrors: false
};

let readerPromise = null;
let qrPromise = null;
const templateCache = new Map();

async function getReader() {
  if (!readerPromise) {
    readerPromise = (async () => {
      const mod = await import(ZXING_MODULE_URL);
      mod.prepareZXingModule({ overrides: { locateFile(path, prefix) { return path.endsWith('.wasm') ? ZXING_WASM_URL : prefix + path; } } });
      await mod.readBarcodes(new ImageData(8, 8), { formats: ['QRCode'], maxNumberOfSymbols: 1 }).catch(() => undefined);
      return mod;
    })();
  }
  return readerPromise;
}
async function getQrCode() { if (!qrPromise) qrPromise = import(QR_MODULE_URL).then(mod => mod.default || mod); return qrPromise; }

function packetMagic(bytes) {
  if (!bytes?.length || bytes.length < 6) return 0;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
}
function isQct(bytes) { const magic = packetMagic(bytes); return magic === MAGIC || magic === MAGIC_V2; }
function isAux(bytes) { return isAuxRepairPacket(bytes); }
function isOptical(bytes) { return isQct(bytes) || isAux(bytes); }
function usesEightStates(bytes) {
  const magic = packetMagic(bytes);
  if (magic === MAGIC) return Boolean(bytes[5] & FLAG_COLOR_8);
  if (magic === MAGIC_V2) return Boolean(bytes[5] & FLAG_V2_COLOR_8);
  return false;
}

function parsePositiveInt(value) {
  if (Number.isInteger(value) && value > 0) return value;
  const match = String(value ?? '').match(/\d+/); return match ? Number(match[0]) : 0;
}
function versionOf(result) {
  let version = parsePositiveInt(result?.version);
  if (version >= 1 && version <= 40) return version;
  try { const extra = JSON.parse(result?.extra || '{}'); version = parsePositiveInt(extra.Version); if (version >= 1 && version <= 40) return version; } catch {}
  return versionFromModules(Number(result?.symbol?.width || 0));
}

async function templateFor(version) {
  if (templateCache.has(version)) return templateCache.get(version);
  const QRCode = await getQrCode();
  const qr = QRCode.create([{ data: Uint8Array.of(0), mode: 'byte' }], { errorCorrectionLevel: QR_ECC, maskPattern: QR_MASK, version });
  const modules = qr.modules.size; const reserved = new Uint8Array(modules * modules); const bits = new Uint8Array(modules * modules);
  if (typeof qr.modules.isReserved !== 'function') throw new Error('qrcode reserved-module API unavailable');
  for (let y = 0; y < modules; y++) for (let x = 0; x < modules; x++) {
    const index = y * modules + x; reserved[index] = qr.modules.isReserved(y, x) ? 1 : 0; bits[index] = qr.modules.get(y, x) ? 1 : 0;
  }
  const template = { modules, reserved, bits }; templateCache.set(version, template); return template;
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length; const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col; for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-9) return null; [a[col], a[pivot]] = [a[pivot], a[col]];
    const d = a[col][col]; for (let j = col; j <= n; j++) a[col][j] /= d;
    for (let row = 0; row < n; row++) { if (row === col) continue; const f = a[row][col]; for (let j = col; j <= n; j++) a[row][j] -= f * a[col][j]; }
  }
  return a.map(row => row[n]);
}
function homography(src, dst) {
  const matrix = [], vector = [];
  for (let i = 0; i < 4; i++) { const [x, y] = src[i], [u, v] = dst[i]; matrix.push([x,y,1,0,0,0,-u*x,-u*y]); vector.push(u); matrix.push([0,0,0,x,y,1,-v*x,-v*y]); vector.push(v); }
  const h = solveLinearSystem(matrix, vector); return h ? [h[0],h[1],h[2],h[3],h[4],h[5],h[6],h[7],1] : null;
}
function mapPoint(h, x, y) { const d = h[6]*x+h[7]*y+h[8]; if (Math.abs(d)<1e-9) return null; return [(h[0]*x+h[1]*y+h[2])/d,(h[3]*x+h[4]*y+h[5])/d]; }
function pixelScores(image, x, y) {
  const xx=Math.max(0,Math.min(image.width-1,Math.round(x))), yy=Math.max(0,Math.min(image.height-1,Math.round(y)));
  const offset=(yy*image.width+xx)*4, r=image.data[offset], g=image.data[offset+1], b=image.data[offset+2]; return [chromaScoreA(r,g,b),chromaScoreB(r,g,b)];
}
function moduleColorScores(image,h,gx,gy) {
  const offsets=[[0.50,0.50],[0.37,0.50],[0.63,0.50],[0.50,0.37],[0.50,0.63]]; let sumA=0,sumB=0;
  for (const [ox,oy] of offsets) { const p=mapPoint(h,gx+ox,gy+oy); if(!p||p[0]<0||p[0]>=image.width||p[1]<0||p[1]>=image.height)return null; const [a,b]=pixelScores(image,p[0],p[1]); sumA+=a; sumB+=b; }
  return [sumA/offsets.length,sumB/offsets.length];
}

function quadFromPosition(position, originX=0, originY=0) {
  if (!position) return null;
  return shiftQuad(position, originX, originY);
}
function resultDetection(result, originX=0, originY=0, decoded=true) {
  const box=detectionBoxFromPosition(result?.position,originX,originY); if(!box)return null;
  const version=versionOf(result), modules=modulesFromVersion(version), quad=quadFromPosition(result?.position,originX,originY);
  return {...box,version,modules,quad,decoded};
}
function detectionFromTracked(quad, modules, decoded=true) {
  const box=detectionBoxFromPosition(quad,0,0); if(!box)return null;
  return {...box,quad,modules,version:versionFromModules(modules),decoded};
}

async function reconstructChromaGeometry(bytes,version,position,image) {
  if(!isQct(bytes)||!version||!position)return null;
  const template=await templateFor(version), modules=template.modules, p=position;
  const h=homography([[0,0],[modules,0],[0,modules],[modules,modules]],[[p.topLeft.x,p.topLeft.y],[p.topRight.x,p.topRight.y],[p.bottomLeft.x,p.bottomLeft.y],[p.bottomRight.x,p.bottomRight.y]]); if(!h)return null;
  const scoresA=[],scoresB=[],dataIndices=[];
  for(let y=0;y<modules;y++)for(let x=0;x<modules;x++){const index=y*modules+x;if(template.reserved[index])continue;const scores=moduleColorScores(image,h,x,y);if(!scores)return null;scoresA.push(scores[0]);scoresB.push(scores[1]);dataIndices.push(index);}
  const clustersA=clusterColorScores(scoresA,COLOR_MIN_SEPARATION_A); const eight=usesEightStates(bytes); const clustersB=eight?clusterColorScores(scoresB,COLOR_MIN_SEPARATION_B):null;
  const bitsA=clustersA?template.bits.slice():null,bitsB=clustersB?template.bits.slice():null;
  if(bitsA)for(let i=0;i<dataIndices.length;i++)bitsA[dataIndices[i]]=classifyColorScore(scoresA[i],clustersA);
  if(bitsB)for(let i=0;i<dataIndices.length;i++)bitsB[dataIndices[i]]=classifyColorScore(scoresB[i],clustersB);
  return {modules,a:bitsA?{bits:bitsA,modules,separation:clustersA.separation}:null,b:bitsB?{bits:bitsB,modules,separation:clustersB.separation}:null,eight};
}
async function reconstructChroma(result,image) {
  return reconstructChromaGeometry(result?.bytes,versionOf(result),result?.position,image);
}

function syntheticImage(item) {
  const size=(item.modules+SYNTH_MARGIN*2)*SYNTH_SCALE; const data=new Uint8ClampedArray(size*size*4); data.fill(255);
  for(let y=0;y<item.modules;y++)for(let x=0;x<item.modules;x++){
    if(!item.bits[y*item.modules+x])continue; const px0=(x+SYNTH_MARGIN)*SYNTH_SCALE,py0=(y+SYNTH_MARGIN)*SYNTH_SCALE;
    for(let yy=0;yy<SYNTH_SCALE;yy++)for(let xx=0;xx<SYNTH_SCALE;xx++){const off=((py0+yy)*size+px0+xx)*4;data[off]=0;data[off+1]=0;data[off+2]=0;data[off+3]=255;}
  }
  return new ImageData(data,size,size);
}
async function decodeSyntheticResults(reader,matrices) {
  const out=[];
  for(const matrix of matrices){const results=await reader.readBarcodes(syntheticImage(matrix),PURE_OPTIONS);const hit=results.find(item=>item.isValid&&item.bytes?.length>0&&isOptical(item.bytes));if(hit)out.push(hit);}
  return out;
}
async function decodeSynthetic(reader,matrices) { return (await decodeSyntheticResults(reader,matrices)).filter(item=>isQct(item.bytes)).map(item=>item.bytes); }

async function tryTrackedBase(reader,image,trackedQuad,trackedModules,originX,originY) {
  if(!trackedQuad||!(trackedModules>0))return null;
  const localQuad=shiftQuad(trackedQuad,-originX,-originY); if(!localQuad)return null;
  const sampled=sampleTrackedQrCandidates(image,localQuad,trackedModules); if(!sampled)return null;
  for(const candidate of sampled.candidates){
    const hits=await decodeSyntheticResults(reader,[candidate]);
    const hit=hits[0]; if(!hit)continue;
    const refinedLocal=sampled.refinedQuad||localQuad;
    const refinedGlobal=shiftQuad(refinedLocal,originX,originY)||trackedQuad;
    return {
      bytes:hit.bytes,localQuad:refinedLocal,globalQuad:refinedGlobal,modules:trackedModules,
      separation:sampled.separation,anchorScore:sampled.anchorScore,
      alignmentAnchors:sampled.alignmentAnchors,kind:candidate.kind
    };
  }
  return null;
}

self.onmessage=async event=>{
  const {id,buf,w,h,mode='full',regionId=null,originX=0,originY=0,decodeColor=mode==='crop',trackedQuad=null,trackedModules=0}=event.data||{};
  let trackedAttempted=false,trackedHit=false,trackedSeparation=0,trackedAnchorScore=0,trackedAlignmentAnchors=0,trackedKind='';
  try{
    const reader=await getReader(); const image=new ImageData(new Uint8ClampedArray(buf),w,h);
    let results=[],base=[],auxBase=[],detections=[],symbols=[],auxSymbols=[];
    let tracked=null;
    if(mode==='crop'&&trackedQuad&&trackedModules>0){
      trackedAttempted=true;
      tracked=await tryTrackedBase(reader,image,trackedQuad,trackedModules,originX,originY);
      if(tracked){
        trackedHit=true; trackedSeparation=tracked.separation; trackedAnchorScore=tracked.anchorScore;
        trackedAlignmentAnchors=tracked.alignmentAnchors; trackedKind=tracked.kind;
        const syntheticResult={bytes:tracked.bytes,position:tracked.localQuad,version:versionFromModules(tracked.modules)};
        if(isQct(tracked.bytes)){base=[syntheticResult];symbols=[tracked.bytes];}
        else if(isAux(tracked.bytes)){auxBase=[syntheticResult];auxSymbols=[tracked.bytes];}
        const detection=detectionFromTracked(tracked.globalQuad,tracked.modules,true);if(detection)detections=[detection];
      }
    }
    if(!trackedHit){
      results=await reader.readBarcodes(image,mode==='crop'?CROP_OPTIONS:FULL_OPTIONS);
      const optical=results.filter(item=>item.isValid&&item.bytes?.length>0&&isOptical(item.bytes));
      base=optical.filter(item=>isQct(item.bytes));
      auxBase=optical.filter(item=>isAux(item.bytes));
      const opticalSet=new Set(optical); symbols=base.map(item=>item.bytes); auxSymbols=auxBase.map(item=>item.bytes);
      detections=results.map(item=>resultDetection(item,originX,originY,opticalSet.has(item))).filter(Boolean);
    }

    const matricesA=[],matricesB=[];let sepA=0,sepB=0,eightBase=0;
    if(decodeColor){
      for(const result of base){
        const reconstructed=trackedHit
          ? await reconstructChromaGeometry(result.bytes,versionFromModules(tracked.modules),tracked.localQuad,image)
          : await reconstructChroma(result,image);
        if(!reconstructed)continue;if(reconstructed.eight)eightBase++;if(reconstructed.a){matricesA.push(reconstructed.a);sepA+=reconstructed.a.separation;}if(reconstructed.b){matricesB.push(reconstructed.b);sepB+=reconstructed.b.separation;}
      }
    } else eightBase=base.reduce((count,item)=>count+(usesEightStates(item.bytes)?1:0),0);
    const colorA=decodeColor?await decodeSynthetic(reader,matricesA):[],colorB=decodeColor?await decodeSynthetic(reader,matricesB):[]; symbols.push(...colorA,...colorB);
    self.postMessage({id,mode,regionId,detections,symbols,auxSymbols,baseCount:base.length,auxCount:auxBase.length,eightBase,color1Candidates:matricesA.length,color1Count:colorA.length,color1Separation:matricesA.length?sepA/matricesA.length:0,color2Candidates:matricesB.length,color2Count:colorB.length,color2Separation:matricesB.length?sepB/matricesB.length:0,trackedAttempted,trackedHit,trackedSeparation,trackedAnchorScore,trackedAlignmentAnchors,trackedKind,error:null});
  }catch(error){self.postMessage({id,mode,regionId,detections:[],symbols:[],auxSymbols:[],baseCount:0,auxCount:0,eightBase:0,color1Candidates:0,color1Count:0,color1Separation:0,color2Candidates:0,color2Count:0,color2Separation:0,trackedAttempted,trackedHit:false,trackedSeparation,trackedAnchorScore,trackedAlignmentAnchors,trackedKind,error:error?.message||String(error)});}
};

void Promise.all([getReader(),getQrCode()]).then(()=>self.postMessage({id:-1,ready:true,symbols:[],auxSymbols:[],detections:[],error:null})).catch(error=>self.postMessage({id:-1,ready:false,symbols:[],auxSymbols:[],detections:[],error:error?.message||String(error)}));
