import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeOpticalPacket } from '../js/protocol.js';
import {
  MODEM_GRID_W,MODEM_GRID_H,MODEM_STATES,MODEM_PAYLOAD_CELLS,MODEM_PACKET_BYTES,MODEM_CHUNK_BYTES,
  MODEM_CODE_BITS,MODEM_CODE_CELLS,MODEM_PALETTE,MODEM_QUIET,encodeModemPacket,packetToModemStates,modemStatesToPacket,
  createModemRaster,decodeModemWithMarkers
} from '../js/optical-modem-codec.js';
import { detectOuterModemMarkers, refineOuterModemMarkers } from '../js/optical-modem-detector.js';

const root=path=>new URL(`../${path}`,import.meta.url);

function samplePacket(symbolId=7){
  const payload=Uint8Array.from({length:MODEM_CHUNK_BYTES},(_,i)=>(i*67+symbolId*13)&255),containerLength=MODEM_CHUNK_BYTES*4+123;
  const meta={streamId:0x12345678,sourceCount:Math.ceil(containerLength/MODEM_CHUNK_BYTES),chunkSize:MODEM_CHUNK_BYTES,containerLength,visualStates:4};
  return{packet:encodeModemPacket(meta,symbolId,payload),payload,meta};
}

function scaleRaster(raster,scale=3){
  const width=raster.width*scale,height=raster.height*scale,data=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const sx=Math.floor(x/scale),sy=Math.floor(y/scale),src=(sy*raster.width+sx)*4,dst=(y*width+x)*4;
    data[dst]=raster.pixels[src];data[dst+1]=raster.pixels[src+1];data[dst+2]=raster.pixels[src+2];data[dst+3]=255;
  }
  return{width,height,data};
}

function rotate90(image){
  const width=image.height,height=image.width,data=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++){
    const nx=image.height-1-y,ny=x,src=(y*image.width+x)*4,dst=(ny*width+nx)*4;
    data[dst]=image.data[src];data[dst+1]=image.data[src+1];data[dst+2]=image.data[src+2];data[dst+3]=255;
  }
  return{width,height,data};
}

function exactMarkers(scale){
  const at=(x,y)=>({x:scale*(x+MODEM_QUIET)-.5,y:scale*(y+MODEM_QUIET)-.5,r:scale*5.2});
  return[at(5.5,5.5),at(MODEM_GRID_W-5.5,5.5),at(MODEM_GRID_W-5.5,MODEM_GRID_H-5.5),at(5.5,MODEM_GRID_H-5.5)];
}

test('legacy v3.2 Hamming codec remains readable for regression coverage',()=>{
  assert.equal(MODEM_GRID_W,192);assert.equal(MODEM_GRID_H,108);assert.equal(MODEM_STATES,4);
  assert.equal(MODEM_PAYLOAD_CELLS,18880);assert.equal(MODEM_PACKET_BYTES,3460);assert.equal(MODEM_CHUNK_BYTES,3432);
  assert.ok(MODEM_CODE_CELLS<=MODEM_PAYLOAD_CELLS);assert.ok(MODEM_CODE_BITS<=MODEM_PAYLOAD_CELLS*2);
});

test('legacy modem Hamming FEC round-trips a full QCT2 packet',()=>{
  const{packet}=samplePacket();assert.equal(packet.length,MODEM_PACKET_BYTES);
  const states=packetToModemStates(packet),round=modemStatesToPacket(states);assert.deepEqual(round.bytes,packet);assert.equal(round.corrected,0);
  const damaged=states.slice();damaged[1234]^=2;const repaired=modemStatesToPacket(damaged);assert.deepEqual(repaired.bytes,packet);assert.ok(repaired.corrected>=1);
  const decoded=decodeOpticalPacket(repaired.bytes);assert.equal(decoded.chunkSize,MODEM_CHUNK_BYTES);assert.equal(decoded.symbolId,7);
});

test('modem palette uses four saturated non-yellow states',()=>{
  assert.equal(MODEM_PALETTE.length,4);assert.equal(new Set(MODEM_PALETTE.map(c=>c.join(','))).size,4);
  for(const[r,g,b]of MODEM_PALETTE)assert.equal(r>160&&g>150&&b<100,false);
});

test('legacy clean synthetic modem sampling works with exact projective markers',async()=>{
  const scale=3,{packet}=samplePacket(19),raster=createModemRaster(packet,{streamId:0x12345678,symbolId:19}),image=scaleRaster(raster,scale);
  const decoded=await decodeModemWithMarkers(image,{markers:exactMarkers(scale),rotation:0,anchorSet:'outer'});
  assert.ok(decoded,'exact marker geometry must decode the clean synthetic frame');assert.equal(decoded.packet.symbolId,19);assert.equal(decoded.anchorSet,'outer');assert.ok(decoded.syncAccuracy>.9);assert.ok(decoded.calibrationSeparation>.1);
});

test('dedicated four-SYNC detector still acquires a clean legacy modem frame',async()=>{
  const scale=3,{packet}=samplePacket(19),raster=createModemRaster(packet,{streamId:0x12345678,symbolId:19}),image=scaleRaster(raster,scale);
  const acquisition=detectOuterModemMarkers(image);assert.ok(acquisition,'dedicated detector must find a coherent outer quartet');assert.equal(acquisition.markers.length,4);assert.ok(acquisition.syncAccuracy>.9);assert.ok(acquisition.detectorMs>=0);
  const decoded=await decodeModemWithMarkers(image,acquisition);assert.ok(decoded,`anchors=${JSON.stringify(acquisition.markers)}`);assert.equal(decoded.packet.symbolId,19);assert.equal(decoded.packet.chunkSize,MODEM_CHUNK_BYTES);assert.ok(decoded.syncAccuracy>.9);assert.ok(decoded.calibrationSeparation>.1);
  const refined=refineOuterModemMarkers(image,acquisition);assert.ok(refined);assert.ok(refined.syncAccuracy>.9);
});

test('dedicated detector acquires the legacy modem in portrait too',async()=>{
  const scale=3,{packet}=samplePacket(23),raster=createModemRaster(packet,{streamId:0x12345678,symbolId:23}),image=rotate90(scaleRaster(raster,scale));
  assert.ok(image.height>image.width,'fixture must model a portrait display');
  const acquisition=detectOuterModemMarkers(image);assert.ok(acquisition,'portrait frame must still acquire all four outer SYNC markers');assert.ok(acquisition.syncAccuracy>.9);
  const decoded=await decodeModemWithMarkers(image,acquisition);assert.ok(decoded);assert.equal(decoded.packet.symbolId,23);assert.equal(decoded.packet.chunkSize,MODEM_CHUNK_BYTES);
});

test('standalone production modem engines do not invoke QR or ZXing payload paths',async()=>{
  const codec=await readFile(root('js/optical-modem-codec.js'),'utf8'),detector=await readFile(root('js/optical-modem-detector.js'),'utf8'),rs=await readFile(root('js/optical-modem-rs.js'),'utf8'),rsCodec=await readFile(root('js/optical-modem-rs-codec.js'),'utf8'),color=await readFile(root('js/optical-modem-color-decoder.js'),'utf8'),tx=await readFile(root('js/optical-modem-tx.js'),'utf8'),rx=await readFile(root('js/optical-modem-rx.js'),'utf8'),worker=await readFile(root('js/optical-modem-worker.js'),'utf8');
  const dependency=/readBarcodes\s*\(|QRCode\.create\s*\(|(?:from|import).*zxing/i;
  for(const source of [codec,detector,rs,rsCodec,color,tx,rx,worker])assert.doesNotMatch(source,dependency);
  assert.doesNotMatch(tx,/encodeAuxRepairPacket/);assert.doesNotMatch(rx,/qr-worker/);
  assert.match(detector,/TARGET_PLANE_MIN/);assert.match(detector,/detectOuterModemMarkers/);assert.match(rs,/RS_PARITY/);assert.match(rs,/berlekampMassey/);assert.match(rsCodec,/RS255\/223/);assert.match(color,/rgbBilinear/);assert.match(color,/rs\/crc/);assert.match(rx,/stage \$\{lastStage\}/);assert.match(worker,/finder\/sync/);assert.match(worker,/decodeOpticalModemColor/);
});

test('UI shell and PWA load all standalone RS modem runtime modules',async()=>{
  const ui=await readFile(root('js/ui-shell.js'),'utf8'),sw=await readFile(root('sw.js'),'utf8');assert.match(ui,/optical-modem-tx/);assert.match(ui,/optical-modem-rx/);
  assert.match(sw,/v3\.3\.0-rs-optical-modem/);for(const name of ['optical-modem-codec','optical-modem-detector','optical-modem-layout','optical-modem-rs','optical-modem-rs-codec','optical-modem-color-decoder','optical-modem-tx-worker','optical-modem-tx','optical-modem-worker','optical-modem-rx'])assert.match(sw,new RegExp(name));
});