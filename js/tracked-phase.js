// qcolortrasfer tracked timing-phase refinement (MIT).
//
// Finder centers can have a broad score plateau when a QR module spans only a
// few camera pixels: a stale quad shifted by half a module may still sample all
// 7x7 finder cells correctly. QR timing patterns alternate every module across
// most of the symbol, so they provide a cheap phase ruler without invoking the
// global detector. This module searches only a small translation around the
// cached quad, using several samples inside each timing module.

import { clusterLuma, homographyForQr, mapHomography, shiftQuad } from './tracked-qr.js';

export const TRACKED_PHASE_MAX_PX = 4;
export const TRACKED_PHASE_FRACTIONS = Object.freeze([0.18, 0.50, 0.82]);
export const TRACKED_PHASE_MAX_SAMPLES_PER_AXIS = 28;

function lumaAt(image, x, y) {
  const xx=Math.floor(x), yy=Math.floor(y);
  if(xx<0||yy<0||xx>=image.width||yy>=image.height)return null;
  const off=(yy*image.width+xx)*4;
  return (77*image.data[off]+150*image.data[off+1]+29*image.data[off+2])/256;
}

function timingIndices(modules) {
  const start=8, end=modules-8;
  if(end<=start)return [];
  const span=end-start;
  // Timing modules alternate every cell. An even stride would sample only one
  // parity (all expected dark or all expected light), destroying the phase
  // signal. Keep the sparse stride odd so both populations are always present.
  let stride=Math.max(1,Math.floor(span/TRACKED_PHASE_MAX_SAMPLES_PER_AXIS));
  if((stride&1)===0)stride=Math.max(1,stride-1);
  const out=[];
  for(let i=start;i<end;i+=stride)out.push(i);
  if(out.at(-1)!==end-1)out.push(end-1);
  return out;
}

function timingSamples(image,h,modules,offset) {
  const values=[],labels=[];
  for(const i of timingIndices(modules)) {
    const expectedDark=(i&1)===0;
    for(const f of TRACKED_PHASE_FRACTIONS) {
      const hp=mapHomography(h,i+f,6.5);
      const vp=mapHomography(h,6.5,i+f);
      if(hp){const lum=lumaAt(image,hp[0]+offset.x,hp[1]+offset.y);if(lum!=null){values.push(lum);labels.push(expectedDark);}}
      if(vp){const lum=lumaAt(image,vp[0]+offset.x,vp[1]+offset.y);if(lum!=null){values.push(lum);labels.push(expectedDark);}}
    }
  }
  return {values,labels};
}

export function timingPhaseScore(image,h,modules,offset={x:0,y:0}) {
  const {values,labels}=timingSamples(image,h,modules,offset);
  if(values.length<12)return null;
  const clusters=clusterLuma(values,14);
  if(!clusters)return null;
  let correct=0,margin=0;
  for(let i=0;i<values.length;i++) {
    const dark=values[i]<=clusters.threshold;
    if(dark===labels[i])correct++;
    margin+=Math.abs(values[i]-clusters.threshold);
  }
  return {correct,total:values.length,ratio:correct/values.length,margin:margin/values.length,separation:clusters.separation};
}

function better(candidate,best) {
  if(!candidate)return false;
  if(!best)return true;
  if(candidate.correct!==best.correct)return candidate.correct>best.correct;
  if(Math.abs(candidate.margin-best.margin)>0.01)return candidate.margin>best.margin;
  const cmag=Math.hypot(candidate.x,candidate.y), bmag=Math.hypot(best.x,best.y);
  return cmag<bmag;
}

export function refineTrackedPhase(image,quad,modules) {
  const h=homographyForQr(modules,quad);
  if(!h)return null;
  const sideLengths=[
    Math.hypot(quad.topRight.x-quad.topLeft.x,quad.topRight.y-quad.topLeft.y),
    Math.hypot(quad.bottomLeft.x-quad.topLeft.x,quad.bottomLeft.y-quad.topLeft.y),
  ];
  const pxPerModule=Math.max(1,(sideLengths[0]+sideLengths[1])/(2*modules));
  const radius=Math.max(1,Math.min(TRACKED_PHASE_MAX_PX,Math.ceil(pxPerModule*0.7)));
  let best=null;
  for(let y=-radius;y<=radius;y++)for(let x=-radius;x<=radius;x++) {
    const score=timingPhaseScore(image,h,modules,{x,y});
    const candidate=score?{x,y,...score}:null;
    if(better(candidate,best))best=candidate;
  }
  if(!best)return null;
  const coarse={...best};
  for(const dy of [-0.5,0,0.5])for(const dx of [-0.5,0,0.5]) {
    const x=coarse.x+dx,y=coarse.y+dy;
    const score=timingPhaseScore(image,h,modules,{x,y});
    const candidate=score?{x,y,...score}:null;
    if(better(candidate,best))best=candidate;
  }
  const refinedQuad=shiftQuad(quad,best.x,best.y);
  return refinedQuad?{...best,refinedQuad,pxPerModule}:null;
}
