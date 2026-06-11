import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildConductionGraph } from '../../src/mesh/ConductionGraph.js';

/** Two triangles sharing an edge: a unit square split along the diagonal. */
function quad() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

function neighborsOf(graph, v) {
  const out = [];
  for (let e = graph.offsets[v]; e < graph.offsets[v + 1]; e++) {
    out.push({ n: graph.neighbors[e], len: graph.edgeLen[e], f: graph.edgeFactor[e] });
  }
  return out;
}

describe('buildConductionGraph', () => {
  it('stores Euclidean edge lengths', () => {
    const g = buildConductionGraph(quad());
    expect(g.vertexCount).toBe(4);
    const e01 = neighborsOf(g, 0).find((e) => e.n === 1);
    expect(e01.len).toBeCloseTo(1, 6);          // adjacent corners
    const e02 = neighborsOf(g, 0).find((e) => e.n === 2);
    expect(e02.len).toBeCloseTo(Math.SQRT2, 6); // diagonal
  });

  it('defaults all conduction factors to 1', () => {
    const g = buildConductionGraph(quad());
    expect(Array.from(g.edgeFactor).every((f) => f === 1)).toBe(true);
  });

  it('derives the edge factor from the slower (min) endpoint', () => {
    // Vertex 2 is fully fibrotic (factor 0) → every edge touching it blocks.
    const vf = Float32Array.from([1, 1, 0, 1]);
    const g = buildConductionGraph(quad(), vf);
    for (let v = 0; v < 4; v++) {
      for (const e of neighborsOf(g, v)) {
        const expected = v === 2 || e.n === 2 ? 0 : 1;
        expect(e.f).toBe(expected);
      }
    }
  });
});
