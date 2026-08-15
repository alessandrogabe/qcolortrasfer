// qcolortrasfer OPTICAL MODEM real-camera color decoder v3.3.1 (MIT).
//
// Geometry and color are decoded independently of QR/ZXing. Sub-pixel bilinear
// RGB sampling handles 2-3 camera pixels/cell. The fast pass samples one
// projected point per data cell. If strong RS still cannot recover the frame, a
// second area-sampled pass averages five sub-cell points to suppress display /
// camera moire and pixel-phase errors. This keeps clean frames cheap while
// giving difficult real-camera frames a robust retry before geometry fallback.

import { decodeOpticalPacket } from './protocol.js';
import { MODEM_GRID_W,MODEM_GRID_H,homographyFromPoints,mapHomography,modemPayloadPositions } from './optical-modem-codec.js';
import { MODEM_RS_VERSION,MODEM_RS_CHUNK_BYTES,MODEM_RS_CODE_CELLS,rsModemStatesToPacket } from './optical-modem-rs-codec.js';

const SOURCE=Object.freeze([
  Object.freeze({x:5.5,y:5.5}),Object.freeze({x:MODEM_GRID_W-5.5,y:5.5}),
  Object.freeze({x:MODEM_GRID_W-5.5,y:MODEM_GRID_H-5.5}),Object.freeze({x:5.5,y:MODEM_GRID_H-5.5}),
]);
const PILOTS=Object.freeze([[64,36],[128,36],[64,72],[128,72]]);
const CAL=Object.freeze([
  Object.freeze({x:25,y:2,state:0}),Object.freeze({x:32,y:2,state:1}),
  Object.freeze({x:39,y:2,state:2}),Object.freeze({x:46,y:2,state:3}),
]);
const PAYLOAD=Object.freeze(modemPayloadPositions().slice(0,MODEM_RS_CODE_CELLS));
const MULTI=Object.freeze([[.5,.5],[.34,.5],[.66,.5],[.5,.34],[.5,.66]]);
const SINGLE=Object.freeze([[.5,.5]]);
const PHASE_STEPS=Object.freeze([0,-.09,.09,-.18,.18,-.28,.28]);
const PILOT_SHIFTS=Object.freeze([0,-.5,.5,-1,1,-2,2,-3,3]);

function rotateSource(rotation){const out=[];for(let i=0;i<4;i++)out.push(SOURCE[(i-(rotation||0)+4)%4]);return out;}
function buildHomography(tracked){return homographyFromPoints(rotateSource(Number(tracked?.rotation)||0),tracked.markers);}
function rgbBilinear(image,x,y,out){
  if(!(x>=0&&y>=0&&x<image.width-1&&y<image.height-1))return false;const x0=Math.floor(x),y0=Math.floor(y),x1=x0+1,y1=y0+1,tx=x-x0,ty=y-y0,d=image.data,w=image.width,o00=(y0*w+x0)*4,o10=(y0*w+x1)*4,o01=(y1*w+x0)*4,o11=(y1*w+x1)*4;
  for(let c=0;c<3;c++){const a=d[o00+c]*(1-tx)+d[o10+c]*tx,b=d[o01+c]*(1-tx)+d[o11+c]*tx;out[c]=a*(1-ty)+b*ty;}return true;
}
function lumaBilinear(image,x,y){const q=[0,0,0];return rgbBilinear(image,x,y,q)?(77*q[0]+150*q[1]+29*q[2])/256:null;}
function feature(rgb,out){const r=rgb[0],g=rgb[1],b=rgb[2],sum=Math.max(32,r+g+b);out[0]=r/sum;out[1]=g/sum;out[2]=b/sum;out[3]=(77*r+150*g+29*b)/(256*255);return out;}
function distance(f,c,state){const o=state*4,dr=f[0]-c[o],dg=f[1]-c[o+1],db=f[2]-c[o+2],dl=f[3]-c[o+3];return 2.7*(dr*dr+dg*dg+db*db)+.18*dl*dl;}
function classify(f,c){let best=0,bd=Infinity,sd=Infinity;for(let s=0;s<4;s++){const d=distance(f,c,s);if(d<bd){sd=bd;bd=d;best=s;}else if(d<sd)sd=d;}return{state:best,margin:Math.max(0,sd-bd)};}

function correctionAt(mx,my,anchors,out){if(!anchors?.length){out[0]=out[1]=0;return out;}let sw=.65,sx=0,sy=0;for(const a of anchors){const dx=mx-a.mx,dy=my-a.my,w=1/(1+(dx*dx+dy*dy)/700);sw+=w;sx+=a.dx*w;sy+=a.dy*w;}out[0]=sx/sw;out[1]=sy/sw;return out;}
function projected(h,mx,my,anchors,corr){const p=mapHomography(h,mx,my);if(!p)return null;correctionAt(mx,my,anchors,corr);return{x:p.x+corr[0],y:p.y+corr[1]};}
function sampleCell(image,h,x,y,phase,anchors,multi,rgb,corr){
  const offsets=multi?MULTI:SINGLE;let r=0,g=0,b=0,n=0,tmp=[0,0,0];for(const[ox,oy]of offsets){const p=projected(h,x+ox+phase.x,y+oy+phase.y,anchors,corr);if(!p||!rgbBilinear(image,p.x,p.y,tmp))continue;r+=tmp[0];g+=tmp[1];b+=tmp[2];n++;}if(!n)return false;rgb[0]=r/n;rgb[1]=g/n;rgb[2]=b/n;return true;
}

function pilotExpected(dx,dy){const d=Math.max(Math.abs(dx),Math.abs(dy));return d===2||d===0;}
function pilotScore(image,h,cx,cy,sx,sy){let dark=0,light=0,dn=0,ln=0,correct=0;const vals=[];for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const p=mapHomography(h,cx+dx+.5,cy+dy+.5);if(!p)continue;const l=lumaBilinear(image,p.x+sx,p.y+sy);if(l==null)continue;const d=pilotExpected(dx,dy);vals.push([l,d]);if(d){dark+=l;dn++;}else{light+=l;ln++;}}if(dn<10||ln<8)return null;const dm=dark/dn,lm=light/ln,sep=lm-dm;if(sep<12)return null;const t=(dm+lm)/2;for(const[v,d]of vals)if((v<t)===d)correct++;return{accuracy:correct/vals.length,separation:sep,score:correct/vals.length*100+Math.min(20,sep/5)};}
function findPilotResiduals(image,h){const anchors=[];for(const[cx,cy]of PILOTS){const zero=pilotScore(image,h,cx,cy,0,0);let best=zero?{...zero,dx:0,dy:0,rank:zero.score}:null;for(const sy of PILOT_SHIFTS)for(const sx of PILOT_SHIFTS){if(!sx&&!sy)continue;const s=pilotScore(image,h,cx,cy,sx,sy);if(!s)continue;const rank=s.score-.12*Math.hypot(sx,sy);if(!best||rank>best.rank)best={...s,dx:sx,dy:sy,rank};}if(!best||best.accuracy<.76)continue;const improves=!zero||best.score>zero.score+2||best.accuracy>zero.accuracy+.04;if(improves&&Math.hypot(best.dx,best.dy)>=.25)anchors.push({mx:cx+.5,my:cy+.5,dx:best.dx,dy:best.dy,accuracy:best.accuracy});}return anchors;}

function timingExpected(index,far){const odd=((index-15)&1)!==0;return far?odd:!odd;}
function phaseScore(image,h,anchors,px,py){let dark=0,light=0,dn=0,ln=0;const vals=[],corr=[0,0],add=(mx,my,d)=>{const p=projected(h,mx+px,my+py,anchors,corr);if(!p)return;const l=lumaBilinear(image,p.x,p.y);if(l==null)return;vals.push([l,d]);if(d){dark+=l;dn++;}else{light+=l;ln++;}};for(let x=15;x<MODEM_GRID_W-15;x+=3){add(x+.5,13.5,timingExpected(x,false));add(x+.5,MODEM_GRID_H-13.5,timingExpected(x,true));}for(let y=15;y<MODEM_GRID_H-15;y+=3){add(13.5,y+.5,timingExpected(y,false));add(MODEM_GRID_W-13.5,y+.5,timingExpected(y,true));}if(dn<25||ln<25)return null;const dm=dark/dn,lm=light/ln,sep=lm-dm;if(sep<10)return null;const t=(dm+lm)/2;let correct=0;for(const[v,d]of vals)if((v<t)===d)correct++;return{accuracy:correct/vals.length,separation:sep,score:correct/vals.length*100+Math.min(18,sep/7)};}
function decodeControlKnown(image,h,phase,anchors){const known=[0x4f,0x4d,MODEM_RS_VERSION,4],corr=[0,0],vals=[];let dark=0,light=0,dn=0,ln=0;for(let i=0;i<32;i++){const expected=((known[i>>3]>>(7-(i&7)))&1)!==0;for(let copy=0;copy<2;copy++){const p=projected(h,32+i+.5+phase.x,100+copy+.5+phase.y,anchors,corr);if(!p)continue;const l=lumaBilinear(image,p.x,p.y);if(l==null)continue;vals.push([l,expected]);if(expected){dark+=l;dn++;}else{light+=l;ln++;}}}if(dn<16||ln<16)return null;const dm=dark/dn,lm=light/ln,t=(dm+lm)/2;let correct=0;for(const[v,e]of vals)if((v<t)===e)correct++;return{accuracy:correct/vals.length,separation:lm-dm};}
function findPhase(image,h,anchors){let best={x:0,y:0,accuracy:0,separation:0,score:-1,rank:-1};for(const y of PHASE_STEPS)for(const x of PHASE_STEPS){const s=phaseScore(image,h,anchors,x,y);if(!s)continue;const control=decodeControlKnown(image,h,{x,y},anchors),ca=control?.accuracy||0,rank=s.score+18*ca-1.8*Math.hypot(x,y);if(rank>best.rank)best={x,y,...s,controlAccuracy:ca,rank};}return best;}

function minSeparation(c){let min=Infinity;for(let a=0;a<4;a++)for(let b=a+1;b<4;b++){const f=[c[a*4],c[a*4+1],c[a*4+2],c[a*4+3]];min=Math.min(min,Math.sqrt(distance(f,c,b)));}return min;}
function calibrate(image,h,phase,anchors){const sums=new Float64Array(16),counts=new Uint16Array(4),rgb=[0,0,0],f=[0,0,0,0],corr=[0,0];for(const p of CAL)for(let yy=0;yy<4;yy++)for(let xx=0;xx<5;xx++){if(!sampleCell(image,h,p.x+xx,p.y+yy,phase,anchors,true,rgb,corr))continue;feature(rgb,f);const o=p.state*4;for(let k=0;k<4;k++)sums[o+k]+=f[k];counts[p.state]++;}for(let s=0;s<4;s++)if(counts[s]<10)return null;const c=new Float64Array(16);for(let s=0;s<4;s++)for(let k=0;k<4;k++)c[s*4+k]=sums[s*4+k]/counts[s];const separation=minSeparation(c);return separation>=.055?{centroids:c,separation}:null;}
function classifyField(image,h,phase,anchors,cal,{area=false}={}){const states=new Uint8Array(MODEM_RS_CODE_CELLS),rgb=[0,0,0],f=[0,0,0,0],corr=[0,0];let margin=0,resampled=0;for(let i=0;i<PAYLOAD.length;i++){const p=PAYLOAD[i];if(!sampleCell(image,h,p.x,p.y,phase,anchors,area,rgb,corr))return null;feature(rgb,f);let q=classify(f,cal.centroids);if(!area&&q.margin<.0012&&sampleCell(image,h,p.x,p.y,phase,anchors,true,rgb,corr)){feature(rgb,f);q=classify(f,cal.centroids);resampled++;}else if(area)resampled++;states[i]=q.state;margin+=q.margin;}return{states,margin:margin/PAYLOAD.length,resampled,area};}
function decodeField(field){try{const fec=rsModemStatesToPacket(field.states),packet=decodeOpticalPacket(fec.bytes);if(packet.protocolVersion!==2||packet.chunkSize!==MODEM_RS_CHUNK_BYTES||packet.visualStates!==4)return{ok:false,error:'protocol'};return{ok:true,fec,packet};}catch(error){return{ok:false,error:error?.message||String(error)};}}
function diag(started,stage,extra={}){return{ok:false,stage,decodeMs:(globalThis.performance?.now?.()??Date.now())-started,...extra};}
function good(started,tracked,d,field,cal,anchors,phase,control,adaptation){return{ok:true,stage:'decoded',packet:d.packet,bytes:d.fec.bytes,corrected:d.fec.corrected,markers:tracked.markers.map(m=>({...m})),rotation:Number(tracked.rotation)||0,anchorSet:tracked.anchorSet||'outer',calibrationSeparation:cal.separation,margin:field.margin,resampled:field.resampled,pilotAnchors:anchors.length,phaseAccuracy:phase.accuracy,phaseSeparation:phase.separation,controlAccuracy:control?.accuracy||0,adaptation,decodeMs:(globalThis.performance?.now?.()??Date.now())-started};}

function attemptDecode(image,h,phase,anchors,cal,area){const field=classifyField(image,h,phase,anchors,cal,{area});const decoded=field&&decodeField(field);return{field,decoded};}

export async function decodeOpticalModemColor(image,tracked){
  const started=globalThis.performance?.now?.()??Date.now();if(!image?.data||!tracked?.markers?.length)return diag(started,'geometry');const h=buildHomography(tracked);if(!h)return diag(started,'geometry');
  let anchors=[],phase=findPhase(image,h,anchors),control=decodeControlKnown(image,h,phase,anchors),cal=calibrate(image,h,phase,anchors);if(!cal)return diag(started,'calibration',{phaseAccuracy:phase.accuracy,controlAccuracy:control?.accuracy||0,pilotAnchors:0});
  let trial=attemptDecode(image,h,phase,anchors,cal,false),field=trial.field,decoded=trial.decoded;if(decoded?.ok)return good(started,tracked,decoded,field,cal,anchors,phase,control,'global-fast-rs');
  trial=attemptDecode(image,h,phase,anchors,cal,true);field=trial.field;decoded=trial.decoded;if(decoded?.ok)return good(started,tracked,decoded,field,cal,anchors,phase,control,'global-area-rs');
  anchors=findPilotResiduals(image,h);if(anchors.length){phase=findPhase(image,h,anchors);control=decodeControlKnown(image,h,phase,anchors);const c=calibrate(image,h,phase,anchors);if(c){cal=c;trial=attemptDecode(image,h,phase,anchors,cal,false);field=trial.field;decoded=trial.decoded;if(decoded?.ok)return good(started,tracked,decoded,field,cal,anchors,phase,control,'pilot-fast-rs');trial=attemptDecode(image,h,phase,anchors,cal,true);field=trial.field;decoded=trial.decoded;if(decoded?.ok)return good(started,tracked,decoded,field,cal,anchors,phase,control,'pilot-area-rs');}}
  return diag(started,'rs/crc',{pilotAnchors:anchors.length,phaseAccuracy:phase.accuracy,phaseSeparation:phase.separation,controlAccuracy:control?.accuracy||0,calibrationSeparation:cal.separation,margin:field?.margin||0,resampled:field?.resampled||0,error:decoded?.error||'RS/CRC failure'});
}
