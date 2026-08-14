// qcolortrasfer MAIN COLOR raster worker v3.1 (MIT).
import { createChromaRaster, prepareChromaTemplate } from './chroma-fountain.js';

self.onmessage=async event=>{
  const {id,generation,basePacket,chromaPacket}=event.data||{};
  if(id==null)return;
  const started=globalThis.performance?.now?.()??Date.now();
  try{
    const base=new Uint8Array(basePacket),chroma=new Uint8Array(chromaPacket);
    const raster=await createChromaRaster(base,chroma);
    const elapsed=(globalThis.performance?.now?.()??Date.now())-started;
    self.postMessage({id,generation,raster:{...raster,pixels:raster.pixels.buffer},generationMs:elapsed},[raster.pixels.buffer]);
  }catch(error){
    self.postMessage({id,generation,error:error?.message||String(error)});
  }
};
void prepareChromaTemplate().then(()=>self.postMessage({id:-1,ready:true})).catch(error=>self.postMessage({id:-1,ready:false,error:error?.message||String(error)}));
