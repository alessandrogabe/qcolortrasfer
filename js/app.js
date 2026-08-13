import { FountainEncoder, FountainDecoder } from './fountain.js';
import {
  encodeOpticalPacket, encodeOpticalPacketV2, decodeOpticalPacket,
  packFileContainerV2, unpackFileContainerV2,
  randomStreamId, sha256Hex, HEADER_BYTES, HEADER_BYTES_V2
} from './protocol.js';
import {
  CAPACITY_BYTES, QR_ECC, MAX_GRID_CODES,
  createDualQrRaster, createTripleQrRaster, gridDims
} from './optical.js';
import {
  adaptiveDwellMs, adaptiveGridCap, adaptiveNextPaintAt, adaptiveOpticalFpsCeiling
} from './adaptive-scheduler.js';
import { RoiTracker, workerCountForHardware } from './rx-roi.js';
import {
  MAX_HIGH_THROUGHPUT_CHUNK, TX_LOOKAHEAD_PER_SLOT,
  chooseHighThroughputGrid, devicePixelsPerRasterCell,
  staggerSubIntervalMs, theoreticalFountainKiBs, txWorkerCountForHardware
} from './high-throughput.js';

const $ = id => document.getElementById(id);
const RX_CAPTURE_WIDTH = 1280;
const RX_CAPTURE_FPS_TARGET = 60;
const RX_CAPTURE_FPS_FALLBACK = 30;

const state = {
  selectedFile: null,
  encoder: null, meta: null, symbolId: 0, transmitting: false, txGeneration: 0, txStartedAt: 0, txSymbolsShown: 0,
  txSlots: 4, txCols: 2, txRows: 2, txCells: [], txCellPaintedAt: [], txStaging: null, txRasterSize: 0,
  txCellCursor: 0, txScale: 1, txStretch: 1, txLastItem: null, txGenerationMsEma: 0,
  txWorkers: [], txWorkerBusy: [], txWorkerJobs: [], txWorkerCount: 0, txWorkerCursor: 0, txJobId: 0,
  txQueue: [], txQueueMisses: 0, txRaf: 0,

  receiving: false, stream: null, track: null, captureGeneration: 0, captureCanvas: null,
  workers: [], workerBusy: [], workerTasks: [], workerCursor: 0, frameId: 0, rxWorkerCount: 0,
  roiTracker: new RoiTracker(),
  rxCaptured: 0, rxDroppedBusy: 0, rxFullScans: 0, rxCropTasks: 0, rxCropHits: 0,
  rxBaseDecoded: 0, rxEightBase: 0,
  rxColor1Candidates: 0, rxColor1Decoded: 0, rxColor1Separation: 0,
  rxColor2Candidates: 0, rxColor2Decoded: 0, rxColor2Separation: 0,
  rxPacketRejected: 0, rxWorkerErrors: 0,
  rxDecoder: null, rxMeta: null, rxStartedAt: 0, expectedHash: null, downloadUrl: null,
  rxFinalizing: false, rxComplete: false,
  wakeLock: null, installPrompt: null,
};

function log(message) {
  const el = $('log'); if (!el) return;
  const line = `${new Date().toLocaleTimeString()}  ${message}`;
  el.textContent = `${line}\n${el.textContent}`.slice(0, 30000);
}
function status(id, text, kind = '') { const el = $(id); if (!el) return; el.textContent = text; el.dataset.kind = kind; }
function formatBytes(bytes) { if (bytes < 1024) return `${bytes} B`; const units = ['KiB','MiB','GiB']; let value=bytes,unit=-1; do { value/=1024; unit++; } while(value>=1024&&unit<units.length-1); return `${value.toFixed(value>=10?1:2)} ${units[unit]}`; }
function sleep(ms) { return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve(); }
function compatiblePacket(a,b) {
  return a.streamId===b.streamId && a.sourceCount===b.sourceCount && a.chunkSize===b.chunkSize &&
    a.transferLength===b.transferLength && a.visualStates===b.visualStates && a.protocolVersion===b.protocolVersion;
}
function estimatedFountainTarget(k) { if(k<=4)return Math.max(k,Math.ceil(k*2.5)); if(k<32)return Math.ceil(k*1.6); if(k<128)return Math.ceil(k*1.35); return Math.ceil(k*1.20); }

// ---- TX profile -------------------------------------------------------------
function selectedColorMode() { return $('colorMode').value; }
function isAdaptiveMode() { return selectedColorMode() === '4a'; }
function selectedVisualStates() { return selectedColorMode() === '8' ? 8 : 4; }
function channelsPerQr() { return selectedVisualStates() === 8 ? 3 : 2; }
function selectedChunkBytes() { return Math.max(512, Math.min(MAX_HIGH_THROUGHPUT_CHUNK, Number($('payloadBytes').value) || MAX_HIGH_THROUGHPUT_CHUNK)); }
function selectedFps() { return Math.max(1, Math.min(60, Number($('fps').value) || 24)); }

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || state.wakeLock) return;
  try { state.wakeLock = await navigator.wakeLock.request('screen'); state.wakeLock.addEventListener('release',()=>{state.wakeLock=null;}); }
  catch(error){ log(`Wake lock non disponibile: ${error.message}`); }
}
async function releaseWakeLockIfIdle() { if(state.transmitting||state.receiving||!state.wakeLock)return; try{await state.wakeLock.release();}catch{} state.wakeLock=null; }

function txStageBudget() {
  const stage=$('txStage'),style=getComputedStyle(stage),px=value=>Number.parseFloat(value)||0;
  return { width:Math.max(1,stage.clientWidth-px(style.paddingLeft)-px(style.paddingRight)), height:Math.max(1,stage.clientHeight-px(style.paddingTop)-px(style.paddingBottom)) };
}
function selectedGridCount(rasterSize = state.txRasterSize || 185) {
  const mode=$('gridMode').value;
  if(mode!=='auto') return Math.max(1,Math.min(MAX_GRID_CODES,Number(mode)||4));
  const {width,height}=txStageBudget();
  return chooseHighThroughputGrid(width,height,Math.min(globalThis.devicePixelRatio||1,3),rasterSize);
}
function updateGridLabel() {
  const {width,height}=txStageBudget();
  const side=Math.floor(Math.min(width/state.txCols,height/state.txRows));
  const modulePx=state.txRasterSize?devicePixelsPerRasterCell(state.txSlots,width,height,Math.min(globalThis.devicePixelRatio||1,3),state.txRasterSize):0;
  const dwell=isAdaptiveMode()?` · dwell ≥${Math.round(adaptiveDwellMs(selectedFps()))}ms`:'';
  $('gridState').textContent=`${state.txSlots} QR · ${state.txCols}×${state.txRows} · ~${side}px · ${modulePx?modulePx.toFixed(1):'—'} px/cella display${dwell}`;
}
function ensureTxStaging() {
  if(!state.txRasterSize)return;
  const width=state.txRasterSize*state.txCols,height=state.txRasterSize*state.txRows;
  if(!state.txStaging)state.txStaging=document.createElement('canvas');
  if(state.txStaging.width!==width||state.txStaging.height!==height){state.txStaging.width=width;state.txStaging.height=height;}
  const ctx=state.txStaging.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);
  state.txCells.forEach((item,index)=>{if(!item)return;const x=(index%state.txCols)*state.txRasterSize,y=Math.floor(index/state.txCols)*state.txRasterSize;ctx.putImageData(new ImageData(item.raster.pixels,state.txRasterSize,state.txRasterSize),x,y);});
}
function resizeTxCanvas() {
  if(!state.txRasterSize||!state.txStaging)return;
  const {width:budgetW,height:budgetH}=txStageBudget(),logicalW=state.txRasterSize*state.txCols,logicalH=state.txRasterSize*state.txRows;
  const dpr=Math.min(globalThis.devicePixelRatio||1,3),scale=Math.max(1,Math.floor(Math.min((budgetW*dpr)/logicalW,(budgetH*dpr)/logicalH)));
  const canvas=$('txCanvas');canvas.width=logicalW*scale;canvas.height=logicalH*scale;state.txScale=scale;
  const nativeCssW=canvas.width/dpr,nativeCssH=canvas.height/dpr,stretch=Math.max(0.1,Math.min(budgetW/nativeCssW,budgetH/nativeCssH));state.txStretch=stretch;
  canvas.style.width=`${nativeCssW*stretch}px`;canvas.style.height=`${nativeCssH*stretch}px`;canvas.style.imageRendering='auto';
  const ctx=canvas.getContext('2d',{alpha:false});ctx.imageSmoothingEnabled=false;ctx.drawImage(state.txStaging,0,0,canvas.width,canvas.height);updateGridLabel();
}
function paintTxCell(index,item) {
  if(!item)return;
  if(!state.txRasterSize)state.txRasterSize=item.raster.size;
  if(item.raster.size!==state.txRasterSize)throw new Error('La versione QR è cambiata durante lo stream');
  state.txCells[index]=item;if(!state.txStaging)ensureTxStaging();
  const logicalX=(index%state.txCols)*state.txRasterSize,logicalY=Math.floor(index/state.txCols)*state.txRasterSize;
  state.txStaging.getContext('2d',{alpha:false}).putImageData(new ImageData(item.raster.pixels,state.txRasterSize,state.txRasterSize),logicalX,logicalY);
  const canvas=$('txCanvas');
  if(!canvas.width||!canvas.height)resizeTxCanvas();
  else{const ctx=canvas.getContext('2d',{alpha:false});ctx.imageSmoothingEnabled=false;const source=state.txRasterSize,dest=source*state.txScale;ctx.drawImage(state.txStaging,logicalX,logicalY,source,source,logicalX*state.txScale,logicalY*state.txScale,dest,dest);}
  state.txCellPaintedAt[index]=performance.now();state.txLastItem=item;updateTxMeta();
}
function updateModeBadge() {
  if(selectedColorMode()==='8')$('colorBadge').textContent='8 STATI · 3 CANALI EXP';
  else if(isAdaptiveMode())$('colorBadge').textContent='4 STATI · ADAPTIVE';
  else $('colorBadge').textContent='4 STATI · HIGH THROUGHPUT';
}
function updateTxMeta() {
  if(!state.encoder||!state.txLastItem){updateModeBadge();return;}
  const requested=selectedFps(),channels=state.meta.visualStates===8?3:2;
  const optical=isAdaptiveMode()?adaptiveOpticalFpsCeiling(requested):requested;
  const theoretical=theoreticalFountainKiBs(state.encoder.chunkSize,optical,state.txSlots,channels);
  const elapsed=state.txStartedAt?Math.max(0.001,(performance.now()-state.txStartedAt)/1000):0,actual=elapsed?(state.txSymbolsShown/elapsed).toFixed(1):'—';
  const fpsText=isAdaptiveMode()&&optical+0.01<requested?`${requested} target / ≤${optical.toFixed(1)} ottici`:`${requested} fps/QR`;
  const genText=state.txGenerationMsEma>0?` · raster ${state.txGenerationMsEma.toFixed(0)}ms`:'';
  const queueText=!isAdaptiveMode()?` · queue ${state.txQueue.length}/${Math.max(1,state.txSlots*TX_LOOKAHEAD_PER_SLOT)} · miss ${state.txQueueMisses}`:'';
  $('txFrame').textContent=`QCT2 · QR V${state.txLastItem.raster.version} ECC ${QR_ECC} · ${state.meta.visualStates} stati/${channels} canali · payload ${state.encoder.chunkSize} B · ${state.txSlots} QR · ${fpsText} · ~${theoretical.toFixed(1)} KiB/s teorici · ${actual} simboli/s${genText}${queueText}`;
  updateModeBadge();
}

function nextTxPackets(generation) {
  if(!state.encoder||generation!==state.txGeneration)return null;
  const channels=state.meta.visualStates===8?3:2;
  const symbolIds=Array.from({length:channels},(_,i)=>(state.symbolId+i)>>>0);state.symbolId=(state.symbolId+channels)>>>0;
  const symbols=symbolIds.map(id=>state.encoder.symbol(id));
  const packets=symbols.map((symbol,i)=>encodeOpticalPacketV2(state.meta,symbolIds[i],symbol.data));
  return {symbolIds,degrees:symbols.map(symbol=>symbol.indices.length),packets};
}
async function makeTxItemDirect(generation) {
  const prepared=nextTxPackets(generation);if(!prepared)return null;
  const started=performance.now();
  const raster=prepared.packets.length===3?await createTripleQrRaster(...prepared.packets):await createDualQrRaster(...prepared.packets);
  const ms=performance.now()-started;state.txGenerationMsEma=state.txGenerationMsEma?state.txGenerationMsEma*0.85+ms*0.15:ms;
  if(generation!==state.txGeneration)return null;
  return {symbolIds:prepared.symbolIds,degrees:prepared.degrees,raster};
}

function terminateTxWorkers() {
  for(const worker of state.txWorkers)worker?.terminate();
  state.txWorkers=[];state.txWorkerBusy=[];state.txWorkerJobs=[];state.txWorkerCursor=0;state.txWorkerCount=0;state.txQueue=[];
}
function txBusyCount(){return state.txWorkerBusy.reduce((sum,busy)=>sum+(busy?1:0),0);}
function nextFreeTxWorker(){for(let offset=0;offset<state.txWorkers.length;offset++){const index=(state.txWorkerCursor+offset)%state.txWorkers.length;if(!state.txWorkerBusy[index]){state.txWorkerCursor=(index+1)%state.txWorkers.length;return index;}}return-1;}
function ensureTxWorkers() {
  if(state.txWorkers.length)return;
  const count=txWorkerCountForHardware(navigator.hardwareConcurrency);state.txWorkerCount=count;
  for(let i=0;i<count;i++){
    const worker=new Worker(new URL('./tx-worker.js',import.meta.url),{type:'module'});
    worker.onmessage=event=>{
      const {id,ready,generation,raster,generationMs=0,error}=event.data||{};
      if(id===-1){if(ready)log(`TX raster worker ${i+1}/${count} pronto`);return;}
      const job=state.txWorkerJobs[i];state.txWorkerJobs[i]=null;state.txWorkerBusy[i]=false;
      if(error){log(`TX raster worker error: ${error}`);pumpTxQueue(state.txGeneration);return;}
      if(!job||generation!==state.txGeneration||job.generation!==generation){pumpTxQueue(state.txGeneration);return;}
      const pixels=new Uint8ClampedArray(raster.pixels);
      state.txQueue.push({symbolIds:job.symbolIds,degrees:job.degrees,raster:{...raster,pixels}});
      if(generationMs>0)state.txGenerationMsEma=state.txGenerationMsEma?state.txGenerationMsEma*0.85+generationMs*0.15:generationMs;
      pumpTxQueue(generation);updateTxMeta();
    };
    worker.onerror=event=>{state.txWorkerBusy[i]=false;state.txWorkerJobs[i]=null;log(`TX raster worker fatal: ${event.message}`);};
    state.txWorkers.push(worker);state.txWorkerBusy.push(false);state.txWorkerJobs.push(null);
  }
}
function dispatchTxJob(workerIndex,generation) {
  const prepared=nextTxPackets(generation);if(!prepared)return false;
  const id=state.txJobId++;const buffers=prepared.packets.map(packet=>packet.buffer);
  state.txWorkerBusy[workerIndex]=true;state.txWorkerJobs[workerIndex]={id,generation,symbolIds:prepared.symbolIds,degrees:prepared.degrees};
  state.txWorkers[workerIndex].postMessage({id,generation,visualStates:state.meta.visualStates,packets:buffers},buffers);return true;
}
function pumpTxQueue(generation) {
  if(!state.transmitting||generation!==state.txGeneration||isAdaptiveMode())return;
  ensureTxWorkers();const target=Math.max(state.txSlots, state.txSlots*TX_LOOKAHEAD_PER_SLOT);
  while(state.txQueue.length+txBusyCount()<target){const wi=nextFreeTxWorker();if(wi<0)break;if(!dispatchTxJob(wi,generation))break;}
}

async function rebuildTxGrid(reason='layout') {
  if(!state.encoder)return;
  const resume=state.transmitting;state.transmitting=false;const generation=++state.txGeneration;state.txQueue=[];state.txQueueMisses=0;
  const first=await makeTxItemDirect(generation);if(!first||generation!==state.txGeneration)return;
  state.txRasterSize=first.raster.size;
  const {width,height}=txStageBudget();state.txSlots=selectedGridCount(state.txRasterSize);const dims=gridDims(state.txSlots,width,height);state.txCols=dims.cols;state.txRows=dims.rows;
  state.txCells=new Array(state.txSlots).fill(null);state.txCellPaintedAt=new Array(state.txSlots).fill(0);state.txStaging=null;state.txCellCursor=0;
  ensureTxStaging();paintTxCell(0,first);
  const channels=state.meta.visualStates===8?3:2;state.txSymbolsShown+=channels;
  for(let index=1;index<state.txSlots;index++){const item=await makeTxItemDirect(generation);if(!item||generation!==state.txGeneration)return;paintTxCell(index,item);state.txSymbolsShown+=channels;}
  resizeTxCanvas();
  log(`TX ${reason}: ${state.txSlots} QR (${state.txCols}x${state.txRows}) · ${$('gridMode').value==='auto'?'AUTO 4/6':'manuale'} · QCT2 · ${state.encoder.chunkSize} B/canale · V${state.txLastItem.raster.version}`);
  if(resume&&generation===state.txGeneration){state.transmitting=true;state.txStartedAt=performance.now();state.txSymbolsShown=0;startTxScheduler(generation);}
}

async function configureSelectedFile(reason='configurazione') {
  if(!state.selectedFile)return;
  stopTransmit();
  const {name,bytes,hash}=state.selectedFile,streamId=randomStreamId(),chunkSize=selectedChunkBytes(),visualStates=selectedVisualStates();
  const container=packFileContainerV2(name,bytes,hash);const encoder=new FountainEncoder(container,chunkSize,streamId);
  if(encoder.sourceCount>0xffff)throw new Error('File troppo grande per questo payload QCT2: aumenta il payload per ridurre K.');
  const meta={protocolVersion:2,streamId,sourceCount:encoder.sourceCount,chunkSize:encoder.chunkSize,containerLength:container.length,visualStates};
  const probe=encodeOpticalPacketV2(meta,0,encoder.symbol(0).data);if(probe.length>CAPACITY_BYTES)throw new Error(`QCT2 ${probe.length} B supera il limite QR ${CAPACITY_BYTES} B`);
  state.encoder=encoder;state.meta=meta;state.symbolId=0;state.txSymbolsShown=0;state.txStartedAt=0;state.txGenerationMsEma=0;state.txQueue=[];state.txQueueMisses=0;
  const modeLabel=isAdaptiveMode()?'4 stati ADAPTIVE':visualStates===8?'8 stati EXP':'4 stati HIGH THROUGHPUT';
  $('txFileInfo').textContent=`${name} · ${formatBytes(bytes.length)} · container ${formatBytes(container.length)} · K=${encoder.sourceCount} × ${encoder.chunkSize} B · ${modeLabel} · QCT2 ${HEADER_BYTES_V2} B header · SHA-256 nel container`;
  status('txStatus',`Pronto · ${chunkSize} B/canale · ${modeLabel} · AUTO sceglie 4/6 QR in base allo spazio fisico disponibile.`,'ok');
  log(`TX ${reason}: ${name}, file=${bytes.length}, container=${container.length}, K=${encoder.sourceCount}, payload=${chunkSize}, states=${visualStates}`);
  await rebuildTxGrid(reason);
}
async function prepareFile(file){const bytes=new Uint8Array(await file.arrayBuffer()),hash=await sha256Hex(bytes);state.selectedFile={name:file.name,bytes,hash};await configureSelectedFile('file selezionato');}

async function txAdaptiveLoop(generation) {
  while(state.transmitting&&generation===state.txGeneration){const fps=selectedFps(),cellIndex=state.txCellCursor,started=performance.now();
    try{const item=await makeTxItemDirect(generation);if(!item)break;const nextPaintAt=adaptiveNextPaintAt(state.txCellPaintedAt[cellIndex],fps);await sleep(Math.max(0,nextPaintAt-performance.now()));if(!state.transmitting||generation!==state.txGeneration)break;paintTxCell(cellIndex,item);state.txCellCursor=(cellIndex+1)%state.txSlots;state.txSymbolsShown+=state.meta.visualStates===8?3:2;}
    catch(error){state.transmitting=false;status('txStatus',`Errore QR colore: ${error.message}`,'error');log(`TX QR error: ${error.stack||error.message}`);break;}
    const spent=performance.now()-started;if(spent<1)await sleep(1);
  }
}
function startHighThroughputLoop(generation) {
  state.txQueue=[];state.txQueueMisses=0;state.txCellCursor=0;ensureTxWorkers();pumpTxQueue(generation);
  let nextAt=performance.now(),lastTick=performance.now();
  const tick=now=>{
    if(!state.transmitting||generation!==state.txGeneration||isAdaptiveMode())return;
    state.txRaf=requestAnimationFrame(tick);
    const fps=selectedFps(),interval=1000/fps,sub=staggerSubIntervalMs(fps,state.txSlots);
    if(now-lastTick>1000){log(`TX rAF stall ${(now-lastTick).toFixed(0)} ms`);nextAt=now;}lastTick=now;
    if(now<nextAt)return;if(now-nextAt>interval)nextAt=now;
    let flips=0;
    while(now>=nextAt&&flips<state.txSlots){const item=state.txQueue.shift();if(!item){state.txQueueMisses++;nextAt=now+sub;break;}const cell=state.txCellCursor;paintTxCell(cell,item);state.txCellCursor=(cell+1)%state.txSlots;state.txSymbolsShown+=state.meta.visualStates===8?3:2;nextAt+=sub;flips++;pumpTxQueue(generation);}
  };
  state.txRaf=requestAnimationFrame(tick);
}
function startTxScheduler(generation){if(isAdaptiveMode())void txAdaptiveLoop(generation);else startHighThroughputLoop(generation);}
function startTransmit() {
  if(!state.encoder||state.transmitting)return;
  state.transmitting=true;state.txStartedAt=performance.now();state.txSymbolsShown=0;const generation=++state.txGeneration;requestWakeLock();
  const channels=state.meta.visualStates===8?3:2,requested=selectedFps(),optical=isAdaptiveMode()?adaptiveOpticalFpsCeiling(requested):requested;
  const theoretical=theoreticalFountainKiBs(state.encoder.chunkSize,optical,state.txSlots,channels);
  const schedulerText=isAdaptiveMode()?`ADAPTIVE · ${requested} fps target`:`LOOKAHEAD/rAF · ${requested} fps/QR`;
  status('txStatus',`Trasmissione attiva: QCT2 · ${schedulerText} · ${state.txSlots} QR · ${state.encoder.chunkSize} B/canale · ~${theoretical.toFixed(0)} KiB/s fountain teorici.`,'ok');
  log(`TX start · ${state.txSlots} QR · ${schedulerText} · ${channels} canali · ${state.encoder.chunkSize} B`);startTxScheduler(generation);
}
function stopTransmit(){state.transmitting=false;state.txGeneration++;if(state.txRaf)cancelAnimationFrame(state.txRaf);state.txRaf=0;state.txQueue=[];if(state.encoder)status('txStatus','Trasmissione in pausa. I QR visibili restano decodificabili.');releaseWakeLockIfIdle();}
async function toggleFullscreenTx(){const stage=$('txStage');try{if(document.fullscreenElement)await document.exitFullscreen();else if(stage.requestFullscreen)await stage.requestFullscreen();else status('txStatus','Schermo intero non supportato; ruota il dispositivo per sfruttare la larghezza.','warn');}catch(error){status('txStatus',`Schermo intero non disponibile: ${error.message}`,'warn');}}
let resizeTimer=null;
function scheduleTxDisplayRefresh(){clearTimeout(resizeTimer);resizeTimer=setTimeout(async()=>{if(!state.encoder)return;if($('gridMode').value==='auto'&&selectedGridCount()!==state.txSlots)await rebuildTxGrid('ridimensionamento');else resizeTxCanvas();},180);}
async function settingsChanged(kind){updateModeBadge();if(!state.selectedFile)return;if(kind==='payload'||kind==='color')await configureSelectedFile(kind==='payload'?'payload modificato':'profilo colore modificato');else if(selectedGridCount()!==state.txSlots)await rebuildTxGrid(`${kind} modificato`);else updateTxMeta();}

// ---- RX ROI + worker pool ---------------------------------------------------
function desiredRxWorkerCount(){return workerCountForHardware(navigator.hardwareConcurrency);}
function terminateWorkers(){for(const worker of state.workers)worker?.terminate();state.workers=[];state.workerBusy=[];state.workerTasks=[];state.workerCursor=0;state.rxWorkerCount=0;}
function nextFreeWorker(){for(let offset=0;offset<state.workers.length;offset++){const index=(state.workerCursor+offset)%state.workers.length;if(!state.workerBusy[index]){state.workerCursor=(index+1)%state.workers.length;return index;}}return-1;}
function busyWorkerCount(){return state.workerBusy.reduce((sum,busy)=>sum+(busy?1:0),0);}
function renderRxStats(){
  const decoder=state.rxDecoder,distinct=decoder?.framesNew||0,dup=decoder?.framesDup||0,solved=decoder?.solvedCount||0,total=decoder?.sourceCount||0,target=total?estimatedFountainTarget(total):0;
  const c1Pct=state.rxColor1Candidates?Math.round(state.rxColor1Decoded*100/state.rxColor1Candidates):0,c2Pct=state.rxColor2Candidates?Math.round(state.rxColor2Decoded*100/state.rxColor2Candidates):0;
  const elapsed=decoder?Math.max(0.001,(performance.now()-state.rxStartedAt)/1000):0,fountainKiB=decoder&&elapsed?(distinct*decoder.chunkSize/1024/elapsed):0;
  const sep1=state.rxColor1Separation?` sep1 ${state.rxColor1Separation.toFixed(2)}`:'',sep2=state.rxColor2Separation?` sep2 ${state.rxColor2Separation.toFixed(2)}`:'';
  const regions=state.roiTracker.active(performance.now()).length,peak=state.roiTracker.peakRegions,cropPct=state.rxCropTasks?Math.round(state.rxCropHits*100/state.rxCropTasks):0;
  $('rxStats').textContent=`${distinct} distinti · ${dup} duplicati · base ${state.rxBaseDecoded} · C1 ${state.rxColor1Decoded}/${state.rxColor1Candidates} (${c1Pct}%)${sep1} · C2 ${state.rxColor2Decoded}/${state.rxColor2Candidates} (${c2Pct}%)${sep2} · ${fountainKiB.toFixed(1)} KiB/s · ROI ${regions}/${peak} · crop ${state.rxCropHits}/${state.rxCropTasks} (${cropPct}%) · full ${state.rxFullScans} · worker ${busyWorkerCount()}/${state.rxWorkerCount} · ${state.rxDroppedBusy} saturi · peeling ${solved}/${total||'—'} · target ~${target||'—'}`;
}
function releaseWorkerTask(index){const task=state.workerTasks[index];if(task?.regionId!=null)state.roiTracker.markDone(task.regionId);state.workerTasks[index]=null;state.workerBusy[index]=false;}
function ensureWorkers(){
  if(state.workers.length)return;const workerCount=desiredRxWorkerCount();state.rxWorkerCount=workerCount;
  for(let i=0;i<workerCount;i++){
    const worker=new Worker(new URL('./qr-worker.js',import.meta.url),{type:'module'});
    worker.onmessage=event=>{const {id,ready,mode='full',detections=[],symbols=[],baseCount=0,eightBase=0,color1Candidates=0,color1Count=0,color1Separation=0,color2Candidates=0,color2Count=0,color2Separation=0,error}=event.data||{};
      if(id===-1){if(ready)log(`ZXing worker ${i+1}/${workerCount} pronto · fast crop + pure C1`);else{state.rxWorkerErrors++;status('rxStatus',`Decoder ZXing/colore non si inizializza: ${error}`,'error');}return;}
      releaseWorkerTask(i);if(detections.length)state.roiTracker.observe(detections,performance.now());if(mode==='crop'&&baseCount>0)state.rxCropHits++;
      if(error){state.rxWorkerErrors++;if(state.rxWorkerErrors<=3)log(`ZXing worker error: ${error}`);}state.rxBaseDecoded+=baseCount;state.rxEightBase+=eightBase;
      state.rxColor1Candidates+=color1Candidates;state.rxColor1Decoded+=color1Count;if(color1Separation>0)state.rxColor1Separation=color1Separation;
      state.rxColor2Candidates+=color2Candidates;state.rxColor2Decoded+=color2Count;if(color2Separation>0)state.rxColor2Separation=color2Separation;
      if(symbols.length&&!state.rxComplete)void onDecodedSymbols(symbols);renderRxStats();};
    worker.onerror=event=>{releaseWorkerTask(i);state.rxWorkerErrors++;status('rxStatus',`Worker QR: ${event.message}`,'error');log(`Worker QR fatal: ${event.message}`);};
    state.workers.push(worker);state.workerBusy.push(false);state.workerTasks.push(null);
  }
}
function submitWorkerImage(workerIndex,image,task){const id=state.frameId++;state.workerBusy[workerIndex]=true;state.workerTasks[workerIndex]=task;state.workers[workerIndex].postMessage({id,buf:image.data.buffer,w:image.width,h:image.height,mode:task.mode,regionId:task.regionId??null,originX:task.originX||0,originY:task.originY||0,decodeColor:task.mode==='crop'},[image.data.buffer]);}

async function tuneCameraTrack(track){try{const caps=track?.getCapabilities?.();if(caps?.focusMode?.includes?.('continuous'))await track.applyConstraints({advanced:[{focusMode:'continuous'}]});}catch(error){log(`Focus continuo non applicato: ${error.message}`);}}
async function getCameraStream(){const base={facingMode:{ideal:'environment'},width:{ideal:RX_CAPTURE_WIDTH},height:{ideal:Math.round(RX_CAPTURE_WIDTH*3/4)}};try{return await navigator.mediaDevices.getUserMedia({audio:false,video:{...base,frameRate:{exact:RX_CAPTURE_FPS_TARGET}}});}catch(firstError){log(`Camera ${RX_CAPTURE_FPS_TARGET} fps exact non disponibile: ${firstError.message}`);try{return await navigator.mediaDevices.getUserMedia({audio:false,video:{...base,frameRate:{exact:RX_CAPTURE_FPS_FALLBACK}}});}catch{return navigator.mediaDevices.getUserMedia({audio:false,video:{...base,frameRate:{ideal:RX_CAPTURE_FPS_TARGET}}});}}}
async function startCamera(){
  if(state.receiving)return;if(!navigator.mediaDevices?.getUserMedia){status('rxStatus','La fotocamera richiede HTTPS e un browser compatibile.','error');return;}
  ensureWorkers();state.roiTracker.reset();state.rxFullScans=0;state.rxCropTasks=0;state.rxCropHits=0;
  try{state.stream=await getCameraStream();const video=$('rxVideo');video.srcObject=state.stream;await video.play();state.track=state.stream.getVideoTracks()[0]||null;await tuneCameraTrack(state.track);state.receiving=true;state.captureGeneration++;state.rxStartedAt=performance.now();requestWakeLock();const settings=state.track?.getSettings?.()||{};status('rxStatus',`Camera ${settings.width||video.videoWidth}×${settings.height||video.videoHeight}@${Math.round(settings.frameRate||0)} · ${state.rxWorkerCount} worker · full acquire + ROI fast crop.`,'ok');log(`RX camera: ${state.track?.label||'video'} · ${video.videoWidth}x${video.videoHeight} · ${Math.round(settings.frameRate||0)} fps · ${state.rxWorkerCount} worker`);scheduleCapture(state.captureGeneration);}catch(error){status('rxStatus',`Fotocamera non disponibile: ${error.message}`,'error');log(`RX camera error: ${error.name} ${error.message}`);}}
function stopCamera(){state.receiving=false;state.captureGeneration++;state.stream?.getTracks().forEach(track=>track.stop());state.stream=null;state.track=null;$('rxVideo').srcObject=null;if(!state.rxDecoder?.complete&&!state.rxFinalizing&&!state.rxComplete)status('rxStatus','Fotocamera ferma.');releaseWakeLockIfIdle();}
function resetReceiver(){state.rxDecoder=null;state.rxMeta=null;state.rxCaptured=0;state.rxDroppedBusy=0;state.rxFullScans=0;state.rxCropTasks=0;state.rxCropHits=0;state.rxBaseDecoded=0;state.rxEightBase=0;state.roiTracker.reset();state.rxColor1Candidates=0;state.rxColor1Decoded=0;state.rxColor1Separation=0;state.rxColor2Candidates=0;state.rxColor2Decoded=0;state.rxColor2Separation=0;state.rxPacketRejected=0;state.rxWorkerErrors=0;state.expectedHash=null;state.rxStartedAt=performance.now();state.rxFinalizing=false;state.rxComplete=false;$('rxProgress').value=0;if(state.downloadUrl)URL.revokeObjectURL(state.downloadUrl);state.downloadUrl=null;const download=$('download');download.hidden=true;download.removeAttribute('href');renderRxStats();status('rxStatus',state.receiving?'Ricevitore azzerato. Riacquisizione ROI in corso.':'Ricevitore azzerato.');log('RX reset');}

async function acceptPacket(packet){
  if(state.rxFinalizing||state.rxComplete)return;
  if(!state.rxDecoder||state.rxMeta?.streamId!==packet.streamId){state.rxMeta=packet;state.rxDecoder=new FountainDecoder(packet.sourceCount,packet.chunkSize,packet.transferLength,packet.streamId);state.expectedHash=packet.sha256;state.rxStartedAt=performance.now();log(`RX nuovo stream ${packet.streamId}: QCT${packet.protocolVersion}, transfer=${packet.transferLength} B, K=${packet.sourceCount}, payload=${packet.chunkSize}, states=${packet.visualStates}`);}else if(!compatiblePacket(state.rxMeta,packet))throw new Error('Metadati stream incoerenti');
  const added=state.rxDecoder.addSymbol(packet.symbolId,packet.payload);if(!added)return;const target=estimatedFountainTarget(state.rxDecoder.sourceCount),estimatedFraction=state.rxDecoder.complete?1:Math.min(0.99,state.rxDecoder.framesNew/target),pct=Math.floor(estimatedFraction*1000)/10;$('rxProgress').value=pct;
  const elapsed=Math.max(0.001,(performance.now()-state.rxStartedAt)/1000),validRate=state.rxDecoder.framesNew/elapsed,fountainKiB=validRate*state.rxDecoder.chunkSize/1024;renderRxStats();status('rxStatus',`Ricezione ~${pct}% · ${state.rxDecoder.framesNew}/${target} distinti · ${validRate.toFixed(1)} simboli/s · ${fountainKiB.toFixed(1)} KiB/s · QCT${packet.protocolVersion} · ROI ${state.roiTracker.regions.length}`,'ok');if(!state.rxDecoder.complete)return;

  state.rxFinalizing=true;$('rxProgress').value=100;stopCamera();const completeElapsed=Math.max(0.001,(performance.now()-state.rxStartedAt)/1000);const transport=state.rxDecoder.reconstruct();
  let fileBytes=transport,fileName=state.rxMeta.fileName||'qcolortrasfer.bin',expectedHash=state.expectedHash;
  if(state.rxMeta.containerized){const unpacked=unpackFileContainerV2(transport);fileBytes=unpacked.bytes;fileName=unpacked.fileName;expectedHash=unpacked.sha256;}
  const hash=await sha256Hex(fileBytes);if(hash&&expectedHash&&hash!==expectedHash){state.rxComplete=true;state.rxFinalizing=false;status('rxStatus','File ricostruito ma SHA-256 non coincide. Download bloccato.','error');log(`SHA-256 FAIL: atteso ${expectedHash}, ricevuto ${hash}`);return;}
  if(state.downloadUrl)URL.revokeObjectURL(state.downloadUrl);state.downloadUrl=URL.createObjectURL(new Blob([fileBytes],{type:'application/octet-stream'}));const link=$('download');link.href=state.downloadUrl;link.download=fileName;link.hidden=false;link.textContent=`SCARICA ${fileName} (${formatBytes(fileBytes.length)})`;
  const effectiveKiB=fileBytes.length/1024/completeElapsed;state.rxComplete=true;state.rxFinalizing=false;status('rxStatus',`COMPLETATO · ${formatBytes(fileBytes.length)} · ${completeElapsed.toFixed(2)} s · ${effectiveKiB.toFixed(1)} KiB/s file · SHA-256 ${hash&&expectedHash?'OK':'N/D'} · ${state.rxDecoder.framesNew} simboli distinti`,'ok');log(`RX completo: ${fileName}, ${fileBytes.length} byte, ${completeElapsed.toFixed(3)} s, ${effectiveKiB.toFixed(2)} KiB/s, ${state.rxDecoder.framesNew} simboli, QCT${state.rxMeta.protocolVersion}, ROIpeak=${state.roiTracker.peakRegions}`);
}
async function onDecodedSymbols(symbols){for(const raw of symbols){if(state.rxFinalizing||state.rxComplete)break;try{const bytes=raw instanceof Uint8Array?raw:new Uint8Array(raw),packet=decodeOpticalPacket(bytes);await acceptPacket(packet);}catch(error){state.rxPacketRejected++;if(state.rxPacketRejected<=3||state.rxPacketRejected%20===0)log(`QR letto ma pacchetto rifiutato: ${error.message}`);}}renderRxStats();}

function captureFrame(){
  const video=$('rxVideo'),width=video.videoWidth,height=video.videoHeight;if(!width||!height||state.rxFinalizing||state.rxComplete)return;state.rxCaptured++;
  if(!state.captureCanvas)state.captureCanvas=document.createElement('canvas');const canvas=state.captureCanvas;if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;state.roiTracker.reset();}
  const ctx=canvas.getContext('2d',{alpha:false,willReadFrequently:true});ctx.drawImage(video,0,0,width,height);const now=performance.now();state.roiTracker.prune(now);let submitted=0;
  if(state.roiTracker.shouldFullScan(now)){const workerIndex=nextFreeWorker();if(workerIndex>=0){const image=ctx.getImageData(0,0,width,height);state.roiTracker.noteFullScan(now);state.rxFullScans++;submitWorkerImage(workerIndex,image,{mode:'full',regionId:null,originX:0,originY:0});submitted++;}}
  const freeSlots=Math.max(0,state.rxWorkerCount-busyWorkerCount()),regions=state.roiTracker.chooseForCrops(freeSlots,now);
  for(const region of regions){const workerIndex=nextFreeWorker();if(workerIndex<0)break;const crop=state.roiTracker.cropFor(region,width,height),image=ctx.getImageData(crop.x,crop.y,crop.w,crop.h);if(!state.roiTracker.markSubmitted(region.id,now))continue;state.rxCropTasks++;submitWorkerImage(workerIndex,image,{mode:'crop',regionId:region.id,originX:crop.x,originY:crop.y});submitted++;}
  if(submitted===0&&busyWorkerCount()>=state.rxWorkerCount)state.rxDroppedBusy++;if(state.rxCaptured%15===0)renderRxStats();
}
function scheduleCapture(generation){if(!state.receiving||generation!==state.captureGeneration)return;const video=$('rxVideo'),next=()=>{if(!state.receiving||generation!==state.captureGeneration)return;captureFrame();scheduleCapture(generation);};if(typeof video.requestVideoFrameCallback==='function')video.requestVideoFrameCallback(next);else requestAnimationFrame(next);}

async function runSelfTest(){
  try{
    const file=Uint8Array.from({length:4096},(_,i)=>(i*37+11)&255),hash='ab'.repeat(32),container=packFileContainerV2('selftest.bin',file,hash),streamId=0x12345678,enc=new FountainEncoder(container,MAX_HIGH_THROUGHPUT_CHUNK,streamId);
    const meta={streamId,sourceCount:enc.sourceCount,chunkSize:enc.chunkSize,containerLength:container.length,visualStates:4};
    const p0=encodeOpticalPacketV2(meta,0,enc.symbol(0).data),p1=encodeOpticalPacketV2(meta,1,enc.symbol(1).data);if(p0.length!==CAPACITY_BYTES)throw new Error(`QCT2 MAX inatteso: ${p0.length}`);
    const decoded=decodeOpticalPacket(p0);if(decoded.protocolVersion!==2||decoded.chunkSize!==MAX_HIGH_THROUGHPUT_CHUNK)throw new Error('QCT2 decode non coerente');
    const dual=await createDualQrRaster(p0,p1);if(dual.visualStates!==4||dual.channels!==2)throw new Error('dual color non attivo');
    const legacyMeta={streamId:1,sourceCount:1,chunkSize:32,fileLength:3,fileName:'x',sha256:null,visualStates:4};if(decodeOpticalPacket(encodeOpticalPacket(legacyMeta,0,new Uint8Array(32))).protocolVersion!==1)throw new Error('QCT1 compatibility persa');
    const roi=new RoiTracker();roi.observe([{x:20,y:20,w:100,h:100,decoded:true}],0);if(roi.regions.length!==1||workerCountForHardware(4)!==4)throw new Error('ROI/worker pool non coerente');
    status('selfTest',`Autotest: OK · QCT2 ${MAX_HIGH_THROUGHPUT_CHUNK} B/canale · QR V${dual.version} · 4 stati/2 canali · AUTO 4/6 · RX fino a 6 worker.`,'ok');log(`Autotest v2 OK · QR V${dual.version}, ${dual.modules} moduli, packet ${p0.length} B`);
  }catch(error){status('selfTest',`Autotest: ERRORE · ${error.message}`,'error');log(`Autotest FAIL: ${error.stack||error.message}`);}
}
function updateNetworkState(){$('netState').textContent=navigator.onLine?'rete: online':'rete: offline';}
async function setupPwa(){updateNetworkState();window.addEventListener('online',updateNetworkState);window.addEventListener('offline',updateNetworkState);const standalone=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;if(standalone)$('pwaState').textContent='app: installata';if('serviceWorker'in navigator&&location.protocol!=='file:'){try{const registration=await navigator.serviceWorker.register('./sw.js',{scope:'./'});$('pwaState').textContent=standalone?'app: installata':'app: offline pronta';registration.update().catch(()=>{});log(`Service worker registrato: ${registration.scope}`);}catch(error){$('pwaState').textContent='app: SW errore';log(`Service worker error: ${error.message}`);}}window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();state.installPrompt=event;$('installPwa').hidden=false;});window.addEventListener('appinstalled',()=>{$('installPwa').hidden=true;$('pwaState').textContent='app: installata';state.installPrompt=null;});$('installPwa').addEventListener('click',async()=>{if(!state.installPrompt)return;await state.installPrompt.prompt();await state.installPrompt.userChoice;state.installPrompt=null;$('installPwa').hidden=true;});}

$('fileInput').addEventListener('change',event=>{const file=event.target.files?.[0];if(file)prepareFile(file).catch(error=>{status('txStatus',error.message,'error');log(`TX prepare error: ${error.stack||error.message}`);});});
$('startTx').addEventListener('click',startTransmit);$('stopTx').addEventListener('click',stopTransmit);$('fullTx').addEventListener('click',toggleFullscreenTx);
$('gridMode').addEventListener('change',()=>{void settingsChanged('griglia');});$('fps').addEventListener('change',()=>{void settingsChanged('fps');});$('payloadBytes').addEventListener('change',()=>{void settingsChanged('payload');});$('colorMode').addEventListener('change',()=>{void settingsChanged('color');});
$('startRx').addEventListener('click',startCamera);$('stopRx').addEventListener('click',stopCamera);$('resetRx').addEventListener('click',resetReceiver);
window.addEventListener('resize',scheduleTxDisplayRefresh);window.addEventListener('orientationchange',scheduleTxDisplayRefresh);document.addEventListener('fullscreenchange',scheduleTxDisplayRefresh);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&(state.transmitting||state.receiving))requestWakeLock();});
window.addEventListener('beforeunload',()=>{stopTransmit();stopCamera();terminateTxWorkers();terminateWorkers();if(state.downloadUrl)URL.revokeObjectURL(state.downloadUrl);});

$('capacity').textContent=`QCT2 · fino a ${MAX_HIGH_THROUGHPUT_CHUNK} B/canale · AUTO 4/6 QR · TX 60 fps max · RX 1280@60 / 2–6 worker`;
updateModeBadge();resetReceiver();setupPwa();void runSelfTest();
