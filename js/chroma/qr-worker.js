// qcolortrasfer unified MAIN COLOR RX worker wrapper v3.1 (MIT).
//
// MAIN COLOR always acquires through a standards-valid luminance QR. Once the
// base QR yields geometry, the independent chroma fountain plane is sampled
// directly from the same pixels. Known MAIN COLOR crops may decode chroma even
// if the base QR misses that frame; the base path remains the normal QR fallback.

import { decodeChromaRasterFast, decodeChromaRasterAuto } from '../chroma-fast-decoder.js';
import { CHROMA_MODULES, isNativeChromaPacket } from '../chroma-fountain.js';
import { shiftQuad } from '../tracked-qr.js';
import { refineTrackedPhase } from '../tracked-phase.js';
import { detectionBoxFromPosition, boxIou } from '../rx-roi.js';

const nativePost=self.postMessage.bind(self);
await import('../qr-worker.js');
const baseHandler=self.onmessage;
const regionState=new Map();
const PHASE_EVERY_CHROMA_CROPS=4,MIN_PHASE_RATIO=.78;

function stateFor(regionId){const key=regionId??'__full__';let state=regionState.get(key);if(!state){state={frames:0,forcePhase:true,alignment:false};regionState.set(key,state);}return state;}
function symbolIdOf(bytes){try{return new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(12);}catch{return-1;}}
function makeDetection(globalQuad){const box=detectionBoxFromPosition(globalQuad,0,0);return box?{...box,quad:globalQuad,modules:CHROMA_MODULES,version:40,decoded:true,transport:'chroma'}:null;}
function markChromaDetection(d){if(d?.quad&&d.decoded!==false&&Number(d.modules)===CHROMA_MODULES)d.transport='chroma';return d;}

function phaseLockEvent(event,{throttle=false}={}){
  const d=event.data||{},phase={attempted:false,applied:false,ratio:0,ms:0};
  if(d.mode!=='crop'||!d.trackedQuad||!(Number(d.trackedModules)>0)||!d.buf||!(d.w>0)||!(d.h>0))return{event,phase};
  const state=stateFor(d.regionId);state.frames++;const due=!throttle||state.forcePhase||state.frames%PHASE_EVERY_CHROMA_CROPS===0;if(!due)return{event,phase};
  const local=shiftQuad(d.trackedQuad,-(Number(d.originX)||0),-(Number(d.originY)||0));if(!local)return{event,phase};
  let image;try{image={data:new Uint8ClampedArray(d.buf),width:Number(d.w),height:Number(d.h)};}catch{return{event,phase};}
  phase.attempted=true;const started=performance.now();
  try{
    const refined=refineTrackedPhase(image,local,Number(d.trackedModules));phase.ms=performance.now()-started;
    if(!refined||refined.ratio<MIN_PHASE_RATIO)return{event,phase};
    const globalQuad=shiftQuad(refined.refinedQuad,Number(d.originX)||0,Number(d.originY)||0);if(!globalQuad)return{event,phase};
    phase.applied=true;phase.ratio=refined.ratio;state.forcePhase=false;return{event:{data:{...d,trackedQuad:globalQuad}},phase};
  }catch{phase.ms=performance.now()-started;return{event,phase};}
}
function attachPhase(response,phase){if(!response)return response;response.phaseAttempted=Boolean(phase?.attempted);response.phaseApplied=Boolean(phase?.applied);response.phaseRatio=Number(phase?.ratio)||0;response.phaseMs=Number(phase?.ms)||0;response.phaseAttempts=phase?.attempted?1:0;response.phaseAppliedCount=phase?.applied?1:0;return response;}

async function runBase(event){
  let captured=null;const previous=self.postMessage;
  self.postMessage=(data,transfer)=>{if(data?.id===event.data?.id)captured=data;else if(transfer===undefined)nativePost(data);else nativePost(data,transfer);};
  try{await baseHandler.call(self,event);}finally{self.postMessage=previous;}return captured;
}

async function trySide(event,quadGlobal,{autoAlignment=true}={}){
  const d=event.data||{};if(!quadGlobal||!d.buf||!(d.w>0)||!(d.h>0))return null;
  const local=shiftQuad(quadGlobal,-(Number(d.originX)||0),-(Number(d.originY)||0));if(!local)return null;
  const image={data:new Uint8ClampedArray(d.buf),width:Number(d.w),height:Number(d.h)},state=stateFor(d.regionId);let decoded;
  if(autoAlignment){decoded=await decodeChromaRasterFast(image,local,{useAlignment:state.alignment});if(!decoded){decoded=await decodeChromaRasterFast(image,local,{useAlignment:!state.alignment});if(decoded)state.alignment=!state.alignment;}}
  else decoded=await decodeChromaRasterAuto(image,local,{preferAlignment:state.alignment});
  if(!decoded){state.forcePhase=true;return null;}state.forcePhase=false;state.alignment=Boolean(decoded.usedAlignment);
  const globalQuad=shiftQuad(local,Number(d.originX)||0,Number(d.originY)||0)||quadGlobal;return{decoded,detection:makeDetection(globalQuad)};
}

function aggregate(sides){
  const n=Math.max(1,sides.length);return{
    corrected:sides.reduce((s,c)=>s+(Number(c.decoded.corrected)||0),0),
    margin:sides.reduce((s,c)=>s+(Number(c.decoded.margin)||0),0)/n,
    calibration:sides.reduce((s,c)=>s+(Number(c.decoded.calibrationSeparation)||0),0)/n,
    alignment:sides.reduce((s,c)=>s+(Number(c.decoded.alignmentAnchors)||0),0)/n,
    resampled:sides.reduce((s,c)=>s+(Number(c.decoded.resampled)||0),0),
    decodeMs:sides.reduce((s,c)=>s+(Number(c.decoded.decodeMs)||0),0)/n
  };
}

function mergeSide(base,sides,{attempts=0,fastCount=0,phase=null}={}){
  const response=base||{id:null,mode:'full',regionId:null,detections:[],symbols:[],auxSymbols:[],baseCount:0,auxCount:0,eightBase:0,color1Candidates:0,color1Count:0,color1Separation:0,color2Candidates:0,color2Count:0,color2Separation:0,error:null};
  attachPhase(response,phase);response.symbols=Array.isArray(response.symbols)?response.symbols:[];response.detections=Array.isArray(response.detections)?response.detections:[];
  const ids=new Set(response.symbols.map(symbolIdOf));
  for(const side of sides){const id=symbolIdOf(side.decoded.bytes);if(!ids.has(id)){response.symbols.push(side.decoded.bytes);ids.add(id);}if(side.detection&&!response.detections.some(d=>d?.quad&&boxIou(d,side.detection)>.7))response.detections.push(side.detection);}
  const m=aggregate(sides);response.chromaAttempted=attempts>0;response.chromaAttempts=attempts;response.chromaCount=sides.length;response.chromaCorrected=m.corrected;response.chromaMargin=m.margin;response.chromaCalibrationSeparation=m.calibration;response.chromaAlignmentAnchors=m.alignment;response.chromaResampled=m.resampled;response.chromaDecodeMs=m.decodeMs;response.chromaFast=fastCount>0;response.chromaFastCount=fastCount;
  return response;
}

self.onmessage=async event=>{
  const d=event.data||{};if(d.id==null)return baseHandler.call(self,event);
  const hinted=Boolean(d.mode==='crop'&&d.chromaHint&&d.trackedQuad&&Number(d.trackedModules)===CHROMA_MODULES),phased=phaseLockEvent(event,{throttle:hinted}),workEvent=phased.event,wd=workEvent.data||{};
  const sides=[];let attempts=0,fastCount=0;

  // Known region: decode the cheap native chroma plane first. Even if the QR
  // base misses this frame, a CRC-valid chroma fountain symbol is still useful.
  if(hinted){attempts++;try{const side=await trySide(workEvent,wd.trackedQuad,{autoAlignment:true});if(side){sides.push(side);fastCount++;}}catch{}}

  const base=await runBase(workEvent);if(!base)return;
  attachPhase(base,phased.phase);if(d.id===-1){nativePost(base);return;}

  const nativeSymbols=(Array.isArray(base.symbols)?base.symbols:[]).filter(isNativeChromaPacket);
  const decodedV40=(Array.isArray(base.detections)?base.detections:[]).filter(det=>det?.decoded!==false&&det?.quad&&Number(det.modules)===CHROMA_MODULES);
  if(nativeSymbols.length){for(const det of decodedV40)markChromaDetection(det);}

  // On acquisition (or after a base fallback recovery), use every decoded V40
  // geometry to recover the side plane. Skip a geometry already covered by the
  // successful hinted side attempt.
  if(nativeSymbols.length&&decodedV40.length){
    const limit=Math.min(nativeSymbols.length,decodedV40.length,2);
    for(let i=0;i<limit;i++){
      const detection=decodedV40[i];if(sides.some(side=>side.detection&&boxIou(side.detection,detection)>.7))continue;
      attempts++;try{const side=await trySide(workEvent,detection.quad,{autoAlignment:d.mode==='crop'});if(side)sides.push(side);}catch{}
    }
  }

  // A known crop can legitimately return only the chroma symbol when the luma
  // QR failed. Preserve that progress instead of converting the frame to zero.
  if(sides.length||attempts){nativePost(mergeSide(base,sides,{attempts,fastCount,phase:phased.phase}));return;}
  nativePost(base);
};
