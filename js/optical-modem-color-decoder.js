// qcolortrasfer OPTICAL MODEM real-camera color decoder v3.2.2 (MIT).
//
// Real cameras project the 192x108 field at fractional sensor coordinates.
// The production path therefore uses bilinear sub-pixel RGB sampling. A stable
// four-SYNC homography + zero-biased timing phase + known color calibration is
// always tried first. Internal pilot residuals and regional color adaptation
// are fallbacks only: they must never perturb an already-good projective lock.

import { decodeOpticalPacket } from './protocol.js';
import {
  MODEM_GRID_W, MODEM_GRID_H, MODEM_PAYLOAD_CELLS, MODEM_CHUNK_BYTES,
  homographyFromPoints, mapHomography, modemPayloadPositions, modemStatesToPacket
} from './optical-modem-codec.js';
import { repairModemPacketWithCrc } from './optical-modem-crc-repair.js';

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
const MULTI=Object.freeze([[.5,.5],[.34,.5],[.66,.5],[.5,.34],[.5,.66]]);
const PHASE_STEPS=Object.freeze([0,-.09,.09,-.18,.18,-.28,.28]);
const PILOT_SHIFTS=Object.freeze([0,-.5,.5,-1,1,-2,2,-3,3]);
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
function distance(f,c,state){const o=state*4,dr=f[0]-c[o],dg=f[1]-c[o+1],db=f[2]-c[o+2],dl=f[3]-c[o+3];return 2.7*(dr*dr+dg*dg+db*db)+.18*dl*dl;}
function classify(f,c){let best=0,bestD=Infinity,secondD=Infinity;for(let s=0;s<4;s++){const d=distance(f,c,s);if(d<bestD){secondD=bestD;bestD=d;best=s;}else if(d<secondD)secondD=d;}return{state:best,margin:Math.max(0,secondD-bestD)};}

function correctionAt(mx,my,anchors,out){
  if(!anchors?.length){out[0]=0;out[1]=0;return out;}let sw=.65,sx=0,sy=0;
  for(const a of anchors){const dx=mx-a.mx,dy=my-a.my,w=1/(1+(dx*dx+dy*dy)/700);sw+=w;sx+=a.dx*w;sy+=a.dy*w;}out[0]=sx/sw;out[1]=sy/sw;return out;
}
function projected(h,mx,my,anchors,corr){const p=mapHomography(h,mx,my);if(!p)return null;correctionAt(mx,my,anchors,corr);return{x:p.x+corr[0],y:p.y+corr[1]};}

function sampleCell(image,h,x,y,phase,anchors,multi,rgb,corr){
  const offsets=multi?MULTI:[[.5,.5]];let r=0,g=0,b=0,n=0,tmp=[0,0,0];
  for(const[ox,oy]of offsets){const p=projected(h,x+ox+phase.x,y+oy+phase.y,anchors,corr);if(!p||!rgbBilinear(image,p.x,p.y,tmp))continue;r+=tmp[0];g+=tmp[1];b+=tmp[2];n++;}
  if(!n)return false;rgb[0]=r/n;rgb[1]=g/n;rgb[2]=b/n;return true;
}

function pilotExpected(dx,dy){const d=Math.max(Math.abs(dx),Math.abs(dy));return d===2||d===0;}
function pilotScore(image,h,cx,cy,sx,sy){
  let dark=0,light=0,dn=0,ln=0,correct=0,total=0;const values=[];
  for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
    const p=mapHomography(h,cx+dx+.5,cy+dy+.5);if(!p)continue;const l=lumaBilinear(image,p.x+sx,p.y+sy);if(l==null)continue;const d=pilotExpected(dx,dy);values.push([l,d]);if(d){dark+=l;dn++;}else{light+=l;ln++;}
  }
  if(dn<10||ln<8)return null;const dm=dark/dn,lm=light/ln,sep=lm-dm;if(sep<12)return null;const t=(dm+lm)/2;for(const[v,d]of values){if((v<t)===d)correct++;total++;}return{accuracy:correct/total,separation:sep,score:correct/total*100+Math.min(20,sep/5)};
}
function findPilotResiduals(image,h){
  const anchors=[];
  for(const[cx,cy]of PILOTS){
    const zero=pilotScore(image,h,cx,cy,0,0);let best=zero?{...zero,dx:0,dy:0,rank:zero.score}:null;
    for(const sy of PILOT_SHIFTS)for(const sx of PILOT_SHIFTS){if(sx===0&&sy===0)continue;const s=pilotScore(image,h,cx,cy,sx,sy);if(!s)continue;const rank=s.score-.12*Math.hypot(sx,sy);if(!best||rank>best.rank)best={...s,dx:sx,dy:sy,rank};}
    if(!best||best.accuracy<.76)continue;
    const improves=!zero||best.score>zero.score+2.0||best.accuracy>zero.accuracy+.04;
    if(improves&&Math.hypot(best.dx,best.dy)>=.25)anchors.push({mx:cx+.5,my:cy+.5,dx:best.dx,dy:best.dy,accuracy:best.accuracy,separation:best.separation});
  }
  return anchors;
}

function timingExpected(index,far){const odd=((index-15)&1)!==0;return far?odd:!odd;}
function phaseScore(image,h,anchors,px,py){
  let dark=0,light=0,dn=0,ln=0;const values=[],corr=[0,0];
  const add=(mx,my,d)=>{const p=projected(h,mx+px,my+py,anchors,corr);if(!p)return;const l=lumaBilinear(image,p.x,p.y);if(l==null)return;values.push([l,d]);if(d){dark+=l;dn++;}else{light+=l;ln++;}};
  for(let x=15;x<MODEM_GRID_W-15;x+=3){add(x+.5,13.5,timingExpected(x,false));add(x+.5,MODEM_GRID_H-13.5,timingExpected(x,true));}
  for(let y=15;y<MODEM_GRID_H-15;y+=3){add(13.5,y+.5,timingExpected(y,false));add(MODEM_GRID_W-13.5,y+.5,timingExpected(y,true));}
  if(dn<25||ln<25)return null;const dm=dark/dn,lm=light/ln,sep=lm-dm;if(sep<10)return null;const t=(dm+lm)/2;let correct=0;for(const[v,d]of values)if((v<t)===d)correct++;return{accuracy:correct/values.length,separation:sep,score:correct/values.length*100+Math.min(18,sep/7)};
}

function decodeControlKnown(image,h,phase,anchors){
  const known=[0x4f,0x4d,1,4],corr=[0,0],values=[];let dark=0,light=0,dn=0,ln=0;
  for(let i=0;i<32;i++){const expected=((known[i>>3]>>(7-(i&7)))&1)!==0;for(let copy=0;copy<2;copy++){const p=projected(h,32+i+.5+phase.x,100+copy+.5+phase.y,anchors,corr);if(!p)continue;const l=lumaBilinear(image,p.x,p.y);if(l==null)continue;values.push([l,expected]);if(expected){dark+=l;dn++;}else{light+=l;ln++;}}}
  if(dn<16||ln<16)return null;const dm=dark/dn,lm=light/ln,t=(dm+lm)/2;let correct=0;for(const[v,e]of values)if((v<t)===e)correct++;return{accuracy:correct/values.length,separation:lm-dm};
}
function findPhase(image,h,anchors){
  let best={x:0,y:0,accuracy:0,separation:0,score:-1,rank:-1};
  for(const y of PHASE_STEPS)for(const x of PHASE_STEPS){const s=phaseScore(image,h,anchors,x,y);if(!s)continue;const control=decodeControlKnown(image,h,{x,y},anchors),controlAcc=control?.accuracy||0,rank=s.score+18*controlAcc-1.8*Math.hypot(x,y);if(rank>best.rank)best={x,y,...s,controlAccuracy:controlAcc,rank};}
  return best;
}

function minSeparation(c){let min=Infinity;for(let a=0;a<4;a++)for(let b=a+1;b<4;b++){const f=[c[a*4],c[a*4+1],c[a*4+2],c[a*4+3]];min=Math.min(min,Math.sqrt(distance(f,c,b)));}return min;}
function calibrate(image,h,phase,anchors){
  const sums=new Float64Array(16),counts=new Uint16Array(4),rgb=[0,0,0],f=[0,0,0,0],corr=[0,0];
  for(const p of CAL)for(let yy=0;yy<4;yy++)for(let xx=0;xx<5;xx++){if(!sampleCell(image,h,p.x+xx,p.y+yy,phase,anchors,true,rgb,corr))continue;feature(rgb,f);const o=p.state*4;for(let k=0;k<4;k++)sums[o+k]+=f[k];counts[p.state]++;}
  for(let s=0;s<4;s++)if(counts[s]<10)return null;const c=new Float64Array(16);for(let s=0;s<4;s++){const o=s*4;for(let k=0;k<4;k++)c[o+k]=sums[o+k]/counts[s];}const separation=minSeparation(c);return separation>=.055?{centroids:c,separation}:null;
}
function regionIndex(x,y){return Math.min(REGION_COLS-1,Math.floor(x*REGION_COLS/MODEM_GRID_W))+REGION_COLS*Math.min(REGION_ROWS-1,Math.floor(y*REGION_ROWS/MODEM_GRID_H));}
function regionalCentroids(image,h,phase,anchors,cal){
  const regions=REGION_COLS*REGION_ROWS,sums=new Float64Array(regions*16),counts=new Uint16Array(regions*4),rgb=[0,0,0],f=[0,0,0,0],corr=[0,0];
  for(let r=0;r<regions;r++)for(let s=0;s<4;s++){const ro=r*16+s*4,so=s*4;for(let k=0;k<4;k++)sums[ro+k]=cal.centroids[so+k]*12;counts[r*4+s]=12;}
  for(let i=0;i<PAYLOAD.length;i+=37){const p=PAYLOAD[i];if(!sampleCell(image,h,p.x,p.y,phase,anchors,false,rgb,corr))continue;feature(rgb,f);const q=classify(f,cal.centroids);if(q.margin<.0014)continue;const r=regionIndex(p.x,p.y),o=r*16+q.state*4;for(let k=0;k<4;k++)sums[o+k]+=f[k];counts[r*4+q.state]++;}
  const out=[];for(let r=0;r<regions;r++){const c=new Float64Array(16);for(let s=0;s<4;s++){const o=s*4,ro=r*16+o,n=counts[r*4+s];for(let k=0;k<4;k++)c[o+k]=sums[ro+k]/n;}out.push(c);}return out;
}

function classifyField(image,h,phase,anchors,cal,regions=null){
  const states=new Uint8Array(MODEM_PAYLOAD_CELLS),confidence=new Float32Array(MODEM_PAYLOAD_CELLS),rgb=[0,0,0],f=[0,0,0,0],corr=[0,0];let marginSum=0,resampled=0;
  for(let i=0;i<PAYLOAD.length;i++){const p=PAYLOAD[i];if(!sampleCell(image,h,p.x,p.y,phase,anchors,false,rgb,corr))return null;feature(rgb,f);const c=regions?regions[regionIndex(p.x,p.y)]:cal.centroids;let q=classify(f,c);if(q.margin<.0012&&sampleCell(image,h,p.x,p.y,phase,anchors,true,rgb,corr)){feature(rgb,f);q=classify(f,c);resampled++;}states[i]=q.state;confidence[i]=q.margin;marginSum+=q.margin;}
  return{states,confidence,margin:marginSum/PAYLOAD.length,resampled};
}
function packetFromField(field){
  let fec;try{fec=modemStatesToPacket(field.states);const packet=decodeOpticalPacket(fec.bytes);if(packet.protocolVersion===2&&packet.chunkSize===MODEM_CHUNK_BYTES&&packet.visualStates===4)return{ok:true,fec,packet,listWords:0,listTrials:0};}catch{}
  if(!fec)try{fec=modemStatesToPacket(field.states);}catch(error){return{ok:false,error:error?.message||String(error),corrected:0};}
  const repaired=repairModemPacketWithCrc(field.states,field.confidence,fec.bytes);if(repaired?.packet&&repaired.packet.protocolVersion===2&&repaired.packet.chunkSize===MODEM_CHUNK_BYTES&&repaired.packet.visualStates===4)return{ok:true,fec:{...fec,bytes:repaired.bytes},packet:repaired.packet,listWords:repaired.listWords,listTrials:repaired.listTrials,suspectCount:repaired.suspectCount};
  return{ok:false,error:'CRC mismatch',corrected:Number(fec.corrected)||0,listWords:0,listTrials:Number(repaired?.listTrials)||0,suspectCount:Number(repaired?.suspectCount)||0};
}

function diagnostic(started,stage,extra={}){return{ok:false,stage,decodeMs:(globalThis.performance?.now?.()??Date.now())-started,...extra};}
function success(started,tracked,decoded,field,cal,anchors,phase,control,adaptation){return{ok:true,stage:'decoded',packet:decoded.packet,bytes:decoded.fec.bytes,corrected:decoded.fec.corrected,listWords:decoded.listWords||0,listTrials:decoded.listTrials||0,suspectCount:decoded.suspectCount||0,markers:tracked.markers.map(m=>({...m})),rotation:Number(tracked.rotation)||0,anchorSet:tracked.anchorSet||'outer',calibrationSeparation:cal.separation,margin:field.margin,resampled:field.resampled,pilotAnchors:anchors.length,phaseAccuracy:phase.accuracy,phaseSeparation:phase.separation,controlAccuracy:control?.accuracy||0,adaptation,decodeMs:(globalThis.performance?.now?.()??Date.now())-started};}

export async function decodeOpticalModemColor(image,tracked){
  const started=globalThis.performance?.now?.()??Date.now();if(!image?.data||!tracked?.markers?.length)return diagnostic(started,'geometry');const h=buildHomography(tracked);if(!h)return diagnostic(started,'geometry');

  let anchors=[],phase=findPhase(image,h,anchors),control=decodeControlKnown(image,h,phase,anchors),cal=calibrate(image,h,phase,anchors);
  if(!cal)return diagnostic(started,'calibration',{pilotAnchors:0,phaseAccuracy:phase.accuracy,controlAccuracy:control?.accuracy||0});
  let field=classifyField(image,h,phase,anchors,cal),decoded=field&&packetFromField(field);if(decoded?.ok)return success(started,tracked,decoded,field,cal,anchors,phase,control,'global');

  anchors=findPilotResiduals(image,h);if(anchors.length){phase=findPhase(image,h,anchors);control=decodeControlKnown(image,h,phase,anchors);const correctedCal=calibrate(image,h,phase,anchors);if(correctedCal){cal=correctedCal;field=classifyField(image,h,phase,anchors,cal);decoded=field&&packetFromField(field);if(decoded?.ok)return success(started,tracked,decoded,field,cal,anchors,phase,control,'pilot');}}

  const regions=regionalCentroids(image,h,phase,anchors,cal);field=classifyField(image,h,phase,anchors,cal,regions);decoded=field&&packetFromField(field);if(decoded?.ok)return success(started,tracked,decoded,field,cal,anchors,phase,control,'regional');

  return diagnostic(started,'fec/crc',{pilotAnchors:anchors.length,phaseAccuracy:phase.accuracy,phaseSeparation:phase.separation,controlAccuracy:control?.accuracy||0,calibrationSeparation:cal.separation,margin:field?.margin||0,resampled:field?.resampled||0,corrected:decoded?.corrected||0,listTrials:decoded?.listTrials||0,suspectCount:decoded?.suspectCount||0,error:decoded?.error||'CRC mismatch',adaptation:'failed'});
}
