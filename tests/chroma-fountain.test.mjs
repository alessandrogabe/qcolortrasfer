import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { encodeOpticalPacketV2, decodeOpticalPacket } from '../js/protocol.js';
import {
  CHROMA_CHUNK_BYTES, CHROMA_QCT_PACKET_BYTES, CHROMA_RAW_BITS, CHROMA_HAMMING_WORDS,
  CHROMA_CODE_BITS, CHROMA_CODE_CELLS, CHROMA_CALIBRATION_CELLS, CHROMA_V40_DATA_MODULES,
  CHROMA_PALETTE, packetToChromaStates, chromaStatesToPacket
} from '../js/chroma-fountain.js';
import { buildCorrectionField } from '../js/chroma-fast-decoder.js';

const root=path=>new URL(`../${path}`,import.meta.url);

function adjacentPalette(state){return [1,0,3,2][state];}

test('CHROMA FOUNTAIN fills one V40 data plane exactly after calibration and Hamming',()=>{
  assert.equal(CHROMA_CHUNK_BYTES,5384);assert.equal(CHROMA_QCT_PACKET_BYTES,5412);assert.equal(CHROMA_RAW_BITS,43296);
  assert.equal(CHROMA_HAMMING_WORDS,3936);assert.equal(CHROMA_CODE_BITS,59040);assert.equal(CHROMA_CODE_CELLS,29520);
  assert.equal(CHROMA_CODE_CELLS+CHROMA_CALIBRATION_CELLS,CHROMA_V40_DATA_MODULES);
});

test('QCT2 packet round-trips through four-color Hamming cells',()=>{
  const payload=Uint8Array.from({length:CHROMA_CHUNK_BYTES},(_,i)=>(i*73+19)&255);
  const meta={streamId:0x1234abcd,sourceCount:7,chunkSize:CHROMA_CHUNK_BYTES,containerLength:CHROMA_CHUNK_BYTES*6+123,visualStates:2};
  meta.sourceCount=Math.ceil(meta.containerLength/meta.chunkSize);
  const packet=encodeOpticalPacketV2(meta,91,payload);assert.equal(packet.length,CHROMA_QCT_PACKET_BYTES);
  const states=packetToChromaStates(packet);assert.equal(states.length,CHROMA_CODE_CELLS);
  const round=chromaStatesToPacket(states);assert.deepEqual(round.bytes,packet);assert.equal(round.corrected,0);
  const decoded=decodeOpticalPacket(round.bytes);assert.equal(decoded.symbolId,91);assert.equal(decoded.chunkSize,CHROMA_CHUNK_BYTES);
});

test('interleaved Hamming repairs sparse one-bit color-cell errors',()=>{
  const payload=Uint8Array.from({length:CHROMA_CHUNK_BYTES},(_,i)=>(i*29+7)&255);
  const meta={streamId:77,sourceCount:2,chunkSize:CHROMA_CHUNK_BYTES,containerLength:CHROMA_CHUNK_BYTES+1,visualStates:2};
  const packet=encodeOpticalPacketV2(meta,5,payload),states=packetToChromaStates(packet);
  for(const index of [0,137,1201,4099,9001,17003,25001])states[index]=adjacentPalette(states[index]);
  const repaired=chromaStatesToPacket(states);assert.deepEqual(repaired.bytes,packet);assert.ok(repaired.corrected>=5);
});

test('production palette has four distinct states and deliberately contains no yellow',()=>{
  assert.equal(CHROMA_PALETTE.length,4);assert.equal(new Set(CHROMA_PALETTE.map(rgb=>rgb.join(','))).size,4);
  for(const [r,g,b] of CHROMA_PALETTE)assert.equal(r>160&&g>150&&b<100,false);
});

test('direct CHROMA decoder contains no synthetic QR or ZXing payload path',async()=>{
  const js=await readFile(root('js/chroma-fast-decoder.js'),'utf8');
  assert.match(js,/chromaStatesToPacket/);assert.match(js,/decodeOpticalPacket/);assert.match(js,/CHROMA_CODE_CELLS/);
  assert.doesNotMatch(js,/readBarcodes|syntheticImage|new ImageData/);
  const field=buildCorrectionField([{mx:20,my:20,dx:1,dy:-1}],177,10);assert.equal(field.cells,10);assert.equal(field.values.length,200);
});

test('CHROMA worker moves phase lock into worker and can acquire two MAIN matrices',async()=>{
  const js=await readFile(root('js/chroma/qr-worker.js'),'utf8');
  assert.match(js,/refineTrackedPhase/);assert.match(js,/decodeChromaRasterFast/);assert.match(js,/customs\.length>=2/);
  assert.match(js,/slice\(0,4\)/);assert.match(js,/chromaFastCount/);assert.match(js,/const base=await runBase/);
});

test('single CHROMA TX remains available and has no AUX dependency',async()=>{
  const js=await readFile(root('js/tx-chroma-fountain.js'),'utf8');
  assert.match(js,/CHROMA FOUNTAIN · 4 COLORI \+ B\/N EXP/);assert.match(js,/CHROMA_CHUNK_BYTES/);assert.match(js,/DEFAULT_FPS=60/);
  assert.doesNotMatch(js,/encodeAuxRepairPacket|QAR2/);
});

test('v3 adds two independent MAIN CHROMA lanes with stagger and no helper',async()=>{
  const js=await readFile(root('js/tx-dual-main-color.js'),'utf8');
  assert.match(js,/LANES=2/);assert.match(js,/2 MAIN CHROMA · 4 COLORI FAST EXP/);assert.match(js,/DEFAULT_FPS=30/);
  assert.match(js,/1000\/\(selectedFps\(\)\*LANES\)/);assert.match(js,/CHROMA_CHUNK_BYTES\*LANES\*selectedFps\(\)/);
  assert.doesNotMatch(js,/encodeAuxRepairPacket|QAR2|txAuxLayer/);
});

test('v3 shell loads RX gates before policy and exposes both CHROMA TX modes',async()=>{
  const ui=await readFile(root('js/ui-shell.js'),'utf8'),sw=await readFile(root('sw.js'),'utf8');
  const runtime=ui.indexOf("import './rx-v3-runtime.js'");const policy=ui.indexOf("import './rx-performance-policy.js'");
  assert.ok(runtime>=0&&policy>runtime);assert.match(ui,/rx-chroma-worker-bridge/);assert.match(ui,/tx-chroma-fountain/);assert.match(ui,/tx-dual-main-color/);
  assert.match(sw,/v3\.0\.0-dual-main-color-fast-rx/);assert.match(sw,/\.\/js\/chroma-fast-decoder\.js/);assert.match(sw,/\.\/js\/tx-dual-main-color\.js/);
});
