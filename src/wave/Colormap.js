/**
 * Phase → RGB colormaps. A "phase" is a 0–1 activation value from the
 * WaveEngine: 0 = resting, rising to 1 at the depolarization peak, falling back
 * to 0 through repolarization.
 *
 * Each colormap writes straight into a target Float32Array at an offset to avoid
 * per-vertex allocations in the animation loop:
 *     colormap(phase, out, offset)  // sets out[offset..offset+2]
 */

/** Linear-segment colormap from a list of [stop, r, g, b] control points. */
function makeRamp(stops) {
  return (phase, out, off) => {
    const p = phase <= 0 ? 0 : phase >= 1 ? 1 : phase;
    for (let i = 1; i < stops.length; i++) {
      const [s1, r1, g1, b1] = stops[i];
      if (p <= s1) {
        const [s0, r0, g0, b0] = stops[i - 1];
        const t = (p - s0) / (s1 - s0 || 1);
        out[off] = r0 + (r1 - r0) * t;
        out[off + 1] = g0 + (g1 - g0) * t;
        out[off + 2] = b0 + (b1 - b0) * t;
        return;
      }
    }
    const last = stops[stops.length - 1];
    out[off] = last[1]; out[off + 1] = last[2]; out[off + 2] = last[3];
  };
}

// Action-potential palette: dark resting blue → red → bright orange peak.
export const actionPotential = makeRamp([
  [0.0, 0.14, 0.18, 0.34],
  [0.35, 0.55, 0.16, 0.22],
  [0.65, 0.88, 0.28, 0.10],
  [1.0, 1.00, 0.82, 0.28],
]);

// Perceptually-ordered fallbacks (approximate).
export const viridis = makeRamp([
  [0.0, 0.27, 0.00, 0.33],
  [0.5, 0.13, 0.57, 0.55],
  [1.0, 0.99, 0.91, 0.14],
]);

export const temperature = makeRamp([
  [0.0, 0.13, 0.20, 0.45],
  [0.5, 0.85, 0.85, 0.85],
  [1.0, 0.78, 0.10, 0.10],
]);

export const colormaps = { actionPotential, viridis, temperature };

// --- categorical region palette (for the heart's anatomical elemTag) ----------

function hslToRgb(h, s, l) {
  const k = (n) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

/** 24 visually-distinct colors via the golden-angle hue walk, alternating tone. */
export const REGION_COLORS = Array.from({ length: 24 }, (_, i) => {
  const h = ((i * 137.508) % 360) / 360;
  const s = 0.5 + 0.15 * (i % 2);
  const l = 0.5 + (i % 3 === 0 ? 0.12 : i % 3 === 1 ? -0.02 : 0.04);
  return hslToRgb(h, s, l);
});

/** RGB (0–1) for an integer region tag (1-based); gray fallback. */
export function regionRGB(tag) {
  const t = (tag | 0) - 1;
  return (t >= 0 && t < REGION_COLORS.length) ? REGION_COLORS[t] : [0.5, 0.5, 0.5];
}
