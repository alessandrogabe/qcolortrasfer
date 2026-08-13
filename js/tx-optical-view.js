// qcolortrasfer TX optical view controller.
//
// The normal INVIA screen is configuration only. The QR stage is parked outside
// the visible page; pressing the normal START button moves it into a dedicated
// optical view pinned to the iOS *visualViewport* and then app.js starts TX via
// its existing handler. No second transmission engine is introduced here.
//
// iPhone/iPad browsers do not reliably fullscreen arbitrary DOM elements, so
// this is deliberately an optical VIEW rather than a Fullscreen API feature.
// Only QR + START / STOP / RESET / ESCI are visible while the view is active.

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

function requestTxLayoutRefresh() {
  cancelAnimationFrame(refreshRaf);
  refreshRaf = requestAnimationFrame(() => {
    // app.js owns QR sizing and AUTO 4/6. Reuse its resize path after changing
    // viewport instead of duplicating optical layout rules in this UI module.
    window.dispatchEvent(new Event('resize'));
  });
}

function syncOpticalViewport() {
  if (!active || !shell) return;
  const { width, height } = visibleViewportSize();
  shell.style.setProperty('--tx-optical-width', `${width}px`);
  shell.style.setProperty('--tx-optical-height', `${height}px`);
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

  if (marker?.parentNode) {
    marker.parentNode.insertBefore(shell, marker);
    marker.remove();
  }
  marker = null;
  unlockPage();
  requestTxLayoutRefresh();
}

function hasPreparedFile() {
  return Boolean(fileInput?.files?.length);
}

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
  // Hidden compatibility control kept because legacy app.js still binds it.
  // If invoked programmatically, route it to the same optical view and prevent
  // the old Fullscreen API path from executing.
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!hasPreparedFile()) return;
  if (active) pauseAndExit();
  else enterTxOpticalView();
}

function pauseAndExit() {
  if (!active) return;
  // Use app.js' public STOP control so TX cannot remain active behind config UI.
  stopButton?.click();
  exitTxOpticalView();
}

function interceptExit(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
  pauseAndExit();
}

function blockPan(event) {
  if (active) event.preventDefault();
}

startButton?.addEventListener('click', enterFromMainStart, { capture: true });
legacyEnterButton?.addEventListener('click', interceptLegacyEnter, { capture: true });
exitButton?.addEventListener('click', interceptExit, { capture: true });

// On iOS overflow:hidden alone does not reliably suppress rubber-band and
// sideways movement, so block the gestures while optical view is active.
document.addEventListener('touchmove', blockPan, { passive: false });
document.addEventListener('gesturestart', blockPan, { passive: false });
window.addEventListener('wheel', blockPan, { passive: false });

window.visualViewport?.addEventListener('resize', syncOpticalViewport);
window.visualViewport?.addEventListener('scroll', syncOpticalViewport);
window.addEventListener('orientationchange', syncOpticalViewport);
window.addEventListener('pagehide', () => { if (active) pauseAndExit(); });
document.addEventListener('keydown', event => {
  if (active && event.key === 'Escape') pauseAndExit();
});
