// qcolortrasfer CHROMA direct decoder v3.0 (MIT).
//
// Direct sampled-matrix -> QCT2 path. No synthetic QR ImageData and no ZXing
// payload decode. The QR-shaped B/W function modules are used only for geometry.
// A coarse alignment correction field replaces per-cell inverse-distance loops;
// most payload cells use one RGB read, with five-point resampling only when the
// four-color classifier margin is weak.

import { decodeOpticalPacket } from './protocol.js';
import {
  CHROMA_MODULES, CHROMA_CHUNK_BYTES, CHROMA_CODE_CELLS,
  CHROMA_CALIBRATION_CELLS, CHROMA_PALETTE,
  prepareChromaTemplate, chromaStatesToPacket
} from './chroma-fountain.js';
import {
  homographyForQr, buildLocalThresholdGrid, findAlignmentResiduals
} from './tracked-qr.js';

const COLOR_SAMPLE_OFFSETS = Object.freeze([[.5,.5],[.34,.5],[.66,.5],[.5,.34],[.5,.66]]);
const MIN_CALIBRATION_SEPARATION = 0.075;
const RESAMPLE_MARGIN = 0.012;
const CORRECTION_GRID = 10;

let fastTemplatePromise = null;

async function fastTemplate() {
  if (!fastTemplatePromise) fastTemplatePromise = (async () => {
    const template = await prepareChromaTemplate();
    const payloadX = new Uint16Array(template.payloadPositions.length);
    const payloadY = new Uint16Array(template.payloadPositions.length);
    for (let i=0;i<template.payloadPositions.length;i++) {
      payloadX[i] = template.payloadPositions[i].x;
      payloadY[i] = template.payloadPositions[i].y;
    }
    const calX = new Uint16Array(template.calibrationEntries.length);
    const calY = new Uint16Array(template.calibrationEntries.length);
    const calState = new Uint8Array(template.calibrationEntries.length);
    for (let i=0;i<template.calibrationEntries.length;i++) {
      calX[i] = template.calibrationEntries[i].x;
      calY[i] = template.calibrationEntries[i].y;
      calState[i] = template.calibrationEntries[i].state;
    }
    return { payloadX, payloadY, calX, calY, calState };
  })();
  return fastTemplatePromise;
}

function correctionAt(mx, my, anchors) {
  if (!anchors?.length) return [0,0];
  let sumW=.35,sumX=0,sumY=0;
  for (const anchor of anchors) {
    const dx=mx-anchor.mx,dy=my-anchor.my,d2=dx*dx+dy*dy;
    const w=1/(1+d2/400);
    sumW+=w;sumX+=anchor.dx*w;sumY+=anchor.dy*w;
  }
  return [sumX/sumW,sumY/sumW];
}

export function buildCorrectionField(anchors, modules = CHROMA_MODULES, cells = CORRECTION_GRID) {
  if (!anchors?.length) return null;
  const n=Math.max(2,Math.floor(Number(cells)||CORRECTION_GRID));
  const out=new Float32Array(n*n*2);
  for(let gy=0;gy<n;gy++)for(let gx=0;gx<n;gx++){
    const mx=gx*(modules-1)/(n-1)+.5,my=gy*(modules-1)/(n-1)+.5;
    const [x,y]=correctionAt(mx,my,anchors),off=(gy*n+gx)*2;
    out[off]=x;out[off+1]=y;
  }
  return {cells:n,modules,values:out};
}

function fieldCorrection(field,mx,my,out) {
  if(!field){out[0]=0;out[1]=0;return out;}
  const n=field.cells;
  const fx=Math.max(0,Math.min(n-1,(mx-.5)*(n-1)/(field.modules-1)));
  const fy=Math.max(0,Math.min(n-1,(my-.5)*(n-1)/(field.modules-1)));
  const x0=Math.floor(fx),y0=Math.floor(fy),x1=Math.min(n-1,x0+1),y1=Math.min(n-1,y0+1);
  const tx=fx-x0,ty=fy-y0,v=field.values;
  const i00=(y0*n+x0)*2,i10=(y0*n+x1)*2,i01=(y1*n+x0)*2,i11=(y1*n+x1)*2;
  const ax=v[i00]*(1-tx)+v[i10]*tx;
  const bx=v[i01]*(1-tx)+v[i11]*tx;
  const ay=v[i00+1]*(1-tx)+v[i10+1]*tx;
  const by=v[i01+1]*(1-tx)+v[i11+1]*tx;
  out[0]=ax*(1-ty)+bx*ty;out[1]=ay*(1-ty)+by*ty;return out;
}

function projectedPixel(image,h,mx,my,cx=0,cy=0) {
  const d=h[6]*mx+h[7]*my+h[8];
  if(Math.abs(d)<1e-9)return -1;
  const x=Math.round((h[0]*mx+h[1]*my+h[2])/d+cx);
  const y=Math.round((h[3]*mx+h[4]*my+h[5])/d+cy);
  if(x<0||y<0||x>=image.width||y>=image.height)return -1;
  return (y*image.width+x)*4;
}

function sampleRgb(image,h,mx,my,field,multi,out,corr) {
  let cx=0,cy=0;
  if(field){fieldCorrection(field,mx+.5,my+.5,corr);cx=corr[0];cy=corr[1];}
  if(!multi){
    const off=projectedPixel(image,h,mx+.5,my+.5,cx,cy);if(off<0)return false;
    out[0]=image.data[off];out[1]=image.data[off+1];out[2]=image.data[off+2];return true;
  }
  let r=0,g=0,b=0,n=0;
  for(let i=0;i<COLOR_SAMPLE_OFFSETS.length;i++){
    const pair=COLOR_SAMPLE_OFFSETS[i],off=projectedPixel(image,h,mx+pair[0],my+pair[1],cx,cy);if(off<0)continue;
    r+=image.data[off];g+=image.data[off+1];b+=image.data[off+2];n++;
  }
  if(!n)return false;out[0]=r/n;out[1]=g/n;out[2]=b/n;return true;
}

function featureInto(rgb,out) {
  const r=rgb[0],g=rgb[1],b=rgb[2],sum=Math.max(32,r+g+b);
  out[0]=(77*r+150*g+29*b)/(256*255);
  out[1]=(r-g)/sum;
  out[2]=(b-g)/sum;
}

function distance(l,a,b,centroids,state) {
  const off=state*3;
  const dl=(l-centroids[off])*1.45;
  const da=(a-centroids[off+1])*2.35;
  const db=(b-centroids[off+2])*2.35;
  return dl*dl+da*da+db*db;
}

function classify(l,a,b,centroids,out) {
  let best=0,bestD=Infinity,second=Infinity;
  for(let state=0;state<4;state++){
    const d=distance(l,a,b,centroids,state);
    if(d<bestD){second=bestD;bestD=d;best=state;}else if(d<second)second=d;
  }
  out[0]=best;out[1]=Math.max(0,second-bestD);
}

function minimumCentroidSeparation(centroids) {
  let min=Infinity;
  for(let i=0;i<4;i++)for(let j=i+1;j<4;j++){
    const oi=i*3,oj=j*3;
    const dl=(centroids[oi]-centroids[oj])*1.45;
    const da=(centroids[oi+1]-centroids[oj+1])*2.35;
    const db=(centroids[oi+2]-centroids[oj+2])*2.35;
    min=Math.min(min,Math.sqrt(dl*dl+da*da+db*db));
  }
  return min;
}

async function decodeOnce(image,quad,useAlignment) {
  const started=globalThis.performance?.now?.()??Date.now();
  const tpl=await fastTemplate();
  const h=homographyForQr(CHROMA_MODULES,quad);if(!h)return null;
  let anchors=[];
  if(useAlignment){
    const threshold=buildLocalThresholdGrid(image,h,CHROMA_MODULES,{x:0,y:0});
    if(threshold)anchors=findAlignmentResiduals(image,h,threshold,CHROMA_MODULES,{x:0,y:0});
  }
  const field=buildCorrectionField(anchors);
  const sums=new Float64Array(12),counts=new Uint16Array(4),rgb=[0,0,0],f=[0,0,0],corr=[0,0];
  for(let i=0;i<tpl.calState.length;i++){
    if(!sampleRgb(image,h,tpl.calX[i],tpl.calY[i],field,true,rgb,corr))return null;
    featureInto(rgb,f);const state=tpl.calState[i],off=state*3;
    sums[off]+=f[0];sums[off+1]+=f[1];sums[off+2]+=f[2];counts[state]++;
  }
  for(let i=0;i<4;i++)if(counts[i]<8)return null;
  const centroids=new Float64Array(12);
  for(let state=0;state<4;state++){
    const off=state*3,n=counts[state];centroids[off]=sums[off]/n;centroids[off+1]=sums[off+1]/n;centroids[off+2]=sums[off+2]/n;
  }
  const calibrationSeparation=minimumCentroidSeparation(centroids);
  if(!(calibrationSeparation>=MIN_CALIBRATION_SEPARATION))return null;

  const states=new Uint8Array(CHROMA_CODE_CELLS),classified=[0,0];
  let marginSum=0,resampled=0;
  for(let i=0;i<CHROMA_CODE_CELLS;i++){
    const x=tpl.payloadX[i],y=tpl.payloadY[i];
    if(!sampleRgb(image,h,x,y,field,false,rgb,corr))return null;
    featureInto(rgb,f);classify(f[0],f[1],f[2],centroids,classified);
    if(classified[1]<RESAMPLE_MARGIN&&sampleRgb(image,h,x,y,field,true,rgb,corr)){
      featureInto(rgb,f);classify(f[0],f[1],f[2],centroids,classified);resampled++;
    }
    states[i]=classified[0];marginSum+=classified[1];
  }

  let decoded,packet;
  try{decoded=chromaStatesToPacket(states);packet=decodeOpticalPacket(decoded.bytes);}catch{return null;}
  if(packet.protocolVersion!==2||packet.chunkSize!==CHROMA_CHUNK_BYTES||packet.visualStates!==2)return null;
  const ended=globalThis.performance?.now?.()??Date.now();
  return {
    bytes:decoded.bytes,packet,corrected:decoded.corrected,
    margin:marginSum/CHROMA_CODE_CELLS,calibrationSeparation,
    alignmentAnchors:anchors.length,resampled,decodeMs:ended-started,
    usedAlignment:Boolean(useAlignment&&anchors.length)
  };
}

export async function decodeChromaRasterFast(image,quad,{useAlignment=false}={}) {
  if(!image?.data||!(image.width>0)||!(image.height>0)||!quad)return null;
  return decodeOnce(image,quad,Boolean(useAlignment));
}

export async function decodeChromaRasterAuto(image,quad,{preferAlignment=false}={}) {
  if(preferAlignment){const aligned=await decodeOnce(image,quad,true);if(aligned)return aligned;return decodeOnce(image,quad,false);}
  const fast=await decodeOnce(image,quad,false);if(fast)return fast;return decodeOnce(image,quad,true);
}

export const CHROMA_FAST_PALETTE = CHROMA_PALETTE;
export const CHROMA_FAST_CALIBRATION_CELLS = CHROMA_CALIBRATION_CELLS;
