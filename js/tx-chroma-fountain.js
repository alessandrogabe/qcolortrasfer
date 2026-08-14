// qcolortrasfer CHROMA FOUNTAIN TX v2.9 (MIT).
//
// Experimental single-matrix mode. The standard V40 finder/timing/alignment
// modules remain B/W; every data module is one calibrated four-color cell.
// Payload is one 5384-byte QCT2 fountain symbol per optical frame. No AUX QR,
// no stacked QR and no color-overlaid QR payload.

import { FountainEncoder } from './fountain.js';
import { encodeOpticalPacketV2, packFileContainerV2, randomStreamId, sha256Hex } from './protocol.js';
import {
  CHROMA_CHUNK_BYTES, CHROMA_QCT_PACKET_BYTES, CHROMA_RASTER, CHROMA_MODULES, CHROMA_PALETTE
} from './chroma-fountain.js';
import { enterTxOpticalView, exitTxOpticalView } from './tx-optical-view.js';

const LOOKAHEAD=5;
const MAX_RENDER_DPR=4;
const DEFAULT_FPS=60;
const $=id=>document.getElementById(id);

function install(){
  if(typeof document==='undefined'||typeof window==='undefined')return;
  const variant=$('txClassicVariant'),method=$('txMethod'),fileInput=$('fileInput'),payload=$('payloadBytes'),fps=$('fps');
  const canvas=$('txCanvas'),stage=$('txStage'),status=$('txStatus'),fileInfo=$('txFileInfo'),frame=$('txFrame'),badge=$('colorBadge'),gridState=$('gridState');
  if(!variant||!method||!fileInput||!payload||!fps||!canvas||!stage)return;

  if(![...variant.options].some(o=>o.value==='chroma')){
    const option=new Option('CHROMA FOUNTAIN · 4 COLORI + B/N EXP','chroma');
    variant.add(option);
  }

  let session=null,running=false,generation=0,raf=0,queue=[],workers=[],busy=[],jobs=[],cursor=0,jobId=0;
  let current=null,shown=0,misses=0,startedAt=0,generationMs=0,wakeLock=null,renderScale=1,bypass=false;
  let savedPayload=payload.value,savedFps=fps.value;
  const staging=document.createElement('canvas');staging.width=CHROMA_RASTER;staging.height=CHROMA_RASTER;

  function enabled(){return method.value==='classic'&&variant.value==='chroma';}
  function setStatus(text,kind=''){if(status){status.textContent=text;status.dataset.kind=kind;}}
  function formatBytes(bytes){if(bytes<1024)return`${bytes} B`;const u=['KiB','MiB','GiB'];let v=bytes,i=-1;do{v/=1024;i++;}while(v>=1024&&i<u.length-1);return`${v.toFixed(v>=10?1:2)} ${u[i]}`;}
  function stageBudget(){const s=getComputedStyle(stage),px=v=>Number.parseFloat(v)||0;return{width:Math.max(1,stage.clientWidth-px(s.paddingLeft)-px(s.paddingRight)),height:Math.max(1,stage.clientHeight-px(s.paddingTop)-px(s.paddingBottom))};}
  function selectedFps(){return Math.max(1,Math.min(60,Number(fps.value)||DEFAULT_FPS));}
  function workerTarget(){const hc=Math.max(2,Math.floor(Number(navigator.hardwareConcurrency)||4));return Math.max(2,Math.min(3,hc-2||2));}
  function theoreticalKiBs(){return CHROMA_CHUNK_BYTES*selectedFps()/1024;}
  async function requestWake(){if(wakeLock||!('wakeLock'in navigator))return;try{wakeLock=await navigator.wakeLock.request('screen');wakeLock.addEventListener('release',()=>{wakeLock=null;});}catch{}}
  async function releaseWake(){if(!wakeLock)return;try{await wakeLock.release();}catch{}wakeLock=null;}

  function metrics(){
    const {width,height}=stageBudget(),dpr=Math.max(1,Math.min(MAX_RENDER_DPR,Number(devicePixelRatio)||1));
    const scale=Math.max(1,Math.floor(Math.min(width*dpr/CHROMA_RASTER,height*dpr/CHROMA_RASTER)));
    return{dpr,scale,pixels:CHROMA_RASTER*scale,css:CHROMA_RASTER*scale/dpr};
  }
  function updateTelemetry(){
    if(!session||!current)return;
    const elapsed=startedAt?Math.max(.001,(performance.now()-startedAt)/1000):0,actual=elapsed?(shown/elapsed).toFixed(1):'—';
    if(frame)frame.textContent=`CHROMA FOUNTAIN · QCT2 · 1 matrice V40 · funzione B/N + 4 colori nativi · ${CHROMA_CHUNK_BYTES} B/frame · ${selectedFps()} fps · ~${theoreticalKiBs().toFixed(1)} KiB/s teorici · ${actual} frame/s · raster ${CHROMA_RASTER} · scala ×${renderScale} · queue ${queue.length}/${LOOKAHEAD} · miss ${misses} · gen ${generationMs?generationMs.toFixed(1):'—'}ms`;
    if(gridState)gridState.textContent=`1 matrice · ${CHROMA_MODULES}×${CHROMA_MODULES} moduli · ${renderScale} px/cella · detector QR solo geometria`;
    if(badge)badge.textContent='CHROMA FOUNTAIN · ROSSO / BLU / CIANO / MAGENTA';
  }
  function paint(item){
    if(!item?.raster)return;current=item;
    const r=item.raster,m=metrics();renderScale=m.scale;
    staging.getContext('2d',{alpha:false}).putImageData(new ImageData(r.pixels,r.size,r.size),0,0);
    canvas.width=m.pixels;canvas.height=m.pixels;canvas.style.width=`${m.css}px`;canvas.style.height=`${m.css}px`;
    canvas.style.maxWidth='none';canvas.style.maxHeight='none';canvas.style.imageRendering='pixelated';canvas.dataset.integerRaster='chroma-fountain';
    const ctx=canvas.getContext('2d',{alpha:false});ctx.imageSmoothingEnabled=false;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(staging,0,0,r.size,r.size,0,0,canvas.width,canvas.height);
    updateTelemetry();
  }

  function terminateWorkers(){for(const w of workers)w?.terminate();workers=[];busy=[];jobs=[];cursor=0;queue=[];}
  function freeWorker(){for(let n=0;n<workers.length;n++){const i=(cursor+n)%workers.length;if(!busy[i]){cursor=(i+1)%workers.length;return i;}}return-1;}
  function ensureWorkers(){
    if(workers.length)return;
    const count=workerTarget();
    for(let i=0;i<count;i++){
      const worker=new Worker(new URL('./chroma-tx-worker.js',import.meta.url),{type:'module'});
      worker.onmessage=event=>{
        const d=event.data||{};
        if(d.id===-1){if(!d.ready)setStatus(`CHROMA worker: ${d.error||'inizializzazione fallita'}`,'error');return;}
        const job=jobs[i];jobs[i]=null;busy[i]=false;
        if(d.error){setStatus(`CHROMA raster: ${d.error}`,'error');running=false;return;}
        if(!job||d.generation!==generation||job.generation!==generation){pump();return;}
        const pixels=new Uint8ClampedArray(d.raster.pixels);
        queue.push({raster:{...d.raster,pixels},symbolId:job.symbolId});
        if(Number(d.generationMs)>0)generationMs=generationMs?generationMs*.85+Number(d.generationMs)*.15:Number(d.generationMs);
        pump();updateTelemetry();
      };
      worker.onerror=e=>{busy[i]=false;jobs[i]=null;setStatus(`CHROMA worker fatal: ${e.message}`,'error');};
      workers.push(worker);busy.push(false);jobs.push(null);
    }
  }
  function nextPacket(){
    if(!session)return null;
    const symbolId=session.nextSymbolId++>>>0,symbol=session.encoder.symbol(symbolId);
    const packet=encodeOpticalPacketV2(session.meta,symbolId,symbol.data);
    if(packet.length!==CHROMA_QCT_PACKET_BYTES)throw new Error(`QCT2 CHROMA ${packet.length} B != ${CHROMA_QCT_PACKET_BYTES} B`);
    return{symbolId,packet};
  }
  function dispatch(i){
    const next=nextPacket();if(!next)return false;
    const id=jobId++,buffer=next.packet.buffer;busy[i]=true;jobs[i]={id,generation,symbolId:next.symbolId};
    workers[i].postMessage({id,generation,packet:buffer},[buffer]);return true;
  }
  function pump(){
    if(!running)return;ensureWorkers();
    while(queue.length+busy.filter(Boolean).length<LOOKAHEAD){const i=freeWorker();if(i<0)break;if(!dispatch(i))break;}
  }

  async function prepare(force=false){
    const file=fileInput.files?.[0];if(!file)throw new Error('Seleziona prima un file.');
    const signature=`${file.name}:${file.size}:${file.lastModified}:${CHROMA_CHUNK_BYTES}`;
    if(!force&&session?.signature===signature)return session;
    setStatus(`CHROMA FOUNTAIN: preparo ${file.name}…`);
    const bytes=new Uint8Array(await file.arrayBuffer()),hash=await sha256Hex(bytes),container=packFileContainerV2(file.name,bytes,hash),streamId=randomStreamId();
    const encoder=new FountainEncoder(container,CHROMA_CHUNK_BYTES,streamId);
    if(encoder.sourceCount>0xffff)throw new Error('File troppo grande per CHROMA FOUNTAIN.');
    const meta={protocolVersion:2,streamId,sourceCount:encoder.sourceCount,chunkSize:encoder.chunkSize,containerLength:container.length,visualStates:2};
    const probe=encodeOpticalPacketV2(meta,0,encoder.symbol(0).data);
    if(probe.length!==CHROMA_QCT_PACKET_BYTES)throw new Error('Envelope QCT2 CHROMA inatteso.');
    session={signature,file,bytes,container,encoder,meta,nextSymbolId:0};generation++;queue=[];current=null;misses=0;
    if(fileInfo)fileInfo.textContent=`${file.name} · ${formatBytes(bytes.length)} · CHROMA FOUNTAIN · QCT2 · K=${encoder.sourceCount} × ${CHROMA_CHUNK_BYTES} B · 4 colori senza giallo`;
    return session;
  }
  async function start(){
    if(!enabled()||running)return;
    try{
      await prepare();running=true;generation++;shown=0;misses=0;startedAt=performance.now();queue=[];generationMs=0;await requestWake();ensureWorkers();pump();
      const waitStart=performance.now();while(running&&queue.length===0&&performance.now()-waitStart<2500)await new Promise(r=>setTimeout(r,8));
      if(!running)return;if(!queue.length)throw new Error('lookahead CHROMA non disponibile');
      paint(queue.shift());shown++;pump();
      setStatus(`CHROMA FOUNTAIN attivo · ${CHROMA_CHUNK_BYTES} B/frame · ${selectedFps()} fps · obiettivo ≥150 KiB/s con ~≥57% frame utili a 60 fps.`,'ok');
      let nextAt=performance.now()+1000/selectedFps();
      const tick=now=>{
        if(!running||!enabled())return;raf=requestAnimationFrame(tick);
        const interval=1000/selectedFps();if(now<nextAt)return;
        const item=queue.shift();pump();
        if(!item){misses++;nextAt=now+interval;updateTelemetry();return;}
        paint(item);shown++;nextAt+=interval;if(now-nextAt>3*interval)nextAt=now+interval;
      };
      raf=requestAnimationFrame(tick);
    }catch(error){running=false;setStatus(`CHROMA FOUNTAIN: ${error.message}`,'error');}
  }
  function stop({quiet=false}={}){
    running=false;generation++;if(raf)cancelAnimationFrame(raf);raf=0;queue=[];terminateWorkers();void releaseWake();
    if(!quiet&&enabled())setStatus('CHROMA FOUNTAIN in pausa. La matrice visibile resta ferma.');
  }
  async function resetTx(){const resume=running;stop({quiet:true});session=null;try{await prepare(true);if(resume)await start();else setStatus('CHROMA FOUNTAIN resettato. Premi START.','ok');}catch(e){setStatus(`CHROMA FOUNTAIN: ${e.message}`,'error');}}
  function passLegacyStop(){bypass=true;try{$('stopTx')?.click();}finally{bypass=false;}}

  function enterMode(){
    passLegacyStop();savedPayload=payload.value;savedFps=fps.value;
    let opt=[...payload.options].find(o=>o.value===String(CHROMA_CHUNK_BYTES));
    if(!opt){opt=new Option(`${CHROMA_CHUNK_BYTES} B · CHROMA fisso`,String(CHROMA_CHUNK_BYTES));opt.dataset.chroma='1';payload.add(opt);}
    payload.value=String(CHROMA_CHUNK_BYTES);payload.disabled=true;fps.value=String(DEFAULT_FPS);
    document.body.dataset.txVariant='chroma';current=null;queue=[];session=null;
    if(badge)badge.textContent='CHROMA FOUNTAIN · 4 COLORI + B/N';
    const p=CHROMA_PALETTE.map(rgb=>`rgb(${rgb.join(',')})`).join(' · ');
    setStatus(`CHROMA FOUNTAIN EXP pronto: 1 grande matrice, payload nativo 4 colori, finder/timing B/N, Hamming + CRC + fountain. Palette senza giallo: ${p}.`,'ok');
    const file=fileInput.files?.[0];if(file&&fileInfo)fileInfo.textContent=`${file.name} · ${formatBytes(file.size)} · pronto per CHROMA FOUNTAIN`;
  }
  function leaveMode(){
    stop({quiet:true});payload.disabled=false;
    const chromaOpt=[...payload.options].find(o=>o.dataset.chroma==='1');if(chromaOpt)chromaOpt.remove();
    if([...payload.options].some(o=>o.value===savedPayload))payload.value=savedPayload;
    if([...fps.options].some(o=>o.value===savedFps))fps.value=savedFps;
    delete document.body.dataset.txVariant;
  }
  let wasEnabled=false;
  variant.addEventListener('change',()=>{
    const now=enabled();
    if(now&&!wasEnabled)enterMode();else if(!now&&wasEnabled)leaveMode();
    wasEnabled=now;
  });
  method.addEventListener('change',()=>{queueMicrotask(()=>{const now=enabled();if(!now&&wasEnabled)leaveMode();wasEnabled=now;});});

  document.addEventListener('change',event=>{
    if(bypass||!enabled()||event.target!==fileInput)return;
    event.preventDefault();event.stopImmediatePropagation();stop({quiet:true});session=null;
    const file=fileInput.files?.[0];if(fileInfo)fileInfo.textContent=file?`${file.name} · ${formatBytes(file.size)} · pronto per CHROMA FOUNTAIN`:'Nessun file selezionato.';
    setStatus(file?'File selezionato. START apre la matrice CHROMA a tutto schermo.':'Seleziona un file.',file?'ok':'');
  },{capture:true});

  document.addEventListener('click',event=>{
    if(bypass||!enabled())return;
    const id=event.target?.id;
    if(!['startTx','fsStartTx','stopTx','fsStopTx','fsResetTx','fsExitTx'].includes(id))return;
    event.preventDefault();event.stopImmediatePropagation();
    if(id==='startTx'){if(!fileInput.files?.length){setStatus('Seleziona prima un file.','warn');return;}enterTxOpticalView();void start();}
    else if(id==='fsStartTx')void start();
    else if(id==='fsResetTx')void resetTx();
    else if(id==='fsExitTx'){stop({quiet:true});exitTxOpticalView();}
    else stop();
  },{capture:true});

  window.addEventListener('resize',()=>{if(enabled()&&current)requestAnimationFrame(()=>paint(current));});
  window.addEventListener('orientationchange',()=>setTimeout(()=>{if(enabled()&&current)paint(current);},80));
}
install();
