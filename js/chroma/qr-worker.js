// qcolortrasfer unified RX worker wrapper v3.0 (MIT).
//
// v3 moves timing-pattern phase refinement into the worker, before either the
// ordinary tracked QR path or the native CHROMA path. Known CHROMA regions try
// direct matrix -> QCT2 first and skip ZXing completely on success. Full scans
// still use ZXing returnErrors only to acquire one or more V40 geometries.

import { decodeChromaRasterFast, decodeChromaRasterAuto } from '../chroma-fast-decoder.js';
import { CHROMA_MODULES, CHROMA_VERSION } from '../chroma-fountain.js';
import { shiftQuad } from '../tracked-qr.js';
import { refineTrackedPhase } from '../tracked-phase.js';
import { detectionBoxFromPosition, boxIou } from '../rx-roi.js';

const nativePost = self.postMessage.bind(self);
await import('../qr-worker.js');
const baseHandler = self.onmessage;
const regionState = new Map();
const PHASE_EVERY_CHROMA_CROPS = 4;
const MIN_PHASE_RATIO = .78;

function stateFor(regionId) {
  const key=regionId??'__full__';
  let state=regionState.get(key);
  if(!state){state={frames:0,forcePhase:true,alignment:false};regionState.set(key,state);}
  return state;
}

function makeDetection(globalQuad) {
  const box=detectionBoxFromPosition(globalQuad,0,0);
  return box?{...box,quad:globalQuad,modules:CHROMA_MODULES,version:CHROMA_VERSION,decoded:true,transport:'chroma'}:null;
}

function plausibleCandidate(detection) {
  if(!detection?.quad||!(detection.w>80)||!(detection.h>80))return false;
  const aspect=Math.max(detection.w,detection.h)/Math.max(1,Math.min(detection.w,detection.h));
  return aspect<=1.55&&(detection.modules===0||detection.modules===CHROMA_MODULES||detection.version===CHROMA_VERSION);
}

function dedupeCandidates(candidates) {
  const out=[];
  for(const candidate of candidates){
    if(out.some(existing=>boxIou(existing,candidate)>.55))continue;
    out.push(candidate);
  }
  return out;
}

function phaseLockEvent(event,{throttle=false}={}) {
  const d=event.data||{};
  const phase={attempted:false,applied:false,ratio:0,ms:0};
  if(d.mode!=='crop'||!d.trackedQuad||!(Number(d.trackedModules)>0)||!d.buf||!(d.w>0)||!(d.h>0))return{event,phase};
  const state=stateFor(d.regionId);
  state.frames++;
  const due=!throttle||state.forcePhase||state.frames%PHASE_EVERY_CHROMA_CROPS===0;
  if(!due)return{event,phase};
  const local=shiftQuad(d.trackedQuad,-(Number(d.originX)||0),-(Number(d.originY)||0));if(!local)return{event,phase};
  let image;
  try{image={data:new Uint8ClampedArray(d.buf),width:Number(d.w),height:Number(d.h)};}catch{return{event,phase};}
  phase.attempted=true;const started=performance.now();
  try{
    const refined=refineTrackedPhase(image,local,Number(d.trackedModules));
    phase.ms=performance.now()-started;
    if(!refined||refined.ratio<MIN_PHASE_RATIO)return{event,phase};
    const globalQuad=shiftQuad(refined.refinedQuad,Number(d.originX)||0,Number(d.originY)||0);if(!globalQuad)return{event,phase};
    phase.applied=true;phase.ratio=refined.ratio;state.forcePhase=false;
    return{event:{data:{...d,trackedQuad:globalQuad}},phase};
  }catch{phase.ms=performance.now()-started;return{event,phase};}
}

function attachPhase(response,phase) {
  if(!response)return response;
  response.phaseAttempted=Boolean(phase?.attempted);
  response.phaseApplied=Boolean(phase?.applied);
  response.phaseRatio=Number(phase?.ratio)||0;
  response.phaseMs=Number(phase?.ms)||0;
  response.phaseAttempts=phase?.attempted?1:0;
  response.phaseAppliedCount=phase?.applied?1:0;
  return response;
}

async function runBase(event) {
  let captured=null;
  const previous=self.postMessage;
  self.postMessage=(data,transfer)=>{
    if(data?.id===event.data?.id)captured=data;
    else if(transfer===undefined)nativePost(data);else nativePost(data,transfer);
  };
  try{await baseHandler.call(self,event);}finally{self.postMessage=previous;}
  return captured;
}

async function tryCustom(event,quadGlobal,{autoAlignment=true}={}) {
  const d=event.data||{};
  if(!quadGlobal||!d.buf||!(d.w>0)||!(d.h>0))return null;
  const local=shiftQuad(quadGlobal,-(Number(d.originX)||0),-(Number(d.originY)||0));if(!local)return null;
  const image={data:new Uint8ClampedArray(d.buf),width:Number(d.w),height:Number(d.h)};
  const state=stateFor(d.regionId);
  let decoded;
  if(autoAlignment){
    decoded=await decodeChromaRasterFast(image,local,{useAlignment:state.alignment});
    if(!decoded){
      decoded=await decodeChromaRasterFast(image,local,{useAlignment:!state.alignment});
      if(decoded)state.alignment=!state.alignment;
    }
  }else decoded=await decodeChromaRasterAuto(image,local,{preferAlignment:state.alignment});
  if(!decoded){state.forcePhase=true;return null;}
  state.forcePhase=false;
  state.alignment=Boolean(decoded.usedAlignment);
  const globalQuad=shiftQuad(local,Number(d.originX)||0,Number(d.originY)||0)||quadGlobal;
  const detection=makeDetection(globalQuad);
  return{decoded,detection};
}

function metricAggregate(customs) {
  const n=Math.max(1,customs.length);
  return{
    corrected:customs.reduce((s,c)=>s+(Number(c.decoded.corrected)||0),0),
    margin:customs.reduce((s,c)=>s+(Number(c.decoded.margin)||0),0)/n,
    calibration:customs.reduce((s,c)=>s+(Number(c.decoded.calibrationSeparation)||0),0)/n,
    alignment:customs.reduce((s,c)=>s+(Number(c.decoded.alignmentAnchors)||0),0)/n,
    resampled:customs.reduce((s,c)=>s+(Number(c.decoded.resampled)||0),0),
    decodeMs:customs.reduce((s,c)=>s+(Number(c.decoded.decodeMs)||0),0)/n
  };
}

function customResponse(event,customs,{base=null,fast=false,attempts=customs.length,phase=null}={}) {
  const d=event.data||{},list=Array.isArray(customs)?customs:[customs],m=metricAggregate(list);
  const detections=[...list.map(c=>c.detection).filter(Boolean)];
  if(base?.detections?.length)detections.push(...base.detections);
  return attachPhase({
    id:d.id,mode:d.mode||'full',regionId:d.regionId??null,
    detections,symbols:list.map(c=>c.decoded.bytes),auxSymbols:[],
    baseCount:list.length,auxCount:0,eightBase:0,
    color1Candidates:0,color1Count:0,color1Separation:0,
    color2Candidates:0,color2Count:0,color2Separation:0,
    trackedAttempted:d.mode==='crop',trackedHit:d.mode==='crop',
    trackedSeparation:m.calibration,trackedAnchorScore:0,
    trackedAlignmentAnchors:m.alignment,
    trackedKind:d.mode==='crop'?(m.alignment>0?'chroma-aligned':'chroma-fast'):'chroma-acquire',
    chromaAttempted:attempts>0,chromaAttempts:attempts,chromaCount:list.length,
    chromaCorrected:m.corrected,chromaMargin:m.margin,
    chromaCalibrationSeparation:m.calibration,chromaAlignmentAnchors:m.alignment,
    chromaResampled:m.resampled,chromaDecodeMs:m.decodeMs,
    chromaFast:fast,chromaFastCount:fast?list.length:0,error:null
  },phase);
}

self.onmessage=async event=>{
  const d=event.data||{};
  if(d.id==null)return baseHandler.call(self,event);

  const hinted=Boolean(d.mode==='crop'&&d.chromaHint&&d.trackedQuad&&Number(d.trackedModules)===CHROMA_MODULES);
  const phased=phaseLockEvent(event,{throttle:hinted});
  const workEvent=phased.event;
  const wd=workEvent.data||{};

  // Known CHROMA ROI: direct color matrix -> Hamming/CRC/QCT2 first. No ZXing
  // and no synthetic ImageData on the successful path.
  if(hinted){
    try{
      const custom=await tryCustom(workEvent,wd.trackedQuad,{autoAlignment:true});
      if(custom){nativePost(customResponse(workEvent,[custom],{fast:true,attempts:1,phase:phased.phase}));return;}
    }catch{}
  }

  const base=await runBase(workEvent);
  if(!base)return;
  attachPhase(base,phased.phase);
  if(d.id===-1){nativePost(base);return;}
  if((base.symbols?.length||0)>0||(base.auxSymbols?.length||0)>0){nativePost(base);return;}

  // A standard QR crop that missed stays a standard QR fallback. CHROMA is
  // discovered on full acquisition, avoiding an expensive color sweep on every
  // ordinary tracked miss.
  if(wd.mode!=='full'){
    if(hinted&&Array.isArray(base.detections)){
      const fresh=base.detections.find(plausibleCandidate);
      if(fresh){
        try{
          const custom=await tryCustom(workEvent,fresh.quad,{autoAlignment:false});
          if(custom){nativePost(customResponse(workEvent,[custom],{base,fast:false,attempts:1,phase:phased.phase}));return;}
        }catch{}
      }
      base.chromaAttempted=true;base.chromaAttempts=1;
    }
    nativePost(base);return;
  }

  // Full acquisition may contain two large CHROMA MAIN matrices. Try the
  // largest distinct V40-shaped sightings and return every CRC-valid symbol in
  // one worker response so both ROIs can become confirmed immediately.
  let attempts=0;
  try{
    const candidates=dedupeCandidates((Array.isArray(base.detections)?base.detections:[])
      .filter(plausibleCandidate)
      .sort((a,b)=>(b.w*b.h)-(a.w*a.h)))
      .slice(0,4);
    const customs=[];
    for(const detection of candidates){
      attempts++;
      const custom=await tryCustom(workEvent,detection.quad,{autoAlignment:false});
      if(custom)customs.push(custom);
      if(customs.length>=2)break;
    }
    if(customs.length){nativePost(customResponse(workEvent,customs,{base,fast:false,attempts,phase:phased.phase}));return;}
  }catch{}

  if(attempts){base.chromaAttempted=true;base.chromaAttempts=attempts;}
  nativePost(base);
};
