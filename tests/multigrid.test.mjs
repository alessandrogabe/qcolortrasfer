import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseGridCount, codeSideFor, gridDims } from '../js/optical.js';
test('grid orientation uses the long screen axis',()=>{assert.deepEqual(gridDims(6,1200,700),{cols:3,rows:2});assert.deepEqual(gridDims(6,390,844),{cols:2,rows:3});assert.deepEqual(gridDims(2,390,844),{cols:1,rows:2});});
test('auto layout chooses the densest readable supported grid',()=>{assert.equal(chooseGridCount(1200,700,150),6);assert.equal(chooseGridCount(390,844,150),6);assert.equal(chooseGridCount(300,300,150),4);assert.equal(chooseGridCount(220,220,150),1);});
test('six-code portrait grid keeps each tile at least 150 CSS px on a modern phone',()=>{assert.ok(codeSideFor(6,390,844)>=150);});
