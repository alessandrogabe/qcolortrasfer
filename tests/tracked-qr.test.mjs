import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterLuma, modulesFromVersion, sampleTrackedQr, shiftQuad, versionFromModules } from '../js/tracked-qr.js';

test('QR version and module helpers round-trip',()=>{assert.equal(modulesFromVersion(40),177);assert.equal(versionFromModules(177),40);assert.equal(versionFromModules(176),0);});
test('luminance clustering separates dark and light populations',()=>{const c=clusterLuma(Float32Array.from([20,24,28,220,225,230]));assert.ok(c);assert.ok(c.threshold>28&&c.threshold<220);assert.ok(c.separation>150);});

function finder(x,y){return x===0||x===6||y===0||y===6||(x>=2&&x<=4&&y>=2&&y<=4);}
test('tracked sampler reconstructs a QR-like module matrix without global detection',()=>{
  const modules=21,scale=6,width=modules*scale,height=width,expected=new Uint8Array(modules*modules),data=new Uint8ClampedArray(width*height*4);data.fill(255);
  for(let y=0;y<modules;y++)for(let x=0;x<modules;x++)expected[y*modules+x]=((x*3+y*5)%7)<3?1:0;
  for(const [ox,oy] of [[0,0],[modules-7,0],[0,modules-7]])for(let y=0;y<7;y++)for(let x=0;x<7;x++)expected[(oy+y)*modules+ox+x]=finder(x,y)?1:0;
  for(let y=0;y<modules;y++)for(let x=0;x<modules;x++){if(!expected[y*modules+x])continue;for(let yy=0;yy<scale;yy++)for(let xx=0;xx<scale;xx++){const off=(((y*scale+yy)*width)+x*scale+xx)*4;data[off]=data[off+1]=data[off+2]=8;data[off+3]=255;}}
  const quad={topLeft:{x:0,y:0},topRight:{x:width,y:0},bottomLeft:{x:0,y:height},bottomRight:{x:width,y:height}};
  const sampled=sampleTrackedQr({data,width,height},quad,modules);assert.ok(sampled);assert.deepEqual([...sampled.bits],[...expected]);assert.ok(sampled.separation>150);assert.ok(sampled.anchorScore>=120);
});

test('quad shifting preserves geometry while translating into crop coordinates',()=>{const q=shiftQuad({topLeft:{x:100,y:200},topRight:{x:200,y:200},bottomLeft:{x:100,y:300},bottomRight:{x:200,y:300}},-80,-150);assert.deepEqual(q.topLeft,{x:20,y:50});assert.deepEqual(q.bottomRight,{x:120,y:150});});
