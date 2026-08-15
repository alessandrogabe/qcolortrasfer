// Standalone OPTICAL MODEM transmitter. Owns its raster queue and does not use
// QR generation, ZXing, AUX or MAIN COLOR layering.

import { FountainEncoder } from './fountain.js';
import { packFileContainerV2, randomStreamId, sha256Hex } from './protocol.js';
import { enterTxOpticalView, exitTxOpticalView } from './tx-optical-view.js';
import { MODEM_CHUNK_BYTES, MODEM_PACKET_BYTES, MODEM_RASTER_W, MODEM_RASTER_H, MODEM_STATES, MODEM_PALETTE, encodeModemPacket } from './optical-modem-codec.js';
import { computeModemDisplayLayout, fitModemRaster } from './optical-modem-layout.js';

const LOOKAHEAD=3,DEFAULT_FPS=60,MAX_DPR=4,$=id=>document.getElementById(id);

function install(){
  if(typeof document==='undefined'||typeof window==='undefined')return;
  const method=$('txMethod'),fileInput=$('fileInput'),payload=$('payloadBytes'),colorMode=$('colorMode'),grid=$('gridMode'),fps=$('fps');
  const canvas=$('txCanvas'),stage=$('txStage'),status=$('txStatus'),fileInfo=$('txFileInfo'),frame=$('txFrame'),badge=$('colorBadge'),gridState=$('gridState');
  if(!method||!fileInput||!payload||!fps||!canvas||!stage)return;
  let option=[...method.options].find(o=>o.value==='modem');if(!option){option=new Option('OPTICAL MODEM · 4 COLORI GRID EXP','modem');method.add(option);}else option.textContent='OPTICAL MODEM · 4 COLORI GRID EXP';

  let session=null,running=false,generation=0,raf=0,workers=[],busy=[],jobs=[],queue=[],workerCursor=0,jobId=0,shown=0,misses=0,startedAt=0,wakeLock=null,current=null;
  let savedPayload=payload.value,savedFps=fps.value,savedColor=colorMode?.value,savedGrid=grid?.value,active=false,syncingMethod=false;

  function enabled(){return method.value==='modem';}
  function setStatus(text,kind=''){if(status){status.textContent=text;status.dataset.kind=kind;}}
  function formatBytes(bytes){if(bytes<1024)return`${bytes} B`;const u=['KiB','MiB','GiB'];let v=bytes,i=-1;do{v/=1024;i++;}while(v>=1024&&i<u.length-1);return`${v.toFixed(v>=10?1:2)} ${u[i]}`;}
  function selectedFps(){return Math.max(8,Math.min(60,Number(fps.value)||DEFAULT_FPS));}
  function theoreticalKiBs(){return MODEM_CHUNK_BYTES*selectedFps()/1024;}
  function workerTarget(){const hc=Math.max(2,Math.floor(Number(navigator.hardwareConcurrency)||4));return hc>=6?4:hc>=4?3:2;}
  function opticalDpr(){return Math.max(1,Math.min(MAX_DPR,Number(devicePixelRatio)||1));}
  function stageBudget(){const s=getComputedStyle(stage),px=v=>Number.parseFloat(v)||0,rect=stage.getBoundingClientRect();const width=rect.width||stage.clientWidth,height=rect.height||stage.clientHeight;return{width:Math.max(1,width-px(s.paddingLeft)-px(s.paddingRight)),height:Math.max(1,height-px(s.paddingTop)-px(s.paddingBottom))};}
  function displayLayout(){const b=stageBudget();return computeModemDisplayLayout({width:b.width,height:b.height,dpr:opticalDpr(),rasterWidth:MODEM_RASTER_W,rasterHeight:MODEM_RASTER_H});}
  function choosePortrait(){return displayLayout().rotated;}
  async function requestWake(){if(wakeLock||!('wakeLock'in navigator))return;try{wakeLock=await navigator.wakeLock.request('screen');wakeLock.addEventListener('release',()=>{wakeLock=null;});}catch{}}
  async function releaseWake(){if(!wakeLock)return;try{await wakeLock.release();}catch{}wakeLock=null;}

  function render(item){
    if(!item?.raster)return;current=item;const r=item.raster,b=stageBudget(),dpr=opticalDpr();const layout=fitModemRaster({width:b.width,height:b.height,dpr,rasterWidth:r.width,rasterHeight:r.height}),scale=layout.scale;
    const staging=document.createElement('canvas');staging.width=r.width;staging.height=r.height;staging.getContext('2d',{alpha:false}).putImageData(new ImageData(r.pixels,r.width,r.height),0,0);
    canvas.width=r.width*scale;canvas.height=r.height*scale;canvas.style.width=`${layout.cssWidth}px`;canvas.style.height=`${layout.cssHeight}px`;canvas.style.maxWidth='none';canvas.style.maxHeight='none';canvas.style.imageRendering='pixelated';canvas.dataset.integerRaster='optical-modem';canvas.dataset.modemLayout=layout.desktop?'desktop-compact':'mobile-fill';
    const ctx=canvas.getContext('2d',{alpha:false});ctx.imageSmoothingEnabled=false;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(staging,0,0,r.width,r.height,0,0,canvas.width,canvas.height);
    const elapsed=startedAt?Math.max(.001,(performance.now()-startedAt)/1000):0,actual=elapsed?(shown/elapsed).toFixed(1):'—',layoutName=layout.desktop?'DESKTOP COMPACT':'MOBILE FILL';
    if(frame)frame.textContent=`OPTICAL MODEM · ${r.rotated?'PORTRAIT':'LANDSCAPE'} · ${layoutName} ${Math.round(layout.cssWidth)}×${Math.round(layout.cssHeight)} CSS px · 192×108 celle · 4 colori · ${MODEM_CHUNK_BYTES} B fountain/frame · Hamming+CRC · ${selectedFps()} fps · ×${scale} raster · ~${theoreticalKiBs().toFixed(1)} KiB/s offerti · ${actual} frame/s · queue ${queue.length}/${LOOKAHEAD} · miss ${misses} · seq ${item.symbolId}`;
    if(gridState)gridState.textContent=`MODEM 192×108 · ${MODEM_STATES} stati · ×${scale} · ${layout.desktop?'PC compatto':'mobile'}`;
    if(badge)badge.textContent='OPTICAL MODEM · R/G/B/M · FEC';
  }

  function terminateWorkers(){for(const w of workers)w?.terminate();workers=[];busy=[];jobs=[];queue=[];workerCursor=0;}
  function freeWorker(){for(let n=0;n<workers.length;n++){const i=(workerCursor+n)%workers.length;if(!busy[i]){workerCursor=(i+1)%workers.length;return i;}}return-1;}
  function ensureWorkers(){
    if(workers.length)return;for(let i=0;i<workerTarget();i++){
      const w=new Worker(new URL('./optical-modem-tx-worker.js',import.meta.url),{type:'module'});
      w.onmessage=e=>{const d=e.data||{};if(d.id===-1)return;const job=jobs[i];jobs[i]=null;busy[i]=false;if(d.error){running=false;setStatus(`OPTICAL MODEM TX: ${d.error}`,'error');return;}if(!job||job.generation!==generation||d.generation!==generation){pump();return;}queue.push({symbolId:job.symbolId,raster:{...d.raster,pixels:new Uint8ClampedArray(d.raster.pixels)}});pump();};
      w.onerror=e=>{busy[i]=false;jobs[i]=null;running=false;setStatus(`OPTICAL MODEM worker: ${e.message}`,'error');};workers.push(w);busy.push(false);jobs.push(null);
    }
  }
  function inFlight(){return jobs.filter(Boolean).length;}
  function dispatch(index){
    if(!session)return false;const symbolId=session.nextSymbolId++>>>0,symbol=session.encoder.symbol(symbolId),packet=encodeModemPacket(session.meta,symbolId,symbol.data);if(packet.length!==MODEM_PACKET_BYTES)throw new Error('Envelope modem inatteso');
    const id=jobId++,buffer=packet.buffer;busy[index]=true;jobs[index]={id,generation,symbolId};workers[index].postMessage({id,generation,symbolId,streamId:session.meta.streamId,portrait:choosePortrait(),packet:buffer},[buffer]);return true;
  }
  function pump(){if(!running)return;ensureWorkers();let guard=12;while(guard-->0&&queue.length+inFlight()<LOOKAHEAD){const i=freeWorker();if(i<0)break;if(!dispatch(i))break;}}

  async function prepare(force=false){
    const file=fileInput.files?.[0];if(!file)throw new Error('Seleziona prima un file.');const signature=`${file.name}:${file.size}:${file.lastModified}:${MODEM_CHUNK_BYTES}`;if(!force&&session?.signature===signature)return session;
    setStatus(`OPTICAL MODEM: preparo ${file.name}…`);const bytes=new Uint8Array(await file.arrayBuffer()),hash=await sha256Hex(bytes),container=packFileContainerV2(file.name,bytes,hash),streamId=randomStreamId(),encoder=new FountainEncoder(container,MODEM_CHUNK_BYTES,streamId);if(encoder.sourceCount>0xffff)throw new Error('File troppo grande per OPTICAL MODEM.');
    const meta={protocolVersion:2,streamId,sourceCount:encoder.sourceCount,chunkSize:encoder.chunkSize,containerLength:container.length,visualStates:4};const probe=encodeModemPacket(meta,0,encoder.symbol(0).data);if(probe.length!==MODEM_PACKET_BYTES)throw new Error('OPTICAL MODEM QCT2 probe fallita');
    session={signature,file,bytes,container,encoder,meta,nextSymbolId:0};generation++;queue=[];shown=0;misses=0;if(fileInfo)fileInfo.textContent=`${file.name} · ${formatBytes(bytes.length)} · OPTICAL MODEM · K=${encoder.sourceCount} × ${MODEM_CHUNK_BYTES} B · 4 colori`;return session;
  }

  async function start(){
    if(!enabled()||running)return;try{await prepare();running=true;generation++;queue=[];shown=0;misses=0;startedAt=performance.now();await requestWake();
      // The optical shell is moved into a fixed overlay immediately before this
      // function. Wait one paint so desktop stage measurements are final before
      // choosing orientation/raster size for the worker queue.
      await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
      ensureWorkers();pump();const wait=performance.now();while(running&&!queue.length&&performance.now()-wait<3000)await new Promise(r=>setTimeout(r,8));if(!running)return;const first=queue.shift();if(!first)throw new Error('lookahead modem non disponibile');render(first);shown++;pump();const layout=displayLayout();setStatus(`OPTICAL MODEM attivo · ${layout.desktop?'layout PC compatto':'layout mobile'} · 192×108 · 4 colori · ${selectedFps()} fps · ${MODEM_CHUNK_BYTES} B fountain/frame · ~${theoreticalKiBs().toFixed(0)} KiB/s offerti.`,'ok');
      let nextAt=performance.now()+1000/selectedFps();const tick=now=>{if(!running||!enabled())return;raf=requestAnimationFrame(tick);const interval=1000/selectedFps();if(now<nextAt)return;const item=queue.shift();pump();if(!item){misses++;nextAt=now+interval;return;}render(item);shown++;nextAt+=interval;if(now-nextAt>3*interval)nextAt=now+interval;};raf=requestAnimationFrame(tick);
    }catch(error){running=false;setStatus(`OPTICAL MODEM: ${error.message}`,'error');}
  }
  function stop({quiet=false}={}){running=false;generation++;if(raf)cancelAnimationFrame(raf);raf=0;terminateWorkers();void releaseWake();if(!quiet&&enabled())setStatus('OPTICAL MODEM in pausa. Il frame corrente resta visibile.');}
  async function resetTx(){const resume=running;stop({quiet:true});session=null;current=null;try{await prepare(true);if(resume)await start();else setStatus('OPTICAL MODEM resettato. Premi START.','ok');}catch(e){setStatus(`OPTICAL MODEM: ${e.message}`,'error');}}

  function enter(){if(active)return;active=true;savedPayload=payload.value;savedFps=fps.value;savedColor=colorMode?.value;savedGrid=grid?.value;let opt=[...payload.options].find(o=>o.value===String(MODEM_CHUNK_BYTES));if(!opt){opt=new Option(`${MODEM_CHUNK_BYTES} B · MODEM fisso`,String(MODEM_CHUNK_BYTES));opt.dataset.modem='1';payload.add(opt);}payload.value=String(MODEM_CHUNK_BYTES);payload.disabled=true;if(colorMode)colorMode.disabled=true;if(grid)grid.disabled=true;fps.value=String(DEFAULT_FPS);document.body.dataset.txVariant='optical-modem';session=null;const palette=MODEM_PALETTE.map(c=>`rgb(${c.join(',')})`).join(' · ');setStatus(`OPTICAL MODEM pronto: motore separato 192×108, fiducial propri, calibrazione per frame, 4 colori R/G/B/M, Hamming interlacciato + CRC + fountain. Layout PC compatto automatico; mobile usa l'area disponibile. Nessun QR/ZXing. ${palette}.`,'ok');}
  function leave(){if(!active)return;active=false;stop({quiet:true});payload.disabled=false;colorMode&&(colorMode.disabled=false);grid&&(grid.disabled=false);const opt=[...payload.options].find(o=>o.dataset.modem==='1');if(opt)opt.remove();if([...payload.options].some(o=>o.value===savedPayload))payload.value=savedPayload;if([...fps.options].some(o=>o.value===savedFps))fps.value=savedFps;if(colorMode&&[...colorMode.options].some(o=>o.value===savedColor))colorMode.value=savedColor;if(grid&&[...grid.options].some(o=>o.value===savedGrid))grid.value=savedGrid;delete document.body.dataset.txVariant;}

  // tx-profile-policy owns the txMethod select and only understands classic or
  // multi. In capture phase, first hand its internal state to multi (so its
  // Classic click interceptor is disabled), then keep the visible value modem.
  document.addEventListener('change',event=>{
    if(event.target!==method||syncingMethod)return;
    if(method.value==='modem'){
      event.preventDefault();event.stopImmediatePropagation();syncingMethod=true;
      method.value='multi';method.dispatchEvent(new Event('change',{bubbles:true}));method.value='modem';syncingMethod=false;enter();
    }else if(active)leave();
  },{capture:true});
  method.addEventListener('change',()=>{if(enabled())enter();else if(active)leave();});
  fileInput.addEventListener('change',event=>{if(!enabled())return;event.preventDefault();event.stopImmediatePropagation();stop({quiet:true});session=null;const file=fileInput.files?.[0];if(fileInfo)fileInfo.textContent=file?`${file.name} · ${formatBytes(file.size)} · pronto per OPTICAL MODEM`:'Nessun file selezionato.';setStatus(file?'File selezionato. START apre il modem ottico.':'Seleziona un file.',file?'ok':'');},{capture:true});
  document.addEventListener('click',event=>{if(!enabled())return;const id=event.target?.id;if(!['startTx','fsStartTx','stopTx','fsStopTx','fsResetTx','fsExitTx'].includes(id))return;event.preventDefault();event.stopImmediatePropagation();if(id==='startTx'){if(!fileInput.files?.length){setStatus('Seleziona prima un file.','warn');return;}enterTxOpticalView();void start();}else if(id==='fsStartTx')void start();else if(id==='fsResetTx')void resetTx();else if(id==='fsExitTx'){stop({quiet:true});exitTxOpticalView();}else stop();},{capture:true});
  window.addEventListener('resize',()=>{if(enabled()&&current)requestAnimationFrame(()=>render(current));});
}

install();
