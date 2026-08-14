import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeOpticalPacket } from '../js/protocol.js';
import {
  CHROMA_CHUNK_BYTES, CHROMA_QCT_PACKET_BYTES, CHROMA_RAW_BITS, CHROMA_HAMMING_WORDS,
  CHROMA_CODE_BITS, CHROMA_CODE_CELLS, CHROMA_CALIBRATION_CELLS, CHROMA_V40_DATA_MODULES,
  CHROMA_PALETTE, encodeChromaOpticalPacket, isNativeChromaPacket,
  packetToChromaStates, chromaStatesToPacket, rgbForMainColor
} from '../js/chroma-fountain.js';

const root=path=>new URL(`../${path}`,import.meta.url);

test('MAIN COLOR fits one native chroma bit plane beside a real V40 QR',()=>{
  assert.equal(CHROMA_CHUNK_BYTES,2678);
  assert.equal(CHROMA_QCT_PACKET_BYTES,2706);
  assert.equal(CHROMA_RAW_BITS,21648);
  assert.equal(CHROMA_HAMMING_WORDS,1968);
  assert.equal(CHROMA_CODE_BITS,29520);
  assert.equal(CHROMA_CODE_CELLS,29520);
  assert.equal(CHROMA_CODE_CELLS+CHROMA_CALIBRATION_CELLS,CHROMA_V40_DATA_MODULES);
});

test('native chroma QCT2 packet round-trips through one-bit Hamming side plane',()=>{
  const payload=Uint8Array.from({length:CHROMA_CHUNK_BYTES},(_,i)=>(i*73+19)&255);
  const containerLength=CHROMA_CHUNK_BYTES*6+123;
  const meta={streamId:0x1234abcd,sourceCount:Math.ceil(containerLength/CHROMA_CHUNK_BYTES),chunkSize:CHROMA_CHUNK_BYTES,containerLength,visualStates:2};
  const packet=encodeChromaOpticalPacket(meta,91,payload);
  assert.equal(packet.length,CHROMA_QCT_PACKET_BYTES);assert.ok(isNativeChromaPacket(packet));
  const states=packetToChromaStates(packet);assert.equal(states.length,CHROMA_CODE_CELLS);assert.ok(states.every(v=>v===0||v===1));
  const round=chromaStatesToPacket(states);assert.deepEqual(round.bytes,packet);assert.equal(round.corrected,0);
  const decoded=decodeOpticalPacket(round.bytes);assert.equal(decoded.symbolId,91);assert.equal(decoded.chunkSize,CHROMA_CHUNK_BYTES);assert.equal(decoded.visualStates,2);
});

test('interleaved Hamming repairs sparse chroma-bit errors',()=>{
  const payload=Uint8Array.from({length:CHROMA_CHUNK_BYTES},(_,i)=>(i*29+7)&255),containerLength=CHROMA_CHUNK_BYTES+1;
  const meta={streamId:77,sourceCount:Math.ceil(containerLength/CHROMA_CHUNK_BYTES),chunkSize:CHROMA_CHUNK_BYTES,containerLength,visualStates:2};
  const packet=encodeChromaOpticalPacket(meta,5,payload),states=packetToChromaStates(packet);
  for(const index of [0,137,1201,4099,9001,17003,25001])states[index]^=1;
  const repaired=chromaStatesToPacket(states);assert.deepEqual(repaired.bytes,packet);assert.ok(repaired.corrected>=5);
});

test('palette has no yellow and preserves a strong B/W QR luminance split',()=>{
  assert.equal(CHROMA_PALETTE.length,4);assert.equal(new Set(CHROMA_PALETTE.map(rgb=>rgb.join(','))).size,4);
  const luma=rgb=>.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2],score=rgb=>(rgb[2]-rgb[0])/Math.max(1,rgb[0]+rgb[1]+rgb[2]);
  const dark=[rgbForMainColor(true,0),rgbForMainColor(true,1)],light=[rgbForMainColor(false,0),rgbForMainColor(false,1)];
  assert.ok(Math.max(...dark.map(luma))+100<Math.min(...light.map(luma)));
  assert.ok(score(rgbForMainColor(true,0))<0&&score(rgbForMainColor(false,0))<0);
  assert.ok(score(rgbForMainColor(true,1))>0&&score(rgbForMainColor(false,1))>0);
  for(const [r,g,b] of CHROMA_PALETTE)assert.equal(r>160&&g>150&&b<100,false);
});

test('MAIN COLOR TX sends two fountain symbols in one standards-valid colored QR',async()=>{
  const js=await readFile(root('js/tx-chroma-fountain.js'),'utf8');
  assert.match(js,/MAIN COLOR · QR VALIDO \+ CHROMA FAST/);assert.match(js,/encodeChromaOpticalPacket/);assert.match(js,/baseSymbolId/);assert.match(js,/chromaSymbolId/);
  assert.match(js,/2\*selectedFps\(\)/);assert.doesNotMatch(js,/encodeAuxRepairPacket|QAR2/);
});

test('DUAL MAIN COLOR uses two real QR MAINs and four fountain symbols per lane cycle',async()=>{
  const js=await readFile(root('js/tx-dual-main-color.js'),'utf8');
  assert.match(js,/2 MAIN COLOR · QR VALIDO \+ CHROMA FAST EXP/);assert.match(js,/encodeChromaOpticalPacket/);assert.match(js,/CHROMA_CHUNK_BYTES\*2\*LANES\*selectedFps/);
  assert.doesNotMatch(js,/helper|QAR2/i);
});

test('MAIN COLOR RX uses native side decoder and disables legacy C1/C2 after lock',async()=>{
  const worker=await readFile(root('js/chroma/qr-worker.js'),'utf8'),bridge=await readFile(root('js/rx-chroma-worker-bridge.js'),'utf8'),fast=await readFile(root('js/chroma-fast-decoder.js'),'utf8');
  assert.match(worker,/isNativeChromaPacket/);assert.match(worker,/decodeChromaRasterFast/);assert.match(worker,/known region/i);
  assert.match(bridge,/decodeColor:false/);assert.match(bridge,/MAIN COLOR side/);
  assert.match(fast,/chromaStatesToPacket/);assert.doesNotMatch(fast,/readBarcodes|syntheticImage|new ImageData/);
});

test('v3.1 shell and PWA keep MAIN COLOR runtime precached',async()=>{
  const ui=await readFile(root('js/ui-shell.js'),'utf8'),sw=await readFile(root('sw.js'),'utf8');
  assert.match(ui,/rx-chroma-worker-bridge/);assert.match(ui,/tx-chroma-fountain/);assert.match(ui,/tx-dual-main-color/);
  assert.match(sw,/v3\.1\.0-main-color-valid-luma/);assert.match(sw,/\.\/js\/chroma-fountain\.js/);assert.match(sw,/\.\/js\/chroma-fast-decoder\.js/);assert.match(sw,/\.\/js\/chroma\/qr-worker\.js/);
});
