// qcolortrasfer MAIN COLOR chroma-side decoder v3.1 (MIT).
//
// The base luminance plane is an ordinary QR and is decoded by the normal QR
// path. This module reads only the independent one-bit chroma plane from the
// same physical modules, then Hamming/CRC-validates it into a second QCT2
// fountain symbol. No synthetic QR and no ZXing call is used for the side data.

import { decodeOpticalPacket } from './protocol.js';
import {
  CHROMA_MODULES, CHROMA_CHUNK_BYTES, CHROMA_CODE_CELLS,
  CHROMA_CALIBRATION_CELLS, CHROMA_PALETTE,
  prepareChromaTemplate, chromaStatesToPacket, isNativeChromaPacket
} from './chroma-fountain.js';
import { homographyForQr, buildLocalThresholdGrid, findAlignmentResiduals } from './tracked-qr.js';

const COLOR_SAMPLE_OFFSETS=Object.freeze([[.5,.5],[.34,.5],[.66,.5],[.5,.34],[.5,.66]]);
const MIN_CHROMA_SEPARATION=.10;
const RESAMPLE_FRACTION=.10;
const CORRECTION_GRID=10;
let fastTemplatePromise=null;

async function fastTemplate(){
  if(!fastTemplatePromise)fastTemplatePromise=(async()=>{
    const template=await prepareChromaTemplate();
    const payloadX=new Uint16Array(template.payloadPositions.length),payloadY=new Uint16Array(template.payloadPositions.length);
    for(let i=0;i<template.payloadPositions.length;i++){payloadX[i]=template.payloadPositions[i].x;payloadY[i]=template.payloadPositions[i].y;}
    const calX=new Uint16Array(template.calibrationEntries.length),calY=new Uint16Array(template.calibrationEntries.length),calState=new Uint8Array(template.calibrationEntries.length);
    for(let i=0;i<template.calibrationEntries.length;i++){calX[i]=template.calibrationEntries[i].x;calY[i]=template.calibrationEntries[i].y;calState[i]=template.calibrationEntries[i].state;}
    return{payloadX,payloadY,calX,calY,calState};
  })();
  return fastTemplatePromise;
}

function correctionAt(mx,my,anchors){
  if(!anchors?.length)return[0,0];
  let sumW=.35,sumX=0,sumY=0;
  for(const anchor of anchors){const dx=mx-anchor.mx,dy=my-anchor.my,d2=dx*dx+dy*dy,w=1/(1+d2/400);sumW+=w;sumX+=anchor.dx*w;sumY+=anchor.dy*w;}
  return[sumX/sumW,sumY/sumW];
}

export function buildCorrectionField(anchors,modules=CHROMA_MODULES,cells=CORRECTION_GRID){
  if(!anchors?.length)return null;
  const n=Math.max(2,Math.floor(Number(cells)||CORRECTION_GRID)),values=new Float32Array(n*n*2);
  for(let gy=0;gy<n;gy++)for(let gx=0;gx<n;gx++){
    const mx=gx*(modules-1)/(n-1)+.5,my=gy*(modules-1)/(n-1)+.5,[x,y]=correctionAt(mx,my,anchors),off=(gy*n+gx)*2;
    values[off]=x;values[off+1]=y;
  }
  return{cells:n,modules,values};
}

function fieldCorrection(field,mx,my,out){
  if(!field){out[0]=0;out[1]=0;return out;}
  const n=field.cells,fx=Math.max(0,Math.min(n-1,(mx-.5)*(n-1)/(field.modules-1))),fy=Math.max(0,Math.min(n-1,(my-.5)*(n-1)/(field.modules-1)));
  const x0=Math.floor(fx),y0=Math.floor(fy),x1=Math.min(n-1,x0+1),y1=Math.min(n-1,y0+1),tx=fx-x0,ty=fy-y0,v=field.values;
  const i00=(y0*n+x0)*2,i10=(y0*n+x1)*2,i01=(y1*n+x0)*2,i11=(y1*n+x1)*2;
  const ax=v[i00]*(1-tx)+v[i10]*tx,bx=v[i01]*(1-tx)+v[i11]*tx,ay=v[i00+1]*(1-tx)+v[i10+1]*tx,by=v[i01+1]*(1-tx)+v[i11+1]*tx;
  out[0]=ax*(1-ty)+bx*ty;out[1]=ay*(1-ty)+by*ty;return out;
}

function projectedPixel(image,h,mx,my,cx=0,cy=0){
  const d=h[6]*mx+h[7]*my+h[8];if(Math.abs(d)<1e-9)return-1;
  const x=Math.round((h[0]*mx+h[1]*my+h[2])/d+cx),y=Math.round((h[3]*mx+h[4]*my+h[5])/d+cy);
  if(x<0||y<0||x>=image.width||y>=image.height)return-1;return(y*image.width+x)*4;
}

function chromaScoreAtOffset(image,off){
  const r=image.data[off],g=image.data[off+1],b=image.data[off+2];return(b-r)/Math.max(32,r+g+b);
}

function sampleScore(image,h,mx,my,field,multi,corr){
  let cx=0,cy=0;if(field){fieldCorrection(field,mx+.5,my+.5,corr);cx=corr[0];cy=corr[1];}
  if(!multi){const off=projectedPixel(image,h,mx+.5,my+.5,cx,cy);return off<0?null:chromaScoreAtOffset(image,off);}
  let sum=0,n=0;
  for(const pair of COLOR_SAMPLE_OFFSETS){const off=projectedPixel(image,h,mx+pair[0],my+pair[1],cx,cy);if(off<0)continue;sum+=chromaScoreAtOffset(image,off);n++;}
  return n?sum/n:null;
}

async function decodeOnce(image,quad,useAlignment){
  const started=globalThis.performance?.now?.()??Date.now(),tpl=await fastTemplate(),h=homographyForQr(CHROMA_MODULES,quad);if(!h)return null;
  let anchors=[];
  if(useAlignment){const threshold=buildLocalThresholdGrid(image,h,CHROMA_MODULES,{x:0,y:0});if(threshold)anchors=findAlignmentResiduals(image,h,threshold,CHROMA_MODULES,{x:0,y:0});}
  const field=buildCorrectionField(anchors),corr=[0,0],sums=[0,0],counts=[0,0];
  for(let i=0;i<tpl.calState.length;i++){
    const score=sampleScore(image,h,tpl.calX[i],tpl.calY[i],field,true,corr);if(score==null)return null;
    const state=tpl.calState[i];sums[state]+=score;counts[state]++;
  }
  if(counts[0]<32||counts[1]<32)return null;
  const c0=sums[0]/counts[0],c1=sums[1]/counts[1],separation=Math.abs(c1-c0);
  if(!(separation>=MIN_CHROMA_SEPARATION))return null;
  const threshold=(c0+c1)/2,oneIsHigh=c1>c0,resampleMargin=separation*RESAMPLE_FRACTION;
  const states=new Uint8Array(CHROMA_CODE_CELLS);let marginSum=0,resampled=0;
  for(let i=0;i<CHROMA_CODE_CELLS;i++){
    const x=tpl.payloadX[i],y=tpl.payloadY[i];let score=sampleScore(image,h,x,y,field,false,corr);if(score==null)return null;
    if(Math.abs(score-threshold)<resampleMargin){const refined=sampleScore(image,h,x,y,field,true,corr);if(refined!=null)score=refined;resampled++;}
    states[i]=oneIsHigh?(score>threshold?1:0):(score<threshold?1:0);marginSum+=Math.abs(score-threshold)/separation;
  }
  let decoded,packet;
  try{decoded=chromaStatesToPacket(states);if(!isNativeChromaPacket(decoded.bytes))return null;packet=decodeOpticalPacket(decoded.bytes);}catch{return null;}
  if(packet.protocolVersion!==2||packet.chunkSize!==CHROMA_CHUNK_BYTES)return null;
  const ended=globalThis.performance?.now?.()??Date.now();
  return{bytes:decoded.bytes,packet,corrected:decoded.corrected,margin:marginSum/CHROMA_CODE_CELLS,calibrationSeparation:separation,alignmentAnchors:anchors.length,resampled,decodeMs:ended-started,usedAlignment:Boolean(useAlignment&&anchors.length)};
}

export async function decodeChromaRasterFast(image,quad,{useAlignment=false}={}){
  if(!image?.data||!(image.width>0)||!(image.height>0)||!quad)return null;
  return decodeOnce(image,quad,Boolean(useAlignment));
}

export async function decodeChromaRasterAuto(image,quad,{preferAlignment=false}={}){
  if(preferAlignment){const aligned=await decodeOnce(image,quad,true);if(aligned)return aligned;return decodeOnce(image,quad,false);}
  const fast=await decodeOnce(image,quad,false);if(fast)return fast;return decodeOnce(image,quad,true);
}

export const CHROMA_FAST_PALETTE=CHROMA_PALETTE;
export const CHROMA_FAST_CALIBRATION_CELLS=CHROMA_CALIBRATION_CELLS;
