import { decodeModemFrame } from './optical-modem-codec.js';

self.onmessage=async event=>{
  const d=event.data||{};
  if(d.type==='warmup'){self.postMessage({id:d.id,warm:true});return;}
  const started=performance.now();
  try{
    const image={width:d.width,height:d.height,data:new Uint8ClampedArray(d.buffer)};
    const result=await decodeModemFrame(image,{tracked:d.tracked||null,forceDetect:Boolean(d.forceDetect)});
    if(!result){self.postMessage({id:d.id,ok:false,workerMs:performance.now()-started});return;}
    const p=result.packet,payload=p.payload.slice();
    self.postMessage({
      id:d.id,ok:true,detected:result.detected,markers:result.markers,rotation:result.rotation,
      syncAccuracy:result.syncAccuracy,syncSeparation:result.syncSeparation,calibrationSeparation:result.calibrationSeparation,
      margin:result.margin,resampled:result.resampled,corrected:result.corrected,decodeMs:result.decodeMs,control:result.control,
      packet:{protocolVersion:p.protocolVersion,streamId:p.streamId,symbolId:p.symbolId,sourceCount:p.sourceCount,chunkSize:p.chunkSize,transferLength:p.transferLength,containerLength:p.containerLength,visualStates:p.visualStates,payload:payload.buffer},
      workerMs:performance.now()-started
    },[payload.buffer]);
  }catch(error){self.postMessage({id:d.id,ok:false,error:error?.message||String(error),workerMs:performance.now()-started});}
};
self.postMessage({id:-1,ready:true});
