import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  RX_ACQUIRE_WIDTH_TARGET, RX_ACQUIRE_HEIGHT_TARGET, RX_WORKER_TARGET_MAX,
  desiredRxWorkerTarget, upgradeVideoConstraints
} from '../js/rx-performance-policy.js';

const root = path => new URL(`../${path}`, import.meta.url);

test('RX v2.6 keeps Decimen-like 1280 capture and four-worker default', () => {
  assert.equal(RX_ACQUIRE_WIDTH_TARGET, 1280);
  assert.equal(RX_ACQUIRE_HEIGHT_TARGET, 960);
  assert.equal(RX_WORKER_TARGET_MAX, 4);
  assert.equal(desiredRxWorkerTarget(2), 2);
  assert.equal(desiredRxWorkerTarget(3), 3);
  assert.equal(desiredRxWorkerTarget(4), 4);
  assert.equal(desiredRxWorkerTarget(8), 4);
});

test('performance policy does not inflate app 1280 capture to 1920', () => {
  const constraints = { video: { width:{ideal:1280}, height:{ideal:960}, frameRate:{exact:60} } };
  assert.equal(upgradeVideoConstraints(constraints), constraints);
});

test('worker hot path attempts tracked pure decode before ordinary crop fallback', async () => {
  const js = await readFile(root('js/qr-worker.js'), 'utf8');
  assert.match(js, /sampleTrackedQr/);
  assert.match(js, /tryTrackedBase/);
  assert.match(js, /trackedAttempted=true/);
  assert.match(js, /if\(!trackedHit\)/);
  assert.match(js, /PURE_OPTIONS/);
  assert.match(js, /isPure: true/);
});

test('browser bridge forwards cached geometry and injects completed AUX blocks', async () => {
  const js = await readFile(root('js/rx-performance-policy.js'), 'utf8');
  assert.match(js, /trackedQuad: geometry\.quad/);
  assert.match(js, /trackedModules: geometry\.modules/);
  assert.match(js, /AuxRepairAssembler/);
  assert.match(js, /findCompatibleFountainDecoder/);
  assert.match(js, /injectSourceBlock/);
  assert.match(js, /rxTrackedStats/);
  assert.match(js, /AUX pkt/);
});

test('multi QR optical view keeps smooth final CSS scaling while Classic and AUX remain pixel-exact', async () => {
  const css = await readFile(root('tx-flow.css'), 'utf8');
  assert.match(css, /body\[data-tx-method="multi"\]/);
  assert.match(css, /image-rendering:auto!important/);
  assert.match(css, /#txAuxCanvas/);
  assert.match(css, /image-rendering:pixelated/);
  const classic = await readFile(root('js/tx-profile-policy.js'), 'utf8');
  assert.match(classic, /canvas\.style\.imageRendering = 'pixelated'/);
});

test('PWA v2.6.1 precaches tracked sampler, Classic policy and AUX runtime', async () => {
  const sw = await readFile(root('sw.js'), 'utf8');
  assert.match(sw, /v2\.6\.1-aux-fixed-geometry/);
  assert.match(sw, /\.\/js\/tracked-qr\.js/);
  assert.match(sw, /\.\/js\/tx-profile-policy\.js/);
  assert.match(sw, /\.\/js\/tx-aux-repair\.js/);
  assert.match(sw, /\.\/js\/aux-repair\.js/);
});
