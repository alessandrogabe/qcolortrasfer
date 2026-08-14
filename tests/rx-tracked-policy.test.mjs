import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  RX_ACQUIRE_WIDTH_TARGET, RX_ACQUIRE_HEIGHT_TARGET, RX_WORKER_TARGET_MAX,
  desiredRxWorkerTarget, upgradeVideoConstraints
} from '../js/rx-performance-policy.js';
import { containVideoTransform, mapVideoPoint, RX_OVERLAY_FRAME_MS, overlayEligibleDetection } from '../js/rx-detection-overlay.js';

const root = path => new URL(`../${path}`, import.meta.url);

test('RX keeps 1280 capture and four-worker default', () => {
  assert.equal(RX_ACQUIRE_WIDTH_TARGET,1280);assert.equal(RX_ACQUIRE_HEIGHT_TARGET,960);assert.equal(RX_WORKER_TARGET_MAX,4);
  assert.equal(desiredRxWorkerTarget(2),2);assert.equal(desiredRxWorkerTarget(3),3);assert.equal(desiredRxWorkerTarget(4),4);assert.equal(desiredRxWorkerTarget(8),4);
});

test('performance policy does not inflate app 1280 capture to 1920',()=>{
  const constraints={video:{width:{ideal:1280},height:{ideal:960},frameRate:{exact:60}}};assert.equal(upgradeVideoConstraints(constraints),constraints);
});

test('v3 browser bridge forwards cached geometry without main-thread phase work',async()=>{
  const js=await readFile(root('js/rx-performance-policy.js'),'utf8');
  assert.doesNotMatch(js,/refineTrackedPhase/);assert.doesNotMatch(js,/phaseLockedGeometry/);
  assert.match(js,/trackedQuad: geometry\.quad/);assert.match(js,/trackedModules: geometry\.modules/);
  assert.match(js,/__QCOLOR_RX_WARM_ACQUIRE = false/);assert.match(js,/__QCOLOR_RX_QR_BUSY/);
  assert.match(js,/AuxRepairAssembler/);assert.match(js,/findCompatibleFountainDecoder/);assert.match(js,/injectSourceBlock/);assert.match(js,/focusMode: 'continuous'/);
});

test('phase refinement is owned by worker wrapper and known CHROMA can bypass ZXing',async()=>{
  const js=await readFile(root('js/chroma/qr-worker.js'),'utf8');
  assert.match(js,/refineTrackedPhase/);assert.match(js,/phaseLockEvent/);assert.match(js,/PHASE_EVERY_CHROMA_CROPS = 4/);
  assert.match(js,/if\(hinted\)/);assert.match(js,/decodeChromaRasterFast/);assert.match(js,/const base=await runBase/);
});

test('camera runtime tries 60 ideal before app fallback and gates saturated frame callbacks',async()=>{
  const js=await readFile(root('js/rx-v3-runtime.js'),'utf8');
  assert.match(js,/cloneVideoWithFrameRate\(constraints, \{ ideal: 60 \}\)/);
  assert.match(js,/__QCOLOR_CAMERA_NEGOTIATION = '60 ideal'/);
  assert.match(js,/busy >= pool/);assert.match(js,/__QCOLOR_RX_EARLY_DROPS/);
  const exactAt=js.indexOf("__QCOLOR_CAMERA_NEGOTIATION = '60 exact'");
  const idealAt=js.indexOf("__QCOLOR_CAMERA_NEGOTIATION = '60 ideal'");
  assert.ok(exactAt>=0&&idealAt>exactAt);
});

test('green RX overlay maps camera geometry through object-fit contain and is throttled',()=>{
  const t=containVideoTransform(400,400,1280,720);assert.equal(t.scale,.3125);assert.equal(t.offsetX,0);assert.equal(t.offsetY,87.5);assert.deepEqual(mapVideoPoint({x:640,y:360},t),{x:200,y:200});assert.ok(RX_OVERLAY_FRAME_MS>=33);
});

test('RX overlay shows only decode-proven geometry and never performs camera/decode work',async()=>{
  const quad={topLeft:{x:0,y:0},topRight:{x:1,y:0},bottomRight:{x:1,y:1},bottomLeft:{x:0,y:1}};
  assert.ok(overlayEligibleDetection({decoded:true,quad}));assert.equal(Boolean(overlayEligibleDetection({decoded:false,quad})),false);
  const js=await readFile(root('js/rx-detection-overlay.js'),'utf8');assert.match(js,/event\.data\?\.detections/);assert.doesNotMatch(js,/getImageData|readBarcodes|drawImage\(video/);
});

test('multi QR optical view keeps smooth CSS scaling while Classic remains pixel-exact',async()=>{
  const css=await readFile(root('tx-flow.css'),'utf8');assert.match(css,/body\[data-tx-method="multi"\]/);assert.match(css,/image-rendering:auto!important/);
  const classic=await readFile(root('js/tx-profile-policy.js'),'utf8');assert.match(classic,/canvas\.style\.imageRendering = 'pixelated'/);
});

test('PWA v3 precaches runtime gates, dual MAIN and direct CHROMA decoder',async()=>{
  const sw=await readFile(root('sw.js'),'utf8');
  assert.match(sw,/v3\.0\.0-dual-main-color-fast-rx/);assert.match(sw,/\.\/js\/rx-v3-runtime\.js/);
  assert.match(sw,/\.\/js\/tx-dual-main-color\.js/);assert.match(sw,/\.\/js\/chroma-fast-decoder\.js/);
  assert.match(sw,/\.\/js\/tracked-phase\.js/);assert.match(sw,/\.\/js\/rx-detection-overlay\.js/);
});
