// qcolortrasfer receiver ROI scheduler.
//
// This is an original qcolortrasfer/MIT implementation of a common optical-
// receiver optimisation: acquire QR positions from an occasional full-frame
// scan, then spend most decode work on small crops around those positions.
// The tracker never trusts a crop forever: regions expire quickly and periodic
// full scans reacquire moved, hidden or newly appearing QR codes.

export const ROI_MAX_REGIONS = 9;
export const ROI_TTL_MS = 1800;
export const ROI_ACQUIRE_SCAN_MS = 120;
export const ROI_DEGRADED_SCAN_MS = 300;
export const ROI_LOCKED_SCAN_MS = 1200;
export const ROI_PAD_RATIO = 0.12;
export const ROI_MIN_PAD_PX = 10;

export function workerCountForHardware(hardwareConcurrency) {
  const hc = Math.max(1, Number(hardwareConcurrency) || 4);
  if (hc >= 8) return 4;
  if (hc >= 6) return 3;
  return 2;
}

export function detectionBoxFromPosition(position, originX = 0, originY = 0) {
  if (!position?.topLeft || !position?.topRight || !position?.bottomLeft || !position?.bottomRight) return null;
  const points = [position.topLeft, position.topRight, position.bottomLeft, position.bottomRight];
  const xs = points.map(point => Number(point.x));
  const ys = points.map(point => Number(point.y));
  if (xs.some(value => !Number.isFinite(value)) || ys.some(value => !Number.isFinite(value))) return null;
  const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xs), maxY = Math.max(...ys);
  if (!(maxX > minX) || !(maxY > minY)) return null;
  return { x: minX + originX, y: minY + originY, w: maxX - minX, h: maxY - minY };
}

export function boxArea(box) {
  return Math.max(0, box?.w || 0) * Math.max(0, box?.h || 0);
}

export function boxIou(a, b) {
  if (!a || !b) return 0;
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = boxArea(a) + boxArea(b) - intersection;
  return union > 0 ? intersection / union : 0;
}

function centerDistanceRatio(a, b) {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2, by = b.y + b.h / 2;
  const distance = Math.hypot(ax - bx, ay - by);
  const scale = Math.max(1, (Math.max(a.w, a.h) + Math.max(b.w, b.h)) / 2);
  return distance / scale;
}

export function sameRegion(a, b) {
  if (boxIou(a, b) >= 0.18) return true;
  const areaA = boxArea(a), areaB = boxArea(b);
  if (!areaA || !areaB) return false;
  const ratio = Math.max(areaA, areaB) / Math.min(areaA, areaB);
  return ratio <= 2.4 && centerDistanceRatio(a, b) <= 0.55;
}

export function paddedCrop(box, frameWidth, frameHeight, padRatio = ROI_PAD_RATIO) {
  const pad = Math.max(ROI_MIN_PAD_PX, Math.max(box.w, box.h) * padRatio);
  const x0 = Math.max(0, Math.floor(box.x - pad));
  const y0 = Math.max(0, Math.floor(box.y - pad));
  const x1 = Math.min(frameWidth, Math.ceil(box.x + box.w + pad));
  const y1 = Math.min(frameHeight, Math.ceil(box.y + box.h + pad));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

export class RoiTracker {
  constructor() { this.reset(); }

  reset() {
    this.regions = [];
    this.nextId = 1;
    this.peakRegions = 0;
    this.lastFullScanAt = -Infinity;
  }

  prune(now) {
    this.regions = this.regions.filter(region => region.inFlight || now - region.lastSeen <= ROI_TTL_MS);
    return this.regions;
  }

  active(now) {
    this.prune(now);
    return this.regions;
  }

  observe(detections, now) {
    if (!Array.isArray(detections)) return this.active(now);
    this.prune(now);
    for (const detection of detections) {
      if (!detection || !(detection.w > 4) || !(detection.h > 4)) continue;
      let match = null;
      let bestScore = -1;
      for (const region of this.regions) {
        if (!sameRegion(region, detection)) continue;
        const score = boxIou(region, detection) - centerDistanceRatio(region, detection) * 0.05;
        if (score > bestScore) { bestScore = score; match = region; }
      }
      if (match) {
        const keep = 0.25, fresh = 0.75;
        match.x = match.x * keep + detection.x * fresh;
        match.y = match.y * keep + detection.y * fresh;
        match.w = match.w * keep + detection.w * fresh;
        match.h = match.h * keep + detection.h * fresh;
        match.lastSeen = now;
        match.hits++;
      } else {
        this.regions.push({ id: this.nextId++, x: detection.x, y: detection.y, w: detection.w, h: detection.h, lastSeen: now, lastSubmitted: -Infinity, inFlight: false, hits: 1 });
      }
    }

    if (this.regions.length > ROI_MAX_REGIONS) {
      this.regions.sort((a, b) => (b.hits - a.hits) || (b.lastSeen - a.lastSeen));
      this.regions.length = ROI_MAX_REGIONS;
    }
    this.peakRegions = Math.max(this.peakRegions, this.regions.length);
    return this.regions;
  }

  shouldFullScan(now) {
    this.prune(now);
    const active = this.regions.length;
    const interval = active === 0 ? ROI_ACQUIRE_SCAN_MS : active < this.peakRegions ? ROI_DEGRADED_SCAN_MS : ROI_LOCKED_SCAN_MS;
    return now - this.lastFullScanAt >= interval;
  }

  noteFullScan(now) { this.lastFullScanAt = now; }

  chooseForCrops(maxCount, now) {
    this.prune(now);
    return this.regions.filter(region => !region.inFlight).sort((a, b) => a.lastSubmitted - b.lastSubmitted || b.lastSeen - a.lastSeen).slice(0, Math.max(0, maxCount));
  }

  markSubmitted(id, now) {
    const region = this.regions.find(item => item.id === id);
    if (!region) return false;
    region.inFlight = true;
    region.lastSubmitted = now;
    return true;
  }

  markDone(id) {
    const region = this.regions.find(item => item.id === id);
    if (region) region.inFlight = false;
  }

  cropFor(region, frameWidth, frameHeight) {
    return paddedCrop(region, frameWidth, frameHeight);
  }
}
