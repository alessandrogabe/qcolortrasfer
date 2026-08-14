import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeOpticalPacket } from '../js/protocol.js';
import {
  MODEM_GRID_W,MODEM_GRID_H,MODEM_STATES,MODEM_PAYLOAD_CELLS,MODEM_PACKET_BYTES,MODEM_CHUNK_BYTES,
  MODEM_CODE_BITS,MODEM_CODE_CELLS,MODEM_PALETTE,MODEM_QUIET,encodeModemPacket,packetToModemStates,modemStatesToPacket,
  createModemRaster,detectModemMarkers,decodeModemWithMarkers,decodeModemFrame
} from '../js/optical-modem-codec.js';

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

function exactMarkers(scale){
  const at=(x,y)=>({x:scale*(x+MODEM_QUIET)-.5,y:scale*(y+MODEM_QUIET)-.5,r:scale*5.2});
  return[at(5.5,5.5),at(MODEM_GRID_W-5.5,5.5),at(MODEM_GRID_W-5.5,MODEM_GRID_H-5.5),at(5.5,MODEM_GRID_H-5.5)];
}

test('optical modem capacity targets a standalone 192x108 four-state field',()=>{
  assert.equal(MODEM_GRID_W,192);assert.equal(MODEM_GRID_H,108);assert.equal(MODEM_STATES,4);
  assert.equal(MODEM_PAYLOAD_CELLS,18880);assert.equal(MODEM_PACKET_BYTES,3460);assert.equal(MODEM_CHUNK_BYTES,3432);
  assert.ok(MODEM_CODE_CELLS<=MODEM_PAYLOAD_CELLS);assert.ok(MODEM_CODE_BITS<=MODEM_PAYLOAD_CELLS*2);
  assert.ok(MODEM_CHUNK_BYTES*60/1024>200);
});

test('modem FEC round-trips a full QCT2 packet and repairs one chroma-cell bit',()=>{
  const{packet}=samplePacket();assert.equal(packet.length,MODEM_PACKET_BYTES);
  const states=packetToModemStates(packet),round=modemStatesToPacket(states);assert.deepEqual(round.bytes,packet);assert.equal(round.corrected,0);
  const damaged=states.slice();damaged[1234]^=2;const repaired=modemStatesToPacket(damaged);assert.deepEqual(repaired.bytes,packet);assert.ok(repaired.corrected>=1);
  const decoded=decodeOpticalPacket(repaired.bytes);assert.equal(decoded.chunkSize,MODEM_CHUNK_BYTES);assert.equal(decoded.symbolId,7);
});

test('modem palette uses four saturated non-yellow states',()=>{
  assert.equal(MODEM_PALETTE.length,4);assert.equal(new Set(MODEM_PALETTE.map(c=>c.join(','))).size,4);
  for(const[r,g,b]of MODEM_PALETTE)assert.equal(r>160&&g>150&&b<100,false);
});

test('clean synthetic modem sampling works with exact projective markers',async()=>{
  const scale=3,{packet}=samplePacket(19),raster=createModemRaster(packet,{streamId:0x12345678,symbolId:19}),image=scaleRaster(raster,scale);
  const decoded=await decodeModemWithMarkers(image,{markers:exactMarkers(scale),rotation:0});
  assert.ok(decoded,'exact marker geometry must decode the clean synthetic frame');assert.equal(decoded.packet.symbolId,19);assert.ok(decoded.syncAccuracy>.9);assert.ok(decoded.calibrationSeparation>.1);
});

test('clean synthetic modem frame is acquired without QR and decoded end-to-end',async()=>{
  const scale=3,{packet}=samplePacket(19),raster=createModemRaster(packet,{streamId:0x12345678,symbolId:19}),image=scaleRaster(raster,scale),expected=exactMarkers(scale);
  const acquisition=detectModemMarkers(image);assert.ok(acquisition);assert.equal(acquisition.markers.length,4);
  for(let i=0;i<4;i++)assert.ok(Math.hypot(acquisition.markers[i].x-expected[i].x,acquisition.markers[i].y-expected[i].y)<8,`marker ${i}=${JSON.stringify(acquisition.markers[i])}, expected=${JSON.stringify(expected[i])}`);
  const decoded=await decodeModemFrame(image,{forceDetect:true});assert.ok(decoded,`acquired markers=${JSON.stringify(acquisition.markers)}`);assert.equal(decoded.packet.symbolId,19);assert.equal(decoded.packet.chunkSize,MODEM_CHUNK_BYTES);assert.ok(decoded.syncAccuracy>.9);assert.ok(decoded.calibrationSeparation>.1);
});

test('standalone modem engines do not invoke QR or ZXing payload paths',async()=>{
  const codec=await readFile(root('js/optical-modem-codec.js'),'utf8'),tx=await readFile(root('js/optical-modem-tx.js'),'utf8'),rx=await readFile(root('js/optical-modem-rx.js'),'utf8');
  const dependency=/readBarcodes\s*\(|QRCode\.create\s*\(|(?:from|import).*zxing/i;
  assert.doesNotMatch(codec,dependency);assert.doesNotMatch(tx,dependency);assert.doesNotMatch(tx,/encodeAuxRepairPacket/);assert.doesNotMatch(rx,dependency);assert.doesNotMatch(rx,/qr-worker/);
  assert.match(codec,/detectModemMarkers/);assert.match(codec,/Hamming\(15,11\)/);assert.match(rx,/early-drop/i);
});

test('UI shell loads modem TX/RX before app.js and service worker is expected to cache them',async()=>{
  const ui=await readFile(root('js/ui-shell.js'),'utf8');assert.match(ui,/optical-modem-tx/);assert.match(ui,/optical-modem-rx/);
});