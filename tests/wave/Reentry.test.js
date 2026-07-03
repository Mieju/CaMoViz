// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as THREE from 'three';
import { buildConductionGraph, applyOneWayGate } from '../../src/mesh/ConductionGraph.js';
import { ExcitableMedium } from '../../src/wave/ExcitableMedium.js';
import { loadFromArrayBuffer } from '../../src/mesh/VTKLoader.js';
import { HEART_ANATOMICAL_MATRIX } from '../../src/mesh/TorsoFit.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// Model parameters — must match src/main.js.
const GATE_RADIUS_FRAC = 0.15;
const GATE_SIGN = 1;
const REF_CV_MM_S = 600;
const CV_MM_S = { 1: 600, 2: 600, 3: 800, 4: 800 };
const NONCONDUCTING_TAGS = new Set([5, 6, 7, 8]);

describe('one-way gate', () => {
  it('makes a directed edge conduct one way only', () => {
    // A small square patch in the z=1 plane (so the shell normal n≈+z has a real
    // tangent plane). Gate at a corner, obstacle centre at the patch middle.
    const positions = new Float32Array([1, 0, 1, 0, 1, 1, -1, 0, 1, 0, -1, 1]);
    const geometry = {
      getAttribute: () => ({ array: positions, count: 4 }),
      getIndex: () => ({ array: new Uint32Array([0, 1, 2, 0, 2, 3]) }),
    };
    const graph = buildConductionGraph(geometry);
    const blocked = applyOneWayGate(graph, positions, [1, 0, 1], [0, 0, 1], 5, 1);
    expect(blocked).toBeGreaterThan(0);

    // For at least one undirected pair, exactly one direction conducts.
    const { offsets, neighbors, edgeFactor } = graph;
    const dir = (a, b) => { for (let e = offsets[a]; e < offsets[a + 1]; e++) if (neighbors[e] === b) return edgeFactor[e]; return null; };
    let oneWayPairs = 0;
    for (let a = 0; a < 4; a++) for (let e = offsets[a]; e < offsets[a + 1]; e++) {
      const b = neighbors[e];
      if (a < b && (dir(a, b) === 0) !== (dir(b, a) === 0)) oneWayPairs++;
    }
    expect(oneWayPairs).toBeGreaterThan(0);
  });

  it('induces SUSTAINED anatomical reentry on the SHIPPED heart substrate', async () => {
    // Load and transform exactly as the app does (SceneManager.setMesh): apply the
    // anatomical rotation, recompute normals, recenter on the bounding-box centre.
    const buf = readFileSync(join(ROOT, 'public', 'example_heart_vt.vtu'));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const { geometry, pointData } = await loadFromArrayBuffer(ab, 'vtu');
    const m = HEART_ANATOMICAL_MATRIX;
    geometry.applyMatrix4(new THREE.Matrix4().set(
      m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1));
    geometry.deleteAttribute('normal');
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    const c = new THREE.Vector3();
    geometry.boundingBox.getCenter(c);
    geometry.translate(-c.x, -c.y, -c.z);

    const positions = geometry.getAttribute('position').array;
    const normals = geometry.getAttribute('normal').array;
    const vertexCount = geometry.getAttribute('position').count;
    const meshScale = meshScaleOf(positions, vertexCount);
    // Build the medium exactly as the app's Reentry preset does: absolute conduction
    // velocity (mm/s), non-conducting great vessels, per-region CV × (1 − fibrosis), and
    // NO AV block (the reentry scenario skips it — see main.js rebuildMedium).
    const baseVelocity = REF_CV_MM_S * 1.0;
    const vf = velocityFactor(pointData.region, pointData.fibrosis, vertexCount);

    const gateV = markerVertex(pointData.gate);
    const s1 = markerVertex(pointData.reentry_s1);
    const gateXyz = [positions[3 * gateV], positions[3 * gateV + 1], positions[3 * gateV + 2]];
    const gateNormal = [normals[3 * gateV], normals[3 * gateV + 1], normals[3 * gateV + 2]];
    const center = scarCentroid(positions, vertexCount, pointData.fibrosis);

    // Build the gated substrate exactly as the app's Reentry preset does.
    const graph = buildConductionGraph(geometry, vf);
    const blocked = applyOneWayGate(
      graph, positions, gateXyz, center, meshScale * GATE_RADIUS_FRAC, GATE_SIGN,
      (v) => pointData.fibrosis[v] > 0.3, gateNormal);
    expect(blocked).toBeGreaterThan(50);

    // Step incrementally as the app does each animation frame (one giant step()
    // would hit the engine's per-call event-budget cap on a sustained circuit).
    const sim = new ExcitableMedium({ graph, baseVelocity, refractoryPeriod: 0.45, waveWidth: 0.08 });
    sim.stimulate(s1, 0);
    stepTo(sim, 15);
    // Many laps later the circuit is still re-firing the ventricle each cycle.
    expect(firedAfter(sim, 14)).toBeGreaterThan(2000);

    // Control: the same single beat WITHOUT the gate dies out (two arms annihilate).
    const plain = buildConductionGraph(geometry, vf);
    const sim2 = new ExcitableMedium({ graph: plain, baseVelocity, refractoryPeriod: 0.45, waveWidth: 0.08 });
    sim2.stimulate(s1, 0);
    stepTo(sim2, 15);
    expect(firedAfter(sim2, 14)).toBeLessThan(100);
  });
});

function markerVertex(field) {
  let best = -1, val = 0.5;
  for (let v = 0; v < field.length; v++) if (field[v] > val) { val = field[v]; best = v; }
  return best;
}
function velocityFactor(region, fib, n) {
  const f = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    const tag = region[v] | 0;
    if (NONCONDUCTING_TAGS.has(tag)) { f[v] = 0; continue; }   // great vessels block
    f[v] = ((CV_MM_S[tag] ?? REF_CV_MM_S) / REF_CV_MM_S) * Math.max(0, 1 - fib[v]);
  }
  return f;
}
function scarCentroid(p, n, fib) {
  let sx = 0, sy = 0, sz = 0, c = 0;
  for (let v = 0; v < n; v++) if (fib[v] >= 0.95) { sx += p[3 * v]; sy += p[3 * v + 1]; sz += p[3 * v + 2]; c++; }
  return [sx / c, sy / c, sz / c];
}
function stepTo(sim, tEnd) {
  for (let t = 0.1; t <= tEnd + 1e-6; t += 0.1) sim.step(t);
}
function firedAfter(sim, t) {
  let n = 0;
  for (let v = 0; v < sim.vertexCount; v++) if (sim.lastFired[v] > t) n++;
  return n;
}
function meshScaleOf(pos, n) {
  let a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) { const x = pos[3 * v + k]; if (x < a[k]) a[k] = x; if (x > b[k]) b[k] = x; }
  const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  let r2 = 0;
  for (let v = 0; v < n; v++) { let d = 0; for (let k = 0; k < 3; k++) { const e = pos[3 * v + k] - c[k]; d += e * e; } if (d > r2) r2 = d; }
  return 2 * Math.sqrt(r2);
}
