import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CAPACITY_BYTES } from '../js/optical.js';
import { HEADER_BYTES } from '../js/protocol.js';

test('optical capacity fits current protocol payload', () => { assert.ok(CAPACITY_BYTES >= HEADER_BYTES + 320 + 4); });
test('PWA manifest has installability fields and relative paths', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
  assert.ok(manifest.name || manifest.short_name); assert.equal(manifest.start_url, './'); assert.equal(manifest.scope, './'); assert.ok(['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display));
  const sizes = new Set(manifest.icons.map(icon => icon.sizes)); assert.ok(sizes.has('192x192')); assert.ok(sizes.has('512x512')); for (const icon of manifest.icons) assert.ok(icon.src.startsWith('./'));
});
test('index references manifest and service worker precaches app', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8'); const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/); assert.match(html, /js\/app\.js/); assert.match(sw, /\.\/manifest\.webmanifest/); assert.match(sw, /\.\/js\/app\.js/);
});
