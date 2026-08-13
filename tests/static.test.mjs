import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CAPACITY_BYTES, MAX_GRID_CODES, VISUAL_STATES_MONO, VISUAL_STATES_4, VISUAL_STATES_8 } from '../js/optical.js';
import { MAX_HIGH_THROUGHPUT_CHUNK } from '../js/high-throughput.js';
const root=path=>new URL(`../${path}`,import.meta.url);

test('V40-L envelope exposes 2925-byte QCT2 fountain payload',()=>{
  assert.equal(CAPACITY_BYTES,2953); assert.equal(MAX_HIGH_THROUGHPUT_CHUNK,2925);
});

test('home launcher exposes send receive views and keeps detailed telemetry',async()=>{
  const html=await readFile(root('index.html'),'utf8');
  assert.match(html,/id="homeView"/); assert.match(html,/id="workspaceView"/);
  assert.match(html,/id="goTx"/); assert.match(html,/id="goRx"/);
  assert.match(html,/class="ascii-logo"/); assert.match(html,/id="txFrame"/); assert.match(html,/id="rxStats"/);
  assert.match(html,/DIAGNOSTICA E STATISTICHE DETTAGLIATE/); assert.match(html,/\.\/js\/ui-shell\.js/);
});

test('UI exposes B/W baseline plus color modes, with 24 fps and AUTO 4/6',async()=>{
  const html=await readFile(root('index.html'),'utf8');
  assert.match(html,/value="2925" selected/); assert.match(html,/value="bw">B\/N · 1 canale BASELINE/);
  assert.match(html,/value="4" selected>4 stati · 2 canali HIGH THROUGHPUT/);
  assert.match(html,/value="4a">4 stati · 2 canali ADAPTIVE fallback/); assert.match(html,/value="8">8 stati · 3 canali EXP/);
  assert.match(html,/value="24" selected/); assert.match(html,/value="60">60 MAX/); assert.match(html,/AUTO 4\/6/);
  const grid=html.match(/<select id="gridMode">([\s\S]*?)<\/select>/)?.[1] || '';
  assert.match(grid,/value="auto" selected/); assert.match(grid,/value="4"/); assert.match(grid,/value="6"/);
  assert.doesNotMatch(grid,/value="1"/); assert.doesNotMatch(grid,/value="2"/);
  assert.equal(MAX_GRID_CODES,6); assert.equal(VISUAL_STATES_MONO,2); assert.equal(VISUAL_STATES_4,4); assert.equal(VISUAL_STATES_8,8);
});

test('fullscreen shell contains only TX stage and compact ordered controls',async()=>{
  const html=await readFile(root('index.html'),'utf8');
  const shell=html.match(/<div id="txFullscreenShell"[\s\S]*?<\/div>\s*<div id="txFrame"/)?.[0] || '';
  assert.match(shell,/id="txStage"/); assert.match(shell,/id="txFsControls"/);
  const start=shell.indexOf('id="fsStartTx"'), stop=shell.indexOf('id="fsStopTx"'), reset=shell.indexOf('id="fsResetTx"'), exit=shell.indexOf('id="fsExitTx"');
  assert.ok(start>=0&&start<stop&&stop<reset&&reset<exit);
  const css=await readFile(root('styles.css'),'utf8');
  assert.match(css,/tx-fullscreen-shell:fullscreen/); assert.match(css,/immersive-fallback/); assert.match(css,/overflow:hidden/); assert.match(css,/\.fs-start/);
});

test('UI shell switches modes through existing controls',async()=>{
  const js=await readFile(root('js/ui-shell.js'),'utf8');
  assert.match(js,/showAppView/); assert.match(js,/stopInactiveEngines/);
  assert.match(js,/stopTx/); assert.match(js,/stopRx/); assert.match(js,/dispatchEvent/);
});

test('PWA manifest keeps relative GitHub Pages paths',async()=>{
  const manifest=JSON.parse(await readFile(root('manifest.webmanifest'),'utf8')); assert.equal(manifest.start_url,'./'); assert.equal(manifest.scope,'./'); const sizes=new Set(manifest.icons.map(icon=>icon.sizes)); assert.ok(sizes.has('192x192')); assert.ok(sizes.has('512x512'));
});

test('app wires mono/color QCT2, fullscreen controls, lookahead and atomic RX finalization',async()=>{
  const js=await readFile(root('js/app.js'),'utf8');
  assert.match(js,/packFileContainerV2/); assert.match(js,/encodeOpticalPacketV2/); assert.match(js,/unpackFileContainerV2/);
  assert.match(js,/channelsForVisualStates/); assert.match(js,/createQrRaster/); assert.match(js,/mode==='bw'\?2/);
  assert.match(js,/txFullscreenShell/); assert.match(js,/requestFullscreen/); assert.match(js,/immersive-fallback/); assert.match(js,/fsResetTx/);
  assert.match(js,/pumpTxQueue/); assert.match(js,/startHighThroughputLoop/); assert.match(js,/requestAnimationFrame/); assert.match(js,/TX_LOOKAHEAD_PER_SLOT/);
  assert.match(js,/rxFinalizing/); assert.match(js,/rxComplete/); assert.match(js,/state\.rxFinalizing=true/);
  assert.match(js,/RX_CAPTURE_WIDTH = 1280/); assert.match(js,/workerCountForHardware/); assert.match(js,/state\.rxMeta\?\.visualStates!==2/);
});

test('worker uses fast crop options and pure synthetic color decode',async()=>{
  const js=await readFile(root('js/qr-worker.js'),'utf8');
  assert.match(js,/CROP_OPTIONS/); assert.match(js,/tryHarder: false/); assert.match(js,/tryRotate: false/); assert.match(js,/tryDownscale: false/);
  assert.match(js,/PURE_OPTIONS/); assert.match(js,/isPure: true/); assert.match(js,/FixedThreshold/); assert.match(js,/returnErrors: true/);
});

test('TX raster worker supports ordinary mono and layered color QR',async()=>{
  const js=await readFile(root('js/tx-worker.js'),'utf8');
  assert.match(js,/createQrRaster/); assert.match(js,/createDualQrRaster/); assert.match(js,/createTripleQrRaster/);
  assert.match(js,/visualStates === 2/); assert.match(js,/pixels\.buffer/);
});

test('service worker precaches complete v2.2 mono/fullscreen runtime',async()=>{
  const sw=await readFile(root('sw.js'),'utf8');
  assert.match(sw,/v2\.2\.0-mono-fullscreen/); assert.match(sw,/\.\/js\/ui-shell\.js/);
  assert.match(sw,/\.\/js\/high-throughput\.js/); assert.match(sw,/\.\/js\/tx-worker\.js/); assert.match(sw,/\.\/js\/rx-roi\.js/); assert.match(sw,/\.\/js\/qr-worker\.js/);
});
