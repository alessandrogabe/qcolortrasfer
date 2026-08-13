import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CAPACITY_BYTES, MAX_GRID_CODES, VISUAL_STATES, COLOR_MODE } from '../js/optical.js';
const root = path => new URL(`../${path}`, import.meta.url);

test('current QCT1 + 512-byte fountain payload fits conservative QR capacity', () => {
  assert.ok(CAPACITY_BYTES >= 96 + 512 + 4);
});

test('4-color dual-channel product surface is wired in the page', async () => {
  const html = await readFile(root('index.html'), 'utf8');
  assert.match(html, /4 COLORI/);
  assert.match(html, /2 CANALI \/ QR/);
  assert.match(html, /id="gridMode"/);
  assert.match(html, /value="6"/);
  assert.equal(MAX_GRID_CODES, 6);
  assert.equal(VISUAL_STATES, 4);
  assert.equal(COLOR_MODE, 'dual-qr-4color-v1');
});

test('PWA manifest keeps relative GitHub Pages paths', async () => {
  const manifest = JSON.parse(await readFile(root('manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  const sizes = new Set(manifest.icons.map(icon => icon.sizes));
  assert.ok(sizes.has('192x192'));
  assert.ok(sizes.has('512x512'));
});

test('service worker precaches color decoder and uses rotated cache', async () => {
  const sw = await readFile(root('sw.js'), 'utf8');
  assert.match(sw, /v1\.3\.0-dual-qr-color/);
  assert.match(sw, /\.\/js\/color-code\.js/);
  assert.match(sw, /\.\/js\/qr-worker\.js/);
  assert.match(sw, /\.\/js\/fountain\.js/);
});
