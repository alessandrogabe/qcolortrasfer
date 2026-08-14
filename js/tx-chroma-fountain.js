// qcolortrasfer MAIN COLOR TX v3.1 (MIT).
//
// One large standards-valid QR V40-L in luminance plus one native chroma
// fountain symbol in the same physical cells. If chroma is lost the base QR is
// still ordinary QCT2. No helper and no second visible QR.

import { FountainEncoder } from './fountain.js';
import { packFileContainerV2, randomStreamId, sha256Hex } from './protocol.js';
import {
  CHROMA_CHUNK_BYTES, CHROMA_QCT_PACKET_BYTES, CHROMA_RASTER, CHROMA_MODULES,
  CHROMA_PALETTE, encodeChromaOpticalPacket
} from './chroma-fountain.js';
import { enterTxOpticalView, exitTxOpticalView } from './tx-optical-view.js';

const LOOKAHEAD=5,MAX_RENDER_DPR=4,DEFAULT_FPS=60,$=id=>document.getElementById(id);

function install(){
  if(typeof document==='undefined'||typeof window==='undefined')return;
  const variant=$('txClassicVariant'),method=$('txMethod'),fileInput=$('fileInput'),payload=$('payloadBytes'),fps=$('fps');
  const canvas=$('txCanvas'),stage=$('txStage'),status=$('txStatus'),fileInfo=$('txFileInfo'),frame=$('txFrame'),badge=$('colorBadge'),gridState=$('gridState');
  if(!variant||!method||!fileInput||!payload||!fps||!canvas||!stage)return;

  let option=[...variant.options].find(o=>o.value==='chroma');
  if(!option){option=new Option('MAIN COLOR · QR VALIDO + CHROMA FAST','chroma');variant.add(option);}else option.textContent='MAIN COLOR · QR VALIDO + CHROMA FAST';

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
  function theoreticalKiBs(){return CHROMA_CHUNK_BYTES*2*selectedFps()/1024;}
  async function requestWake(){if(wakeLock||!('wakeLock'in navigator))return;try{wakeLock=await navigator.wakeLock.request('screen');wakeLock.addEventListener('release',()=>{wakeLock=null;});}catch{}}
  async function releaseWake(){if(!wakeLock)return;try{await wakeLock.release();}catch{}wakeLock=null;}

  function metrics(){const{width,height}=stageBudget(),dpr=Math.max(1,Math.min(MAX_RENDER_DPR,Number(devicePixelRatio)||1)),scale=Math.max(1,Math.floor(Math.min(width*dpr/CHROMA_RASTER,height*dpr/CHROMA_RASTER)));return{dpr,scale,pixels:CHROMA_RASTER*scale,css:CHROMA_RASTER*scale/dpr};}
  function updateTelemetry(){
    if(!session||!current)return;const elapsed=startedAt?Math.max(.001,(performance.now()-startedAt)/1000):0,actual=elapsed?(shown/elapsed).toFixed(1):'—';
    if(frame)frame.textContent=`MAIN COLOR · QR V40-L valido + chroma nativo · 2 × ${CHROMA_CHUNK_BYTES} B/frame · ${selectedFps()} fps · ~${theoreticalKiBs().toFixed(1)} KiB/s teorici · ${actual} frame/s · scala ×${renderScale} · queue ${queue.length}/${LOOKAHEAD} · miss ${misses} · gen ${generationMs?generationMs.toFixed(1):'—'}ms`;
    if(gridState)gridState.textContent=`1 MAIN · V40 ${CHROMA_MODULES}×${CHROMA_MODULES} · ${renderScale} px/cella · fallback B/N sempre valido`;
    if(badge)badge.textContent='MAIN COLOR · QR VALIDO + CHROMA';
  }
  function paint(item){
    if(!item?.raster)return;current=item;const r=item.raster,m=metrics();renderScale=m.scale;
    staging.getContext('2d',{alpha:false}).putImageData(new ImageData(r.pixels,r.size,r.size),0,0);
    canvas.width=m.pixels;canvas.height=m.pixels;canvas.style.width=`${m.css}px`;canvas.style.height=`${m.css}px`;canvas.style.maxWidth='none';canvas.style.maxHeight='none';canvas.style.imageRendering='pixelated';canvas.dataset.integerRaster='main-color';
    const ctx=canvas.getContext('2d',{alpha:false});ctx.imageSmoothingEnabled=false;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(staging,0,0,r.size,r.size,0,0,canvas.width,canvas.height);updateTelemetry();
  }

  function terminateWorkers(){for(const w of workers)w?.terminate();workers=[];busy=[];jobs=[];cursor=0;queue=[];}
  function freeWorker(){for(let n=0;n<workers.length;n++){const i=(cursor+n)%workers.length;if(!busy[i]){cursor=(i+1)%workers.length;return i;}}return-1;}
  function ensureWorkers(){
    if(workers.length)return;const count=workerTarget();
    for(let i=0;i<count;i++){
      const worker=new Worker(new URL('./chroma-tx-worker.js',import.meta.url),{type:'module'});
      worker.onmessage=event=>{
        const d=event.data||{};if(d.id===-1){if(!d.ready)setStatus(`MAIN COLOR worker: ${d.error||'inizializzazione fallita'}`,'error');return;}
        const job=jobs[i];jobs[i]=null;busy[i]=false;
        if(d.error){setStatus(`MAIN COLOR raster: ${d.error}`,'error');running=false;return;}
        if(!job||d.generation!==generation||job.generation!==generation){pump();return;}
        queue.push({raster:{...d.raster,pixels:new Uint8ClampedArray(d.raster.pixels)},baseSymbolId:job.baseSymbolId,chromaSymbolId:job.chromaSymbolId});
        if(Number(d.generationMs)>0)generationMs=generationMs?generationMs*.85+Number(d.generationMs)*.15:Number(d.generationMs);pump();updateTelemetry();
      };
      worker.onerror=e=>{busy[i]=false;jobs[i]=null;setStatus(`MAIN COLOR worker fatal: ${e.message}`,'error');};workers.push(worker);busy.push(false);jobs.push(null);
    }
  }
  function nextPair(){
    if(!session)return null;const baseSymbolId=session.nextSymbolId++>>>0,chromaSymbolId=session.nextSymbolId++>>>0;
    const baseSymbol=session.encoder.symbol(baseSymbolId),chromaSymbol=session.encoder.symbol(chromaSymbolId);
    const basePacket=encodeChromaOpticalPacket(session.meta,baseSymbolId,baseSymbol.data),chromaPacket=encodeChromaOpticalPacket(session.meta,chromaSymbolId,chromaSymbol.data);
    if(basePacket.length!==CHROMA_QCT_PACKET_BYTES||chromaPacket.length!==CHROMA_QCT_PACKET_BYTES)throw new Error('MAIN COLOR QCT2 envelope inatteso');
    return{baseSymbolId,chromaSymbolId,basePacket,chromaPacket};
  }
  function dispatch(i){
    const next=nextPair();if(!next)return false;const id=jobId++,baseBuffer=next.basePacket.buffer,chromaBuffer=next.chromaPacket.buffer;
    busy[i]=true;jobs[i]={id,generation,baseSymbolId:next.baseSymbolId,chromaSymbolId:next.chromaSymbolId};
    workers[i].postMessage({id,generation,basePacket:baseBuffer,chromaPacket:chromaBuffer},[baseBuffer,chromaBuffer]);return true;
  }
  function pump(){if(!running)return;ensureWorkers();while(queue.length+busy.filter(Boolean).length<LOOKAHEAD){const i=freeWorker();if(i<0)break;if(!dispatch(i))break;}}

  async function prepare(force=false){
    const file=fileInput.files?.[0];if(!file)throw new Error('Seleziona prima un file.');const signature=`${file.name}:${file.size}:${file.lastModified}:${CHROMA_CHUNK_BYTES}:maincolor`;
    if(!force&&session?.signature===signature)return session;setStatus(`MAIN COLOR: preparo ${file.name}…`);
    const bytes=new Uint8Array(await file.arrayBuffer()),hash=await sha256Hex(bytes),container=packFileContainerV2(file.name,bytes,hash),streamId=randomStreamId(),encoder=new FountainEncoder(container,CHROMA_CHUNK_BYTES,streamId);
    if(encoder.sourceCount>0xffff)throw new Error('File troppo grande per MAIN COLOR.');
    const meta={protocolVersion:2,streamId,sourceCount:encoder.sourceCount,chunkSize:encoder.chunkSize,containerLength:container.length,visualStates:2};
    const probe=encodeChromaOpticalPacket(meta,0,encoder.symbol(0).data);if(probe.length!==CHROMA_QCT_PACKET_BYTES)throw new Error('Envelope MAIN COLOR inatteso.');
    session={signature,file,bytes,container,encoder,meta,nextSymbolId:0};generation++;queue=[];current=null;misses=0;
    if(fileInfo)fileInfo.textContent=`${file.name} · ${formatBytes(bytes.length)} · MAIN COLOR · K=${encoder.sourceCount} × ${CHROMA_CHUNK_BYTES} B · QR base + chroma fountain`;
    return session;
  }
  async function start(){
    if(!enabled()||running)return;
    try{
      await prepare();running=true;generation++;shown=0;misses=0;startedAt=performance.now();queue=[];generationMs=0;await requestWake();ensureWorkers();pump();
      const waitStart=performance.now();while(running&&queue.length===0&&performance.now()-waitStart<2500)await new Promise(r=>setTimeout(r,8));
      if(!running)return;if(!queue.length)throw new Error('lookahead MAIN COLOR non disponibile');paint(queue.shift());shown++;pump();
      setStatus(`MAIN COLOR attivo · QR V40-L B/N sempre valido + ${CHROMA_CHUNK_BYTES} B chroma nello stesso frame · ${selectedFps()} fps · ~${theoreticalKiBs().toFixed(0)} KiB/s teorici.`,'ok');
      let nextAt=performance.now()+1000/selectedFps();
      const tick=now=>{if(!running||!enabled())return;raf=requestAnimationFrame(tick);const interval=1000/selectedFps();if(now<nextAt)return;const item=queue.shift();pump();if(!item){misses++;nextAt=now+interval;updateTelemetry();return;}paint(item);shown++;nextAt+=interval;if(now-nextAt>3*interval)nextAt=now+interval;};
      raf=requestAnimationFrame(tick);
    }catch(error){running=false;setStatus(`MAIN COLOR: ${error.message}`,'error');}
  }
  function stop({quiet=false}={}){running=false;generation++;if(raf)cancelAnimationFrame(raf);raf=0;queue=[];terminateWorkers();void releaseWake();if(!quiet&&enabled())setStatus('MAIN COLOR in pausa. Il QR visibile resta fermo.');}
  async function resetTx(){const resume=running;stop({quiet:true});session=null;try{await prepare(true);if(resume)await start();else setStatus('MAIN COLOR resettato. Premi START.','ok');}catch(e){setStatus(`MAIN COLOR: ${e.message}`,'error');}}
  function passLegacyStop(){bypass=true;try{$('stopTx')?.click();}finally{bypass=false;}}

  function enterMode(){
    passLegacyStop();savedPayload=payload.value;savedFps=fps.value;let opt=[...payload.options].find(o=>o.value===String(CHROMA_CHUNK_BYTES));
    if(!opt){opt=new Option(`${CHROMA_CHUNK_BYTES} B/canale · MAIN COLOR`,String(CHROMA_CHUNK_BYTES));opt.dataset.chroma='1';payload.add(opt);}payload.value=String(CHROMA_CHUNK_BYTES);payload.disabled=true;fps.value=String(DEFAULT_FPS);
    document.body.dataset.txVariant='chroma';current=null;queue=[];session=null;if(badge)badge.textContent='MAIN COLOR · QR VALIDO + CHROMA';
    const p=CHROMA_PALETTE.map(rgb=>`rgb(${rgb.join(',')})`).join(' · ');
    setStatus(`MAIN COLOR pronto: un vero QR V40-L in luminanza + un secondo simbolo fountain nel bit cromatico delle stesse celle. Finder/timing B/N; rosso/blu/magenta/ciano, nessun giallo. ${p}.`,'ok');
    const file=fileInput.files?.[0];if(file&&fileInfo)fileInfo.textContent=`${file.name} · ${formatBytes(file.size)} · pronto per MAIN COLOR`;
  }
  function leaveMode(){stop({quiet:true});payload.disabled=false;const opt=[...payload.options].find(o=>o.dataset.chroma==='1');if(opt)opt.remove();if([...payload.options].some(o=>o.value===savedPayload))payload.value=savedPayload;if([...fps.options].some(o=>o.value===savedFps))fps.value=savedFps;delete document.body.dataset.txVariant;}
  let wasEnabled=false;variant.addEventListener('change',()=>{const now=enabled();if(now&&!wasEnabled)enterMode();else if(!now&&wasEnabled)leaveMode();wasEnabled=now;});method.addEventListener('change',()=>{queueMicrotask(()=>{const now=enabled();if(!now&&wasEnabled)leaveMode();wasEnabled=now;});});
  document.addEventListener('change',event=>{if(bypass||!enabled()||event.target!==fileInput)return;event.preventDefault();event.stopImmediatePropagation();stop({quiet:true});session=null;const file=fileInput.files?.[0];if(fileInfo)fileInfo.textContent=file?`${file.name} · ${formatBytes(file.size)} · pronto per MAIN COLOR`:'Nessun file selezionato.';setStatus(file?'File selezionato. START apre MAIN COLOR a tutto schermo.':'Seleziona un file.',file?'ok':'');},{capture:true});
  document.addEventListener('click',event=>{if(bypass||!enabled())return;const id=event.target?.id;if(!['startTx','fsStartTx','stopTx','fsStopTx','fsResetTx','fsExitTx'].includes(id))return;event.preventDefault();event.stopImmediatePropagation();if(id==='startTx'){if(!fileInput.files?.length){setStatus('Seleziona prima un file.','warn');return;}enterTxOpticalView();void start();}else if(id==='fsStartTx')void start();else if(id==='fsResetTx')void resetTx();else if(id==='fsExitTx'){stop({quiet:true});exitTxOpticalView();}else stop();},{capture:true});
  window.addEventListener('resize',()=>{if(enabled()&&current)requestAnimationFrame(()=>paint(current));});window.addEventListener('orientationchange',()=>setTimeout(()=>{if(enabled()&&current)paint(current);},80));
}
install();
