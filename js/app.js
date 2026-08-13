import { FountainEncoder, FountainDecoder } from './fountain.js';
import { encodeOpticalPacket, decodeOpticalPacket, randomStreamId, sha256Hex, HEADER_BYTES } from './protocol.js';
import { CAPACITY_BYTES, QR_ECC, MAX_GRID_CODES, MIN_AUTO_QR_SIDE, chooseGridCount, createQrRaster, gridDims } from './optical.js';

const $ = id => document.getElementById(id);
const FOUNTAIN_CHUNK_BYTES = 512;
const RX_WORKERS = 2;
const RX_CAPTURE_WIDTH = 1920;
const RX_CAPTURE_FPS = 30;

const state = {
  encoder: null, meta: null, symbolId: 0, transmitting: false, txGeneration: 0, txStartedAt: 0, txSymbolsShown: 0,
  txSlots: 1, txCols: 1, txRows: 1, txCells: [], txStaging: null, txRasterSize: 0, txCellCursor: 0, txScale: 1, txStretch: 1, txLastItem: null,
  receiving: false, stream: null, track: null, captureGeneration: 0, captureCanvas: null,
  workers: [], workerBusy: [], workerCursor: 0, frameId: 0,
  rxCaptured: 0, rxDroppedBusy: 0, rxQrDecoded: 0, rxPacketRejected: 0, rxWorkerErrors: 0,
  rxDecoder: null, rxMeta: null, rxStartedAt: 0, expectedHash: null, downloadUrl: null,
  wakeLock: null, installPrompt: null,
};

function log(message) { const el = $('log'); if (!el) return; const line = `${new Date().toLocaleTimeString()}  ${message}`; el.textContent = `${line}\n${el.textContent}`.slice(0, 22000); }
function status(id, text, kind = '') { const el = $(id); if (!el) return; el.textContent = text; el.dataset.kind = kind; }
function formatBytes(bytes) { if (bytes < 1024) return `${bytes} B`; const units = ['KiB', 'MiB', 'GiB']; let value = bytes, unit = -1; do { value /= 1024; unit++; } while (value >= 1024 && unit < units.length - 1); return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`; }
function compatiblePacket(a, b) { return a.streamId === b.streamId && a.sourceCount === b.sourceCount && a.chunkSize === b.chunkSize && a.fileLength === b.fileLength && a.sha256 === b.sha256; }
function estimatedFountainTarget(k) { if (k <= 4) return Math.max(k, Math.ceil(k * 2.5)); if (k < 32) return Math.ceil(k * 1.6); if (k < 128) return Math.ceil(k * 1.35); return Math.ceil(k * 1.20); }

async function requestWakeLock() { if (!('wakeLock' in navigator) || state.wakeLock) return; try { state.wakeLock = await navigator.wakeLock.request('screen'); state.wakeLock.addEventListener('release', () => { state.wakeLock = null; }); } catch (error) { log(`Wake lock non disponibile: ${error.message}`); } }
async function releaseWakeLockIfIdle() { if (state.transmitting || state.receiving || !state.wakeLock) return; try { await state.wakeLock.release(); } catch {} state.wakeLock = null; }

function txStageBudget() {
  const stage = $('txStage');
  const style = getComputedStyle(stage);
  const px = value => Number.parseFloat(value) || 0;
  return { width: Math.max(1, stage.clientWidth - px(style.paddingLeft) - px(style.paddingRight)), height: Math.max(1, stage.clientHeight - px(style.paddingTop) - px(style.paddingBottom)) };
}
function selectedGridCount() { const mode = $('gridMode').value; if (mode !== 'auto') return Math.max(1, Math.min(MAX_GRID_CODES, Number(mode) || 1)); const { width, height } = txStageBudget(); return chooseGridCount(width, height, MIN_AUTO_QR_SIDE); }
function updateGridLabel() { const { width, height } = txStageBudget(); const side = Math.floor(Math.min(width / state.txCols, height / state.txRows)); $('gridState').textContent = `${state.txSlots} QR · ${state.txCols}×${state.txRows} · ~${side}px/QR`; }

function ensureTxStaging() {
  if (!state.txRasterSize) return;
  const width = state.txRasterSize * state.txCols, height = state.txRasterSize * state.txRows;
  if (!state.txStaging) state.txStaging = document.createElement('canvas');
  if (state.txStaging.width !== width || state.txStaging.height !== height) { state.txStaging.width = width; state.txStaging.height = height; }
  const ctx = state.txStaging.getContext('2d', { alpha: false }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
  state.txCells.forEach((item, index) => { if (!item) return; const x = (index % state.txCols) * state.txRasterSize; const y = Math.floor(index / state.txCols) * state.txRasterSize; ctx.putImageData(new ImageData(item.raster.pixels, state.txRasterSize, state.txRasterSize), x, y); });
}

function resizeTxCanvas() {
  if (!state.txRasterSize || !state.txStaging) return;
  const { width: budgetW, height: budgetH } = txStageBudget();
  const logicalW = state.txRasterSize * state.txCols, logicalH = state.txRasterSize * state.txRows;
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
  const scale = Math.max(1, Math.floor(Math.min((budgetW * dpr) / logicalW, (budgetH * dpr) / logicalH)));
  const canvas = $('txCanvas'); canvas.width = logicalW * scale; canvas.height = logicalH * scale; state.txScale = scale;
  const nativeCssW = canvas.width / dpr, nativeCssH = canvas.height / dpr;
  const stretch = Math.max(0.1, Math.min(budgetW / nativeCssW, budgetH / nativeCssH)); state.txStretch = stretch;
  canvas.style.width = `${nativeCssW * stretch}px`; canvas.style.height = `${nativeCssH * stretch}px`; canvas.style.imageRendering = 'auto';
  const ctx = canvas.getContext('2d', { alpha: false }); ctx.imageSmoothingEnabled = false; ctx.drawImage(state.txStaging, 0, 0, canvas.width, canvas.height); updateGridLabel();
}

function paintTxCell(index, item) {
  if (!item) return;
  if (!state.txRasterSize) state.txRasterSize = item.raster.size;
  if (item.raster.size !== state.txRasterSize) throw new Error('La versione QR è cambiata durante lo stream');
  state.txCells[index] = item;
  if (!state.txStaging) ensureTxStaging();
  const logicalX = (index % state.txCols) * state.txRasterSize, logicalY = Math.floor(index / state.txCols) * state.txRasterSize;
  const stagingCtx = state.txStaging.getContext('2d', { alpha: false });
  stagingCtx.putImageData(new ImageData(item.raster.pixels, state.txRasterSize, state.txRasterSize), logicalX, logicalY);
  const canvas = $('txCanvas');
  if (!canvas.width || !canvas.height) resizeTxCanvas();
  else { const ctx = canvas.getContext('2d', { alpha: false }); ctx.imageSmoothingEnabled = false; const source = state.txRasterSize, dest = source * state.txScale; ctx.drawImage(state.txStaging, logicalX, logicalY, source, source, logicalX * state.txScale, logicalY * state.txScale, dest, dest); }
  state.txLastItem = item; updateTxMeta();
}

function updateTxMeta() {
  if (!state.encoder || !state.txLastItem) return;
  const fps = Number($('fps').value), aggregate = fps * state.txSlots;
  const elapsed = state.txStartedAt ? Math.max(0.001, (performance.now() - state.txStartedAt) / 1000) : 0;
  const actual = elapsed ? (state.txSymbolsShown / elapsed).toFixed(1) : '—';
  $('txFrame').textContent = `QR V${state.txLastItem.raster.version} ECC ${QR_ECC} · ${state.txSlots} simultanei · ${fps} fps/QR · ${aggregate} simboli/s teorici · ${actual} simboli/s generati · seq ${state.txLastItem.symbolId}`;
}

async function makeTxItem(generation) {
  if (!state.encoder || generation !== state.txGeneration) return null;
  const symbolId = state.symbolId >>> 0; state.symbolId = (state.symbolId + 1) >>> 0;
  const symbol = state.encoder.symbol(symbolId); const packet = encodeOpticalPacket(state.meta, symbolId, symbol.data); const raster = await createQrRaster(packet);
  if (generation !== state.txGeneration) return null;
  return { symbolId, degree: symbol.indices.length, raster };
}

async function rebuildTxGrid(reason = 'layout') {
  if (!state.encoder) return;
  const resume = state.transmitting; state.transmitting = false; const generation = ++state.txGeneration;
  const { width, height } = txStageBudget(); state.txSlots = selectedGridCount(); const dims = gridDims(state.txSlots, width, height); state.txCols = dims.cols; state.txRows = dims.rows;
  state.txCells = new Array(state.txSlots).fill(null); state.txStaging = null; state.txRasterSize = 0; state.txCellCursor = 0;
  for (let index = 0; index < state.txSlots; index++) {
    const item = await makeTxItem(generation); if (!item || generation !== state.txGeneration) return;
    if (!state.txRasterSize) { state.txRasterSize = item.raster.size; ensureTxStaging(); resizeTxCanvas(); }
    paintTxCell(index, item); state.txSymbolsShown++;
  }
  resizeTxCanvas(); const mode = $('gridMode').value === 'auto' ? 'AUTO' : 'manuale'; log(`TX ${reason}: ${state.txSlots} QR (${state.txCols}x${state.txRows}) · ${mode}`);
  if (resume && generation === state.txGeneration) { state.transmitting = true; state.txStartedAt = performance.now(); state.txSymbolsShown = 0; void txLoop(generation); }
}

async function prepareFile(file) {
  stopTransmit(); const bytes = new Uint8Array(await file.arrayBuffer()); const hash = await sha256Hex(bytes); const streamId = randomStreamId();
  const encoder = new FountainEncoder(bytes, FOUNTAIN_CHUNK_BYTES, streamId);
  const probeMeta = { streamId, sourceCount: encoder.sourceCount, chunkSize: encoder.chunkSize, fileLength: bytes.length, fileName: file.name, sha256: hash };
  const probe = encodeOpticalPacket(probeMeta, 0, encoder.symbol(0).data); if (probe.length > CAPACITY_BYTES) throw new Error(`QCT1 ${probe.length} B supera il limite QR ${CAPACITY_BYTES} B`);
  state.encoder = encoder; state.meta = probeMeta; state.symbolId = 0; state.txSymbolsShown = 0; state.txStartedAt = 0;
  $('txFileInfo').textContent = `${file.name} · ${formatBytes(bytes.length)} · K=${encoder.sourceCount} blocchi × ${encoder.chunkSize} B · robust-soliton LT · SHA-256 ${hash ? 'OK' : 'N/D'}`;
  status('txStatus', 'Pronto. Il layout AUTO usa il massimo numero di QR leggibili nello spazio disponibile.', 'ok'); log(`TX preparato: ${file.name}, ${bytes.length} byte, stream ${streamId}, K=${encoder.sourceCount}`);
  await rebuildTxGrid('iniziale');
}

async function txLoop(generation) {
  while (state.transmitting && generation === state.txGeneration) {
    const fpsPerCode = Math.max(1, Number($('fps').value)); const interval = 1000 / (fpsPerCode * state.txSlots); const started = performance.now();
    try { const item = await makeTxItem(generation); if (!item) break; paintTxCell(state.txCellCursor, item); state.txCellCursor = (state.txCellCursor + 1) % state.txSlots; state.txSymbolsShown++; }
    catch (error) { state.transmitting = false; status('txStatus', `Errore QR: ${error.message}`, 'error'); log(`TX QR error: ${error.stack || error.message}`); break; }
    const spent = performance.now() - started; if (!state.transmitting || generation !== state.txGeneration) break; await new Promise(resolve => setTimeout(resolve, Math.max(0, interval - spent)));
  }
}

function startTransmit() { if (!state.encoder || state.transmitting) return; state.transmitting = true; state.txStartedAt = performance.now(); state.txSymbolsShown = 0; const generation = ++state.txGeneration; requestWakeLock(); const aggregate = Number($('fps').value) * state.txSlots; status('txStatus', `Trasmissione attiva: ${state.txSlots} QR · ${$('fps').value} fps per QR · fino a ${aggregate} nuovi simboli/s.`, 'ok'); log(`TX start · ${state.txSlots} QR @ ${$('fps').value} fps/QR`); void txLoop(generation); }
function stopTransmit() { state.transmitting = false; state.txGeneration++; if (state.encoder) status('txStatus', 'Trasmissione in pausa. I QR visibili restano decodificabili.'); releaseWakeLockIfIdle(); }
async function toggleFullscreenTx() { const stage = $('txStage'); try { if (document.fullscreenElement) await document.exitFullscreen(); else if (stage.requestFullscreen) await stage.requestFullscreen(); else status('txStatus', 'Schermo intero non supportato da questo browser; ruota il dispositivo per sfruttare la larghezza.', 'warn'); } catch (error) { status('txStatus', `Schermo intero non disponibile: ${error.message}`, 'warn'); } }

let resizeTimer = null;
function scheduleTxDisplayRefresh() { clearTimeout(resizeTimer); resizeTimer = setTimeout(async () => { if (!state.encoder) return; if ($('gridMode').value === 'auto' && selectedGridCount() !== state.txSlots) await rebuildTxGrid('ridimensionamento'); else resizeTxCanvas(); }, 180); }

function terminateWorkers() { for (const worker of state.workers) worker?.terminate(); state.workers = []; state.workerBusy = []; state.workerCursor = 0; }
function renderRxStats() { const decoder = state.rxDecoder; const distinct = decoder?.framesNew || 0, dup = decoder?.framesDup || 0, solved = decoder?.solvedCount || 0, total = decoder?.sourceCount || 0, target = total ? estimatedFountainTarget(total) : 0; $('rxStats').textContent = `${distinct} QR distinti · ${dup} duplicati · ${state.rxQrDecoded} QR letti · ${state.rxCaptured} frame camera · ${state.rxDroppedBusy} frame saltati · ${state.rxPacketRejected} pacchetti rifiutati · peeling ${solved}/${total || '—'} · target stimato ${target || '—'}`; }

function ensureWorkers() {
  if (state.workers.length) return;
  for (let i = 0; i < RX_WORKERS; i++) {
    const worker = new Worker(new URL('./qr-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = event => {
      const { id, ready, symbols = [], error } = event.data || {};
      if (id === -1) { if (ready) log(`ZXing worker ${i + 1}/${RX_WORKERS} pronto · multi-QR`); else { state.rxWorkerErrors++; status('rxStatus', `ZXing-WASM non si inizializza: ${error}`, 'error'); log(`ZXing worker init error: ${error}`); } return; }
      state.workerBusy[i] = false; if (error) { state.rxWorkerErrors++; if (state.rxWorkerErrors <= 3) log(`ZXing worker error: ${error}`); }
      if (symbols.length) { state.rxQrDecoded += symbols.length; void onDecodedSymbols(symbols); }
      renderRxStats();
    };
    worker.onerror = event => { state.workerBusy[i] = false; state.rxWorkerErrors++; status('rxStatus', `Worker QR: ${event.message}`, 'error'); log(`Worker QR fatal: ${event.message}`); };
    state.workers.push(worker); state.workerBusy.push(false);
  }
}
function nextFreeWorker() { for (let offset = 0; offset < state.workers.length; offset++) { const index = (state.workerCursor + offset) % state.workers.length; if (!state.workerBusy[index]) { state.workerCursor = (index + 1) % state.workers.length; return index; } } return -1; }

async function startCamera() {
  if (state.receiving) return; if (!navigator.mediaDevices?.getUserMedia) { status('rxStatus', 'La fotocamera richiede HTTPS e un browser compatibile.', 'error'); return; }
  ensureWorkers(); const base = { facingMode: { ideal: 'environment' }, width: { ideal: RX_CAPTURE_WIDTH }, height: { ideal: Math.round(RX_CAPTURE_WIDTH * 9 / 16) } };
  try {
    try { state.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, frameRate: { exact: RX_CAPTURE_FPS } } }); }
    catch { state.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, frameRate: { ideal: RX_CAPTURE_FPS } } }); }
    const video = $('rxVideo'); video.srcObject = state.stream; await video.play(); state.track = state.stream.getVideoTracks()[0] || null; state.receiving = true; state.captureGeneration++; state.rxStartedAt = performance.now(); requestWakeLock();
    const settings = state.track?.getSettings?.() || {}; status('rxStatus', `Camera ${settings.width || video.videoWidth}×${settings.height || video.videoHeight}@${Math.round(settings.frameRate || 0)} · ZXing cerca fino a 8 QR nello stesso fotogramma.`, 'ok'); log(`RX camera: ${state.track?.label || 'video'} · ${video.videoWidth}x${video.videoHeight}`); scheduleCapture(state.captureGeneration);
  } catch (error) { status('rxStatus', `Fotocamera non disponibile: ${error.message}`, 'error'); log(`RX camera error: ${error.name} ${error.message}`); }
}
function stopCamera() { state.receiving = false; state.captureGeneration++; state.stream?.getTracks().forEach(track => track.stop()); state.stream = null; state.track = null; $('rxVideo').srcObject = null; if (!state.rxDecoder?.complete) status('rxStatus', 'Fotocamera ferma.'); releaseWakeLockIfIdle(); }
function resetReceiver() { state.rxDecoder = null; state.rxMeta = null; state.rxCaptured = 0; state.rxDroppedBusy = 0; state.rxQrDecoded = 0; state.rxPacketRejected = 0; state.rxWorkerErrors = 0; state.expectedHash = null; state.rxStartedAt = performance.now(); $('rxProgress').value = 0; if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl); state.downloadUrl = null; const download = $('download'); download.hidden = true; download.removeAttribute('href'); renderRxStats(); status('rxStatus', state.receiving ? 'Ricevitore azzerato. Continua a inquadrare l’intera griglia QR.' : 'Ricevitore azzerato.'); log('RX reset'); }

async function acceptPacket(packet) {
  if (!state.rxDecoder || state.rxMeta?.streamId !== packet.streamId) { state.rxMeta = packet; state.rxDecoder = new FountainDecoder(packet.sourceCount, packet.chunkSize, packet.fileLength, packet.streamId); state.expectedHash = packet.sha256; state.rxStartedAt = performance.now(); log(`RX nuovo stream ${packet.streamId}: ${packet.fileName}, ${packet.fileLength} byte, K=${packet.sourceCount}`); }
  else if (!compatiblePacket(state.rxMeta, packet)) throw new Error('Metadati stream incoerenti');
  const added = state.rxDecoder.addSymbol(packet.symbolId, packet.payload); if (!added) return;
  const target = estimatedFountainTarget(state.rxDecoder.sourceCount); const estimatedFraction = state.rxDecoder.complete ? 1 : Math.min(0.99, state.rxDecoder.framesNew / target); const pct = Math.floor(estimatedFraction * 1000) / 10; $('rxProgress').value = pct;
  const elapsed = Math.max(0.001, (performance.now() - state.rxStartedAt) / 1000); const validRate = (state.rxDecoder.framesNew / elapsed).toFixed(1); renderRxStats(); status('rxStatus', `Ricezione ~${pct}% · ${state.rxDecoder.framesNew}/${target} simboli distinti stimati · ${validRate}/s · peeling ${state.rxDecoder.solvedCount}/${state.rxDecoder.sourceCount}`, 'ok');
  if (!state.rxDecoder.complete) return;
  $('rxProgress').value = 100; const bytes = state.rxDecoder.reconstruct(); const hash = await sha256Hex(bytes);
  if (hash && state.expectedHash && hash !== state.expectedHash) { status('rxStatus', 'File ricostruito ma SHA-256 non coincide. Download bloccato.', 'error'); log(`SHA-256 FAIL: atteso ${state.expectedHash}, ricevuto ${hash}`); return; }
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl); state.downloadUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })); const link = $('download'); link.href = state.downloadUrl; link.download = state.rxMeta.fileName || 'qcolortrasfer.bin'; link.hidden = false; link.textContent = `SCARICA ${link.download} (${formatBytes(bytes.length)})`; status('rxStatus', `COMPLETATO · ${formatBytes(bytes.length)} · SHA-256 ${hash && state.expectedHash ? 'OK' : 'N/D'} · ${state.rxDecoder.framesNew} QR distinti`, 'ok'); log(`RX completo: ${link.download}, ${bytes.length} byte, ${state.rxDecoder.framesNew} QR distinti`); stopCamera();
}

async function onDecodedSymbols(symbols) { for (const raw of symbols) { try { const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw); const packet = decodeOpticalPacket(bytes); await acceptPacket(packet); } catch (error) { state.rxPacketRejected++; if (state.rxPacketRejected <= 3 || state.rxPacketRejected % 20 === 0) log(`QR letto ma pacchetto rifiutato: ${error.message}`); } } renderRxStats(); }

function captureFrame() {
  const video = $('rxVideo'), width = video.videoWidth, height = video.videoHeight; if (!width || !height) return; const workerIndex = nextFreeWorker(); state.rxCaptured++;
  if (workerIndex < 0) { state.rxDroppedBusy++; renderRxStats(); return; }
  if (!state.captureCanvas) state.captureCanvas = document.createElement('canvas'); const canvas = state.captureCanvas; if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true }); ctx.drawImage(video, 0, 0, width, height); const image = ctx.getImageData(0, 0, width, height); const id = state.frameId++; state.workerBusy[workerIndex] = true; state.workers[workerIndex].postMessage({ id, buf: image.data.buffer, w: width, h: height }, [image.data.buffer]);
}
function scheduleCapture(generation) { if (!state.receiving || generation !== state.captureGeneration) return; const video = $('rxVideo'); const next = () => { if (!state.receiving || generation !== state.captureGeneration) return; captureFrame(); scheduleCapture(generation); }; if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(next); else requestAnimationFrame(next); }

async function runSelfTest() {
  try { const bytes = Uint8Array.from({ length: 512 }, (_, i) => (i * 37 + 11) & 255); const streamId = 0x12345678; const enc = new FountainEncoder(bytes, 512, streamId); const symbol = enc.symbol(0); const meta = { streamId, sourceCount: enc.sourceCount, chunkSize: enc.chunkSize, fileLength: bytes.length, fileName: 'selftest.bin', sha256: 'ab'.repeat(32) }; const packet = encodeOpticalPacket(meta, 0, symbol.data); if (packet.length !== HEADER_BYTES + 512 + 4) throw new Error('dimensione QCT1 inattesa'); const parsed = decodeOpticalPacket(packet); if (parsed.streamId !== streamId || parsed.payload.length !== 512) throw new Error('QCT1 roundtrip'); const raster = await createQrRaster(packet); status('selfTest', `Autotest: OK · LT robust-soliton · QCT1 ${packet.length} B · QR V${raster.version} ECC ${raster.ecc} · multi-grid fino a ${MAX_GRID_CODES}.`, 'ok'); log(`Autotest OK · QR V${raster.version}, ${raster.modules} moduli`); }
  catch (error) { status('selfTest', `Autotest: ERRORE · ${error.message}`, 'error'); log(`Autotest FAIL: ${error.stack || error.message}`); }
}
function updateNetworkState() { $('netState').textContent = navigator.onLine ? 'rete: online' : 'rete: offline'; }
async function setupPwa() { updateNetworkState(); window.addEventListener('online', updateNetworkState); window.addEventListener('offline', updateNetworkState); const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; if (standalone) $('pwaState').textContent = 'app: installata'; if ('serviceWorker' in navigator && location.protocol !== 'file:') { try { const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' }); $('pwaState').textContent = standalone ? 'app: installata' : 'app: offline pronta'; registration.update().catch(() => {}); log(`Service worker registrato: ${registration.scope}`); } catch (error) { $('pwaState').textContent = 'app: SW errore'; log(`Service worker error: ${error.message}`); } } window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); state.installPrompt = event; $('installPwa').hidden = false; }); window.addEventListener('appinstalled', () => { $('installPwa').hidden = true; $('pwaState').textContent = 'app: installata'; state.installPrompt = null; }); $('installPwa').addEventListener('click', async () => { if (!state.installPrompt) return; await state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; $('installPwa').hidden = true; }); }

$('fileInput').addEventListener('change', event => { const file = event.target.files?.[0]; if (file) prepareFile(file).catch(error => { status('txStatus', error.message, 'error'); log(`TX prepare error: ${error.stack || error.message}`); }); });
$('startTx').addEventListener('click', startTransmit); $('stopTx').addEventListener('click', stopTransmit); $('fullTx').addEventListener('click', toggleFullscreenTx); $('gridMode').addEventListener('change', () => { if (state.encoder) void rebuildTxGrid('selettore griglia'); }); $('fps').addEventListener('change', updateTxMeta); $('startRx').addEventListener('click', startCamera); $('stopRx').addEventListener('click', stopCamera); $('resetRx').addEventListener('click', resetReceiver);
window.addEventListener('resize', scheduleTxDisplayRefresh); window.addEventListener('orientationchange', scheduleTxDisplayRefresh); document.addEventListener('fullscreenchange', scheduleTxDisplayRefresh); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (state.transmitting || state.receiving)) requestWakeLock(); });
window.addEventListener('beforeunload', () => { stopTransmit(); stopCamera(); terminateWorkers(); if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl); });

$('capacity').textContent = `QR standard ECC ${QR_ECC} · fino a ${MAX_GRID_CODES} simultanei · LT robust-soliton`;
resetReceiver(); setupPwa(); void runSelfTest();
