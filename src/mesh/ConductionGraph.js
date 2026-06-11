/**
 * Builds a CSR adjacency graph for the excitable-medium simulation: for every
 * surface edge it stores the Euclidean length and a conduction factor in (0, 1]
 * derived from a per-vertex velocity field (e.g. fibrosis). A factor of 0 means
 * the edge does not conduct (block).
 *
 * @param {THREE.BufferGeometry} geometry          indexed geometry (position + index)
 * @param {Float32Array} [velocityFactor]          per-vertex conduction factor (default all 1)
 * @returns {{ offsets: Uint32Array, neighbors: Uint32Array, edgeLen: Float32Array,
 *             edgeFactor: Float32Array, vertexCount: number }}
 */
export function buildConductionGraph(geometry, velocityFactor) {
  const positions = geometry.getAttribute('position').array;
  const vertexCount = geometry.getAttribute('position').count;
  const index = geometry.getIndex();
  if (!index) throw new Error('buildConductionGraph requires indexed geometry');
  const idx = index.array;
  const vf = velocityFactor || null;

  // Degree (each vertex touches the other two of every incident triangle).
  const degree = new Uint32Array(vertexCount);
  for (let i = 0; i < idx.length; i += 3) {
    degree[idx[i]] += 2; degree[idx[i + 1]] += 2; degree[idx[i + 2]] += 2;
  }
  const offsets = new Uint32Array(vertexCount + 1);
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] = offsets[v] + degree[v];

  const edgeCount = offsets[vertexCount];
  const neighbors = new Uint32Array(edgeCount);
  const edgeLen = new Float32Array(edgeCount);
  const edgeFactor = new Float32Array(edgeCount);
  const cursor = offsets.slice(0, vertexCount);

  const addEdge = (a, b) => {
    const len = distance(positions, a, b);
    // A fibrotic endpoint blocks the edge: take the slower (min) of the two.
    const factor = vf ? Math.min(vf[a], vf[b]) : 1;
    const ia = cursor[a]++; neighbors[ia] = b; edgeLen[ia] = len; edgeFactor[ia] = factor;
    const ib = cursor[b]++; neighbors[ib] = a; edgeLen[ib] = len; edgeFactor[ib] = factor;
  };
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    addEdge(a, b); addEdge(b, c); addEdge(c, a);
  }

  return { offsets, neighbors, edgeLen, edgeFactor, vertexCount };
}

function distance(p, a, b) {
  const dx = p[3 * a] - p[3 * b];
  const dy = p[3 * a + 1] - p[3 * b + 1];
  const dz = p[3 * a + 2] - p[3 * b + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Make a small patch of the graph conduct in one direction only — a model of
 * **unidirectional block**, the prerequisite for anatomical reentry. Within
 * `radius` of `gateXyz` (and only on tissue whose `gateMask` is set, e.g. the
 * surviving scar channel), every *directed* edge that points "backwards" against
 * the local circulation tangent is blocked (factor 0); forward edges are kept.
 *
 * The tangent is the loop direction at the gate: `sign · (n × radial)`, where
 * `n` is the surface normal (≈ the gate position on a shell centred at the
 * origin) and `radial` points from the obstacle centre to the gate, in the
 * tangent plane. A wave entering the loop then dies one way at the gate and
 * circulates the other way → a sustained reentrant circuit. Mutates the graph.
 *
 * @param {object} graph        from {@link buildConductionGraph}
 * @param {ArrayLike<number>} positions  xyz per vertex (3 each)
 * @param {number[]} gateXyz    gate centre [x,y,z]
 * @param {number[]} scarCenter obstacle centre [x,y,z] (the loop's inner hub)
 * @param {number} radius       gate disc radius (mesh units)
 * @param {number} sign         +1 / −1 circulation sense to permit
 * @param {(v:number)=>boolean} [gateMask]  restrict the gate to these vertices
 * @returns {number} count of directed edges blocked
 */
export function applyOneWayGate(graph, positions, gateXyz, scarCenter, radius, sign, gateMask) {
  const { offsets, neighbors, edgeFactor } = graph;
  const gx = gateXyz[0], gy = gateXyz[1], gz = gateXyz[2];
  const nl = Math.hypot(gx, gy, gz) || 1;
  const n = [gx / nl, gy / nl, gz / nl];
  let rx = gx - scarCenter[0], ry = gy - scarCenter[1], rz = gz - scarCenter[2];
  const rn = rx * n[0] + ry * n[1] + rz * n[2];           // remove normal component
  rx -= rn * n[0]; ry -= rn * n[1]; rz -= rn * n[2];
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  // tangent = sign · (n × radial)
  let tx = n[1] * rz - n[2] * ry, ty = n[2] * rx - n[0] * rz, tz = n[0] * ry - n[1] * rx;
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx = sign * tx / tl; ty = sign * ty / tl; tz = sign * tz / tl;

  const r2 = radius * radius;
  let blocked = 0;
  for (let a = 0; a < graph.vertexCount; a++) {
    if (gateMask && !gateMask(a)) continue;
    const ax = positions[3 * a], ay = positions[3 * a + 1], az = positions[3 * a + 2];
    const dx = ax - gx, dy = ay - gy, dz = az - gz;
    if (dx * dx + dy * dy + dz * dz > r2) continue;
    for (let e = offsets[a]; e < offsets[a + 1]; e++) {
      const b = neighbors[e];
      const ex = positions[3 * b] - ax, ey = positions[3 * b + 1] - ay, ez = positions[3 * b + 2] - az;
      if (ex * tx + ey * ty + ez * tz < -1e-6) {           // retrograde → block
        if (edgeFactor[e] > 0) blocked++;
        edgeFactor[e] = 0;
      }
    }
  }
  return blocked;
}
