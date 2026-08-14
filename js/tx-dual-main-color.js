// qcolortrasfer DUAL MAIN COLOR TX v3.1 (MIT).
//
// Two independent standards-valid QR V40-L MAINs. In every data module the
// luma bit is the real QR, while the same colored cell also carries one native
// chroma fountain bit. There are no helper QR and no second visible barcode.

import { FountainEncoder } from './fountain.js';
import { packFileContainerV2, randomStreamId, sha256Hex } from './protocol.js';
import {
  CHROMA_CHUNK_BYTES, CHROMA_QCT_PACKET_BYTES, CHROMA_RASTER,
  CHROMA_MODULES, CHROMA_PALETTE, encodeChromaOpticalPacket
} from './chroma-fountain.js';
import { enterTxOpticalView, exitTxOpticalView } from './tx-optical-view.js';

const LANES=2,LOOKAHEAD_PER_LANE=3,DEFAULT_FPS=30,MAX_RENDER_DPR=4,GAP_RASTER=2,$=id=>document.getElementById(id);

function install(){
  if(typeof document==='undefined'||typeof window==='undefined')return;
  const variant=$('txClassicVariant'),method=$('txMethod'),fileInput=$('fileInput'),payload=$('payloadBytes'),fps=$('fps');
  const canvas=$('txCanvas'),stage=$('txStage'),status=$('txStatus'),fileInfo=$('txFileInfo'),frame=$('txFrame'),badge=$('colorBadge'),gridState=$('gridState');
  if(!variant||!method||!fileInput||!payload||!fps||!canvas||!stage)return;
  const label=variant.closest('label')?.querySelector('span');if(label)label.textContent='Modalità MAIN / Decimen';
  let option=[...variant.options].find(o=>o.value==='dualchroma');
  if(!option){option=new Option('2 MAIN COLOR · QR VALIDO + CHROMA FAST EXP','dualchroma');variant.add(option);}else option.textContent='2 MAIN COLOR · QR VALIDO + CHROMA FAST EXP';

  let session=null,running=false,generation=0,raf=0,workers=[],busy=[],jobs=[],workerCursor=0,jobId=0,nextLane=0;
  let queues=Array.from({length:LANES},()=>[]),laneItems=Array(LANES).fill(null),shown=0,misses=0,startedAt=0,generationMs=0,wakeLock=null;
  let savedPayload=payload.value,savedFps=fps.value,layout={vertical:true,scale:1,dpr:1,logicalW:CHROMA_RASTER,logicalH:CHROMA_RASTER*2+GAP_RASTER,pixelsW:CHROMA_RASTER,pixelsH:CHROMA_RASTER*2+GAP_RASTER,cssW:CHROMA_RASTER,cssH:CHROMA_RASTER*2+GAP_RASTER},bypass=false;
  const staging=document.createElement('canvas');

  function enabled(){return method.value==='classic'&&variant.value==='dualchroma';}
  function setStatus(text,kind=''){if(status){status.textContent=text;status.dataset.kind=kind;}}
  function formatBytes(bytes){if(bytes<1024)return`${bytes} B`;const u=['KiB','MiB','GiB'];let v=bytes,i=-1;do{v/=1024;i++;}while(v>=1024&&i<u.length-1);return`${v.toFixed(v>=10?1:2)} ${u[i]}`;}
  function stageBudget(){const s=getComputedStyle(stage),px=v=>Number.parseFloat(v)||0;return{width:Math.max(1,stage.clientWidth-px(s.paddingLeft)-px(s.paddingRight)),height:Math.max(1,stage.clientHeight-px(s.paddingTop)-px(s.paddingBottom))};}
  function selectedFps(){return Math.max(8,Math.min(60,Number(fps.value)||DEFAULT_FPS));}
  function theoreticalKiBs(){return CHROMA_CHUNK_BYTES*2*LANES*selectedFps()/1024;}
  function workerTarget(){const hc=Math.max(2,Math.floor(Number(navigator.hardwareConcurrency)||4));return hc>=6?4:hc>=4?3:2;}
  async function requestWake(){if(wakeLock||!('wakeLock'in navigator))return;try{wakeLock=await navigator.wakeLock.request('screen');wakeLock.addEventListener('release',()=>{wakeLock=null;});}catch{}}
  async function releaseWake(){if(!wakeLock)return;try{await wakeLock.release();}catch{}wakeLock=null;}

  function chooseLayout(){
    const{width,height}=stageBudget(),dpr=Math.max(1,Math.min(MAX_RENDER_DPR,Number(devicePixelRatio)||1));
    const verticalW=CHROMA_RASTER,verticalH=CHROMA_RASTER*2+GAP_RASTER,horizontalW=CHROMA_RASTER*2+GAP_RASTER,horizontalH=CHROMA_RASTER;
    const scaleV=Math.max(1,Math.floor(Math.min(width*dpr/verticalW,height*dpr/verticalH))),scaleH=Math.max(1,Math.floor(Math.min(width*dpr/horizontalW,height*dpr/horizontalH)));
    const vertical=scaleV>scaleH||(scaleV===scaleH&&height>=width),scale=vertical?scaleV:scaleH,logicalW=vertical?verticalW:horizontalW,logicalH=vertical?verticalH:horizontalH;
    return{vertical,scale,dpr,logicalW,logicalH,pixelsW:logicalW*scale,pixelsH:logicalH*scale,cssW:logicalW*scale/dpr,cssH:logicalH*scale/dpr};
  }
  function laneOrigin(lane){return layout.vertical?{x:0,y:lane*(CHROMA_RASTER+GAP_RASTER)}:{x:lane*(CHROMA_RASTER+GAP_RASTER),y:0};}
  function rebuildComposite(){
    layout=chooseLayout();staging.width=layout.logicalW;staging.height=layout.logicalH;const sctx=staging.getContext('2d',{alpha:false});sctx.fillStyle='#fff';sctx.fillRect(0,0,staging.width,staging.height);
    for(let lane=0;lane<LANES;lane++){const item=laneItems[lane];if(!item?.raster)continue;const o=laneOrigin(lane);sctx.putImageData(new ImageData(item.raster.pixels,CHROMA_RASTER,CHROMA_RASTER),o.x,o.y);}
    canvas.width=layout.pixelsW;canvas.height=layout.pixelsH;canvas.style.width=`${layout.cssW}px`;canvas.style.height=`${layout.cssH}px`;canvas.style.maxWidth='none';canvas.style.maxHeight='none';canvas.style.imageRendering='pixelated';canvas.dataset.integerRaster='dual-main-color';
    const ctx=canvas.getContext('2d',{alpha:false});ctx.imageSmoothingEnabled=false;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(staging,0,0,staging.width,staging.height,0,0,canvas.width,canvas.height);updateTelemetry();
  }
  function paintLane(lane,item){
    if(!item?.raster||item.raster.size!==CHROMA_RASTER)return;laneItems[lane]=item;if(staging.width!==layout.logicalW||staging.height!==layout.logicalH)rebuildComposite();
    const o=laneOrigin(lane),sctx=staging.getContext('2d',{alpha:false});sctx.putImageData(new ImageData(item.raster.pixels,CHROMA_RASTER,CHROMA_RASTER),o.x,o.y);
    const ctx=canvas.getContext('2d',{alpha:false}),destX=o.x*layout.scale,destY=o.y*layout.scale,dest=CHROMA_RASTER*layout.scale;ctx.imageSmoothingEnabled=false;ctx.drawImage(staging,o.x,o.y,CHROMA_RASTER,CHROMA_RASTER,destX,destY,dest,dest);updateTelemetry();
  }
  function updateTelemetry(){
    if(!session)return;const elapsed=startedAt?Math.max(.001,(performance.now()-startedAt)/1000):0,actual=elapsed?(shown/elapsed).toFixed(1):'—',orientation=layout.vertical?'2×1 verticale':'1×2 orizzontale';
    if(frame)frame.textContent=`2 MAIN COLOR · ${orientation} · QR V40-L validi + chroma nativo · 4 × ${CHROMA_CHUNK_BYTES} B/ciclo · ${selectedFps()} fps/MAIN · stagger ${Math.round(1000/(selectedFps()*2))}ms · ~${theoreticalKiBs().toFixed(1)} KiB/s teorici · ${actual} MAIN/s · ${layout.scale} px/cella · queue ${queues.map(q=>q.length).join('/')} · miss ${misses} · gen ${generationMs?generationMs.toFixed(1):'—'}ms`;
    if(gridState)gridState.textContent=`2 MAIN · ${orientation} · V40 ${CHROMA_MODULES}×${CHROMA_MODULES} · ×${layout.scale} px/cella · fallback B/N`;
    if(badge)badge.textContent='2 MAIN COLOR · QR VALIDI + CHROMA';
  }

  function terminateWorkers(){for(const w of workers)w?.terminate();workers=[];busy=[];jobs=[];workerCursor=0;queues=Array.from({length:LANES},()=>[]);}
  function freeWorker(){for(let n=0;n<workers.length;n++){const i=(workerCursor+n)%workers.length;if(!busy[i]){workerCursor=(i+1)%workers.length;return i;}}return-1;}
  function inFlightForLane(lane){let n=0;for(const job of jobs)if(job?.lane===lane)n++;return n;}
  function ensureWorkers(){
    if(workers.length)return;const count=workerTarget();
    for(let i=0;i<count;i++){
      const worker=new Worker(new URL('./chroma-tx-worker.js',import.meta.url),{type:'module'});
      worker.onmessage=event=>{
        const d=event.data||{};if(d.id===-1){if(!d.ready)setStatus(`DUAL MAIN COLOR worker: ${d.error||'init fallita'}`,'error');return;}
        const job=jobs[i];jobs[i]=null;busy[i]=false;if(d.error){running=false;setStatus(`DUAL MAIN COLOR raster: ${d.error}`,'error');return;}
        if(!job||d.generation!==generation||job.generation!==generation){pump();return;}
        queues[job.lane].push({raster:{...d.raster,pixels:new Uint8ClampedArray(d.raster.pixels)},baseSymbolId:job.baseSymbolId,chromaSymbolId:job.chromaSymbolId});
        if(Number(d.generationMs)>0)generationMs=generationMs?generationMs*.85+Number(d.generationMs)*.15:Number(d.generationMs);pump();updateTelemetry();
      };
      worker.onerror=e=>{busy[i]=false;jobs[i]=null;running=false;setStatus(`DUAL MAIN COLOR worker fatal: ${e.message}`,'error');};workers.push(worker);busy.push(false);jobs.push(null);
    }
  }
  function nextPair(lane){
    if(!session)return null;const baseSymbolId=session.nextSymbolId++>>>0,chromaSymbolId=session.nextSymbolId++>>>0,baseSymbol=session.encoder.symbol(baseSymbolId),chromaSymbol=session.encoder.symbol(chromaSymbolId);
    const basePacket=encodeChromaOpticalPacket(session.meta,baseSymbolId,baseSymbol.data),chromaPacket=encodeChromaOpticalPacket(session.meta,chromaSymbolId,chromaSymbol.data);
    if(basePacket.length!==CHROMA_QCT_PACKET_BYTES||chromaPacket.length!==CHROMA_QCT_PACKET_BYTES)throw new Error('DUAL MAIN COLOR QCT2 envelope inatteso');
    return{lane,baseSymbolId,chromaSymbolId,basePacket,chromaPacket};
  }
  function dispatch(workerIndex,lane){
    const next=nextPair(lane);if(!next)return false;const id=jobId++,baseBuffer=next.basePacket.buffer,chromaBuffer=next.chromaPacket.buffer;busy[workerIndex]=true;jobs[workerIndex]={id,generation,lane,baseSymbolId:next.baseSymbolId,chromaSymbolId:next.chromaSymbolId};
    workers[workerIndex].postMessage({id,generation,basePacket:baseBuffer,chromaPacket:chromaBuffer},[baseBuffer,chromaBuffer]);return true;
  }
  function pump(){
    if(!running)return;ensureWorkers();let guard=16;
    while(guard-->0){let lane=-1;for(let offset=0;offset<LANES;offset++){const candidate=(nextLane+offset)%LANES;if(queues[candidate].length+inFlightForLane(candidate)<LOOKAHEAD_PER_LANE){lane=candidate;break;}}if(lane<0)break;const worker=freeWorker();if(worker<0)break;if(!dispatch(worker,lane))break;nextLane=(lane+1)%LANES;}
  }

  async function prepare(force=false){
    const file=fileInput.files?.[0];if(!file)throw new Error('Seleziona prima un file.');const signature=`${file.name}:${file.size}:${file.lastModified}:${CHROMA_CHUNK_BYTES}:dualmaincolor`;
    if(!force&&session?.signature===signature)return session;setStatus(`2 MAIN COLOR: preparo ${file.name}…`);
    const bytes=new Uint8Array(await file.arrayBuffer()),hash=await sha256Hex(bytes),container=packFileContainerV2(file.name,bytes,hash),streamId=randomStreamId(),encoder=new FountainEncoder(container,CHROMA_CHUNK_BYTES,streamId);if(encoder.sourceCount>0xffff)throw new Error('File troppo grande per 2 MAIN COLOR.');
    const meta={protocolVersion:2,streamId,sourceCount:encoder.sourceCount,chunkSize:encoder.chunkSize,containerLength:container.length,visualStates:2};
    const probe=encodeChromaOpticalPacket(meta,0,encoder.symbol(0).data);if(probe.length!==CHROMA_QCT_PACKET_BYTES)throw new Error('Envelope 2 MAIN COLOR inatteso.');
    session={signature,file,bytes,container,encoder,meta,nextSymbolId:0};generation++;queues=Array.from({length:LANES},()=>[]);laneItems.fill(null);misses=0;shown=0;
    if(fileInfo)fileInfo.textContent=`${file.name} · ${formatBytes(bytes.length)} · 2 MAIN COLOR · K=${encoder.sourceCount} × ${CHROMA_CHUNK_BYTES} B · QR base + chroma fountain per MAIN`;
    return session;
  }
  async function start(){
    if(!enabled()||running)return;
    try{
      await prepare();running=true;generation++;shown=0;misses=0;startedAt=performance.now();generationMs=0;nextLane=0;queues=Array.from({length:LANES},()=>[]);await requestWake();ensureWorkers();pump();
      const waitStart=performance.now();while(running&&(queues[0].length===0||queues[1].length===0)&&performance.now()-waitStart<3000)await new Promise(r=>setTimeout(r,8));if(!running)return;if(!queues[0].length||!queues[1].length)throw new Error('lookahead 2 MAIN COLOR non disponibile');
      layout=chooseLayout();laneItems[0]=queues[0].shift();laneItems[1]=queues[1].shift();shown+=2;rebuildComposite();pump();
      setStatus(`2 MAIN COLOR attivi · ${selectedFps()} fps per MAIN · ogni MAIN porta QR B/N + chroma ${CHROMA_CHUNK_BYTES} B · ~${theoreticalKiBs().toFixed(0)} KiB/s fountain teorici.`,'ok');
      let nextPaintLane=0,nextAt=performance.now()+1000/(selectedFps()*LANES);
      const tick=now=>{if(!running||!enabled())return;raf=requestAnimationFrame(tick);const sub=1000/(selectedFps()*LANES);if(now<nextAt)return;let flips=0;while(now>=nextAt&&flips<LANES){const lane=nextPaintLane,item=queues[lane].shift();pump();if(!item){misses++;nextAt=now+sub;updateTelemetry();break;}paintLane(lane,item);shown++;nextPaintLane=(lane+1)%LANES;nextAt+=sub;flips++;}if(now-nextAt>1000/selectedFps()*2)nextAt=now+sub;};
      raf=requestAnimationFrame(tick);
    }catch(error){running=false;setStatus(`2 MAIN COLOR: ${error.message}`,'error');}
  }
  function stop({quiet=false}={}){running=false;generation++;if(raf)cancelAnimationFrame(raf);raf=0;terminateWorkers();void releaseWake();if(!quiet&&enabled())setStatus('2 MAIN COLOR in pausa. I QR restano visibili.');}
  async function resetTx(){const resume=running;stop({quiet:true});session=null;try{await prepare(true);if(resume)await start();else setStatus('2 MAIN COLOR resettati. Premi START.','ok');}catch(e){setStatus(`2 MAIN COLOR: ${e.message}`,'error');}}
  function passLegacyStop(){bypass=true;try{$('stopTx')?.click();}finally{bypass=false;}}
  function enterMode(){
    passLegacyStop();savedPayload=payload.value;savedFps=fps.value;let opt=[...payload.options].find(o=>o.value===String(CHROMA_CHUNK_BYTES));if(!opt){opt=new Option(`${CHROMA_CHUNK_BYTES} B/canale · MAIN COLOR`,String(CHROMA_CHUNK_BYTES));opt.dataset.dualchroma='1';payload.add(opt);}payload.value=String(CHROMA_CHUNK_BYTES);payload.disabled=true;fps.value=String(DEFAULT_FPS);document.body.dataset.txVariant='dualchroma';session=null;laneItems.fill(null);layout=chooseLayout();
    if(badge)badge.textContent='2 MAIN COLOR · QR VALIDI + CHROMA';const p=CHROMA_PALETTE.map(rgb=>`rgb(${rgb.join(',')})`).join(' · ');
    setStatus(`2 MAIN COLOR pronto: due veri QR V40-L indipendenti. Ogni cella dati mantiene il bit QR in luminanza e aggiunge un bit fountain cromatico rosso/blu/magenta/ciano. Nessun giallo, nessun helper. ${p}.`,'ok');const file=fileInput.files?.[0];if(file&&fileInfo)fileInfo.textContent=`${file.name} · ${formatBytes(file.size)} · pronto per 2 MAIN COLOR`;
  }
  function leaveMode(){stop({quiet:true});payload.disabled=false;const opt=[...payload.options].find(o=>o.dataset.dualchroma==='1');if(opt)opt.remove();if([...payload.options].some(o=>o.value===savedPayload))payload.value=savedPayload;if([...fps.options].some(o=>o.value===savedFps))fps.value=savedFps;delete document.body.dataset.txVariant;}
  let wasEnabled=false;variant.addEventListener('change',()=>{const now=enabled();if(now&&!wasEnabled)enterMode();else if(!now&&wasEnabled)leaveMode();wasEnabled=now;});method.addEventListener('change',()=>{queueMicrotask(()=>{const now=enabled();if(!now&&wasEnabled)leaveMode();wasEnabled=now;});});
  document.addEventListener('change',event=>{if(bypass||!enabled()||event.target!==fileInput)return;event.preventDefault();event.stopImmediatePropagation();stop({quiet:true});session=null;const file=fileInput.files?.[0];if(fileInfo)fileInfo.textContent=file?`${file.name} · ${formatBytes(file.size)} · pronto per 2 MAIN COLOR`:'Nessun file selezionato.';setStatus(file?'File selezionato. START apre i 2 MAIN COLOR a tutto schermo.':'Seleziona un file.',file?'ok':'');},{capture:true});
  document.addEventListener('click',event=>{if(bypass||!enabled())return;const id=event.target?.id;if(!['startTx','fsStartTx','stopTx','fsStopTx','fsResetTx','fsExitTx'].includes(id))return;event.preventDefault();event.stopImmediatePropagation();if(id==='startTx'){if(!fileInput.files?.length){setStatus('Seleziona prima un file.','warn');return;}enterTxOpticalView();void start();}else if(id==='fsStartTx')void start();else if(id==='fsResetTx')void resetTx();else if(id==='fsExitTx'){stop({quiet:true});exitTxOpticalView();}else stop();},{capture:true});
  window.addEventListener('resize',()=>{if(enabled()&&laneItems.some(Boolean))requestAnimationFrame(rebuildComposite);});window.addEventListener('orientationchange',()=>setTimeout(()=>{if(enabled()&&laneItems.some(Boolean))rebuildComposite();},80));
}
install();
