import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CLASSIC_LOOKAHEAD, CLASSIC_QR_MARGIN, CLASSIC_QR_MASK, CLASSIC_QR_ECC,
  classicCanvasMetrics, classicFrameIntervalMs
} from '../js/tx-profile-policy.js';

const root = path => new URL(`../${path}`, import.meta.url);

test('Decimen classic optical constants stay pinned', () => {
  assert.equal(CLASSIC_LOOKAHEAD, 3);
  assert.equal(CLASSIC_QR_MARGIN, 4);
  assert.equal(CLASSIC_QR_MASK, 4);
  assert.equal(CLASSIC_QR_ECC, 'L');
});

test('classic canvas uses an integer physical raster scale without stretch', () => {
  const m = classicCanvasMetrics(185, 390, 700, 3);
  assert.equal(Number.isInteger(m.scale), true);
  assert.equal(m.canvasPixels, 185 * m.scale);
  assert.equal(m.cssPixels * m.dpr, m.canvasPixels);
  assert.equal(m.devicePixelsPerRasterCell, m.scale);
});

test('classic timing follows requested fps', () => {
  assert.ok(Math.abs(classicFrameIntervalMs(24) - 41.6666667) < 0.001);
  assert.ok(Math.abs(classicFrameIntervalMs(60) - 16.6666667) < 0.001);
});

test('classic browser policy keeps multi B/N and color engine available', async () => {
  const js = await readFile(root('js/tx-profile-policy.js'), 'utf8');
  assert.match(js, /DECIMEN CLASSIC/);
  assert.match(js, /QCOLOR MULTI/);
  assert.match(js, /colorMode\.value = 'bw'/);
  assert.match(js, /gridMode\.value = '1'/);
  assert.match(js, /imageSmoothingEnabled = false/);
  assert.match(js, /imageRendering = 'pixelated'/);
  assert.match(js, /now - nextAt > 3 \* interval/);
  assert.match(js, /packFileContainerV2/);
  assert.match(js, /encodeOpticalPacketV2/);
});
