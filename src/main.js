import { SceneManager } from './renderer/SceneManager.js';
import { DropZone } from './ui/DropZone.js';
import { Panel } from './ui/Panel.js';
import { ECGMonitor } from './ui/ECGMonitor.js';
import { HelpBar } from './ui/HelpBar.js';
import { PresetsPanel } from './ui/PresetsPanel.js';
import { Dock, DOCK_ICONS } from './ui/Dock.js';
import { loadFromArrayBuffer } from './mesh/VTKLoader.js';
import { buildConductionGraph, applyOneWayGate } from './mesh/ConductionGraph.js';
import { ExcitableMedium } from './wave/ExcitableMedium.js';
import { colormaps, regionRGB } from './wave/Colormap.js';

const els = {
  viewport: document.getElementById('viewport'),
  overlay: document.getElementById('overlay'),
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  pickBtn: document.getElementById('pick-btn'),
  exampleBtn: document.getElementById('example-btn'),
  controls: document.getElementById('controls'),
  reopenBtn: document.getElementById('reopen-btn'),
  meshInfo: document.getElementById('mesh-info'),
  toast: document.getElementById('toast'),
  transport: document.getElementById('transport'),
  tpPlay: document.getElementById('tp-play'),
  leadsToggle: document.getElementById('leads-toggle'),
  camCard: document.getElementById('cam-card'),
  camReset: document.getElementById('cam-reset'),
};

// Standard, always-present scenarios. Custom presets the user saves are added at
// runtime (PresetsPanel, persisted in localStorage). `gate` installs the
// one-way reentry gate; `params` is a full Panel state snapshot.
// Note: presets intentionally omit `colormap` — the display palette (incl. the
// anatomical Regions view) is a separate display choice we don't want to clobber.
const BUILTIN_PRESETS = [
  { id: 'healthy', name: 'Healthy', builtin: true, gate: false,
    params: { waveSpeed: 1.0, refractoryPeriod: 0.5, waveWidth: 0.08, s2Coupling: 0.3, loop: false } },
  { id: 'reentry', name: 'Reentry', builtin: true, gate: true,
    params: { waveSpeed: 1.0, refractoryPeriod: 0.45, waveWidth: 0.08, s2Coupling: 0.3, loop: false } },
];

const CROSS_TIME = 1.2;            // seconds for the front to cross the mesh at speed 1×
const SCAR_GRAY = [0.50, 0.50, 0.55];
const REGION_DIM = [0.20, 0.22, 0.27];   // non-isolated regions when one is isolated

// Bundled example meshes (preprocessed by scripts/preprocess_examples.py).
const EXAMPLES = {
  heart: { file: 'example_heart.vtu', ext: 'vtu', label: 'Heart (anatomy)', view: 'regions' },
  vt: { file: 'example_heart_vt.vtu', ext: 'vtu', label: 'VT substrate', view: 'actionPotential' },
};

// One-way gate for the Reentry preset (validated by scripts/experiment_gate.mjs):
// a unidirectional conduction block in the scar channel turns a single S1 beat
// into a sustained anatomical-reentry circuit around the scar.
const GATE_RADIUS_FRAC = 0.15;    // gate disc radius as a fraction of mesh diameter
const GATE_SIGN = 1;              // circulation sense the gate permits

// Virtual torso electrodes for the pseudo-ECG, in the mesh frame with the
// convention +x = patient left, +y = anterior, +z = superior. Limb electrodes
// sit far out (arms/legs) in the coronal plane; precordials hug the anterior
// chest, closer to the heart so they read more locally — as in a real 12-lead.
const ECG_LIMB_R = 2.4;           // limb-electrode radius (× mesh radius)
const ECG_PREC_R = 1.7;           // precordial radius (× mesh radius)
const ECG_ELECTRODES = {
  RA: { dir: [-1.0, 0.0, 0.55], r: ECG_LIMB_R },
  LA: { dir: [1.0, 0.0, 0.55], r: ECG_LIMB_R },
  LL: { dir: [0.2, 0.0, -1.0], r: ECG_LIMB_R },
  V1: { dir: [-0.25, 1.0, 0.15], r: ECG_PREC_R },
  V2: { dir: [0.2, 1.0, 0.1], r: ECG_PREC_R },
  V3: { dir: [0.5, 1.0, 0.0], r: ECG_PREC_R },
  V4: { dir: [0.75, 0.85, -0.1], r: ECG_PREC_R },
  V5: { dir: [0.95, 0.5, -0.15], r: ECG_PREC_R },
  V6: { dir: [1.05, 0.15, -0.2], r: ECG_PREC_R },
};
// Lead = weighted sum of electrode potentials (Einthoven / Goldberger / Wilson).
const ECG_LEADS = {
  I: (p) => p.LA - p.RA,
  II: (p) => p.LL - p.RA,
  III: (p) => p.LL - p.LA,
  aVR: (p) => p.RA - (p.LA + p.LL) / 2,
  aVL: (p) => p.LA - (p.RA + p.LL) / 2,
  aVF: (p) => p.LL - (p.RA + p.LA) / 2,
  V1: (p) => p.V1 - p.WCT, V2: (p) => p.V2 - p.WCT, V3: (p) => p.V3 - p.WCT,
  V4: (p) => p.V4 - p.WCT, V5: (p) => p.V5 - p.WCT, V6: (p) => p.V6 - p.WCT,
};
let ecgElectrodes = null;         // { name: [x,y,z] } resolved at mesh scale
let ecgMaxR = 1;                  // farthest electrode distance (for framing)
let leadsOn = false;             // ECG lead overlay visible

const scene = new SceneManager(els.viewport);
const ecg = new ECGMonitor();
const helpBar = new HelpBar();

// Active mesh + simulation state.
let meshGeometry = null;
let vertexCount = 0;
let meshScale = 1;                 // mesh diameter, for unit-independent pacing
let pointData = {};
let colorAttr = null, colorArray = null, baseColors = null;
let medium = null;                 // ExcitableMedium (smooth excitable medium)
let reentryActive = false;         // current graph has the one-way reentry gate
let params = null;
let colormap = colormaps.actionPotential;   // wave (active-phase) palette
let regionView = false;                      // base coloured by anatomical region
let regionTags = [];                         // distinct region tags in the mesh
let isolatedRegion = null;                   // only this region kept coloured
let lastSource = null;             // S1 stimulus origin (white marker)
let s2Vertex = null;               // S2 site (cyan marker); defaults to S1 when unset
let pickS2 = false;                // next mesh click sets S2 instead of S1
let pendingS2 = null;              // armed S1–S2 beat, scheduled off local activation

// Continuous simulation clock.
let simTime = 0;
let lastFrame = 0;
let nextPace = Infinity;
let paused = false;
let simSpeed = 1;                  // playback rate (0.25× slow-mo … 2× fast)

// Left dock: a thin icon rail + flyout, one home for every control panel. Each
// section returns a body element we render a component (or relocate markup) into.
const dock = new Dock();
const meshBody = dock.addSection({ id: 'mesh', title: 'Mesh', icon: DOCK_ICONS.mesh });
const scenarioBody = dock.addSection({ id: 'scenarios', title: 'Scenarios', icon: DOCK_ICONS.scenarios });
const simBody = dock.addSection({ id: 'simulation', title: 'Simulation', icon: DOCK_ICONS.simulation });
const viewBody = dock.addSection({ id: 'view', title: 'View', icon: DOCK_ICONS.view });

const panel = new Panel({ mount: simBody, onChange: onParams, onReset: resetWave, onTrigger: () => stimulate(lastSource), onS1S2: deliverS1S2, onPickS2: () => setPickS2(!pickS2) });
params = panel.state();

const presets = new PresetsPanel({
  mount: scenarioBody,
  builtins: BUILTIN_PRESETS,
  onApply: applyPreset,
  getCurrent: () => ({ params: panel.state(), gate: reentryActive }),
});

// Mesh section: load button, live stats, and quick example switches.
els.reopenBtn.className = 'dock-btn';
meshBody.appendChild(els.reopenBtn);
els.meshInfo = document.createElement('p');
els.meshInfo.className = 'dock-note';
meshBody.appendChild(els.meshInfo);
const exGroup = dockGroup('Example meshes');
for (const key of ['heart', 'vt']) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dock-toggle';
  b.textContent = EXAMPLES[key].label;
  b.addEventListener('click', () => loadExample(key));
  exGroup.appendChild(b);
}
meshBody.appendChild(exGroup);

// View section: camera controls, then overlay toggles (relocated from the old
// top-left stack so their existing handlers keep working).
const camGroup = dockGroup('Camera');
camGroup.appendChild(els.camCard);
viewBody.appendChild(camGroup);

const overlayGroup = dockGroup('Overlays');
els.leadsToggle.className = 'dock-toggle';
overlayGroup.appendChild(els.leadsToggle);
els.axesToggle = document.createElement('button');
els.axesToggle.type = 'button';
els.axesToggle.className = 'dock-toggle active';
els.axesToggle.textContent = 'Orientation axes';
overlayGroup.appendChild(els.axesToggle);
viewBody.appendChild(overlayGroup);

function dockGroup(label) {
  const g = document.createElement('div');
  g.className = 'dock-group';
  const l = document.createElement('div');
  l.className = 'dock-group-label';
  l.textContent = label;
  g.appendChild(l);
  return g;
}

new DropZone({ dropEl: els.dropzone, inputEl: els.fileInput, pickBtn: els.pickBtn, onFile: handleFile });
els.exampleBtn.addEventListener('click', () => loadExample('heart'));
els.reopenBtn.addEventListener('click', () => setOverlay(true));

// Preload the torso shell (small) once; the ECG lead overlay renders it as a
// wireframe scaled around the heart.
let torsoGeometry = null;
const torsoReady = (async () => {
  try {
    const res = await fetch('example_torso.vtu');
    if (res.ok) torsoGeometry = (await loadFromArrayBuffer(await res.arrayBuffer(), 'vtu')).geometry;
  } catch { /* overlay falls back to a procedural shell */ }
})();
els.axesToggle.addEventListener('click', toggleAxisGizmo);
els.tpPlay.addEventListener('click', (e) => { setPaused(!paused); e.currentTarget.blur(); });
els.leadsToggle.addEventListener('click', toggleLeads);
els.camReset.addEventListener('click', () => scene.resetView());
document.querySelectorAll('.cam-set').forEach((b) =>
  b.addEventListener('click', () => saveView(+b.dataset.slot)));
document.querySelectorAll('.cam-jump').forEach((b) =>
  b.addEventListener('click', () => { const v = savedViews[+b.dataset.slot]; if (v) scene.setView(v); }));
els.transport.querySelectorAll('.tp-speed').forEach((b) =>
  b.addEventListener('click', () => { setSpeed(parseFloat(b.dataset.speed)); b.blur(); }));
window.addEventListener('keydown', (e) => {
  // Space toggles pause unless typing in a field or a menu has focus.
  if (e.code === 'Space' && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !els.transport.hidden) {
    e.preventDefault();
    setPaused(!paused);
  }
});
scene.onFrame = onFrame;
wireClickToStimulate();

// --- loading ----------------------------------------------------------------

async function handleFile(file) {
  const ext = file.name.split('.').pop();
  toast(`Loading ${file.name}…`);
  try {
    await renderMesh(await file.arrayBuffer(), ext, file.name);
  } catch (err) {
    fail(err, file.name);
  }
}

async function loadExample(key = 'heart') {
  const ex = EXAMPLES[key] || EXAMPLES.heart;
  toast(`Loading ${ex.label}…`);
  try {
    const res = await fetch(ex.file);
    if (!res.ok) throw new Error(`example mesh not found (${res.status})`);
    panel.setColormapValue(ex.view);   // anatomy → Regions; VT → action-potential
    await renderMesh(await res.arrayBuffer(), ex.ext, ex.file);
    // First impression should be alive: auto-fire the Healthy scenario.
    applyPreset(BUILTIN_PRESETS[0]);
  } catch (err) {
    fail(err, ex.file);
  }
}

async function renderMesh(buffer, ext, name) {
  const result = await loadFromArrayBuffer(buffer, ext);
  const { geometry, flatShaded } = result;
  meshGeometry = geometry;
  pointData = result.pointData || {};
  const verts = geometry.getAttribute('position').count;
  const tris = (geometry.getIndex()?.count ?? 0) / 3;

  scene.setMesh(geometry, { flatShaded });

  vertexCount = verts;
  meshScale = (geometry.boundingSphere?.radius || 1) * 2;
  colorAttr = geometry.getAttribute('color');
  colorArray = colorAttr.array;
  baseColors = new Float32Array(colorArray.length);

  regionTags = distinctRegions(pointData.region);
  isolatedRegion = null;
  params = panel.state();
  applyColormapState(params.colormap);
  refreshColorKey();

  rebuildMedium();        // plain substrate (no reentry gate) for a fresh mesh
  await torsoReady;       // ensure the torso shell is ready for the lead overlay
  setupElectrodes();      // virtual torso electrodes at this mesh's scale
  buildBase();
  applyResting();
  ecg.reset();

  lastSource = null;
  s2Vertex = null;
  pendingS2 = null;
  setPickS2(false);
  panel.setCanTrigger(false);
  panel.setS2Status('S2: same as S1');
  scene.markOrigin(null);
  scene.markS2(null);
  simTime = 0;
  lastFrame = performance.now();
  nextPace = Infinity;
  setPaused(false);
  setSpeed(1);
  leadsOn = false;
  scene.showLeadOverlay(false);
  els.leadsToggle.textContent = 'Show ECG leads';
  els.leadsToggle.classList.remove('active');
  clearViews();

  const stats = `${name} — ${verts.toLocaleString()} vertices, ${tris.toLocaleString()} triangles`;
  els.meshInfo.textContent = stats;
  setOverlay(false);
  toast(stats, false, 2600);
}

// --- simulation -------------------------------------------------------------

/**
 * (Re)build the conduction graph + excitable medium from the current params.
 * With `gate: true`, install the one-way reentry gate in the scar channel so a
 * single stimulus produces sustained anatomical reentry.
 */
function rebuildMedium({ gate = false } = {}) {
  const velocityFactor = buildVelocityFactor();
  const graph = buildConductionGraph(meshGeometry, velocityFactor);
  if (gate) applyReentryGate(graph);
  medium = new ExcitableMedium({
    graph,
    baseVelocity: baseVelocity(),
    refractoryPeriod: params.refractoryPeriod,
    waveWidth: params.waveWidth,
  });
  reentryActive = gate;
}

/** Install the validated one-way gate at the mesh's `gate` marker. */
function applyReentryGate(graph) {
  const gateV = markerVertex('gate');
  const fib = pointData.fibrosis;
  if (gateV == null || !fib) return;
  const positions = meshGeometry.getAttribute('position').array;
  const gateXyz = [positions[3 * gateV], positions[3 * gateV + 1], positions[3 * gateV + 2]];
  applyOneWayGate(
    graph, positions, gateXyz, scarCentroid(), meshScale * GATE_RADIUS_FRAC, GATE_SIGN,
    (v) => fib[v] > 0.3,                 // gate lives in the surviving channel tissue
  );
}

/** Centroid of the dense scar core (the reentry loop's inner hub). */
function scarCentroid() {
  const f = pointData.fibrosis, p = meshGeometry.getAttribute('position').array;
  let sx = 0, sy = 0, sz = 0, c = 0;
  for (let v = 0; v < vertexCount; v++) if (f[v] >= 0.95) { sx += p[3 * v]; sy += p[3 * v + 1]; sz += p[3 * v + 2]; c++; }
  return c ? [sx / c, sy / c, sz / c] : [0, 0, 0];
}

/** Vertex flagged in a one-hot marker point-data field, or null if absent. */
function markerVertex(name) {
  const f = pointData[name];
  if (!f) return null;
  let best = -1, val = 0.5;
  for (let v = 0; v < f.length; v++) if (f[v] > val) { val = f[v]; best = v; }
  return best >= 0 ? best : null;
}

function baseVelocity() {
  return (meshScale / CROSS_TIME) * params.waveSpeed;
}

/** Per-vertex conduction factor in [0,1] from the mesh's fibrosis field (scar
 *  slows/blocks conduction). Null when the mesh has no fibrosis field. */
function buildVelocityFactor() {
  const field = pointData.fibrosis || null;
  if (!field) return null;
  const f = new Float32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) f[v] = Math.max(0, Math.min(1, 1 - field[v]));
  return f;
}

function wireClickToStimulate() {
  const canvas = scene.renderer.domElement;
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 500;
    down = null;
    if (moved < 6 && quick) {
      const v = scene.pickVertex(e.clientX, e.clientY);
      if (v == null) return;
      if (pickS2) {
        s2Vertex = v;
        scene.markS2(v);
        setPickS2(false);
        panel.setS2Status('S2 set (cyan)');
      } else {
        lastSource = v;
        panel.setCanTrigger(true);
        stimulate(v);
      }
    }
  });
}

/** Arm/disarm "next click sets S2" mode. */
function setPickS2(on) {
  pickS2 = on;
  panel.setPickS2State(on);
  scene.renderer.domElement.style.cursor = on ? 'crosshair' : '';
  if (on) toast('Click the mesh to place the S2 site.', false, 2500);
}

/** Deliver a stimulus at a vertex at the current sim time. */
function stimulate(vertex) {
  if (vertex == null || !medium) return;
  scene.markOrigin(vertex);
  medium.stimulate(vertex, simTime);
}

/**
 * S1–S2 protocol: fire S1 at the origin now, then S2 at the S2 site one coupling
 * interval **after that site is activated** (clinical premature-beat timing). The
 * coupling is measured from the site's own activation — not from S1 — so a
 * coupling above the refractory period always captures and below it blocks,
 * regardless of how far the S2 site is from S1. Two independent sites show wave
 * collision, fusion, and unidirectional block.
 */
function deliverS1S2() {
  if (lastSource == null || !medium) return;
  const s2 = s2Vertex != null ? s2Vertex : lastSource;
  stimulate(lastSource);                       // S1 now, at the origin
  scene.markS2(s2);
  // Arm S2: fire it `coupling` after the S2 site is next activated (by S1's wave,
  // or immediately if S2 is the origin). Resolved in onFrame once we see it fire.
  pendingS2 = { site: s2, coupling: params.s2Coupling, armedAt: simTime, scheduled: false };
  const where = s2 === lastSource ? 'at the same point' : 'at the cyan point';
  toast(`S1 fired; S2 armed ${where} (${pendingS2.coupling.toFixed(2)} s after it activates).`, false, 3000);
}

/**
 * Drive the armed S1–S2 beat: once the S2 site activates (lastFired advances past
 * when we armed), schedule S2 a coupling interval after that local activation.
 */
function servicePendingS2() {
  const p = pendingS2;
  if (!p || p.scheduled) return;
  const localT = medium.lastFired[p.site];
  if (localT >= p.armedAt - 1e-6) {
    medium.stimulate(p.site, localT + p.coupling);   // S2, coupling after local activation
    p.scheduled = true;
    const captures = p.coupling >= params.refractoryPeriod;
    toast(captures
      ? `S2 delivered — coupling ${p.coupling.toFixed(2)} s ≥ refractory ${params.refractoryPeriod.toFixed(2)} s → captures.`
      : `S2 delivered — coupling ${p.coupling.toFixed(2)} s < refractory ${params.refractoryPeriod.toFixed(2)} s → blocks (premature).`,
      false, 3200);
    pendingS2 = null;
  } else if (simTime - p.armedAt > 6) {
    pendingS2 = null;                                 // S1 wave never reached S2
  }
}

function onFrame() {
  if (!medium || !colorAttr) return;
  const now = performance.now();
  let dt = (now - lastFrame) / 1000;
  lastFrame = now;
  if (paused) return;              // frozen: keep last frame, orbit still works
  if (dt > 0.1) dt = 0.1;          // clamp after a tab switch / long frame
  simTime += dt * simSpeed;        // playback-rate scaled sim clock

  // Pacing: re-stimulate the origin at a fixed interval (an S1 train) so each
  // beat cleanly captures the tissue.
  if (params.loop && lastSource != null) {
    const interval = Math.max(params.refractoryPeriod * 1.3, 0.15);
    while (simTime >= nextPace) { medium.stimulate(lastSource, nextPace); nextPace += interval; }
  }

  medium.step(simTime);
  servicePendingS2();
  medium.composite(colorArray, baseColors, colormap);
  ecg.push(simTime, ecgLead(ecg.lead));
  colorAttr.needsUpdate = true;
}

/** Resolve electrode world positions for the current mesh (heart centred at 0). */
function setupElectrodes() {
  const R = meshScale / 2;       // mesh radius
  ecgElectrodes = {};
  ecgMaxR = R;
  for (const name in ECG_ELECTRODES) {
    const { dir, r } = ECG_ELECTRODES[name];
    const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const s = (r * R) / l;
    const p = [dir[0] * s, dir[1] * s, dir[2] * s];
    ecgElectrodes[name] = p;
    ecgMaxR = Math.max(ecgMaxR, Math.hypot(p[0], p[1], p[2]));
  }
  scene.setLeadOverlay({ torsoGeometry, electrodes: ecgElectrodes, meshRadius: R });
}

// Saved camera views (per mesh; coordinates are mesh-specific).
const savedViews = [null, null, null];
function saveView(slot) {
  savedViews[slot] = scene.getView();
  const jump = document.querySelector(`.cam-jump[data-slot="${slot}"]`);
  const set = document.querySelector(`.cam-set[data-slot="${slot}"]`);
  jump.disabled = false;
  jump.classList.add('filled');
  set.textContent = '↻';                 // now overwrites
  set.title = 'Overwrite with current view';
}
function clearViews() {
  for (let i = 0; i < savedViews.length; i++) savedViews[i] = null;
  document.querySelectorAll('.cam-jump').forEach((b) => { b.disabled = true; b.classList.remove('filled'); });
  document.querySelectorAll('.cam-set').forEach((b) => { b.textContent = '＋'; b.title = 'Save current view'; });
}

/** Toggle the 3D torso + electrode overlay, zooming to fit it when shown. */
function toggleLeads() {
  leadsOn = !leadsOn;
  scene.showLeadOverlay(leadsOn);
  scene.frameRadius(leadsOn ? ecgMaxR * 1.15 : meshScale / 2);
  els.leadsToggle.textContent = leadsOn ? 'Hide ECG leads' : 'Show ECG leads';
  els.leadsToggle.classList.toggle('active', leadsOn);
}

/**
 * Net cardiac current dipole D = Σ over surface edges of ΔVm · edge-direction.
 * Only wavefronts (where neighbouring phase differs) contribute, so a uniformly
 * depolarized or resting heart gives ~0 — as a real ECG is isoelectric between
 * the wavefront (QRS) and the repolarization wave (T).
 */
function cardiacDipole() {
  const { offsets, neighbors, edgeLen } = medium.g;
  const pos = meshGeometry.getAttribute('position').array;
  const list = medium.firedList;            // active set; resting neighbours read phase 0
  let dx = 0, dy = 0, dz = 0;
  for (let k = 0; k < list.length; k++) {
    const a = list[k];
    const pa = medium.getPhase(a);
    const ax = pos[3 * a], ay = pos[3 * a + 1], az = pos[3 * a + 2];
    for (let e = offsets[a]; e < offsets[a + 1]; e++) {
      const b = neighbors[e];
      const d = pa - medium.getPhase(b);
      if (d === 0) continue;
      const inv = d / (edgeLen[e] || 1);
      dx += inv * (ax - pos[3 * b]);
      dy += inv * (ay - pos[3 * b + 1]);
      dz += inv * (az - pos[3 * b + 2]);
    }
  }
  return [dx, dy, dz];
}

/** Selected lead signal from the dipole, via torso-electrode potentials. */
function ecgLead(leadName) {
  if (!medium || !meshGeometry || !ecgElectrodes) return 0;
  const D = cardiacDipole();
  // Potential of a central dipole at each electrode: φ = D·r / |r|³.
  const phi = {};
  for (const name in ecgElectrodes) {
    const r = ecgElectrodes[name];
    const r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
    const r3 = r2 * Math.sqrt(r2) || 1;
    phi[name] = (D[0] * r[0] + D[1] * r[1] + D[2] * r[2]) / r3;
  }
  phi.WCT = (phi.RA + phi.LA + phi.LL) / 3;   // Wilson central terminal
  const lead = ECG_LEADS[leadName] || ECG_LEADS.II;
  return lead(phi) * meshScale * meshScale;   // undo the 1/r² scale for a sane range
}

/** Distinct integer region tags present in a region field (sorted). */
function distinctRegions(field) {
  if (!field) return [];
  const set = new Set();
  for (let v = 0; v < field.length; v++) set.add(field[v] | 0);
  return [...set].sort((a, b) => a - b);
}

/** Resolve the wave palette + region-view flag from the colormap selector value. */
function applyColormapState(value) {
  regionView = value === 'regions';
  if (!regionView) isolatedRegion = null;
  colormap = regionView ? colormaps.actionPotential : (colormaps[value] || colormaps.actionPotential);
}

/** Show the gradient key, or the region legend when in Regions view. */
function refreshColorKey() {
  if (regionView && regionTags.length) panel.setRegionKey(regionTags, isolateRegion, isolatedRegion);
  else panel.setColorKey(colormap, !!pointData.fibrosis);
}

/** Isolate (or clear) a single anatomical region in the Regions view. */
function isolateRegion(tag) {
  isolatedRegion = tag;
  buildBase();
  applyResting();
  panel.setRegionKey(regionTags, isolateRegion, isolatedRegion);
}

/** Recompute resting base colors: resting tissue / region colours + scar overlay. */
function buildBase() {
  if (!baseColors) return;
  const region = regionView ? pointData.region : null;
  if (region) {
    for (let v = 0; v < vertexCount; v++) {
      const off = 3 * v;
      const rgb = (isolatedRegion != null && (region[v] | 0) !== isolatedRegion)
        ? REGION_DIM : regionRGB(region[v]);
      baseColors[off] = rgb[0]; baseColors[off + 1] = rgb[1]; baseColors[off + 2] = rgb[2];
    }
  } else {
    for (let v = 0; v < vertexCount; v++) colormap(0, baseColors, 3 * v); // resting
  }

  // Tint fibrotic tissue gray so the conduction obstacle is always visible.
  const fib = pointData.fibrosis || null;
  if (fib) {
    for (let v = 0; v < vertexCount; v++) {
      const a = Math.max(0, Math.min(1, fib[v]));
      if (a > 0) {
        const off = 3 * v, ia = 1 - a;
        baseColors[off] = baseColors[off] * ia + SCAR_GRAY[0] * a;
        baseColors[off + 1] = baseColors[off + 1] * ia + SCAR_GRAY[1] * a;
        baseColors[off + 2] = baseColors[off + 2] * ia + SCAR_GRAY[2] * a;
      }
    }
  }
}

function applyResting() {
  if (!colorArray) return;
  colorArray.set(baseColors);
  colorAttr.needsUpdate = true;
}

function onParams(state) {
  const prev = params;
  params = state;
  applyColormapState(state.colormap);
  refreshColorKey();

  // Speed / refractory / wave-width update the medium in place (no graph rebuild,
  // so a running reentry circuit keeps its one-way gate).
  if (medium) medium.setParams({ baseVelocity: baseVelocity(), refractoryPeriod: state.refractoryPeriod, waveWidth: state.waveWidth });

  if (state.loop && !prev.loop) nextPace = simTime;       // start pacing now
  else if (!state.loop) nextPace = Infinity;

  buildBase();
  applyResting();
}

/**
 * Apply a preset (built-in or custom) from the Presets window. Writes its saved
 * controls into the panel, then sets up the scenario: `gate:true` installs the
 * one-way reentry gate and fires a single S1 at the channel entrance (a single
 * beat then circulates the scar into a self-sustaining, emergent reentry);
 * otherwise it builds a plain substrate and fires a clean wave from the pacing
 * site. Stimulus sites come from the mesh's markers, so a preset is
 * mesh-independent (no baked-in vertex indices).
 */
function applyPreset(preset) {
  if (!preset || !medium) return;
  if (preset.params) panel.setState(preset.params);   // writes sliders + fires onParams

  simTime = 0;
  lastFrame = performance.now();
  nextPace = Infinity;
  s2Vertex = null;
  pendingS2 = null;
  scene.markS2(null);
  setPickS2(false);
  panel.setS2Status('S2: same as S1');

  if (preset.gate) {
    if (!pointData.fibrosis) {
      toast(`"${preset.name}" needs a fibrosis field — load the example heart mesh.`, true, 4000);
      return;
    }
    rebuildMedium({ gate: true });
    buildBase();
    applyResting();
    const s1 = markerVertex('reentry_s1') ?? lastSource;
    lastSource = s1;
    if (s1 != null) {
      panel.setCanTrigger(true);
      stimulate(s1);
      toast(`${preset.name} — one beat at the channel entrance; the one-way gate forces the wave to circulate the scar into a self-sustaining reentry.`, false, 6000);
    }
    return;
  }

  // Plain substrate (no gate), clean wave from the pacing site (or the mesh apex
  // when there's no marker, so even a marker-less anatomy mesh loads alive).
  rebuildMedium({ gate: false });
  buildBase();
  applyResting();
  const s1 = markerVertex('pace_site') ?? lastSource ?? apexVertex();
  lastSource = s1;
  if (s1 != null) {
    panel.setCanTrigger(true);
    stimulate(s1);
    toast(`${preset.name} — a clean single wave spreads from the pacing site.`, false, 4000);
  } else {
    toast(`${preset.name} — click the mesh to fire a clean single wave.`, false, 4000);
  }
}

/** Fallback stimulus site: the mesh's lowest point (≈ apex), for marker-less meshes. */
function apexVertex() {
  const p = meshGeometry?.getAttribute('position');
  if (!p) return null;
  let best = 0, lo = Infinity;
  for (let v = 0; v < p.count; v++) { const y = p.getY(v); if (y < lo) { lo = y; best = v; } }
  return best;
}

function resetWave() {
  if (medium) medium.reset();
  pendingS2 = null;
  applyResting();
  nextPace = params.loop && lastSource != null ? simTime : Infinity;
}

// --- ui helpers -------------------------------------------------------------

function setOverlay(visible) {
  els.overlay.classList.toggle('hidden', !visible);
  dock.show(!visible);
  els.transport.hidden = visible;
  ecg.show(!visible);
  helpBar.show(!visible);
}

let axisOn = true;
function toggleAxisGizmo() {
  axisOn = !axisOn;
  scene.setAxisGizmoVisible(axisOn);
  els.axesToggle.classList.toggle('active', axisOn);
}

function setPaused(p) {
  paused = p;
  if (!paused) lastFrame = performance.now();   // avoid a dt jump on resume
  els.tpPlay.textContent = paused ? '▶' : '⏸';
  els.tpPlay.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
  els.transport.classList.toggle('paused', paused);
}

function setSpeed(s) {
  simSpeed = s;
  els.transport.querySelectorAll('.tp-speed').forEach((b) =>
    b.classList.toggle('active', parseFloat(b.dataset.speed) === s));
}

function fail(err, name) {
  console.error(err);
  toast(`Failed to load ${name}: ${err.message}`, true);
}

let toastTimer;
function toast(msg, isError = false, autohide = 0) {
  clearTimeout(toastTimer);
  els.toast.textContent = msg;
  els.toast.classList.toggle('error', isError);
  els.toast.hidden = false;
  if (autohide) toastTimer = setTimeout(() => { els.toast.hidden = true; }, autohide);
}
