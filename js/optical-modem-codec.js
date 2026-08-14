// qcolortrasfer OPTICAL MODEM v3.2 (MIT).
//
// Standalone screen->camera modem. This is not a QR code and does not use
// ZXing for detection or payload decoding. Four custom B/W fiducials establish
// projective geometry; fixed pilot cells provide orientation and per-frame
// color calibration; the payload is a dense 4-state cell field protected by
// interleaved Hamming(15,11), QCT2 CRC and the existing LT fountain layer.
//
// Design is an original qcolortrasfer implementation. General inspiration:
// color-cell optical camera communication, libcimbar's tile/FEC/interleaving
// architecture, and published OCC pilot/channel-calibration techniques. No
// third-party source code is copied here.

import { crc32 } from './crc32.js';
import { decodeOpticalPacket, encodeOpticalPacketV2 } from './protocol.js';

export const MODEM_VERSION = 1;
export const MODEM_GRID_W = 192;
export const MODEM_GRID_H = 108;
export const MODEM_QUIET = 4;
export const MODEM_RASTER_W = MODEM_GRID_W + MODEM_QUIET * 2;
export const MODEM_RASTER_H = MODEM_GRID_H + MODEM_QUIET * 2;
export const MODEM_MARKER_SIZE = 11;
export const MODEM_MARKER_ZONE = 15;
export const MODEM_STATES = 4;
export const MODEM_BITS_PER_CELL = 2;
export const MODEM_CAL_PATCH_W = 5;
export const MODEM_CAL_PATCH_H = 4;
export const MODEM_FEC_PERMUTATION = 7919;
export const MODEM_QCT_OVERHEAD = 28;
export const MODEM_PAYLOAD_CELLS = 18880;
export const MODEM_PACKET_BYTES = 3460;
export const MODEM_CHUNK_BYTES = MODEM_PACKET_BYTES - MODEM_QCT_OVERHEAD;
export const MODEM_RAW_BITS = MODEM_PACKET_BYTES * 8;
export const MODEM_HAMMING_WORDS = Math.ceil(MODEM_RAW_BITS / 11);
export const MODEM_CODE_BITS = MODEM_HAMMING_WORDS * 15;
export const MODEM_CODE_CELLS = Math.ceil(MODEM_CODE_BITS / 2);

// High-saturation palette, deliberately no yellow. Black/white are reserved for
// sync/fiducials and are never data symbols.
export const MODEM_PALETTE = Object.freeze([
  Object.freeze([226, 34, 46]),   // 00 red
  Object.freeze([34, 202, 74]),   // 01 green
  Object.freeze([36, 76, 226]),   // 10 blue
  Object.freeze([220, 46, 206]),  // 11 magenta
]);

const BLACK = Object.freeze([0, 0, 0]);
const WHITE = Object.freeze([255, 255, 255]);
const NEUTRAL = Object.freeze([238, 238, 238]);
const DATA_POSITIONS = Object.freeze([3,5,6,7,9,10,11,12,13,14,15]);
const CAL_PATCHES = Object.freeze([
  Object.freeze({ x:25, y:2, kind:'color', state:0 }),
  Object.freeze({ x:32, y:2, kind:'color', state:1 }),
  Object.freeze({ x:39, y:2, kind:'color', state:2 }),
  Object.freeze({ x:46, y:2, kind:'color', state:3 }),
  Object.freeze({ x:53, y:2, kind:'black', state:-1 }),
  Object.freeze({ x:60, y:2, kind:'white', state:-1 }),
]);
const PILOT_CENTERS = Object.freeze([[64,36],[128,36],[64,72],[128,72]]);
const SOURCE_MARKER_CENTERS = Object.freeze([
  Object.freeze({x:5.5,y:5.5}),
  Object.freeze({x:MODEM_GRID_W-5.5,y:5.5}),
  Object.freeze({x:MODEM_GRID_W-5.5,y:MODEM_GRID_H-5.5}),
  Object.freeze({x:5.5,y:MODEM_GRID_H-5.5}),
]);

function gcd(a,b){while(b){const t=a%b;a=b;b=t;}return Math.abs(a);}
if (MODEM_CODE_CELLS > MODEM_PAYLOAD_CELLS || gcd(MODEM_FEC_PERMUTATION, MODEM_CODE_BITS) !== 1)
  throw new Error('OPTICAL MODEM capacity/permutation constants are inconsistent');

function bitAt(bytes,index){return(bytes[index>>3]>>(7-(index&7)))&1;}
function setBit(bytes,index,value){if(value)bytes[index>>3]|=1<<(7-(index&7));}

function hammingEncodeBytes(bytes) {
  const rawBits=bytes.length*8,words=Math.ceil(rawBits/11),out=new Uint8Array(words*15);let src=0;
  for(let word=0;word<words;word++){
    const bits=new Uint8Array(16);
    for(const position of DATA_POSITIONS)bits[position]=src<rawBits?bitAt(bytes,src++):0;
    for(const parity of [1,2,4,8]){
      let value=0;for(let position=1;position<=15;position++)if(position!==parity&&(position&parity))value^=bits[position];bits[parity]=value;
    }
    for(let position=1;position<=15;position++)out[word*15+position-1]=bits[position];
  }
  return out;
}

function hammingDecodeBits(coded,expectedBytes) {
  const expectedBits=expectedBytes*8,words=Math.ceil(expectedBits/11),out=new Uint8Array(expectedBytes);let dst=0,corrected=0;
  if(coded.length<words*15)throw new Error('OPTICAL MODEM FEC truncated');
  for(let word=0;word<words;word++){
    const bits=new Uint8Array(16);let syndrome=0;
    for(let position=1;position<=15;position++){const value=coded[word*15+position-1]&1;bits[position]=value;if(value)syndrome^=position;}
    if(syndrome>=1&&syndrome<=15){bits[syndrome]^=1;corrected++;}
    for(const position of DATA_POSITIONS){if(dst>=expectedBits)break;setBit(out,dst++,bits[position]);}
  }
  return{bytes:out,corrected};
}

function scrambleBits(bits){const out=new Uint8Array(bits.length);for(let i=0;i<bits.length;i++)out[(i*MODEM_FEC_PERMUTATION)%bits.length]=bits[i]&1;return out;}
function unscrambleBits(bits){const out=new Uint8Array(bits.length);for(let i=0;i<bits.length;i++)out[i]=bits[(i*MODEM_FEC_PERMUTATION)%bits.length]&1;return out;}

function syncBit(i){
  let x=(Math.imul((i+1)>>>0,0x9e3779b1)^0xa6d3f05c)>>>0;
  x^=x>>>16;x=Math.imul(x,0x7feb352d)>>>0;x^=x>>>15;return(x>>>1)&1;
}

function controlBytes(streamId,symbolId){
  const out=new Uint8Array(8),view=new DataView(out.buffer);out[0]=0x4f;out[1]=0x4d;out[2]=MODEM_VERSION;out[3]=MODEM_STATES;view.setUint16(4,streamId&0xffff);view.setUint16(6,symbolId&0xffff);return out;
}

function reserveRect(mask,x0,y0,w,h){for(let y=y0;y<y0+h;y++)for(let x=x0;x<x0+w;x++)if(x>=0&&y>=0&&x<MODEM_GRID_W&&y<MODEM_GRID_H)mask[y*MODEM_GRID_W+x]=1;}

function buildLayout(){
  const reserved=new Uint8Array(MODEM_GRID_W*MODEM_GRID_H);
  reserveRect(reserved,0,0,MODEM_MARKER_ZONE,MODEM_MARKER_ZONE);
  reserveRect(reserved,MODEM_GRID_W-MODEM_MARKER_ZONE,0,MODEM_MARKER_ZONE,MODEM_MARKER_ZONE);
  reserveRect(reserved,0,MODEM_GRID_H-MODEM_MARKER_ZONE,MODEM_MARKER_ZONE,MODEM_MARKER_ZONE);
  reserveRect(reserved,MODEM_GRID_W-MODEM_MARKER_ZONE,MODEM_GRID_H-MODEM_MARKER_ZONE,MODEM_MARKER_ZONE,MODEM_MARKER_ZONE);
  for(let x=15;x<MODEM_GRID_W-15;x++){reserved[13*MODEM_GRID_W+x]=1;reserved[(MODEM_GRID_H-14)*MODEM_GRID_W+x]=1;}
  for(let y=15;y<MODEM_GRID_H-15;y++){reserved[y*MODEM_GRID_W+13]=1;reserved[y*MODEM_GRID_W+(MODEM_GRID_W-14)]=1;}
  for(const patch of CAL_PATCHES)reserveRect(reserved,patch.x,patch.y,MODEM_CAL_PATCH_W,MODEM_CAL_PATCH_H);
  for(const y of [8,9])for(let x=64;x<128;x++)reserved[y*MODEM_GRID_W+x]=1;
  for(const [cx,cy] of PILOT_CENTERS)reserveRect(reserved,cx-2,cy-2,5,5);
  for(const y of [100,101])for(let x=32;x<96;x++)reserved[y*MODEM_GRID_W+x]=1;
  const payload=[];
  for(let y=0;y<MODEM_GRID_H;y++)for(let x=0;x<MODEM_GRID_W;x++)if(!reserved[y*MODEM_GRID_W+x])payload.push({x,y,index:y*MODEM_GRID_W+x});
  if(payload.length!==MODEM_PAYLOAD_CELLS)throw new Error(`OPTICAL MODEM payload cells ${payload.length} != ${MODEM_PAYLOAD_CELLS}`);
  return{reserved,payload};
}
const LAYOUT=buildLayout();

export function modemPayloadPositions(){return LAYOUT.payload.map(p=>({...p}));}

export function encodeModemPacket(meta,symbolId,payload){
  const packet=encodeOpticalPacketV2({...meta,visualStates:4},symbolId,payload);
  if(packet.length!==MODEM_PACKET_BYTES)throw new Error(`OPTICAL MODEM packet ${packet.length} B != ${MODEM_PACKET_BYTES} B`);
  return packet;
}

export function packetToModemStates(packet){
  if(!(packet instanceof Uint8Array)||packet.length!==MODEM_PACKET_BYTES)throw new Error(`OPTICAL MODEM packet must be ${MODEM_PACKET_BYTES} B`);
  const coded=scrambleBits(hammingEncodeBytes(packet));
  if(coded.length!==MODEM_CODE_BITS)throw new Error('OPTICAL MODEM FEC size mismatch');
  const states=new Uint8Array(MODEM_PAYLOAD_CELLS);let bit=0;
  for(let i=0;i<MODEM_CODE_CELLS;i++){
    const hi=bit<MODEM_CODE_BITS?coded[bit++]:0,lo=bit<MODEM_CODE_BITS?coded[bit++]:0;states[i]=(hi<<1)|lo;
  }
  return states;
}

export function modemStatesToPacket(states){
  if(!(states instanceof Uint8Array)||states.length<MODEM_CODE_CELLS)throw new Error('OPTICAL MODEM state field truncated');
  const scrambled=new Uint8Array(MODEM_CODE_BITS);let bit=0;
  for(let i=0;i<MODEM_CODE_CELLS&&bit<MODEM_CODE_BITS;i++){
    const state=states[i]&3;scrambled[bit++]=(state>>1)&1;if(bit<MODEM_CODE_BITS)scrambled[bit++]=state&1;
  }
  return hammingDecodeBits(unscrambleBits(scrambled),MODEM_PACKET_BYTES);
}

function pixelOffset(width,x,y){return(y*width+x)*4;}
function paintPixel(pixels,width,x,y,rgb){const o=pixelOffset(width,x,y);pixels[o]=rgb[0];pixels[o+1]=rgb[1];pixels[o+2]=rgb[2];pixels[o+3]=255;}
function paintLogical(pixels,x,y,rgb){paintPixel(pixels,MODEM_RASTER_W,x+MODEM_QUIET,y+MODEM_QUIET,rgb);}

function markerDark(dx,dy){const d=Math.max(Math.abs(dx-5),Math.abs(dy-5));return d>=4||d<=1;}
function paintMarker(pixels,x0,y0){
  for(let y=y0;y<y0+MODEM_MARKER_ZONE;y++)for(let x=x0;x<x0+MODEM_MARKER_ZONE;x++)paintLogical(pixels,x,y,WHITE);
  const mx=x0===0?0:MODEM_GRID_W-MODEM_MARKER_SIZE,my=y0===0?0:MODEM_GRID_H-MODEM_MARKER_SIZE;
  for(let y=0;y<MODEM_MARKER_SIZE;y++)for(let x=0;x<MODEM_MARKER_SIZE;x++)paintLogical(pixels,mx+x,my+y,markerDark(x,y)?BLACK:WHITE);
}
function paintPilot(pixels,cx,cy){for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const d=Math.max(Math.abs(dx),Math.abs(dy));paintLogical(pixels,cx+dx,cy+dy,(d===2||d===0)?BLACK:WHITE);}}

export function createModemRaster(packet,{streamId=0,symbolId=0}={}){
  const states=packetToModemStates(packet),pixels=new Uint8ClampedArray(MODEM_RASTER_W*MODEM_RASTER_H*4);
  for(let y=0;y<MODEM_RASTER_H;y++)for(let x=0;x<MODEM_RASTER_W;x++)paintPixel(pixels,MODEM_RASTER_W,x,y,WHITE);
  for(let y=0;y<MODEM_GRID_H;y++)for(let x=0;x<MODEM_GRID_W;x++)paintLogical(pixels,x,y,NEUTRAL);
  paintMarker(pixels,0,0);paintMarker(pixels,MODEM_GRID_W-MODEM_MARKER_ZONE,0);paintMarker(pixels,0,MODEM_GRID_H-MODEM_MARKER_ZONE);paintMarker(pixels,MODEM_GRID_W-MODEM_MARKER_ZONE,MODEM_GRID_H-MODEM_MARKER_ZONE);
  for(let x=15;x<MODEM_GRID_W-15;x++){paintLogical(pixels,x,13,((x-15)&1)?WHITE:BLACK);paintLogical(pixels,x,MODEM_GRID_H-14,((x-15)&1)?BLACK:WHITE);}
  for(let y=15;y<MODEM_GRID_H-15;y++){paintLogical(pixels,13,y,((y-15)&1)?WHITE:BLACK);paintLogical(pixels,MODEM_GRID_W-14,y,((y-15)&1)?BLACK:WHITE);}
  for(const patch of CAL_PATCHES){const rgb=patch.kind==='color'?MODEM_PALETTE[patch.state]:patch.kind==='black'?BLACK:WHITE;for(let y=0;y<MODEM_CAL_PATCH_H;y++)for(let x=0;x<MODEM_CAL_PATCH_W;x++)paintLogical(pixels,patch.x+x,patch.y+y,rgb);}
  for(const y of [8,9])for(let x=64;x<128;x++)paintLogical(pixels,x,y,syncBit(x-64)?BLACK:WHITE);
  for(const [cx,cy] of PILOT_CENTERS)paintPilot(pixels,cx,cy);
  const control=controlBytes(streamId,symbolId);
  for(let copy=0;copy<2;copy++)for(let i=0;i<64;i++)paintLogical(pixels,32+i,100+copy,bitAt(control,i)?BLACK:WHITE);
  for(let i=0;i<LAYOUT.payload.length;i++)paintLogical(pixels,LAYOUT.payload[i].x,LAYOUT.payload[i].y,MODEM_PALETTE[states[i]&3]);
  return{pixels,width:MODEM_RASTER_W,height:MODEM_RASTER_H,gridWidth:MODEM_GRID_W,gridHeight:MODEM_GRID_H,states:MODEM_STATES};
}

function solveLinearSystem(matrix,vector){
  const n=vector.length,a=matrix.map((row,i)=>[...row,vector[i]]);
  for(let col=0;col<n;col++){
    let pivot=col;for(let row=col+1;row<n;row++)if(Math.abs(a[row][col])>Math.abs(a[pivot][col]))pivot=row;
    if(Math.abs(a[pivot][col])<1e-9)return null;[a[col],a[pivot]]=[a[pivot],a[col]];const d=a[col][col];for(let j=col;j<=n;j++)a[col][j]/=d;
    for(let row=0;row<n;row++){if(row===col)continue;const f=a[row][col];for(let j=col;j<=n;j++)a[row][j]-=f*a[col][j];}
  }
  return a.map(row=>row[n]);
}

export function homographyFromPoints(src,dst){
  if(src?.length!==4||dst?.length!==4)return null;const matrix=[],vector=[];
  for(let i=0;i<4;i++){
    const{x,y}=src[i],u=dst[i].x,v=dst[i].y;matrix.push([x,y,1,0,0,0,-u*x,-u*y]);vector.push(u);matrix.push([0,0,0,x,y,1,-v*x,-v*y]);vector.push(v);
  }
  const h=solveLinearSystem(matrix,vector);return h?[h[0],h[1],h[2],h[3],h[4],h[5],h[6],h[7],1]:null;
}
export function mapHomography(h,x,y){const d=h[6]*x+h[7]*y+h[8];if(Math.abs(d)<1e-9)return null;return{x:(h[0]*x+h[1]*y+h[2])/d,y:(h[3]*x+h[4]*y+h[5])/d};}

function lumaAt(image,x,y){const xx=Math.round(x),yy=Math.round(y);if(xx<0||yy<0||xx>=image.width||yy>=image.height)return null;const o=(yy*image.width+xx)*4;return(77*image.data[o]+150*image.data[o+1]+29*image.data[o+2])/256;}
function rgbAt(image,x,y,out){const xx=Math.round(x),yy=Math.round(y);if(xx<0||yy<0||xx>=image.width||yy>=image.height)return false;const o=(yy*image.width+xx)*4;out[0]=image.data[o];out[1]=image.data[o+1];out[2]=image.data[o+2];return true;}

function ringScore(image,cx,cy,r){
  if(!(r>=3))return-1e9;let dark=0,light=0,dn=0,ln=0;
  const add=(radius,isDark)=>{for(let k=0;k<8;k++){const a=k*Math.PI/4,v=lumaAt(image,cx+Math.cos(a)*radius,cy+Math.sin(a)*radius);if(v==null)continue;if(isDark){dark+=v;dn++;}else{light+=v;ln++;}}};
  const center=lumaAt(image,cx,cy);if(center!=null){dark+=center*4;dn+=4;}add(r*.82,true);add(r*.46,false);add(r*1.18,false);
  if(dn<8||ln<8)return-1e9;const darkMean=dark/dn,lightMean=light/ln;return lightMean-darkMean;
}

function searchCorner(image,quadrant){
  const w=image.width,h=image.height,min=Math.min(w,h),grid=Math.max(6,Math.floor(min/105));
  const bounds=quadrant===0?[.04,.52,.04,.52]:quadrant===1?[.48,.96,.04,.52]:quadrant===2?[.48,.96,.48,.96]:[.04,.52,.48,.96];
  let best=null;const radii=[.010,.014,.018,.023,.029,.036,.045].map(v=>Math.max(3,min*v));
  for(let y=Math.floor(h*bounds[2]);y<h*bounds[3];y+=grid)for(let x=Math.floor(w*bounds[0]);x<w*bounds[1];x+=grid)for(const r of radii){const score=ringScore(image,x,y,r);if(!best||score>best.score)best={x,y,r,score};}
  if(!best||best.score<45)return null;
  let refined=best;
  const delta=Math.max(2,Math.floor(grid*.75));
  for(let dy=-delta;dy<=delta;dy+=2)for(let dx=-delta;dx<=delta;dx+=2)for(let dr=-3;dr<=3;dr+=1){const r=Math.max(3,best.r+dr),score=ringScore(image,best.x+dx,best.y+dy,r);if(score>refined.score)refined={x:best.x+dx,y:best.y+dy,r,score};}
  return refined;
}

export function detectModemMarkers(image){
  if(!image?.data||!(image.width>0)||!(image.height>0))return null;const found=[];
  for(let q=0;q<4;q++){const marker=searchCorner(image,q);if(!marker)return null;found.push(marker);}
  const avg=found.reduce((s,m)=>s+m.score,0)/4;if(avg<55)return null;return{markers:found.map(({x,y})=>({x,y})),score:avg};
}

function refineMarker(image,marker){
  let best={x:marker.x,y:marker.y,r:Math.max(3,marker.r||Math.min(image.width,image.height)*.022),score:-1e9};
  for(let dy=-5;dy<=5;dy+=1)for(let dx=-5;dx<=5;dx+=1)for(const dr of [-2,0,2]){const r=Math.max(3,best.r+dr),score=ringScore(image,marker.x+dx,marker.y+dy,r);if(score>best.score)best={x:marker.x+dx,y:marker.y+dy,r,score};}
  return best.score>=40?best:null;
}

export function refineModemMarkers(image,tracked){
  if(!tracked?.markers?.length||tracked.markers.length!==4)return null;const markers=[];
  for(const marker of tracked.markers){const next=refineMarker(image,marker);if(!next)return null;markers.push(next);}
  return{markers,rotation:Number.isInteger(tracked.rotation)?tracked.rotation:0,score:markers.reduce((s,m)=>s+m.score,0)/4};
}

function homographyForRotation(imageMarkers,rotation){
  const dst=[];for(let i=0;i<4;i++)dst.push(imageMarkers[(i+rotation)%4]);return homographyFromPoints(SOURCE_MARKER_CENTERS,dst);
}

function syncScore(image,h){
  let black=0,white=0,bn=0,wn=0;const samples=[];
  for(const y of [8,9])for(let x=64;x<128;x++){
    const p=mapHomography(h,x+.5,y+.5);if(!p)continue;const l=lumaAt(image,p.x,p.y);if(l==null)continue;const bit=syncBit(x-64);samples.push([l,bit]);if(bit){black+=l;bn++;}else{white+=l;wn++;}
  }
  if(bn<30||wn<30)return null;const b=black/bn,w=white/wn,separation=w-b;if(separation<25)return null;const t=(b+w)/2;let correct=0;for(const[l,bit]of samples)if((l<t?1:0)===bit)correct++;
  return{accuracy:correct/samples.length,separation,score:correct/samples.length*100+Math.min(30,separation/4)};
}

function chooseRotation(image,markers,preferred=null){
  const order=[];if(Number.isInteger(preferred))order.push(((preferred%4)+4)%4);for(let r=0;r<4;r++)if(!order.includes(r))order.push(r);
  let best=null;for(const rotation of order){const h=homographyForRotation(markers,rotation);if(!h)continue;const sync=syncScore(image,h);if(!sync)continue;const candidate={rotation,h,...sync};if(!best||candidate.score>best.score)best=candidate;}
  return best&&best.accuracy>=.72?best:null;
}

function feature(rgb,out){
  const r=rgb[0],g=rgb[1],b=rgb[2],sum=Math.max(32,r+g+b);out[0]=r/sum;out[1]=g/sum;out[2]=b/sum;out[3]=(77*r+150*g+29*b)/(256*255);return out;
}
function colorDistance(f,centroids,state){const o=state*4,dr=f[0]-centroids[o],dg=f[1]-centroids[o+1],db=f[2]-centroids[o+2],dl=f[3]-centroids[o+3];return 2.4*(dr*dr+dg*dg+db*db)+.35*dl*dl;}
function classifyFeature(f,centroids){let best=0,bestD=Infinity,second=Infinity;for(let s=0;s<4;s++){const d=colorDistance(f,centroids,s);if(d<bestD){second=bestD;bestD=d;best=s;}else if(d<second)second=d;}return{state:best,margin:Math.max(0,second-bestD)};}

function sampleCellRgb(image,h,x,y,multi,rgb){
  const offsets=multi?[[.5,.5],[.30,.5],[.70,.5],[.5,.30],[.5,.70]]:[[.5,.5]];let r=0,g=0,b=0,n=0,tmp=[0,0,0];
  for(const[ox,oy]of offsets){const p=mapHomography(h,x+ox,y+oy);if(!p||!rgbAt(image,p.x,p.y,tmp))continue;r+=tmp[0];g+=tmp[1];b+=tmp[2];n++;}
  if(!n)return false;rgb[0]=r/n;rgb[1]=g/n;rgb[2]=b/n;return true;
}

function calibrate(image,h){
  const sums=new Float64Array(16),counts=new Uint16Array(4),rgb=[0,0,0],f=[0,0,0,0];
  for(const patch of CAL_PATCHES){if(patch.kind!=='color')continue;for(let yy=0;yy<MODEM_CAL_PATCH_H;yy++)for(let xx=0;xx<MODEM_CAL_PATCH_W;xx++){
    if(!sampleCellRgb(image,h,patch.x+xx,patch.y+yy,true,rgb))continue;feature(rgb,f);const o=patch.state*4;for(let k=0;k<4;k++)sums[o+k]+=f[k];counts[patch.state]++;
  }}
  for(let s=0;s<4;s++)if(counts[s]<8)return null;const centroids=new Float64Array(16);
  for(let s=0;s<4;s++){const o=s*4;for(let k=0;k<4;k++)centroids[o+k]=sums[o+k]/counts[s];}
  let min=Infinity;for(let a=0;a<4;a++)for(let b=a+1;b<4;b++){const fa=[centroids[a*4],centroids[a*4+1],centroids[a*4+2],centroids[a*4+3]],d=colorDistance(fa,centroids,b);min=Math.min(min,Math.sqrt(d));}
  return min>=.10?{centroids,separation:min}:null;
}

function decodeControl(image,h){
  const bytes=new Uint8Array(8);let votes=0;
  for(let i=0;i<64;i++){
    let ones=0,zeros=0;for(let copy=0;copy<2;copy++){const p=mapHomography(h,32+i+.5,100+copy+.5);if(!p)continue;const l=lumaAt(image,p.x,p.y);if(l==null)continue;(l<128?ones:zeros)++;}
    if(ones||zeros){setBit(bytes,i,ones>zeros?1:0);votes++;}
  }
  return votes>=56&&bytes[0]===0x4f&&bytes[1]===0x4d?{version:bytes[2],states:bytes[3],streamLow:new DataView(bytes.buffer).getUint16(4),sequenceLow:new DataView(bytes.buffer).getUint16(6)}:null;
}

export async function decodeModemWithMarkers(image,tracked,{allowDetectRotation=true}={}){
  const start=globalThis.performance?.now?.()??Date.now();const rawMarkers=tracked?.markers||tracked;
  if(!rawMarkers?.length||rawMarkers.length!==4)return null;
  const choice=chooseRotation(image,rawMarkers,allowDetectRotation?tracked?.rotation:null);if(!choice)return null;const calibration=calibrate(image,choice.h);if(!calibration)return null;
  const states=new Uint8Array(MODEM_PAYLOAD_CELLS),rgb=[0,0,0],f=[0,0,0,0];let marginSum=0,resampled=0;
  for(let i=0;i<LAYOUT.payload.length;i++){
    const p=LAYOUT.payload[i];if(!sampleCellRgb(image,choice.h,p.x,p.y,false,rgb))return null;feature(rgb,f);let c=classifyFeature(f,calibration.centroids);
    if(c.margin<.010&&sampleCellRgb(image,choice.h,p.x,p.y,true,rgb)){feature(rgb,f);c=classifyFeature(f,calibration.centroids);resampled++;}
    states[i]=c.state;marginSum+=c.margin;
  }
  let fec,packet;try{fec=modemStatesToPacket(states);packet=decodeOpticalPacket(fec.bytes);}catch{return null;}
  if(packet.protocolVersion!==2||packet.chunkSize!==MODEM_CHUNK_BYTES||packet.visualStates!==4)return null;
  const end=globalThis.performance?.now?.()??Date.now();
  return{packet,bytes:fec.bytes,corrected:fec.corrected,markers:rawMarkers.map(m=>({...m})),rotation:choice.rotation,syncAccuracy:choice.accuracy,syncSeparation:choice.separation,calibrationSeparation:calibration.separation,margin:marginSum/LAYOUT.payload.length,resampled,control:decodeControl(image,choice.h),decodeMs:end-start};
}

export async function decodeModemFrame(image,{tracked=null,forceDetect=false}={}){
  let markerState=null,detected=false;
  if(tracked&&!forceDetect)markerState=refineModemMarkers(image,tracked);
  if(markerState){const decoded=await decodeModemWithMarkers(image,markerState);if(decoded)return{...decoded,detected:false};}
  const acquisition=detectModemMarkers(image);if(!acquisition)return null;detected=true;
  markerState={markers:acquisition.markers.map(m=>({...m,r:Math.min(image.width,image.height)*.022})),rotation:tracked?.rotation??0};
  const decoded=await decodeModemWithMarkers(image,markerState);return decoded?{...decoded,detected}:null;
}

export function modemControlCrc(bytes){return crc32(bytes);}
