// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { loadFromArrayBuffer } from '../../src/mesh/VTKLoader.js';

function fixture(name) {
  const buf = readFileSync(resolve(process.cwd(), 'tests/fixtures', name));
  // Slice to a real ArrayBuffer (Node Buffers can share a larger backing store).
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe('VTKLoader.loadFromArrayBuffer', () => {
  it('parses the cube fixture into a BufferGeometry', async () => {
    const { geometry } = await loadFromArrayBuffer(fixture('cube.vtu'), 'vtu');

    expect(geometry).toBeInstanceOf(THREE.BufferGeometry);
    // 8 corner vertices.
    expect(geometry.getAttribute('position').count).toBe(8);
    // 12 triangles → 36 indices.
    expect(geometry.getIndex().count).toBe(36);
    // Normals computed when absent.
    expect(geometry.getAttribute('normal')).toBeTruthy();
    expect(geometry.getAttribute('normal').count).toBe(8);
  });

  it('produces finite, non-degenerate positions', async () => {
    const { geometry } = await loadFromArrayBuffer(fixture('cube.vtu'), 'vtu');
    const pos = geometry.getAttribute('position').array;
    expect(pos.every(Number.isFinite)).toBe(true);
    geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    geometry.boundingBox.getSize(size);
    expect(size.x).toBeGreaterThan(0);
    expect(size.y).toBeGreaterThan(0);
    expect(size.z).toBeGreaterThan(0);
  });

  it('decodes compressed-binary VTU identically to ASCII', async () => {
    const ascii = await loadFromArrayBuffer(fixture('cube.vtu'), 'vtu');
    const binary = await loadFromArrayBuffer(fixture('cube_binary.vtu'), 'vtu');

    expect(binary.geometry.getAttribute('position').count).toBe(8);
    expect(binary.geometry.getIndex().count).toBe(36);
    // Same vertices, same connectivity as the ASCII twin.
    expect(Array.from(binary.geometry.getAttribute('position').array))
      .toEqual(Array.from(ascii.geometry.getAttribute('position').array));
    expect(Array.from(binary.geometry.getIndex().array))
      .toEqual(Array.from(ascii.geometry.getIndex().array));
  });

  it('reads UInt64 uncompressed binary and extracts a volume boundary surface', async () => {
    // Two tetrahedra sharing one face → boundary = 8 faces − 2 shared = 6 triangles.
    const { geometry } = await loadFromArrayBuffer(fixture('tets_uint64.vtu'), 'vtu');

    expect(geometry.getAttribute('position').count).toBe(5);
    expect(geometry.getIndex().count).toBe(6 * 3); // 6 boundary triangles
    const pos = geometry.getAttribute('position').array;
    expect(pos.every(Number.isFinite)).toBe(true);
    // The shared interior face (vertices 1,2,3) must not be emitted: vertex 0 and
    // vertex 4 each belong to exactly 3 boundary triangles (the two apexes).
    const idx = Array.from(geometry.getIndex().array);
    const uses = (v) => idx.filter((i) => i === v).length;
    expect(uses(0)).toBe(3);
    expect(uses(4)).toBe(3);
  });

  it('parses the bundled example heart mesh (binary) and exposes its region tags', async () => {
    const buf = readFileSync(resolve(process.cwd(), 'public', 'example_heart.vtu'));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const { geometry, pointData } = await loadFromArrayBuffer(ab, 'vtu');

    // Counts reflect the shipped surface after preprocessing drops the aorta
    // (elemTag 5) — see scripts/preprocess_examples.py DROP_REGIONS.
    const verts = geometry.getAttribute('position').count;
    expect(verts).toBe(64708);
    expect(geometry.getIndex().count).toBe(128936 * 3);
    // Anatomical element tags carried through as a per-point `region` field.
    expect(pointData.region).toBeInstanceOf(Float32Array);
    expect(pointData.region.length).toBe(verts);
    const tags = new Set(Array.from(pointData.region, (r) => Math.round(r)));
    expect(tags.size).toBe(23);          // 24 original regions minus the aorta
    expect(tags.has(5)).toBe(false);     // aorta fully excised
  });
});
