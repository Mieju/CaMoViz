/**
 * Minimal ASCII-VTU reader for Node tests/scripts — no DOM required (the app's
 * VTKLoader uses DOMParser, which isn't available in the `node` test env).
 *
 * Reads an all-triangle UnstructuredGrid written by meshio (`binary=False`):
 * extracts point coordinates, triangle connectivity, and named point-data
 * arrays. Returns positions/index in the same layout buildConductionGraph wants,
 * plus a faux geometry object so the real ConductionGraph/ExcitableMedium code
 * can run unchanged.
 *
 * @param {string} text  full .vtu file contents
 */
export function parseVtuAscii(text) {
  const nums = (name) => {
    const m = text.match(
      new RegExp(`<DataArray[^>]*Name="${name}"[^>]*>([\\s\\S]*?)</DataArray>`)
    );
    if (!m) return null;
    return m[1].trim().split(/\s+/).map(Number);
  };

  const positions = Float32Array.from(nums('Points'));
  const connectivity = nums('connectivity');
  const index = Uint32Array.from(connectivity); // all-triangle → flat tri indices
  const vertexCount = positions.length / 3;

  const pointData = {};
  for (const name of ['apex_base', 'fibrosis', 'pace_site', 'reentry_s1', 'gate']) {
    const arr = nums(name);
    if (arr) pointData[name] = Float32Array.from(arr);
  }

  // Just enough of the THREE.BufferGeometry surface for buildConductionGraph.
  const geometry = {
    getAttribute: (n) => (n === 'position' ? { array: positions, count: vertexCount } : null),
    getIndex: () => ({ array: index }),
  };

  return { geometry, positions, index, vertexCount, pointData };
}

/** Per-vertex conduction factor from a fibrosis field — mirrors main.js. */
export function velocityFactorFromFibrosis(fibrosis, vertexCount) {
  const f = new Float32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) f[v] = Math.max(0, Math.min(1, 1 - fibrosis[v]));
  return f;
}

/** Index of the single vertex flagged in a one-hot marker field. */
export function markerVertex(field) {
  let best = 0, bestVal = -Infinity;
  for (let v = 0; v < field.length; v++) if (field[v] > bestVal) { bestVal = field[v]; best = v; }
  return best;
}
