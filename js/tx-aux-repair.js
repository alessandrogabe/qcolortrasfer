// qcolortrasfer v2.6 Decimen + AUX Repair side channel.
//
// This module intentionally leaves the existing DECIMEN CLASSIC sender intact.
// When AUX REPAIR is enabled, a second low-density B/W QR sends systematic
// source-block stripes in parallel. The receiver can inject a completed block
// directly into the main LT peeling decoder.

import { packFileContainerV2, randomStreamId, sha256Hex } from './protocol.js';
import { encodeAuxRepairPacket, AUX_STRIPE_BYTES } from './aux-repair.js';
import { MAX_HIGH_THROUGHPUT_CHUNK } from './high-throughput.js';

const AUX_QR_ECC = 'M';
const AUX_QR_MASK = 4;
const AUX_QR_MARGIN = 4;
const AUX_LOOKAHEAD = 2;
const AUX_MAX_DPR = 4;

let qrPromise = null;
async function getQrCode() {
  if (!qrPromise) qrPromise = import('https://esm.sh/qrcode@1.5.4?bundle').then(mod => mod.default || mod);
  return qrPromise;
}

function installAuxRepairUi() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const toolbar = document.querySelector('#txView .tx-toolbar');
  const methodSelect = document.getElementById('txMethod');
  const fileInput = document.getElementById('fileInput');
  const payloadBytes = document.getElementById('payloadBytes');
  const fpsSelect = document.getElementById('fps');
  const stage = document.getElementById('txStage');
  const txFrame = document.getElementById('txFrame');
  if (!toolbar || !methodSelect || !fileInput || !payloadBytes || !fpsSelect || !stage) return;

  const variantLabel = document.createElement('label');
  variantLabel.className = 'tx-aux-control';
  variantLabel.innerHTML = '<span>Modalità Decimen</span><select id="txClassicVariant"><option value="classic" selected>CLASSIC · solo QR principale</option><option value="aux">CLASSIC + AUX REPAIR · QR helper</option></select>';
  const methodLabel = methodSelect.closest('label');
  methodLabel?.after(variantLabel);
  const variant = variantLabel.querySelector('select');

  const auxCanvas = document.createElement('canvas');
  auxCanvas.id = 'txAuxCanvas';
  auxCanvas.setAttribute('aria-label', 'QR helper AUX repair');
  auxCanvas.hidden = true;
  stage.appendChild(auxCanvas);

  const auxStats = document.createElement('div');
  auxStats.id = 'txAuxStats';
  auxStats.className = 'frame-meta telemetry-line';
  auxStats.hidden = true;
  txFrame?.after(auxStats);

  const badges = document.querySelector('.badges');
  const auxBadge = document.createElement('span');
  auxBadge.id = 'auxRepairBadge';
  auxBadge.className = 'badge';
  auxBadge.textContent = 'AUX REPAIR';
  auxBadge.hidden = true;
  badges?.appendChild(auxBadge);

  let session = null;
  let running = false;
  let generation = 0;
  let queue = [];
  let generating = false;
  let raf = 0;
  let nextAt = 0;
  let shown = 0;
  let misses = 0;
  let startedAt = 0;
  let auxCssTarget = 120;
  let currentRaster = null;

  function enabled() { return methodSelect.value === 'classic' && variant.value === 'aux'; }
  function selectedChunk() { return Math.max(512, Math.min(MAX_HIGH_THROUGHPUT_CHUNK, Number(payloadBytes.value) || MAX_HIGH_THROUGHPUT_CHUNK)); }
  function auxFps() {
    const main = Math.max(1, Math.min(60, Number(fpsSelect.value) || 24));
    return Math.max(8, Math.min(24, Math.round(main / 2)));
  }
  function sourceBlock(container, chunkSize, blockIndex) {
    const out = new Uint8Array(chunkSize);
    const start = blockIndex * chunkSize;
    out.set(container.subarray(start, Math.min(container.length, start + chunkSize)));
    return out;
  }

  function syncAuxLayout() {
    if (!enabled()) return;
    const width = Math.max(1, stage.clientWidth || window.innerWidth || 1);
    const height = Math.max(1, stage.clientHeight || window.innerHeight || 1);
    const sideLayout = width > height * 1.18;
    auxCssTarget = Math.max(104, Math.min(180, Math.round(Math.min(width, height) * 0.29)));
    stage.classList.add('aux-repair-active');
    stage.classList.toggle('aux-repair-side', sideLayout);
    stage.style.setProperty('--aux-repair-size', `${auxCssTarget}px`);
    stage.style.setProperty('--aux-repair-reserve', `${auxCssTarget + 16}px`);
    auxCanvas.hidden = false;
  }

  function requestMainResize() {
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  function enableLayout() {
    if (!enabled()) return disableLayout();
    syncAuxLayout();
    auxBadge.hidden = false;
    auxStats.hidden = false;
    requestMainResize();
  }
  function disableLayout() {
    stage.classList.remove('aux-repair-active', 'aux-repair-side');
    stage.style.removeProperty('--aux-repair-size');
    stage.style.removeProperty('--aux-repair-reserve');
    auxCanvas.hidden = true;
    auxBadge.hidden = true;
    auxStats.hidden = true;
    requestMainResize();
  }

  async function createAuxRaster(bytes) {
    const QRCode = await getQrCode();
    const qr = QRCode.create([{ data: bytes, mode: 'byte' }], { errorCorrectionLevel: AUX_QR_ECC, maskPattern: AUX_QR_MASK });
    const modules = qr.modules.size;
    const size = modules + AUX_QR_MARGIN * 2;
    const pixels = new Uint8ClampedArray(size * size * 4);
    pixels.fill(255);
    for (let y = 0; y < modules; y++) for (let x = 0; x < modules; x++) {
      if (!qr.modules.get(y, x)) continue;
      const offset = ((y + AUX_QR_MARGIN) * size + x + AUX_QR_MARGIN) * 4;
      pixels[offset] = 0; pixels[offset + 1] = 0; pixels[offset + 2] = 0; pixels[offset + 3] = 255;
    }
    return { pixels, size, modules, version: qr.version };
  }

  function renderAux(item) {
    if (!item?.raster || !enabled()) return;
    currentRaster = item.raster;
    const raster = item.raster;
    const dpr = Math.max(1, Math.min(AUX_MAX_DPR, Number(window.devicePixelRatio) || 1));
    const scale = Math.max(1, Math.floor((auxCssTarget * dpr) / raster.size));
    const px = raster.size * scale;
    const staging = document.createElement('canvas');
    staging.width = raster.size; staging.height = raster.size;
    staging.getContext('2d', { alpha: false }).putImageData(new ImageData(raster.pixels, raster.size, raster.size), 0, 0);
    auxCanvas.width = px; auxCanvas.height = px;
    auxCanvas.style.width = `${px / dpr}px`;
    auxCanvas.style.height = `${px / dpr}px`;
    auxCanvas.style.imageRendering = 'pixelated';
    const ctx = auxCanvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, px, px);
    ctx.drawImage(staging, 0, 0, raster.size, raster.size, 0, 0, px, px);
    updateStats(item, scale);
  }

  function updateStats(item = null, scale = null) {
    if (!enabled()) return;
    const fps = auxFps();
    const elapsed = startedAt ? Math.max(0.001, (performance.now() - startedAt) / 1000) : 0;
    const actual = elapsed ? (shown / elapsed).toFixed(1) : '—';
    const current = item || session?.lastItem;
    const stripeCount = session ? Math.ceil(session.chunkSize / session.stripeSize) : 0;
    const version = current?.raster?.version ?? currentRaster?.version ?? '—';
    const scaleText = scale ?? '—';
    auxStats.textContent = `AUX REPAIR · QAR1 · ${session?.stripeSize || AUX_STRIPE_BYTES} B/stripe · ${fps} fps · QR V${version} ECC M · scala ×${scaleText} · ${actual} helper/s · queue ${queue.length}/${AUX_LOOKAHEAD} · miss ${misses} · ciclo blocco ${session ? session.blockIndex + 1 : '—'}/${session?.sourceCount || '—'} stripe ${session ? session.stripeIndex + 1 : '—'}/${stripeCount || '—'}`;
  }

  async function prepareSession(force = false) {
    const file = fileInput.files?.[0];
    if (!file) throw new Error('Seleziona prima un file.');
    const chunkSize = selectedChunk();
    const signature = `${file.name}:${file.size}:${file.lastModified}:${chunkSize}`;
    if (!force && session?.signature === signature) return session;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await sha256Hex(bytes);
    const container = packFileContainerV2(file.name, bytes, hash);
    const sourceCount = Math.max(1, Math.ceil(container.length / chunkSize));
    if (sourceCount > 0xffff) throw new Error('AUX: troppi blocchi sorgente.');
    session = {
      signature, container, chunkSize, sourceCount,
      stripeSize: Math.min(AUX_STRIPE_BYTES, chunkSize),
      auxSessionId: randomStreamId(), blockIndex: 0, stripeIndex: 0, lastItem: null,
    };
    queue = []; misses = 0; generation++;
    updateStats();
    return session;
  }

  function nextDescriptor(runGeneration) {
    if (!session || runGeneration !== generation) return null;
    const blockIndex = session.blockIndex;
    const stripeIndex = session.stripeIndex;
    const block = sourceBlock(session.container, session.chunkSize, blockIndex);
    const meta = {
      auxSessionId: session.auxSessionId,
      sourceCount: session.sourceCount,
      chunkSize: session.chunkSize,
      containerLength: session.container.length,
      stripeSize: session.stripeSize,
    };
    const packet = encodeAuxRepairPacket(meta, blockIndex, stripeIndex, block);
    const stripeCount = Math.ceil(session.chunkSize / session.stripeSize);
    session.stripeIndex++;
    if (session.stripeIndex >= stripeCount) {
      session.stripeIndex = 0;
      session.blockIndex = (session.blockIndex + 1) % session.sourceCount;
    }
    return { packet, blockIndex, stripeIndex };
  }

  async function makeItem(runGeneration) {
    const descriptor = nextDescriptor(runGeneration);
    if (!descriptor) return null;
    const raster = await createAuxRaster(descriptor.packet);
    if (runGeneration !== generation) return null;
    return { ...descriptor, raster };
  }

  async function pump(runGeneration) {
    if (generating || !running || runGeneration !== generation) return;
    generating = true;
    try {
      while (running && runGeneration === generation && queue.length < AUX_LOOKAHEAD) {
        const item = await makeItem(runGeneration);
        if (!item) break;
        queue.push(item);
      }
    } catch (error) {
      running = false;
      auxStats.textContent = `AUX REPAIR errore: ${error.message}`;
      auxStats.dataset.kind = 'error';
    } finally {
      generating = false;
      updateStats();
    }
  }

  async function startAux() {
    if (!enabled() || running) return;
    enableLayout();
    try {
      await prepareSession();
      running = true;
      generation++;
      const runGeneration = generation;
      shown = 0; misses = 0; startedAt = performance.now();
      await pump(runGeneration);
      if (!running || runGeneration !== generation) return;
      const first = queue.shift();
      if (!first) throw new Error('lookahead helper non disponibile');
      session.lastItem = first; renderAux(first); shown++; void pump(runGeneration);
      nextAt = performance.now() + 1000 / auxFps();
      const tick = now => {
        if (!running || runGeneration !== generation || !enabled()) return;
        raf = requestAnimationFrame(tick);
        const interval = 1000 / auxFps();
        if (now < nextAt) return;
        const item = queue.shift();
        void pump(runGeneration);
        if (!item) { misses++; nextAt = now + interval; updateStats(); return; }
        session.lastItem = item; renderAux(item); shown++;
        nextAt += interval;
        if (now - nextAt > 3 * interval) nextAt = now + interval;
      };
      raf = requestAnimationFrame(tick);
    } catch (error) {
      running = false;
      auxStats.hidden = false;
      auxStats.textContent = `AUX REPAIR errore: ${error.message}`;
      auxStats.dataset.kind = 'error';
    }
  }

  function stopAux() {
    running = false; generation++;
    if (raf) cancelAnimationFrame(raf);
    raf = 0; queue = [];
    updateStats();
  }

  async function resetAux(resume = running) {
    stopAux(); session = null; currentRaster = null;
    if (resume && enabled()) await startAux();
  }

  function syncAvailability() {
    const classic = methodSelect.value === 'classic';
    variant.disabled = !classic;
    variantLabel.hidden = !classic;
    if (!classic) { stopAux(); disableLayout(); }
    else if (variant.value === 'aux') enableLayout();
    else disableLayout();
  }

  variant.addEventListener('change', () => {
    stopAux(); session = null;
    syncAvailability();
  });
  methodSelect.addEventListener('change', () => queueMicrotask(syncAvailability));
  payloadBytes.addEventListener('change', () => { session = null; });
  fpsSelect.addEventListener('change', updateStats);

  // Observe transport controls before target-level Classic handlers. The main
  // sender remains owner of its QR; this module only starts/stops the sidecar.
  document.addEventListener('click', event => {
    const id = event.target?.id;
    if ((id === 'startTx' || id === 'fsStartTx') && enabled()) queueMicrotask(() => { void startAux(); });
    else if (id === 'stopTx' || id === 'fsStopTx' || id === 'fsExitTx') stopAux();
    else if (id === 'fsResetTx' && enabled()) {
      const resume = running;
      queueMicrotask(() => { void resetAux(resume); });
    }
  }, { capture: true });

  document.addEventListener('change', event => {
    if (event.target === fileInput) { stopAux(); session = null; }
  }, { capture: true });

  window.addEventListener('resize', () => { if (enabled()) syncAuxLayout(); });
  window.addEventListener('orientationchange', () => { if (enabled()) { syncAuxLayout(); requestMainResize(); } });
  window.addEventListener('pagehide', stopAux);

  syncAvailability();
}

installAuxRepairUi();
