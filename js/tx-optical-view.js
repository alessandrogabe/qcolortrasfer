// qcolortrasfer TX optical view controller.
// UI concept: QR A TUTTO SCHERMO.
//
// The normal INVIA screen is configuration only. The QR stage is parked outside
// the visible page; pressing the normal START button moves it into a dedicated
// optical view pinned to the iOS *visualViewport* and then app.js starts TX via
// its existing handler. No second transmission engine is introduced here.
//
// v2.3 adds an optical safe area: high-density/tall displays get a larger side
// guard so curved edges and panel fall-off do not cut into the finder patterns.
// The QR tiles themselves use a shared internal quiet zone, so this extra room
// is taken from the outside rather than wasted between neighboring QR codes.

const root = document.documentElement;
const body = document.body;
const shell = document.getElementById('txFullscreenShell');
const startButton = document.getElementById('startTx');
const legacyEnterButton = document.getElementById('fullTx');
const exitButton = document.getElementById('fsExitTx');
const stopButton = document.getElementById('stopTx');
const fileInput = document.getElementById('fileInput');
const txStatus = document.getElementById('txStatus');

let active = false;
let marker = null;
let restoreScrollX = 0;
let restoreScrollY = 0;
let refreshRaf = 0;

function visibleViewportSize() {
  const vv = window.visualViewport;
  return {
    width: Math.max(1, Math.round(vv?.width || window.innerWidth || root.clientWidth || 1)),
    height: Math.max(1, Math.round(vv?.height || window.innerHeight || root.clientHeight || 1)),
  };
}

function opticalEdgeGuard(width, height) {
  const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
  const tall = height / Math.max(1, width) > 1.8;
  // Curved/high-density phones need more horizontal protection. iPhones around
  // DPR3 keep a smaller guard so the proven 4-QR B/N baseline does not shrink
  // unnecessarily; DPR3.5+ displays receive the larger edge-safe envelope.
  const xRatio = dpr >= 3.5 || tall && dpr >= 3.25 ? 0.055 : 0.030;
  const yRatio = 0.022;
  return {
    x: Math.max(10, Math.round(width * xRatio)),
    y: Math.max(8, Math.round(height * yRatio)),
  };
}

function requestTxLayoutRefresh() {
  cancelAnimationFrame(refreshRaf);
  refreshRaf = requestAnimationFrame(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

function syncOpticalViewport() {
  if (!active || !shell) return;
  const { width, height } = visibleViewportSize();
  const guard = opticalEdgeGuard(width, height);
  shell.style.setProperty('--tx-optical-width', `${width}px`);
  shell.style.setProperty('--tx-optical-height', `${height}px`);
  shell.style.setProperty('--tx-edge-x', `${guard.x}px`);
  shell.style.setProperty('--tx-edge-y', `${guard.y}px`);
  requestTxLayoutRefresh();
}

function lockPage() {
  restoreScrollX = window.scrollX || 0;
  restoreScrollY = window.scrollY || 0;
  root.classList.add('tx-optical-active');
  body.classList.add('tx-optical-active');
}

function unlockPage() {
  root.classList.remove('tx-optical-active');
  body.classList.remove('tx-optical-active');
  requestAnimationFrame(() => window.scrollTo(restoreScrollX, restoreScrollY));
}

export function enterTxOpticalView() {
  if (active || !shell) return;
  marker = document.createComment('qcolortrasfer-tx-optical-origin');
  shell.parentNode?.insertBefore(marker, shell);
  body.appendChild(shell);
  active = true;
  shell.classList.remove('immersive-fallback');
  shell.classList.add('tx-optical-overlay');
  shell.setAttribute('data-optical-view', 'active');
  lockPage();
  syncOpticalViewport();
}

export function exitTxOpticalView() {
  if (!active || !shell) return;
  active = false;
  shell.classList.remove('tx-optical-overlay', 'immersive-fallback');
  shell.removeAttribute('data-optical-view');
  shell.style.removeProperty('--tx-optical-width');
  shell.style.removeProperty('--tx-optical-height');
  shell.style.removeProperty('--tx-edge-x');
  shell.style.removeProperty('--tx-edge-y');
  if (marker?.parentNode) {
    marker.parentNode.insertBefore(shell, marker);
    marker.remove();
  }
  marker = null;
  unlockPage();
  requestTxLayoutRefresh();
}

function hasPreparedFile() { return Boolean(fileInput?.files?.length); }

function enterFromMainStart() {
  // Capture phase runs before app.js' normal START handler. We only prepare the
  // optical viewport here and intentionally DO NOT stop propagation: app.js then
  // receives the same click and starts the existing QCT2/fountain scheduler.
  if (active) return;
  if (!hasPreparedFile()) {
    if (txStatus) {
      txStatus.textContent = 'Seleziona prima un file da trasmettere.';
      txStatus.dataset.kind = 'warn';
    }
    return;
  }
  enterTxOpticalView();
}

function interceptLegacyEnter(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!hasPreparedFile()) return;
  if (active) pauseAndExit();
  else enterTxOpticalView();
}

function pauseAndExit() {
  if (!active) return;
  stopButton?.click();
  exitTxOpticalView();
}

function interceptExit(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
  pauseAndExit();
}

function blockPan(event) { if (active) event.preventDefault(); }

startButton?.addEventListener('click', enterFromMainStart, { capture: true });
legacyEnterButton?.addEventListener('click', interceptLegacyEnter, { capture: true });
exitButton?.addEventListener('click', interceptExit, { capture: true });
document.addEventListener('touchmove', blockPan, { passive: false });
document.addEventListener('gesturestart', blockPan, { passive: false });
window.addEventListener('wheel', blockPan, { passive: false });
window.visualViewport?.addEventListener('resize', syncOpticalViewport);
window.visualViewport?.addEventListener('scroll', syncOpticalViewport);
window.addEventListener('orientationchange', syncOpticalViewport);
window.addEventListener('pagehide', () => { if (active) pauseAndExit(); });
document.addEventListener('keydown', event => { if (active && event.key === 'Escape') pauseAndExit(); });
