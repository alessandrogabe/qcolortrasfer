import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleTrackedQrCandidates } from '../js/tracked-qr.js';
import { chooseAuxLayoutV2, repairSymbolsPerAnchor, selectRepairAnchors } from '../js/tx-aux-repair-v2.js';
import { overlayEligibleDetection } from '../js/rx-detection-overlay.js';

function idealFinder(x,y){return x===0||x===6||y===0||y===6||(x>=2&&x<=4&&y>=2&&y<=4);}
function makeMatrix(modules){
  const bits=new Uint8Array(modules*modules);
  for(let y=0;y<modules;y++)for(let x=0;x<modules;x++)bits[y*modules+x]=(x+y)%2;
  for(const [ox,oy] of [[0,0],[modules-7,0],[0,modules-7]])for(let y=0;y<7;y++)for(let x=0;x<7;x++)bits[(oy+y)*modules+ox+x]=idealFinder(x,y)?1:0;
  return bits;
}
function render(bits,modules,scale=4,originX=20,originY=18){
  const width=originX*2+modules*scale,height=originY*2+modules*scale,data=new Uint8ClampedArray(width*height*4);data.fill(255);
  for(let y=0;y<modules;y++)for(let x=0;x<modules;x++){const value=bits[y*modules+x]?18:238;for(let yy=0;yy<scale;yy++)for(let xx=0;xx<scale;xx++){const o=((originY+y*scale+yy)*width+originX+x*scale+xx)*4;data[o]=data[o+1]=data[o+2]=value;data[o+3]=255;}}
  return{data,width,height,originX,originY};
}

test('tracked sampler re-anchors a stale quad before sampling the full grid',()=>{
  const modules=57,bits=makeMatrix(modules),image=render(bits,modules),right=image.originX+modules*4,bottom=image.originY+modules*4;
  const stale={topLeft:{x:image.originX-2,y:image.originY-1},topRight:{x:right-2,y:image.originY-1},bottomLeft:{x:image.originX-2,y:bottom-1},bottomRight:{x:right-2,y:bottom-1}};
  const sampled=sampleTrackedQrCandidates(image,stale,modules);
  assert.ok(sampled);
  assert.ok(sampled.anchorScore>=120);
  assert.ok(Math.abs(sampled.refinedQuad.topLeft.x-image.originX)<=0.6);
  assert.ok(Math.abs(sampled.refinedQuad.topLeft.y-image.originY)<=0.6);
  const uniform=sampled.candidates.find(c=>c.kind==='uniform');
  let same=0;for(let i=0;i<bits.length;i++)if(bits[i]===uniform.bits[i])same++;
  assert.ok(same/bits.length>0.97);
});

test('AUX AUTO reduces helper count when pixels per module would be too low',()=>{
  const roomy=chooseAuxLayoutV2(430,800,3,77);
  assert.ok(roomy.count>=2);
  assert.ok(roomy.devicePxPerCell>=3.35);
  const cramped=chooseAuxLayoutV2(300,430,1,77);
  assert.equal(cramped.count,1);
  assert.ok(cramped.count<=roomy.count);
});

test('QAR2 concentrates repair on a bounded set of source anchors',()=>{
  const anchors=selectRepairAnchors(297,12);
  assert.equal(anchors.length,12);
  assert.equal(anchors[0],0);assert.equal(anchors.at(-1),296);
  assert.ok(repairSymbolsPerAnchor(2925)>Math.ceil(2925/256));
});

test('RX overlay hides detector-error sightings and draws decoded quads only',()=>{
  const quad={topLeft:{x:0,y:0},topRight:{x:10,y:0},bottomRight:{x:10,y:10},bottomLeft:{x:0,y:10}};
  assert.equal(overlayEligibleDetection({decoded:true,quad}),true);
  assert.equal(overlayEligibleDetection({decoded:false,quad}),false);
});
