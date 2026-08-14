// qcolortrasfer receiver ROI scheduler.
//
// Original qcolortrasfer/MIT implementation of a high-throughput optical
// pattern: acquire code positions from occasional full-frame scans, then spend
// most work on small crops. V2.5 keeps decoded geometry (quad + module count),
// estimates motion drift, expands crops in the direction-independent safety
// envelope and gives recovery scans priority over crop work.
//
// V2.7 also keeps plausible small QR sightings after at least one real QR has
// been decoded. This lets low-resolution QAR1 helpers obtain a crop and a second
// decode attempt even when their first full-frame ZXing pass only found geometry.

export const ROI_MAX_REGIONS = 9;
export const ROI_TTL_MS = 1500;
export const ROI_ACQUIRE_SCAN_MS = 100;
export const ROI_WARM_SCAN_MS = 180;
export const ROI_WARMUP_MS = 2800;
export const ROI_DEGRADED_SCAN_MS = 250;
export const ROI_LOCKED_SCAN_MS = 1500;
export const ROI_EXPECTED_DECAY_MS = 10000;
export const ROI_PAD_RATIO = 0.35;
export const ROI_MIN_PAD_PX = 12;
export const ROI_FULL_SCAN_PRIORITY_MS = 10;
export const ROI_SMALL_SIGHTING_MIN_RATIO = 0.16;
export const ROI_SMALL_SIGHTING_MAX_RATIO = 2.2;

export function workerCountForHardware(hardwareConcurrency) {
  const override = Math.floor(Number(globalThis.__QCOLOR_RX_WORKER_TARGET));
  if (Number.isFinite(override) && override > 0) return Math.max(2, Math.min(6, override));
  const hc = Math.max(1, Math.floor(Number(hardwareConcurrency) || 4));
  return Math.max(2, Math.min(6, hc));
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

export function boxArea(box) { return Math.max(0, box?.w || 0) * Math.max(0, box?.h || 0); }
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

export function plausibleSmallQrSighting(detection, reference) {
  if (!detection || !reference || !detection.quad) return false;
  const size = Math.max(Number(detection.w) || 0, Number(detection.h) || 0);
  const referenceSize = Math.max(Number(reference.w) || 0, Number(reference.h) || 0);
  if (!(size > 4 && referenceSize > 4)) return false;
  const ratio = size / referenceSize;
  const aspect = Math.max(detection.w, detection.h) / Math.max(1, Math.min(detection.w, detection.h));
  return ratio >= ROI_SMALL_SIGHTING_MIN_RATIO && ratio <= ROI_SMALL_SIGHTING_MAX_RATIO && aspect <= 1.55;
}

export function paddedCrop(box, frameWidth, frameHeight, padRatio = ROI_PAD_RATIO) {
  const size = Math.max(box.w, box.h);
  const drift = Math.max(0, Number(box?.drift) || 0);
  const pad = Math.max(ROI_MIN_PAD_PX, size * padRatio + Math.min(size, 2 * drift));
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
    this.expectedRegions = 0;
    this.expectedRegionsAt = -Infinity;
    this.lastFullScanAt = -Infinity;
    this.firstConfirmedAt = null;
  }
  prune(now) {
    this.regions = this.regions.filter(region => region.inFlight || now - region.lastSeen <= ROI_TTL_MS);
    const confirmed = this.confirmedCount();
    if (confirmed >= this.expectedRegions || now - this.expectedRegionsAt > ROI_EXPECTED_DECAY_MS) {
      this.expectedRegions = confirmed;
      this.expectedRegionsAt = now;
    }
    return this.regions;
  }
  active(now) { this.prune(now); return this.regions; }
  confirmedCount() { return this.regions.reduce((n, region) => n + (region.confirmed ? 1 : 0), 0); }

  observe(detections, now) {
    if (!Array.isArray(detections)) return this.active(now);
    this.prune(now);
    for (const detection of detections) {
      if (!detection || !(detection.w > 4) || !(detection.h > 4)) continue;
      const decoded = detection.decoded !== false;
      let match = null;
      let bestScore = -1;
      for (const region of this.regions) {
        if (!sameRegion(region, detection)) continue;
        const score = boxIou(region, detection) - centerDistanceRatio(region, detection) * 0.05;
        if (score > bestScore) { bestScore = score; match = region; }
      }
      if (match) {
        match.lastSeen = now;
        if (decoded) {
          const oldCx = match.x + match.w / 2, oldCy = match.y + match.h / 2;
          const newCx = detection.x + detection.w / 2, newCy = detection.y + detection.h / 2;
          const displacement = Math.hypot(newCx - oldCx, newCy - oldCy);
          match.drift = 0.5 * (match.drift || 0) + 0.5 * displacement;
          const keep = 0.25, fresh = 0.75;
          match.x = match.x * keep + detection.x * fresh;
          match.y = match.y * keep + detection.y * fresh;
          match.w = match.w * keep + detection.w * fresh;
          match.h = match.h * keep + detection.h * fresh;
          match.confirmed = true;
          match.hits++;
          if (detection.quad) match.quad = detection.quad;
          if (detection.modules > 0) match.modules = detection.modules;
          if (detection.version > 0) match.version = detection.version;
          if (this.firstConfirmedAt == null) this.firstConfirmedAt = now;
        }
        continue;
      }

      if (!decoded) {
        const reference = this.regions.find(region => region.confirmed);
        if (!reference || !plausibleSmallQrSighting(detection, reference)) continue;
      }
      this.regions.push({
        id: this.nextId++, x: detection.x, y: detection.y, w: detection.w, h: detection.h,
        lastSeen: now, lastSubmitted: -Infinity, inFlight: false, hits: decoded ? 1 : 0,
        confirmed: decoded, drift: 0, quad: decoded ? detection.quad || null : null,
        modules: decoded ? Number(detection.modules) || 0 : 0,
        version: decoded ? Number(detection.version) || 0 : 0,
      });
      if (decoded && this.firstConfirmedAt == null) this.firstConfirmedAt = now;
    }

    if (this.regions.length > ROI_MAX_REGIONS) {
      this.regions.sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || (b.hits - a.hits) || (b.lastSeen - a.lastSeen));
      this.regions.length = ROI_MAX_REGIONS;
    }
    const confirmed = this.confirmedCount();
    this.peakRegions = Math.max(this.peakRegions, confirmed);
    if (confirmed > this.expectedRegions) {
      this.expectedRegions = confirmed;
      this.expectedRegionsAt = now;
    }
    return this.regions;
  }

  shouldFullScan(now) {
    this.prune(now);
    const confirmed = this.confirmedCount();
    const warmAcquire = globalThis.__QCOLOR_RX_WARM_ACQUIRE === true;
    let interval;
    if (confirmed === 0) interval = ROI_ACQUIRE_SCAN_MS;
    else if (warmAcquire && this.firstConfirmedAt != null && now - this.firstConfirmedAt < ROI_WARMUP_MS) interval = ROI_WARM_SCAN_MS;
    else if (confirmed < this.expectedRegions) interval = ROI_DEGRADED_SCAN_MS;
    else interval = ROI_LOCKED_SCAN_MS;
    return now - this.lastFullScanAt >= interval;
  }
  noteFullScan(now) { this.lastFullScanAt = now; }

  chooseForCrops(maxCount, now) {
    this.prune(now);
    if (now - this.lastFullScanAt < ROI_FULL_SCAN_PRIORITY_MS) return [];
    return this.regions
      .filter(region => !region.inFlight)
      .sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || a.lastSubmitted - b.lastSubmitted || b.lastSeen - a.lastSeen)
      .slice(0, Math.max(0, maxCount));
  }
  markSubmitted(id, now) {
    const region = this.regions.find(item => item.id === id);
    if (!region) return false;
    region.inFlight = true; region.lastSubmitted = now; return true;
  }
  markDone(id) { const region = this.regions.find(item => item.id === id); if (region) region.inFlight = false; }
  cropFor(region, frameWidth, frameHeight) { return paddedCrop(region, frameWidth, frameHeight); }
}
