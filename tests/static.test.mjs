import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CAPACITY_BYTES, MAX_GRID_CODES, VISUAL_STATES_4, VISUAL_STATES_8 } from '../js/optical.js';
const root=path=>new URL(`../${path}`,import.meta.url);

test('1280-byte fountain payload fits conservative QR capacity',()=>{assert.ok(CAPACITY_BYTES>=96+1280+4);});

test('UI exposes 1024-byte default, 8-state mode, 20 fps and full grid selector',async()=>{
  const html=await readFile(root('index.html'),'utf8');
  assert.match(html,/id="payloadBytes"/); assert.match(html,/value="1024" selected/); assert.match(html,/id="colorMode"/); assert.match(html,/value="8" selected/); assert.match(html,/value="20"/); assert.match(html,/id="gridMode"/); assert.match(html,/value="6"/);
  assert.equal(MAX_GRID_CODES,6); assert.equal(VISUAL_STATES_4,4); assert.equal(VISUAL_STATES_8,8);
});

test('PWA manifest keeps relative GitHub Pages paths',async()=>{
  const manifest=JSON.parse(await readFile(root('manifest.webmanifest'),'utf8')); assert.equal(manifest.start_url,'./'); assert.equal(manifest.scope,'./'); const sizes=new Set(manifest.icons.map(icon=>icon.sizes)); assert.ok(sizes.has('192x192')); assert.ok(sizes.has('512x512'));
});

test('receiver has atomic completion guard',async()=>{const js=await readFile(root('js/app.js'),'utf8');assert.match(js,/rxFinalizing/);assert.match(js,/rxComplete/);assert.match(js,/state\.rxFinalizing = true/);});

test('worker exposes two chromatic channel counters',async()=>{const js=await readFile(root('js/qr-worker.js'),'utf8');assert.match(js,/color1Count/);assert.match(js,/color2Count/);assert.match(js,/chromaScoreB/);});

test('service worker precaches color runtime and uses v1.4 cache',async()=>{const sw=await readFile(root('sw.js'),'utf8');assert.match(sw,/v1\.4\.0-triple-qr-1024/);assert.match(sw,/\.\/js\/color-code\.js/);assert.match(sw,/\.\/js\/qr-worker\.js/);assert.match(sw,/\.\/js\/fountain\.js/);});
