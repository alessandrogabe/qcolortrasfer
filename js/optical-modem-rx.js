// Standalone OPTICAL MODEM receiver. It owns camera capture while RX mode is
// set to modem and never invokes QR/ZXing. Frames are dropped before readback
// when all workers are busy.

import { FountainDecoder } from './fountain.js';
import { unpackFileContainerV2, sha256Hex } from './protocol.js';
import { MODEM_GRID_W, MODEM_GRID_H } from './optical-modem-codec.js';
import { MODEM_RS_CHUNK_BYTES as MODEM_CHUNK_BYTES } from './optical-modem-rs-codec.js';

const $=id=>document.getElementById(id),MAX_WORKERS=4,LOCK_FULL_MS=1500;

function install(){
  if(typeof document==='undefined'||typeof window==='undefined')return;
  const video=$('rxVideo'),status=$('rxStatus'),stats=$('rxStats'),progress=$('rxProgress'),download=$('download'),stage=document.querySelector('#rxView .rx-stage'),controls=document.querySelector('#rxView .controls');
  if(!video||!status||!stats||!stage||!controls)return;

  const wrap=document.createElement('label');wrap.className='rx-modem-control';wrap.innerHTML='<span>Metodo RX</span><select id="rxMethod"><option value="qr" selected>QR / MAIN COLOR</option><option value="modem">OPTICAL MODEM · COLOR GRID EXP</option></select>';controls.parentNode?.insertBefore(wrap,controls);const method=wrap.querySelector('select');
  const overlay=document.createElement('canvas');overlay.className='modem-rx-overlay';Object.assign(overlay.style,{position:'absolute',inset:'0',width:'100%',height:'100%',pointerEvents:'none',zIndex:'4'});stage.style.position='relative';stage.appendChild(overlay);

  let running=false,stream=null,captureCanvas=document.createElement('canvas'),ctx=captureCanvas.getContext('2d',{alpha:false,willReadFrequently:true});
  let workers=[],busy=[],jobs=[],workerCursor=0,jobId=0,raf=0,tracked=null,lastFull=0,misses=0,earlyDrop=0,attempts=0,hits=0,detectHits=0,trackedHits=0;
  let corrected=0,resampled=0,syncSum=0,calSum=0,marginSum=0,workerEma=0,decodeEma=0,detectorEma=0,lastOverlayAt=0,cameraLabel='—',lastAnchor='—';
  let lastStage='—',lastFinder=0,lastProbeSync=0,anchorSeen=0,lastCal=0,lastMargin=0,lastPilot=0,lastPhase=0,lastControlAccuracy=0,lastTrialCorrected=0,lastTrialResampled=0,lastDecodeError='';
  let decoder=null,currentStream=null,startedAt=0,completed=false,downloadUrl=null,lastControl=null;

  function enabled(){return method.value==='modem';}
  function setStatus(text,kind=''){status.textContent=text;status.dataset.kind=kind;}
  function desiredWorkers(){const hc=Math.max(2,Math.floor(Number(navigator.hardwareConcurrency)||4));return Math.min(MAX_WORKERS,hc>=6?4:hc>=4?3:2);}
  function stopTracks(target){for(const track of target?.getTracks?.()||[])try{track.stop();}catch{}}
  function resetCounters(){tracked=null;lastFull=0;misses=0;earlyDrop=0;attempts=0;hits=0;detectHits=0;trackedHits=0;corrected=0;resampled=0;syncSum=0;calSum=0;marginSum=0;workerEma=0;decodeEma=0;detectorEma=0;lastStage='—';lastFinder=0;lastProbeSync=0;anchorSeen=0;lastCal=0;lastMargin=0;lastPilot=0;lastPhase=0;lastControlAccuracy=0;lastTrialCorrected=0;lastTrialResampled=0;lastDecodeError='';decoder=null;currentStream=null;startedAt=performance.now();completed=false;lastControl=null;lastAnchor='—';if(progress)progress.value=0;if(download){download.hidden=true;download.removeAttribute('href');}if(downloadUrl){URL.revokeObjectURL(downloadUrl);downloadUrl=null;}clearOverlay();updateStats();}

  function clearOverlay(){const r=stage.getBoundingClientRect(),dpr=Math.max(1,Math.min(2,devicePixelRatio||1));overlay.width=Math.max(1,Math.round(r.width*dpr));overlay.height=Math.max(1,Math.round(r.height*dpr));overlay.getContext('2d').clearRect(0,0,overlay.width,overlay.height);}
  function drawOverlay(markers,color='#58f29a'){
    if(!markers?.length||markers.length!==4)return;const rect=stage.getBoundingClientRect(),dpr=Math.max(1,Math.min(2,devicePixelRatio||1));if(overlay.width!==Math.round(rect.width*dpr)||overlay.height!==Math.round(rect.height*dpr))clearOverlay();
    const vw=video.videoWidth||captureCanvas.width,vh=video.videoHeight||captureCanvas.height;if(!vw||!vh)return;const scale=Math.min(rect.width/vw,rect.height/vh),ox=(rect.width-vw*scale)/2,oy=(rect.height-vh*scale)/2,c=overlay.getContext('2d');c.clearRect(0,0,overlay.width,overlay.height);c.save();c.scale(dpr,dpr);c.strokeStyle=color;c.lineWidth=2;c.beginPath();markers.forEach((p,i)=>{const x=ox+p.x*scale,y=oy+p.y*scale;i?c.lineTo(x,y):c.moveTo(x,y);});c.closePath();c.stroke();c.restore();lastOverlayAt=performance.now();
  }

  function updateStats(){
    const elapsed=Math.max(.001,(performance.now()-startedAt)/1000),symps=decoder?decoder.framesNew/elapsed:0,kibs=decoder?decoder.framesNew*MODEM_CHUNK_BYTES/elapsed/1024:0,hitPct=attempts?Math.round(hits*100/attempts):0;
    const sync=hits?Math.round(syncSum*100/hits):0,cal=hits?(calSum/hits).toFixed(3):'—',margin=hits?(marginSum/hits).toFixed(4):'—',probeSync=Math.round(lastProbeSync*100);
    stats.textContent=`MODEM RS191 ${hits}/${attempts} (${hitPct}%) · ${symps.toFixed(1)} simboli/s · ${kibs.toFixed(1)} KiB/s · stage ${lastStage} · anchor-visti ${anchorSeen} · finder ${lastFinder?lastFinder.toFixed(1):'—'} · probe-sync ${lastProbeSync?probeSync+'%':'—'} · detector ${detectorEma?detectorEma.toFixed(1):'—'} ms · detect ${detectHits} · tracked ${trackedHits} · anchor ${lastAnchor} · pilot ${lastPilot}/4 · phase ${lastPhase?Math.round(lastPhase*100)+'%':'—'} · control ${lastControlAccuracy?Math.round(lastControlAccuracy*100)+'%':'—'} · cal-now ${lastCal?lastCal.toFixed(3):'—'} · margin-now ${lastMargin?lastMargin.toFixed(4):'—'} · RS corr ${lastTrialCorrected} / total ${corrected} · area-now ${lastTrialResampled} · sync ${sync}% · cal ${cal} · margin ${margin} · resample ${resampled} · decode ${decodeEma?decodeEma.toFixed(1):'—'} ms · worker ${workerEma?workerEma.toFixed(1):'—'} ms · pool ${workers.length} · early-drop ${earlyDrop} · camera ${cameraLabel}${lastDecodeError?` · fail ${lastDecodeError.slice(0,48)}`:''}`;
    if(progress)progress.value=decoder?decoder.progress*100:0;
  }

  function freeWorker(){for(let n=0;n<workers.length;n++){const i=(workerCursor+n)%workers.length;if(!busy[i]){workerCursor=(i+1)%workers.length;return i;}}return-1;}
  function terminateWorkers(){for(const w of workers)w?.terminate();workers=[];busy=[];jobs=[];workerCursor=0;}
  function ensureWorkers(){
    if(workers.length)return;for(let i=0;i<desiredWorkers();i++){
      const w=new Worker(new URL('./optical-modem-worker.js',import.meta.url),{type:'module'});
      w.onmessage=e=>onWorker(i,e.data||{});w.onerror=e=>{busy[i]=false;jobs[i]=null;setStatus(`OPTICAL MODEM worker: ${e.message}`,'error');};workers.push(w);busy.push(false);jobs.push(null);w.postMessage({type:'warmup',id:-100-i});
    }
  }

  async function finalize(){
    if(completed||!decoder?.complete)return;completed=true;try{
      const container=decoder.reconstruct(),file=unpackFileContainerV2(container),hash=await sha256Hex(file.bytes);if(file.sha256&&hash&&file.sha256!==hash)throw new Error('SHA-256 finale non corrisponde');
      downloadUrl=URL.createObjectURL(new Blob([file.bytes]));if(download){download.href=downloadUrl;download.download=file.fileName;download.textContent=`SCARICA ${file.fileName} (${(file.fileLength/1024).toFixed(1)} KiB)`;download.hidden=false;}
      const elapsed=Math.max(.001,(performance.now()-startedAt)/1000);setStatus(`COMPLETATO MODEM RS191 · ${(file.fileLength/1024).toFixed(1)} KiB · ${elapsed.toFixed(2)} s · ${(file.fileLength/elapsed/1024).toFixed(1)} KiB/s file · SHA-256 OK · ${decoder.framesNew} simboli distinti`,'ok');if(progress)progress.value=100;
    }catch(error){completed=false;setStatus(`OPTICAL MODEM finale: ${error.message}`,'error');}
  }

  function acceptPacket(raw){
    const p={...raw,payload:new Uint8Array(raw.payload)};if(p.chunkSize!==MODEM_CHUNK_BYTES)return;
    if(!decoder||currentStream!==p.streamId){decoder=new FountainDecoder(p.sourceCount,p.chunkSize,p.transferLength,p.streamId);currentStream=p.streamId;startedAt=performance.now();completed=false;}
    decoder.addSymbol(p.symbolId,p.payload);if(decoder.complete)void finalize();
  }

  function onWorker(index,d){
    busy[index]=false;jobs[index]=null;if(d.id<0)return;attempts++;workerEma=workerEma?workerEma*.88+Number(d.workerMs||0)*.12:Number(d.workerMs||0);lastStage=d.stage||lastStage;
    if(Number(d.detectorMs)>0)detectorEma=detectorEma?detectorEma*.85+Number(d.detectorMs)*.15:Number(d.detectorMs);
    lastCal=Number(d.calibrationSeparation)||lastCal;lastMargin=Number(d.margin)||lastMargin;lastPilot=Number(d.pilotAnchors)||0;lastPhase=Number(d.phaseAccuracy)||lastPhase;lastControlAccuracy=Number(d.controlAccuracy)||lastControlAccuracy;lastTrialCorrected=Number(d.corrected)||0;lastTrialResampled=Number(d.resampled)||0;lastDecodeError=d.decodeError||'';
    if(d.anchorFound){
      anchorSeen++;lastFinder=Number(d.finderScore)||lastFinder;lastProbeSync=Number(d.syncAccuracy)||lastProbeSync;lastAnchor=d.anchorSet||lastAnchor||'outer';
      if(d.markers){tracked={markers:d.markers,rotation:d.rotation,anchorSet:d.anchorSet||'outer'};misses=0;drawOverlay(d.markers,'#f5c451');}
    }
    if(d.ok){hits++;if(d.detected)detectHits++;else trackedHits++;misses=0;lastAnchor=d.anchorSet||'outer';tracked={markers:d.markers,rotation:d.rotation,anchorSet:lastAnchor};lastFull=d.detected?performance.now():lastFull;corrected+=Number(d.corrected)||0;resampled+=Number(d.resampled)||0;syncSum+=Number(d.syncAccuracy)||0;calSum+=Number(d.calibrationSeparation)||0;marginSum+=Number(d.margin)||0;decodeEma=decodeEma?decodeEma*.88+Number(d.decodeMs||0)*.12:Number(d.decodeMs||0);drawOverlay(d.markers);acceptPacket(d.packet);
      if(!completed)setStatus(`OPTICAL MODEM RS191 agganciato · ${MODEM_GRID_W}×${MODEM_GRID_H} · 4 colori · SYNC ${lastAnchor} · ${decoder?Math.round(decoder.progress*100):0}%`,'ok');
    }else if(!d.anchorFound){misses++;if(misses>=8)tracked=null;}
    if(!d.ok&&attempts%20===0)setStatus(`OPTICAL MODEM RS191: stage ${lastStage} · anchor ${anchorSeen} · sync ${lastProbeSync?Math.round(lastProbeSync*100)+'%':'—'} · pilot ${lastPilot}/4 · phase ${lastPhase?Math.round(lastPhase*100)+'%':'—'} · cal ${lastCal?lastCal.toFixed(3):'—'} · area ${lastTrialResampled} · worker ${workerEma.toFixed(0)} ms`,'warn');
    updateStats();
  }

  function capture(now){
    if(!running||!enabled())return;raf=requestAnimationFrame(capture);if(lastOverlayAt&&now-lastOverlayAt>700)clearOverlay();const i=freeWorker();if(i<0){earlyDrop++;if((earlyDrop&15)===0)updateStats();return;}
    const w=video.videoWidth,h=video.videoHeight;if(!w||!h)return;if(captureCanvas.width!==w||captureCanvas.height!==h){captureCanvas.width=w;captureCanvas.height=h;ctx=captureCanvas.getContext('2d',{alpha:false,willReadFrequently:true});}
    ctx.drawImage(video,0,0,w,h);const image=ctx.getImageData(0,0,w,h),forceDetect=!tracked||misses>=4||now-lastFull>LOCK_FULL_MS,id=jobId++;busy[i]=true;jobs[i]={id};workers[i].postMessage({id,width:w,height:h,buffer:image.data.buffer,tracked,forceDetect},[image.data.buffer]);if(forceDetect)lastFull=now;
  }

  async function getCamera(){
    const base={facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:960}},rates=[{exact:60},{ideal:60},{exact:30},{ideal:30}];let last=null;
    for(const frameRate of rates)try{const s=await navigator.mediaDevices.getUserMedia({audio:false,video:{...base,frameRate}});const track=s.getVideoTracks()[0],settings=track?.getSettings?.()||{};cameraLabel=`${settings.width||'?'}×${settings.height||'?'}@${settings.frameRate||'?'}${frameRate.exact?' exact':' ideal'}`;try{const caps=track?.getCapabilities?.();if(caps?.focusMode?.includes?.('continuous'))await track.applyConstraints({advanced:[{focusMode:'continuous'}]});}catch{}return s;}catch(error){last=error;}
    throw last||new Error('Fotocamera non disponibile');
  }

  async function start(){
    if(running||!enabled())return;try{stopTracks(video.srcObject);resetCounters();stream=await getCamera();video.srcObject=stream;await video.play();running=true;ensureWorkers();setStatus(`Camera ${cameraLabel} · OPTICAL MODEM RS191: cerca i 4 SYNC e calibra R/G/B/M…`,'ok');raf=requestAnimationFrame(capture);
    }catch(error){running=false;setStatus(`OPTICAL MODEM camera: ${error.message}`,'error');}
  }
  function stop({quiet=false}={}){running=false;if(raf)cancelAnimationFrame(raf);raf=0;stopTracks(stream);stream=null;if(video.srcObject){stopTracks(video.srcObject);video.srcObject=null;}terminateWorkers();clearOverlay();if(!quiet&&enabled())setStatus('OPTICAL MODEM RX fermato.');}
  function reset(){const resume=running;stop({quiet:true});resetCounters();if(resume)void start();else setStatus('OPTICAL MODEM RX azzerato. Premi CAMERA START.','ok');}

  method.addEventListener('change',()=>{if(enabled()){stopTracks(video.srcObject);resetCounters();setStatus('OPTICAL MODEM RX pronto: 4 fiducial SYNC, calibrazione colore, fast pass + area retry e RS(255,191). Premi CAMERA START.','ok');}else{stop({quiet:true});setStatus("Avvia la fotocamera e inquadra l'intera griglia QR.");}});
  document.addEventListener('click',event=>{if(!enabled())return;const id=event.target?.id;if(!['startRx','stopRx','resetRx'].includes(id))return;event.preventDefault();event.stopImmediatePropagation();if(id==='startRx')void start();else if(id==='resetRx')reset();else stop();},{capture:true});
  window.addEventListener('resize',()=>{if(enabled())clearOverlay();});
}

install();
