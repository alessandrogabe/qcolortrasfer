import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AUX_HEADER_BYTES, AUX_STRIPE_BYTES } from '../js/aux-repair.js';
import { padAuxPacketForOpticalQr } from '../js/tx-aux-repair.js';

const root = path => new URL(`../${path}`, import.meta.url);

test('TX AUX module exposes Classic + AUX Repair as a separate selectable variant', async () => {
  const js = await readFile(root('js/tx-aux-repair.js'), 'utf8');
  assert.match(js, /id="txClassicVariant"/);
  assert.match(js, /CLASSIC \+ AUX REPAIR/);
  assert.match(js, /txAuxCanvas/);
  assert.match(js, /AUX_QR_ECC = 'M'/);
  assert.match(js, /AUX_LOOKAHEAD = 2/);
  assert.match(js, /encodeAuxRepairPacket/);
  assert.match(js, /Math\.round\(main \/ 2\)/);
});

test('AUX optical QR keeps one fixed byte envelope even when final stripe is shorter', () => {
  const fixedLength = AUX_HEADER_BYTES + AUX_STRIPE_BYTES + 4;
  const full = new Uint8Array(fixedLength).fill(0x5a);
  const short = new Uint8Array(AUX_HEADER_BYTES + 173 + 4).fill(0xa5);
  const fullPadded = padAuxPacketForOpticalQr(full);
  const shortPadded = padAuxPacketForOpticalQr(short);
  assert.equal(fullPadded.length, fixedLength);
  assert.equal(shortPadded.length, fixedLength);
  assert.equal(fullPadded, full);
  assert.deepEqual(shortPadded.subarray(0, short.length), short);
  assert.ok(shortPadded.subarray(short.length).every(value => value === 0));
});

test('AUX QR renderer encodes the fixed optical envelope, preventing version/size oscillation', async () => {
  const js = await readFile(root('js/tx-aux-repair.js'), 'utf8');
  assert.match(js, /padAuxPacketForOpticalQr\(bytes\)/);
  assert.match(js, /data: opticalBytes/);
  assert.match(js, /geometria fissa/);
  assert.doesNotMatch(js, /QRCode\.create\(\[\{ data: bytes,/);
});

test('UI shell loads AUX sidecar only after the Classic profile policy', async () => {
  const js = await readFile(root('js/ui-shell.js'), 'utf8');
  const classic = js.indexOf("import './tx-profile-policy.js'");
  const aux = js.indexOf("import './tx-aux-repair.js'");
  assert.ok(classic >= 0 && aux > classic);
});

test('AUX layout reserves unused screen strip instead of stretching the main QR', async () => {
  const css = await readFile(root('tx-flow.css'), 'utf8');
  assert.match(css, /aux-repair-active/);
  assert.match(css, /--aux-repair-reserve/);
  assert.match(css, /padding-bottom:calc/);
  assert.match(css, /padding-right:calc/);
});
