// qcolortrasfer CIMBAR ENGINE adapter (MIT).
//
// This file does NOT reimplement libcimbar. It launches the exact vendored
// upstream Web/WASM v0.6.7c runtime in a same-origin optical view. The vendored
// files remain MPL-2.0; see vendor/libcimbar/SOURCE-NOTICE.md.

const VENDOR_ROOT = './vendor/libcimbar/v0.6.7c/';
const CIMBAR_TX_URL = `${VENDOR_ROOT}index.html`;
const CIMBAR_RX_URL = `${VENDOR_ROOT}recv.html`;
const CIMBAR_VERSION = 'v0.6.7c';
const CIMBAR_DEFAULT_MODE = 'B';
const CIMBAR_DEFAULT_FPS = 15;
const $ = id => document.getElementById(id);

let shell = null;
let frame = null;
let shellStatus = null;
let shellTitle = null;
let activeKind = null;
let rxMetrics = null;

function ensureShell() {
  if (shell) return shell;
  shell = document.createElement('div');
  shell.id = 'cimbarEngineShell';
  shell.hidden = true;
  Object.assign(shell.style, {
    position: 'fixed', inset: '0', zIndex: '2147483647', background: '#000',
    display: 'grid', gridTemplateRows: '44px minmax(0,1fr)', width: '100vw',
    height: '100dvh', overflow: 'hidden',
  });

  const bar = document.createElement('div');
  Object.assign(bar.style, {
    display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0',
    padding: '5px max(6px, env(safe-area-inset-right)) 5px max(8px, env(safe-area-inset-left))',
    background: '#071018', color: '#e8f2f8', borderBottom: '1px solid #294052',
    font: '11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  });
  shellTitle = document.createElement('strong');
  shellTitle.style.whiteSpace = 'nowrap';
  shellStatus = document.createElement('span');
  Object.assign(shellStatus.style, { minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#91a7b5' });
  const exit = document.createElement('button');
  exit.type = 'button';
  exit.textContent = 'ESCI';
  Object.assign(exit.style, {
    marginLeft: 'auto', border: '1px solid #3e7f64', background: '#0d251b',
    color: '#77f0ad', padding: '6px 10px', font: 'inherit', fontWeight: '700',
  });
  exit.addEventListener('click', closeEngine);
  bar.append(shellTitle, shellStatus, exit);

  frame = document.createElement('iframe');
  frame.id = 'cimbarEngineFrame';
  frame.title = 'libcimbar Web/WASM engine';
  frame.allow = 'camera; fullscreen; autoplay';
  frame.allowFullscreen = true;
  Object.assign(frame.style, { width: '100%', height: '100%', border: '0', background: '#000' });

  shell.append(bar, frame);
  document.body.appendChild(shell);
  return shell;
}

function setShellStatus(text) {
  if (shellStatus) shellStatus.textContent = text;
}

function closeEngine() {
  if (!shell) return;
  try {
    const w = frame?.contentWindow;
    const video = w?.document?.getElementById?.('video');
    for (const track of video?.srcObject?.getTracks?.() || []) track.stop();
  } catch {}
  if (frame) frame.src = 'about:blank';
  shell.hidden = true;
  activeKind = null;
  rxMetrics = null;
  document.body.classList.remove('cimbar-engine-active');
}

function openShell(kind) {
  ensureShell();
  activeKind = kind;
  shell.hidden = false;
  document.body.classList.add('cimbar-engine-active');
  shellTitle.textContent = kind === 'tx' ? 'CIMBAR ENGINE · TX' : 'CIMBAR ENGINE · RX';
  setShellStatus(`${CIMBAR_VERSION} · runtime ufficiale MPL-2.0 · caricamento WASM…`);
}

async function waitFor(predicate, timeoutMs = 20000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    try {
      const value = predicate();
      if (value) return value;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('timeout inizializzazione libcimbar WASM');
}

async function openTx(file) {
  if (!file) throw new Error('Seleziona prima un file.');
  openShell('tx');
  frame.onload = async () => {
    if (activeKind !== 'tx') return;
    try {
      const w = frame.contentWindow;
      await waitFor(() => w?.Main && w?.Module && typeof w.Module._cimbare_encode_bufsize === 'function');
      w.Main.setMode(CIMBAR_DEFAULT_MODE);
      w.Main.setFPS(CIMBAR_DEFAULT_FPS);
      w.Main.importFile(file);
      w.Main.resize?.();
      setShellStatus(`${CIMBAR_VERSION} · Mode ${CIMBAR_DEFAULT_MODE} · ${CIMBAR_DEFAULT_FPS} fps · ${file.name} · ${(file.size / 1024).toFixed(1)} KiB`);
    } catch (error) {
      setShellStatus(`ERRORE: ${error.message}`);
    }
  };
  frame.src = CIMBAR_TX_URL;
}

function updateRxMetricStatus() {
  if (!rxMetrics || activeKind !== 'rx') return;
  const now = performance.now();
  const elapsed = rxMetrics.firstDecodeAt ? Math.max(0.001, (now - rxMetrics.firstDecodeAt) / 1000) : 0;
  const opticalKiBs = elapsed ? rxMetrics.bytes / elapsed / 1024 : 0;
  const complete = rxMetrics.completedAt && rxMetrics.firstDecodeAt
    ? Math.max(0.001, (rxMetrics.completedAt - rxMetrics.firstDecodeAt) / 1000)
    : 0;
  const fileKiBs = complete && rxMetrics.fileBytes ? rxMetrics.fileBytes / complete / 1024 : 0;
  setShellStatus(
    `${CIMBAR_VERSION} · RX ufficiale · chunk ${rxMetrics.chunks} · ${opticalKiBs.toFixed(1)} KiB/s payload` +
    (fileKiBs ? ` · FILE ${fileKiBs.toFixed(1)} KiB/s` : '')
  );
}

async function instrumentReceiver() {
  const w = frame.contentWindow;
  await waitFor(() => w?.Recv && w?.Sink && w?.Zstd && w?.Module);
  if (w.__qcolorCimbarInstrumented) return;
  w.__qcolorCimbarInstrumented = true;
  rxMetrics = { chunks: 0, bytes: 0, firstDecodeAt: 0, completedAt: 0, fileBytes: 0 };

  const originalSink = w.Sink.on_decode.bind(w.Sink);
  w.Sink.on_decode = function qcolorCimbarSink(buff) {
    if (buff?.length) {
      if (!rxMetrics.firstDecodeAt) rxMetrics.firstDecodeAt = performance.now();
      rxMetrics.chunks += 1;
      rxMetrics.bytes += Number(buff.length) || 0;
      updateRxMetricStatus();
    }
    return originalSink(buff);
  };

  const originalDownload = w.Zstd.download_blob.bind(w.Zstd);
  w.Zstd.download_blob = function qcolorCimbarDownload(name, blob) {
    rxMetrics.completedAt = performance.now();
    rxMetrics.fileBytes = Number(blob?.size) || 0;
    updateRxMetricStatus();
    const seconds = rxMetrics.firstDecodeAt ? (rxMetrics.completedAt - rxMetrics.firstDecodeAt) / 1000 : 0;
    const kibs = seconds > 0 ? rxMetrics.fileBytes / seconds / 1024 : 0;
    const rxStatus = $('rxStatus');
    if (rxStatus) {
      rxStatus.textContent = `CIMBAR COMPLETATO · ${name} · ${(rxMetrics.fileBytes / 1024).toFixed(1)} KiB · ${seconds.toFixed(2)} s dal primo decode · ${kibs.toFixed(1)} KiB/s file`;
      rxStatus.dataset.kind = 'ok';
    }
    return originalDownload(name, blob);
  };

  setShellStatus(`${CIMBAR_VERSION} · receiver WASM pronto · Auto/B · camera gestita da libcimbar`);
}

function openRx() {
  openShell('rx');
  frame.onload = async () => {
    if (activeKind !== 'rx') return;
    try {
      await instrumentReceiver();
    } catch (error) {
      setShellStatus(`ERRORE: ${error.message}`);
    }
  };
  frame.src = CIMBAR_RX_URL;
}

function installTx() {
  const method = $('txMethod');
  const fileInput = $('fileInput');
  const payload = $('payloadBytes');
  const color = $('colorMode');
  const fps = $('fps');
  const grid = $('gridMode');
  const status = $('txStatus');
  const info = $('txFileInfo');
  const badge = $('colorBadge');
  const gridState = $('gridState');
  if (!method || !fileInput) return;

  if (![...method.options].some(option => option.value === 'cimbar')) {
    method.add(new Option('CIMBAR ENGINE · LIBCIMBAR WASM v0.6.7c', 'cimbar'));
  }

  let active = false;
  let syncing = false;
  let saved = null;

  function enter() {
    if (active) return;
    active = true;
    saved = {
      payloadDisabled: payload?.disabled, colorDisabled: color?.disabled, fpsDisabled: fps?.disabled, gridDisabled: grid?.disabled,
      payload: payload?.value, color: color?.value, fps: fps?.value, grid: grid?.value,
    };
    for (const control of [payload, color, fps, grid]) if (control) control.disabled = true;
    if (status) {
      status.textContent = `CIMBAR ENGINE pronto · ${CIMBAR_VERSION} ufficiale · Mode B · 15 fps · decoder/encoder WASM libcimbar.`;
      status.dataset.kind = 'ok';
    }
    if (badge) badge.textContent = 'LIBCIMBAR v0.6.7c · MPL-2.0';
    if (gridState) gridState.textContent = 'CIMBAR MODE B';
  }

  function leave() {
    if (!active) return;
    active = false;
    closeEngine();
    if (payload) { payload.disabled = !!saved?.payloadDisabled; if (saved?.payload != null) payload.value = saved.payload; }
    if (color) { color.disabled = !!saved?.colorDisabled; if (saved?.color != null) color.value = saved.color; }
    if (fps) { fps.disabled = !!saved?.fpsDisabled; if (saved?.fps != null) fps.value = saved.fps; }
    if (grid) { grid.disabled = !!saved?.gridDisabled; if (saved?.grid != null) grid.value = saved.grid; }
  }

  method.addEventListener('change', event => {
    if (syncing) return;
    if (method.value === 'cimbar') {
      event.preventDefault();
      event.stopImmediatePropagation();
      // Let the existing TX policy cleanly stop Classic/Multi, but keep libcimbar
      // as the visible selection afterwards.
      syncing = true;
      method.value = 'multi';
      method.dispatchEvent(new Event('change', { bubbles: true }));
      method.value = 'cimbar';
      syncing = false;
      enter();
    } else if (active) {
      leave();
    }
  }, true);

  fileInput.addEventListener('change', event => {
    if (!active || method.value !== 'cimbar') return;
    event.stopImmediatePropagation();
    const file = fileInput.files?.[0];
    if (info) info.textContent = file ? `${file.name} · ${(file.size / 1024).toFixed(1)} KiB · pronto per libcimbar ${CIMBAR_VERSION}` : 'Nessun file selezionato.';
    if (status) status.textContent = file ? 'File pronto. START apre il sender libcimbar ufficiale.' : 'Seleziona un file.';
  }, true);

  document.addEventListener('click', event => {
    if (method.value !== 'cimbar') return;
    const id = event.target?.id;
    if (!['startTx', 'stopTx', 'fsStopTx', 'fsResetTx', 'fsExitTx'].includes(id)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (id === 'startTx') {
      openTx(fileInput.files?.[0]).catch(error => {
        if (status) { status.textContent = `CIMBAR ENGINE: ${error.message}`; status.dataset.kind = 'error'; }
      });
    } else if (id === 'fsResetTx' && activeKind === 'tx') {
      const file = fileInput.files?.[0];
      closeEngine();
      if (file) void openTx(file);
    } else {
      closeEngine();
    }
  }, true);
}

function installRx() {
  const method = $('rxMethod');
  const status = $('rxStatus');
  const video = $('rxVideo');
  if (!method) return;
  if (![...method.options].some(option => option.value === 'cimbar')) {
    method.add(new Option('CIMBAR ENGINE · LIBCIMBAR WASM v0.6.7c', 'cimbar'));
  }

  let passthrough = false;
  function stopUnderlyingQr() {
    passthrough = true;
    const previous = method.value;
    try {
      method.value = 'qr';
      $('stopRx')?.click();
    } finally {
      method.value = previous;
      passthrough = false;
    }
    try {
      for (const track of video?.srcObject?.getTracks?.() || []) track.stop();
      if (video) video.srcObject = null;
    } catch {}
  }

  method.addEventListener('change', () => {
    if (method.value === 'cimbar') {
      stopUnderlyingQr();
      if (status) {
        status.textContent = `CIMBAR ENGINE RX pronto · ${CIMBAR_VERSION} ufficiale · Auto/Mode B · 4 worker WASM.`;
        status.dataset.kind = 'ok';
      }
    } else if (activeKind === 'rx') {
      closeEngine();
    }
  });

  document.addEventListener('click', event => {
    if (passthrough || method.value !== 'cimbar') return;
    const id = event.target?.id;
    if (!['startRx', 'stopRx', 'resetRx'].includes(id)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (id === 'startRx') openRx();
    else if (id === 'resetRx') {
      closeEngine();
      openRx();
    } else closeEngine();
  }, true);
}

function install() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  ensureShell();
  installTx();
  installRx();
}

install();

export { CIMBAR_VERSION, CIMBAR_TX_URL, CIMBAR_RX_URL, CIMBAR_DEFAULT_MODE, CIMBAR_DEFAULT_FPS };
