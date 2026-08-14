// qcolortrasfer RX performance policy v2.5.
//
// The v2.4 receiver cropped known QR regions but still ran the generic ZXing
// detector on every crop. V2.5 wires decoded geometry (quad + module count)
// back into subsequent crop jobs so qr-worker can perspective-sample the known
// grid and use a detector-free `isPure` decode first, with ordinary ZXing as a
// safe fallback.
//
// The implementation is original qcolortrasfer/MIT. It reproduces a general
// tracked-decoding architecture without incorporating Decimen >=0.4 AGPL code.

export const RX_ACQUIRE_WIDTH_TARGET = 1280;
export const RX_ACQUIRE_HEIGHT_TARGET = 960;
export const RX_WORKER_TARGET_MAX = 4;

export function desiredRxWorkerTarget(hardwareConcurrency) {
  const hc = Math.max(1, Math.floor(Number(hardwareConcurrency) || 4));
  if (hc >= 4) return 4;
  if (hc === 3) return 3;
  return 2;
}

// app.js already requests 1280×960, exact 60 first and then safe fallbacks.
// Keep that request intact. The previous 1920 upgrade increased readback cost
// on older phones and is intentionally removed.
export function upgradeVideoConstraints(constraints) { return constraints; }

const regionGeometry = new Map();
let recentFullDetections = [];
const taskStarted = new Map();
const metrics = {
  crops: 0, full: 0, trackedAttempts: 0, trackedHits: 0, fallbackHits: 0,
  responses: 0, latencyEma: 0, qrWorkers: 0,
};

function resetTrackedSession() {
  regionGeometry.clear(); recentFullDetections = []; taskStarted.clear();
  metrics.crops = 0; metrics.full = 0; metrics.trackedAttempts = 0;
  metrics.trackedHits = 0; metrics.fallbackHits = 0; metrics.responses = 0;
  metrics.latencyEma = 0;
  renderTrackedTelemetry();
}

function validGeometry(detection) {
  return detection && detection.decoded !== false && detection.quad && Number(detection.modules) > 0;
}
function rememberFullDetections(detections) {
  const now = performance.now();
  recentFullDetections = (Array.isArray(detections) ? detections : [])
    .filter(validGeometry)
    .map(d => ({ ...d, rememberedAt: now }));
}
function geometryForCrop(message) {
  const known = regionGeometry.get(message.regionId);
  if (known) return known;
  const now = performance.now();
  recentFullDetections = recentFullDetections.filter(d => now - d.rememberedAt < 2200);
  const x0 = Number(message.originX) || 0, y0 = Number(message.originY) || 0;
  const x1 = x0 + (Number(message.w) || 0), y1 = y0 + (Number(message.h) || 0);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let best = null, bestDistance = Infinity;
  for (const detection of recentFullDetections) {
    const dx = detection.x + detection.w / 2, dy = detection.y + detection.h / 2;
    if (dx < x0 || dx > x1 || dy < y0 || dy > y1) continue;
    const distance = Math.hypot(dx - cx, dy - cy);
    if (distance < bestDistance) { best = detection; bestDistance = distance; }
  }
  if (best) {
    const geometry = { quad: best.quad, modules: best.modules };
    regionGeometry.set(message.regionId, geometry);
    return geometry;
  }
  return null;
}

function renderTrackedTelemetry() {
  if (typeof document === 'undefined') return;
  let el = document.getElementById('rxTrackedStats');
  const anchor = document.getElementById('rxStats');
  if (!anchor) return;
  if (!el) {
    el = document.createElement('div');
    el.id = 'rxTrackedStats';
    el.className = 'stats telemetry-line';
    anchor.after(el);
  }
  const pct = metrics.trackedAttempts ? Math.round(metrics.trackedHits * 100 / metrics.trackedAttempts) : 0;
  el.textContent = `TRACKED ${metrics.trackedHits}/${metrics.trackedAttempts} (${pct}%) · fallback ${metrics.fallbackHits} · full ${metrics.full} · crop ${metrics.crops} · decode worker ${metrics.latencyEma ? metrics.latencyEma.toFixed(1) : '—'} ms EMA · pool target ${desiredRxWorkerTarget(globalThis.navigator?.hardwareConcurrency)}`;
}

function instrumentQrWorker(worker) {
  metrics.qrWorkers++;
  const nativePost = worker.postMessage.bind(worker);
  const nativeTerminate = worker.terminate.bind(worker);

  worker.addEventListener('message', event => {
    const data = event.data || {};
    if (data.id === -1) return;
    metrics.responses++;
    const started = taskStarted.get(data.id);
    if (started != null) {
      const latency = performance.now() - started;
      metrics.latencyEma = metrics.latencyEma ? metrics.latencyEma * 0.85 + latency * 0.15 : latency;
      taskStarted.delete(data.id);
    }
    if (data.mode === 'full') rememberFullDetections(data.detections);
    if (data.regionId != null && Array.isArray(data.detections)) {
      const confirmed = data.detections.find(validGeometry);
      if (confirmed) regionGeometry.set(data.regionId, { quad: confirmed.quad, modules: confirmed.modules });
    }
    if (data.trackedAttempted) metrics.trackedAttempts++;
    if (data.trackedHit) metrics.trackedHits++;
    else if (data.trackedAttempted && Number(data.baseCount) > 0) metrics.fallbackHits++;
    renderTrackedTelemetry();
  });

  return new Proxy(worker, {
    get(target, prop) {
      if (prop === 'postMessage') return (message, transfer) => {
        let outgoing = message;
        if (message && message.id >= 0) taskStarted.set(message.id, performance.now());
        if (message?.mode === 'full') metrics.full++;
        if (message?.mode === 'crop') {
          metrics.crops++;
          const geometry = message.regionId != null ? geometryForCrop(message) : null;
          if (geometry) outgoing = { ...message, trackedQuad: geometry.quad, trackedModules: geometry.modules };
        }
        renderTrackedTelemetry();
        return transfer === undefined ? nativePost(outgoing) : nativePost(outgoing, transfer);
      };
      if (prop === 'terminate') return () => nativeTerminate();
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, prop, value) { return Reflect.set(target, prop, value, target); },
  });
}

function installWorkerTrackingBridge() {
  if (typeof globalThis.Worker !== 'function' || globalThis.__QCOLOR_TRACKED_WORKER_BRIDGE) return;
  const NativeWorker = globalThis.Worker;
  try {
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(Target, args) {
        const worker = Reflect.construct(Target, args);
        const url = String(args?.[0] ?? '');
        return /(?:^|\/)qr-worker\.js(?:$|[?#])/.test(url) ? instrumentQrWorker(worker) : worker;
      },
    });
    globalThis.Worker = WrappedWorker;
    globalThis.__QCOLOR_TRACKED_WORKER_BRIDGE = true;
  } catch {
    // A hardened browser may expose Worker as non-replaceable. In that case
    // app.js keeps the normal crop decoder; no receive functionality is lost.
  }
}

function armRxPerformancePolicy() {
  if (typeof navigator === 'undefined') return;
  resetTrackedSession();
  globalThis.__QCOLOR_RX_WORKER_TARGET = desiredRxWorkerTarget(navigator.hardwareConcurrency);
  // A short warm-acquisition phase prevents a first 1/4 lock from being
  // mistaken for the complete grid before the tracker has seen all codes.
  globalThis.__QCOLOR_RX_WARM_ACQUIRE = true;
  queueMicrotask(() => {
    try { delete globalThis.__QCOLOR_RX_WORKER_TARGET; }
    catch { globalThis.__QCOLOR_RX_WORKER_TARGET = undefined; }
  });
}

function updateRuntimeLabels() {
  if (typeof document === 'undefined') return;
  const capacity = document.getElementById('capacity');
  if (capacity) capacity.textContent = capacity.textContent.replace(/RX .*?worker/, 'RX 1280@60 · pool 2–4 worker · tracked pure decode');
  const rxNote = document.querySelector('#rxView .note');
  if (rxNote) rxNote.innerHTML = '<strong>RX TRACKED:</strong> 1280×960 con 60 fps exact quando disponibili; 2–4 worker per evitare contention. Dopo il primo lock, quad + numero moduli vengono riusati per campionare direttamente la griglia e saltare il detector ZXing. Se il tracked fallisce, lo stesso crop ricade automaticamente sul decoder normale. Full scan: acquisizione rapida, 250 ms quando degradato, 1500 ms quando stabile.';
  renderTrackedTelemetry();
}

installWorkerTrackingBridge();
if (typeof document !== 'undefined') {
  document.getElementById('startRx')?.addEventListener('click', armRxPerformancePolicy, { capture: true });
  document.getElementById('resetRx')?.addEventListener('click', resetTrackedSession, { capture: true });
}
if (typeof window !== 'undefined') window.addEventListener('load', updateRuntimeLabels, { once: true });
