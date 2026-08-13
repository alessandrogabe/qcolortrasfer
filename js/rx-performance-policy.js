// qcolortrasfer RX performance policy.
//
// Browser-reported hardwareConcurrency is treated as a hint, not a hard cap:
// Safari/Chrome may expose only four logical cores for privacy even on hardware
// that can profitably schedule six independent QR/WASM jobs. The START RX click
// therefore requests a six-worker pool when the browser exposes >=4 cores.
//
// Dense V40 grids also benefit from more acquisition pixels. app.js still owns
// camera lifecycle/fallbacks; this module only upgrades its *ideal* 1280x960
// request to 1920x1440. Because width/height remain ideal constraints, browsers
// can safely return 1280 or another supported size when 1920 is unavailable.

export const RX_ACQUIRE_WIDTH_TARGET = 1920;
export const RX_ACQUIRE_HEIGHT_TARGET = 1440;
export const RX_WORKER_TARGET_MAX = 6;

export function desiredRxWorkerTarget(hardwareConcurrency) {
  const hc = Math.max(1, Math.floor(Number(hardwareConcurrency) || 4));
  if (hc >= 4) return 6;
  if (hc === 3) return 4;
  return 2;
}

export function upgradeVideoConstraints(constraints) {
  if (!constraints || typeof constraints !== 'object') return constraints;
  const video = constraints.video;
  if (!video || typeof video !== 'object' || Array.isArray(video)) return constraints;

  const widthIdeal = Number(video.width?.ideal);
  const heightIdeal = Number(video.height?.ideal);
  // Only rewrite qcolortrasfer's own capture profile, never arbitrary camera
  // requests from another component that might share this page in the future.
  if (widthIdeal !== 1280 || heightIdeal !== 960) return constraints;

  return {
    ...constraints,
    video: {
      ...video,
      width: { ...video.width, ideal: RX_ACQUIRE_WIDTH_TARGET },
      height: { ...video.height, ideal: RX_ACQUIRE_HEIGHT_TARGET },
    },
  };
}

function installCameraUpgrade() {
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia || media.__qcolorPerformanceWrapped) return;
  const original = media.getUserMedia.bind(media);
  const wrapped = constraints => original(upgradeVideoConstraints(constraints));
  try {
    media.getUserMedia = wrapped;
    media.__qcolorPerformanceWrapped = true;
  } catch {
    // Some WebKit builds expose methods through a non-writable instance. A
    // configurable own property is still standards-safe; if that too fails we
    // simply keep the original 1280 profile rather than breaking camera access.
    try {
      Object.defineProperty(media, 'getUserMedia', { configurable: true, value: wrapped });
      Object.defineProperty(media, '__qcolorPerformanceWrapped', { configurable: true, value: true });
    } catch {}
  }
}

function armRxWorkerOverride() {
  const target = desiredRxWorkerTarget(navigator.hardwareConcurrency);
  globalThis.__QCOLOR_RX_WORKER_TARGET = target;
  // app.js calls ensureWorkers synchronously in its START handler. Clear the
  // transient override immediately afterwards so TX worker policy and self-tests
  // continue to see the browser's real hardwareConcurrency value.
  queueMicrotask(() => {
    try { delete globalThis.__QCOLOR_RX_WORKER_TARGET; }
    catch { globalThis.__QCOLOR_RX_WORKER_TARGET = undefined; }
  });
}

function updateRuntimeLabels() {
  const capacity = document.getElementById('capacity');
  if (capacity) capacity.textContent = capacity.textContent.replace('RX 1280@60 / 2–6 worker', 'RX 1920 target / pool fino a 6 worker');
  const rxNote = document.querySelector('#rxView .note');
  if (rxNote) rxNote.innerHTML = '<strong>RX FAST:</strong> acquisizione fino a 1920 px quando disponibile, pool fino a 6 worker, full scan rapido durante l’aggancio e crop ROI sul percorso caldo. B/N usa solo il QR base; il colore riusa la geometria base per C1/C2.';
}

installCameraUpgrade();
document.getElementById('startRx')?.addEventListener('click', armRxWorkerOverride, { capture: true });
window.addEventListener('load', updateRuntimeLabels, { once: true });
