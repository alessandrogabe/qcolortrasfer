import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const root=path=>new URL(`../${path}`,import.meta.url);
test('UI exposes 1024-byte default, 8-state mode and 20 fps',async()=>{const html=await readFile(root('index.html'),'utf8');assert.match(html,/id="payloadBytes"/);assert.match(html,/value="1024" selected/);assert.match(html,/id="colorMode"/);assert.match(html,/value="8" selected/);assert.match(html,/value="20"/);});
test('receiver has atomic completion guard',async()=>{const js=await readFile(root('js/app.js'),'utf8');assert.match(js,/rxFinalizing/);assert.match(js,/rxComplete/);assert.match(js,/state\.rxFinalizing = true/);});
test('worker exposes two chromatic channel counters',async()=>{const js=await readFile(root('js/qr-worker.js'),'utf8');assert.match(js,/color1Count/);assert.match(js,/color2Count/);assert.match(js,/chromaScoreB/);});
test('service worker cache is rotated to v1.4 triple layer',async()=>{const sw=await readFile(root('sw.js'),'utf8');assert.match(sw,/v1\.4\.0-triple-qr-1024/);});
