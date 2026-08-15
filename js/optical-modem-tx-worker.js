import { createRsModemRaster } from './optical-modem-rs-codec.js';

function rotateClockwise(raster){
  const w=raster.width,h=raster.height,out=new Uint8ClampedArray(w*h*4),nw=h,nh=w;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const nx=h-1-y,ny=x,src=(y*w+x)*4,dst=(ny*nw+nx)*4;
    out[dst]=raster.pixels[src];out[dst+1]=raster.pixels[src+1];out[dst+2]=raster.pixels[src+2];out[dst+3]=255;
  }
  return{...raster,pixels:out,width:nw,height:nh,rotated:true};
}

self.onmessage=event=>{
  const d=event.data||{};
  try{
    const packet=new Uint8Array(d.packet);
    let raster=createRsModemRaster(packet,{streamId:d.streamId>>>0,symbolId:d.symbolId>>>0});
    if(d.portrait)raster=rotateClockwise(raster);
    self.postMessage({id:d.id,generation:d.generation,symbolId:d.symbolId,raster:{...raster,pixels:raster.pixels.buffer}},[raster.pixels.buffer]);
  }catch(error){self.postMessage({id:d.id,generation:d.generation,error:error?.message||String(error)});}
};
self.postMessage({id:-1,ready:true});
