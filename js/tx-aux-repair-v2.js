// qcolortrasfer v2.8 adaptive QAR2 helper sender (MIT).
//
// DECIMEN CLASSIC remains the main transport. This side channel uses only the
// spare screen strip when possible and shows 1–3 low-density helpers according
// to actual viewport/DPR AND helper pixels-per-module. Helpers cooperate on a
// small set of source-block anchors using independent GF(2) repair equations.

import { packFileContainerV2, randomStreamId, sha256Hex } from './protocol.js';
import {
  AUX2_PACKET_BYTES, AUX2_STRIPE_BYTES, encodeAuxRepairPacketV2
} from './aux-repair.js';
import { MAX_HIGH_THROUGHPUT_CHUNK } from './high-throughput.js';

const AUX_QR_ECC = 'M';
const AUX_QR_MASK = 4;
const AUX_QR_MARGIN = 4;
const AUX_MAX_DPR = 4;
const AUX_MAX_HELPERS = 3;
const AUX_MIN_CSS_PX = 104;
const AUX_MAX_CSS_PX = 190;
const AUX_GAP_CSS_PX = 8;
const AUX_RESERVE_EXTRA_PX = 18;
const AUX_MIN_DEVICE_PX_PER_CELL = 3.35;
const AUX_DEFAULT_RASTER = 77; // conservative QAR2 ~300 B ECC-M estimate
const CLASSIC_V40_RASTER_WITH_QUIET = 185;
const AUX_MAX_ANCHOR_BLOCKS = 12;
const AUX_REPAIR_OVERHEAD_RATIO = 0.75;
const AUX_LOOKAHEAD_PER_HELPER = 2;

let qrPromise = null;
async function getQrCode() {
  if (!qrPromise) qrPromise = import('https://esm.sh/qrcode@1.5.4?bundle').then(mod => mod.default || mod);
  return qrPromise;
}

function physicalScale(cssBudget, dpr, rasterSize) {
  return Math.max(1, Math.floor((Math.max(1, cssBudget) * dpr) / Math.max(1, rasterSize)));
}

export function chooseAuxLayoutV2(widthCss, heightCss, devicePixelRatio = 1, auxRasterSize = AUX_DEFAULT_RASTER, mainRasterSize = CLASSIC_V40_RASTER_WITH_QUIET) {
  const width = Math.max(1, Number(widthCss) || 1);
  const height = Math.max(1, Number(heightCss) || 1);
  const dpr = Math.max(1, Math.min(AUX_MAX_DPR, Number(devicePixelRatio) || 1));
  const auxRaster = Math.max(29, Math.floor(Number(auxRasterSize) || AUX_DEFAULT_RASTER));
  const mainRaster = Math.max(21, Math.floor(Number(mainRasterSize) || CLASSIC_V40_RASTER_WITH_QUIET));
  const sideLayout = width > height * 1.18;
  const cross = sideLayout ? height : width;
  const baselineMainScale = physicalScale(Math.min(width, height), dpr, mainRaster);

  for (let count = AUX_MAX_HELPERS; count >= 1; count--) {
    const maxByCross = (cross - AUX_GAP_CSS_PX * (count - 1)) / count;
    const helperCss = Math.floor(Math.min(AUX_MAX_CSS_PX, cross * 0.34, maxByCross));
    if (helperCss < AUX_MIN_CSS_PX) continue;
    const devicePxPerCell = helperCss * dpr / auxRaster;
    if (devicePxPerCell < AUX_MIN_DEVICE_PX_PER_CELL) continue;
    const reserve = helperCss + AUX_RESERVE_EXTRA_PX;
    const mainWidth = width - (sideLayout ? reserve : 0);
    const mainHeight = height - (sideLayout ? 0 : reserve);
    const mainScale = physicalScale(Math.min(mainWidth, mainHeight), dpr, mainRaster);
    if (mainScale >= baselineMainScale) {
      return { count, helperCss, reserve, sideLayout, baselineMainScale, mainScale, devicePxPerCell, compromisesMain:false };
    }
  }

  // No truly-free strip: keep one readable helper only if it can still reach a
  // useful optical density. The UI reports that the main raster is compromised.
  const helperCss = Math.max(88, Math.floor(Math.min(AUX_MAX_CSS_PX, cross * 0.30)));
  const reserve = helperCss + AUX_RESERVE_EXTRA_PX;
  const mainWidth = width - (sideLayout ? reserve : 0);
  const mainHeight = height - (sideLayout ? 0 : reserve);
  return {
    count:1, helperCss, reserve, sideLayout, baselineMainScale,
    mainScale:physicalScale(Math.min(mainWidth,mainHeight),dpr,mainRaster),
    devicePxPerCell:helperCss*dpr/auxRaster, compromisesMain:true
  };
}

export function selectRepairAnchors(sourceCount, maxAnchors = AUX_MAX_ANCHOR_BLOCKS) {
  const total = Math.max(1, Math.floor(Number(sourceCount) || 1));
  const count = Math.min(total, Math.max(1, Math.floor(Number(maxAnchors) || 1)));
  if (count === total) return Array.from({length:total},(_,i)=>i);
  if (count === 1) return [0];
  const out=[];
  for(let i=0;i<count;i++) out.push(Math.round(i*(total-1)/(count-1)));
  return [...new Set(out)];
}

export function repairSymbolsPerAnchor(chunkSize) {
  const stripes=Math.ceil(Math.max(1,Number(chunkSize)||1)/AUX2_STRIPE_BYTES);
  return stripes + Math.max(4, Math.ceil(stripes * AUX_REPAIR_OVERHEAD_RATIO));
}

function installQar2Ui() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const toolbar=document.querySelector('#txView .tx-toolbar');
  const methodSelect=document.getElementById('txMethod');
  const fileInput=document.getElementById('fileInput');
  const payloadBytes=document.getElementById('payloadBytes');
  const fpsSelect=document.getElementById('fps');
  const stage=document.getElementById('txStage');
  const txFrame=document.getElementById('txFrame');
  if(!toolbar||!methodSelect||!fileInput||!payloadBytes||!fpsSelect||!stage)return;

  const variantLabel=document.createElement('label');
  variantLabel.className='tx-aux-control';
  variantLabel.innerHTML='<span>Modalità Decimen</span><select id="txClassicVariant"><option value="classic" selected>CLASSIC · solo QR principale</option><option value="aux">CLASSIC + AUX REPAIR · QAR2 AUTO</option></select>';
  methodSelect.closest('label')?.after(variantLabel);
  const variant=variantLabel.querySelector('select');

  stage.style.position='relative';
  const auxLayer=document.createElement('div');
  auxLayer.id='txAuxLayer';
  auxLayer.setAttribute('aria-label','QR helper QAR2 adattivi');
  Object.assign(auxLayer.style,{position:'absolute',zIndex:'4',display:'none',alignItems:'center',justifyContent:'center',gap:`${AUX_GAP_CSS_PX}px`,pointerEvents:'none'});
  stage.appendChild(auxLayer);

  const auxStats=document.createElement('div');
  auxStats.id='txAuxStats'; auxStats.className='frame-meta telemetry-line'; auxStats.hidden=true;
  txFrame?.after(auxStats);
  const auxBadge=document.createElement('span');
  auxBadge.id='auxRepairBadge'; auxBadge.className='badge'; auxBadge.textContent='QAR2 AUTO'; auxBadge.hidden=true;
  document.querySelector('.badges')?.appendChild(auxBadge);

  let session=null,running=false,generation=0,queue=[],generating=false,raf=0,nextAt=0;
  let shown=0,misses=0,startedAt=0,nextLane=0,currentRasterSize=AUX_DEFAULT_RASTER;
  let layout={count:1,helperCss:112,reserve:130,sideLayout:false,devicePxPerCell:0};
  let canvases=[],laneItems=[];

  function enabled(){return methodSelect.value==='classic'&&variant.value==='aux';}
  function selectedChunk(){return Math.max(512,Math.min(MAX_HIGH_THROUGHPUT_CHUNK,Number(payloadBytes.value)||MAX_HIGH_THROUGHPUT_CHUNK));}
  function auxFpsPerHelper(){const main=Math.max(1,Math.min(60,Number(fpsSelect.value)||24));return Math.max(8,Math.min(20,Math.round(main/2)));}
  function globalTickFps(){return auxFpsPerHelper()*Math.max(1,layout.count);}
  function queueTarget(){return Math.max(4,layout.count*AUX_LOOKAHEAD_PER_HELPER+2);}

  function sourceBlock(container,chunkSize,blockIndex){const out=new Uint8Array(chunkSize);const start=blockIndex*chunkSize;out.set(container.subarray(start,Math.min(container.length,start+chunkSize)));return out;}
  function styleCanvas(canvas){Object.assign(canvas.style,{display:'block',background:'#fff',imageRendering:'pixelated',boxShadow:'0 0 0 5px #fff',touchAction:'none',flex:'0 0 auto'});}
  function ensureCanvasCount(count){
    while(canvases.length<count){const canvas=document.createElement('canvas');canvas.className='txAuxCanvas';canvas.setAttribute('aria-label',`QR helper QAR2 ${canvases.length+1}`);styleCanvas(canvas);auxLayer.appendChild(canvas);canvases.push(canvas);laneItems.push(null);}
    while(canvases.length>count){canvases.pop()?.remove();laneItems.pop();}
    nextLane%=Math.max(1,canvases.length);
  }
  function positionLayer(){
    auxLayer.style.flexDirection=layout.sideLayout?'column':'row';
    if(layout.sideLayout){auxLayer.style.right='var(--tx-edge-x,12px)';auxLayer.style.left='auto';auxLayer.style.top='50%';auxLayer.style.bottom='auto';auxLayer.style.transform='translateY(-50%)';}
    else{auxLayer.style.left='50%';auxLayer.style.right='auto';auxLayer.style.bottom='var(--tx-edge-y,10px)';auxLayer.style.top='auto';auxLayer.style.transform='translateX(-50%)';}
  }
  function syncAuxLayout(){
    if(!enabled())return;
    layout=chooseAuxLayoutV2(Math.max(1,stage.clientWidth||window.innerWidth||1),Math.max(1,stage.clientHeight||window.innerHeight||1),window.devicePixelRatio||1,currentRasterSize);
    ensureCanvasCount(layout.count);
    stage.classList.add('aux-repair-active');stage.classList.toggle('aux-repair-side',layout.sideLayout);
    stage.style.setProperty('--aux-repair-size',`${layout.helperCss}px`);stage.style.setProperty('--aux-repair-reserve',`${layout.reserve}px`);
    auxLayer.style.display='flex';positionLayer();auxBadge.textContent=`QAR2 ×${layout.count}`;
    for(let lane=0;lane<laneItems.length;lane++)if(laneItems[lane])renderAux(laneItems[lane],lane,false);
    updateStats();
  }
  function requestMainResize(){requestAnimationFrame(()=>window.dispatchEvent(new Event('resize')));}
  function enableLayout(){if(!enabled())return disableLayout();syncAuxLayout();auxBadge.hidden=false;auxStats.hidden=false;requestMainResize();}
  function disableLayout(){stage.classList.remove('aux-repair-active','aux-repair-side');stage.style.removeProperty('--aux-repair-size');stage.style.removeProperty('--aux-repair-reserve');auxLayer.style.display='none';auxBadge.hidden=true;auxStats.hidden=true;requestMainResize();}

  async function createAuxRaster(bytes){
    if(bytes.length!==AUX2_PACKET_BYTES)throw new Error(`QAR2 optical envelope ${bytes.length} B inatteso`);
    const QRCode=await getQrCode();
    const qr=QRCode.create([{data:bytes,mode:'byte'}],{errorCorrectionLevel:AUX_QR_ECC,maskPattern:AUX_QR_MASK});
    const modules=qr.modules.size,size=modules+AUX_QR_MARGIN*2,pixels=new Uint8ClampedArray(size*size*4);pixels.fill(255);
    for(let y=0;y<modules;y++)for(let x=0;x<modules;x++){if(!qr.modules.get(y,x))continue;const off=((y+AUX_QR_MARGIN)*size+x+AUX_QR_MARGIN)*4;pixels[off]=pixels[off+1]=pixels[off+2]=0;pixels[off+3]=255;}
    return{pixels,size,modules,version:qr.version};
  }
  function renderAux(item,lane,reflow=true){
    const canvas=canvases[lane];if(!item?.raster||!canvas||!enabled())return;
    laneItems[lane]=item;const raster=item.raster;currentRasterSize=raster.size;
    const dpr=Math.max(1,Math.min(AUX_MAX_DPR,Number(window.devicePixelRatio)||1));
    const scale=Math.max(1,Math.floor((layout.helperCss*dpr)/raster.size));const px=raster.size*scale;
    const staging=document.createElement('canvas');staging.width=raster.size;staging.height=raster.size;staging.getContext('2d',{alpha:false}).putImageData(new ImageData(raster.pixels,raster.size,raster.size),0,0);
    canvas.width=px;canvas.height=px;canvas.style.width=`${px/dpr}px`;canvas.style.height=`${px/dpr}px`;
    const ctx=canvas.getContext('2d',{alpha:false});ctx.imageSmoothingEnabled=false;ctx.clearRect(0,0,px,px);ctx.drawImage(staging,0,0,raster.size,raster.size,0,0,px,px);
    if(reflow){const oldCount=layout.count;syncAuxLayout();if(layout.count!==oldCount)requestMainResize();}
  }
  function updateStats(){
    if(!enabled())return;
    const elapsed=startedAt?Math.max(.001,(performance.now()-startedAt)/1000):0;const actual=elapsed?(shown/elapsed).toFixed(1):'—';
    const version=laneItems.find(Boolean)?.raster?.version??'—';const raster=laneItems.find(Boolean)?.raster?.size??currentRasterSize;
    const rankGoal=session?Math.ceil(session.chunkSize/AUX2_STRIPE_BYTES):0;
    auxStats.textContent=`AUX QAR2 ×${layout.count} · ${AUX2_STRIPE_BYTES} B/equazione · ${auxFpsPerHelper()} fps/helper · ${globalTickFps()} update/s staggered · QR V${version} ECC M · raster ${raster} · ${layout.devicePxPerCell?.toFixed?.(1)||'—'} px/cella · anchor ${session?.anchors.length||'—'} · rank target ${rankGoal||'—'} · ${actual} eq/s · queue ${queue.length}/${queueTarget()} · miss ${misses}${layout.compromisesMain?' · MAIN COMPROMESSO':''}`;
  }

  async function prepareSession(force=false){
    const file=fileInput.files?.[0];if(!file)throw new Error('Seleziona prima un file.');
    const chunkSize=selectedChunk();const signature=`${file.name}:${file.size}:${file.lastModified}:${chunkSize}`;
    if(!force&&session?.signature===signature)return session;
    const bytes=new Uint8Array(await file.arrayBuffer());const hash=await sha256Hex(bytes);const container=packFileContainerV2(file.name,bytes,hash);const sourceCount=Math.max(1,Math.ceil(container.length/chunkSize));
    if(sourceCount>0xffff)throw new Error('QAR2: troppi blocchi sorgente.');
    const anchors=selectRepairAnchors(sourceCount);const symbolsPerAnchor=repairSymbolsPerAnchor(chunkSize);
    session={signature,container,chunkSize,sourceCount,auxSessionId:randomStreamId(),anchors,anchorCursor:0,symbolInAnchor:0,symbolsPerAnchor,repairIndex:new Map()};
    queue=[];misses=0;generation++;nextLane=0;laneItems.fill(null);updateStats();return session;
  }
  function nextDescriptor(runGeneration){
    if(!session||runGeneration!==generation)return null;
    const blockIndex=session.anchors[session.anchorCursor];const block=sourceBlock(session.container,session.chunkSize,blockIndex);
    const repairIndex=session.repairIndex.get(blockIndex)||0;session.repairIndex.set(blockIndex,repairIndex+1);
    const packet=encodeAuxRepairPacketV2({auxSessionId:session.auxSessionId,sourceCount:session.sourceCount,chunkSize:session.chunkSize,containerLength:session.container.length},blockIndex,repairIndex,block);
    session.symbolInAnchor++;
    if(session.symbolInAnchor>=session.symbolsPerAnchor){session.symbolInAnchor=0;session.anchorCursor=(session.anchorCursor+1)%session.anchors.length;}
    return{packet,blockIndex,repairIndex};
  }
  async function makeItem(runGeneration){const descriptor=nextDescriptor(runGeneration);if(!descriptor)return null;const raster=await createAuxRaster(descriptor.packet);if(runGeneration!==generation)return null;return{...descriptor,raster};}
  async function pump(runGeneration){
    if(generating||!running||runGeneration!==generation)return;generating=true;
    try{while(running&&runGeneration===generation&&queue.length<queueTarget()){const item=await makeItem(runGeneration);if(!item)break;queue.push(item);}}
    catch(error){running=false;auxStats.textContent=`QAR2 errore: ${error.message}`;auxStats.dataset.kind='error';}
    finally{generating=false;updateStats();}
  }
  async function startAux(){
    if(!enabled()||running)return;enableLayout();
    try{
      await prepareSession();running=true;generation++;const runGeneration=generation;shown=0;misses=0;startedAt=performance.now();await pump(runGeneration);
      if(!running||runGeneration!==generation)return;
      for(let lane=0;lane<layout.count;lane++){const item=queue.shift();if(!item)break;renderAux(item,lane,lane===layout.count-1);shown++;}
      void pump(runGeneration);nextLane=0;nextAt=performance.now()+1000/globalTickFps();
      const tick=now=>{
        if(!running||runGeneration!==generation||!enabled())return;raf=requestAnimationFrame(tick);const interval=1000/globalTickFps();if(now<nextAt)return;
        const item=queue.shift();void pump(runGeneration);if(!item){misses++;nextAt=now+interval;updateStats();return;}
        const lane=nextLane%Math.max(1,layout.count);renderAux(item,lane,false);nextLane=(lane+1)%Math.max(1,layout.count);shown++;nextAt+=interval;if(now-nextAt>3*interval)nextAt=now+interval;updateStats();
      };
      raf=requestAnimationFrame(tick);
    }catch(error){running=false;auxStats.hidden=false;auxStats.textContent=`QAR2 errore: ${error.message}`;auxStats.dataset.kind='error';}
  }
  function stopAux(){running=false;generation++;if(raf)cancelAnimationFrame(raf);raf=0;queue=[];updateStats();}
  async function resetAux(resume=running){stopAux();session=null;laneItems.fill(null);if(resume&&enabled())await startAux();}
  function syncAvailability(){const classic=methodSelect.value==='classic';variant.disabled=!classic;variantLabel.hidden=!classic;if(!classic){stopAux();disableLayout();}else if(variant.value==='aux')enableLayout();else disableLayout();}

  variant.addEventListener('change',()=>{stopAux();session=null;syncAvailability();});
  methodSelect.addEventListener('change',()=>queueMicrotask(syncAvailability));
  payloadBytes.addEventListener('change',()=>{session=null;});fpsSelect.addEventListener('change',updateStats);
  document.addEventListener('click',event=>{const id=event.target?.id;if((id==='startTx'||id==='fsStartTx')&&enabled())queueMicrotask(()=>void startAux());else if(id==='stopTx'||id==='fsStopTx'||id==='fsExitTx')stopAux();else if(id==='fsResetTx'&&enabled()){const resume=running;queueMicrotask(()=>void resetAux(resume));}},{capture:true});
  document.addEventListener('change',event=>{if(event.target===fileInput){stopAux();session=null;}},{capture:true});
  window.addEventListener('resize',()=>{if(enabled()){syncAuxLayout();requestMainResize();}});
  window.addEventListener('orientationchange',()=>setTimeout(()=>{if(enabled()){syncAuxLayout();requestMainResize();}},80));
  syncAvailability();
}

installQar2Ui();
