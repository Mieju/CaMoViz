# Cardiac Wave Propagation Visualizer — Full Project Plan
### A lightweight browser-based teaching & marketing tool for computational modeling groups

---

## 0. Project Overview

**What it is:** A single-page web application that loads a 3D heart mesh (VTK/VTU), lets users rotate and inspect it, and simulates pseudo-realistic electrical wave propagation by clicking anywhere on the surface. Secondary feature: load multiple mesh variants (healthy, fibrotic, infarcted) and compare how the wavefront behaves differently.

**What it is not:** A real simulation. All propagation is approximated via weighted geodesic traversal (Dijkstra on the mesh graph). No differential equations are solved at runtime.

**Target users:** Students, clinicians, collaborators, conference visitors — mixed background, zero setup required.

**Guiding constraint:** Zero backend. Runs entirely in the browser. No server, no install, shareable as a URL or a static folder.

---

## 1. Requirements Analysis

### 1.1 Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F-01 | Load a VTK/VTU mesh file via drag-and-drop or file picker | Must |
| F-02 | Render the mesh in 3D with surface shading | Must |
| F-03 | Rotate, zoom, pan the mesh with mouse/touch | Must |
| F-04 | Click a point on the mesh surface to select a stimulus origin | Must |
| F-05 | Animate a pseudo wave propagation from the selected point | Must |
| F-06 | Wave respects mesh surface geometry (geodesic, not Euclidean) | Must |
| F-07 | Wave has a visible refractory tail (activates → repolarizes → resets) | Must |
| F-08 | Load a second mesh variant and compare side-by-side | Should |
| F-09 | Fibrosis / slow-conduction regions affect wave speed visually | Should |
| F-10 | Adjustable wave speed slider | Should |
| F-11 | Export current view as PNG screenshot | Could |
| F-12 | Colormap selector (e.g. viridis, RdBu, action potential palette) | Could |
| F-13 | Mobile / tablet touch support for orbit controls | Could |

### 1.2 Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NF-01 | Runs entirely in the browser, zero backend |
| NF-02 | No framework install required — single HTML file or simple Vite bundle |
| NF-03 | Target mesh size: up to ~200k vertices, performs acceptably (< 2s Dijkstra) |
| NF-04 | Loads on Chrome, Firefox, Safari without plugins |
| NF-05 | Clean, minimal design — mesh is the hero, UI is secondary |
| NF-06 | Accessible color choices (colorblind-friendly default palette) |

### 1.3 Out of Scope (explicitly)

- Real-time PDE solving (FitzHugh-Nagumo, monodomain, etc.)
- Server-side processing
- User accounts or persistence
- Volume rendering (surface mesh only)
- VTK pipeline beyond what vtk.js provides out of the box

---

## 2. Use Cases

### UC-01: Load and inspect a heart mesh
**Actor:** Any user  
**Trigger:** User opens the page  
**Flow:**
1. User sees a landing state with a drag-and-drop zone and a "Load example mesh" button
2. User drops a `.vtu` or `.vtk` file
3. App parses the file, builds a scene, centers the mesh on screen
4. Mesh is rendered with default surface shading
5. User drags to rotate, scrolls to zoom

**Acceptance:** Mesh appears within 3 seconds for files up to 50MB. Orbit controls feel responsive (no lag on rotate).

---

### UC-02: Trigger a wave from a surface click
**Actor:** Any user  
**Trigger:** User clicks a point on the rendered mesh surface  
**Flow:**
1. Raycast from camera through cursor finds the nearest surface vertex
2. App runs Dijkstra from that vertex across the mesh graph (weighted by edge length, uniform conductivity)
3. Each vertex receives a `activation_time = geodesic_distance / wave_speed`
4. Animation loop sweeps through time, coloring vertices by phase: resting → depolarized → repolarized → resting
5. Wave cycles once (or loops if toggle is on)

**Acceptance:** Wave starts animating within 500ms of click on a 100k-vertex mesh. Wavefront visually expands outward from the click point respecting surface curvature.

---

### UC-03: Compare healthy vs. modified tissue
**Actor:** Researcher or clinician  
**Trigger:** User loads a second mesh or enables a fibrosis overlay  
**Flow Option A (two meshes):**
1. User clicks "Add comparison mesh"
2. Second file loaded, both meshes shown side by side
3. Each mesh is independently clickable; waves animate simultaneously on both
4. User sees that the wavefront propagates differently (slower/rerouted) on the modified mesh

**Flow Option B (same mesh, painted regions):**
1. User enables "Fibrosis mode" toggle
2. Brush tool appears; user paints slow-conduction regions directly on the surface
3. Edge weights in painted region are multiplied by a slowdown factor (e.g. 5×)
4. Next wave click reflects the modified conduction landscape

**Acceptance:** Both flows should produce a visually distinguishable wavefront difference that a non-expert can interpret without explanation.

---

### UC-04: Adjust wave parameters
**Actor:** Any user  
**Trigger:** User interacts with the control panel  
**Flow:**
1. Sidebar/panel contains sliders: Wave Speed, Refractory Period, Wave Width (depolarization front thickness)
2. Changing a slider immediately affects the next triggered wave (or re-runs current)
3. A "Reset" button clears the animation and returns mesh to resting color

---

## 3. Architecture

```
cardiac-wave-viz/
├── index.html               # Entry point, single page
├── package.json             # Vite + dependencies
├── vite.config.js
├── src/
│   ├── main.js              # App init, event wiring
│   ├── ui/
│   │   ├── Panel.js         # Side panel controls (sliders, toggles)
│   │   ├── DropZone.js      # File drop / load UI
│   │   └── CompareView.js   # Side-by-side layout manager
│   ├── mesh/
│   │   ├── VTKLoader.js     # Wraps vtk.js reader → Three.js geometry
│   │   ├── MeshGraph.js     # Builds adjacency list from mesh faces
│   │   ├── Dijkstra.js      # Weighted shortest path on mesh graph
│   │   └── RegionTagger.js  # Assigns edge weights from VTU scalar fields or user painting
│   ├── wave/
│   │   ├── WaveEngine.js    # Converts distance field → time-phase animation
│   │   └── Colormap.js      # Phase → RGB mapping (action potential palette)
│   ├── renderer/
│   │   ├── SceneManager.js  # Three.js scene, camera, lights
│   │   ├── OrbitControls.js # (re-exported from Three.js examples)
│   │   └── Raycaster.js     # Click → vertex selection
│   └── utils/
│       ├── PriorityQueue.js # Binary heap for Dijkstra
│       └── Export.js        # Screenshot via canvas.toDataURL
├── public/
│   └── example_mesh.vtu     # Bundled demo mesh (synthetic heart surface)
└── tests/
    ├── mesh/
    │   ├── MeshGraph.test.js
    │   └── Dijkstra.test.js
    ├── wave/
    │   └── WaveEngine.test.js
    └── fixtures/
        ├── cube.vtu         # Simple 8-vertex mesh for unit tests
        └── sphere.vtu       # Geodesic reference mesh
```

### Technology Choices

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Bundler | Vite | Zero config, fast HMR, single `npm run build` produces a static folder |
| 3D rendering | Three.js r165+ | Mature, excellent docs, orbit controls built in |
| VTK parsing | @kitware/vtk.js (reader only) | Handles ASCII + binary VTU/VTK including compressed; Kitware-maintained |
| Graph algo | Custom Dijkstra + binary heap | vtk.js has no geodesic module; ~80 lines, fully testable, fast enough |
| Tests | Vitest | Same config as Vite, no extra setup, runs in Node |
| Styling | Plain CSS (CSS variables) | No framework overhead, full control, single file |

---

## 4. Data Flow

```
VTU File
   │
   ▼
VTKLoader.js
   │  → Three.js BufferGeometry (positions, normals, faces, scalar fields)
   │
   ▼
MeshGraph.js
   │  → adjacency list: vertex → [{neighbor, edge_weight}]
   │    edge_weight = euclidean edge length × regional_conductivity_factor
   │
   ▼
[User clicks surface]
   │
   ▼
Raycaster.js → source_vertex_index
   │
   ▼
Dijkstra.js
   │  → Float32Array of size N_vertices, value = activation_time (seconds)
   │
   ▼
WaveEngine.js
   │  → animation loop: for each frame, compute phase(v) = f(current_time, activation_time[v], refractory_period)
   │    phase ∈ {resting, depolarized, repolarizing}
   │
   ▼
Colormap.js → per-vertex color buffer updated each frame → Three.js vertex colors
   │
   ▼
SceneManager.js → rendered frame
```

---

## 5. Phased Implementation Plan

### Phase 1 — Static Viewer (Foundation)
**Goal:** Load any VTU file and spin it. Nothing else. Ship this first.

**Tasks:**
- [ ] Scaffold Vite project, install Three.js and vtk.js reader
- [ ] `VTKLoader.js`: parse VTU → extract positions + faces → Three.js `BufferGeometry`
- [ ] `SceneManager.js`: scene, perspective camera, ambient + directional lights, `MeshPhongMaterial`
- [ ] `OrbitControls.js`: mouse rotate / zoom / pan
- [ ] `DropZone.js`: drag-and-drop or file picker, triggers loader
- [ ] Landing state: centered drop zone with "or load example mesh" fallback
- [ ] Bundle example `.vtu` synthetic heart surface in `/public`
- [ ] Basic responsive layout: canvas fills viewport

**Deliverable:** Static page, loads a heart, you can spin it.  
**Estimated effort:** 2 days

---

### Phase 2 — Wave Propagation (Core Feature)
**Goal:** Click → wave. The main attraction.

**Tasks:**
- [ ] `MeshGraph.js`: iterate faces, build half-edge adjacency, compute Euclidean edge lengths
- [ ] `PriorityQueue.js`: binary min-heap
- [ ] `Dijkstra.js`: standard implementation on adjacency list, returns `Float32Array` of distances
- [ ] `Raycaster.js`: Three.js `Raycaster`, on click find intersected face → nearest vertex index
- [ ] `WaveEngine.js`:
  - Accept distance array + wave speed + refractory period parameters
  - Convert distances to activation times
  - `tick(t)` method → per-vertex phase value [0, 1]
  - Drive `requestAnimationFrame` loop
- [ ] `Colormap.js`: action potential palette (dark blue → bright orange → blue-purple → dark blue)
- [ ] Wire click handler in `main.js`
- [ ] UI: small "click the heart to trigger a wave" hint text
- [ ] Reset button

**Deliverable:** Clicking the heart triggers a geodesic wave. Looks good.  
**Estimated effort:** 3 days

---

### Phase 3 — Controls & Parameters
**Goal:** Make it interactive and understandable for non-experts.

**Tasks:**
- [ ] `Panel.js`: collapsible side panel with:
  - Wave Speed slider (0.1× – 3×)
  - Refractory Period slider
  - Colormap selector (action potential, viridis, temperature)
  - Loop toggle (wave repeats)
  - Reset button
- [ ] Connect sliders → `WaveEngine.js` parameters (live update)
- [ ] Show activation origin marker (small sphere at click point)
- [ ] Add scalar field selector: if VTU has point data fields, show a dropdown to color the resting mesh by that field (e.g. fiber angle, wall thickness)
- [ ] Performance: for meshes >150k vertices, run Dijkstra in a Web Worker to avoid blocking the UI thread

**Deliverable:** Polished single-mesh experience.  
**Estimated effort:** 2 days

---

### Phase 4 — Comparison & Region Weighting
**Goal:** Show healthy vs. modified tissue. The teaching payoff.

**Tasks:**
- [ ] `RegionTagger.js`:
  - Read point data scalar fields from VTU (e.g. a `fibrosis` field where value > 0.5 = slow tissue)
  - Map scalar → conductivity factor → edge weight multiplier in `MeshGraph.js`
- [ ] `CompareView.js`: split-screen layout, two independent `SceneManager` instances
  - Synchronized camera option (both views rotate together)
  - Independent click/wave on each side
- [ ] UI: "Load comparison mesh" button appears after first mesh is loaded
- [ ] Label banner above each view ("Healthy" / "Fibrotic" — user-editable)
- [ ] Option B (stretch): in-browser fibrosis painter using Three.js brush raycasting

**Deliverable:** Side-by-side comparison with visually different wave behavior.  
**Estimated effort:** 3 days

---

### Phase 5 — Polish & Distribution
**Goal:** Make it shareable and presentable.

**Tasks:**
- [ ] Screenshot export (`Export.js`) — canvas `toDataURL` → download PNG
- [ ] URL parameter to auto-load a mesh from a public URL (for embedding in lab website)
- [ ] `?demo=true` mode that auto-triggers a wave 2 seconds after load (for poster/conference display)
- [ ] README with setup instructions, how to prepare a VTU file, how to host on GitHub Pages
- [ ] `npm run build` → `dist/` is fully self-contained static folder
- [ ] Test on Chrome, Firefox, Safari

**Deliverable:** Deployable, shareable, conference-ready.  
**Estimated effort:** 1–2 days

---

## 6. Test Plan

### 6.1 Unit Tests (Vitest)

**`MeshGraph.test.js`**
- Given a cube mesh (8 vertices, 12 triangles): adjacency list has correct neighbor counts
- Edge weights are positive and equal Euclidean distance between vertices
- Regional factor of 5× on tagged faces produces 5× edge weights for those edges

**`Dijkstra.test.js`**
- On a flat grid mesh: distances from corner vertex match known Manhattan-like geodesic values (within 5% of analytic)
- On a sphere mesh: distances from pole match arc-length values (within 10%)
- Source vertex has distance = 0
- All vertices are reachable (no Infinity values on a connected mesh)
- Performance: 200k-vertex mesh completes in < 2000ms

**`WaveEngine.test.js`**
- At `t = activation_time[v]`, vertex `v` enters depolarized phase
- At `t = activation_time[v] + refractory_period`, vertex `v` returns to resting
- Wave speed scaling: doubling wave speed halves all activation times
- All vertices start in resting phase at `t = 0`

### 6.2 Integration Tests (manual checklist, run before each phase merge)

```
[ ] Load example_mesh.vtu → mesh appears, no console errors
[ ] Drag-and-drop a real .vtu file → loads correctly
[ ] Orbit controls: rotate, zoom, pan all work
[ ] Click on mesh → wave starts from click point
[ ] Wave visibly expands outward, does not jump or teleport
[ ] Wave refractory tail visible (color returns to resting behind front)
[ ] Wave Speed slider changes animation speed
[ ] Reset button clears wave and returns to resting color
[ ] Load two meshes → side-by-side view, both clickable
[ ] Fibrosis-tagged mesh shows slower/rerouted wave vs. healthy mesh
[ ] Screenshot export downloads a valid PNG
[ ] Works in Chrome, Firefox, Safari (latest)
[ ] No memory leaks after 10+ wave cycles (check Chrome DevTools heap)
```

### 6.3 Test Fixtures

| File | Description | Vertices | Use |
|------|-------------|----------|-----|
| `cube.vtu` | 8 vertices, 12 faces | 8 | MeshGraph unit tests |
| `sphere.vtu` | UV sphere | ~500 | Dijkstra geodesic accuracy |
| `flat_grid.vtu` | 10×10 planar grid | 100 | Distance validation |
| `heart_synth.vtu` | Synthetic prolate spheroid approximating LV | ~10k | Demo mesh, visual QA |

Generate test fixtures with a 5-line Python script using `meshio` — include this script in the repo under `scripts/generate_fixtures.py`.

---

## 7. Claude Code Usage Strategy

To move as fast as possible with Claude Code, structure your prompts by phase and module. Some specific tips:

**Start each session with context:**
```
I'm building a browser-based cardiac wave visualizer. 
Stack: Vite + Three.js + vtk.js reader. See CARDIAC_WAVE_VISUALIZER_PLAN.md for full spec.
Today we are working on Phase [N]: [goal].
```

**One module per task:**
- Ask Claude Code to implement one file at a time (e.g. "implement `Dijkstra.js` as specified")
- Paste the Data Flow section so it knows exactly what inputs/outputs to expect
- Immediately ask for the corresponding Vitest unit test in the same session

**Iteration order within a phase:**
1. Implement the module
2. Write the test
3. Run `npx vitest run` — fix failures
4. Wire into `main.js`
5. Visual QA in browser

**Specific prompts that work well with Claude Code:**
- "Implement `MeshGraph.js`. Input: Three.js `BufferGeometry` with `position` and `index` attributes. Output: `Map<number, Array<{neighbor: number, weight: number}>>`. Edge weight = Euclidean length of the edge. Export a single function `buildGraph(geometry)`."
- "Implement Dijkstra on the adjacency list from `MeshGraph.js`. Use a binary min-heap (`PriorityQueue.js`). Input: graph Map, source vertex index. Output: `Float32Array` of distances, length = vertex count. Handle disconnected graphs by leaving unreachable vertices at `Infinity`."
- "The `WaveEngine.js` should be a class. Constructor takes `{distances, waveSpeed, refractoryPeriod}`. Method `getPhase(vertexIndex, currentTime)` returns a value 0–1 where: 0 = resting, ramps to 1 at activation_time, decays back to 0 at activation_time + refractoryPeriod."

**When you get stuck on vtk.js parsing:**
- vtk.js has its own reader pipeline that is different from Three.js. The cleanest approach is to use `@kitware/vtk.js/IO/XML/XMLPolyDataReader` and then convert the output to Three.js `BufferGeometry` manually. Ask Claude Code: "Write `VTKLoader.js` that uses vtk.js `XMLPolyDataReader` to parse an ArrayBuffer from a `.vtu` file and returns a Three.js `BufferGeometry` with `position`, `normal` (compute if absent), and `index` attributes."

---

## 8. Effort Summary

| Phase | Feature | Days |
|-------|---------|------|
| 1 | Static viewer (load + orbit) | 2 |
| 2 | Wave propagation (click → wave) | 3 |
| 3 | Controls & parameters | 2 |
| 4 | Comparison & region weighting | 3 |
| 5 | Polish & deploy | 2 |
| **Total** | | **~12 days** |

Working with Claude Code actively writing the implementation: realistically **5–7 days** of calendar time at a comfortable pace, since the algorithmic core (Dijkstra, graph builder) is well-specified and Claude Code handles boilerplate very fast.

A working, conference-showable MVP (Phases 1–3) can be done in **3–4 days**.

---

## 9. Example Mesh Preparation (for your real VTU files)

Your simulation VTU files likely have volume elements (tetrahedra). The viewer needs a **surface mesh**. Prepare it once with:

```python
# scripts/extract_surface.py
import meshio

mesh = meshio.read("your_simulation.vtu")
# meshio can extract surface triangles from a tet mesh:
surface = mesh.extract_surface()   # or use pyvista: mesh.extract_surface()
meshio.write("heart_surface.vtu", surface)
```

If a scalar field like `fibrosis` or `conductivity` exists in your VTU as point data, it will be automatically available in the viewer's field selector dropdown (Phase 3) and will drive the edge weights in the wave propagation (Phase 4) with no extra work.

---

*Plan version 1.0 — ready for Claude Code implementation*
