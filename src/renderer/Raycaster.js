import * as THREE from 'three';

/**
 * Maps a screen click to the nearest surface vertex of a mesh via raycasting.
 */
export class VertexPicker {
  constructor() {
    this.raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._v = new THREE.Vector3();
  }

  /**
   * @param {THREE.Mesh} mesh
   * @param {THREE.Camera} camera
   * @param {number} ndcX  normalized device x in [-1, 1]
   * @param {number} ndcY  normalized device y in [-1, 1]
   * @returns {number|null} index of the closest vertex on the hit face, or null
   */
  pick(mesh, camera, ndcX, ndcY) {
    if (!mesh) return null;
    this._ndc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this._ndc, camera);
    const hits = this.raycaster.intersectObject(mesh, false);
    if (!hits.length) return null;

    const hit = hits[0];
    const face = hit.face;
    if (!face) return null;

    const pos = mesh.geometry.getAttribute('position');
    let best = -1;
    let bestDist = Infinity;
    for (const vi of [face.a, face.b, face.c]) {
      this._v.fromBufferAttribute(pos, vi);
      mesh.localToWorld(this._v);
      const d = this._v.distanceToSquared(hit.point);
      if (d < bestDist) { bestDist = d; best = vi; }
    }
    return best;
  }
}
