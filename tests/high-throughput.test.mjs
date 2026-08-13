import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_HIGH_THROUGHPUT_CHUNK, QR_MAX_PACKET_BYTES,
  chooseHighThroughputGrid, devicePixelsPerRasterCell,
  staggerSubIntervalMs, theoreticalFountainKiBs, txWorkerCountForHardware
} from '../js/high-throughput.js';

test('QCT2 max fountain payload fills the V40-L packet envelope exactly',()=>{
  assert.equal(MAX_HIGH_THROUGHPUT_CHUNK,2925);
  assert.equal(QR_MAX_PACKET_BYTES,2953);
});

test('AUTO uses 6 QR on a tall DPR3 phone when six are as large as four',()=>{
  assert.equal(chooseHighThroughputGrid(390,844,3,185),6);
  assert.ok(devicePixelsPerRasterCell(6,390,844,3,185)>3);
});

test('AUTO falls back to 4 QR when a square viewport would shrink a 2x3 grid too much',()=>{
  assert.equal(chooseHighThroughputGrid(390,390,2,185),4);
});

test('stagger cadence divides per-code frame interval across visible codes',()=>{
  assert.equal(staggerSubIntervalMs(24,6),1000/(24*6));
  assert.equal(staggerSubIntervalMs(60,4),1000/(60*4));
});

test('theoretical fountain rate counts both logical channels',()=>{
  const rate=theoreticalFountainKiBs(2925,24,4,2);
  assert.ok(rate>540 && rate<550);
});

test('TX raster workers leave cores for UI but scale to four',()=>{
  assert.equal(txWorkerCountForHardware(4),2);
  assert.equal(txWorkerCountForHardware(8),4);
  assert.equal(txWorkerCountForHardware(16),4);
});
