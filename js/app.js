import { FountainEncoder, FountainDecoder } from './fountain.js';
import { encodeOpticalPacket, decodeOpticalPacket, randomStreamId, sha256Hex, HEADER_BYTES } from './protocol.js';
import {
  CAPACITY_BYTES, QR_ECC, MAX_GRID_CODES, MIN_AUTO_QR_SIDE,
  chooseGridCount, createDualQrRaster, createTripleQrRaster, gridDims
} from './optical.js';
import {
  adaptiveDwellMs, adaptiveGridCap, adaptiveNextPaintAt, adaptiveOpticalFpsCeiling
} from './adaptive-scheduler.js';
import { RoiTracker, workerCountForHardware } from './rx-roi.js';

const $ = id => document.getElementById(id);
const RX_CAPTURE_WIDTH = 1920;
const RX_CAPTURE_FPS_TARGET = 60;
const RX_CAPTURE_FPS_FALLBACK = 30;

const state = {
  selectedFile: null,
  encoder: null, meta: null, symbolId: 0, transmitting: false, txGeneration: 0, txStartedAt: 0, txSymbolsShown: 0,
  txSlots: 1, txCols: 1, txRows: 1, txCells: [], txCellPaintedAt: [], txStaging: null, txRasterSize: 0,
  txCellCursor: 0, txScale: 1, txStretch: 1, txLastItem: null, txGenerationMsEma: 0,

  receiving: false, stream: null, track: null, captureGeneration: 0, captureCanvas: null,
  workers: [], workerBusy: [], workerTasks: [], workerCursor: 0, frameId: 0, rxWorkerCount: 0,
  roiTracker: new RoiTracker(),
  rxCaptured: 0, rxDroppedBusy: 0, rxFullScans: 0, rxCropTasks: 0, rxCropHits: 0,
  rxBaseDecoded: 0, rxEightBase: 0,
  rxColor1Candidates: 0, rxColor1Decoded: 0, rxColor1Separation: 0,
  rxColor2Candidates: 0, rxColor2Decoded: 0, rxColor2Separation: 0,
  rxPacketRejected: 0, rxWorkerErrors: 0,
  rxDecoder: null, rxMeta: null, rxStartedAt: 0, expectedHash: null, downloadUrl: null,
  rxFinalizing: false, rxComplete: false,
  wakeLock: null, installPrompt: null,
};

function log(message) {
  const el = $('log');
  if (!el) return;
  const line = `${new Date().toLocaleTimeString()}  ${message}`;
  el.textContent = `${line}\n${el.textContent}`.slice(0, 30000);
}
function status(id, text, kind = '') { const el = $(id); if (!el) return; el.textContent = text; el.dataset.kind = kind; }
function formatBytes(bytes) { if (bytes < 1024) return `${bytes} B`; const units = ['KiB', 'MiB', 'GiB']; let value = bytes, unit = -1; do { value /= 1024; unit++; } while (value >= 1024 && unit < units.length - 1); return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`; }
function sleep(ms) { return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve(); }
function compatiblePacket(a, b) { return a.streamId === b.streamId && a.sourceCount === b.sourceCount && a.chunkSize === b.chunkSize && a.fileLength === b.fileLength && a.sha256 === b.sha256 && a.visualStates === b.visualStates; }
function estimatedFountainTarget(k) { if (k <= 4) return Math.max(k, Math.ceil(k * 2.5)); if (k < 32) return Math.ceil(k * 1.6); if (k < 128) return Math.ceil(k * 1.35); return Math.ceil(k * 1.20); }

// ---- TX profile -------------------------------------------------------------
// 4-adaptive uses exactly the same four-state/two-channel wire format as
// 4-stable. It differs only in sender timing and remains available for devices
// that benefit from longer optical dwell.
function selectedColorMode() { return $('colorMode').value; }
function isAdaptiveMode() { return selectedColorMode() === '4a'; }
function selectedVisualStates() { return selectedColorMode() === '8' ? 8 : 4; }
function channelsPerQr() { return selectedVisualStates() === 8 ? 3 : 2; }
function selectedChunkBytes() { return Math.max(512, Math.min(1280, Number($('payloadBytes').value) || 1024)); }
function selectedFps() { return Math.max(1, Number($('fps').value) || 8); }
function autoGridCap() {
  const fps = selectedFps(), channels = channelsPerQr();
  if (isAdaptiveMode()) return adaptiveGridCap(fps);
  if (fps >= 20) return channels === 3 ? 1 : 2;
  if (fps >= 12) return channels === 3 ? 2 : 4;
  return 6;
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

function txStageBudget() {
  const stage = $('txStage'); const style = getComputedStyle(stage); const px = value => Number.parseFloat(value) || 0;
  return { width: Math.max(1, stage.clientWidth - px(style.paddingLeft) - px(style.paddingRight)), height: Math.max(1, stage.clientHeight - px(style.paddingTop) - px(style.paddingBottom)) };
}
function supportedAtOrBelow(count, cap) { for (const candidate of [6,4,2,1]) if (candidate <= count && candidate <= cap) return candidate; return 1; }
function selectedGridCount() {
  const mode = $('gridMode').value;
  if (mode !== 'auto') return Math.max(1, Math.min(MAX_GRID_CODES, Number(mode) || 1));
  const { width, height } = txStageBudget();
  return supportedAtOrBelow(chooseGridCount(width, height, MIN_AUTO_QR_SIDE), autoGridCap());
}
function updateGridLabel() {
  const { width, height } = txStageBudget(); const side = Math.floor(Math.min(width / state.txCols, height / state.txRows));
  const cap = $('gridMode').value === 'auto' && autoGridCap() < 6 ? ` · cap AUTO ${autoGridCap()}` : '';
  const dwell = isAdaptiveMode() ? ` · dwell ≥${Math.round(adaptiveDwellMs(selectedFps()))}ms` : '';
  $('gridState').textContent = `${state.txSlots} QR · ${state.txCols}×${state.txRows} · ~${side}px${cap}${dwell}`;
}
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
  const { width: budgetW, height: budgetH } = txStageBudget(); const logicalW = state.txRasterSize * state.txCols, logicalH = state.txRasterSize * state.txRows;
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 3); const scale = Math.max(1, Math.floor(Math.min((budgetW * dpr) / logicalW, (budgetH * dpr) / logicalH)));
  const canvas = $('txCanvas'); canvas.width = logicalW * scale; canvas.height = logicalH * scale; state.txScale = scale;
  const nativeCssW = canvas.width / dpr, nativeCssH = canvas.height / dpr; const stretch = Math.max(0.1, Math.min(budgetW / nativeCssW, budgetH / nativeCssH)); state.txStretch = stretch;
  canvas.style.width = `${nativeCssW * stretch}px`; canvas.style.height = `${nativeCssH * stretch}px`; canvas.style.imageRendering = 'auto';
  const ctx = canvas.getContext('2d', { alpha: false }); ctx.imageSmoothingEnabled = false; ctx.drawImage(state.txStaging, 0, 0, canvas.width, canvas.height); updateGridLabel();
}
function paintTxCell(index, item) {
  if (!item) return;
  if (!state.txRasterSize) state.txRasterSize = item.raster.size;
  if (item.raster.size !== state.txRasterSize) throw new Error('La versione QR è cambiata durante lo stream');
  state.txCells[index] = item; if (!state.txStaging) ensureTxStaging();
  const logicalX = (index % state.txCols) * state.txRasterSize, logicalY = Math.floor(index / state.txCols) * state.txRasterSize;
  state.txStaging.getContext('2d', { alpha: false }).putImageData(new ImageData(item.raster.pixels, state.txRasterSize, state.txRasterSize), logicalX, logicalY);
  const canvas = $('txCanvas');
  if (!canvas.width || !canvas.height) resizeTxCanvas();
  else { const ctx = canvas.getContext('2d', { alpha: false }); ctx.imageSmoothingEnabled = false; const source = state.txRasterSize, dest = source * state.txScale; ctx.drawImage(state.txStaging, logicalX, logicalY, source, source, logicalX * state.txScale, logicalY * state.txScale, dest, dest); }
  state.txCellPaintedAt[index] = performance.now();
  state.txLastItem = item; updateTxMeta();
}
function updateModeBadge() {
  if (selectedColorMode() === '8') $('colorBadge').textContent = '8 STATI · 3 CANALI EXP';
  else if (isAdaptiveMode()) $('colorBadge').textContent = '4 STATI · ADAPTIVE';
  else $('colorBadge').textContent = '4 STATI · STABILE';
}
function updateTxMeta() {
  if (!state.encoder || !state.txLastItem) { updateModeBadge(); return; }
  const requestedFps = selectedFps(), channels = state.meta.visualStates === 8 ? 3 : 2;
  const opticalFps = isAdaptiveMode() ? adaptiveOpticalFpsCeiling(requestedFps) : requestedFps;
  const aggregate = opticalFps * state.txSlots * channels; const theoreticalKiB = aggregate * state.encoder.chunkSize / 1024;
  const elapsed = state.txStartedAt ? Math.max(0.001, (performance.now() - state.txStartedAt) / 1000) : 0; const actual = elapsed ? (state.txSymbolsShown / elapsed).toFixed(1) : '—';
  const fpsText = isAdaptiveMode() && opticalFps + 0.01 < requestedFps ? `${requestedFps} target / ≤${opticalFps.toFixed(1)} ottici` : `${requestedFps} fps/QR`;
  const genText = state.txGenerationMsEma > 0 ? ` · gen ${state.txGenerationMsEma.toFixed(0)}ms` : '';
  $('txFrame').textContent = `QR V${state.txLastItem.raster.version} ECC ${QR_ECC} · ${state.meta.visualStates} stati / ${channels} canali · payload ${state.encoder.chunkSize} B · ${state.txSlots} QR · ${fpsText} · ~${theoreticalKiB.toFixed(1)} KiB/s fountain ottici · ${actual} simboli/s generati${genText}`;
  updateModeBadge();
}
async function makeTxItem(generation) {
  if (!state.encoder || generation !== state.txGeneration) return null;
  const channels = state.meta.visualStates === 8 ? 3 : 2;
  const symbolIds = Array.from({ length: channels }, (_, i) => (state.symbolId + i) >>> 0); state.symbolId = (state.symbolId + channels) >>> 0;
  const symbols = symbolIds.map(id => state.encoder.symbol(id));
  const packets = symbols.map((symbol, i) => encodeOpticalPacket(state.meta, symbolIds[i], symbol.data));
  const raster = channels === 3 ? await createTripleQrRaster(packets[0], packets[1], packets[2]) : await createDualQrRaster(packets[0], packets[1]);
  if (generation !== state.txGeneration) return null;
  return { symbolIds, degrees: symbols.map(symbol => symbol.indices.length), raster };
}
async function rebuildTxGrid(reason = 'layout') {
  if (!state.encoder) return;
  const resume = state.transmitting; state.transmitting = false; const generation = ++state.txGeneration;
  const { width, height } = txStageBudget(); state.txSlots = selectedGridCount(); const dims = gridDims(state.txSlots, width, height); state.txCols = dims.cols; state.txRows = dims.rows;
  state.txCells = new Array(state.txSlots).fill(null); state.txCellPaintedAt = new Array(state.txSlots).fill(0); state.txStaging = null; state.txRasterSize = 0; state.txCellCursor = 0; state.txGenerationMsEma = 0;
  const channels = state.meta.visualStates === 8 ? 3 : 2;
  for (let index = 0; index < state.txSlots; index++) {
    const item = await makeTxItem(generation); if (!item || generation !== state.txGeneration) return;
    if (!state.txRasterSize) { state.txRasterSize = item.raster.size; ensureTxStaging(); resizeTxCanvas(); }
    paintTxCell(index, item); state.txSymbolsShown += channels;
  }
  resizeTxCanvas(); const mode = $('gridMode').value === 'auto' ? 'AUTO' : 'manuale'; const scheduler = isAdaptiveMode() ? 'ADAPTIVE dwell' : 'standard';
  log(`TX ${reason}: ${state.txSlots} QR (${state.txCols}x${state.txRows}) · ${mode} · ${state.meta.visualStates} stati · ${channels} simboli/QR · ${state.encoder.chunkSize} B · ${scheduler}`);
  if (resume && generation === state.txGeneration) { state.transmitting = true; state.txStartedAt = performance.now(); state.txSymbolsShown = 0; void txLoop(generation); }
}
async function configureSelectedFile(reason = 'configurazione') {
  if (!state.selectedFile) return;
  stopTransmit();
  const { name, bytes, hash } = state.selectedFile; const streamId = randomStreamId(); const chunkSize = selectedChunkBytes(); const visualStates = selectedVisualStates();
  const encoder = new FountainEncoder(bytes, chunkSize, streamId);
  const meta = { streamId, sourceCount: encoder.sourceCount, chunkSize: encoder.chunkSize, fileLength: bytes.length, fileName: name, sha256: hash, visualStates };
  const probe = encodeOpticalPacket(meta, 0, encoder.symbol(0).data); if (probe.length > CAPACITY_BYTES) throw new Error(`QCT1 ${probe.length} B supera il limite QR ${CAPACITY_BYTES} B`);
  state.encoder = encoder; state.meta = meta; state.symbolId = 0; state.txSymbolsShown = 0; state.txStartedAt = 0; state.txGenerationMsEma = 0;
  const modeLabel = isAdaptiveMode() ? '4 stati ADAPTIVE' : visualStates === 8 ? '8 stati EXP' : '4 stati STABILE';
  $('txFileInfo').textContent = `${name} · ${formatBytes(bytes.length)} · K=${encoder.sourceCount} × ${encoder.chunkSize} B · ${modeLabel} · ${visualStates === 8 ? 3 : 2} canali · SHA-256 ${hash ? 'OK' : 'N/D'}`;
  const adaptiveText = isAdaptiveMode() ? ` ADAPTIVE garantisce dwell ≥${Math.round(adaptiveDwellMs(selectedFps()))} ms/cella senza feedback dal ricevitore.` : ' AUTO limita la griglia solo ai profili più pesanti; la griglia manuale resta libera.';
  status('txStatus', `Pronto · payload ${chunkSize} B · ${modeLabel}.${adaptiveText}`, 'ok');
  log(`TX ${reason}: ${name}, ${bytes.length} byte, stream ${streamId}, K=${encoder.sourceCount}, payload=${chunkSize}, states=${visualStates}, adaptive=${isAdaptiveMode()}`);
  await rebuildTxGrid(reason);
}
async function prepareFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer()); const hash = await sha256Hex(bytes); state.selectedFile = { name: file.name, bytes, hash };
  await configureSelectedFile('file selezionato');
}
async function txLoop(generation) {
  while (state.transmitting && generation === state.txGeneration) {
    const fpsPerCode = selectedFps(); const cellIndex = state.txCellCursor; const started = performance.now();
    try {
      const item = await makeTxItem(generation); if (!item) break;
      const generationMs = performance.now() - started;
      state.txGenerationMsEma = state.txGenerationMsEma ? state.txGenerationMsEma * 0.85 + generationMs * 0.15 : generationMs;
      if (isAdaptiveMode()) {
        const nextPaintAt = adaptiveNextPaintAt(state.txCellPaintedAt[cellIndex], fpsPerCode);
        await sleep(Math.max(0, nextPaintAt - performance.now()));
        if (!state.transmitting || generation !== state.txGeneration) break;
      }
      paintTxCell(cellIndex, item); state.txCellCursor = (cellIndex + 1) % state.txSlots; state.txSymbolsShown += state.meta.visualStates === 8 ? 3 : 2;
    } catch (error) { state.transmitting = false; status('txStatus', `Errore QR colore: ${error.message}`, 'error'); log(`TX QR error: ${error.stack || error.message}`); break; }
    if (!state.transmitting || generation !== state.txGeneration) break;
    if (!isAdaptiveMode()) {
      const interval = 1000 / (fpsPerCode * state.txSlots); const spent = performance.now() - started;
      await sleep(Math.max(0, interval - spent));
    }
  }
}
function startTransmit() {
  if (!state.encoder || state.transmitting) return;
  state.transmitting = true; state.txStartedAt = performance.now(); state.txSymbolsShown = 0; const generation = ++state.txGeneration; requestWakeLock();
  const channels = state.meta.visualStates === 8 ? 3 : 2; const requested = selectedFps(); const optical = isAdaptiveMode() ? adaptiveOpticalFpsCeiling(requested) : requested; const aggregate = optical * state.txSlots * channels;
  const schedulerText = isAdaptiveMode() ? `ADAPTIVE · ${requested} fps target · dwell ≥${Math.round(adaptiveDwellMs(requested))} ms` : `${requested} fps/QR`;
  status('txStatus', `Trasmissione attiva: ${state.meta.visualStates} stati · ${schedulerText} · ${state.txSlots} QR · payload ${state.encoder.chunkSize} B · fino a ~${aggregate.toFixed(1)} simboli fountain/s ottici.`, 'ok');
  log(`TX start · ${state.txSlots} QR · ${schedulerText} · ${channels} canali · ${state.encoder.chunkSize} B`); void txLoop(generation);
}
function stopTransmit() { state.transmitting = false; state.txGeneration++; if (state.encoder) status('txStatus', 'Trasmissione in pausa. I QR visibili restano decodificabili.'); releaseWakeLockIfIdle(); }
async function toggleFullscreenTx() { const stage = $('txStage'); try { if (document.fullscreenElement) await document.exitFullscreen(); else if (stage.requestFullscreen) await stage.requestFullscreen(); else status('txStatus', 'Schermo intero non supportato; ruota il dispositivo per sfruttare la larghezza.', 'warn'); } catch (error) { status('txStatus', `Schermo intero non disponibile: ${error.message}`, 'warn'); } }
let resizeTimer = null;
function scheduleTxDisplayRefresh() { clearTimeout(resizeTimer); resizeTimer = setTimeout(async () => { if (!state.encoder) return; if ($('gridMode').value === 'auto' && selectedGridCount() !== state.txSlots) await rebuildTxGrid('ridimensionamento'); else resizeTxCanvas(); }, 180); }
async function settingsChanged(kind) {
  updateModeBadge();
  if (!state.selectedFile) return;
  if (kind === 'payload' || kind === 'color') await configureSelectedFile(kind === 'payload' ? 'payload modificato' : 'profilo colore modificato');
  else if (selectedGridCount() !== state.txSlots) await rebuildTxGrid(`${kind} modificato`);
  else updateTxMeta();
}

// ---- RX ROI + worker pool ---------------------------------------------------
// Full-frame scans are now acquisition/recovery operations. Once ZXing returns
// QR positions, most frames are decoded as small crops. A crop task keeps color
// decoding enabled; a full scan skips chroma to free the worker sooner.
function desiredRxWorkerCount() { return workerCountForHardware(navigator.hardwareConcurrency); }
function terminateWorkers() {
  for (const worker of state.workers) worker?.terminate();
  state.workers = []; state.workerBusy = []; state.workerTasks = []; state.workerCursor = 0; state.rxWorkerCount = 0;
}
function nextFreeWorker() {
  for (let offset = 0; offset < state.workers.length; offset++) {
    const index = (state.workerCursor + offset) % state.workers.length;
    if (!state.workerBusy[index]) { state.workerCursor = (index + 1) % state.workers.length; return index; }
  }
  return -1;
}
function busyWorkerCount() { return state.workerBusy.reduce((sum, busy) => sum + (busy ? 1 : 0), 0); }
function renderRxStats() {
  const decoder = state.rxDecoder; const distinct = decoder?.framesNew || 0, dup = decoder?.framesDup || 0, solved = decoder?.solvedCount || 0, total = decoder?.sourceCount || 0, target = total ? estimatedFountainTarget(total) : 0;
  const c1Pct = state.rxColor1Candidates ? Math.round(state.rxColor1Decoded * 100 / state.rxColor1Candidates) : 0; const c2Pct = state.rxColor2Candidates ? Math.round(state.rxColor2Decoded * 100 / state.rxColor2Candidates) : 0;
  const elapsed = decoder ? Math.max(0.001, (performance.now() - state.rxStartedAt) / 1000) : 0; const fountainKiB = decoder && elapsed ? (distinct * decoder.chunkSize / 1024 / elapsed) : 0;
  const sep1 = state.rxColor1Separation ? ` sep1 ${state.rxColor1Separation.toFixed(2)}` : ''; const sep2 = state.rxColor2Separation ? ` sep2 ${state.rxColor2Separation.toFixed(2)}` : '';
  const regions = state.roiTracker.active(performance.now()).length; const peak = state.roiTracker.peakRegions;
  const cropPct = state.rxCropTasks ? Math.round(state.rxCropHits * 100 / state.rxCropTasks) : 0;
  $('rxStats').textContent = `${distinct} distinti · ${dup} duplicati · base ${state.rxBaseDecoded} · C1 ${state.rxColor1Decoded}/${state.rxColor1Candidates} (${c1Pct}%)${sep1} · C2 ${state.rxColor2Decoded}/${state.rxColor2Candidates} (${c2Pct}%)${sep2} · ${fountainKiB.toFixed(1)} KiB/s · ROI ${regions}/${peak} · crop ${state.rxCropHits}/${state.rxCropTasks} (${cropPct}%) · full ${state.rxFullScans} · worker ${busyWorkerCount()}/${state.rxWorkerCount} · ${state.rxDroppedBusy} frame saturi · peeling ${solved}/${total || '—'} · target ~${target || '—'}`;
}
function releaseWorkerTask(index) {
  const task = state.workerTasks[index];
  if (task?.regionId != null) state.roiTracker.markDone(task.regionId);
  state.workerTasks[index] = null;
  state.workerBusy[index] = false;
}
function ensureWorkers() {
  if (state.workers.length) return;
  const workerCount = desiredRxWorkerCount(); state.rxWorkerCount = workerCount;
  for (let i = 0; i < workerCount; i++) {
    const worker = new Worker(new URL('./qr-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = event => {
      const {
        id, ready, mode = 'full', regionId = null, detections = [], symbols = [], baseCount = 0, eightBase = 0,
        color1Candidates = 0, color1Count = 0, color1Separation = 0,
        color2Candidates = 0, color2Count = 0, color2Separation = 0, error
      } = event.data || {};
      if (id === -1) {
        if (ready) log(`ZXing worker ${i + 1}/${workerCount} pronto · ROI/crop + colore`);
        else { state.rxWorkerErrors++; status('rxStatus', `Decoder ZXing/colore non si inizializza: ${error}`, 'error'); log(`Worker init error: ${error}`); }
        return;
      }
      releaseWorkerTask(i);
      if (detections.length) state.roiTracker.observe(detections, performance.now());
      if (mode === 'crop' && baseCount > 0) state.rxCropHits++;
      if (error) { state.rxWorkerErrors++; if (state.rxWorkerErrors <= 3) log(`ZXing worker error: ${error}`); }
      state.rxBaseDecoded += baseCount; state.rxEightBase += eightBase;
      state.rxColor1Candidates += color1Candidates; state.rxColor1Decoded += color1Count; if (color1Separation > 0) state.rxColor1Separation = color1Separation;
      state.rxColor2Candidates += color2Candidates; state.rxColor2Decoded += color2Count; if (color2Separation > 0) state.rxColor2Separation = color2Separation;
      if (symbols.length && !state.rxComplete) void onDecodedSymbols(symbols);
      renderRxStats();
    };
    worker.onerror = event => {
      releaseWorkerTask(i); state.rxWorkerErrors++;
      status('rxStatus', `Worker QR: ${event.message}`, 'error'); log(`Worker QR fatal: ${event.message}`);
    };
    state.workers.push(worker); state.workerBusy.push(false); state.workerTasks.push(null);
  }
}
function submitWorkerImage(workerIndex, image, task) {
  const id = state.frameId++;
  state.workerBusy[workerIndex] = true; state.workerTasks[workerIndex] = task;
  state.workers[workerIndex].postMessage({
    id, buf: image.data.buffer, w: image.width, h: image.height,
    mode: task.mode, regionId: task.regionId ?? null,
    originX: task.originX || 0, originY: task.originY || 0,
    decodeColor: task.mode === 'crop'
  }, [image.data.buffer]);
}

async function tuneCameraTrack(track) {
  try {
    const caps = track?.getCapabilities?.();
    if (caps?.focusMode?.includes?.('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
  } catch (error) { log(`Focus continuo non applicato: ${error.message}`); }
}
async function getCameraStream() {
  const base = { facingMode: { ideal: 'environment' }, width: { ideal: RX_CAPTURE_WIDTH }, height: { ideal: Math.round(RX_CAPTURE_WIDTH * 9 / 16) } };
  try { return await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, frameRate: { exact: RX_CAPTURE_FPS_TARGET } } }); }
  catch (firstError) {
    log(`Camera ${RX_CAPTURE_FPS_TARGET} fps exact non disponibile: ${firstError.message}`);
    try { return await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, frameRate: { exact: RX_CAPTURE_FPS_FALLBACK } } }); }
    catch { return navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, frameRate: { ideal: RX_CAPTURE_FPS_TARGET } } }); }
  }
}
async function startCamera() {
  if (state.receiving) return;
  if (!navigator.mediaDevices?.getUserMedia) { status('rxStatus', 'La fotocamera richiede HTTPS e un browser compatibile.', 'error'); return; }
  ensureWorkers(); state.roiTracker.reset(); state.rxFullScans = 0; state.rxCropTasks = 0; state.rxCropHits = 0;
  try {
    state.stream = await getCameraStream();
    const video = $('rxVideo'); video.srcObject = state.stream; await video.play();
    state.track = state.stream.getVideoTracks()[0] || null; await tuneCameraTrack(state.track);
    state.receiving = true; state.captureGeneration++; state.rxStartedAt = performance.now(); requestWakeLock();
    const settings = state.track?.getSettings?.() || {};
    status('rxStatus', `Camera ${settings.width || video.videoWidth}×${settings.height || video.videoHeight}@${Math.round(settings.frameRate || 0)} · ${state.rxWorkerCount} worker · acquisizione full-frame + tracking ROI.`, 'ok');
    log(`RX camera: ${state.track?.label || 'video'} · ${video.videoWidth}x${video.videoHeight} · ${Math.round(settings.frameRate || 0)} fps · ${state.rxWorkerCount} worker`);
    scheduleCapture(state.captureGeneration);
  } catch (error) { status('rxStatus', `Fotocamera non disponibile: ${error.message}`, 'error'); log(`RX camera error: ${error.name} ${error.message}`); }
}
function stopCamera() {
  state.receiving = false; state.captureGeneration++;
  state.stream?.getTracks().forEach(track => track.stop()); state.stream = null; state.track = null; $('rxVideo').srcObject = null;
  if (!state.rxDecoder?.complete && !state.rxFinalizing && !state.rxComplete) status('rxStatus', 'Fotocamera ferma.');
  releaseWakeLockIfIdle();
}
function resetReceiver() {
  state.rxDecoder = null; state.rxMeta = null; state.rxCaptured = 0; state.rxDroppedBusy = 0; state.rxFullScans = 0; state.rxCropTasks = 0; state.rxCropHits = 0;
  state.rxBaseDecoded = 0; state.rxEightBase = 0; state.roiTracker.reset();
  state.rxColor1Candidates = 0; state.rxColor1Decoded = 0; state.rxColor1Separation = 0; state.rxColor2Candidates = 0; state.rxColor2Decoded = 0; state.rxColor2Separation = 0;
  state.rxPacketRejected = 0; state.rxWorkerErrors = 0; state.expectedHash = null; state.rxStartedAt = performance.now(); state.rxFinalizing = false; state.rxComplete = false; $('rxProgress').value = 0;
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl); state.downloadUrl = null; const download = $('download'); download.hidden = true; download.removeAttribute('href');
  renderRxStats(); status('rxStatus', state.receiving ? 'Ricevitore azzerato. Riacquisizione ROI in corso.' : 'Ricevitore azzerato.'); log('RX reset');
}

async function acceptPacket(packet) {
  if (state.rxFinalizing || state.rxComplete) return;
  if (!state.rxDecoder || state.rxMeta?.streamId !== packet.streamId) {
    state.rxMeta = packet; state.rxDecoder = new FountainDecoder(packet.sourceCount, packet.chunkSize, packet.fileLength, packet.streamId); state.expectedHash = packet.sha256; state.rxStartedAt = performance.now();
    log(`RX nuovo stream ${packet.streamId}: ${packet.fileName}, ${packet.fileLength} byte, K=${packet.sourceCount}, payload=${packet.chunkSize}, states=${packet.visualStates}`);
  } else if (!compatiblePacket(state.rxMeta, packet)) throw new Error('Metadati stream incoerenti');
  const added = state.rxDecoder.addSymbol(packet.symbolId, packet.payload); if (!added) return;
  const target = estimatedFountainTarget(state.rxDecoder.sourceCount); const estimatedFraction = state.rxDecoder.complete ? 1 : Math.min(0.99, state.rxDecoder.framesNew / target); const pct = Math.floor(estimatedFraction * 1000) / 10; $('rxProgress').value = pct;
  const elapsed = Math.max(0.001, (performance.now() - state.rxStartedAt) / 1000); const validRate = state.rxDecoder.framesNew / elapsed; const fountainKiB = validRate * state.rxDecoder.chunkSize / 1024;
  renderRxStats(); status('rxStatus', `Ricezione ~${pct}% · ${state.rxDecoder.framesNew}/${target} distinti · ${validRate.toFixed(1)} simboli/s · ${fountainKiB.toFixed(1)} KiB/s · ROI ${state.roiTracker.regions.length}`, 'ok');
  if (!state.rxDecoder.complete) return;

  state.rxFinalizing = true; $('rxProgress').value = 100; stopCamera();
  const completeElapsed = Math.max(0.001, (performance.now() - state.rxStartedAt) / 1000); const bytes = state.rxDecoder.reconstruct(); const hash = await sha256Hex(bytes);
  if (hash && state.expectedHash && hash !== state.expectedHash) {
    state.rxComplete = true; state.rxFinalizing = false; status('rxStatus', 'File ricostruito ma SHA-256 non coincide. Download bloccato.', 'error'); log(`SHA-256 FAIL: atteso ${state.expectedHash}, ricevuto ${hash}`); return;
  }
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl); state.downloadUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })); const link = $('download'); link.href = state.downloadUrl; link.download = state.rxMeta.fileName || 'qcolortrasfer.bin'; link.hidden = false; link.textContent = `SCARICA ${link.download} (${formatBytes(bytes.length)})`;
  const effectiveKiB = bytes.length / 1024 / completeElapsed; state.rxComplete = true; state.rxFinalizing = false;
  status('rxStatus', `COMPLETATO · ${formatBytes(bytes.length)} · ${completeElapsed.toFixed(2)} s · ${effectiveKiB.toFixed(1)} KiB/s file · SHA-256 ${hash && state.expectedHash ? 'OK' : 'N/D'} · ${state.rxDecoder.framesNew} simboli distinti`, 'ok');
  log(`RX completo: ${link.download}, ${bytes.length} byte, ${completeElapsed.toFixed(3)} s, ${effectiveKiB.toFixed(2)} KiB/s, ${state.rxDecoder.framesNew} simboli distinti, states=${state.rxMeta.visualStates}, ROIpeak=${state.roiTracker.peakRegions}`);
}
async function onDecodedSymbols(symbols) {
  for (const raw of symbols) {
    if (state.rxFinalizing || state.rxComplete) break;
    try { const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw); const packet = decodeOpticalPacket(bytes); await acceptPacket(packet); }
    catch (error) { state.rxPacketRejected++; if (state.rxPacketRejected <= 3 || state.rxPacketRejected % 20 === 0) log(`QR letto ma pacchetto rifiutato: ${error.message}`); }
  }
  renderRxStats();
}

function captureFrame() {
  const video = $('rxVideo'), width = video.videoWidth, height = video.videoHeight;
  if (!width || !height || state.rxFinalizing || state.rxComplete) return;
  state.rxCaptured++;
  if (!state.captureCanvas) state.captureCanvas = document.createElement('canvas');
  const canvas = state.captureCanvas;
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; state.roiTracker.reset(); }
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true }); ctx.drawImage(video, 0, 0, width, height);
  const now = performance.now(); state.roiTracker.prune(now);
  let submitted = 0;

  if (state.roiTracker.shouldFullScan(now)) {
    const workerIndex = nextFreeWorker();
    if (workerIndex >= 0) {
      const image = ctx.getImageData(0, 0, width, height); state.roiTracker.noteFullScan(now); state.rxFullScans++;
      submitWorkerImage(workerIndex, image, { mode: 'full', regionId: null, originX: 0, originY: 0 }); submitted++;
    }
  }

  const freeSlots = Math.max(0, state.rxWorkerCount - busyWorkerCount());
  const regions = state.roiTracker.chooseForCrops(freeSlots, now);
  for (const region of regions) {
    const workerIndex = nextFreeWorker(); if (workerIndex < 0) break;
    const crop = state.roiTracker.cropFor(region, width, height);
    const image = ctx.getImageData(crop.x, crop.y, crop.w, crop.h);
    if (!state.roiTracker.markSubmitted(region.id, now)) continue;
    state.rxCropTasks++;
    submitWorkerImage(workerIndex, image, { mode: 'crop', regionId: region.id, originX: crop.x, originY: crop.y }); submitted++;
  }

  if (submitted === 0 && busyWorkerCount() >= state.rxWorkerCount) state.rxDroppedBusy++;
  if (state.rxCaptured % 15 === 0) renderRxStats();
}
function scheduleCapture(generation) {
  if (!state.receiving || generation !== state.captureGeneration) return;
  const video = $('rxVideo');
  const next = () => { if (!state.receiving || generation !== state.captureGeneration) return; captureFrame(); scheduleCapture(generation); };
  if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(next); else requestAnimationFrame(next);
}

async function runSelfTest() {
  try {
    const bytes = Uint8Array.from({ length: 2048 }, (_, i) => (i * 37 + 11) & 255); const streamId = 0x12345678; const enc = new FountainEncoder(bytes, 1024, streamId);
    const meta4 = { streamId, sourceCount: enc.sourceCount, chunkSize: enc.chunkSize, fileLength: bytes.length, fileName: 'selftest.bin', sha256: 'ab'.repeat(32), visualStates: 4 };
    const p0 = encodeOpticalPacket(meta4, 0, enc.symbol(0).data), p1 = encodeOpticalPacket(meta4, 1, enc.symbol(1).data); if (p0.length !== HEADER_BYTES + 1024 + 4) throw new Error('dimensione QCT1 1024 inattesa');
    const dual = await createDualQrRaster(p0, p1); if (dual.visualStates !== 4 || dual.channels !== 2) throw new Error('dual color non attivo');
    const meta8 = { ...meta4, visualStates: 8 }; const q0 = encodeOpticalPacket(meta8, 2, enc.symbol(2).data), q1 = encodeOpticalPacket(meta8, 3, enc.symbol(3).data), q2 = encodeOpticalPacket(meta8, 4, enc.symbol(4).data);
    if (decodeOpticalPacket(q0).visualStates !== 8) throw new Error('flag 8-state non presente'); const triple = await createTripleQrRaster(q0, q1, q2); if (triple.visualStates !== 8 || triple.channels !== 3 || triple.coloredModules <= 0) throw new Error('triple color non attivo');
    const dwell20 = adaptiveDwellMs(20); if (dwell20 < 70 || adaptiveGridCap(20) !== 4) throw new Error('scheduler ADAPTIVE non coerente');
    const roi = new RoiTracker(); roi.observe([{ x: 20, y: 20, w: 100, h: 100 }], 0); if (roi.regions.length !== 1 || workerCountForHardware(8) !== 4) throw new Error('ROI/worker pool non coerente');
    status('selfTest', `Autotest: OK · payload 1024 B · 4 stati STABILE/ADAPTIVE + 8 stati EXP · QR V${triple.version} · RX ROI + pool 2–4 worker.`, 'ok');
    log(`Autotest 4/8-state + ROI OK · QR V${triple.version}, ${triple.modules} moduli`);
  } catch (error) { status('selfTest', `Autotest: ERRORE · ${error.message}`, 'error'); log(`Autotest FAIL: ${error.stack || error.message}`); }
}

function updateNetworkState() { $('netState').textContent = navigator.onLine ? 'rete: online' : 'rete: offline'; }
async function setupPwa() {
  updateNetworkState(); window.addEventListener('online', updateNetworkState); window.addEventListener('offline', updateNetworkState);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; if (standalone) $('pwaState').textContent = 'app: installata';
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    try { const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' }); $('pwaState').textContent = standalone ? 'app: installata' : 'app: offline pronta'; registration.update().catch(() => {}); log(`Service worker registrato: ${registration.scope}`); }
    catch (error) { $('pwaState').textContent = 'app: SW errore'; log(`Service worker error: ${error.message}`); }
  }
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); state.installPrompt = event; $('installPwa').hidden = false; });
  window.addEventListener('appinstalled', () => { $('installPwa').hidden = true; $('pwaState').textContent = 'app: installata'; state.installPrompt = null; });
  $('installPwa').addEventListener('click', async () => { if (!state.installPrompt) return; await state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; $('installPwa').hidden = true; });
}

$('fileInput').addEventListener('change', event => { const file = event.target.files?.[0]; if (file) prepareFile(file).catch(error => { status('txStatus', error.message, 'error'); log(`TX prepare error: ${error.stack || error.message}`); }); });
$('startTx').addEventListener('click', startTransmit); $('stopTx').addEventListener('click', stopTransmit); $('fullTx').addEventListener('click', toggleFullscreenTx);
$('gridMode').addEventListener('change', () => { void settingsChanged('griglia'); }); $('fps').addEventListener('change', () => { void settingsChanged('fps'); }); $('payloadBytes').addEventListener('change', () => { void settingsChanged('payload'); }); $('colorMode').addEventListener('change', () => { void settingsChanged('color'); });
$('startRx').addEventListener('click', startCamera); $('stopRx').addEventListener('click', stopCamera); $('resetRx').addEventListener('click', resetReceiver);
window.addEventListener('resize', scheduleTxDisplayRefresh); window.addEventListener('orientationchange', scheduleTxDisplayRefresh); document.addEventListener('fullscreenchange', scheduleTxDisplayRefresh); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (state.transmitting || state.receiving)) requestWakeLock(); });
window.addEventListener('beforeunload', () => { stopTransmit(); stopCamera(); terminateWorkers(); if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl); });

$('capacity').textContent = `1024 B default · 4 STABILE default · RX ROI · 2–4 worker · camera fino a 60 fps`;
updateModeBadge(); resetReceiver(); setupPwa(); void runSelfTest();
