// qcolortrasfer v2.8 RX detection overlay (MIT).
//
// Draws a perspective-following green outline only for QR codes that actually
// decoded. Detector-error sightings remain useful to the crop scheduler but are
// deliberately invisible: failed quads are often clipped or wildly oversized
// and must not look like successful reads to the operator.
//
// No extra camera reads, ZXing calls or pixel analysis. One transparent canvas,
// max 20 fps, fed only by results workers already produce.

export const RX_OVERLAY_TTL_MS = 650;
export const RX_OVERLAY_FRAME_MS = 50;
export const RX_OVERLAY_MAX_DPR = 2;

export function containVideoTransform(stageWidth,stageHeight,videoWidth,videoHeight){
  const sw=Math.max(1,Number(stageWidth)||1),sh=Math.max(1,Number(stageHeight)||1),vw=Math.max(1,Number(videoWidth)||1),vh=Math.max(1,Number(videoHeight)||1);
  const scale=Math.min(sw/vw,sh/vh);return{scale,offsetX:(sw-vw*scale)/2,offsetY:(sh-vh*scale)/2};
}
export function mapVideoPoint(point,transform){return{x:transform.offsetX+Number(point?.x||0)*transform.scale,y:transform.offsetY+Number(point?.y||0)*transform.scale};}
function validQuad(quad){return quad?.topLeft&&quad?.topRight&&quad?.bottomRight&&quad?.bottomLeft;}
export function overlayEligibleDetection(detection){return detection?.decoded!==false&&validQuad(detection?.quad);}

function installDetectionOverlay(){
  if(typeof document==='undefined'||typeof window==='undefined'||typeof globalThis.Worker!=='function')return;
  const stage=document.querySelector('#rxView .rx-stage'),video=document.getElementById('rxVideo');if(!stage||!video)return;
  stage.style.position='relative';const canvas=document.createElement('canvas');canvas.id='rxDetectionOverlay';canvas.setAttribute('aria-hidden','true');
  Object.assign(canvas.style,{position:'absolute',inset:'0',width:'100%',height:'100%',pointerEvents:'none',zIndex:'3',display:'block'});stage.appendChild(canvas);
  const tracks=[];let drawScheduled=false,lastDrawAt=-Infinity,timer=0;

  function centerOf(quad){const points=[quad.topLeft,quad.topRight,quad.bottomRight,quad.bottomLeft];return{x:points.reduce((s,p)=>s+Number(p.x||0),0)/4,y:points.reduce((s,p)=>s+Number(p.y||0),0)/4};}
  function mergeDetection(detection,now){
    if(!overlayEligibleDetection(detection))return;const center=centerOf(detection.quad),scaleHint=Math.max(12,Number(detection.w)||0,Number(detection.h)||0);let best=null,bestDistance=Infinity;
    for(const track of tracks){const tc=centerOf(track.quad),distance=Math.hypot(center.x-tc.x,center.y-tc.y);if(distance<bestDistance&&distance<=Math.max(scaleHint,track.scaleHint)*.45){best=track;bestDistance=distance;}}
    if(best){best.quad=detection.quad;best.scaleHint=scaleHint;best.updatedAt=now;return;}
    tracks.push({quad:detection.quad,scaleHint,updatedAt:now});if(tracks.length>12)tracks.splice(0,tracks.length-12);
  }
  function ingestDetections(detections){if(!Array.isArray(detections)||!detections.length)return;const now=performance.now();for(const detection of detections)if(overlayEligibleDetection(detection))mergeDetection(detection,now);scheduleDraw();}
  function resizeBacking(){const width=Math.max(1,stage.clientWidth),height=Math.max(1,stage.clientHeight),dpr=Math.max(1,Math.min(RX_OVERLAY_MAX_DPR,Number(window.devicePixelRatio)||1));const targetW=Math.round(width*dpr),targetH=Math.round(height*dpr);if(canvas.width!==targetW||canvas.height!==targetH){canvas.width=targetW;canvas.height=targetH;}return{width,height,dpr};}
  function draw(now){
    lastDrawAt=now;const metrics=resizeBacking(),ctx=canvas.getContext('2d');ctx.setTransform(metrics.dpr,0,0,metrics.dpr,0,0);ctx.clearRect(0,0,metrics.width,metrics.height);
    const vw=Number(video.videoWidth)||0,vh=Number(video.videoHeight)||0;if(!(vw>0&&vh>0))return;const transform=containVideoTransform(metrics.width,metrics.height,vw,vh);
    const alive=tracks.filter(track=>now-track.updatedAt<=RX_OVERLAY_TTL_MS);tracks.length=0;tracks.push(...alive);ctx.lineJoin='round';ctx.lineCap='round';ctx.lineWidth=2.25;ctx.strokeStyle='rgba(82,255,143,.95)';ctx.fillStyle='rgba(82,255,143,.045)';
    for(const track of alive){const q=track.quad,points=[q.topLeft,q.topRight,q.bottomRight,q.bottomLeft].map(point=>mapVideoPoint(point,transform));ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);for(let i=1;i<points.length;i++)ctx.lineTo(points[i].x,points[i].y);ctx.closePath();ctx.stroke();ctx.fill();}
  }
  function scheduleDraw(){if(drawScheduled)return;drawScheduled=true;requestAnimationFrame(now=>{drawScheduled=false;const wait=RX_OVERLAY_FRAME_MS-(now-lastDrawAt);if(wait>1){clearTimeout(timer);timer=setTimeout(scheduleDraw,wait);return;}draw(now);});}
  function clearOverlay(){tracks.length=0;clearTimeout(timer);canvas.getContext('2d')?.clearRect(0,0,canvas.width,canvas.height);}

  const NativeWorker=globalThis.Worker;
  try{globalThis.Worker=new Proxy(NativeWorker,{construct(Target,args){const worker=Reflect.construct(Target,args),url=String(args?.[0]??'');if(/(?:^|\/)qr-worker\.js(?:$|[?#])/.test(url))worker.addEventListener('message',event=>ingestDetections(event.data?.detections));return worker;}});}catch{}
  document.getElementById('resetRx')?.addEventListener('click',clearOverlay,{capture:true});document.getElementById('stopRx')?.addEventListener('click',clearOverlay,{capture:true});window.addEventListener('resize',scheduleDraw);window.addEventListener('orientationchange',scheduleDraw);
}

installDetectionOverlay();
