/**
 * Pure geometry helpers (typed arrays only — no THREE) for the ECG-leads overlay:
 * place the torso shell around the heart, put virtual electrodes onto the torso
 * surface, and test heart-in-torso containment. Shared by the app
 * (`main.js` / `SceneManager.js`) and the unit test so they can't diverge.
 *
 * Scene frame everywhere here: +x = patient left, +y = superior (up),
 * +z = anterior (toward the default camera). The heart sits at the origin.
 */

// Rotation that brings the bundled heart from its native frame into the scene frame
// (+x left, +y superior, +z anterior). Derived from the mesh's own landmarks, not
// guessed: the long axis is the first PCA axis oriented toward the apex (the LV — the
// largest, most apical `region` — forms the cardiac apex); the short-axis reference is
// the LV→RV centroid vector. These two native vectors are aligned (Gram-Schmidt
// frame match) to physiological targets `apex_t = norm([0.35,-0.85,0.40])` (apex
// inferior+anterior+left) and `lvrv_t = norm([-0.55,0,0.84])` (RV anterior and right).
// Result places RV on the anterior surface, LV left-posterior, atria at the superior
// base. Row-major 3×3 (new vertex = M · old vertex); re-tune via the targets above.
export const HEART_ANATOMICAL_MATRIX = [
  0.7857, 0.0236, 0.6182,
  -0.6186, 0.0348, 0.7849,
  -0.0030, -0.9991, 0.0419,
];

// Torso placement constants.
// Heart cardiac-transverse diameter / torso chest left–right width — i.e. a
// cardiothoracic ratio. Derived from landmarks of the bundled meshes: cardiac
// transverse diameter ≈ 126 (verified as the true ventricular width — the widest
// cross-band sits at mid-ventricle; the great vessels don't inflate it) and torso
// chest LR width ≈ 337–348 (near-uniform with height). 0.29 is a lower-normal
// cardiothoracic ratio; it also yields realistic AP-depth (~0.35) and long-axis /
// torso-height (~0.23) ratios since only the torso is scaled.
export const HEART_LR_FRACTION = 0.29;   // heart left–right width / chest left–right width
// Heart center relative to the torso bbox-center, in chest-LR-width units. Places
// the heart in the left-anterior, upper-third mediastinum (torso center sits to the
// patient's right, posterior, and inferior of the heart). Tuned against the test.
export const HEART_IN_TORSO = [0.07, 0.12, 0.10];   // [+left, +superior, +anterior]

/** Axis-aligned bounds of a flat xyz position array. */
export function meshBounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const v = positions[i + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return { min, max, center, size };
}

/**
 * World-space torso vertices: recenter on the torso bbox center, uniformly scale,
 * rotate −90° about X (native z-up → scene +y up; native +y → scene −z), then
 * translate so the torso bbox-center lands at `offset`.
 * @returns {Float32Array} transformed positions (same length as input)
 */
export function transformTorso(positions, scale, offset) {
  const { center } = meshBounds(positions);
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = (positions[i] - center[0]) * scale;
    const y = (positions[i + 1] - center[1]) * scale;
    const z = (positions[i + 2] - center[2]) * scale;
    // rotateX(-90°): (x, y, z) -> (x, z, -y)
    out[i] = x + offset[0];
    out[i + 1] = z + offset[1];
    out[i + 2] = -y + offset[2];
  }
  return out;
}

/**
 * Torso placement around a heart centered at the origin.
 * @param {{size:number[]}} heartBounds  heart bounds in the scene frame
 * @param {{size:number[]}} torsoBounds  torso bounds in its native frame
 * @returns {{ scale:number, offset:number[], chestWidth:number }}
 */
export function torsoPlacement(heartBounds, torsoBounds) {
  const heartLR = heartBounds.size[0];
  const torsoLR = torsoBounds.size[0] || 1;       // native x = left–right
  const chestWidth = heartLR / HEART_LR_FRACTION;
  const scale = chestWidth / torsoLR;
  const offset = [
    -HEART_IN_TORSO[0] * chestWidth,              // torso center to patient's right of heart
    -HEART_IN_TORSO[1] * chestWidth,              // …inferior
    -HEART_IN_TORSO[2] * chestWidth,              // …posterior
  ];
  return { scale, offset, chestWidth };
}

const EPS = 1e-7;

/**
 * Möller–Trumbore ray/triangle distances for all triangles a ray crosses.
 * @returns {number[]} positive distances `t` along `dir` (assumed normalized)
 */
export function rayTriHits(orig, dir, positions, index) {
  const hits = [];
  const n = index.length;
  for (let i = 0; i < n; i += 3) {
    const ia = index[i] * 3, ib = index[i + 1] * 3, ic = index[i + 2] * 3;
    const e1x = positions[ib] - positions[ia];
    const e1y = positions[ib + 1] - positions[ia + 1];
    const e1z = positions[ib + 2] - positions[ia + 2];
    const e2x = positions[ic] - positions[ia];
    const e2y = positions[ic + 1] - positions[ia + 1];
    const e2z = positions[ic + 2] - positions[ia + 2];
    // p = dir × e2
    const px = dir[1] * e2z - dir[2] * e2y;
    const py = dir[2] * e2x - dir[0] * e2z;
    const pz = dir[0] * e2y - dir[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -EPS && det < EPS) continue;          // ray parallel to triangle
    const inv = 1 / det;
    const tx = orig[0] - positions[ia];
    const ty = orig[1] - positions[ia + 1];
    const tz = orig[2] - positions[ia + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -EPS || u > 1 + EPS) continue;
    // q = t × e1
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
    if (v < -EPS || u + v > 1 + EPS) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > EPS) hits.push(t);
  }
  return hits;
}

const PROBE_DIRS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1],
];

/**
 * Is `p` inside the closed mesh? Ray-parity (odd crossings = inside), voted over
 * `dirs` so a single grazing/edge hit can't flip the verdict. Defaults to a 5-way
 * vote; pass a single direction for a faster (still reliable on a watertight mesh)
 * bulk check.
 */
export function pointInMesh(p, positions, index, dirs = PROBE_DIRS) {
  let inside = 0;
  for (const d of dirs) {
    if (rayTriHits(p, d, positions, index).length % 2 === 1) inside++;
  }
  return inside > dirs.length / 2;
}

// Standard electrode sites as anatomical directions in the scene frame
// (+x left, +y superior, +z anterior) plus a fractional height along the torso's
// superior axis at which to anchor the outgoing ray. Limb leads sit high (RA/LA) or
// low-left (LL); precordials arc across the left anterior chest at heart level.
const ELECTRODE_SPECS = {
  RA: { dir: [-1.0, 0.35, 0.1], h: 0.62 },
  LA: { dir: [1.0, 0.35, 0.1], h: 0.62 },
  LL: { dir: [0.45, -1.0, 0.1], h: 0.18 },
  V1: { dir: [-0.35, -0.1, 1.0], h: 0.5 },
  V2: { dir: [0.05, -0.15, 1.0], h: 0.48 },
  V3: { dir: [0.4, -0.2, 1.0], h: 0.46 },
  V4: { dir: [0.7, -0.25, 0.85], h: 0.44 },
  V5: { dir: [0.95, -0.25, 0.5], h: 0.45 },
  V6: { dir: [1.05, -0.25, 0.15], h: 0.46 },
};

/**
 * Place electrodes onto the torso surface: from an interior anchor on the torso's
 * vertical axis (at each site's fractional height), cast a ray along the site's
 * anatomical direction and take the outermost surface hit, nudged slightly out.
 * @param {ArrayLike<number>} torsoPositions  world-space torso vertices
 * @param {ArrayLike<number>} index           triangle index
 * @returns {Record<string, number[]>}
 */
export function electrodeSites(torsoPositions, index) {
  const b = meshBounds(torsoPositions);
  const out = {};
  for (const name in ELECTRODE_SPECS) {
    const { dir, h } = ELECTRODE_SPECS[name];
    const anchor = [b.center[0], b.min[1] + h * b.size[1], b.center[2]];
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const d = [dir[0] / len, dir[1] / len, dir[2] / len];
    const hits = rayTriHits(anchor, d, torsoPositions, index);
    const t = hits.length ? Math.max(...hits) * 1.04 : Math.max(...b.size) * 0.6;
    out[name] = [anchor[0] + d[0] * t, anchor[1] + d[1] * t, anchor[2] + d[2] * t];
  }
  return out;
}
