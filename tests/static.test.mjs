import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CAPACITY_BYTES, QR_ECC } from '../js/optical.js';
import { HEADER_BYTES } from '../js/protocol.js';

test('QCT1 320-byte fountain payload fits QR baseline', () => {
  assert.ok(CAPACITY_BYTES >= HEADER_BYTES + 320 + 4);
  assert.equal(QR_ECC, 'L');
});

test('PWA references QR worker and trusted decoder sources', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../js/qr-worker.js', import.meta.url), 'utf8');
  assert.match(html, /https:\/\/esm\.sh/);
  assert.match(html, /https:\/\/cdn\.jsdelivr\.net/);
  assert.match(app, /qr-worker\.js/);
  assert.match(worker, /zxing-wasm@2\.0\.0/);
  assert.match(sw, /decimen-qr-baseline/);
});
