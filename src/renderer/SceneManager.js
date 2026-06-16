import * as THREE from 'three';
import { OrbitControls } from './OrbitControls.js';
import { VertexPicker } from './Raycaster.js';

/**
 * Owns the Three.js scene, camera, lights, renderer and orbit controls.
 * Phase 1 responsibility: render a single static mesh and let the user orbit it.
 */
export class SceneManager {
  /** @param {HTMLElement} container element the canvas mounts into */
  constructor(container) {
    this.container = container;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d1117);

    const { clientWidth: w, clientHeight: h } = container;
    this.camera = new THREE.PerspectiveCamera(45, w / h || 1, 0.01, 10000);
    this.camera.position.set(0, 0, 5);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);

    // Stop the browser starting a native image-drag of the canvas on a left-drag
    // (it would "drag a stale image" of the frame instead of orbiting).
    this.renderer.domElement.addEventListener('dragstart', (e) => e.preventDefault());

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    // Lighting: soft ambient fill + a key directional light that tracks the camera
    // so surface shading reads well from any orbit angle.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    // Hemisphere fill keeps flat faces (e.g. extracted volume boundaries) from
    // going fully dark when they face away from the key light.
    this.scene.add(new THREE.HemisphereLight(0xcdd6f4, 0x202632, 0.45));
    this.keyLight = new THREE.DirectionalLight(0xffffff, 0.85);
    this.keyLight.position.set(1, 1, 1);
    this.camera.add(this.keyLight);
    this.scene.add(this.camera);

    this.mesh = null;
    this.picker = new VertexPicker();
    /** Optional per-frame callback (e.g. to drive wave coloring). */
    this.onFrame = null;

    // Markers for the S1 (white) and S2 (cyan) stimulus sites.
    this.originMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    this.originMarker.visible = false;
    this.scene.add(this.originMarker);
    this.s2Marker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0x4fc3f7 })
    );
    this.s2Marker.visible = false;
    this.scene.add(this.s2Marker);
    this._tmp = new THREE.Vector3();

    // Small orientation gizmo drawn in the bottom-left corner (toggleable).
    this.axisVisible = true;
    this._axisDir = new THREE.Vector3();
    this._buildAxisGizmo();

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);

    this._animate = this._animate.bind(this);
    this.renderer.setAnimationLoop(this._animate);
  }

  /**
   * Replace the displayed mesh with new geometry, recenter it at the origin and
   * frame the camera so the whole mesh is visible.
   * @param {THREE.BufferGeometry} geometry
   * @param {{ flatShaded?: boolean }} [opts]
   */
  setMesh(geometry, opts = {}) {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }

    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    // Recenter geometry on the origin for predictable orbiting.
    const center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);
    geometry.translate(-center.x, -center.y, -center.z);
    geometry.computeBoundingSphere();

    // Per-vertex color buffer drives the wave animation; start neutral gray and
    // let the caller paint the resting palette.
    if (!geometry.getAttribute('color')) {
      const colors = new Float32Array(geometry.getAttribute('position').count * 3).fill(0.5);
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }

    const material = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      vertexColors: true,
      specular: 0x222222,
      shininess: 18,
      side: THREE.DoubleSide,
      flatShading: !!opts.flatShaded,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.mesh);

    // Size the markers relative to the mesh and hide them until a click.
    this.meshRadius = geometry.boundingSphere?.radius || 1;
    this.originMarker.scale.setScalar(this.meshRadius * 0.02);
    this.s2Marker.scale.setScalar(this.meshRadius * 0.02);
    this.originMarker.visible = false;
    this.s2Marker.visible = false;

    this._frameToSphere(geometry.boundingSphere);
  }

  /** Place the S1 (origin) marker at a vertex, or hide it if null. */
  markOrigin(vertexIndex) { this._placeMarker(this.originMarker, vertexIndex); }

  /** Place the S2 marker at a vertex, or hide it if null. */
  markS2(vertexIndex) { this._placeMarker(this.s2Marker, vertexIndex); }

  _placeMarker(marker, vertexIndex) {
    if (vertexIndex == null || !this.mesh) { marker.visible = false; return; }
    const pos = this.mesh.geometry.getAttribute('position');
    this._tmp.fromBufferAttribute(pos, vertexIndex);
    this.mesh.localToWorld(this._tmp);
    marker.position.copy(this._tmp);
    marker.visible = true;
  }

  /**
   * Map a client (pixel) coordinate to the nearest surface vertex index.
   * @returns {number|null}
   */
  pickVertex(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    return this.picker.pick(this.mesh, this.camera, ndcX, ndcY);
  }

  /** Capture the current camera view (position + orbit target). */
  getView() {
    return {
      pos: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
    };
  }

  /** Restore a view captured by {@link getView}. */
  setView(v) {
    if (!v) return;
    this.camera.position.set(v.pos[0], v.pos[1], v.pos[2]);
    this.controls.target.set(v.target[0], v.target[1], v.target[2]);
    this.controls.update();
  }

  /** Re-frame the default 3/4 view of the current mesh. */
  resetView() {
    if (this.mesh) this._frameToSphere(this.mesh.geometry.boundingSphere);
  }

  /** Position the camera so a bounding sphere fits the view. */
  _frameToSphere(sphere) {
    const radius = sphere?.radius || 1;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = (radius / Math.sin(fov / 2)) * 1.25;

    // Angled 3/4 view so depth + curvature read immediately (not pole-on).
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(dist * 0.45, dist * 0.35, dist * 0.82);
    this.camera.near = Math.max(dist - radius * 4, radius * 0.001);
    this.camera.far = dist + radius * 8;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  _onResize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /** Show/hide the bottom-left orientation gizmo. */
  setAxisGizmoVisible(on) { this.axisVisible = !!on; }

  /**
   * Build the ECG lead-overlay: a translucent torso outline, the virtual
   * electrodes (labelled spheres) and the Einthoven triangle (lead axes I/II/III),
   * so users can see where the leads run. Hidden until `showLeadOverlay(true)`.
   * @param {{ electrodes: Record<string, number[]>, meshRadius: number }} opts
   */
  setLeadOverlay({ torsoGeometry, electrodes, meshRadius }) {
    if (this.leadOverlay) { this.scene.remove(this.leadOverlay); this.leadOverlay = null; }
    const g = new THREE.Group();
    const V = (p) => new THREE.Vector3(p[0], p[1], p[2]);

    // Torso shell: the real torso mesh (recentred + uniformly scaled to enclose
    // the electrode shell) as a faint wireframe; fall back to a sphere if absent.
    const torsoMat = new THREE.MeshBasicMaterial({ color: 0x8aa0bd, wireframe: true, transparent: true, opacity: 0.14 });
    let torso;
    if (torsoGeometry) {
      const geo = torsoGeometry.clone();
      geo.computeBoundingSphere();
      const bs = geo.boundingSphere;
      geo.translate(-bs.center.x, -bs.center.y, -bs.center.z);
      const scale = (meshRadius * 2.6) / (bs.radius || 1);   // a bit beyond the limb leads (2.4R)
      geo.scale(scale, scale, scale);
      torso = new THREE.Mesh(geo, torsoMat);
    } else {
      torso = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 18), torsoMat);
      torso.scale.set(meshRadius * 1.9, meshRadius * 1.35, meshRadius * 2.3);
    }
    g.add(torso);

    // Electrodes: limb leads gold, precordials blue, each labelled.
    const limb = new Set(['RA', 'LA', 'LL']);
    const markerR = meshRadius * 0.05;
    for (const name in electrodes) {
      const p = electrodes[name];
      const color = limb.has(name) ? 0xffd166 : 0x4dabf7;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(markerR, 12, 12), new THREE.MeshBasicMaterial({ color }));
      dot.position.copy(V(p));
      g.add(dot);
      const label = this._textSprite(name, color, meshRadius * 0.26);
      label.position.copy(V(p).multiplyScalar(1.09));
      g.add(label);
    }

    // Einthoven triangle (the frontal-plane limb-lead axes).
    const tri = ['RA', 'LA', 'LL'].map((n) => electrodes[n]);
    const triGeo = new THREE.BufferGeometry().setFromPoints([
      V(tri[0]), V(tri[1]), V(tri[1]), V(tri[2]), V(tri[2]), V(tri[0]),
    ]);
    g.add(new THREE.LineSegments(triGeo, new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.5 })));
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const leadLabel = (name, a, b) => {
      const s = this._textSprite(name, 0xffe08a, meshRadius * 0.3);
      s.position.copy(V(mid(electrodes[a], electrodes[b])));
      g.add(s);
    };
    leadLabel('I', 'RA', 'LA'); leadLabel('II', 'RA', 'LL'); leadLabel('III', 'LA', 'LL');

    g.visible = false;
    this.leadOverlay = g;
    this.scene.add(g);
  }

  /** Show/hide the ECG lead overlay. */
  showLeadOverlay(on) { if (this.leadOverlay) this.leadOverlay.visible = !!on; }

  /** Dolly the camera (preserving orbit angle) to fit a sphere of `radius`. */
  frameRadius(radius) {
    const dir = this._tmp.copy(this.camera.position).sub(this.controls.target).normalize();
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = (radius / Math.sin(fov / 2)) * 1.12;
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist - radius * 4, radius * 0.001);
    this.camera.far = dist + radius * 8;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  _textSprite(text, color, scaleWorld) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    ctx.font = 'bold 38px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
    ctx.fillText(text, 32, 34);
    const tex = new THREE.CanvasTexture(c);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sprite.scale.setScalar(scaleWorld);
    return sprite;
  }

  /** Build the axis gizmo: unlit RGB arrows + X/Y/Z sprite labels in a tiny scene. */
  _buildAxisGizmo() {
    this.axisScene = new THREE.Scene();
    // Orthographic so the gizmo shows true orientation without perspective skew.
    this.axisCamera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 100);
    const origin = new THREE.Vector3(0, 0, 0);
    const axes = [
      [new THREE.Vector3(1, 0, 0), 0xff6b6b, 'X'],
      [new THREE.Vector3(0, 1, 0), 0x51cf66, 'Y'],
      [new THREE.Vector3(0, 0, 1), 0x4dabf7, 'Z'],
    ];
    for (const [dir, color, label] of axes) {
      this.axisScene.add(new THREE.ArrowHelper(dir, origin, 1.0, color, 0.3, 0.18));
      const sprite = this._axisLabel(label, color);
      sprite.position.copy(dir).multiplyScalar(1.32);
      this.axisScene.add(sprite);
    }
  }

  _axisLabel(text, color) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    ctx.font = 'bold 46px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
    ctx.fillText(text, 32, 34);
    const tex = new THREE.CanvasTexture(c);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sprite.scale.setScalar(0.62);
    return sprite;
  }

  /** Render the gizmo into a small scissored viewport, synced to camera orientation. */
  _renderAxisGizmo() {
    const r = this.renderer;
    const size = 184, margin = 16;
    this._axisDir.copy(this.camera.position).sub(this.controls.target).normalize();
    this.axisCamera.position.copy(this._axisDir).multiplyScalar(5);
    this.axisCamera.up.copy(this.camera.up);
    this.axisCamera.lookAt(0, 0, 0);

    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    r.clearDepth();                       // draw on top of the main scene
    r.setScissorTest(true);
    r.setScissor(margin, margin, size, size);
    r.setViewport(margin, margin, size, size);
    r.render(this.axisScene, this.axisCamera);
    r.setScissorTest(false);

    const { clientWidth: w, clientHeight: h } = this.container;
    r.setViewport(0, 0, w, h);            // restore the full viewport
    r.autoClear = prevAutoClear;
  }

  _animate() {
    this.controls.update();
    if (this.onFrame) this.onFrame();
    this.renderer.render(this.scene, this.camera);
    if (this.axisVisible && this.mesh) this._renderAxisGizmo();
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.setAnimationLoop(null);
    this.controls.dispose();
    this.renderer.dispose();
  }
}
