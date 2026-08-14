// qcolortrasfer OPTICAL MODEM detector v3.2 (MIT).
// Dedicated four-SYNC acquisition. No QR/ZXing dependency.

import { MODEM_GRID_W, MODEM_GRID_H, mapHomography, homographyFromPoints } from './optical-modem-codec.js';

const SOURCE = Object.freeze([
  Object.freeze({x:5.5,y:5.5}),
  Object.freeze({x:MODEM_GRID_W-5.5,y:5.5}),
  Object.freeze({x:MODEM_GRID_W-5.5,y:MODEM_GRID_H-5.5}),
  Object.freeze({x:5.5,y:MODEM_GRID_H-5.5}),
]);
const MAX_PER_QUADRANT=5;

function lumaAt(image,x,y){
  const xx=Math.round(x),yy=Math.round(y);if(xx<0||yy<0||xx>=image.width||yy>=image.height)return null;const o=(yy*image.width+xx)*4;return(77*image.data[o]+150*image.data[o+1]+29*image.data[o+2])/256;
}
function syncBit(i){let x=(Math.imul((i+1)>>>0,0x9e3779b1)^0xa6d3f05c)>>>0;x^=x>>>16;x=Math.imul(x,0x7feb352d)>>>0;x^=x>>>15;return(x>>>1)&1;}
function ringScore(image,cx,cy,r){
  if(!(r>=3))return-1e9;let dark=0,light=0,dn=0,ln=0;
  const add=(radius,isDark)=>{for(let k=0;k<12;k++){const a=k*Math.PI/6,v=lumaAt(image,cx+Math.cos(a)*radius,cy+Math.sin(a)*radius);if(v==null)continue;if(isDark){dark+=v;dn++;}else{light+=v;ln++;}}};
  const center=lumaAt(image,cx,cy);if(center!=null){dark+=center*6;dn+=6;}add(r*.82,true);add(r*.46,false);add(r*1.20,false);
  if(dn<12||ln<12)return-1e9;return light/ln-dark/dn;
}
function refine(image,seed,step){
  let best={...seed};const d=Math.max(2,Math.floor(step*.8)),baseR=seed.r;
  for(let dy=-d;dy<=d;dy++)for(let dx=-d;dx<=d;dx++)for(const dr of [-2,-1,0,1,2]){
    const r=Math.max(3,baseR+dr),score=ringScore(image,seed.x+dx,seed.y+dy,r),rank=score+2.8*r;if(rank>best.rank)best={x:seed.x+dx,y:seed.y+dy,r,score,rank};
  }
  return best.score>=45?best:null;
}
function insertTop(list,candidate,limit=24){
  list.push(candidate);list.sort((a,b)=>b.rank-a.rank);if(list.length>limit)list.length=limit;
}
function candidatesForQuadrant(image,q){
  const w=image.width,h=image.height,min=Math.min(w,h),step=Math.max(6,Math.floor(min/110));
  const bounds=q===0?[.015,.52,.015,.52]:q===1?[.48,.985,.015,.52]:q===2?[.48,.985,.48,.985]:[.015,.52,.48,.985];
  const radii=[.014,.019,.024,.030,.037,.045,.054].map(v=>Math.max(3,min*v)),coarse=[];
  for(let y=Math.floor(h*bounds[2]);y<h*bounds[3];y+=step)for(let x=Math.floor(w*bounds[0]);x<w*bounds[1];x+=step)for(const r of radii){
    const score=ringScore(image,x,y,r);if(score<42)continue;insertTop(coarse,{x,y,r,score,rank:score+2.8*r});
  }
  const refined=[];
  for(const seed of coarse){const c=refine(image,seed,step);if(!c)continue;if(refined.some(e=>Math.hypot(e.x-c.x,e.y-c.y)<Math.max(5,Math.min(e.r,c.r)*.7)))continue;refined.push(c);if(refined.length>=MAX_PER_QUADRANT)break;}
  return refined;
}
function rotateSource(rotation){const out=[];for(let i=0;i<4;i++)out.push(SOURCE[(i-rotation+4)%4]);return out;}
function geometryPlausible(points){
  const edge=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),top=edge(points[0],points[1]),right=edge(points[1],points[2]),bottom=edge(points[2],points[3]),left=edge(points[3],points[0]);
  if(Math.min(top,right,bottom,left)<30)return false;const width=(top+bottom)/2,height=(left+right)/2,ratio=Math.max(width,height)/Math.max(1,Math.min(width,height));if(ratio<1.25||ratio>2.8)return false;
  const radii=points.map(p=>p.r),rRatio=Math.max(...radii)/Math.max(1,Math.min(...radii));return rRatio<=2.1;
}
function syncScore(image,h){
  let dark=0,light=0,dn=0,ln=0;const samples=[];
  for(const y of [8,9])for(let x=64;x<128;x++){
    const p=mapHomography(h,x+.5,y+.5);if(!p)continue;const lum=lumaAt(image,p.x,p.y);if(lum==null)continue;const bit=syncBit(x-64);samples.push([lum,bit]);if(bit){dark+=lum;dn++;}else{light+=lum;ln++;}
  }
  if(dn<30||ln<30)return null;const darkMean=dark/dn,lightMean=light/ln,separation=lightMean-darkMean;if(separation<25)return null;const threshold=(darkMean+lightMean)/2;let correct=0;for(const[l,bit]of samples)if((l<threshold?1:0)===bit)correct++;
  return{accuracy:correct/samples.length,separation,score:correct/samples.length*100+Math.min(25,separation/5)};
}

export function detectOuterModemMarkers(image){
  if(!image?.data||!(image.width>0)||!(image.height>0))return null;const sets=[];for(let q=0;q<4;q++){const c=candidatesForQuadrant(image,q);if(!c.length)return null;sets.push(c);}
  let best=null;
  for(const a of sets[0])for(const b of sets[1])for(const c of sets[2])for(const d of sets[3]){
    const points=[a,b,c,d];if(!geometryPlausible(points))continue;
    for(let rotation=0;rotation<4;rotation++){
      const h=homographyFromPoints(rotateSource(rotation),points);if(!h)continue;const sync=syncScore(image,h);if(!sync||sync.accuracy<.74)continue;const ring=(a.score+b.score+c.score+d.score)/4,rank=sync.score+Math.min(10,Math.max(0,ring-45)*.05);
      if(!best||rank>best.rank)best={markers:points.map(p=>({...p})),rotation,anchorSet:'outer',syncAccuracy:sync.accuracy,syncSeparation:sync.separation,rank};
    }
  }
  return best;
}

export function refineOuterModemMarkers(image,tracked){
  if(!tracked?.markers?.length||tracked.markers.length!==4)return null;const markers=[];
  for(const marker of tracked.markers){const c=refine(image,{...marker,rank:Number(marker.score||0)+2.8*Number(marker.r||4)},4);if(!c)return null;markers.push(c);}
  const h=homographyFromPoints(rotateSource(Number(tracked.rotation)||0),markers);if(!h)return null;const sync=syncScore(image,h);if(!sync||sync.accuracy<.70)return null;
  return{markers,rotation:Number(tracked.rotation)||0,anchorSet:'outer',syncAccuracy:sync.accuracy,syncSeparation:sync.separation};
}
