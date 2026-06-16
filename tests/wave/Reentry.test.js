import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildConductionGraph, applyOneWayGate } from '../../src/mesh/ConductionGraph.js';
import { ExcitableMedium } from '../../src/wave/ExcitableMedium.js';
import { parseVtuAscii, velocityFactorFromFibrosis, markerVertex } from '../helpers/parseVtuAscii.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

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

  it('induces SUSTAINED anatomical reentry on the example mesh from a single beat', () => {
    const { positions, vertexCount, pointData, geometry } =
      parseVtuAscii(readFileSync(join(ROOT, 'tests', 'fixtures', 'example_substrate.vtu'), 'utf8'));
    const meshScale = meshScaleOf(positions, vertexCount);
    const baseVelocity = (meshScale / 1.2) * 1.0;
    const vf = velocityFactorFromFibrosis(pointData.fibrosis, vertexCount);

    // Build the gated substrate exactly as the app's Reentry preset does.
    const graph = buildConductionGraph(geometry, vf);
    const gateV = markerVertex(pointData.gate);
    const gateXyz = [positions[3 * gateV], positions[3 * gateV + 1], positions[3 * gateV + 2]];
    const center = scarCentroid(positions, vertexCount, pointData.fibrosis);
    const blocked = applyOneWayGate(graph, positions, gateXyz, center, meshScale * 0.15, 1, (v) => pointData.fibrosis[v] > 0.3);
    expect(blocked).toBeGreaterThan(10);

    const m = new ExcitableMedium({ graph, baseVelocity, refractoryPeriod: 0.45, waveWidth: 0.08 });
    const s1 = markerVertex(pointData.reentry_s1);
    m.stimulate(s1, 0);

    // A single beat WITH the gate must still be circulating many laps later.
    m.step(20);
    expect(m.isActive).toBe(true);

    // Control: without the gate, the same single beat dies out.
    const plain = buildConductionGraph(geometry, vf);
    const m2 = new ExcitableMedium({ graph: plain, baseVelocity, refractoryPeriod: 0.45, waveWidth: 0.08 });
    m2.stimulate(s1, 0);
    m2.step(20);
    expect(m2.isActive).toBe(false);
  });
});

function scarCentroid(p, n, fib) {
  let sx = 0, sy = 0, sz = 0, c = 0;
  for (let v = 0; v < n; v++) if (fib[v] >= 0.95) { sx += p[3 * v]; sy += p[3 * v + 1]; sz += p[3 * v + 2]; c++; }
  return [sx / c, sy / c, sz / c];
}
function meshScaleOf(pos, n) {
  let a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) { const x = pos[3 * v + k]; if (x < a[k]) a[k] = x; if (x > b[k]) b[k] = x; }
  const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  let r2 = 0;
  for (let v = 0; v < n; v++) { let d = 0; for (let k = 0; k < 3; k++) { const e = pos[3 * v + k] - c[k]; d += e * e; } if (d > r2) r2 = d; }
  return 2 * Math.sqrt(r2);
}
