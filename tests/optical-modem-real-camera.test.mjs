import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeOpticalModemColor } from '../js/optical-modem-color-decoder.js';
import { MODEM_QUIET,MODEM_GRID_W,MODEM_GRID_H } from '../js/optical-modem-codec.js';
import { MODEM_RS_CHUNK_BYTES,createRsModemRaster,encodeRsModemPacket } from '../js/optical-modem-rs-codec.js';

function samplePacket(symbolId=31){
  const payload=Uint8Array.from({length:MODEM_RS_CHUNK_BYTES},(_,i)=>(i*71+symbolId*19)&255),containerLength=MODEM_RS_CHUNK_BYTES*5+77;
  const meta={streamId:0x2468ace0,sourceCount:Math.ceil(containerLength/MODEM_RS_CHUNK_BYTES),chunkSize:MODEM_RS_CHUNK_BYTES,containerLength,visualStates:4};
  return{packet:encodeRsModemPacket(meta,symbolId,payload),payload,meta};
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

test('RS modem survives fractional 2-3 pixel cells and white-balance shift',async()=>{
  const{packet}=samplePacket(31),raster=createRsModemRaster(packet,{streamId:0x2468ace0,symbolId:31}),{image,tracked}=cameraResample(raster);
  const result=await decodeOpticalModemColor(image,tracked);
  assert.equal(result.ok,true,`stage=${result.stage} cal=${result.calibrationSeparation} phase=${result.phaseAccuracy} control=${result.controlAccuracy} pilots=${result.pilotAnchors} corrected=${result.corrected} margin=${result.margin} resample=${result.resampled} adaptation=${result.adaptation} decodeMs=${result.decodeMs} err=${result.error||''}`);
  assert.equal(result.packet.symbolId,31);assert.equal(result.packet.chunkSize,MODEM_RS_CHUNK_BYTES);assert.ok(result.calibrationSeparation>.05);assert.ok(result.phaseAccuracy>.7);assert.ok(result.corrected>0,'camera-like fixture should exercise RS correction');
});
