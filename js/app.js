import { FountainEncoder, FountainDecoder } from './fountain.js';
import { encodeOpticalPacket, decodeOpticalPacket, randomStreamId, sha256Hex } from './protocol.js';
import { renderFrame, decodeFrameFromCanvas, CAPACITY_BYTES, ANALYSIS_SIZE } from './optical.js';

const $ = id => document.getElementById(id);
const state = {
  encoder: null, meta: null, symbolId: 0, timer: null, txFrames: 0, txStartedAt: 0,
  receiving: false, stream: null, track: null,
  rxDecoder: null, rxMeta: null, rxFrames: 0, rxBad: 0, rxLastSymbol: -1, rxStartedAt: 0,
  rxGeometry: null, rxErrors: { FINDER: 0, COLOR: 0, CRC: 0, PROTOCOL: 0 }, rxLastError: '—',
  expectedHash: null, downloadUrl: null, wakeLock: null, installPrompt: null
};

function log(message) {
  const line = `${new Date().toLocaleTimeString()}  ${message}`;
  const el = $('log');
  el.textContent = `${line}\n${el.textContent}`.slice(0, 16000);
}
function status(id, text, kind = '') { const el = $(id); el.textContent = text; el.dataset.kind = kind; }
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
function resetRxErrors() {
  state.rxErrors = { FINDER: 0, COLOR: 0, CRC: 0, PROTOCOL: 0 };
  state.rxLastError = '—';
}
function classifyRxError(error) {
  if (error?.code === 'FINDER') return 'FINDER';
  if (error?.code === 'COLOR') return 'COLOR';
  if (/CRC mismatch/i.test(error?.message || '')) return 'CRC';
  return 'PROTOCOL';
}
function recordRxError(error) {
  const kind = classifyRxError(error);
  state.rxErrors[kind]++;
  state.rxLastError = `${kind}: ${error?.message || 'errore sconosciuto'}`;
  state.rxBad++;
  if (state.rxBad <= 3 || state.rxBad % 12 === 0) log(`RX scarto ${state.rxBad} · ${state.rxLastError}`);
}
function renderRxStats(extra = '') {
  const solved = state.rxDecoder?.solvedCount || 0;
  const total = state.rxDecoder?.sourceCount || 0;
  const e = state.rxErrors;
  $('rxStats').textContent = `${state.rxFrames} simboli validi · ${state.rxBad} scarti · ${solved}/${total || '—'} blocchi · finder ${e.FINDER} · colore ${e.COLOR} · CRC ${e.CRC} · protocollo ${e.PROTOCOL}${extra ? ` · ${extra}` : ''}`;
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch (error) { log(`Wake lock non disponibile: ${error.message}`); }
}
async function releaseWakeLockIfIdle() {
  if (state.timer || state.receiving || !state.wakeLock) return;
  try { await state.wakeLock.release(); } catch {}
  state.wakeLock = null;
}

async function prepareFile(file) {
  stopTransmit();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await sha256Hex(bytes);
  const encoder = new FountainEncoder(bytes, 320);
  const packetSize = 96 + encoder.chunkSize + 4;
  if (packetSize > CAPACITY_BYTES) throw new Error('La configurazione del protocollo supera la capacità del frame ottico.');
  state.encoder = encoder; state.symbolId = 0; state.txFrames = 0;
  state.meta = { streamId: randomStreamId(), sourceCount: encoder.sourceCount, chunkSize: encoder.chunkSize, fileLength: bytes.length, fileName: file.name, sha256: hash };
  $('txFileInfo').textContent = `${file.name} · ${formatBytes(bytes.length)} · ${encoder.sourceCount} blocchi sorgente · SHA-256 ${hash ? 'OK' : 'non disponibile'}`;
  const memoryWarning = bytes.length > 50 * 1024 * 1024 ? ' File grande: la PWA lo mantiene in memoria durante il trasferimento.' : '';
  status('txStatus', `Pronto. ${encoder.sourceCount} blocchi da ${encoder.chunkSize} B.${memoryWarning}`, 'ok');
  log(`TX preparato: ${file.name}, ${bytes.length} byte, stream ${state.meta.streamId}`);
  drawSymbol();
}
function drawSymbol() {
  if (!state.encoder) return;
  const symbol = state.encoder.symbol(state.symbolId);
  const packet = encodeOpticalPacket(state.meta, state.symbolId, symbol.data);
  renderFrame($('txCanvas'), packet);
  state.txFrames++;
  const kind = state.symbolId < state.encoder.sourceCount ? 'sorgente' : `repair d${symbol.indices.length}`;
  const elapsed = state.txStartedAt ? Math.max(0.001, (performance.now() - state.txStartedAt) / 1000) : 0;
  const realFps = elapsed ? ((state.txFrames - 1) / elapsed).toFixed(1) : '—';
  $('txFrame').textContent = `stream ${state.meta.streamId} · simbolo ${state.symbolId} · ${kind} · tx ${state.txFrames} · ${realFps} fps effettivi`;
  state.symbolId = (state.symbolId + 1) >>> 0;
}
function scheduleNextTx() {
  if (!state.timer) return;
  const fps = Number($('fps').value); const interval = 1000 / fps; const started = performance.now();
  drawSymbol(); const spent = performance.now() - started;
  state.timer = setTimeout(scheduleNextTx, Math.max(0, interval - spent));
}
function startTransmit() {
  if (!state.encoder || state.timer) return;
  state.txStartedAt = performance.now(); state.txFrames = 0;
  state.timer = setTimeout(scheduleNextTx, 0); requestWakeLock();
  status('txStatus', `Trasmissione attiva a ${$('fps').value} fps. Il flusso è rateless: può continuare senza limite.`, 'ok');
  log(`TX start @ ${$('fps').value} fps`);
}
function stopTransmit() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (state.encoder) status('txStatus', 'Trasmissione in pausa.');
  releaseWakeLockIfIdle();
}
function restartTransmit() {
  if (!state.encoder) return;
  stopTransmit(); state.symbolId = 0; state.txFrames = 0; drawSymbol();
  status('txStatus', 'Sequenza riportata ai simboli sistematici iniziali.', 'ok');
  log('TX restart da simbolo 0');
}
async function toggleFullscreenTx() {
  const stage = $('txStage');
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (stage.requestFullscreen) await stage.requestFullscreen();
  } catch (error) { status('txStatus', `Schermo intero non disponibile: ${error.message}`, 'warn'); }
}

async function startCamera() {
  if (state.receiving) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    status('rxStatus', 'La fotocamera richiede HTTPS e un browser compatibile.', 'error'); return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false
    });
    const video = $('rxVideo'); video.srcObject = state.stream; await video.play();
    state.track = state.stream.getVideoTracks()[0] || null;
    state.receiving = true; state.rxStartedAt = performance.now(); state.rxGeometry = null;
    requestWakeLock();
    status('rxStatus', 'Fotocamera attiva. Tieni l’intero quadrato dentro la guida: i finder vengono agganciati automaticamente.', 'ok');
    log(`RX camera: ${state.track?.label || 'video track'} · ${video.videoWidth}x${video.videoHeight}`);
    requestAnimationFrame(scanLoop);
  } catch (error) {
    status('rxStatus', `Fotocamera non disponibile: ${error.message}`, 'error');
    log(`RX camera error: ${error.name} ${error.message}`);
  }
}
function stopCamera() {
  state.receiving = false; state.rxGeometry = null;
  state.stream?.getTracks().forEach(track => track.stop()); state.stream = null; state.track = null;
  $('rxVideo').srcObject = null;
  if (!state.rxDecoder?.complete) status('rxStatus', 'Fotocamera ferma.');
  releaseWakeLockIfIdle();
}
function resetReceiver() {
  state.rxDecoder = null; state.rxMeta = null; state.rxFrames = 0; state.rxBad = 0; state.rxLastSymbol = -1;
  state.rxGeometry = null; resetRxErrors(); state.expectedHash = null; state.rxStartedAt = performance.now();
  $('rxProgress').value = 0; renderRxStats();
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
  state.downloadUrl = null; const download = $('download'); download.hidden = true; download.removeAttribute('href');
  status('rxStatus', state.receiving ? 'Ricevitore azzerato. Riaggancio finder in corso.' : 'Ricevitore azzerato.');
  log('RX reset');
}
async function acceptPacket(packet) {
  if (!state.rxDecoder || state.rxMeta?.streamId !== packet.streamId) {
    state.rxMeta = packet;
    state.rxDecoder = new FountainDecoder(packet.sourceCount, packet.chunkSize, packet.fileLength);
    state.rxFrames = 0; state.rxBad = 0; state.rxLastSymbol = -1; resetRxErrors();
    state.expectedHash = packet.sha256; state.rxStartedAt = performance.now();
    log(`RX nuovo stream ${packet.streamId}: ${packet.fileName}, ${packet.fileLength} byte`);
  } else if (!compatiblePacket(state.rxMeta, packet)) throw new Error('Metadati stream incoerenti');

  if (packet.symbolId === state.rxLastSymbol) return;
  state.rxLastSymbol = packet.symbolId;
  const added = state.rxDecoder.addSymbol(packet.symbolId, packet.payload);
  if (!added) return;
  state.rxFrames++;
  const pct = Math.floor(state.rxDecoder.progress * 1000) / 10;
  $('rxProgress').value = pct;
  const elapsed = Math.max(0.001, (performance.now() - state.rxStartedAt) / 1000);
  const validRate = (state.rxFrames / elapsed).toFixed(1);
  renderRxStats(`${validRate} validi/s`);
  status('rxStatus', `Ricezione ${pct}% · ultimo simbolo ${packet.symbolId} · finder lock`, 'ok');

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

function drawGuide() {
  const size = Number($('guideSize').value); const inset = (100 - size) / 2;
  $('guide').style.inset = `${inset}%`; $('guideValue').value = `${size}%`;
  state.rxGeometry = null;
}
function copyCameraCropToAnalysis() {
  const video = $('rxVideo'); if (!video.videoWidth || !video.videoHeight) return false;
  const rawSquare = Math.min(video.videoWidth, video.videoHeight);
  const baseX = (video.videoWidth - rawSquare) / 2; const baseY = (video.videoHeight - rawSquare) / 2;
  const ratio = Number($('guideSize').value) / 100; const cropSize = rawSquare * ratio;
  const sourceX = baseX + (rawSquare - cropSize) / 2; const sourceY = baseY + (rawSquare - cropSize) / 2;
  const canvas = $('rxCanvas');
  if (canvas.width !== ANALYSIS_SIZE || canvas.height !== ANALYSIS_SIZE) { canvas.width = ANALYSIS_SIZE; canvas.height = ANALYSIS_SIZE; }
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(video, sourceX, sourceY, cropSize, cropSize, 0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE);
  return true;
}
function decodeCurrentFrame() {
  const canvas = $('rxCanvas');
  const diagnostics = {};
  try {
    const raw = decodeFrameFromCanvas(canvas, diagnostics, state.rxGeometry);
    const packet = decodeOpticalPacket(raw);
    state.rxGeometry = diagnostics.geometry || state.rxGeometry;
    return { packet, diagnostics };
  } catch (firstError) {
    state.rxGeometry = null;
    if (classifyRxError(firstError) === 'FINDER' || classifyRxError(firstError) === 'COLOR') throw firstError;
    const retryDiagnostics = {};
    const raw = decodeFrameFromCanvas(canvas, retryDiagnostics, null);
    const packet = decodeOpticalPacket(raw);
    state.rxGeometry = retryDiagnostics.geometry || null;
    return { packet, diagnostics: retryDiagnostics };
  }
}

let lastScan = 0; let scanBusy = false;
async function scanLoop(now) {
  if (!state.receiving) return;
  if (!scanBusy && now - lastScan >= 80) {
    lastScan = now; scanBusy = true;
    try {
      if (copyCameraCropToAnalysis()) {
        const hadGeometry = Boolean(state.rxGeometry);
        const { packet, diagnostics } = decodeCurrentFrame();
        if (!hadGeometry && diagnostics?.finderContrast) {
          log(`RX finder lock · contrasto ${diagnostics.finderContrast.toFixed(1)} · cella ${diagnostics.meanCell.toFixed(2)} px · separazione colore ${diagnostics.colorSeparation.toFixed(4)}`);
        }
        await acceptPacket(packet);
      }
    } catch (error) {
      recordRxError(error);
      if (state.rxBad % 5 === 0) {
        renderRxStats(`ultimo: ${state.rxLastError}`);
        status('rxStatus', `Nessun frame valido ancora · ${state.rxLastError}`, 'warn');
      }
    } finally { scanBusy = false; }
  }
  requestAnimationFrame(scanLoop);
}

async function runSelfTest() {
  try {
    const payload = Uint8Array.from({ length: 320 }, (_, i) => (i * 37 + 11) & 255);
    const meta = { streamId: 0x12345678, sourceCount: 1, chunkSize: 320, fileLength: 320, fileName: 'selftest.bin', sha256: 'ab'.repeat(32) };
    const packet = encodeOpticalPacket(meta, 0, payload);
    if (packet.length > CAPACITY_BYTES) throw new Error('packet > optical capacity');
    const canvas = document.createElement('canvas'); canvas.style.width = '720px'; canvas.style.height = '720px'; renderFrame(canvas, packet);
    const analysis = document.createElement('canvas'); analysis.width = ANALYSIS_SIZE; analysis.height = ANALYSIS_SIZE;
    const actx = analysis.getContext('2d', { alpha: false }); actx.drawImage(canvas, 0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE);
    const diagnostics = {}; const decodedRaw = decodeFrameFromCanvas(analysis, diagnostics); const decoded = decodeOpticalPacket(decodedRaw);
    if (decoded.streamId !== meta.streamId || decoded.symbolId !== 0) throw new Error('metadata mismatch');
    for (let i = 0; i < payload.length; i++) if (decoded.payload[i] !== payload[i]) throw new Error(`payload mismatch @${i}`);
    status('selfTest', `Autotest: OK · finder automatici · frame ${packet.length}/${CAPACITY_BYTES} B · encode→render→decode verificata`, 'ok');
    log(`Autotest ottico OK · finder contrast ${diagnostics.finderContrast?.toFixed(1) || '—'}`);
  } catch (error) {
    status('selfTest', `Autotest: ERRORE · ${error.message}`, 'error'); log(`Autotest FAIL: ${error.stack || error.message}`);
  }
}

function updateNetworkState() { $('netState').textContent = navigator.onLine ? 'rete: online' : 'rete: offline'; }
async function setupPwa() {
  updateNetworkState(); window.addEventListener('online', updateNetworkState); window.addEventListener('offline', updateNetworkState);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) $('pwaState').textContent = 'app: installata';
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      $('pwaState').textContent = standalone ? 'app: installata' : 'app: offline pronta';
      registration.update().catch(() => {}); log(`Service worker registrato: ${registration.scope}`);
    } catch (error) { $('pwaState').textContent = 'app: SW errore'; log(`Service worker error: ${error.message}`); }
  } else if (!standalone) $('pwaState').textContent = 'app: browser';
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); state.installPrompt = event; $('installPwa').hidden = false; });
  window.addEventListener('appinstalled', () => { $('installPwa').hidden = true; $('pwaState').textContent = 'app: installata'; state.installPrompt = null; log('PWA installata'); });
  $('installPwa').addEventListener('click', async () => {
    if (!state.installPrompt) return; await state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; $('installPwa').hidden = true;
  });
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (isiOS && !standalone) $('pwaState').title = 'Su iPhone/iPad: Condividi → Aggiungi a Home';
}

$('fileInput').addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (file) prepareFile(file).catch(error => { status('txStatus', error.message, 'error'); log(`TX prepare error: ${error.stack || error.message}`); });
});
$('startTx').addEventListener('click', startTransmit);
$('stopTx').addEventListener('click', stopTransmit);
$('restartTx').addEventListener('click', restartTransmit);
$('fullTx').addEventListener('click', toggleFullscreenTx);
$('startRx').addEventListener('click', startCamera);
$('stopRx').addEventListener('click', stopCamera);
$('resetRx').addEventListener('click', resetReceiver);
$('guideSize').addEventListener('input', drawGuide);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (state.timer || state.receiving)) requestWakeLock(); });
window.addEventListener('beforeunload', () => { stopTransmit(); stopCamera(); if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl); });

$('capacity').textContent = `capacità: ${CAPACITY_BYTES} B/frame raw`;
resetRxErrors(); drawGuide(); setupPwa(); runSelfTest();
