import test from 'node:test';
import assert from 'node:assert/strict';
import { COLOR_PALETTE, rgbForState, luma, chromaScore, clusterColorScores, classifyColorScore } from '../js/color-code.js';

test('four visual states are distinct', () => {
  const states = [rgbForState(true,0), rgbForState(true,1), rgbForState(false,0), rgbForState(false,1)];
  assert.equal(new Set(states.map(v => v.join(','))).size, 4);
});

test('dark colors stay dark and light colors stay light for QR luminance', () => {
  assert.ok(luma(COLOR_PALETTE.dark0) < 80);
  assert.ok(luma(COLOR_PALETTE.dark1) < 80);
  assert.ok(luma(COLOR_PALETTE.light0) > 190);
  assert.ok(luma(COLOR_PALETTE.light1) > 190);
});

test('warm/cool bit is separable independently of light/dark state', () => {
  const warm = [COLOR_PALETTE.dark0, COLOR_PALETTE.light0].map(v => chromaScore(...v));
  const cool = [COLOR_PALETTE.dark1, COLOR_PALETTE.light1].map(v => chromaScore(...v));
  assert.ok(Math.max(...warm) < Math.min(...cool));
});

test('adaptive clustering recovers noisy warm/cool bits', () => {
  const scores = [-0.55,-0.45,-0.32,-0.28,0.18,0.22,0.55,0.67];
  const clusters = clusterColorScores(scores);
  assert.ok(clusters);
  assert.equal(classifyColorScore(-0.3, clusters), 0);
  assert.equal(classifyColorScore(0.2, clusters), 1);
  assert.ok(clusters.separation > 0.3);
});
