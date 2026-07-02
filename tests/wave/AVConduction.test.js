// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as THREE from 'three';
import { buildConductionGraph, applyAVBlock } from '../../src/mesh/ConductionGraph.js';
import { ExcitableMedium } from '../../src/wave/ExcitableMedium.js';
import { loadFromArrayBuffer } from '../../src/mesh/VTKLoader.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// AV-model parameters — must match src/main.js.
const VENTRICLE_TAGS = new Set([1, 2]);
const ATRIA_TAGS = new Set([3, 4]);
const AV_DELAY = 0.30;
const AV_NODE_RADIUS_FRAC = 0.03;

/** Reachable set from `seed` over conducting edges (factor > 0), ignoring refractory. */
function reachable(graph, seed) {
  const { offsets, neighbors, edgeFactor, vertexCount } = graph;
  const seen = new Uint8Array(vertexCount); const st = [seed]; seen[seed] = 1;
  while (st.length) {
    const v = st.pop();
    for (let e = offsets[v]; e < offsets[v + 1]; e++) {
      if (edgeFactor[e] <= 0) continue;
      const b = neighbors[e];
      if (!seen[b]) { seen[b] = 1; st.push(b); }
    }
  }
  return seen;
}

describe('AV block (fibrous annulus + AV node)', () => {
  it('insulates the two sides except through the delayed node, even past a neutral bridge', () => {
    // Atrial strip A0—A1 (tag 3) and ventricular strip V0—V1 (tag 1), joined both
    // directly (A0—V0, the AV contact) and via a NEUTRAL vertex N (tag 5) that
    // touches both sides (a valve/vessel bridge). Insulation must survive the
    // neutral detour: with the node removed, no atrium→ventricle path may remain.
    const positions = new Float32Array([
      0, 1, 0,   1, 1, 0,       // A0 A1
      0, 0, 0,   1, 0, 0,       // V0 V1
      2, 0.5, 0,                // N (bridges A1 and V1)
    ]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setIndex([0, 1, 2, 1, 3, 2, 1, 3, 4]); // A0A1V0, A1V1V0, A1V1N
    const graph = buildConductionGraph(g);
    const region = [3, 3, 1, 1, 5];
    const isA = (v) => ATRIA_TAGS.has(region[v]);
    const isV = (v) => VENTRICLE_TAGS.has(region[v]);

    // Node radius large enough to keep the direct A0—V0 contact conducting.
    const res = applyAVBlock(graph, positions, isA, isV, AV_DELAY, 0.6);
    expect(res.bridged).toBeGreaterThan(0);
    expect(res.blocked).toBeGreaterThan(0);

    // Antegrade: atria → ventricles conducts.
    expect(reachable(graph, 0)[2]).toBe(1); // A0 reaches V0
    // One-way: a ventricular stimulus must NOT climb back into the atria.
    const fromV = reachable(graph, 2);      // seed V0
    for (let v = 0; v < graph.vertexCount; v++) if (isA(v)) expect(fromV[v]).toBe(0);

    // Remove the node bridge → atria and ventricles fully disconnected (incl. via N).
    const { offsets, neighbors, edgeFactor, edgeDelay } = graph;
    for (let v = 0; v < graph.vertexCount; v++)
      for (let e = offsets[v]; e < offsets[v + 1]; e++) if (edgeDelay[e] > 0) edgeFactor[e] = 0;
    const seen = reachable(graph, 0);
    for (let v = 0; v < graph.vertexCount; v++) if (isV(v)) expect(seen[v]).toBe(0);
  });

  it('separates atria and ventricles on the SHIPPED heart, with a PR-interval delay', async () => {
    const buf = readFileSync(join(ROOT, 'public', 'example_heart.vtu'));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const { geometry, pointData } = await loadFromArrayBuffer(ab, 'vtu');
    geometry.computeBoundingSphere();
    const meshScale = geometry.boundingSphere.radius * 2;
    const region = pointData.region;
    const isA = (v) => ATRIA_TAGS.has(region[v] | 0);
    const isV = (v) => VENTRICLE_TAGS.has(region[v] | 0);
    const positions = geometry.getAttribute('position').array;

    const graph = buildConductionGraph(geometry);
    const res = applyAVBlock(graph, positions, isA, isV, AV_DELAY, meshScale * AV_NODE_RADIUS_FRAC);
    expect(res.blocked).toBeGreaterThan(50);
    expect(res.bridged).toBeGreaterThan(0);

    // Pace an atrial vertex; the ventricles must depolarize only AFTER the wave has
    // reached the AV node and paid the delay — never before AV_DELAY (P → PR → QRS).
    let seed = -1; for (let v = 0; v < graph.vertexCount; v++) if (isA(v)) { seed = v; break; }
    const sim = new ExcitableMedium({ graph, baseVelocity: meshScale / 1.2, refractoryPeriod: 0.5, waveWidth: 0.08 });
    sim.stimulate(seed, 0);
    sim.step(3);
    let firstV = Infinity, ventFired = 0;
    for (let v = 0; v < graph.vertexCount; v++) {
      const t = sim.lastFired[v];
      if (isV(v) && isFinite(t)) { firstV = Math.min(firstV, t); ventFired++; }
    }
    expect(firstV).toBeGreaterThan(AV_DELAY); // no atrium→ventricle short-circuit
    expect(ventFired).toBeGreaterThan(1000);  // the ventricles do activate via the node

    // One-way node: a VENTRICULAR stimulus stays in the ventricles (no retrograde
    // VA conduction), so no atrial vertex ever fires.
    let vSeed = -1; for (let v = 0; v < graph.vertexCount; v++) if (isV(v)) { vSeed = v; break; }
    const simV = new ExcitableMedium({ graph, baseVelocity: meshScale / 1.2, refractoryPeriod: 0.5, waveWidth: 0.08 });
    simV.stimulate(vSeed, 0);
    simV.step(3);
    let atriaFired = 0;
    for (let v = 0; v < graph.vertexCount; v++) if (isA(v) && isFinite(simV.lastFired[v])) atriaFired++;
    expect(atriaFired).toBe(0);

    // With the node bridge removed there is NO conducting path atria → ventricles.
    const { offsets, neighbors, edgeFactor, edgeDelay } = graph;
    for (let v = 0; v < graph.vertexCount; v++)
      for (let e = offsets[v]; e < offsets[v + 1]; e++) if (edgeDelay[e] > 0) edgeFactor[e] = 0;
    const seen = reachable(graph, seed);
    let leak = 0;
    for (let v = 0; v < graph.vertexCount; v++) if (isV(v) && seen[v]) leak++;
    expect(leak).toBe(0);
  });
});
