// qcolortrasfer RX v3 runtime gates (MIT).
//
// Loaded before app.js:
// 1) camera negotiation expands exact targets to an ideal attempt before app.js
//    moves to the next tier: 60 exact -> 60 ideal -> 30 exact -> 30 ideal;
// 2) requestVideoFrameCallback suppresses capture callbacks while every QR
//    worker is busy, so app.js never performs drawImage/getImageData for frames
//    that have nowhere to go.

function cloneVideoWithFrameRate(constraints, frameRate) {
  if (!constraints || typeof constraints !== 'object') return constraints;
  const video = constraints.video;
  if (!video || typeof video !== 'object') return constraints;
  return { ...constraints, video: { ...video, frameRate } };
}

function installCameraNegotiation() {
  const mediaDevices = globalThis.navigator?.mediaDevices;
  if (!mediaDevices?.getUserMedia || globalThis.__QCOLOR_CAMERA_NEGOTIATION_PATCH) return;
  const native = mediaDevices.getUserMedia.bind(mediaDevices);
  try {
    mediaDevices.getUserMedia = async constraints => {
      const exact = Number(constraints?.video?.frameRate?.exact);
      if (exact !== 60 && exact !== 30) return native(constraints);
      try {
        const stream = await native(constraints);
        globalThis.__QCOLOR_CAMERA_NEGOTIATION = `${exact} exact`;
        return stream;
      } catch (exactError) {
        try {
          const stream = await native(cloneVideoWithFrameRate(constraints, { ideal: exact }));
          globalThis.__QCOLOR_CAMERA_NEGOTIATION = `${exact} ideal`;
          return stream;
        } catch {
          globalThis.__QCOLOR_CAMERA_NEGOTIATION = `${exact} rejected → app fallback`;
          throw exactError;
        }
      }
    };
    globalThis.__QCOLOR_CAMERA_NEGOTIATION_PATCH = true;
  } catch {}
}

function installBusyFrameGate() {
  const proto = globalThis.HTMLVideoElement?.prototype;
  if (!proto?.requestVideoFrameCallback || globalThis.__QCOLOR_RX_FRAME_GATE) return;
  const native = proto.requestVideoFrameCallback;
  try {
    proto.requestVideoFrameCallback = function requestVideoFrameCallbackGated(callback) {
      if (this.id !== 'rxVideo') return native.call(this, callback);
      const video = this;
      const gated = (now, metadata) => {
        const pool = Math.max(0, Number(globalThis.__QCOLOR_RX_QR_POOL) || 0);
        const busy = Math.max(0, Number(globalThis.__QCOLOR_RX_QR_BUSY) || 0);
        if (video.srcObject && pool > 0 && busy >= pool) {
          globalThis.__QCOLOR_RX_EARLY_DROPS = (Number(globalThis.__QCOLOR_RX_EARLY_DROPS) || 0) + 1;
          native.call(video, gated);
          return;
        }
        callback(now, metadata);
      };
      return native.call(video, gated);
    };
    globalThis.__QCOLOR_RX_FRAME_GATE = true;
  } catch {}
}

installCameraNegotiation();
installBusyFrameGate();
