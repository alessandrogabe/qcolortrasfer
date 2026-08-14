// qcolortrasfer CHROMA RX bridge v3.0 (MIT).
//
// Redirects QR workers to the unified CHROMA wrapper. Multiple CHROMA MAIN
// matrices can be acquired in one full scan; each successful crop promotes its
// region to the direct color decoder path on subsequent frames.

const recentChroma=[];
const chromaRegions=new Set();
const metrics={attempts:0,hits:0,fast:0,corrected:0,margin:0,cal:0,align:0,decodeMs:0,resampled:0};

function ema(current,value,w=.15){return current?current*(1-w)+value*w:value;}
function reset(){
  recentChroma.length=0;chromaRegions.clear();
  Object.assign(metrics,{attempts:0,hits:0,fast:0,corrected:0,margin:0,cal:0,align:0,decodeMs:0,resampled:0});
  render();
}
function rememberDetection(d){
  if(!d||d.transport!=='chroma'||!(d.w>0)||!(d.h>0))return;
  recentChroma.push({...d,at:performance.now()});
  while(recentChroma.length>12)recentChroma.shift();
}
function prune(){
  const now=performance.now();
  for(let i=recentChroma.length-1;i>=0;i--)if(now-recentChroma[i].at>2200)recentChroma.splice(i,1);
}
function cropMatches(message,d){
  const x0=Number(message.originX)||0,y0=Number(message.originY)||0;
  const x1=x0+(Number(message.w)||0),y1=y0+(Number(message.h)||0);
  const cx=d.x+d.w/2,cy=d.y+d.h/2;
  return cx>=x0&&cx<=x1&&cy>=y0&&cy<=y1;
}
function render(){
  if(typeof document==='undefined')return;
  const anchor=document.getElementById('rxTrackedStats')||document.getElementById('rxStats');if(!anchor)return;
  let el=document.getElementById('rxChromaStats');
  if(!el){el=document.createElement('div');el.id='rxChromaStats';el.className='stats telemetry-line';anchor.after(el);}
  const pct=metrics.attempts?Math.round(metrics.hits*100/metrics.attempts):0;
  el.textContent=`CHROMA MAIN ${metrics.hits}/${metrics.attempts} (${pct}%) · fast ${metrics.fast} · Hamming corr ${metrics.corrected} · margin ${metrics.margin?metrics.margin.toFixed(3):'—'} · cal ${metrics.cal?metrics.cal.toFixed(2):'—'} · align ${metrics.align?metrics.align.toFixed(1):'—'} · resample ${metrics.resampled} · decode ${metrics.decodeMs?metrics.decodeMs.toFixed(1):'—'} ms`;
}
function observeResponse(data){
  if(!data)return;
  for(const d of Array.isArray(data.detections)?data.detections:[])rememberDetection(d);
  const count=Math.max(0,Number(data.chromaCount)||0);
  if(data.regionId!=null&&count>0)chromaRegions.add(data.regionId);
  const attempts=Math.max(0,Number(data.chromaAttempts)||(data.chromaAttempted?1:0));
  metrics.attempts+=attempts;
  if(count>0){
    metrics.hits+=count;metrics.fast+=Math.max(0,Number(data.chromaFastCount)||(data.chromaFast?count:0));
    metrics.corrected+=Number(data.chromaCorrected)||0;
    metrics.margin=ema(metrics.margin,Number(data.chromaMargin)||0);
    metrics.cal=ema(metrics.cal,Number(data.chromaCalibrationSeparation)||0);
    metrics.align=ema(metrics.align,Number(data.chromaAlignmentAnchors)||0);
    metrics.decodeMs=ema(metrics.decodeMs,Number(data.chromaDecodeMs)||0);
    metrics.resampled+=Number(data.chromaResampled)||0;
  }
  render();
}

function install(){
  if(typeof globalThis.Worker!=='function'||globalThis.__QCOLOR_CHROMA_WORKER_BRIDGE)return;
  const PriorWorker=globalThis.Worker;
  globalThis.Worker=new Proxy(PriorWorker,{
    construct(Target,args){
      const original=String(args?.[0]??'');
      const isQr=/(?:^|\/)qr-worker\.js(?:$|[?#])/.test(original)&&!/\/chroma\/qr-worker\.js(?:$|[?#])/.test(original);
      if(!isQr)return Reflect.construct(Target,args);
      const nextArgs=[new URL('./chroma/qr-worker.js',import.meta.url),args?.[1]??{type:'module'}];
      const worker=Reflect.construct(Target,nextArgs);
      worker.addEventListener('message',event=>observeResponse(event.data));
      const nativePost=worker.postMessage.bind(worker),nativeTerminate=worker.terminate.bind(worker);
      return new Proxy(worker,{
        get(target,prop){
          if(prop==='postMessage')return(message,transfer)=>{
            let outgoing=message;
            if(message?.mode==='crop'){
              prune();
              const known=message.regionId!=null&&chromaRegions.has(message.regionId);
              const nearby=!known&&recentChroma.some(d=>cropMatches(message,d));
              if(known||nearby)outgoing={...message,chromaHint:true};
            }
            return transfer===undefined?nativePost(outgoing):nativePost(outgoing,transfer);
          };
          if(prop==='terminate')return()=>nativeTerminate();
          const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;
        },
        set(target,prop,value){return Reflect.set(target,prop,value,target);}
      });
    }
  });
  globalThis.__QCOLOR_CHROMA_WORKER_BRIDGE=true;
}

install();
if(typeof document!=='undefined'){
  document.getElementById('startRx')?.addEventListener('click',reset,{capture:true});
  document.getElementById('resetRx')?.addEventListener('click',reset,{capture:true});
  window.addEventListener('load',render,{once:true});
}
