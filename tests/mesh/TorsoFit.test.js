// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { loadFromArrayBuffer } from '../../src/mesh/VTKLoader.js';
import {
  HEART_ANATOMICAL_MATRIX, meshBounds, transformTorso, torsoPlacement,
  pointInMesh, electrodeSites, rayTriHits,
} from '../../src/mesh/TorsoFit.js';

function load(rel) {
  const buf = readFileSync(resolve(process.cwd(), rel));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Heart positions in the scene frame, exactly as SceneManager.setMesh produces:
 *  apply the anatomical rotation, then recenter on the bounding-box center. */
async function heartSceneFrame() {
  const { geometry } = await loadFromArrayBuffer(load('public/example_heart.vtu'), 'vtu');
  const m = HEART_ANATOMICAL_MATRIX;
  geometry.applyMatrix4(new THREE.Matrix4().set(
    m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1));
  geometry.computeBoundingBox();
  const c = new THREE.Vector3();
  geometry.boundingBox.getCenter(c);
  geometry.translate(-c.x, -c.y, -c.z);
  return geometry.getAttribute('position').array;
}

async function torsoNative() {
  const { geometry } = await loadFromArrayBuffer(load('public/example_torso.vtu'), 'vtu');
  return { positions: geometry.getAttribute('position').array, index: geometry.getIndex().array };
}

describe('TorsoFit — heart inside torso', () => {
  it('places every heart vertex inside the torso shell', async () => {
    const heart = await heartSceneFrame();
    const { positions: tNative, index } = await torsoNative();
    const { scale, offset } = torsoPlacement(meshBounds(heart), meshBounds(tNative));
    const torso = transformTorso(tNative, scale, offset);

    // Bulk: every vertex, single-ray parity (reliable on the watertight torso).
    let outside = 0;
    for (let i = 0; i < heart.length; i += 3) {
      if (!pointInMesh([heart[i], heart[i + 1], heart[i + 2]], torso, index, [[0, 0, 1]])) outside++;
    }
    expect(outside).toBe(0);

    // Robustness spot-check: a sample with the full 5-direction vote agrees.
    let outsideVoted = 0;
    for (let i = 0; i < heart.length; i += 3 * 97) {
      if (!pointInMesh([heart[i], heart[i + 1], heart[i + 2]], torso, index)) outsideVoted++;
    }
    expect(outsideVoted).toBe(0);
  });

  it('seats each electrode on the torso surface', async () => {
    const heart = await heartSceneFrame();
    const { positions: tNative, index } = await torsoNative();
    const { scale, offset } = torsoPlacement(meshBounds(heart), meshBounds(tNative));
    const torso = transformTorso(tNative, scale, offset);
    const sites = electrodeSites(torso, index);

    expect(Object.keys(sites)).toHaveLength(9);     // RA LA LL + V1..V6
    const tb = meshBounds(torso);
    for (const name in sites) {
      const p = sites[name];
      // The electrode points just outside the surface: a ray back toward the torso
      // center must hit the shell at a small distance (it sits on the torso).
      const toCenter = [tb.center[0] - p[0], tb.center[1] - p[1], tb.center[2] - p[2]];
      const len = Math.hypot(...toCenter) || 1;
      const dir = toCenter.map((v) => v / len);
      const hits = rayTriHits(p, dir, torso, index);
      const nearest = hits.length ? Math.min(...hits) : Infinity;
      expect(nearest).toBeLessThan(Math.max(...tb.size) * 0.12);
    }
  });
});
