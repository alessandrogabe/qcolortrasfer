// qcolortrasfer OPTICAL MODEM real-camera color decoder v3.2.2 (MIT).
//
// The original v3.2 decoder was validated on integer-scaled synthetic rasters.
// Real cameras project a 192x108 field at fractional pixel coordinates, so
// nearest-neighbour Math.round() sampling can jump into adjacent cells. This
// decoder uses bilinear sub-pixel RGB sampling, the four internal B/W pilots to
// estimate local geometric residuals, timing-line phase refinement, and a
// sparse self-calibration pass across the payload before Hamming/CRC.

import { decodeOpticalPacket } from './protocol.js';
import {
  MODEM_GRID_W, MODEM_GRID_H, MODEM_PAYLOAD_CELLS, MODEM_CHUNK_BYTES,
  homographyFromPoints, mapHomography, modemPayloadPositions, modemStatesToPacket
} from './optical-modem-codec.js';

const SOURCE=Object.freeze([
  Object.freeze({x:5.5,y:5.5}),Object.freeze({x:MODEM_GRID_W-5.5,y:5.5}),
  Object.freeze({x:MODEM_GRID_W-5.5,y:MODEM_GRID_H-5.5}),Object.freeze({x:5.5,y:MODEM_GRID_H-5.5}),
]);
const PILOTS=Object.freeze([[64,36],[128,36],[64,72],[128,72]]);
const CAL=Object.freeze([
  Object.freeze({x:25,y:2,state:0}),Object.freeze({x:32,y:2,state:1}),
  Object.freeze({x:39,y:2,state:2}),Object.freeze({x:46,y:2,state:3}),
]);
const PAYLOAD=Object.freeze(modemPayloadPositions());
const SAMPLE_OFFSETS=Object.freeze([[.5,.5],[.34,.5],[.66,.5],[.5,.34],[.5,.66]]);
const PHASE_STEPS=Object.freeze([-.28,-.18,-.09,0,.09,.18,.28]);
const REGION_COLS=3,REGION_ROWS=2;

function rotateSource(rotation){const out=[];for(let i=0;i<4;i++)out.push(SOURCE[(i-(rotation||0)+4)%4]);return out;}
function buildHomography(tracked){return homographyFromPoints(rotateSource(Number(tracked?.rotation)||0),tracked.markers);}

function rgbBilinear(image,x,y,out){
  if(!(x>=0&&y>=0&&x<image.width-1&&y<image.height-1))return false;
  const x0=Math.floor(x),y0=Math.floor(y),x1=x0+1,y1=y0+1,tx=x-x0,ty=y-y0,d=image.data,w=image.width;
  const o00=(y0*w+x0)*4,o10=(y0*w+x1)*4,o01=(y1*w+x0)*4,o11=(y1*w+x1)*4;
  for(let c=0;c<3;c++){const a=d[o00+c]*(1-tx)+d[o10+c]*tx,b=d[o01+c]*(1-tx)+d[o11+c]*tx;out[c]=a*(1-ty)+b*ty;}return true;
}
function lumaBilinear(image,x,y){const rgb=[0,0,0];return rgbBilinear(image,x,y,rgb)?(77*rgb[0]+150*rgb[1]+29*rgb[2])/256:null;}
function feature(rgb,out){const r=rgb[0],g=rgb[1],b=rgb[2],sum=Math.max(32,r+g+b);out[0]=r/sum;out[1]=g/sum;out[2]=b/sum;out[3]=(77*r+150*g+29*b)/(256*255);return out;}
function distance(f,centroids,state){const o=state*4,dr=f[0]-centroids[o],dg=f[1]-centroids[o+1],db=f[2]-centroids[o+2],dl=f[3]-centroids[o+3];return 2.7*(dr*dr+dg*dg+db*db)+.18*dl*dl;}
function classify(f,centroids){let best=0,bestD=Infinity,secondD=Infinity,second=0;for(let s=0;s<4;s++){const d=distance(f,centroids,s);if(d<bestD){secondD=bestD;second=best;bestD=d;best=s;}else if(d<secondD){secondD=d;second=s;}}return{state:best,second,bestD,secondD,margin:Math.max(0,secondD-bestD)};}

function correctionAt(mx,my,anchors,out){
  if(!anchors?.length){out[0]=0;out[1]=0;return out;}let sumW=.55,sumX=0,sumY=0;
  for(const a of anchors){const dx=mx-a.mx,dy=my-a.my,w=1/(1+(dx*dx+dy*dy)/700);sumW+=w;sumX+=a.dx*w;sumY+=a.dy*w;}
  out[0]=sumX/sumW;out[1]=sumY/sumW;return out;
}
function projected(image,h,mx,my,anchors,corr){const p=mapHomography(h,mx,my);if(!p)return null;correctionAt(mx,my,anchors,corr);return{x:p.x+corr[0],y:p.y+corr[1]};}

function pilotExpected(dx,dy){const d=Math.max(Math.abs(dx),Math.abs(dy));return d===2||d===0;}
function pilotScore(image,h,cx,cy,shiftX,shiftY){
  const values=[];let dark=0,light=0,dn=0,ln=0;
  for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
    const p=mapHomography(h,cx+dx+.5,cy+dy+.5);if(!p)continue;const l=lumaBilinear(image,p.x+shiftX,p.y+shiftY);if(l==null)continue;const expected=pilotExpected(dx,dy);values.push([l,expected]);if(expected){dark+=l;dn++;}else{light+=l;ln++;}
  }
  if(dn<10||ln<8)return null;const dm=dark/dn,lm=light/ln,sep=lm-dm;if(sep<12)return null;const t=(dm+lm)/2;let correct=0;for(const[v,darkExpected]of values)if((v<t)===darkExpected)correct++;return{accuracy:correct/values.length,separation:sep,score:correct/values.length*100+Math.min(20,sep/5)};
}
function findPilotResiduals(image,h){
  const anchors=[];
  for(const [cx,cy] of PILOTS){let best=null;for(let sy=-4;sy<=4;sy++)for(let sx=-4;sx<=4;sx++){const s=pilotScore(image,h,cx,cy,sx,sy);if(s&&(!best||s.score>best.score))best={...s,dx:sx,dy:sy};}
    if(best&&best.accuracy>=.76)anchors.push({mx:cx+.5,my:cy+.5,dx:best.dx,dy:best.dy,accuracy:best.accuracy,separation:best.separation});
  }
  return anchors;
}

function timingExpected(axis,index,far){const odd=((index-15)&1)!==0;return far?odd:!odd;}
function phaseScore(image,h,anchors,px,py){
  let dark=0,light=0,dn=0,ln=0;const samples=[],corr=[0,0];
  const add=(mx,my,darkExpected)=>{const p=projected(image,h,mx+px,my+py,anchors,corr);if(!p)return;const l=lumaBilinear(image,p.x,p.y);if(l==null)return;samples.push([l,darkExpected]);if(darkExpected){dark+=l;dn++;}else{light+=l;ln++;}};
  for(let x=15;x<MODEM_GRID_W-15;x+=3){add(x+.5,13.5,timingExpected('x',x,false));add(x+.5,MODEM_GRID_H-13.5,timingExpected('x',x,true));}
  for(let y=15;y<MODEM_GRID_H-15;y+=3){add(13.5,y+.5,timingExpected('y',y,false));add(MODEM_GRID_W-13.5,y+.5,timingExpected('y',y,true));}
  if(dn<25||ln<25)return null;const dm=dark/dn,lm=light/ln,sep=lm-dm;if(sep<10)return null,t=(dm+lm)/2;let correct=0;for(const[v,d]of samples)if((v<t)===d)correct++;return{accuracy:correct/samples.length,separation:sep,score:correct/samples.length*100+Math.min(18,sep/7)};
}
function findPhase(image,h,anchors){let best={x:0,y:0,accuracy:0,separation:0,score:-1};for(const y of PHASE_STEPS)for(const x of PHASE_STEPS){const s=phaseScore(image,h,anchors,x,y);if(s&&s.score>best.score)best={x,y,...s};}return best;}

function sampleCell(image,h,x,y,phase,anchors,multi,rgb,corr){
  const offsets=multi?SAMPLE_OFFSETS:[[.5,.5]];let r=0,g=0,b=0,n=0,tmp=[0,0,0];
  for(const [ox,oy] of offsets){const p=projected(image,h,x+ox+phase.x,y+oy+phase.y,anchors,corr);if(!p||!rgbBilinear(image,p.x,p.y,tmp))continue;r+=tmp[0];g+=tmp[1];b+=tmp[2];n++;}
  if(!n)return false;rgb[0]=r/n;rgb[1]=g/n;rgb[2]=b/n;return true;
}
function minCentroidSeparation(centroids){let min=Infinity;for(let a=0;a<4;a++)for(let b=a+1;b<4;b++){const f=[centroids[a*4],centroids[a*4+1],centroids[a*4+2],centroids[a*4+3]];min=Math.min(min,Math.sqrt(distance(f,centroids,b)));}return min;}
function calibrateSeeds(image,h,phase,anchors){
  const sums=new Float64Array(16),counts=new Uint16Array(4),rgb=[0,0,0],f=[0,0,0,0],corr=[0,0];
  for(const patch of CAL)for(let yy=0;yy<4;yy++)for(let xx=0;xx<5;xx++){if(!sampleCell(image,h,patch.x+xx,patch.y+yy,phase,anchors,true,rgb,corr))continue;feature(rgb,f);const o=patch.state*4;for(let k=0;k<4;k++)sums[o+k]+=f[k];counts[patch.state]++;}
  for(let s=0;s<4;s++)if(counts[s]<10)return null;const centroids=new Float64Array(16);for(let s=0;s<4;s++){const o=s*4;for(let k=0;k<4;k++)centroids[o+k]=sums[o+k]/counts[s];}
  const separation=minCentroidSeparation(centroids);return separation>=.055?{centroids,separation}:null;
}
function regionIndex(x,y){return Math.min(REGION_COLS-1,Math.floor(x*REGION_COLS/MODEM_GRID_W))+REGION_COLS*Math.min(REGION_ROWS-1,Math.floor(y*REGION_ROWS/MODEM_GRID_H));}
function buildRegionalCentroids(image,h,phase,anchors,seeds){
  const regions=REGION_COLS*REGION_ROWS,sums=new Float64Array(regions*16),counts=new Uint16Array(regions*4),rgb=[0,0,0],f=[0,0,0,0],corr=[0,0];
  // Seed every region with a small prior from the known calibration patches.
  for(let r=0;r<regions;r++)for(let s=0;s<4;s++){const ro=r*16+s*4,so=s*4;for(let k=0;k<4;k++)sums[ro+k]=seeds.centroids[so+k]*6;counts[r*4+s]=6;}
  for(let i=0;i<PAYLOAD.length;i+=31){const p=PAYLOAD[i];if(!sampleCell(image,h,p.x,p.y,phase,anchors,false,rgb,corr))continue;feature(rgb,f);const c=classify(f,seeds.centroids);if(c.margin<.0007)continue;const r=regionIndex(p.x,p.y),o=r*16+c.state*4;for(let k=0;k<4;k++)sums[o+k]+=f[k];counts[r*4+c.state]++;}
  const out=[];for(let r=0;r<regions;r++){const c=new Float64Array(16);for(let s=0;s<4;s++){const o=s*4,ro=r*16+o,n=Math.max(1,counts[r*4+s]);for(let k=0;k<4;k++)c[o+k]=sums[ro+k]/n;}out.push(c);}return out;
}

function decodeControlKnown(image,h,phase,anchors){
  const known=[0x4f,0x4d,1,4],corr=[0,0],samples=[];let dark=0,light=0,dn=0,ln=0;
  for(let i=0;i<32;i++){const expected=((known[i>>3]>>(7-(i&7)))&1)!==0;for(let copy=0;copy<2;copy++){const p=projected(image,h,32+i+.5+phase.x,100+copy+.5+phase.y,anchors,corr);if(!p)continue;const l=lumaBilinear(image,p.x,p.y);if(l==null)continue;samples.push([l,expected]);if(expected){dark+=l;dn++;}else{light+=l;ln++;}}}
  if(dn<16||ln<16)return null;const dm=dark/dn,lm=light/ln,t=(dm+lm)/2;let correct=0;for(const[v,e]of samples)if((v<t)===e)correct++;return{accuracy:correct/samples.length,separation:lm-dm};
}

export async function decodeOpticalModemColor(image,tracked){
  const started=globalThis.performance?.now?.()??Date.now();if(!image?.data||!tracked?.markers?.length)return{ok:false,stage:'geometry'};const h=buildHomography(tracked);if(!h)return{ok:false,stage:'geometry'};
  const pilotAnchors=findPilotResiduals(image,h),phase=findPhase(image,h,pilotAnchors),control=decodeControlKnown(image,h,phase,pilotAnchors);
  const calibration=calibrateSeeds(image,h,phase,pilotAnchors);if(!calibration)return{ok:false,stage:'calibration',pilotAnchors:pilotAnchors.length,phaseAccuracy:phase.accuracy,controlAccuracy:control?.accuracy||0,decodeMs:(globalThis.performance?.now?.()??Date.now())-started};
  const regions=buildRegionalCentroids(image,h,phase,pilotAnchors,calibration),states=new Uint8Array(MODEM_PAYLOAD_CELLS),rgb=[0,0,0],f=[0,0,0,0],corr=[0,0];let marginSum=0,resampled=0;
  for(let i=0;i<PAYLOAD.length;i++){const p=PAYLOAD[i];if(!sampleCell(image,h,p.x,p.y,phase,pilotAnchors,false,rgb,corr))return{ok:false,stage:'sampling',pilotAnchors:pilotAnchors.length,phaseAccuracy:phase.accuracy,calibrationSeparation:calibration.separation};feature(rgb,f);const centroids=regions[regionIndex(p.x,p.y)];let c=classify(f,centroids);if(c.margin<.0012&&sampleCell(image,h,p.x,p.y,phase,pilotAnchors,true,rgb,corr)){feature(rgb,f);c=classify(f,centroids);resampled++;}states[i]=c.state;marginSum+=c.margin;}
  let fec,packet;try{fec=modemStatesToPacket(states);packet=decodeOpticalPacket(fec.bytes);}catch(error){return{ok:false,stage:'fec/crc',pilotAnchors:pilotAnchors.length,phaseAccuracy:phase.accuracy,phaseSeparation:phase.separation,controlAccuracy:control?.accuracy||0,calibrationSeparation:calibration.separation,margin:marginSum/PAYLOAD.length,resampled,corrected:Number(fec?.corrected)||0,error:error?.message||String(error),decodeMs:(globalThis.performance?.now?.()??Date.now())-started};}
  if(packet.protocolVersion!==2||packet.chunkSize!==MODEM_CHUNK_BYTES||packet.visualStates!==4)return{ok:false,stage:'protocol',pilotAnchors:pilotAnchors.length,calibrationSeparation:calibration.separation};
  return{ok:true,stage:'decoded',packet,bytes:fec.bytes,corrected:fec.corrected,markers:tracked.markers.map(m=>({...m})),rotation:Number(tracked.rotation)||0,anchorSet:tracked.anchorSet||'outer',calibrationSeparation:calibration.separation,margin:marginSum/PAYLOAD.length,resampled,pilotAnchors:pilotAnchors.length,phaseAccuracy:phase.accuracy,phaseSeparation:phase.separation,controlAccuracy:control?.accuracy||0,decodeMs:(globalThis.performance?.now?.()??Date.now())-started};
}
