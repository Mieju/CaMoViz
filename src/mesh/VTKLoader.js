import * as THREE from 'three';

/**
 * Parses a VTK XML mesh file (ArrayBuffer) into a Three.js BufferGeometry.
 *
 * Self-contained parser — covers the formats the viewer actually receives:
 *   - `.vtu` UnstructuredGrid (surface *or* volume meshes) and `.vtp` PolyData
 *   - data arrays in `ascii` or inline `binary` (base64), `header_type`
 *     UInt32/UInt64, optionally zlib-compressed (`vtkZLibDataCompressor`)
 *
 * Surface cells (triangle/quad/polygon) are fan-triangulated directly. Volume
 * meshes (tetra/hex/wedge/pyramid/voxel) are reduced to their boundary surface
 * — the faces owned by exactly one cell — so raw simulation `.vtu` files render
 * without pre-extraction.
 *
 * Not supported: appended/raw-binary VTK (re-export as inline binary or ASCII —
 * ParaView "Data Mode → Binary"; meshio `binary=True`).
 *
 * @param {ArrayBuffer} buffer  raw file bytes
 * @param {string} ext          'vtu' | 'vtp' | 'vtk' (advisory; type is read from the file)
 * @returns {Promise<{ geometry: THREE.BufferGeometry, pointData: Record<string, Float32Array> }>}
 */
export async function loadFromArrayBuffer(buffer, ext) {
  const text = new TextDecoder().decode(buffer);
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('File is not valid VTK XML (legacy/binary-appended not supported)');
  }

  const vtkFile = doc.getElementsByTagName('VTKFile')[0];
  if (!vtkFile) throw new Error('Missing <VTKFile> root element');

  const ctx = {
    compressed: !!vtkFile.getAttribute('compressor'),
    headerType: vtkFile.getAttribute('header_type') || 'UInt32',
  };
  const type = vtkFile.getAttribute('type');

  const piece = doc.getElementsByTagName('Piece')[0];
  if (!piece) throw new Error('Missing <Piece> element');

  const positions = await readPoints(piece, ctx);                  // Float32Array
  const { indices, flatShaded } = type === 'PolyData'
    ? await readPolys(piece, ctx)
    : await readCells(piece, ctx, positions);

  if (!positions.length) throw new Error('Mesh has no points');
  if (!indices.length) throw new Error('Mesh has no renderable surface cells');

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  // Volume boundaries are faceted (flat faces) — flat-shade them so faces stay
  // crisp; smooth surface meshes keep their interpolated normals.
  return { geometry, flatShaded, pointData: await readPointData(piece, ctx) };
}

// --- section readers --------------------------------------------------------

async function readPoints(piece, ctx) {
  const pointsEl = piece.getElementsByTagName('Points')[0];
  const da = pointsEl?.getElementsByTagName('DataArray')[0];
  if (!da) throw new Error('Missing <Points> data array');
  const arr = await parseDataArray(da, ctx);
  return arr instanceof Float32Array ? arr : Float32Array.from(arr);
}

/** PolyData: triangulate <Polys> (connectivity + offsets). */
async function readPolys(piece, ctx) {
  const polys = piece.getElementsByTagName('Polys')[0];
  if (!polys) return { indices: new Uint32Array(0), flatShaded: false };
  const conn = await namedArray(polys, 'connectivity', ctx);
  const offsets = await namedArray(polys, 'offsets', ctx);
  return { indices: triangulateDirect(conn, offsets), flatShaded: false };
}

/** UnstructuredGrid: surface cells pass through; volume cells → boundary surface. */
async function readCells(piece, ctx, positions) {
  const cells = piece.getElementsByTagName('Cells')[0];
  if (!cells) return new Uint32Array(0);
  const conn = await namedArray(cells, 'connectivity', ctx);
  const offsets = await namedArray(cells, 'offsets', ctx);
  const types = await namedArray(cells, 'types', ctx);

  let hasVolume = false;
  for (let i = 0; i < types.length; i++) if (FACES[types[i]]) { hasVolume = true; break; }
  return hasVolume
    ? { indices: extractBoundary(conn, offsets, types, positions), flatShaded: true }
    : { indices: triangulateDirect(conn, offsets), flatShaded: false };
}

async function readPointData(piece, ctx) {
  const result = {};
  const pd = piece.getElementsByTagName('PointData')[0];
  if (!pd) return result;
  for (const da of pd.getElementsByTagName('DataArray')) {
    const name = da.getAttribute('Name');
    if (name) {
      const arr = await parseDataArray(da, ctx);
      result[name] = arr instanceof Float32Array ? arr : Float32Array.from(arr);
    }
  }
  return result;
}

// --- surface construction ---------------------------------------------------

/** Fan-triangulate every cell (used when all cells are already surface polygons). */
function triangulateDirect(conn, offsets) {
  const out = [];
  let start = 0;
  for (let c = 0; c < offsets.length; c++) {
    const end = offsets[c];
    const base = conn[start];
    for (let k = 1; k < end - start - 1; k++) {
      out.push(base, conn[start + k], conn[start + k + 1]);
    }
    start = end;
  }
  return Uint32Array.from(out);
}

// Local face definitions (point indices into a cell) for VTK volume cell types.
// Winding is irrelevant — the material is double-sided and normals are recomputed.
const FACES = {
  10: [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 2, 3]],                       // tetra
  11: [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]], // voxel
  12: [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]], // hexahedron
  13: [[0, 1, 2], [3, 4, 5], [0, 1, 4, 3], [1, 2, 5, 4], [2, 0, 3, 5]],   // wedge
  14: [[0, 1, 2, 3], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]],         // pyramid
};

/**
 * Reduce a volume mesh to its boundary surface: every cell face is hashed by its
 * sorted vertex ids; faces seen exactly once are on the surface. Each boundary
 * face is then oriented outward (normal pointing away from its parent cell's
 * centroid) so the recomputed vertex normals are consistent — without this,
 * mixed winding makes shared-vertex normals cancel and the surface goes black.
 */
function extractBoundary(conn, offsets, types, positions) {
  const count = new Map();   // faceKey -> times seen
  const info = new Map();    // faceKey -> { f, s, e } (parent cell span; kept while unique)

  let start = 0;
  for (let c = 0; c < offsets.length; c++) {
    const end = offsets[c];
    const faceDefs = FACES[types[c]];
    const faces = faceDefs
      ? faceDefs.map((def) => def.map((li) => conn[start + li]))
      : [Array.from(conn.subarray(start, end))]; // already a surface polygon

    for (const f of faces) {
      const key = faceKey(f);
      const seen = (count.get(key) || 0) + 1;
      count.set(key, seen);
      if (seen === 1) info.set(key, { f, s: start, e: end, vol: !!faceDefs });
      else info.delete(key);
    }
    start = end;
  }

  const out = [];
  for (const [key, n] of count) {
    if (n !== 1) continue;
    const { f, s, e, vol } = info.get(key);
    if (vol) orientOutward(f, s, e, conn, positions);
    for (let k = 1; k < f.length - 1; k++) out.push(f[0], f[k], f[k + 1]); // fan
  }
  return Uint32Array.from(out);
}

const faceKey = (ids) => ids.slice().sort((a, b) => a - b).join(',');

/** Reverse a face's winding if its normal points toward the parent cell centroid. */
function orientOutward(f, s, e, conn, pos) {
  // Parent cell centroid.
  let cx = 0, cy = 0, cz = 0;
  for (let i = s; i < e; i++) { const p = conn[i] * 3; cx += pos[p]; cy += pos[p + 1]; cz += pos[p + 2]; }
  const np = e - s; cx /= np; cy /= np; cz /= np;

  // Face normal (first three vertices) and face centroid.
  const a = f[0] * 3, b = f[1] * 3, d = f[2] * 3;
  const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
  const vx = pos[d] - pos[a], vy = pos[d + 1] - pos[a + 1], vz = pos[d + 2] - pos[a + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  let fx = 0, fy = 0, fz = 0;
  for (const id of f) { const p = id * 3; fx += pos[p]; fy += pos[p + 1]; fz += pos[p + 2]; }
  fx /= f.length; fy /= f.length; fz /= f.length;

  if (nx * (fx - cx) + ny * (fy - cy) + nz * (fz - cz) < 0) f.reverse();
}

// --- data array parsing -----------------------------------------------------

async function namedArray(parent, name, ctx) {
  for (const da of parent.getElementsByTagName('DataArray')) {
    if (da.getAttribute('Name') === name) return parseDataArray(da, ctx);
  }
  throw new Error(`Missing <DataArray Name="${name}">`);
}

/** Parse one <DataArray> into a TypedArray regardless of ascii/binary encoding. */
async function parseDataArray(el, ctx) {
  const format = (el.getAttribute('format') || 'ascii').toLowerCase();
  const type = el.getAttribute('type') || 'Float32';
  let text = el.textContent.trim();

  if (format === 'ascii') {
    if (!text) return new Float32Array(0);
    return Float32Array.from(text.split(/\s+/), Number);
  }
  if (format === 'binary') {
    if (/\s/.test(text)) text = text.replace(/\s+/g, '');
    const bytes = decodeBase64(text);                 // header + payload, contiguous
    const dataBuf = ctx.compressed
      ? await readCompressed(bytes, ctx.headerType)
      : slicePayload(bytes, ctx.headerType);
    return typedView(dataBuf, type);
  }
  throw new Error(`Unsupported DataArray format "${format}"`);
}

/** Uncompressed: a single header word (payload byte count) precedes the payload. */
function slicePayload(bytes, headerType) {
  const headerBytes = headerType === 'UInt64' ? 8 : 4;
  // .slice() yields a fresh, 0-offset ArrayBuffer so typed views stay aligned.
  return bytes.buffer.slice(bytes.byteOffset + headerBytes, bytes.byteOffset + bytes.byteLength);
}

/**
 * zlib-compressed. Header layout (header_type-sized words):
 *   [nBlocks, blockSize, lastBlockSize, cSize_0 .. cSize_{n-1}], then blocks.
 */
async function readCompressed(bytes, headerType) {
  const wordBytes = headerType === 'UInt64' ? 8 : 4;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = (i) => (wordBytes === 8 ? Number(dv.getBigUint64(i * 8, true)) : dv.getUint32(i * 4, true));

  const nBlocks = word(0);
  const compSizes = [];
  for (let b = 0; b < nBlocks; b++) compSizes.push(word(3 + b));

  let offset = (3 + nBlocks) * wordBytes;
  const chunks = [];
  for (let b = 0; b < nBlocks; b++) {
    chunks.push(await inflate(bytes.subarray(offset, offset + compSizes[b])));
    offset += compSizes[b];
  }
  return concatBuffers(chunks);
}

async function inflate(uint8) {
  const ds = new DecompressionStream('deflate'); // zlib (vtkZLibDataCompressor)
  const writer = ds.writable.getWriter();
  writer.write(uint8);
  writer.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

function concatBuffers(uint8Arrays) {
  const total = uint8Arrays.reduce((s, a) => s + a.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of uint8Arrays) { out.set(a, o); o += a.byteLength; }
  return out.buffer;
}

/**
 * View an ArrayBuffer as numbers of the given VTK type. Index types (Int/UInt
 * 32/64) are returned as a Uint32Array of mesh indices; floats as Float32Array.
 */
function typedView(buffer, type) {
  switch (type) {
    case 'Float64': return Float32Array.from(new Float64Array(buffer));
    case 'Float32': return new Float32Array(buffer);
    case 'Int64':
    case 'UInt64': return u32From(new BigInt64Array(buffer));
    case 'Int32':
    case 'UInt32': return new Uint32Array(buffer);
    case 'Int16': return Float32Array.from(new Int16Array(buffer));
    case 'UInt16': return new Uint32Array(new Uint16Array(buffer));
    case 'Int8': return Float32Array.from(new Int8Array(buffer));
    case 'UInt8': return new Uint32Array(new Uint8Array(buffer));
    default: return new Float32Array(buffer);
  }
}

function u32From(bigArr) {
  const out = new Uint32Array(bigArr.length);
  for (let i = 0; i < bigArr.length; i++) out[i] = Number(bigArr[i]);
  return out;
}

/**
 * Decode (possibly multi-chunk) base64 into one contiguous byte array.
 * VTK writers encode the header and payload either as one base64 stream
 * (ParaView) or as separate concatenated streams (meshio); splitting on padding
 * runs and concatenating the decoded bytes handles both uniformly.
 */
function decodeBase64(clean) {
  const parts = [];
  let i = 0;
  while (i < clean.length) {
    let end = clean.indexOf('=', i);
    if (end === -1) { end = clean.length; }
    else { while (end < clean.length && clean[end] === '=') end++; }
    parts.push(atobBytes(clean.slice(i, end)));
    i = end;
  }
  if (parts.length === 1) return parts[0];
  const total = parts.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function atobBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
