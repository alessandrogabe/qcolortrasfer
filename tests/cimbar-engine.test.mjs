import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = path => new URL(`../${path}`, import.meta.url);
const VENDOR = 'vendor/libcimbar/v0.6.7c';

async function text(path) { return readFile(root(path), 'utf8'); }
async function sha256(path) {
  const bytes = await readFile(root(path));
  return createHash('sha256').update(bytes).digest('hex');
}

test('official libcimbar v0.6.7c Web/WASM runtime is vendored byte-for-byte', async () => {
  assert.equal(await sha256(`${VENDOR}/cimbar_js.2026-07-13T0523.wasm`), '4b10483127d403ea3873ee751454afdc5d42eb5818f8b02e4c2ed0d49e2072ec');
  assert.equal(await sha256(`${VENDOR}/cimbar_js.2026-07-13T0523.js`), 'cc14cec5d982107b5bcdf02cdd254a8c01496c9b8833f02684c7ed8b90ba1d09');
  assert.equal((await stat(root(`${VENDOR}/cimbar_js.2026-07-13T0523.wasm`))).size, 1938521);
});

test('vendored sender and receiver remain the official self-contained pages', async () => {
  const sender = await text(`${VENDOR}/index.html`);
  const receiver = await text(`${VENDOR}/recv.html`);
  assert.match(sender, /main\.2026-07-13T0523\.js/);
  assert.match(sender, /cimbar_js\.2026-07-13T0523\.js/);
  assert.match(receiver, /recv\.2026-07-13T0523\.js/);
  assert.match(receiver, /recv-worker\.2026-07-13T0523\.js|Recv\.init_ww\(4\)/);
  assert.match(receiver, /zstd\.2026-07-13T0523\.js/);
  assert.match(receiver, /cimbar_js\.2026-07-13T0523\.js/);
});

test('qcolor adapter uses the exact same-origin libcimbar pages and native APIs', async () => {
  const adapter = await text('js/cimbar-engine.js');
  assert.match(adapter, /vendor\/libcimbar\/v0\.6\.7c/);
  assert.match(adapter, /CIMBAR ENGINE · LIBCIMBAR WASM v0\.6\.7c/);
  assert.match(adapter, /Main\.importFile\(file\)/);
  assert.match(adapter, /Main\.setMode\(CIMBAR_DEFAULT_MODE\)/);
  assert.match(adapter, /Main\.setFPS\(CIMBAR_DEFAULT_FPS\)/);
  assert.match(adapter, /Sink\.on_decode/);
  assert.match(adapter, /Zstd\.download_blob/);
  assert.doesNotMatch(adapter, /https:\/\/cimbar\.org/);
  assert.doesNotMatch(adapter, /https:\/\/re\.cimbar\.org/);
});

test('MPL source and exact release provenance are shipped with the runtime', async () => {
  const notice = await text('vendor/libcimbar/SOURCE-NOTICE.md');
  const license = await text('vendor/libcimbar/LICENSE-MPL-2.0.txt');
  const manifest = await text('vendor/libcimbar/MANIFEST.sha256');
  assert.match(notice, /v0\.6\.7c/);
  assert.match(notice, /776a8d71c8bc782eda769c4c0b309d805ca13cbd78df0ed0373cfa9ac44ef20e/);
  assert.match(notice, /github\.com\/sz3\/libcimbar\/tree\/v0\.6\.7c/);
  assert.match(license, /Mozilla Public License Version 2\.0/i);
  assert.match(manifest, /4b10483127d403ea3873ee751454afdc5d42eb5818f8b02e4c2ed0d49e2072ec\s+\.\/cimbar_js\.2026-07-13T0523\.wasm/);
});
