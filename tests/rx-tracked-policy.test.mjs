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

test('worker refined tracked path runs before ordinary crop fallback',async()=>{
  const js=await readFile(root('js/qr-worker.js'),'utf8');
  assert.match(js,/sampleTrackedQrCandidates/);assert.match(js,/tryTrackedBase/);assert.match(js,/trackedAttempted=true/);assert.match(js,/if\(!trackedHit\)/);assert.match(js,/isPure: true/);assert.match(js,/refinedGlobal/);
});

test('browser bridge forwards geometry, tracks QAR2 rank and requests capability-gated focus',async()=>{
  const js=await readFile(root('js/rx-performance-policy.js'),'utf8');
  assert.match(js,/trackedQuad:geometry\.quad/);assert.match(js,/trackedModules:geometry\.modules/);assert.match(js,/AuxRepairAssembler/);assert.match(js,/findCompatibleFountainDecoder/);assert.match(js,/injectSourceBlock/);assert.match(js,/auxRankPeak/);assert.match(js,/focusMode:'continuous'/);
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

test('PWA v2.8 precaches refined sampler, QAR2 runtime and RX overlay',async()=>{
  const sw=await readFile(root('sw.js'),'utf8');assert.match(sw,/v2\.8\.0/);assert.match(sw,/\.\/js\/tracked-qr\.js/);assert.match(sw,/\.\/js\/tx-profile-policy\.js/);assert.match(sw,/\.\/js\/tx-aux-repair-v2\.js/);assert.match(sw,/\.\/js\/rx-detection-overlay\.js/);assert.match(sw,/\.\/js\/aux-repair\.js/);
});
