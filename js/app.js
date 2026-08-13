import { FountainEncoder, FountainDecoder } from './fountain.js';
import { encodeOpticalPacket, decodeOpticalPacket, randomStreamId, sha256Hex } from './protocol.js';
import { renderFrame, decodeFrameFromCanvas, CAPACITY_BYTES } from './optical.js';

const $ = id => document.getElementById(id);
const state = {
  encoder: null,
  meta: null,
  symbolId: 0,
  timer: null,
  receiving: false,
  stream: null,
  rxDecoder: null,
  rxMeta: null,
  rxFrames: 0,
  rxBad: 0,
  rxLastSymbol: -1,
  expectedHash: null
};

function status(id, text, kind = '') {
  const el = $(id);
  el.textContent = text;
  el.dataset.kind = kind;
}

async function prepareFile(file) {
  stopTransmit();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await sha256Hex(bytes);
  const encoder = new FountainEncoder(bytes, 320);
  state.encoder = encoder;
  state.symbolId = 0;
  state.meta = {
    streamId: randomStreamId(),
    sourceCount: encoder.sourceCount,
    chunkSize: encoder.chunkSize,
    fileLength: bytes.length,
    fileName: file.name,
    sha256: hash
  };
  $('txFileInfo').textContent = `${file.name} · ${bytes.length.toLocaleString()} B · ${encoder.sourceCount} blocchi sorgente`;
  status('txStatus', `Pronto. Capacità ottica: ${CAPACITY_BYTES} B/frame.`, 'ok');
  drawSymbol();
}

function drawSymbol() {
  if (!state.encoder) return;
  const symbol = state.encoder.symbol(state.symbolId);
  const packet = encodeOpticalPacket(state.meta, state.symbolId, symbol.data);
  renderFrame($('txCanvas'), packet);
  $('txFrame').textContent = `simbolo ${state.symbolId} · ${state.symbolId < state.encoder.sourceCount ? 'sorgente' : 'repair'}`;
  state.symbolId++;
}

function startTransmit() {
  if (!state.encoder || state.timer) return;
  const fps = Number($('fps').value);
  status('txStatus', `Trasmissione a ${fps} fps`, 'ok');
  const tick = () => {
    drawSymbol();
    state.timer = setTimeout(tick, 1000 / fps);
  };
  tick();
}

function stopTransmit() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (state.encoder) status('txStatus', 'Trasmissione in pausa.');
}

async function startCamera() {
  if (state.receiving) return;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false
    });
    const video = $('rxVideo');
    video.srcObject = state.stream;
    await video.play();
    state.receiving = true;
    status('rxStatus', 'Fotocamera attiva. Allinea il quadrato colorato alla guida.', 'ok');
    requestAnimationFrame(scanLoop);
  } catch (error) {
    status('rxStatus', `Fotocamera non disponibile: ${error.message}`, 'error');
  }
}

function stopCamera() {
  state.receiving = false;
  state.stream?.getTracks().forEach(track => track.stop());
  state.stream = null;
  $('rxVideo').srcObject = null;
  status('rxStatus', 'Fotocamera ferma.');
}

function resetReceiver() {
  state.rxDecoder = null;
  state.rxMeta = null;
  state.rxFrames = 0;
  state.rxBad = 0;
  state.rxLastSymbol = -1;
  state.expectedHash = null;
  $('rxProgress').value = 0;
  $('rxStats').textContent = '0 frame validi · 0 scartati';
  $('download').hidden = true;
  $('download').removeAttribute('href');
  status('rxStatus', state.receiving ? 'Ricevitore azzerato. Continua a inquadrare.' : 'Ricevitore azzerato.');
}

async function acceptPacket(packet) {
  if (!state.rxDecoder || state.rxMeta?.streamId !== packet.streamId) {
    state.rxMeta = packet;
    state.rxDecoder = new FountainDecoder(packet.sourceCount, packet.chunkSize, packet.fileLength);
    state.rxFrames = 0;
    state.rxBad = 0;
    state.expectedHash = packet.sha256;
  }

  if (packet.streamId !== state.rxMeta.streamId) return;
  state.rxDecoder.addSymbol(packet.symbolId, packet.payload);
  state.rxFrames++;
  state.rxLastSymbol = packet.symbolId;
  const pct = Math.floor(state.rxDecoder.progress * 100);
  $('rxProgress').value = pct;
  $('rxStats').textContent = `${state.rxFrames} frame validi · ${state.rxBad} scartati · ${state.rxDecoder.solvedCount}/${state.rxDecoder.sourceCount} blocchi`;
  status('rxStatus', `Ricezione ${pct}% · ultimo simbolo ${packet.symbolId}`, 'ok');

  if (state.rxDecoder.complete) {
    const bytes = state.rxDecoder.reconstruct();
    const hash = await sha256Hex(bytes);
    if (hash && state.expectedHash && hash !== state.expectedHash) {
      status('rxStatus', 'File ricostruito ma SHA-256 non coincide. Trasferimento rifiutato.', 'error');
      return;
    }
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    const link = $('download');
    link.href = url;
    link.download = state.rxMeta.fileName || 'qcolortrasfer.bin';
    link.hidden = false;
    link.textContent = `Scarica ${link.download}`;
    status('rxStatus', `Completato · ${bytes.length.toLocaleString()} B · integrità OK`, 'ok');
    stopCamera();
  }
}

let lastScan = 0;
async function scanLoop(now) {
  if (!state.receiving) return;
  if (now - lastScan > 65) {
    lastScan = now;
    const video = $('rxVideo');
    if (video.videoWidth && video.videoHeight) {
      const side = Math.min(video.videoWidth, video.videoHeight);
      const sx = (video.videoWidth - side) / 2;
      const sy = (video.videoHeight - side) / 2;
      const canvas = $('rxCanvas');
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      ctx.drawImage(video, sx, sy, side, side, 0, 0, side, side);
      try {
        const inset = Math.floor(side * 0.08);
        const raw = decodeFrameFromCanvas(canvas, { x: inset, y: inset, size: side - inset * 2 });
        const packet = decodeOpticalPacket(raw);
        if (packet.symbolId !== state.rxLastSymbol) await acceptPacket(packet);
      } catch {
        state.rxBad++;
        $('rxStats').textContent = `${state.rxFrames} frame validi · ${state.rxBad} scartati`;
      }
    }
  }
  requestAnimationFrame(scanLoop);
}

$('fileInput').addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (file) prepareFile(file).catch(error => status('txStatus', error.message, 'error'));
});
$('startTx').addEventListener('click', startTransmit);
$('stopTx').addEventListener('click', stopTransmit);
$('startRx').addEventListener('click', startCamera);
$('stopRx').addEventListener('click', stopCamera);
$('resetRx').addEventListener('click', resetReceiver);
window.addEventListener('beforeunload', stopCamera);

$('capacity').textContent = `${CAPACITY_BYTES} byte/frame raw`;
