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

test('dynamic RX worker primitive still supports two through six', () => {
  assert.equal(workerCountForHardware(2), 2);
  assert.equal(workerCountForHardware(4), 4);
  assert.equal(workerCountForHardware(6), 6);
  assert.equal(workerCountForHardware(8), 6);
  assert.equal(workerCountForHardware(32), 6);
});

test('overlapping detections match while distant codes stay separate', () => {
  const a = { x: 100, y: 100, w: 160, h: 160 };
  const b = { x: 108, y: 96, w: 158, h: 164 };
  const c = { x: 400, y: 100, w: 160, h: 160 };
  assert.ok(boxIou(a, b) > 0.8);
  assert.equal(sameRegion(a, b), true);
  assert.equal(sameRegion(a, c), false);
});

test('v2.5 crop padding uses 35 percent base margin and clamps to frame', () => {
  assert.deepEqual(paddedCrop({ x: 2, y: 3, w: 100, h: 80 }, 200, 150), { x: 0, y: 0, w: 137, h: 118 });
});

test('motion drift expands the next crop safety envelope', () => {
  const steady = paddedCrop({ x: 100, y: 100, w: 100, h: 100, drift: 0 }, 500, 500);
  const moving = paddedCrop({ x: 100, y: 100, w: 100, h: 100, drift: 20 }, 500, 500);
  assert.ok(moving.w > steady.w);
  assert.ok(moving.h > steady.h);
});

test('tracker stores decoded quad/modules and estimates drift', () => {
  const tracker = new RoiTracker();
  const quad1 = { topLeft:{x:100,y:100},topRight:{x:200,y:100},bottomLeft:{x:100,y:200},bottomRight:{x:200,y:200} };
  const quad2 = { topLeft:{x:110,y:100},topRight:{x:210,y:100},bottomLeft:{x:110,y:200},bottomRight:{x:210,y:200} };
  tracker.observe([{ x:100,y:100,w:100,h:100,decoded:true,quad:quad1,modules:177,version:40 }], 0);
  tracker.observe([{ x:110,y:100,w:100,h:100,decoded:true,quad:quad2,modules:177,version:40 }], 50);
  assert.equal(tracker.regions[0].modules, 177);
  assert.equal(tracker.regions[0].version, 40);
  assert.deepEqual(tracker.regions[0].quad, quad2);
  assert.ok(tracker.regions[0].drift > 0);
});

test('tracker merges repeated decoded sightings and allocates independent crops', () => {
  const tracker = new RoiTracker();
  tracker.observe([{ x: 100, y: 100, w: 120, h: 120, decoded: true }, { x: 300, y: 100, w: 120, h: 120, decoded: true }], 0);
  tracker.observe([{ x: 104, y: 102, w: 121, h: 119, decoded: true }], 50);
  assert.equal(tracker.regions.length, 2);
  const picked = tracker.chooseForCrops(2, 50);
  assert.equal(picked.length, 2);
  tracker.markSubmitted(picked[0].id, 50);
  assert.equal(tracker.chooseForCrops(2, 60).some(r => r.id === picked[0].id), false);
  tracker.markDone(picked[0].id);
  assert.equal(tracker.chooseForCrops(2, 70).some(r => r.id === picked[0].id), true);
});

test('a submitted full scan owns that capture and suppresses crops', () => {
  const tracker = new RoiTracker();
  tracker.observe([{ x: 20, y: 20, w: 100, h: 100, decoded: true }], 0);
  tracker.noteFullScan(100);
  assert.deepEqual(tracker.chooseForCrops(4, 100), []);
  assert.equal(tracker.chooseForCrops(4, 120).length, 1);
});

test('unconfirmed sighting cannot create a phantom before first real decode', () => {
  const tracker = new RoiTracker();
  tracker.observe([{ x: 50, y: 50, w: 100, h: 100, decoded: false }], 0);
  assert.equal(tracker.regions.length, 0);
  tracker.observe([{ x: 50, y: 50, w: 100, h: 100, decoded: true }], 10);
  tracker.observe([{ x: 250, y: 50, w: 105, h: 95, decoded: false }], 20);
  assert.equal(tracker.regions.length, 2);
});

test('full scans slow down after lock and accelerate when degraded', () => {
  const tracker = new RoiTracker();
  assert.equal(tracker.shouldFullScan(0), true);
  tracker.noteFullScan(0);
  assert.equal(tracker.shouldFullScan(ROI_ACQUIRE_SCAN_MS - 1), false);
  tracker.observe([{ x: 0, y: 0, w: 100, h: 100, decoded: true }, { x: 200, y: 0, w: 100, h: 100, decoded: true }], 200);
  tracker.noteFullScan(200);
  assert.equal(tracker.shouldFullScan(200 + ROI_LOCKED_SCAN_MS - 1), false);
  assert.equal(tracker.shouldFullScan(200 + ROI_LOCKED_SCAN_MS), true);
  tracker.regions[0].lastSeen = 5000;
  tracker.regions[1].lastSeen = 7000;
  tracker.noteFullScan(7000);
  assert.equal(tracker.shouldFullScan(7000 + ROI_DEGRADED_SCAN_MS - 1), false);
  assert.equal(tracker.shouldFullScan(7000 + ROI_DEGRADED_SCAN_MS), true);
});
