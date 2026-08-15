import { decodeOpticalModemColor } from './optical-modem-color-decoder.js';
import { detectOuterModemMarkers, refineOuterModemMarkers } from './optical-modem-detector.js';

function failureMessage(d,anchors,diag,started){
  return{
    id:d.id,ok:false,stage:diag?.stage||'finder/sync',anchorFound:Boolean(anchors),markers:anchors?.markers||null,
    rotation:anchors?.rotation??null,anchorSet:anchors?.anchorSet||'outer',syncAccuracy:anchors?.syncAccuracy??0,
    syncSeparation:anchors?.syncSeparation??0,finderScore:anchors?.finderScore??0,detectorMs:anchors?.detectorMs??0,
    calibrationSeparation:diag?.calibrationSeparation??0,margin:diag?.margin??0,resampled:diag?.resampled??0,
    corrected:diag?.corrected??0,pilotAnchors:diag?.pilotAnchors??0,phaseAccuracy:diag?.phaseAccuracy??0,
    phaseSeparation:diag?.phaseSeparation??0,controlAccuracy:diag?.controlAccuracy??0,decodeMs:diag?.decodeMs??0,
    decodeError:diag?.error||'',workerMs:performance.now()-started
  };
}

self.onmessage=async event=>{
  const d=event.data||{};
  if(d.type==='warmup'){self.postMessage({id:d.id,warm:true});return;}
  const started=performance.now();
  try{
    const image={width:d.width,height:d.height,data:new Uint8ClampedArray(d.buffer)};
    let anchors=null,result=null,diag=null,detected=false;

    // A valid refined SYNC is already a useful geometry lock. If color/FEC fails
    // we keep that lock for the next frame instead of paying for another full
    // four-fiducial detector pass on the same image.
    if(d.tracked&&!d.forceDetect){
      anchors=refineOuterModemMarkers(image,d.tracked);
      if(anchors){
        diag=await decodeOpticalModemColor(image,anchors);
        if(diag.ok)result=diag;
        else{self.postMessage(failureMessage(d,anchors,diag,started));return;}
      }
    }

    if(!result){
      anchors=detectOuterModemMarkers(image);
      if(!anchors){self.postMessage(failureMessage(d,null,{stage:'finder/sync'},started));return;}
      detected=true;diag=await decodeOpticalModemColor(image,anchors);if(diag.ok)result=diag;
      else{self.postMessage(failureMessage(d,anchors,diag,started));return;}
    }

    const p=result.packet,payload=p.payload.slice();
    self.postMessage({
      id:d.id,ok:true,stage:'decoded',detected,markers:anchors.markers,rotation:anchors.rotation,anchorSet:anchors.anchorSet||'outer',
      syncAccuracy:anchors.syncAccuracy??0,syncSeparation:anchors.syncSeparation??0,calibrationSeparation:result.calibrationSeparation,
      finderScore:anchors.finderScore??0,detectorMs:anchors.detectorMs??0,margin:result.margin,resampled:result.resampled,
      corrected:result.corrected,decodeMs:result.decodeMs,pilotAnchors:result.pilotAnchors,phaseAccuracy:result.phaseAccuracy,
      phaseSeparation:result.phaseSeparation,controlAccuracy:result.controlAccuracy,
      packet:{protocolVersion:p.protocolVersion,streamId:p.streamId,symbolId:p.symbolId,sourceCount:p.sourceCount,chunkSize:p.chunkSize,transferLength:p.transferLength,containerLength:p.containerLength,visualStates:p.visualStates,payload:payload.buffer},
      workerMs:performance.now()-started
    },[payload.buffer]);
  }catch(error){self.postMessage({id:d.id,ok:false,stage:'exception',error:error?.message||String(error),workerMs:performance.now()-started});}
};
self.postMessage({id:-1,ready:true});
