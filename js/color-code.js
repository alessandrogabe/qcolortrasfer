// qcolortrasfer chromatic modulation.
// Luminance remains the ordinary QR bit read by ZXing. Chroma carries one
// additional QR bit in 4-state mode or two additional QR bits in 8-state mode.
// Reserved QR function modules stay pure black/white.

export const COLOR_MODE_4 = 'dual-qr-4color-v1';
export const COLOR_MODE_8 = 'triple-qr-8color-v1';
export const COLOR_MODE = COLOR_MODE_4; // backward-compatible alias

// Proven 4-state palette retained unchanged as the stable fallback.
export const COLOR_PALETTE = Object.freeze({
  dark0: Object.freeze([150, 20, 20]),
  dark1: Object.freeze([0, 55, 145]),
  light0: Object.freeze([250, 235, 90]),
  light1: Object.freeze([120, 235, 245])
});

// Experimental 8-state palette. The four chromatic states occupy four
// quadrants in two normalized opponent-color axes while dark/light luma bands
// stay widely separated for the base QR binarizer.
export const COLOR_PALETTE_8 = Object.freeze({
  dark00: Object.freeze([240, 0, 0]),
  dark10: Object.freeze([30, 30, 240]),
  dark01: Object.freeze([50, 60, 0]),
  dark11: Object.freeze([0, 60, 60]),
  light00: Object.freeze([255, 145, 145]),
  light10: Object.freeze([160, 160, 255]),
  light01: Object.freeze([205, 205, 15]),
  light11: Object.freeze([20, 240, 240])
});

export function rgbForState(primaryDark, colorBit) {
  if (primaryDark) return colorBit ? COLOR_PALETTE.dark1 : COLOR_PALETTE.dark0;
  return colorBit ? COLOR_PALETTE.light1 : COLOR_PALETTE.light0;
}

export function rgbForState8(primaryDark, bitA, bitB) {
  const prefix = primaryDark ? 'dark' : 'light';
  return COLOR_PALETTE_8[`${prefix}${bitA ? 1 : 0}${bitB ? 1 : 0}`];
}

export function luma(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

// Axis A: warm/cool opponent component. Positive is blue/cyan, negative red/yellow.
export function chromaScoreA(r, g, b) {
  return (b - r) / Math.max(1, r + g + b);
}

// Backward-compatible name used by the proven 4-state decoder.
export const chromaScore = chromaScoreA;

// Axis B: green/cyan-yellow versus red/blue-magenta opponent component.
export function chromaScoreB(r, g, b) {
  return (2 * g - r - b) / Math.max(1, r + g + b);
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
