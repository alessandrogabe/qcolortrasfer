// qcolortrasfer CHROMA FOUNTAIN worker wrapper v2.9 (MIT).
//
// The existing QR worker remains the acquisition/fallback engine. This wrapper
// captures its response, and only when ordinary QCT/QAR decoding produced no
// symbol does it try the native four-color matrix. Once the main thread marks a
// region as CHROMA, successful crop frames bypass ZXing completely.

import { decodeChromaRaster, CHROMA_MODULES, CHROMA_VERSION } from '../chroma-fountain.js';
import { shiftQuad } from '../tracked-qr.js';
import { detectionBoxFromPosition } from '../rx-roi.js';

const nativePost = self.postMessage.bind(self);
await import('../qr-worker.js');
const baseHandler = self.onmessage;

function makeDetection(globalQuad) {
  const box=detectionBoxFromPosition(globalQuad,0,0);
  return box?{...box,quad:globalQuad,modules:CHROMA_MODULES,version:CHROMA_VERSION,decoded:true,transport:'chroma'}:null;
}
function plausibleCandidate(detection) {
  if(!detection?.quad||!(detection.w>100)||!(detection.h>100))return false;
  const aspect=Math.max(detection.w,detection.h)/Math.max(1,Math.min(detection.w,detection.h));
  return aspect<=1.55&&(detection.modules===0||detection.modules===CHROMA_MODULES||detection.version===CHROMA_VERSION);
}
async function runBase(event) {
  let captured=null;
  const previous=self.postMessage;
  self.postMessage=(data,transfer)=>{
    if(data?.id===event.data?.id)captured=data;
    else if(transfer===undefined)nativePost(data);else nativePost(data,transfer);
  };
  try{await baseHandler.call(self,event);}
  finally{self.postMessage=previous;}
  return captured;
}
async function tryCustom(event,quadGlobal) {
  const d=event.data||{};
  if(!quadGlobal||!d.buf||!(d.w>0)||!(d.h>0))return null;
  const local=shiftQuad(quadGlobal,-(Number(d.originX)||0),-(Number(d.originY)||0));if(!local)return null;
  const image={data:new Uint8ClampedArray(d.buf),width:Number(d.w),height:Number(d.h)};
  const decoded=await decodeChromaRaster(image,local);
  if(!decoded)return null;
  const globalQuad=shiftQuad(local,Number(d.originX)||0,Number(d.originY)||0)||quadGlobal;
  const detection=makeDetection(globalQuad);
  return {decoded,detection};
}
function customResponse(event,custom,{fast=false}={}) {
  const d=event.data||{},decoded=custom.decoded;
  return {
    id:d.id,mode:d.mode||'full',regionId:d.regionId??null,
    detections:custom.detection?[custom.detection]:[],
    symbols:[decoded.bytes],auxSymbols:[],
    baseCount:1,auxCount:0,eightBase:0,
    color1Candidates:0,color1Count:0,color1Separation:0,
    color2Candidates:0,color2Count:0,color2Separation:0,
    trackedAttempted:d.mode==='crop',trackedHit:d.mode==='crop',
    trackedSeparation:decoded.calibrationSeparation,
    trackedAnchorScore:0,trackedAlignmentAnchors:decoded.alignmentAnchors,
    trackedKind:'chroma',
    chromaAttempted:true,chromaCount:1,chromaCorrected:decoded.corrected,
    chromaMargin:decoded.margin,chromaCalibrationSeparation:decoded.calibrationSeparation,
    chromaAlignmentAnchors:decoded.alignmentAnchors,chromaResampled:decoded.resampled,
    chromaDecodeMs:decoded.decodeMs,chromaFast:fast,error:null
  };
}

self.onmessage=async event=>{
  const d=event.data||{};
  if(d.id==null){return baseHandler.call(self,event);}

  // Known CHROMA ROI: use the cached/phase-locked quad directly. ZXing is only
  // a fallback if the native matrix CRC does not validate.
  if(d.mode==='crop'&&d.chromaHint&&d.trackedQuad&&Number(d.trackedModules)===CHROMA_MODULES){
    try{
      const custom=await tryCustom(event,d.trackedQuad);
      if(custom){nativePost(customResponse(event,custom,{fast:true}));return;}
    }catch{}
  }

  const base=await runBase(event);
  if(!base)return;
  if(d.id===-1){nativePost(base);return;}
  if((base.symbols?.length||0)>0||(base.auxSymbols?.length||0)>0){nativePost(base);return;}

  let attempted=false;
  try{
    // Recovery crop: the region may be CHROMA before the main bridge learned its
    // type. One successful decode promotes it to the detector-free fast path.
    if(d.mode==='crop'&&d.trackedQuad&&Number(d.trackedModules)===CHROMA_MODULES){
      attempted=true;
      const custom=await tryCustom(event,d.trackedQuad);
      if(custom){nativePost(customResponse(event,custom,{fast:false}));return;}
    }

    // Full acquisition: ZXing returnErrors gives us finder geometry even though
    // the colored data area is intentionally not a valid QR payload.
    if(d.mode==='full'&&Array.isArray(base.detections)){
      const candidates=base.detections.filter(plausibleCandidate).sort((a,b)=>(b.w*b.h)-(a.w*a.h)).slice(0,2);
      for(const detection of candidates){
        attempted=true;
        const custom=await tryCustom(event,detection.quad);
        if(custom){nativePost(customResponse(event,custom,{fast:false}));return;}
      }
    }
  }catch{}

  if(attempted)base.chromaAttempted=true;
  nativePost(base);
};
