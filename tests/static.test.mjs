import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CAPACITY_BYTES, MAX_GRID_CODES, VISUAL_STATES_4, VISUAL_STATES_8 } from '../js/optical.js';
const root=path=>new URL(`../${path}`,import.meta.url);

test('1280-byte fountain payload fits conservative QR capacity',()=>{assert.ok(CAPACITY_BYTES>=96+1280+4);});

test('UI exposes 1024-byte default, adaptive 4-state default, 8-state experiment and 20 fps target',async()=>{
  const html=await readFile(root('index.html'),'utf8');
  assert.match(html,/id="payloadBytes"/); assert.match(html,/value="1024" selected/);
  assert.match(html,/id="colorMode"/); assert.match(html,/value="4a" selected/); assert.match(html,/4 stati · 2 canali ADAPTIVE/); assert.match(html,/value="8"/);
  assert.match(html,/value="8" selected>8<\/option>/); assert.match(html,/value="20"/); assert.match(html,/id="gridMode"/); assert.match(html,/value="6"/);
  assert.equal(MAX_GRID_CODES,6); assert.equal(VISUAL_STATES_4,4); assert.equal(VISUAL_STATES_8,8);
});

test('PWA manifest keeps relative GitHub Pages paths',async()=>{
  const manifest=JSON.parse(await readFile(root('manifest.webmanifest'),'utf8')); assert.equal(manifest.start_url,'./'); assert.equal(manifest.scope,'./'); const sizes=new Set(manifest.icons.map(icon=>icon.sizes)); assert.ok(sizes.has('192x192')); assert.ok(sizes.has('512x512'));
});

test('receiver has atomic completion guard',async()=>{const js=await readFile(root('js/app.js'),'utf8');assert.match(js,/rxFinalizing/);assert.match(js,/rxComplete/);assert.match(js,/state\.rxFinalizing = true/);});

test('adaptive scheduler is wired into app and documented as one-way transmitter adaptation',async()=>{
  const js=await readFile(root('js/app.js'),'utf8'); const html=await readFile(root('index.html'),'utf8');
  assert.match(js,/adaptiveDwellMs/); assert.match(js,/adaptiveNextPaintAt/); assert.match(js,/txCellPaintedAt/); assert.match(js,/isAdaptiveMode/);
  assert.match(html,/non esiste un canale di ritorno/i); assert.match(html,/finestra stabile/i);
});

test('worker exposes two chromatic channel counters',async()=>{const js=await readFile(root('js/qr-worker.js'),'utf8');assert.match(js,/color1Count/);assert.match(js,/color2Count/);assert.match(js,/chromaScoreB/);});

test('service worker precaches adaptive runtime and uses v1.5 cache',async()=>{const sw=await readFile(root('sw.js'),'utf8');assert.match(sw,/v1\.5\.0-adaptive-4state/);assert.match(sw,/\.\/js\/adaptive-scheduler\.js/);assert.match(sw,/\.\/js\/color-code\.js/);assert.match(sw,/\.\/js\/qr-worker\.js/);assert.match(sw,/\.\/js\/fountain\.js/);});
