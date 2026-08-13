// qcolortrasfer UI shell.
//
// This module owns navigation between HOME / INVIA / RICEVI and loads the
// browser-side optical policies before app.js.

import './tx-optical-view.js';
import './tx-flow-ui.js';
import './rx-performance-policy.js';
import './tx-profile-policy.js';

const homeView = document.getElementById('homeView');
const workspaceView = document.getElementById('workspaceView');
const txView = document.getElementById('txView');
const rxView = document.getElementById('rxView');
const goTx = document.getElementById('goTx');
const goRx = document.getElementById('goRx');
const goHome = document.getElementById('goHome');
const switchTx = document.getElementById('switchTx');
const switchRx = document.getElementById('switchRx');

function clickIfPresent(id) {
  document.getElementById(id)?.click();
}

function stopInactiveEngines(target) {
  if (target !== 'tx') clickIfPresent('stopTx');
  if (target !== 'rx') clickIfPresent('stopRx');
}

function setCurrentModeButton(mode) {
  for (const [button, name] of [[switchTx, 'tx'], [switchRx, 'rx']]) {
    if (!button) continue;
    if (mode === name) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

export function showAppView(target) {
  const mode = target === 'tx' || target === 'rx' ? target : 'home';
  stopInactiveEngines(mode);

  const isHome = mode === 'home';
  if (homeView) homeView.hidden = !isHome;
  if (workspaceView) workspaceView.hidden = isHome;
  if (txView) txView.hidden = mode !== 'tx';
  if (rxView) rxView.hidden = mode !== 'rx';
  setCurrentModeButton(mode);

  document.body.dataset.view = mode;
  document.title = mode === 'tx'
    ? 'Invia · qcolortrasfer'
    : mode === 'rx'
      ? 'Ricevi · qcolortrasfer'
      : 'qcolortrasfer';

  if (mode === 'tx') requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
}

goTx?.addEventListener('click', () => showAppView('tx'));
goRx?.addEventListener('click', () => showAppView('rx'));
goHome?.addEventListener('click', () => showAppView('home'));
switchTx?.addEventListener('click', () => showAppView('tx'));
switchRx?.addEventListener('click', () => showAppView('rx'));

showAppView('home');
