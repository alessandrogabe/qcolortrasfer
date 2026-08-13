import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLOR_PALETTE, COLOR_PALETTE_8, rgbForState, rgbForState8, luma,
  chromaScoreA, chromaScoreB, clusterColorScores, classifyColorScore
} from '../js/color-code.js';

test('stable four visual states stay distinct', () => {
  const states = [rgbForState(true,0), rgbForState(true,1), rgbForState(false,0), rgbForState(false,1)];
  assert.equal(new Set(states.map(v => v.join(','))).size, 4);
});

test('experimental eight visual states are distinct', () => {
  const states = [];
  for (const dark of [true,false]) for (const a of [0,1]) for (const b of [0,1]) states.push(rgbForState8(dark,a,b));
  assert.equal(new Set(states.map(v => v.join(','))).size, 8);
});

test('8-state dark/light luma bands stay widely separated', () => {
  const dark = Object.entries(COLOR_PALETTE_8).filter(([k])=>k.startsWith('dark')).map(([,v])=>luma(v));
  const light = Object.entries(COLOR_PALETTE_8).filter(([k])=>k.startsWith('light')).map(([,v])=>luma(v));
  assert.ok(Math.max(...dark) < 65);
  assert.ok(Math.min(...light) > 145);
  assert.ok(Math.min(...light) - Math.max(...dark) > 90);
});

test('axis A separates bit A independently of luminance and bit B', () => {
  const zero=[], one=[];
  for (const dark of [true,false]) for (const b of [0,1]) { zero.push(chromaScoreA(...rgbForState8(dark,0,b))); one.push(chromaScoreA(...rgbForState8(dark,1,b))); }
  assert.ok(Math.max(...zero) < Math.min(...one));
});

test('axis B separates bit B independently of luminance and bit A', () => {
  const zero=[], one=[];
  for (const dark of [true,false]) for (const a of [0,1]) { zero.push(chromaScoreB(...rgbForState8(dark,a,0))); one.push(chromaScoreB(...rgbForState8(dark,a,1))); }
  assert.ok(Math.max(...zero) < Math.min(...one));
});

test('binary adaptive clustering tolerates noisy opponent scores', () => {
  const scores=[-0.55,-0.43,-0.22,-0.17,0.16,0.23,0.49,0.61];
  const c=clusterColorScores(scores,0.06); assert.ok(c); assert.equal(classifyColorScore(-0.2,c),0); assert.equal(classifyColorScore(0.2,c),1);
});

test('stable 4-state palette remains luma-safe',()=>{
  assert.ok(luma(COLOR_PALETTE.dark0)<80 && luma(COLOR_PALETTE.dark1)<80);
  assert.ok(luma(COLOR_PALETTE.light0)>190 && luma(COLOR_PALETTE.light1)>190);
});
