// qcolortrasfer v2.7 adaptive Decimen + AUX Repair side channel.
//
// Keeps the DECIMEN CLASSIC main QR untouched and uses only screen area that
// does not reduce its integer physical raster scale when possible. Depending on
// the real optical viewport, 1, 2 or 3 fixed-geometry QAR1 helper QR are shown.
// Helpers are updated in a staggered round-robin schedule so every lane carries
// independent systematic source-block stripes without flashing all helpers on
// the same display refresh.

import { packFileContainerV2, randomStreamId, sha256Hex } from './protocol.js';
import { encodeAuxRepairPacket, AUX_HEADER_BYTES, AUX_STRIPE_BYTES } from './aux-repair.js';
import { MAX_HIGH_THROUGHPUT_CHUNK } from './high-throughput.js';

const AUX_QR_ECC = 'M';
const AUX_QR_MASK = 4;
const AUX_QR_MARGIN = 4;
const AUX_LOOKAHEAD_PER_HELPER = 2;
const AUX_MAX_DPR = 4;
const AUX_PACKET_CRC_BYTES = 4;
const AUX_OPTICAL_PACKET_BYTES = AUX_HEADER_BYTES + AUX_STRIPE_BYTES + AUX_PACKET_CRC_BYTES;
const AUX_MAX_HELPERS = 3;
const AUX_MIN_CSS_PX = 112;
const AUX_MAX_CSS_PX = 180;
const AUX_GAP_CSS_PX = 8;
const AUX_RESERVE_EXTRA_PX = 16;
const CLASSIC_V40_RASTER_WITH_QUIET = 185;

let qrPromise = null;
async function getQrCode() {
  if (!qrPromise) qrPromise = import('https://esm.sh/qrcode@1.5.4?bundle').then(mod => mod.default || mod);
  return qrPromise;
}

export function padAuxPacketForOpticalQr(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('AUX QR payload must be Uint8Array');
  if (bytes.length > AUX_OPTICAL_PACKET_BYTES) throw new Error(`AUX QR packet ${bytes.length} B > fixed optical envelope ${AUX_OPTICAL_PACKET_BYTES} B`);
  if (bytes.length === AUX_OPTICAL_PACKET_BYTES) return bytes;
  const padded = new Uint8Array(AUX_OPTICAL_PACKET_BYTES);
  padded.set(bytes);
  return padded;
}

function physicalScale(cssBudget, dpr, rasterSize) {
  return Math.max(1, Math.floor((Math.max(1, cssBudget) * dpr) / rasterSize));
}

// Highest helper count that fits the short screen axis while preserving the
// main V40 integer scale. This deliberately uses the densest main QR as the
// conservative reference; lower-version main QR only gain extra margin.
export function chooseAuxLayout(widthCss, heightCss, devicePixelRatio = 1, mainRasterSize = CLASSIC_V40_RASTER_WITH_QUIET) {
  const width = Math.max(1, Number(widthCss) || 1);
  const height = Math.max(1, Number(heightCss) || 1);
  const dpr = Math.max(1, Math.min(AUX_MAX_DPR, Number(devicePixelRatio) || 1));
  const raster = Math.max(21, Math.floor(Number(mainRasterSize) || CLASSIC_V40_RASTER_WITH_QUIET));
  const sideLayout = width > height * 1.18;
  const cross = sideLayout ? height : width;
  const baselineMainCss = Math.min(width, height);
  const baselineScale = physicalScale(baselineMainCss, dpr, raster);

  for (let count = AUX_MAX_HELPERS; count >= 1; count--) {
    const maxByCross = (cross - AUX_GAP_CSS_PX * (count - 1)) / count;
    const helperCss = Math.floor(Math.min(AUX_MAX_CSS_PX, cross * 0.31, maxByCross));
    if (helperCss < AUX_MIN_CSS_PX) continue;
    const reserve = helperCss + AUX_RESERVE_EXTRA_PX;
    const mainWidth = width - (sideLayout ? reserve : 0);
    const mainHeight = height - (sideLayout ? 0 : reserve);
    const candidateScale = physicalScale(Math.min(mainWidth, mainHeight), dpr, raster);
    if (candidateScale >= baselineScale) {
      return { count, helperCss, reserve, sideLayout, baselineScale, mainScale: candidateScale };
    }
  }

  // Small/short viewports may have no truly free strip. Keep one helper but
  // make the compromise explicit and bounded instead of hiding AUX entirely.
  const helperCss = Math.max(88, Math.floor(Math.min(AUX_MIN_CSS_PX, cross * 0.28)));
  const reserve = helperCss + AUX_RESERVE_EXTRA_PX;
  const mainWidth = width - (sideLayout ? reserve : 0);
  const mainHeight = height - (sideLayout ? 0 : reserve);
  return {
    count: 1, helperCss, reserve, sideLayout, baselineScale,
    mainScale: physicalScale(Math.min(mainWidth, mainHeight), dpr, raster),
  };
}

function installAdaptiveAuxRepairUi() {
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
  variantLabel.innerHTML = '<span>Modalità Decimen</span><select id="txClassicVariant"><option value="classic" selected>CLASSIC · solo QR principale</option><option value="aux">CLASSIC + AUX REPAIR · helper AUTO</option></select>';
  methodSelect.closest('label')?.after(variantLabel);
  const variant = variantLabel.querySelector('select');

  const auxLayer = document.createElement('div');
  auxLayer.id = 'txAuxLayer';
  auxLayer.setAttribute('aria-label', 'QR helper AUX repair adattivi');
  Object.assign(auxLayer.style, {
    position: 'absolute', zIndex: '4', display: 'none', alignItems: 'center',
    justifyContent: 'center', gap: `${AUX_GAP_CSS_PX}px`, pointerEvents: 'none',
  });
  stage.appendChild(auxLayer);

  const auxStats = document.createElement('div');
  auxStats.id = 'txAuxStats';
  auxStats.className = 'frame-meta telemetry-line';
  auxStats.hidden = true;
  txFrame?.after(auxStats);

  const auxBadge = document.createElement('span');
  auxBadge.id = 'auxRepairBadge';
  auxBadge.className = 'badge';
  auxBadge.textContent = 'AUX REPAIR AUTO';
  auxBadge.hidden = true;
  document.querySelector('.badges')?.appendChild(auxBadge);

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
  let layout = { count: 1, helperCss: 112, reserve: 128, sideLayout: false };
  let canvases = [];
  let currentRaster = null;
  let nextLane = 0;

  function enabled() { return methodSelect.value === 'classic' && variant.value === 'aux'; }
  function selectedChunk() { return Math.max(512, Math.min(MAX_HIGH_THROUGHPUT_CHUNK, Number(payloadBytes.value) || MAX_HIGH_THROUGHPUT_CHUNK)); }
  function auxFpsPerHelper() {
    const main = Math.max(1, Math.min(60, Number(fpsSelect.value) || 24));
    return Math.max(8, Math.min(24, Math.round(main / 2)));
  }
  function globalAuxTickFps() { return auxFpsPerHelper() * Math.max(1, layout.count); }
  function queueTarget() { return Math.max(2, AUX_LOOKAHEAD_PER_HELPER * Math.max(1, layout.count)); }
  function sourceBlock(container, chunkSize, blockIndex) {
    const out = new Uint8Array(chunkSize);
    const start = blockIndex * chunkSize;
    out.set(container.subarray(start, Math.min(container.length, start + chunkSize)));
    return out;
  }

  function styleCanvas(canvas) {
    Object.assign(canvas.style, {
      display: 'block', background: '#fff', imageRendering: 'pixelated',
      boxShadow: '0 0 0 5px #fff', touchAction: 'none', flex: '0 0 auto',
    });
  }

  function ensureCanvasCount(count) {
    while (canvases.length < count) {
      const canvas = document.createElement('canvas');
      canvas.className = 'txAuxCanvas';
      canvas.setAttribute('aria-label', `QR helper AUX repair ${canvases.length + 1}`);
      styleCanvas(canvas);
      auxLayer.appendChild(canvas);
      canvases.push(canvas);
    }
    while (canvases.length > count) canvases.pop()?.remove();
    nextLane %= Math.max(1, canvases.length);
  }

  function positionLayer() {
    auxLayer.style.flexDirection = layout.sideLayout ? 'column' : 'row';
    if (layout.sideLayout) {
      auxLayer.style.right = 'var(--tx-edge-x,12px)';
      auxLayer.style.left = 'auto';
      auxLayer.style.top = '50%';
      auxLayer.style.bottom = 'auto';
      auxLayer.style.transform = 'translateY(-50%)';
    } else {
      auxLayer.style.left = '50%';
      auxLayer.style.right = 'auto';
      auxLayer.style.bottom = 'var(--tx-edge-y,10px)';
      auxLayer.style.top = 'auto';
      auxLayer.style.transform = 'translateX(-50%)';
    }
  }

  function syncAuxLayout() {
    if (!enabled()) return;
    const next = chooseAuxLayout(
      Math.max(1, stage.clientWidth || window.innerWidth || 1),
      Math.max(1, stage.clientHeight || window.innerHeight || 1),
      window.devicePixelRatio || 1,
    );
    const changed = next.count !== layout.count || next.helperCss !== layout.helperCss || next.sideLayout !== layout.sideLayout;
    layout = next;
    ensureCanvasCount(layout.count);
    stage.classList.add('aux-repair-active');
    stage.classList.toggle('aux-repair-side', layout.sideLayout);
    stage.style.setProperty('--aux-repair-size', `${layout.helperCss}px`);
    stage.style.setProperty('--aux-repair-reserve', `${layout.reserve}px`);
    auxLayer.style.display = 'flex';
    positionLayer();
    auxBadge.textContent = `AUX REPAIR ×${layout.count}`;
    if (changed) updateStats();
  }

  function requestMainResize() { requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))); }
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
    auxLayer.style.display = 'none';
    auxBadge.hidden = true;
    auxStats.hidden = true;
    requestMainResize();
  }

  async function createAuxRaster(bytes) {
    const QRCode = await getQrCode();
    const opticalBytes = padAuxPacketForOpticalQr(bytes);
    const qr = QRCode.create([{ data: opticalBytes, mode: 'byte' }], { errorCorrectionLevel: AUX_QR_ECC, maskPattern: AUX_QR_MASK });
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

  function renderAux(item, lane) {
    const canvas = canvases[lane];
    if (!item?.raster || !canvas || !enabled()) return;
    currentRaster = item.raster;
    const raster = item.raster;
    const dpr = Math.max(1, Math.min(AUX_MAX_DPR, Number(window.devicePixelRatio) || 1));
    const scale = Math.max(1, Math.floor((layout.helperCss * dpr) / raster.size));
    const px = raster.size * scale;
    const staging = document.createElement('canvas');
    staging.width = raster.size; staging.height = raster.size;
    staging.getContext('2d', { alpha: false }).putImageData(new ImageData(raster.pixels, raster.size, raster.size), 0, 0);
    canvas.width = px; canvas.height = px;
    canvas.style.width = `${px / dpr}px`;
    canvas.style.height = `${px / dpr}px`;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, px, px);
    ctx.drawImage(staging, 0, 0, raster.size, raster.size, 0, 0, px, px);
    updateStats(item, scale);
  }

  function updateStats(item = null, scale = null) {
    if (!enabled()) return;
    const elapsed = startedAt ? Math.max(0.001, (performance.now() - startedAt) / 1000) : 0;
    const actual = elapsed ? (shown / elapsed).toFixed(1) : '—';
    const stripeCount = session ? Math.ceil(session.chunkSize / session.stripeSize) : 0;
    const version = item?.raster?.version ?? currentRaster?.version ?? '—';
    const scaleText = scale ?? '—';
    auxStats.textContent = `AUX REPAIR AUTO ×${layout.count} · QAR1 · ${session?.stripeSize || AUX_STRIPE_BYTES} B/stripe · ${auxFpsPerHelper()} fps/helper · ${globalAuxTickFps()} update/s staggered · QR V${version} ECC M · geometria fissa · scala ×${scaleText} · ${actual} stripe/s · queue ${queue.length}/${queueTarget()} · miss ${misses} · blocco ${session ? session.blockIndex + 1 : '—'}/${session?.sourceCount || '—'} stripe ${session ? session.stripeIndex + 1 : '—'}/${stripeCount || '—'}`;
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
      auxSessionId: randomStreamId(), blockIndex: 0, stripeIndex: 0,
    };
    queue = []; misses = 0; generation++; nextLane = 0;
    updateStats();
    return session;
  }

  function nextDescriptor(runGeneration) {
    if (!session || runGeneration !== generation) return null;
    const blockIndex = session.blockIndex;
    const stripeIndex = session.stripeIndex;
    const block = sourceBlock(session.container, session.chunkSize, blockIndex);
    const packet = encodeAuxRepairPacket({
      auxSessionId: session.auxSessionId,
      sourceCount: session.sourceCount,
      chunkSize: session.chunkSize,
      containerLength: session.container.length,
      stripeSize: session.stripeSize,
    }, blockIndex, stripeIndex, block);
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
      while (running && runGeneration === generation && queue.length < queueTarget()) {
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
      shown = 0; misses = 0; startedAt = performance.now(); nextLane = 0;
      await pump(runGeneration);
      if (!running || runGeneration !== generation) return;

      // Prime every visible helper with a different stripe before animation.
      for (let lane = 0; lane < layout.count; lane++) {
        const item = queue.shift();
        if (!item) break;
        renderAux(item, lane); shown++;
      }
      void pump(runGeneration);

      nextAt = performance.now() + 1000 / globalAuxTickFps();
      const tick = now => {
        if (!running || runGeneration !== generation || !enabled()) return;
        raf = requestAnimationFrame(tick);
        const interval = 1000 / globalAuxTickFps();
        if (now < nextAt) return;
        const item = queue.shift();
        void pump(runGeneration);
        if (!item) { misses++; nextAt = now + interval; updateStats(); return; }
        renderAux(item, nextLane); shown++;
        nextLane = (nextLane + 1) % Math.max(1, layout.count);
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

  variant.addEventListener('change', () => { stopAux(); session = null; syncAvailability(); });
  methodSelect.addEventListener('change', () => queueMicrotask(syncAvailability));
  payloadBytes.addEventListener('change', () => { session = null; });
  fpsSelect.addEventListener('change', updateStats);

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

  window.addEventListener('resize', () => {
    if (!enabled()) return;
    const oldCount = layout.count, oldReserve = layout.reserve, oldSide = layout.sideLayout;
    syncAuxLayout();
    if (oldCount !== layout.count || oldReserve !== layout.reserve || oldSide !== layout.sideLayout) requestMainResize();
  });
  window.addEventListener('orientationchange', () => { if (enabled()) { syncAuxLayout(); requestMainResize(); } });
  window.addEventListener('pagehide', stopAux);

  syncAvailability();
}

installAdaptiveAuxRepairUi();
