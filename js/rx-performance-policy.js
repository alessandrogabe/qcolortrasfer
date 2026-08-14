// qcolortrasfer RX performance policy v2.8 (MIT).
//
// The worker owns decoding. This bridge wires decoded quad/module geometry back
// into future crop jobs, performs a cheap timing-pattern phase lock on the crop
// buffer before transfer, measures tracked-path quality, assembles QAR1/QAR2
// repair packets and injects completed source blocks into the compatible LT
// decoder. Camera extras are capability-gated rather than UA-gated.
//
// This is an independent implementation informed by public high-throughput
// optical architecture. No Decimen >=0.4 AGPL source is incorporated.

import { AuxRepairAssembler } from './aux-repair.js';
import { findCompatibleFountainDecoder } from './fountain.js';
import { refineTrackedPhase } from './tracked-phase.js';
import { shiftQuad } from './tracked-qr.js';

export const RX_ACQUIRE_WIDTH_TARGET = 1280;
export const RX_ACQUIRE_HEIGHT_TARGET = 960;
export const RX_WORKER_TARGET_MAX = 4;

export function desiredRxWorkerTarget(hardwareConcurrency) {
  const hc=Math.max(1,Math.floor(Number(hardwareConcurrency)||4));
  if(hc>=4)return 4;if(hc===3)return 3;return 2;
}
export function upgradeVideoConstraints(constraints){return constraints;}

const regionGeometry=new Map();
let recentFullDetections=[];
const taskStarted=new Map();
const auxAssembler=new AuxRepairAssembler();
let auxPendingBlocks=[];
let rxSessionStartedAt=-Infinity;
let focusRetryTimer=0;
const metrics={
  crops:0,full:0,trackedAttempts:0,trackedHits:0,fallbackHits:0,responses:0,latencyEma:0,qrWorkers:0,
  anchorScoreEma:0,alignmentEma:0,alignedHits:0,phaseAttempts:0,phaseApplied:0,phaseRatioEma:0,phaseMsEma:0,
  auxPackets:0,auxBlocks:0,auxInjected:0,auxPeelGain:0,auxErrors:0,auxRedundant:0,auxRankPeak:0,auxRankTotal:0,
  focus:'—'
};

function resetTrackedSession(){
  regionGeometry.clear();recentFullDetections=[];taskStarted.clear();auxAssembler.reset();auxPendingBlocks=[];
  Object.assign(metrics,{crops:0,full:0,trackedAttempts:0,trackedHits:0,fallbackHits:0,responses:0,latencyEma:0,anchorScoreEma:0,alignmentEma:0,alignedHits:0,phaseAttempts:0,phaseApplied:0,phaseRatioEma:0,phaseMsEma:0,auxPackets:0,auxBlocks:0,auxInjected:0,auxPeelGain:0,auxErrors:0,auxRedundant:0,auxRankPeak:0,auxRankTotal:0,focus:'—'});
  rxSessionStartedAt=globalThis.performance?.now?.()??Date.now();clearTimeout(focusRetryTimer);renderTrackedTelemetry();
}

function validGeometry(detection){return detection&&detection.decoded!==false&&detection.quad&&Number(detection.modules)>0;}
function rememberFullDetections(detections){const now=performance.now();recentFullDetections=(Array.isArray(detections)?detections:[]).filter(validGeometry).map(d=>({...d,rememberedAt:now}));}
function geometryForCrop(message){
  const known=regionGeometry.get(message.regionId);if(known)return known;
  const now=performance.now();recentFullDetections=recentFullDetections.filter(d=>now-d.rememberedAt<2200);
  const x0=Number(message.originX)||0,y0=Number(message.originY)||0,x1=x0+(Number(message.w)||0),y1=y0+(Number(message.h)||0),cx=(x0+x1)/2,cy=(y0+y1)/2;
  let best=null,bestDistance=Infinity;
  for(const detection of recentFullDetections){const dx=detection.x+detection.w/2,dy=detection.y+detection.h/2;if(dx<x0||dx>x1||dy<y0||dy>y1)continue;const distance=Math.hypot(dx-cx,dy-cy);if(distance<bestDistance){best=detection;bestDistance=distance;}}
  if(best){const geometry={quad:best.quad,modules:best.modules};regionGeometry.set(message.regionId,geometry);return geometry;}return null;
}

function phaseLockedGeometry(message,geometry){
  if(!geometry?.quad||!(geometry.modules>0)||!message?.buf||!(message.w>0)||!(message.h>0))return geometry;
  let data;
  try{data=new Uint8ClampedArray(message.buf);}catch{return geometry;}
  if(data.length<Number(message.w)*Number(message.h)*4)return geometry;
  const local=shiftQuad(geometry.quad,-(Number(message.originX)||0),-(Number(message.originY)||0));if(!local)return geometry;
  metrics.phaseAttempts++;const started=performance.now();
  try{
    const phase=refineTrackedPhase({data,width:Number(message.w),height:Number(message.h)},local,geometry.modules);
    metrics.phaseMsEma=ema(metrics.phaseMsEma,performance.now()-started,.12);
    if(!phase||phase.ratio<0.78)return geometry;
    const globalQuad=shiftQuad(phase.refinedQuad,Number(message.originX)||0,Number(message.originY)||0);if(!globalQuad)return geometry;
    metrics.phaseApplied++;metrics.phaseRatioEma=ema(metrics.phaseRatioEma,phase.ratio,.12);
    return{quad:globalQuad,modules:geometry.modules};
  }catch{metrics.phaseMsEma=ema(metrics.phaseMsEma,performance.now()-started,.12);return geometry;}
}

function flushAuxPending(){
  if(!auxPendingBlocks.length)return;const keep=[];
  for(const item of auxPendingBlocks){
    const decoder=findCompatibleFountainDecoder(item.sourceCount,item.chunkSize,item.containerLength,rxSessionStartedAt);
    if(!decoder){keep.push(item);continue;}
    const before=decoder.solvedCount;const injected=decoder.injectSourceBlock(item.blockIndex,item.block);
    if(injected){metrics.auxInjected++;metrics.auxPeelGain+=Math.max(0,decoder.solvedCount-before);}
  }
  auxPendingBlocks=keep;
}

function syncAuxMetrics(){
  metrics.auxPackets=auxAssembler.packetsNew;metrics.auxBlocks=auxAssembler.blocksCompleted;metrics.auxErrors=auxAssembler.crcFailures;
  metrics.auxRedundant=auxAssembler.equationsRedundant;metrics.auxRankPeak=auxAssembler.rankPeak;metrics.auxRankTotal=auxAssembler.rankTotal;
}
function handleAuxSymbols(symbols){
  if(!Array.isArray(symbols)||!symbols.length)return;
  for(const raw of symbols){try{const bytes=raw instanceof Uint8Array?raw:new Uint8Array(raw);const completed=auxAssembler.add(bytes);syncAuxMetrics();if(completed)auxPendingBlocks.push(completed);}catch{metrics.auxErrors++;}}
  queueMicrotask(()=>{flushAuxPending();renderTrackedTelemetry();});
}

async function applyContinuousFocus(attempt=0){
  const video=document.getElementById('rxVideo');const track=video?.srcObject?.getVideoTracks?.()[0];
  if(!track){if(attempt<8)focusRetryTimer=setTimeout(()=>void applyContinuousFocus(attempt+1),180);return;}
  try{
    const caps=track.getCapabilities?.();const modes=caps?.focusMode;
    if(Array.isArray(modes)&&modes.includes('continuous')){await track.applyConstraints({advanced:[{focusMode:'continuous'}]});metrics.focus='continuous';}
    else metrics.focus='camera-auto';
  }catch{metrics.focus='camera-default';}
  renderTrackedTelemetry();
}

function ema(current,value,weight=.15){return current?current*(1-weight)+value*weight:value;}
function renderTrackedTelemetry(){
  if(typeof document==='undefined')return;let el=document.getElementById('rxTrackedStats');const anchor=document.getElementById('rxStats');if(!anchor)return;
  if(!el){el=document.createElement('div');el.id='rxTrackedStats';el.className='stats telemetry-line';anchor.after(el);}
  const pct=metrics.trackedAttempts?Math.round(metrics.trackedHits*100/metrics.trackedAttempts):0;
  const phasePct=metrics.phaseAttempts?Math.round(metrics.phaseApplied*100/metrics.phaseAttempts):0;
  el.textContent=`TRACKED ${metrics.trackedHits}/${metrics.trackedAttempts} (${pct}%) · aligned ${metrics.alignedHits} · anchor ${metrics.anchorScoreEma?metrics.anchorScoreEma.toFixed(0):'—'}/147 · align ${metrics.alignmentEma?metrics.alignmentEma.toFixed(1):'—'} · phase ${metrics.phaseApplied}/${metrics.phaseAttempts} (${phasePct}%) ${metrics.phaseRatioEma?Math.round(metrics.phaseRatioEma*100):'—'}% ${metrics.phaseMsEma?metrics.phaseMsEma.toFixed(1):'—'}ms · fallback ${metrics.fallbackHits} · full ${metrics.full} · crop ${metrics.crops} · worker ${metrics.latencyEma?metrics.latencyEma.toFixed(1):'—'} ms EMA · pool ${desiredRxWorkerTarget(globalThis.navigator?.hardwareConcurrency)} · focus ${metrics.focus} · AUX eq ${metrics.auxPackets} · rank ${metrics.auxRankTotal} (peak ${metrics.auxRankPeak}) · red ${metrics.auxRedundant} · blocchi ${metrics.auxBlocks} · injected ${metrics.auxInjected} · peeling +${metrics.auxPeelGain} · pending ${auxPendingBlocks.length} · err ${metrics.auxErrors}`;
}

function instrumentQrWorker(worker){
  metrics.qrWorkers++;const nativePost=worker.postMessage.bind(worker),nativeTerminate=worker.terminate.bind(worker);
  worker.addEventListener('message',event=>{
    const data=event.data||{};if(data.id===-1)return;metrics.responses++;
    const started=taskStarted.get(data.id);if(started!=null){metrics.latencyEma=ema(metrics.latencyEma,performance.now()-started);taskStarted.delete(data.id);}
    if(data.mode==='full')rememberFullDetections(data.detections);
    if(data.regionId!=null&&Array.isArray(data.detections)){const confirmed=data.detections.find(validGeometry);if(confirmed)regionGeometry.set(data.regionId,{quad:confirmed.quad,modules:confirmed.modules});}
    if(data.trackedAttempted)metrics.trackedAttempts++;
    if(data.trackedHit){metrics.trackedHits++;if(data.trackedKind==='aligned')metrics.alignedHits++;if(Number(data.trackedAnchorScore)>0)metrics.anchorScoreEma=ema(metrics.anchorScoreEma,Number(data.trackedAnchorScore));metrics.alignmentEma=ema(metrics.alignmentEma,Number(data.trackedAlignmentAnchors)||0);}
    else if(data.trackedAttempted&&Number(data.baseCount||0)+Number(data.auxCount||0)>0)metrics.fallbackHits++;
    handleAuxSymbols(data.auxSymbols);queueMicrotask(flushAuxPending);renderTrackedTelemetry();
  });
  return new Proxy(worker,{get(target,prop){
    if(prop==='postMessage')return(message,transfer)=>{
      let outgoing=message;if(message&&message.id>=0)taskStarted.set(message.id,performance.now());
      if(message?.mode==='full')metrics.full++;
      if(message?.mode==='crop'){
        metrics.crops++;const geometry=message.regionId!=null?geometryForCrop(message):null;
        if(geometry){const locked=phaseLockedGeometry(message,geometry);outgoing={...message,trackedQuad:locked.quad,trackedModules:locked.modules};}
      }
      renderTrackedTelemetry();return transfer===undefined?nativePost(outgoing):nativePost(outgoing,transfer);
    };
    if(prop==='terminate')return()=>nativeTerminate();const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;
  },set(target,prop,value){return Reflect.set(target,prop,value,target);}});
}

function installWorkerTrackingBridge(){
  if(typeof globalThis.Worker!=='function'||globalThis.__QCOLOR_TRACKED_WORKER_BRIDGE)return;const NativeWorker=globalThis.Worker;
  try{globalThis.Worker=new Proxy(NativeWorker,{construct(Target,args){const worker=Reflect.construct(Target,args);const url=String(args?.[0]??'');return/(?:^|\/)qr-worker\.js(?:$|[?#])/.test(url)?instrumentQrWorker(worker):worker;}});globalThis.__QCOLOR_TRACKED_WORKER_BRIDGE=true;}catch{}
}

function armRxPerformancePolicy(){
  if(typeof navigator==='undefined')return;resetTrackedSession();globalThis.__QCOLOR_RX_WORKER_TARGET=desiredRxWorkerTarget(navigator.hardwareConcurrency);globalThis.__QCOLOR_RX_WARM_ACQUIRE=true;
  queueMicrotask(()=>{try{delete globalThis.__QCOLOR_RX_WORKER_TARGET;}catch{globalThis.__QCOLOR_RX_WORKER_TARGET=undefined;}});
  focusRetryTimer=setTimeout(()=>void applyContinuousFocus(),240);
}

function updateRuntimeLabels(){
  if(typeof document==='undefined')return;const capacity=document.getElementById('capacity');if(capacity)capacity.textContent=capacity.textContent.replace(/RX .*?worker/,'RX 1280@60 · pool 2–4 worker · phase+finder tracked + QAR2');
  const rxNote=document.querySelector('#rxView .note');if(rxNote)rxNote.innerHTML='<strong>RX FAST v2.8:</strong> 1280×960 con 60 fps exact quando disponibili; 2–4 worker. Prima del worker il timing pattern corregge la fase sub-modulo del quad cached; il tracked path riallinea poi i tre finder, usa soglie luminanza locali e alignment pattern prima del fallback ZXing. QAR2 usa equazioni repair da 256 B: pacchetti persi non azzerano più il progresso del blocco. Autofocus continuo viene richiesto solo quando la camera lo espone.';renderTrackedTelemetry();
}

installWorkerTrackingBridge();
if(typeof document!=='undefined'){
  document.getElementById('startRx')?.addEventListener('click',armRxPerformancePolicy,{capture:true});
  document.getElementById('resetRx')?.addEventListener('click',resetTrackedSession,{capture:true});
  document.getElementById('stopRx')?.addEventListener('click',()=>clearTimeout(focusRetryTimer),{capture:true});
}
if(typeof window!=='undefined')window.addEventListener('load',updateRuntimeLabels,{once:true});
