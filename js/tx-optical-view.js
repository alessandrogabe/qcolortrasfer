// qcolortrasfer TX optical view controller.
//
// iPhone/iPad browsers do not reliably expose the Fullscreen API for arbitrary
// DOM elements. More importantly, element fullscreen still couples the optical
// stage to the page layout on some WebKit builds. This module therefore treats
// "QR a tutto schermo" as a dedicated optical VIEW, not as page fullscreen.
//
// The TX shell is temporarily portaled directly under <body>, pinned to the
// *visible* viewport, and all page pan/overscroll is locked. Only the QR stage
// and the compact START / STOP / RESET / ESCI bar remain visible. The optical
// engine itself stays in app.js and is controlled through its existing buttons.

const root = document.documentElement;
const body = document.body;
const shell = document.getElementById('txFullscreenShell');
const enterButton = document.getElementById('fullTx');
const exitButton = document.getElementById('fsExitTx');

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
    // app.js already owns all QR sizing/AUTO 4/6 logic. Reuse that path instead
    // of duplicating optical-layout code in the presentation module.
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

function interceptEnter(event) {
  // app.js still contains the old native-fullscreen fallback for compatibility.
  // Capture phase prevents that legacy handler from running for this button.
  event.preventDefault();
  event.stopImmediatePropagation();
  if (active) exitTxOpticalView();
  else enterTxOpticalView();
}

function interceptExit(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
  exitTxOpticalView();
}

function blockPan(event) {
  if (active) event.preventDefault();
}

enterButton?.addEventListener('click', interceptEnter, { capture: true });
exitButton?.addEventListener('click', interceptExit, { capture: true });

// These listeners matter on iOS: overflow:hidden alone does not consistently
// suppress rubber-band / sideways page movement while a finger is on the view.
document.addEventListener('touchmove', blockPan, { passive: false });
document.addEventListener('gesturestart', blockPan, { passive: false });
window.addEventListener('wheel', blockPan, { passive: false });

window.visualViewport?.addEventListener('resize', syncOpticalViewport);
window.visualViewport?.addEventListener('scroll', syncOpticalViewport);
window.addEventListener('orientationchange', syncOpticalViewport);
window.addEventListener('pagehide', () => { if (active) exitTxOpticalView(); });
document.addEventListener('keydown', event => {
  if (active && event.key === 'Escape') exitTxOpticalView();
});

if (enterButton) enterButton.textContent = 'QR A TUTTO SCHERMO';
