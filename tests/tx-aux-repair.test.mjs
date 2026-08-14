import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AUX2_PACKET_BYTES, AUX2_STRIPE_BYTES } from '../js/aux-repair.js';
import { chooseAuxLayoutV2, repairSymbolsPerAnchor, selectRepairAnchors } from '../js/tx-aux-repair-v2.js';

const root=path=>new URL(`../${path}`,import.meta.url);

test('TX AUX v2.8 exposes adaptive QAR2 with up to three helpers',async()=>{
  const js=await readFile(root('js/tx-aux-repair-v2.js'),'utf8');assert.match(js,/id="txClassicVariant"/);assert.match(js,/QAR2 AUTO/);assert.match(js,/AUX_MAX_HELPERS = 3/);assert.match(js,/AUX_QR_ECC = 'M'/);assert.match(js,/globalTickFps/);assert.match(js,/nextLane/);assert.match(js,/encodeAuxRepairPacketV2/);
});

test('QAR2 optical envelope is fixed and smaller than old 512-byte helper',()=>{assert.equal(AUX2_STRIPE_BYTES,256);assert.equal(AUX2_PACKET_BYTES,300);assert.ok(AUX2_PACKET_BYTES<548);});

test('large portrait optical view can select multiple helpers without lowering main integer scale',()=>{
  const layout=chooseAuxLayoutV2(428,700,3,77,185);assert.equal(layout.sideLayout,false);assert.ok(layout.count>=2);assert.ok(layout.devicePxPerCell>=3.35);assert.ok(layout.mainScale>=layout.baselineMainScale);
});

test('compact low-DPR screen falls back to one helper',()=>{const layout=chooseAuxLayoutV2(300,430,1,77,185);assert.equal(layout.count,1);});

test('QAR2 sender concentrates extra equations on bounded anchor blocks',()=>{const anchors=selectRepairAnchors(297,12);assert.equal(anchors.length,12);assert.ok(repairSymbolsPerAnchor(2925)>Math.ceil(2925/256));});

test('UI shell loads QAR2 AUX after Classic profile policy',async()=>{const js=await readFile(root('js/ui-shell.js'),'utf8');const classic=js.indexOf("import './tx-profile-policy.js'");const aux=js.indexOf("import './tx-aux-repair-v2.js'");assert.ok(classic>=0&&aux>classic);assert.doesNotMatch(js,/tx-aux-repair-multi\.js/);});

test('AUX layout keeps reserved strip contract instead of stretching main QR',async()=>{const css=await readFile(root('tx-flow.css'),'utf8');assert.match(css,/aux-repair-active/);assert.match(css,/--aux-repair-reserve/);assert.match(css,/padding-bottom:calc/);assert.match(css,/padding-right:calc/);});
