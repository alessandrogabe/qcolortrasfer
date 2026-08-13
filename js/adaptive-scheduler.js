// qcolortrasfer adaptive sender scheduler.
//
// This module deliberately does NOT pretend to receive feedback from the remote
// camera: qcolortrasfer is a one-way optical link. "Adaptive" therefore means
// transmitter-side dwell adaptation. In v2 this mode is retained as a fallback;
// the main production scheduler is the high-throughput lookahead/rAF path.
//
// QR generation is allowed to happen while the currently displayed tile is
// still stable. Only the final paint is delayed, so CPU time spent creating a
// dense QR does not consume the optical dwell time seen by the receiver.

export const ADAPTIVE_CAMERA_FPS = 30;
export const ADAPTIVE_MIN_CAMERA_FRAMES = 2.25;
export const ADAPTIVE_MIN_DWELL_MS = 1000 * ADAPTIVE_MIN_CAMERA_FRAMES / ADAPTIVE_CAMERA_FPS; // 75 ms

/**
 * Return the minimum time for which one physical QR tile should remain
 * unchanged before it is replaced.
 *
 * At low rates the user's requested fps wins (e.g. 5 fps => 200 ms). At high
 * rates we clamp the dwell to ~75 ms, giving a 30 fps camera a little more than
 * two opportunities to observe the same QR.
 */
export function adaptiveDwellMs(requestedFps) {
  const fps = Math.max(1, Number(requestedFps) || 1);
  return Math.max(1000 / fps, ADAPTIVE_MIN_DWELL_MS);
}

/**
 * Legacy v1.5 AUTO-grid policy retained for compatibility tests and historical
 * behavior. The v2 production UI does NOT use this helper: its grid contract is
 * strictly AUTO 4/6, forced 4 or forced 6, implemented by high-throughput.js.
 */
export function adaptiveGridCap(requestedFps) {
  const fps = Math.max(1, Number(requestedFps) || 1);
  return fps >= 20 ? 4 : 6;
}

/** Earliest monotonic timestamp at which one adaptive tile may be repainted. */
export function adaptiveNextPaintAt(lastPaintAt, requestedFps) {
  if (!(lastPaintAt > 0)) return 0;
  return lastPaintAt + adaptiveDwellMs(requestedFps);
}

/** Effective per-QR ceiling imposed only by the fallback dwell rule. */
export function adaptiveOpticalFpsCeiling(requestedFps) {
  return Math.min(Math.max(1, Number(requestedFps) || 1), 1000 / adaptiveDwellMs(requestedFps));
}
