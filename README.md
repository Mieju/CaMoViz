# Cardiac Wave Visualizer

Browser-based teaching/marketing tool for computational cardiac modeling groups.
Loads a 3D heart surface mesh, renders it with shading, and lets you orbit it.
Zero backend — runs entirely in the browser.

> **Status:** Phases 1–3 done (load + orbit, click → wave, controls panel), plus
> a Phase-4 start: the wave is a lightweight **excitable medium** — each cell has
> a refractory period and conduction can be blocked by **fibrosis**, so waves
> route around scar tissue. Side-by-side comparison and export are still planned
> in [`CARDIAC_WAVE_VISUALIZER_PLAN.md`](CARDIAC_WAVE_VISUALIZER_PLAN.md).
>
> **Emergent reentry.** The wave is one smooth excitable medium
> (`ExcitableMedium`). A single stimulus on intact tissue can't sustain reentry —
> its two fronts meet behind any obstacle and annihilate. Real anatomical reentry
> needs **unidirectional block**, so the **Reentry preset** installs a one-way
> conduction *gate* in the surviving scar channel (`applyOneWayGate`: it zeroes
> the retrograde direction of edges in a small patch). A single S1 beat at the
> channel entrance then dies one way at the gate and circulates the other way
> around the scar — a sustained, *emergent* reentrant circuit, not a scripted
> spiral. A unit test asserts it sustains with the gate and dies without it.

## Quick start

```bash
npm install
npm run dev      # open the printed localhost URL
```

On the landing screen, drag-and-drop a `.vtu` / `.vtp` / `.vtk` file, click
**Choose file…**, or click **Load example heart mesh** for the bundled demo.
Drag to rotate, scroll to zoom, right-drag to pan.

**Click any point on the mesh** to fire a stimulus. The tissue is modeled as a
lightweight **excitable medium**: the cell depolarizes, conducts to its
neighbours after an edge delay (length / conduction speed), then enters a
**refractory** period before it can be re-stimulated. The result is a
depolarization front with a repolarization tail that settles back to rest. A
marker shows the stimulus origin. Use the **S1–S2** control for a paired beat
from two points, or enable pacing. Conduction speed auto-scales to the mesh so
the front crosses in ~1.2 s regardless of the file's units.

The **Controls** panel (top-right) tunes the sim live:

- **Presets** — one click loads a coherent setup *and a starting point*.
  **Healthy** fires a clean single wave from a pacing site. **Reentry** installs
  the one-way gate and fires one beat at the channel entrance, starting a
  self-sustaining anatomical-reentry circuit around the scar. Each preset marks
  its origin.
- **Conduction speed / Refractory / Wave width** — propagation speed, recovery
  time, and depolarization-front thickness.
- **S1–S2 (two points)** — fire S1 at the white origin, then S2 at the cyan point
  (click **Set S2 point**, then the mesh) or the same point. The **coupling
  interval** is measured from when the S2 site is activated, so a coupling above
  the refractory period captures and below it blocks (a premature beat) — wherever
  the S2 site sits. Two independent sites show wave **collision**, **fusion**, and
  unidirectional **block**.
- **Colormap** — action-potential, viridis, or temperature.
- **Loop** — repeatedly stimulate the origin. **Reset** — clear.

A floating **pseudo-ECG** (left, draggable/minimizable) computes a real 12-lead
signal the physiological way: the heart's net **current dipole** `D = Σ ΔVm·edge`
(only wavefronts contribute, so it's isoelectric between QRS and T) is read by
**virtual torso electrodes** — limb leads in the coronal plane, precordials on the
anterior chest — via `φ = D·r/|r|³`, then combined per the standard lead
definitions (Einthoven I/II/III, Goldberger aVR/aVL/aVF, Wilson V1–V6 vs. the
central terminal). Buttons at the top switch leads, and the morphology changes per
lead as on a real ECG. A single beat reads as one deflection; the reentry circuit
reads as a fast, regular rhythm — you *see* the VT. **Show ECG leads** (top-left)
toggles a 3D torso outline with the electrode positions and the Einthoven
triangle, to show where the leads run.

This is a teaching approximation, not a forward solver: it uses a phenomenological
phase (not biophysical mV), a thin surface (no transmural wall), and a single
central dipole (so the precordial leads are only schematic). The pipeline —
wavefront dipole → torso electrodes → lead differences — is the real method. A small 3D axis gizmo
(bottom-left, eye toggle) shows mesh orientation; a top-center **transport**
pauses/resumes (or **Space**) and sets playback speed (0.25×–2×).

The mesh's `fibrosis` field is always applied: scar slows or blocks conduction
and is drawn gray, so waves route around it automatically.

The bundled example mesh is a post-infarct **ventricular-tachycardia substrate**:
a dense non-conducting **scar core**, a surviving slow **conducting channel**
looping around it (with a single entrance corridor to the healthy myocardium),
and surrounding healthy tissue — after Kléber & Rudy (Physiol Rev 2004), de
Bakker et al. (Circulation 1993) and Stevenson (2009). The channel loop is the
reentry circuit; the **Reentry** preset adds a one-way gate in it so a single
beat circulates the loop.

## Supported mesh formats

VTK XML files: **UnstructuredGrid** (`.vtu`) and **PolyData** (`.vtp`), with data
arrays in `ascii` or inline `binary` (base64), `header_type` UInt32 or UInt64,
optionally zlib-compressed (`vtkZLibDataCompressor`).

- **Surface meshes** (triangle/quad/polygon cells) are fan-triangulated directly.
- **Volume meshes** (tetra/hex/wedge/pyramid/voxel) are reduced to their
  **boundary surface** in the browser — the faces owned by exactly one cell — so
  raw simulation `.vtu` files render with no pre-processing.

Large volume meshes work but take a few seconds and a few GB of RAM (e.g. a
3.8M-tetra / 394 MB file → ~9 s, 100k surface triangles). For very large files
or to shrink them, pre-extract the surface with
[pyvista](https://docs.pyvista.org/):

```python
import pyvista as pv
pv.read("your_simulation.vtu").extract_surface().save("heart_surface.vtu")
```

Not supported: legacy `.vtk` ASCII/binary beyond simple XML, and **appended/raw**
binary VTK. Re-export those as inline binary or ASCII (ParaView: *Data Mode →
Binary*; meshio: `binary=True`).

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Production build → self-contained `dist/` |
| `npm run preview` | Serve the built `dist/` |
| `npm test` | Vitest unit tests (mesh loader, wave engine, one-way-gate reentry) |

## Development

```bash
# Regenerate the demo mesh + test fixtures (needs Python + meshio):
python3 -m venv .venv && .venv/bin/pip install meshio numpy
.venv/bin/python scripts/generate_fixtures.py

# Headless browser smoke tests (needs Playwright chromium installed):
npm run preview &                                  # note the printed port
SMOKE_URL=http://localhost:4173/ node scripts/smoke.mjs           # load → wave
SMOKE_URL=http://localhost:4173/ node scripts/reentry_smoke.mjs   # reentry renders/animates

# Re-find / re-validate the one-way gate that induces reentry (Node, no browser):
node scripts/experiment_gate.mjs
```

## Project layout

```
index.html                  Landing overlay + canvas mount
src/main.js                 App wiring (load → render → stimulate → simulate)
src/renderer/               SceneManager, OrbitControls, Raycaster (click→vertex)
src/mesh/VTKLoader.js       VTU/VTP XML → Three.js BufferGeometry
src/mesh/ConductionGraph.js Mesh → CSR graph; conduction factors + one-way gate
src/wave/ExcitableMedium.js Event-driven excitable medium (the wave engine)
src/wave/Colormap.js        Phase → RGB (action-potential palette + others)
src/utils/PriorityQueue.js  Binary min-heap (event queue)
src/ui/Panel.js             Controls panel (presets, params, colormap, fields, S1–S2, pacing)
src/ui/DropZone.js          Drag-and-drop + file picker
public/example_mesh.vtu     Demo mesh (LV surface + post-infarct VT scar substrate)
scripts/                    Fixture generation + smoke/validation scripts
tests/                      Vitest unit tests + fixtures
```

## TODO / next up

- **Phase 4 (compare) / Phase 5 (export, share, deploy)** from
  [`CARDIAC_WAVE_VISUALIZER_PLAN.md`](CARDIAC_WAVE_VISUALIZER_PLAN.md).
