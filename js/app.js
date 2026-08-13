import { FountainEncoder, FountainDecoder } from './fountain.js';
import { encodeOpticalPacket, decodeOpticalPacket, randomStreamId, sha256Hex } from './protocol.js';
import { renderFrame, CAPACITY_BYTES, QR_ECC } from './optical.js';

const $ = id => document.getElementById(id);
const RX_WORKERS = 2;
const RX_CAPTURE_WIDTH = 1280;
const RX_CAPTURE_FPS = 30;

const state = {
  encoder: null, meta: null, symbolId: 0, txGeneration: 0, transmitting: false, txFrames: 0, txStartedAt: 0,
  receiving: false, stream: null, track: null, captureGeneration: 0, captureCanvas: null,
  workers: [], workerBusy: [], workerCursor: 0, frameId: 0,
  rxCaptured: 0, rxDroppedBusy: 0, rxQrDecoded: 0, rxPacketRejected: 0, rxWorkerErrors: 0,
  rxDecoder: null, rxMeta: null, rxFrames: 0, rxLastSymbol: -1, rxStartedAt: 0,
  expectedHash: null, downloadUrl: null, wakeLock: null, installPrompt: null,
};

function log(message) {
  const el = $('log');
  if (!el) return;
  const line = `${new Date().toLocaleTimeString()}  ${message}`;
  el.textContent = `${line}\n${el.textContent}`.slice(0, 18000);
}
function status(id, text, kind = '') { const el = $(id); if (el) { el.textContent = text; el.dataset.kind = kind; } }
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB']; let value = bytes, unit = -1;
  do { value /= 1024; unit++; } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}
function compatiblePacket(a, b) {
  return a.streamId === b.streamId && a.sourceCount === b.sourceCount && a.chunkSize === b.chunkSize
    && a.fileLength === b.fileLength && a.sha256 === b.sha256;
}
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch (error) { log(`Wake lock non disponibile: ${error.message}`); }
}
async function releaseWakeLockIfIdle() {
  if (state.transmitting || state.receiving || !state.wakeLock) return;
  try { await state.wakeLock.release(); } catch {}
  state.wakeLock = null;
}

async function prepareFile(file) {
  stopTransmit();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await sha256Hex(bytes);
  const encoder = new FountainEncoder(bytes, 320);
  const packetSize = 96 + encoder.chunkSize + 4;
  if (packetSize > CAPACITY_BYTES) throw new Error('Il pacchetto QCT1 supera la capacità QR configurata.');
  state.encoder = encoder; state.symbolId = 0; state.txFrames = 0;
  state.meta = { streamId: randomStreamId(), sourceCount: encoder.sourceCount, chunkSize: encoder.chunkSize, fileLength: bytes.length, fileName: file.name, sha256: hash };
  $('txFileInfo').textContent = `${file.name} · ${formatBytes(bytes.length)} · ${encoder.sourceCount} blocchi × ${encoder.chunkSize} B · SHA-256 ${hash ? 'OK' : 'N/D'}`;
  status('txStatus', 'Pronto. Baseline QR standard + fountain code.', 'ok');
  log(`TX preparato: ${file.name}, ${bytes.length} byte, stream ${state.meta.streamId}`);
  await drawSymbol(++state.txGeneration);
}

async function drawSymbol(generation = state.txGeneration) {
  if (!state.encoder || generation !== state.txGeneration) return;
  const symbolId = state.symbolId;
  const symbol = state.encoder.symbol(symbolId);
  const packet = encodeOpticalPacket(state.meta, symbolId, symbol.data);
  const qr = await renderFrame($('txCanvas'), packet);
  if (generation !== state.txGeneration) return;
  state.txFrames++;
  state.symbolId = (state.symbolId + 1) >>> 0;
  const elapsed = state.txStartedAt ? Math.max(0.001, (performance.now() - state.txStartedAt) / 1000) : 0;
  const realFps = elapsed ? ((state.txFrames - 1) / elapsed).toFixed(1) : '—';
  const kind = symbolId < state.encoder.sourceCount ? 'sorgente' : `repair d${symbol.indices.length}`;
  $('txFrame').textContent = `QR V${qr.version} ECC ${qr.ecc} · stream ${state.meta.streamId} · simbolo ${symbolId} · ${kind} · ${realFps} fps`;
}

async function txLoop(generation) {
  while (state.transmitting && generation === state.txGeneration) {
    const fps = Number($('fps').value); const interval = 1000 / fps; const started = performance.now();
    try { await drawSymbol(generation); }
    catch (error) {
      state.transmitting = false;
      status('txStatus', `Errore QR: ${error.message}`, 'error');
      log(`TX QR error: ${error.stack || error.message}`);
      break;
    }
    const spent = performance.now() - started;
    if (generation !== state.txGeneration || !state.transmitting) break;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, interval - spent)));
  }
}
function startTransmit() {
  if (!state.encoder || state.transmitting) return;
  state.transmitting = true; state.txStartedAt = performance.now(); state.txFrames = 0;
  const generation = ++state.txGeneration;
  requestWakeLock();
  status('txStatus', `Trasmissione QR attiva a ${$('fps').value} fps.`, 'ok');
  log(`TX start @ ${$('fps').value} fps`);
  void txLoop(generation);
}
function stopTransmit() {
  state.transmitting = false; state.txGeneration++;
  if (state.encoder) status('txStatus', 'Trasmissione in pausa.');
  releaseWakeLockIfIdle();
}
async function restartTransmit() {
  if (!state.encoder) return;
  stopTransmit(); state.symbolId = 0; state.txFrames = 0;
  await drawSymbol(++state.txGeneration);
  status('txStatus', 'Sequenza riportata ai simboli sistematici iniziali.', 'ok');
  log('TX restart da simbolo 0');
}
async function toggleFullscreenTx() {
  const stage = $('txStage');
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (stage?.requestFullscreen) await stage.requestFullscreen();
  } catch (error) { status('txStatus', `Schermo intero non disponibile: ${error.message}`, 'warn'); }
}

function terminateWorkers() {
  for (const worker of state.workers) worker?.terminate();
  state.workers = []; state.workerBusy = []; state.workerCursor = 0;
}
function renderRxStats() {
  const solved = state.rxDecoder?.solvedCount || 0; const total = state.rxDecoder?.sourceCount || 0;
  $('rxStats').textContent = `${state.rxFrames} simboli fountain validi · ${state.rxQrDecoded} QR letti · ${state.rxCaptured} frame camera · ${state.rxDroppedBusy} frame saltati (worker occupati) · ${state.rxPacketRejected} pacchetti rifiutati · ${solved}/${total || '—'} blocchi`;
}
function ensureWorkers() {
  if (state.workers.length) return;
  for (let i = 0; i < RX_WORKERS; i++) {
    const worker = new Worker(new URL('./qr-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = event => {
      const { id, ready, bytes, error } = event.data || {};
      if (id === -1) {
        if (ready) log(`ZXing worker ${i + 1}/${RX_WORKERS} pronto`);
        else {
          state.rxWorkerErrors++;
          status('rxStatus', `ZXing-WASM non si inizializza: ${error}`, 'error');
          log(`ZXing worker init error: ${error}`);
        }
        return;
      }
      state.workerBusy[i] = false;
      if (error) {
        state.rxWorkerErrors++;
        if (state.rxWorkerErrors <= 3) log(`ZXing worker error: ${error}`);
      }
      if (bytes?.length) { state.rxQrDecoded++; void onDecodedQr(bytes); }
      renderRxStats();
    };
    worker.onerror = event => {
      state.workerBusy[i] = false; state.rxWorkerErrors++;
      status('rxStatus', `Worker QR: ${event.message}`, 'error');
      log(`Worker QR fatal: ${event.message}`);
    };
    state.workers.push(worker); state.workerBusy.push(false);
  }
}
function nextFreeWorker() {
  for (let offset = 0; offset < state.workers.length; offset++) {
    const index = (state.workerCursor + offset) % state.workers.length;
    if (!state.workerBusy[index]) { state.workerCursor = (index + 1) % state.workers.length; return index; }
  }
  return -1;
}

async function startCamera() {
  if (state.receiving) return;
  if (!navigator.mediaDevices?.getUserMedia) { status('rxStatus', 'La fotocamera richiede HTTPS e un browser compatibile.', 'error'); return; }
  ensureWorkers();
  const base = { facingMode: { ideal: 'environment' }, width: { ideal: RX_CAPTURE_WIDTH }, height: { ideal: Math.round(RX_CAPTURE_WIDTH * 3 / 4) } };
  try {
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, frameRate: { exact: RX_CAPTURE_FPS } } });
    } catch {
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, frameRate: { ideal: RX_CAPTURE_FPS } } });
    }
    const video = $('rxVideo'); video.srcObject = state.stream; await video.play();
    state.track = state.stream.getVideoTracks()[0] || null;
    state.receiving = true; state.captureGeneration++; state.rxStartedAt = performance.now(); requestWakeLock();
    const settings = state.track?.getSettings?.() || {};
    status('rxStatus', `Camera ${settings.width || video.videoWidth}×${settings.height || video.videoHeight}@${Math.round(settings.frameRate || 0)} · ZXing cerca il QR nell'intero frame.`, 'ok');
    log(`RX camera: ${state.track?.label || 'video'} · ${video.videoWidth}x${video.videoHeight}`);
    scheduleCapture(state.captureGeneration);
  } catch (error) {
    status('rxStatus', `Fotocamera non disponibile: ${error.message}`, 'error');
    log(`RX camera error: ${error.name} ${error.message}`);
  }
}
function stopCamera() {
  state.receiving = false; state.captureGeneration++;
  state.stream?.getTracks().forEach(track => track.stop()); state.stream = null; state.track = null;
  if ($('rxVideo')) $('rxVideo').srcObject = null;
  if (!state.rxDecoder?.complete) status('rxStatus', 'Fotocamera ferma.');
  releaseWakeLockIfIdle();
}
function resetReceiver() {
  state.rxDecoder = null; state.rxMeta = null; state.rxFrames = 0; state.rxLastSymbol = -1;
  state.rxCaptured = 0; state.rxDroppedBusy = 0; state.rxQrDecoded = 0; state.rxPacketRejected = 0; state.rxWorkerErrors = 0;
  state.expectedHash = null; state.rxStartedAt = performance.now(); $('rxProgress').value = 0;
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
  state.downloadUrl = null; const download = $('download'); download.hidden = true; download.removeAttribute('href');
  renderRxStats();
  status('rxStatus', state.receiving ? 'Ricevitore azzerato. Continua a inquadrare il QR.' : 'Ricevitore azzerato.');
  log('RX reset');
}

async function acceptPacket(packet) {
  if (!state.rxDecoder || state.rxMeta?.streamId !== packet.streamId) {
    state.rxMeta = packet;
    state.rxDecoder = new FountainDecoder(packet.sourceCount, packet.chunkSize, packet.fileLength);
    state.rxFrames = 0; state.rxLastSymbol = -1; state.expectedHash = packet.sha256; state.rxStartedAt = performance.now();
    log(`RX nuovo stream ${packet.streamId}: ${packet.fileName}, ${packet.fileLength} byte`);
  } else if (!compatiblePacket(state.rxMeta, packet)) throw new Error('Metadati stream incoerenti');

  if (packet.symbolId === state.rxLastSymbol) return;
  state.rxLastSymbol = packet.symbolId;
  const added = state.rxDecoder.addSymbol(packet.symbolId, packet.payload);
  if (!added) return;
  state.rxFrames++;
  const pct = Math.floor(state.rxDecoder.progress * 1000) / 10; $('rxProgress').value = pct;
  const elapsed = Math.max(0.001, (performance.now() - state.rxStartedAt) / 1000);
  const validRate = (state.rxFrames / elapsed).toFixed(1);
  renderRxStats();
  status('rxStatus', `Ricezione ${pct}% · ultimo simbolo ${packet.symbolId} · ${validRate} QR utili/s`, 'ok');

  if (!state.rxDecoder.complete) return;
  const bytes = state.rxDecoder.reconstruct(); const hash = await sha256Hex(bytes);
  if (hash && state.expectedHash && hash !== state.expectedHash) {
    status('rxStatus', 'File ricostruito ma SHA-256 non coincide. Download bloccato.', 'error');
    log(`SHA-256 FAIL: atteso ${state.expectedHash}, ricevuto ${hash}`); return;
  }
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
  state.downloadUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = $('download'); link.href = state.downloadUrl; link.download = state.rxMeta.fileName || 'qcolortrasfer.bin'; link.hidden = false;
  link.textContent = `SCARICA ${link.download} (${formatBytes(bytes.length)})`;
  status('rxStatus', `COMPLETATO · ${formatBytes(bytes.length)} · ${hash && state.expectedHash ? 'SHA-256 OK' : 'ricostruzione completata'}`, 'ok');
  log(`RX completo: ${link.download}, ${bytes.length} byte`); stopCamera();
}
async function onDecodedQr(bytes) {
  try {
    const packet = decodeOpticalPacket(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    await acceptPacket(packet);
  } catch (error) {
    state.rxPacketRejected++;
    if (state.rxPacketRejected <= 3 || state.rxPacketRejected % 20 === 0) log(`QR letto ma pacchetto rifiutato: ${error.message}`);
  }
  renderRxStats();
}

function captureFrame() {
  const video = $('rxVideo'); const width = video.videoWidth; const height = video.videoHeight;
  if (!width || !height) return;
  const workerIndex = nextFreeWorker(); state.rxCaptured++;
  if (workerIndex < 0) { state.rxDroppedBusy++; renderRxStats(); return; }
  if (!state.captureCanvas) state.captureCanvas = document.createElement('canvas');
  const canvas = state.captureCanvas;
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  ctx.drawImage(video, 0, 0, width, height);
  const image = ctx.getImageData(0, 0, width, height); const id = state.frameId++;
  state.workerBusy[workerIndex] = true;
  state.workers[workerIndex].postMessage({ id, buf: image.data.buffer, w: width, h: height }, [image.data.buffer]);
}
function scheduleCapture(generation) {
  if (!state.receiving || generation !== state.captureGeneration) return;
  const video = $('rxVideo');
  const next = () => {
    if (!state.receiving || generation !== state.captureGeneration) return;
    captureFrame(); scheduleCapture(generation);
  };
  if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

async function runSelfTest() {
  try {
    const payload = Uint8Array.from({ length: 320 }, (_, i) => (i * 37 + 11) & 255);
    const meta = { streamId: 0x12345678, sourceCount: 1, chunkSize: 320, fileLength: 320, fileName: 'selftest.bin', sha256: 'ab'.repeat(32) };
    const packet = encodeOpticalPacket(meta, 0, payload); const parsed = decodeOpticalPacket(packet);
    if (parsed.streamId !== meta.streamId || parsed.payload.length !== payload.length) throw new Error('QCT1 roundtrip');
    const qr = await renderFrame(document.createElement('canvas'), packet);
    status('selfTest', `Autotest: OK · QCT1 + QR generator V${qr.version} ECC ${qr.ecc}. ZXing-WASM viene verificato dai worker all'avvio camera.`, 'ok');
    log(`Autotest baseline QR OK · V${qr.version}`);
  } catch (error) {
    status('selfTest', `Autotest: ERRORE · ${error.message}`, 'error');
    log(`Autotest FAIL: ${error.stack || error.message}`);
  }
}
function updateNetworkState() { if ($('netState')) $('netState').textContent = navigator.onLine ? 'rete: online' : 'rete: offline'; }
async function setupPwa() {
  updateNetworkState(); window.addEventListener('online', updateNetworkState); window.addEventListener('offline', updateNetworkState);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone && $('pwaState')) $('pwaState').textContent = 'app: installata';
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      if ($('pwaState')) $('pwaState').textContent = standalone ? 'app: installata' : 'app: offline pronta';
      registration.update().catch(() => {}); log(`Service worker registrato: ${registration.scope}`);
    } catch (error) {
      if ($('pwaState')) $('pwaState').textContent = 'app: SW errore';
      log(`Service worker error: ${error.message}`);
    }
  }
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); state.installPrompt = event; if ($('installPwa')) $('installPwa').hidden = false; });
  window.addEventListener('appinstalled', () => { if ($('installPwa')) $('installPwa').hidden = true; if ($('pwaState')) $('pwaState').textContent = 'app: installata'; state.installPrompt = null; });
  $('installPwa')?.addEventListener('click', async () => {
    if (!state.installPrompt) return;
    await state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; $('installPwa').hidden = true;
  });
}

$('fileInput').addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (file) prepareFile(file).catch(error => { status('txStatus', error.message, 'error'); log(`TX prepare error: ${error.stack || error.message}`); });
});
$('startTx').addEventListener('click', startTransmit);
$('stopTx').addEventListener('click', stopTransmit);
$('restartTx')?.addEventListener('click', () => { void restartTransmit(); });
$('fullTx')?.addEventListener('click', toggleFullscreenTx);
$('startRx').addEventListener('click', startCamera);
$('stopRx').addEventListener('click', stopCamera);
$('resetRx').addEventListener('click', resetReceiver);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (state.transmitting || state.receiving)) requestWakeLock(); });
window.addEventListener('beforeunload', () => {
  stopTransmit(); stopCamera(); terminateWorkers(); if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
});

$('capacity').textContent = `baseline: QR standard ECC ${QR_ECC} · QCT1 + fountain`;
resetReceiver();
setupPwa();
void runSelfTest();
