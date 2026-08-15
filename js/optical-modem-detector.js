// qcolortrasfer OPTICAL MODEM detector v3.2.1 (MIT).
// Dedicated four-SYNC acquisition. No QR/ZXing dependency.
//
// v3.2.1 replaces the original full-resolution radius sweep with a two-stage
// detector: a cheap downsampled square-fiducial search followed by a small
// full-resolution refinement and a long known-SYNC verification. This keeps
// acquisition practical on phones while preserving the independent modem.

import { MODEM_GRID_W, MODEM_GRID_H, mapHomography, homographyFromPoints } from './optical-modem-codec.js';

const SOURCE = Object.freeze([
  Object.freeze({x:5.5,y:5.5}),
  Object.freeze({x:MODEM_GRID_W-5.5,y:5.5}),
  Object.freeze({x:MODEM_GRID_W-5.5,y:MODEM_GRID_H-5.5}),
  Object.freeze({x:5.5,y:MODEM_GRID_H-5.5}),
]);
const MAX_PER_QUADRANT=4;
const TARGET_PLANE_MIN=240;

function lumaAt(image,x,y){
  const xx=Math.round(x),yy=Math.round(y);if(xx<0||yy<0||xx>=image.width||yy>=image.height)return null;const o=(yy*image.width+xx)*4;return(77*image.data[o]+150*image.data[o+1]+29*image.data[o+2])/256;
}
function syncBit(i){let x=(Math.imul((i+1)>>>0,0x9e3779b1)^0xa6d3f05c)>>>0;x^=x>>>16;x=Math.imul(x,0x7feb352d)>>>0;x^=x>>>15;return(x>>>1)&1;}

function makeLumaPlane(image){
  const factor=Math.max(1,Math.round(Math.min(image.width,image.height)/TARGET_PLANE_MIN));
  const width=Math.ceil(image.width/factor),height=Math.ceil(image.height/factor),data=new Uint8Array(width*height);
  const half=Math.max(0,Math.floor(factor/4));
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const cx=Math.min(image.width-1,Math.floor((x+.5)*factor)),cy=Math.min(image.height-1,Math.floor((y+.5)*factor));
    let sum=0,n=0;
    for(const [dx,dy] of [[0,0],[-half,0],[half,0],[0,-half],[0,half]]){
      const xx=Math.max(0,Math.min(image.width-1,cx+dx)),yy=Math.max(0,Math.min(image.height-1,cy+dy)),o=(yy*image.width+xx)*4;
      sum+=(77*image.data[o]+150*image.data[o+1]+29*image.data[o+2])/256;n++;
    }
    data[y*width+x]=Math.max(0,Math.min(255,Math.round(sum/n)));
  }
  return{width,height,data,factor};
}
function planeAt(p,x,y){const xx=Math.round(x),yy=Math.round(y);return xx<0||yy<0||xx>=p.width||yy>=p.height?null:p.data[yy*p.width+xx];}

// The 11x11 fiducial is a square 2/2/3/2/2 dark/light run. Sampling with
// Chebyshev-like square points is substantially more tolerant than the old
// circular ring score, especially under perspective and camera blur.
function squareScore(sample,cx,cy,r){
  if(!(r>=2.5))return-1e9;let dark=0,light=0,dn=0,ln=0;
  const add=(dx,dy,isDark)=>{const v=sample(cx+dx*r,cy+dy*r);if(v==null)return;if(isDark){dark+=v;dn++;}else{light+=v;ln++;}};
  add(0,0,true);
  for(const [x,y] of [[.82,0],[-.82,0],[0,.82],[0,-.82],[.82,.38],[.82,-.38],[-.82,.38],[-.82,-.38],[.38,.82],[-.38,.82],[.38,-.82],[-.38,-.82]])add(x,y,true);
  for(const [x,y] of [[.45,0],[-.45,0],[0,.45],[0,-.45],[.40,.40],[-.40,.40],[.40,-.40],[-.40,-.40],[1.16,0],[-1.16,0],[0,1.16],[0,-1.16]])add(x,y,false);
  if(dn<10||ln<9)return-1e9;const dm=dark/dn,lm=light/ln;return lm-dm;
}
function fullSquareScore(image,cx,cy,r){return squareScore((x,y)=>lumaAt(image,x,y),cx,cy,r);}

function insertTop(list,candidate,limit=16){list.push(candidate);list.sort((a,b)=>b.rank-a.rank);if(list.length>limit)list.length=limit;}
function coarseCandidates(plane,q){
  const w=plane.width,h=plane.height,min=Math.min(w,h),step=Math.max(2,Math.floor(min/120));
  const bounds=q===0?[.01,.53,.01,.53]:q===1?[.47,.99,.01,.53]:q===2?[.47,.99,.47,.99]:[.01,.53,.47,.99];
  const radii=[.015,.020,.026,.033,.041,.050].map(v=>Math.max(3,min*v)),out=[];
  const sample=(x,y)=>planeAt(plane,x,y);
  for(let y=Math.floor(h*bounds[2]);y<h*bounds[3];y+=step)for(let x=Math.floor(w*bounds[0]);x<w*bounds[1];x+=step){
    const center=sample(x,y);if(center==null||center>135)continue;
    for(const r of radii){const score=squareScore(sample,x,y,r);if(score<38)continue;insertTop(out,{x,y,r,score,rank:score+3.4*r});}
  }
  return out;
}
function refine(image,seed,factor){
  const baseX=(seed.x+.5)*factor,baseY=(seed.y+.5)*factor,baseR=seed.r*factor,d=Math.max(3,factor+1);let best=null;
  for(let dy=-d;dy<=d;dy+=2)for(let dx=-d;dx<=d;dx+=2)for(const dr of [-factor,-Math.max(1,factor/2),0,Math.max(1,factor/2),factor]){
    const r=Math.max(4,baseR+dr),score=fullSquareScore(image,baseX+dx,baseY+dy,r),rank=score+.11*r;if(!best||rank>best.rank)best={x:baseX+dx,y:baseY+dy,r,score,rank};
  }
  return best&&best.score>=42?best:null;
}
function candidatesForQuadrant(image,plane,q){
  const refined=[];
  for(const seed of coarseCandidates(plane,q)){
    const c=refine(image,seed,plane.factor);if(!c)continue;if(refined.some(e=>Math.hypot(e.x-c.x,e.y-c.y)<Math.max(7,Math.min(e.r,c.r)*.65)))continue;
    refined.push(c);if(refined.length>=MAX_PER_QUADRANT)break;
  }
  return refined;
}
function rotateSource(rotation){const out=[];for(let i=0;i<4;i++)out.push(SOURCE[(i-rotation+4)%4]);return out;}
function geometryPlausible(points){
  const edge=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),top=edge(points[0],points[1]),right=edge(points[1],points[2]),bottom=edge(points[2],points[3]),left=edge(points[3],points[0]);
  if(Math.min(top,right,bottom,left)<30)return false;const width=(top+bottom)/2,height=(left+right)/2,ratio=Math.max(width,height)/Math.max(1,Math.min(width,height));if(ratio<1.25||ratio>2.8)return false;
  const radii=points.map(p=>p.r),rRatio=Math.max(...radii)/Math.max(1,Math.min(...radii));return rRatio<=2.0;
}
function averagedLuma(image,h,x,y){
  let sum=0,n=0;for(const [dx,dy] of [[0,0],[-.16,0],[.16,0],[0,-.14],[0,.14]]){const p=mapHomography(h,x+.5+dx,y+.5+dy);if(!p)continue;const l=lumaAt(image,p.x,p.y);if(l==null)continue;sum+=l;n++;}return n?sum/n:null;
}
function syncScore(image,h){
  let dark=0,light=0,dn=0,ln=0;const samples=[];
  for(const y of [8,9])for(let x=64;x<128;x++){
    const lum=averagedLuma(image,h,x,y);if(lum==null)continue;const bit=syncBit(x-64);samples.push([lum,bit]);if(bit){dark+=lum;dn++;}else{light+=lum;ln++;}
  }
  if(dn<30||ln<30)return null;const darkMean=dark/dn,lightMean=light/ln,separation=lightMean-darkMean;if(separation<18)return null;const threshold=(darkMean+lightMean)/2;let correct=0;for(const[l,bit]of samples)if((l<threshold?1:0)===bit)correct++;
  return{accuracy:correct/samples.length,separation,score:correct/samples.length*100+Math.min(25,separation/5)};
}

export function detectOuterModemMarkers(image){
  if(!image?.data||!(image.width>0)||!(image.height>0))return null;const started=globalThis.performance?.now?.()??Date.now(),plane=makeLumaPlane(image),sets=[];
  for(let q=0;q<4;q++){const c=candidatesForQuadrant(image,plane,q);if(!c.length)return null;sets.push(c);}
  let best=null;
  for(const a of sets[0])for(const b of sets[1])for(const c of sets[2])for(const d of sets[3]){
    const points=[a,b,c,d];if(!geometryPlausible(points))continue;
    for(let rotation=0;rotation<4;rotation++){
      const h=homographyFromPoints(rotateSource(rotation),points);if(!h)continue;const sync=syncScore(image,h);if(!sync||sync.accuracy<.66)continue;const finder=(a.score+b.score+c.score+d.score)/4,rank=sync.score+Math.min(10,Math.max(0,finder-42)*.05);
      if(!best||rank>best.rank)best={markers:points.map(p=>({...p})),rotation,anchorSet:'outer',syncAccuracy:sync.accuracy,syncSeparation:sync.separation,finderScore:finder,rank};
    }
  }
  if(best)best.detectorMs=(globalThis.performance?.now?.()??Date.now())-started;
  return best;
}

export function refineOuterModemMarkers(image,tracked){
  if(!tracked?.markers?.length||tracked.markers.length!==4)return null;const markers=[];
  for(const marker of tracked.markers){
    let best=null;for(let dy=-4;dy<=4;dy+=2)for(let dx=-4;dx<=4;dx+=2)for(const dr of [-2,0,2]){const r=Math.max(4,Number(marker.r||8)+dr),score=fullSquareScore(image,marker.x+dx,marker.y+dy,r);if(!best||score>best.score)best={x:marker.x+dx,y:marker.y+dy,r,score,rank:score};}
    if(!best||best.score<38)return null;markers.push(best);
  }
  const h=homographyFromPoints(rotateSource(Number(tracked.rotation)||0),markers);if(!h)return null;const sync=syncScore(image,h);if(!sync||sync.accuracy<.64)return null;
  return{markers,rotation:Number(tracked.rotation)||0,anchorSet:'outer',syncAccuracy:sync.accuracy,syncSeparation:sync.separation,finderScore:markers.reduce((s,m)=>s+m.score,0)/4};
}
