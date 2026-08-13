// qcolortrasfer adaptive sender scheduler.
//
// This module deliberately does NOT pretend to receive feedback from the remote
// camera: qcolortrasfer is a one-way optical link. "Adaptive" therefore means
// transmitter-side adaptation. We use the selected target fps, the number of
// visible QR tiles and the actual time a tile has already remained unchanged to
// guarantee a useful stable observation window for a typical ~30 fps camera.
//
// The important difference from the normal scheduler is that QR generation is
// allowed to happen while the currently displayed tile is still stable. Only
// the final paint is delayed. CPU time spent creating a dense QR therefore does
// not consume the optical dwell time seen by the receiver.

export const ADAPTIVE_CAMERA_FPS = 30;
export const ADAPTIVE_MIN_CAMERA_FRAMES = 2.25;
export const ADAPTIVE_MIN_DWELL_MS = 1000 * ADAPTIVE_MIN_CAMERA_FRAMES / ADAPTIVE_CAMERA_FPS; // 75 ms

/**
 * Return the minimum time for which one physical QR tile should remain
 * unchanged before it is replaced.
 *
 * At low rates the user's requested fps wins (e.g. 5 fps => 200 ms). At high
 * rates we clamp the dwell to ~75 ms, giving a 30 fps camera a little more than
 * two opportunities to observe the same QR. Selecting 20 fps therefore remains
 * a useful stress-test target, but ADAPTIVE will not blindly replace the same
 * tile every 50 ms.
 */
export function adaptiveDwellMs(requestedFps) {
  const fps = Math.max(1, Number(requestedFps) || 1);
  return Math.max(1000 / fps, ADAPTIVE_MIN_DWELL_MS);
}

/**
 * AUTO grid cap for the adaptive four-state profile.
 *
 * 4-state decoding proved materially more robust than the experimental
 * 8-state profile. We therefore keep six simultaneous QR up to 12 fps target.
 * At the 20 fps stress target AUTO uses four tiles so each code keeps more
 * pixels on screen; manual 6-QR remains available for comparative testing.
 */
export function adaptiveGridCap(requestedFps) {
  const fps = Math.max(1, Number(requestedFps) || 1);
  return fps >= 20 ? 4 : 6;
}

/**
 * Earliest monotonic timestamp at which a tile may be repainted.
 * A never-painted tile (timestamp <= 0) can be painted immediately.
 */
export function adaptiveNextPaintAt(lastPaintAt, requestedFps) {
  if (!(lastPaintAt > 0)) return 0;
  return lastPaintAt + adaptiveDwellMs(requestedFps);
}

/**
 * Effective per-QR ceiling imposed only by the optical dwell rule.
 * Generation cost can reduce the measured rate further at runtime.
 */
export function adaptiveOpticalFpsCeiling(requestedFps) {
  return Math.min(Math.max(1, Number(requestedFps) || 1), 1000 / adaptiveDwellMs(requestedFps));
}
