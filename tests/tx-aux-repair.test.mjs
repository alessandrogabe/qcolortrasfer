import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
