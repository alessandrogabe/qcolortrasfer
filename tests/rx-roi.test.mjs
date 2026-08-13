import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RoiTracker, boxIou, detectionBoxFromPosition, paddedCrop, sameRegion, workerCountForHardware,
  ROI_ACQUIRE_SCAN_MS, ROI_DEGRADED_SCAN_MS, ROI_LOCKED_SCAN_MS
} from '../js/rx-roi.js';

test('ZXing position becomes a full-frame ROI with crop origin applied', () => {
  const box = detectionBoxFromPosition({
    topLeft: { x: 5, y: 10 }, topRight: { x: 105, y: 8 },
    bottomLeft: { x: 7, y: 110 }, bottomRight: { x: 108, y: 112 }
  }, 300, 200);
  assert.deepEqual(box, { x: 305, y: 208, w: 103, h: 104 });
});

test('dynamic worker count stays within 2..4', () => {
  assert.equal(workerCountForHardware(2), 2);
  assert.equal(workerCountForHardware(6), 3);
  assert.equal(workerCountForHardware(8), 4);
  assert.equal(workerCountForHardware(32), 4);
});

test('overlapping detections match while distant codes stay separate', () => {
  const a = { x: 100, y: 100, w: 160, h: 160 };
  const b = { x: 108, y: 96, w: 158, h: 164 };
  const c = { x: 400, y: 100, w: 160, h: 160 };
  assert.ok(boxIou(a, b) > 0.8);
  assert.equal(sameRegion(a, b), true);
  assert.equal(sameRegion(a, c), false);
});

test('crop padding clamps to frame boundaries', () => {
  assert.deepEqual(paddedCrop({ x: 2, y: 3, w: 100, h: 80 }, 200, 150), { x: 0, y: 0, w: 114, h: 95 });
});

test('tracker merges repeated sightings and allocates independent crops', () => {
  const tracker = new RoiTracker();
  tracker.observe([{ x: 100, y: 100, w: 120, h: 120 }, { x: 300, y: 100, w: 120, h: 120 }], 0);
  tracker.observe([{ x: 104, y: 102, w: 121, h: 119 }], 50);
  assert.equal(tracker.regions.length, 2);
  const picked = tracker.chooseForCrops(2, 50);
  assert.equal(picked.length, 2);
  tracker.markSubmitted(picked[0].id, 50);
  assert.equal(tracker.chooseForCrops(2, 60).some(r => r.id === picked[0].id), false);
  tracker.markDone(picked[0].id);
  assert.equal(tracker.chooseForCrops(2, 70).some(r => r.id === picked[0].id), true);
});

test('full scans slow down after lock and accelerate when degraded', () => {
  const tracker = new RoiTracker();
  assert.equal(tracker.shouldFullScan(0), true);
  tracker.noteFullScan(0);
  assert.equal(tracker.shouldFullScan(ROI_ACQUIRE_SCAN_MS - 1), false);
  tracker.observe([{ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 0, w: 100, h: 100 }], 200);
  tracker.noteFullScan(200);
  assert.equal(tracker.shouldFullScan(200 + ROI_LOCKED_SCAN_MS - 1), false);
  assert.equal(tracker.shouldFullScan(200 + ROI_LOCKED_SCAN_MS), true);
  tracker.regions[0].lastSeen = 5000;
  tracker.regions[1].lastSeen = 7000;
  tracker.noteFullScan(7000);
  assert.equal(tracker.shouldFullScan(7000 + ROI_DEGRADED_SCAN_MS - 1), false);
  assert.equal(tracker.shouldFullScan(7000 + ROI_DEGRADED_SCAN_MS), true);
});
