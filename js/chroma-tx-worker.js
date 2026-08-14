// qcolortrasfer CHROMA FOUNTAIN raster worker v2.9 (MIT).
import { createChromaRaster, prepareChromaTemplate } from './chroma-fountain.js';

self.onmessage=async event=>{
  const {id,generation,packet}=event.data||{};
  if(id==null)return;
  const started=globalThis.performance?.now?.()??Date.now();
  try{
    const bytes=new Uint8Array(packet);
    const raster=await createChromaRaster(bytes);
    const elapsed=(globalThis.performance?.now?.()??Date.now())-started;
    self.postMessage({id,generation,raster:{...raster,pixels:raster.pixels.buffer},generationMs:elapsed},[raster.pixels.buffer]);
  }catch(error){
    self.postMessage({id,generation,error:error?.message||String(error)});
  }
};
void prepareChromaTemplate().then(()=>self.postMessage({id:-1,ready:true})).catch(error=>self.postMessage({id:-1,ready:false,error:error?.message||String(error)}));
