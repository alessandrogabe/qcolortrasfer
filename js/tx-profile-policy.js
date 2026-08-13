// qcolortrasfer v2.4 TX profile policy.
//
// DECIMEN CLASSIC is an independent qcolortrasfer/MIT implementation of the
// v0.3 MIT optical technique: one ordinary B/W QR, ECC L, fixed mask 4,
// fountain erasure coding, three-frame lookahead, requestAnimationFrame timing
// and no attempt to burst through missed display deadlines.
//
// QCT2 is intentionally retained instead of cloning Decimen's frame header: it
// lets the same qcolortrasfer receiver compare Classic vs Multi on identical
// fountain/container semantics. The optical difference is therefore isolated.

import { FountainEncoder } from './fountain.js';
import {
  encodeOpticalPacketV2, packFileContainerV2, randomStreamId, sha256Hex
} from './protocol.js';
import { CAPACITY_BYTES } from './optical.js';
import { MAX_HIGH_THROUGHPUT_CHUNK } from './high-throughput.js';

export const CLASSIC_LOOKAHEAD = 3;
export const CLASSIC_QR_MARGIN = 4;
export const CLASSIC_QR_MASK = 4;
export const CLASSIC_QR_ECC = 'L';
export const CLASSIC_MAX_RENDER_DPR = 4;

export function classicCanvasMetrics(rasterSize, budgetWidthCss, budgetHeightCss, devicePixelRatio = 1) {
  const raster = Math.max(1, Math.floor(Number(rasterSize) || 1));
  const width = Math.max(1, Number(budgetWidthCss) || 1);
  const height = Math.max(1, Number(budgetHeightCss) || 1);
  const dpr = Math.max(1, Math.min(CLASSIC_MAX_RENDER_DPR, Number(devicePixelRatio) || 1));
  const scale = Math.max(1, Math.floor(Math.min((width * dpr) / raster, (height * dpr) / raster)));
  const canvasPixels = raster * scale;
  return {
    dpr,
    scale,
    canvasPixels,
    cssPixels: canvasPixels / dpr,
    devicePixelsPerRasterCell: scale,
  };
}

export function classicFrameIntervalMs(fps) {
  return 1000 / Math.max(1, Math.min(60, Number(fps) || 24));
}

let qrModulePromise = null;
async function getQrCode() {
  if (!qrModulePromise) qrModulePromise = import('https://esm.sh/qrcode@1.5.4?bundle').then(mod => mod.default || mod);
  return qrModulePromise;
}

async function createClassicRaster(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Classic QR payload must be Uint8Array');
  if (bytes.length > CAPACITY_BYTES) throw new Error(`Classic QR packet ${bytes.length} B > ${CAPACITY_BYTES} B`);
  const QRCode = await getQrCode();
  const qr = QRCode.create([{ data: bytes, mode: 'byte' }], {
    errorCorrectionLevel: CLASSIC_QR_ECC,
    maskPattern: CLASSIC_QR_MASK,
  });
  const modules = qr.modules.size;
  const size = modules + CLASSIC_QR_MARGIN * 2;
  const pixels = new Uint8ClampedArray(size * size * 4);
  pixels.fill(255);
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      if (!qr.modules.get(y, x)) continue;
      const offset = ((y + CLASSIC_QR_MARGIN) * size + x + CLASSIC_QR_MARGIN) * 4;
      pixels[offset] = 0;
      pixels[offset + 1] = 0;
      pixels[offset + 2] = 0;
      pixels[offset + 3] = 255;
    }
  }
  return { pixels, size, modules, version: qr.version };
}

function installBrowserPolicy() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  const toolbar = document.querySelector('#txView .tx-toolbar');
  const fileInput = document.getElementById('fileInput');
  const colorMode = document.getElementById('colorMode');
  const gridMode = document.getElementById('gridMode');
  const payloadBytes = document.getElementById('payloadBytes');
  const fpsSelect = document.getElementById('fps');
  const startMain = document.getElementById('startTx');
  const stopLegacy = document.getElementById('stopTx');
  const fsStart = document.getElementById('fsStartTx');
  const fsStop = document.getElementById('fsStopTx');
  const fsReset = document.getElementById('fsResetTx');
  const canvas = document.getElementById('txCanvas');
  const stage = document.getElementById('txStage');
  const txStatus = document.getElementById('txStatus');
  const txFileInfo = document.getElementById('txFileInfo');
  const txFrame = document.getElementById('txFrame');
  const colorBadge = document.getElementById('colorBadge');
  const gridState = document.getElementById('gridState');
  if (!toolbar || !fileInput || !colorMode || !gridMode || !payloadBytes || !fpsSelect || !canvas || !stage) return;

  // Keep 1 QR internal: production Multi still exposes only AUTO/4/6 in HTML.
  let oneOption = [...gridMode.options].find(option => option.value === '1');
  if (!oneOption) {
    oneOption = new Option('1 QR · CLASSIC interno', '1');
    oneOption.hidden = true;
    gridMode.add(oneOption);
  }

  const methodLabel = document.createElement('label');
  methodLabel.className = 'tx-method-control';
  methodLabel.innerHTML = '<span>Metodo TX</span><select id="txMethod"><option value="classic" selected>DECIMEN CLASSIC · 1 QR B/N</option><option value="multi">QCOLOR MULTI · 4/6 QR</option></select>';
  const firstConfig = toolbar.querySelector('label:not(.file-control)');
  toolbar.insertBefore(methodLabel, firstConfig || null);
  const methodSelect = methodLabel.querySelector('select');

  let method = 'classic';
  let savedMultiColor = colorMode.value === 'bw' ? '4' : colorMode.value;
  let savedMultiGrid = gridMode.value === '1' ? 'auto' : gridMode.value;
  let classicSession = null;
  let classicRunning = false;
  let classicRunGeneration = 0;
  let classicRaf = 0;
  let classicGenerating = false;
  let classicQueue = [];
  let classicCurrent = null;
  let classicShown = 0;
  let classicStartedAt = 0;
  let classicWakeLock = null;
  let classicRenderScale = 1;
  let classicQueueMisses = 0;

  function setStatus(text, kind = '') {
    if (!txStatus) return;
    txStatus.textContent = text;
    txStatus.dataset.kind = kind;
  }
  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB'];
    let value = bytes, index = -1;
    do { value /= 1024; index++; } while (value >= 1024 && index < units.length - 1);
    return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
  }
  function stageBudget() {
    const style = getComputedStyle(stage);
    const px = value => Number.parseFloat(value) || 0;
    return {
      width: Math.max(1, stage.clientWidth - px(style.paddingLeft) - px(style.paddingRight)),
      height: Math.max(1, stage.clientHeight - px(style.paddingTop) - px(style.paddingBottom)),
    };
  }
  async function requestClassicWakeLock() {
    if (classicWakeLock || !('wakeLock' in navigator)) return;
    try {
      classicWakeLock = await navigator.wakeLock.request('screen');
      classicWakeLock.addEventListener('release', () => { classicWakeLock = null; });
    } catch {}
  }
  async function releaseClassicWakeLock() {
    if (!classicWakeLock) return;
    try { await classicWakeLock.release(); } catch {}
    classicWakeLock = null;
  }

  function updateClassicTelemetry() {
    if (!classicSession || !classicCurrent) return;
    const elapsed = classicStartedAt ? Math.max(0.001, (performance.now() - classicStartedAt) / 1000) : 0;
    const actual = elapsed ? (classicShown / elapsed).toFixed(1) : '—';
    const fps = Math.max(1, Math.min(60, Number(fpsSelect.value) || 24));
    const theoretical = classicSession.encoder.chunkSize * fps / 1024;
    if (txFrame) txFrame.textContent = `DECIMEN CLASSIC · QCT2 compatibile · 1 QR B/N · V${classicCurrent.raster.version} ECC L · mask 4 · quiet 4 · payload ${classicSession.encoder.chunkSize} B · ${fps} fps · scala intera ×${classicRenderScale} · ~${theoretical.toFixed(1)} KiB/s teorici · ${actual} simboli/s · queue ${classicQueue.length}/${CLASSIC_LOOKAHEAD} · miss ${classicQueueMisses}`;
    if (gridState) gridState.textContent = `1 QR · V${classicCurrent.raster.version} · ${classicRenderScale} px/cella raster · INTEGER`;
    if (colorBadge) colorBadge.textContent = 'DECIMEN CLASSIC · 1 QR B/N';
  }

  function renderClassic(item) {
    if (!item) return;
    classicCurrent = item;
    const raster = item.raster;
    const budget = stageBudget();
    const metrics = classicCanvasMetrics(raster.size, budget.width, budget.height, window.devicePixelRatio || 1);
    classicRenderScale = metrics.scale;

    const staging = document.createElement('canvas');
    staging.width = raster.size;
    staging.height = raster.size;
    staging.getContext('2d', { alpha: false }).putImageData(new ImageData(raster.pixels, raster.size, raster.size), 0, 0);

    canvas.width = metrics.canvasPixels;
    canvas.height = metrics.canvasPixels;
    canvas.style.width = `${metrics.cssPixels}px`;
    canvas.style.height = `${metrics.cssPixels}px`;
    canvas.style.maxWidth = 'none';
    canvas.style.maxHeight = 'none';
    canvas.style.imageRendering = 'pixelated';
    canvas.dataset.integerRaster = 'classic';
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(staging, 0, 0, raster.size, raster.size, 0, 0, canvas.width, canvas.height);
    updateClassicTelemetry();
  }

  function nextClassicPacket(runGeneration) {
    if (!classicSession || runGeneration !== classicRunGeneration) return null;
    const symbolId = classicSession.nextSymbolId++ >>> 0;
    const symbol = classicSession.encoder.symbol(symbolId);
    return encodeOpticalPacketV2(classicSession.meta, symbolId, symbol.data);
  }

  async function makeClassicItem(runGeneration) {
    const packet = nextClassicPacket(runGeneration);
    if (!packet) return null;
    const raster = await createClassicRaster(packet);
    if (runGeneration !== classicRunGeneration) return null;
    return { raster };
  }

  async function pumpClassic(runGeneration, max = CLASSIC_LOOKAHEAD) {
    if (classicGenerating || !classicSession || runGeneration !== classicRunGeneration) return;
    classicGenerating = true;
    try {
      for (let n = 0; n < max && classicQueue.length < CLASSIC_LOOKAHEAD; n++) {
        const item = await makeClassicItem(runGeneration);
        if (!item || runGeneration !== classicRunGeneration) break;
        classicQueue.push(item);
      }
    } catch (error) {
      classicRunning = false;
      setStatus(`DECIMEN CLASSIC: ${error.message}`, 'error');
    } finally {
      classicGenerating = false;
      updateClassicTelemetry();
    }
  }

  async function prepareClassicSession(force = false) {
    const file = fileInput.files?.[0];
    if (!file) throw new Error('Seleziona prima un file da trasmettere.');
    const chunkSize = Math.max(512, Math.min(MAX_HIGH_THROUGHPUT_CHUNK, Number(payloadBytes.value) || MAX_HIGH_THROUGHPUT_CHUNK));
    const signature = `${file.name}:${file.size}:${file.lastModified}:${chunkSize}`;
    if (!force && classicSession?.signature === signature) return classicSession;

    setStatus(`DECIMEN CLASSIC: preparo ${file.name}…`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await sha256Hex(bytes);
    const container = packFileContainerV2(file.name, bytes, hash);
    const streamId = randomStreamId();
    const encoder = new FountainEncoder(container, chunkSize, streamId);
    if (encoder.sourceCount > 0xffff) throw new Error('File troppo grande per il payload QCT2 selezionato.');
    const meta = {
      protocolVersion: 2,
      streamId,
      sourceCount: encoder.sourceCount,
      chunkSize: encoder.chunkSize,
      containerLength: container.length,
      visualStates: 2,
    };
    const probe = encodeOpticalPacketV2(meta, 0, encoder.symbol(0).data);
    if (probe.length > CAPACITY_BYTES) throw new Error(`QCT2 ${probe.length} B supera QR V40-L (${CAPACITY_BYTES} B)`);

    classicSession = { signature, file, bytes, container, encoder, meta, nextSymbolId: 0 };
    classicQueue = [];
    classicCurrent = null;
    classicQueueMisses = 0;
    classicRunGeneration++;
    if (txFileInfo) txFileInfo.textContent = `${file.name} · ${formatBytes(bytes.length)} · DECIMEN CLASSIC · 1 QR B/N · QCT2 · K=${encoder.sourceCount} × ${encoder.chunkSize} B`;
    return classicSession;
  }

  async function startClassic() {
    if (method !== 'classic' || classicRunning) return;
    try {
      await prepareClassicSession();
      classicRunning = true;
      classicRunGeneration++;
      const runGeneration = classicRunGeneration;
      classicShown = 0;
      classicStartedAt = performance.now();
      classicQueueMisses = 0;
      await requestClassicWakeLock();
      await pumpClassic(runGeneration, CLASSIC_LOOKAHEAD);
      if (!classicRunning || runGeneration !== classicRunGeneration) return;
      const first = classicQueue.shift();
      if (!first) throw new Error('lookahead QR non disponibile');
      renderClassic(first);
      classicShown++;
      void pumpClassic(runGeneration, 1);

      const fps = Math.max(1, Math.min(60, Number(fpsSelect.value) || 24));
      setStatus(`Trasmissione DECIMEN CLASSIC attiva · 1 QR · ${fps} fps · scala intera · nessuno stretch CSS.`, 'ok');
      let nextAt = performance.now() + classicFrameIntervalMs(fps);
      const tick = now => {
        if (!classicRunning || runGeneration !== classicRunGeneration || method !== 'classic') return;
        classicRaf = requestAnimationFrame(tick);
        const interval = classicFrameIntervalMs(fpsSelect.value);
        if (now < nextAt) return;
        const item = classicQueue.shift();
        void pumpClassic(runGeneration, 1);
        if (!item) {
          classicQueueMisses++;
          nextAt = now + interval;
          updateClassicTelemetry();
          return;
        }
        renderClassic(item);
        classicShown++;
        nextAt += interval;
        // Same Decimen principle: if generation/display fell behind, skip the
        // missed deadline instead of flashing stale QR frames in a burst.
        if (now - nextAt > 3 * interval) nextAt = now + interval;
      };
      classicRaf = requestAnimationFrame(tick);
    } catch (error) {
      classicRunning = false;
      setStatus(`DECIMEN CLASSIC: ${error.message}`, 'error');
    }
  }

  function stopClassic({ quiet = false } = {}) {
    if (!classicRunning && !classicRaf) return;
    classicRunning = false;
    classicRunGeneration++;
    if (classicRaf) cancelAnimationFrame(classicRaf);
    classicRaf = 0;
    classicQueue = [];
    void releaseClassicWakeLock();
    if (!quiet) setStatus('DECIMEN CLASSIC in pausa. Il QR visibile resta decodificabile.');
  }

  async function resetClassic() {
    const resume = classicRunning;
    stopClassic({ quiet: true });
    classicSession = null;
    classicCurrent = null;
    try {
      await prepareClassicSession(true);
      if (resume) await startClassic();
      else setStatus('DECIMEN CLASSIC resettato. Premi START per un nuovo stream.', 'ok');
    } catch (error) {
      setStatus(`DECIMEN CLASSIC: ${error.message}`, 'error');
    }
  }

  function dispatchChange(element) {
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function applyMethod(next, notifyApp = true) {
    const previous = method;
    if (next === previous && notifyApp) return;

    if (previous === 'classic') stopClassic({ quiet: true });
    else {
      savedMultiColor = colorMode.value === 'bw' ? savedMultiColor : colorMode.value;
      savedMultiGrid = gridMode.value === '1' ? savedMultiGrid : gridMode.value;
      stopLegacy?.click();
    }

    method = next === 'multi' ? 'multi' : 'classic';
    document.body.dataset.txMethod = method;
    if (method === 'classic') {
      savedMultiColor = colorMode.value === 'bw' ? savedMultiColor : colorMode.value;
      savedMultiGrid = gridMode.value === '1' ? savedMultiGrid : gridMode.value;
      colorMode.value = 'bw';
      gridMode.value = '1';
      colorMode.disabled = true;
      gridMode.disabled = true;
      if (colorBadge) colorBadge.textContent = 'DECIMEN CLASSIC · 1 QR B/N';
      setStatus('DECIMEN CLASSIC pronto: 1 QR B/N grande, ECC L, mask 4, quiet zone 4, scala intera. Seleziona un file e premi START.', 'ok');
    } else {
      colorMode.disabled = false;
      gridMode.disabled = false;
      colorMode.value = savedMultiColor || '4';
      gridMode.value = savedMultiGrid === '1' ? 'auto' : (savedMultiGrid || 'auto');
      if (fileInput.files?.length && notifyApp) dispatchChange(fileInput);
    }

    if (notifyApp) {
      dispatchChange(colorMode);
      dispatchChange(gridMode);
    }
  }

  methodSelect.addEventListener('change', () => applyMethod(methodSelect.value, true));

  // In Classic mode the app.js file handler is deliberately bypassed: Classic
  // owns its own one-QR queue/raster path. Returning to Multi re-dispatches the
  // same selected file into app.js, so no feature is lost.
  fileInput.addEventListener('change', event => {
    if (method !== 'classic') return;
    event.stopImmediatePropagation();
    stopClassic({ quiet: true });
    classicSession = null;
    const file = fileInput.files?.[0];
    if (txFileInfo) txFileInfo.textContent = file ? `${file.name} · ${formatBytes(file.size)} · pronto per DECIMEN CLASSIC` : 'Nessun file selezionato.';
    setStatus(file ? 'File selezionato. Premi START: la vista ottica aprirà un singolo QR B/N a scala intera.' : 'Seleziona un file.', file ? 'ok' : '');
  }, { capture: true });

  function interceptClassicStart(event) {
    if (method !== 'classic') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void startClassic();
  }
  function interceptClassicStop(event) {
    if (method !== 'classic') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stopClassic();
  }
  function interceptClassicReset(event) {
    if (method !== 'classic') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void resetClassic();
  }

  startMain?.addEventListener('click', interceptClassicStart, { capture: true });
  fsStart?.addEventListener('click', interceptClassicStart, { capture: true });
  stopLegacy?.addEventListener('click', interceptClassicStop, { capture: true });
  fsStop?.addEventListener('click', interceptClassicStop, { capture: true });
  fsReset?.addEventListener('click', interceptClassicReset, { capture: true });

  // Multi renderer compatibility guard. app.js already builds an integer
  // nearest-neighbour backing canvas, then historically stretches its CSS box.
  // Cancel only that final stretch and force pixelated sampling; the existing
  // B/N/4-state/8-state engine, worker pool and scheduler are otherwise intact.
  let pinning = false;
  function pinMultiCanvas() {
    if (method !== 'multi' || !canvas.width || !canvas.height || pinning) return;
    pinning = true;
    try {
      const appDpr = Math.max(1, Math.min(Number(window.devicePixelRatio) || 1, 3));
      const cssW = canvas.width / appDpr;
      const cssH = canvas.height / appDpr;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.style.imageRendering = 'pixelated';
      canvas.dataset.integerRaster = 'multi-no-stretch';
    } finally {
      pinning = false;
    }
  }
  const observer = new MutationObserver(() => requestAnimationFrame(pinMultiCanvas));
  observer.observe(canvas, { attributes: true, attributeFilter: ['width', 'height', 'style'] });
  window.addEventListener('resize', () => {
    if (method === 'classic' && classicCurrent) requestAnimationFrame(() => renderClassic(classicCurrent));
    else requestAnimationFrame(pinMultiCanvas);
  });

  // Classic is the v2.4 default so the first physical benchmark measures the
  // proven one-QR optical geometry. Switching to Multi restores every existing
  // B/N/color profile and AUTO 4/6 behavior.
  applyMethod('classic', false);
}

installBrowserPolicy();
