// qcolortrasfer 4-state optical palette.
// The first visual bit is the ordinary QR luminance bit decoded by ZXing.
// The second bit is encoded chromatically inside the same module:
//   dark+warm, dark+cool, light+warm, light+cool = 4 visible states.
// Function/reserved QR modules stay pure B/W; only data/ECC modules carry color.

export const COLOR_MODE = 'dual-qr-4color-v1';

export const COLOR_PALETTE = Object.freeze({
  dark0: Object.freeze([150, 20, 20]),   // warm dark red, Y ~= 48
  dark1: Object.freeze([0, 55, 145]),    // cool dark blue, Y ~= 50
  light0: Object.freeze([250, 235, 90]), // warm light yellow, Y ~= 228
  light1: Object.freeze([120, 235, 245]) // cool light cyan, Y ~= 211
});

export function rgbForState(primaryDark, colorBit) {
  if (primaryDark) return colorBit ? COLOR_PALETTE.dark1 : COLOR_PALETTE.dark0;
  return colorBit ? COLOR_PALETTE.light1 : COLOR_PALETTE.light0;
}

export function luma(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

// Warm states have R > B, cool states have B > R. Normalize by total light so
// exposure changes mostly cancel out. This is deliberately independent of the
// QR luminance bit: both dark/light warm states fall below both cool states.
export function chromaScore(r, g, b) {
  return (b - r) / Math.max(1, r + g + b);
}

export function clusterColorScores(values, minSeparation = 0.08) {
  if (!values || values.length < 8) return null;
  let low = Infinity;
  let high = -Infinity;
  for (const raw of values) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  if (!Number.isFinite(low) || !Number.isFinite(high) || high - low < minSeparation) return null;

  let c0 = low;
  let c1 = high;
  for (let iteration = 0; iteration < 8; iteration++) {
    let s0 = 0, n0 = 0, s1 = 0, n1 = 0;
    const threshold = (c0 + c1) / 2;
    for (const raw of values) {
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      if (value <= threshold) { s0 += value; n0++; }
      else { s1 += value; n1++; }
    }
    if (!n0 || !n1) return null;
    c0 = s0 / n0;
    c1 = s1 / n1;
  }
  if (c0 > c1) [c0, c1] = [c1, c0];
  const separation = c1 - c0;
  if (separation < minSeparation) return null;
  return { low: c0, high: c1, threshold: (c0 + c1) / 2, separation };
}

export function classifyColorScore(score, clusters) {
  return score > clusters.threshold ? 1 : 0;
}
