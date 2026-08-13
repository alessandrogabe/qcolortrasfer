import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_MIN_DWELL_MS,
  adaptiveDwellMs,
  adaptiveGridCap,
  adaptiveNextPaintAt,
  adaptiveOpticalFpsCeiling
} from '../js/adaptive-scheduler.js';

test('low requested fps keeps the requested dwell',()=>{
  assert.equal(adaptiveDwellMs(5),200);
  assert.equal(adaptiveDwellMs(8),125);
});

test('20 fps target is clamped to a camera-observable dwell window',()=>{
  assert.ok(ADAPTIVE_MIN_DWELL_MS>=70 && ADAPTIVE_MIN_DWELL_MS<=80);
  assert.equal(adaptiveDwellMs(20),ADAPTIVE_MIN_DWELL_MS);
  const ceiling=adaptiveOpticalFpsCeiling(20);
  assert.ok(ceiling>13 && ceiling<14);
});

test('adaptive AUTO keeps six QR through 12 fps and four at 20 fps',()=>{
  assert.equal(adaptiveGridCap(3),6);
  assert.equal(adaptiveGridCap(8),6);
  assert.equal(adaptiveGridCap(12),6);
  assert.equal(adaptiveGridCap(20),4);
});

test('next paint deadline is based on the previous visible paint time',()=>{
  assert.equal(adaptiveNextPaintAt(0,8),0);
  assert.equal(adaptiveNextPaintAt(1000,8),1125);
  assert.equal(adaptiveNextPaintAt(1000,20),1000+ADAPTIVE_MIN_DWELL_MS);
});
