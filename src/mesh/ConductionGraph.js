/**
 * Builds a CSR adjacency graph for the excitable-medium simulation: for every
 * surface edge it stores the Euclidean length and a conduction factor in (0, 1]
 * derived from a per-vertex velocity field (e.g. fibrosis). A factor of 0 means
 * the edge does not conduct (block).
 *
 * An optional per-edge additive `edgeDelay` (seconds, default 0) lets a specific
 * connection impose a fixed conduction delay on top of its length/speed transit
 * time — used to model the AV node, whose slow decremental conduction is the
 * source of the PR interval (see {@link applyAVBlock}).
 *
 * @param {THREE.BufferGeometry} geometry          indexed geometry (position + index)
 * @param {Float32Array} [velocityFactor]          per-vertex conduction factor (default all 1)
 * @returns {{ offsets: Uint32Array, neighbors: Uint32Array, edgeLen: Float32Array,
 *             edgeFactor: Float32Array, edgeDelay: Float32Array, vertexCount: number }}
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
  const edgeDelay = new Float32Array(edgeCount);   // extra fixed delay (s); 0 for plain tissue
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

  return { offsets, neighbors, edgeLen, edgeFactor, edgeDelay, vertexCount };
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
 * `n` is the surface normal at the gate and `radial` points from the obstacle
 * centre to the gate, in the tangent plane. Pass the true vertex normal via
 * `normal`; if omitted it falls back to the gate position direction (only valid
 * on a shell centred at the origin). A wave entering the loop then dies one way at
 * the gate and circulates the other way → a sustained reentrant circuit. Mutates
 * the graph.
 *
 * @param {object} graph        from {@link buildConductionGraph}
 * @param {ArrayLike<number>} positions  xyz per vertex (3 each)
 * @param {number[]} gateXyz    gate centre [x,y,z]
 * @param {number[]} scarCenter obstacle centre [x,y,z] (the loop's inner hub)
 * @param {number} radius       gate disc radius (mesh units)
 * @param {number} sign         +1 / −1 circulation sense to permit
 * @param {(v:number)=>boolean} [gateMask]  restrict the gate to these vertices
 * @param {number[]} [normal]   surface normal at the gate (defaults to gateXyz dir)
 * @returns {number} count of directed edges blocked
 */
export function applyOneWayGate(graph, positions, gateXyz, scarCenter, radius, sign, gateMask, normal) {
  const { offsets, neighbors, edgeFactor } = graph;
  const gx = gateXyz[0], gy = gateXyz[1], gz = gateXyz[2];
  const nv = normal || gateXyz;
  const nl = Math.hypot(nv[0], nv[1], nv[2]) || 1;
  const n = [nv[0] / nl, nv[1] / nl, nv[2] / nl];
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

/**
 * Model the **fibrous atrio-ventricular annulus**: the cardiac skeleton that
 * electrically insulates the atria from the ventricles. Real myocardium only
 * conducts atrium→ventricle through the **AV node → His bundle**, a single tiny
 * bridge that adds the ~120–200 ms PR-interval delay; everywhere else the AV
 * groove is a hard block. Without this, a surface wave floods straight across the
 * groove at full speed (no P-then-QRS separation) — the "wave runs over it wrong".
 *
 * The chamber tags only cover myocardium, so cutting just the direct atrium↔
 * ventricle edges leaves the two connected through the valves/great-vessel tags
 * that touch both — the wave leaks around the block. Instead the whole surface is
 * partitioned into an **atrial side** and a **ventricular side** (each non-chamber
 * vertex joins whichever chamber set it is fewer hops from), and *every* edge
 * across that watershed is blocked — a complete electrical separation. The one
 * exception is a compact cluster of edges around the AV node, which keep
 * conducting but carry a fixed `avDelay` (see {@link buildConductionGraph}'s
 * `edgeDelay`). The node is snapped to a real atrium↔ventricle contact nearest the
 * centroid of all such contacts — the medial/septal base where the AV node sits.
 *
 * The node conducts **antegrade only** (atria → ventricles): the reverse direction
 * of every node edge is blocked. So a ventricular stimulus stays in the ventricles
 * — it cannot climb back into the atria — while an atrial wave still crosses to the
 * ventricles after the delay. Mutates the graph.
 *
 * **His–Purkinje breakthrough (`breakthroughs` given):** the AV node sits at the
 * base, but the ventricles physiologically break through first at the septal-apical
 * endocardium (the bundle-branch terminals), depolarising apex→base. So instead of a
 * local basal bridge, block *every* watershed crossing (complete annulus) and install
 * directed conduction paths (`graph.conductionPaths`) from the AV node's atrial vertex
 * to each ventricular breakthrough, each carrying `avDelay`. The engine
 * ({@link import('../wave/ExcitableMedium.js').ExcitableMedium}) fires those distant
 * sites when the node activates — one-way, so no retrograde conduction.
 *
 * @param {object} graph        from {@link buildConductionGraph} (needs edgeDelay)
 * @param {ArrayLike<number>} positions  xyz per vertex (3 each)
 * @param {(v:number)=>boolean} isAtrial      vertex belongs to an atrium
 * @param {(v:number)=>boolean} isVentricular vertex belongs to a ventricle
 * @param {number} avDelay      AV-node → ventricle conduction delay (seconds)
 * @param {number} nodeRadius   radius of the conducting AV-node patch (mesh units)
 * @param {number[]} [breakthroughs]  ventricular vertices to deliver the impulse to via
 *   the His bundle; when given, replaces the basal bridge with `graph.conductionPaths`
 * @returns {{ blocked: number, bridged: number, nodeXyz: number[]|null }}
 */
export function applyAVBlock(graph, positions, isAtrial, isVentricular, avDelay, nodeRadius, breakthroughs) {
  const { offsets, neighbors, edgeFactor, edgeDelay, vertexCount } = graph;
  const px = (v) => positions[3 * v], py = (v) => positions[3 * v + 1], pz = (v) => positions[3 * v + 2];

  // Partition the whole surface: multi-source BFS from all atrial (side 0) and all
  // ventricular (side 1) vertices; every other vertex joins its nearest side. This
  // turns the chamber tags into a full two-way split so the interface is a complete
  // cut (no leak through the valve/vessel tags that bridge atria and ventricles).
  const ATRIAL = 0, VENTRICULAR = 1, UNSET = -1;
  const side = new Int8Array(vertexCount).fill(UNSET);
  let head = 0;
  const wave = [];
  for (let v = 0; v < vertexCount; v++) {
    if (isAtrial(v)) { side[v] = ATRIAL; wave.push(v); }
    else if (isVentricular(v)) { side[v] = VENTRICULAR; wave.push(v); }
  }
  while (head < wave.length) {
    const v = wave[head++];
    for (let e = offsets[v]; e < offsets[v + 1]; e++) {
      const b = neighbors[e];
      if (side[b] === UNSET) { side[b] = side[v]; wave.push(b); }
    }
  }

  // Collect every edge across the watershed (both sides set and differing), with
  // its midpoint. Flag the direct atrium↔ventricle contacts as AV-node candidates.
  const cross = [];               // { e, a, b, mx, my, mz, contact, antegrade }
  let sx = 0, sy = 0, sz = 0, nContacts = 0;
  for (let a = 0; a < vertexCount; a++) {
    if (side[a] === UNSET) continue;
    for (let e = offsets[a]; e < offsets[a + 1]; e++) {
      const b = neighbors[e];
      if (side[b] === UNSET || side[b] === side[a]) continue;
      const mx = (px(a) + px(b)) / 2, my = (py(a) + py(b)) / 2, mz = (pz(a) + pz(b)) / 2;
      const contact = (isAtrial(a) && isVentricular(b)) || (isVentricular(a) && isAtrial(b));
      const antegrade = side[a] === ATRIAL; // directed a→b: atria → ventricles
      cross.push({ e, a, b, mx, my, mz, contact, antegrade });
      if (contact) { sx += mx; sy += my; sz += mz; nContacts++; }
    }
  }
  if (!cross.length) return { blocked: 0, bridged: 0, nodeXyz: null };

  // AV-node site = the direct chamber-to-chamber contact nearest the centroid of
  // all such contacts (medial/septal base). Snapping to a real contact keeps the
  // node on the AV ring rather than out on the vessel watershed.
  const cx = nContacts ? sx / nContacts : 0, cy = nContacts ? sy / nContacts : 0, cz = nContacts ? sz / nContacts : 0;
  let node = null, nodeD2 = Infinity;
  for (const c of cross) {
    if (nContacts && !c.contact) continue;
    const d2 = (c.mx - cx) ** 2 + (c.my - cy) ** 2 + (c.mz - cz) ** 2;
    if (d2 < nodeD2) { nodeD2 = d2; node = c; }
  }

  // His–Purkinje mode: seal the whole annulus and deliver the impulse from the AV
  // node's atrial vertex to each ventricular breakthrough via a directed path, so the
  // ventricles start at the septal-apical endocardium (apex→base), not at the base.
  if (breakthroughs && breakthroughs.length) {
    let blocked = 0;
    for (const c of cross) { edgeFactor[c.e] = 0; blocked++; }
    const hisSource = side[node.a] === ATRIAL ? node.a : node.b;
    graph.conductionPaths = breakthroughs.map((to) => ({ from: hisSource, to, delay: avDelay }));
    return { blocked, bridged: graph.conductionPaths.length, nodeXyz: [node.mx, node.my, node.mz] };
  }

  const r2 = nodeRadius * nodeRadius;
  let blocked = 0, bridged = 0;
  for (const c of cross) {
    const d2 = (c.mx - node.mx) ** 2 + (c.my - node.my) ** 2 + (c.mz - node.mz) ** 2;
    if (d2 <= r2 && c.antegrade) {        // AV node, forward → conduct, but delayed
      edgeDelay[c.e] += avDelay; bridged++;
    } else {                              // annulus, or the node's retrograde direction → block
      edgeFactor[c.e] = 0; blocked++;
    }
  }
  return { blocked, bridged, nodeXyz: [node.mx, node.my, node.mz] };
}
