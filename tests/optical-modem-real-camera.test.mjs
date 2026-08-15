import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeOpticalModemColor } from '../js/optical-modem-color-decoder.js';
import {
  MODEM_CHUNK_BYTES, MODEM_QUIET, MODEM_GRID_W, MODEM_GRID_H, MODEM_CODE_BITS, MODEM_FEC_PERMUTATION,
  createModemRaster, encodeModemPacket, packetToModemStates, homographyFromPoints, mapHomography, modemPayloadPositions
} from '../js/optical-modem-codec.js';

const SOURCE=[{x:5.5,y:5.5},{x:MODEM_GRID_W-5.5,y:5.5},{x:MODEM_GRID_W-5.5,y:MODEM_GRID_H-5.5},{x:5.5,y:MODEM_GRID_H-5.5}];
const CAL=[{x:25,y:2,state:0},{x:32,y:2,state:1},{x:39,y:2,state:2},{x:46,y:2,state:3}];
const PAYLOAD=modemPayloadPositions();

function samplePacket(symbolId=31){
  const payload=Uint8Array.from({length:MODEM_CHUNK_BYTES},(_,i)=>(i*71+symbolId*19)&255),containerLength=MODEM_CHUNK_BYTES*5+77;
  const meta={streamId:0x2468ace0,sourceCount:Math.ceil(containerLength/MODEM_CHUNK_BYTES),chunkSize:MODEM_CHUNK_BYTES,containerLength,visualStates:4};
  return{packet:encodeModemPacket(meta,symbolId,payload),payload,meta};
}

function bilinear(src,width,height,x,y,c){
  x=Math.max(0,Math.min(width-1.001,x));y=Math.max(0,Math.min(height-1.001,y));
  const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(width-1,x0+1),y1=Math.min(height-1,y0+1),tx=x-x0,ty=y-y0;
  const o00=(y0*width+x0)*4,o10=(y0*width+x1)*4,o01=(y1*width+x0)*4,o11=(y1*width+x1)*4;
  const a=src[o00+c]*(1-tx)+src[o10+c]*tx,b=src[o01+c]*(1-tx)+src[o11+c]*tx;return a*(1-ty)+b*ty;
}

function cameraResample(raster,{sx=2.45,sy=2.35,shiftX=.37,shiftY=.61}={}){
  const width=Math.ceil(raster.width*sx+4),height=Math.ceil(raster.height*sy+4),data=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const srcX=((x+.5-shiftX)/sx)-.5,srcY=((y+.5-shiftY)/sy)-.5,o=(y*width+x)*4;
    if(srcX<0||srcY<0||srcX>=raster.width||srcY>=raster.height){data[o]=data[o+1]=data[o+2]=255;data[o+3]=255;continue;}
    const r=bilinear(raster.pixels,raster.width,raster.height,srcX,srcY,0),g=bilinear(raster.pixels,raster.width,raster.height,srcX,srcY,1),b=bilinear(raster.pixels,raster.width,raster.height,srcX,srcY,2);
    data[o]=Math.max(0,Math.min(255,r*.90+8));data[o+1]=Math.max(0,Math.min(255,g*1.04+3));data[o+2]=Math.max(0,Math.min(255,b*.96+5));data[o+3]=255;
  }
  const at=(x,y)=>({x:(MODEM_QUIET+x)*sx+shiftX-.5,y:(MODEM_QUIET+y)*sy+shiftY-.5,r:5.2*(sx+sy)/2});
  const markers=[at(5.5,5.5),at(MODEM_GRID_W-5.5,5.5),at(MODEM_GRID_W-5.5,MODEM_GRID_H-5.5),at(5.5,MODEM_GRID_H-5.5)];
  return{image:{width,height,data},tracked:{markers,rotation:0,anchorSet:'outer'}};
}

function rgbAt(image,x,y){
  const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(image.width-1,x0+1),y1=Math.min(image.height-1,y0+1),tx=x-x0,ty=y-y0,d=image.data,w=image.width,out=[0,0,0];
  for(let c=0;c<3;c++){const a=d[(y0*w+x0)*4+c]*(1-tx)+d[(y0*w+x1)*4+c]*tx,b=d[(y1*w+x0)*4+c]*(1-tx)+d[(y1*w+x1)*4+c]*tx;out[c]=a*(1-ty)+b*ty;}return out;
}
function feat(rgb){const[r,g,b]=rgb,sum=Math.max(32,r+g+b);return[r/sum,g/sum,b/sum,(77*r+150*g+29*b)/(256*255)];}
function dist(f,c,s){const o=s*4,dr=f[0]-c[o],dg=f[1]-c[o+1],db=f[2]-c[o+2],dl=f[3]-c[o+3];return 2.7*(dr*dr+dg*dg+db*db)+.18*dl*dl;}
function classify(f,c){let best=0,bd=Infinity,sd=Infinity;for(let s=0;s<4;s++){const d=dist(f,c,s);if(d<bd){sd=bd;bd=d;best=s;}else if(d<sd)sd=d;}return{state:best,margin:sd-bd};}
function inspectStates(image,tracked){
  const h=homographyFromPoints(SOURCE,tracked.markers),sums=new Float64Array(16),counts=new Uint16Array(4);
  const sample=(x,y)=>{const p=mapHomography(h,x+.5,y+.5);return feat(rgbAt(image,p.x,p.y));};
  for(const p of CAL)for(let y=0;y<4;y++)for(let x=0;x<5;x++){const f=sample(p.x+x,p.y+y),o=p.state*4;for(let k=0;k<4;k++)sums[o+k]+=f[k];counts[p.state]++;}
  const centroids=new Float64Array(16);for(let s=0;s<4;s++)for(let k=0;k<4;k++)centroids[s*4+k]=sums[s*4+k]/counts[s];
  const states=new Uint8Array(PAYLOAD.length),confidence=new Float32Array(PAYLOAD.length);for(let i=0;i<PAYLOAD.length;i++){const p=PAYLOAD[i],q=classify(sample(p.x,p.y),centroids);states[i]=q.state;confidence[i]=q.margin;}return{states,confidence};
}
function errorSummary(expected,observed,confidence){
  const inverse=new Int32Array(MODEM_CODE_BITS).fill(-1);for(let i=0;i<MODEM_CODE_BITS;i++)inverse[(i*MODEM_FEC_PERMUTATION)%MODEM_CODE_BITS]=i;
  const wordErrors=new Map(),wordConf=new Map();let cells=0,bits=0;
  for(let cell=0;cell<Math.min(expected.length,observed.length);cell++){
    const xor=(expected[cell]^observed[cell])&3;if(!xor)continue;cells++;
    for(let k=0;k<2;k++){const mask=k===0?2:1;if(!(xor&mask))continue;bits++;const j=cell*2+k;if(j>=MODEM_CODE_BITS)continue;const coded=inverse[j],word=Math.floor(coded/15);wordErrors.set(word,(wordErrors.get(word)||0)+1);wordConf.set(word,Math.min(wordConf.get(word)??Infinity,confidence[cell]));}
  }
  const hist={};for(const n of wordErrors.values())hist[n]=(hist[n]||0)+1;const multi=[...wordErrors.entries()].filter(([,n])=>n>=2).map(([word,n])=>({word,n,conf:wordConf.get(word)})).sort((a,b)=>b.n-a.n||a.conf-b.conf);
  return{cells,bits,hist,multi:multi.slice(0,20)};
}

test('real-camera decoder survives fractional 2-3 pixel cells and white-balance shift',async()=>{
  const{packet}=samplePacket(31),raster=createModemRaster(packet,{streamId:0x2468ace0,symbolId:31}),{image,tracked}=cameraResample(raster),inspection=inspectStates(image,tracked),summary=errorSummary(packetToModemStates(packet),inspection.states,inspection.confidence);
  console.log('MODEM_CAMERA_ERROR_SUMMARY',JSON.stringify(summary));
  const result=await decodeOpticalModemColor(image,tracked);
  assert.equal(result.ok,true,`stage=${result.stage} cal=${result.calibrationSeparation} phase=${result.phaseAccuracy} control=${result.controlAccuracy} pilots=${result.pilotAnchors} corrected=${result.corrected} suspects=${result.suspectCount} listTrials=${result.listTrials} margin=${result.margin} resample=${result.resampled} adaptation=${result.adaptation} decodeMs=${result.decodeMs} err=${result.error||''}`);
  assert.equal(result.packet.symbolId,31);
  assert.equal(result.packet.chunkSize,MODEM_CHUNK_BYTES);
  assert.ok(result.calibrationSeparation>.05);
  assert.ok(result.phaseAccuracy>.7);
});
