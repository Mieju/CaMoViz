# Cardiac Wave Visualizer

A browser-based teaching/marketing tool for computational cardiac modeling groups.
Load a 3D heart surface mesh, fire an electrical wave across it, and watch a live
pseudo-ECG respond — all in the browser, with **zero backend** and **no PDE solve**.

> **Status.** Load + orbit, click → wave, and the controls dock are done. The wave
> is a lightweight **excitable medium**: each cell has a refractory period and
> conduction can be blocked by **fibrosis**, so fronts route around scar.
>
> **Emergent reentry, not a scripted spiral.** A single stimulus on intact tissue
> can't sustain reentry — its two fronts meet behind any obstacle and annihilate.
> Real anatomical reentry needs **unidirectional block**, so the **Reentry preset**
> installs a one-way conduction *gate* in the surviving scar channel. One S1 beat
> then dies one way at the gate and circulates the other way around the scar — a
> self-sustaining circuit. A unit test asserts it sustains *with* the gate and
> dies *without* it. Side-by-side compare and export are still planned
> ([`CARDIAC_WAVE_VISUALIZER_PLAN.md`](CARDIAC_WAVE_VISUALIZER_PLAN.md)).

## Contents

- [Quick start](#quick-start)
- [Using it](#using-it)
  - [Loading a mesh](#loading-a-mesh)
  - [Firing waves & S1–S2](#firing-waves--s1s2)
  - [The dock](#the-dock)
  - [The pseudo-ECG](#the-pseudo-ecg)
- [How it works](#how-it-works)
  - [Pipeline](#pipeline)
  - [From mesh to conduction graph](#from-mesh-to-conduction-graph)
  - [Propagation: an event-driven excitable medium](#propagation-an-event-driven-excitable-medium)
  - [Why reentry needs a one-way gate](#why-reentry-needs-a-one-way-gate)
  - [The pseudo-ECG, physically](#the-pseudo-ecg-physically)
  - [Relationship to the monodomain model](#relationship-to-the-monodomain-model)
- [Supported mesh formats](#supported-mesh-formats)
- [Bundled examples](#bundled-examples)
- [Scripts](#scripts)
- [Development](#development)
- [Project layout](#project-layout)
- [Roadmap](#roadmap)

## Quick start

```bash
npm install
npm run dev      # open the printed localhost URL
```

## Using it

### Loading a mesh

On the landing screen you can:

- **drag-and-drop** a `.vtu` / `.vtp` / `.vtk` file,
- click **Choose file…**, or
- click **Load example heart mesh** for the bundled anatomical heart (its `elemTag`
  regions show up in the **Regions** colour view).

The dock's **Mesh** section also offers a **VT substrate** variant — the same heart
with a synthesized fibrotic reentry channel — for the Reentry demo. Drag to rotate,
scroll to zoom, right-drag to pan.

### Firing waves & S1–S2

**Click any point on the mesh** to fire a stimulus. The clicked cell depolarizes,
conducts to its neighbours after an edge delay, then enters a **refractory** period
before it can be re-stimulated — producing a depolarization front with a
repolarization tail that settles back to rest. A marker shows the stimulus origin.

- **S1** restimulates the origin.
- **S1–S2 (two points)** delivers a paired beat: fire S1 at the white origin, then
  S2 at the cyan point (click **Set S2 point**, then the mesh — or reuse the same
  point). The **coupling interval** is measured from when the S2 *site* activates,
  so a coupling above the refractory period captures and below it blocks, wherever
  S2 sits — the classic protocol for probing block and reentry.
- Conduction speed **auto-scales to the mesh** so a front crosses in ~1.2 s
  regardless of the file's units.

### The dock

All controls live in a thin **left icon rail** that flies out one section at a time
(click the active icon, or the section's ×, to collapse back to the rail and keep
the mesh in focus).

| Section | What it holds |
|---|---|
| **Mesh** | Load another mesh; shows the active mesh's vertex/triangle count. |
| **Scenarios** | *Standard* presets plus any you save. **Healthy** fires a clean single wave from a pacing site; **Reentry** installs the one-way gate and fires one beat at the channel entrance, starting a self-sustaining circuit. **＋ Save current configuration** snapshots the live sliders + scenario as a named custom preset (`localStorage`); custom presets are deletable. |
| **Simulation** | Stimulate origin (S1); the **S1–S2** protocol; **Conduction speed / Refractory / Wave width** sliders; **Colormap** (action-potential / viridis / temperature, plus **Regions** for anatomical tags) with a live **colour key / region legend**; **Loop**; **Clear wave**. |
| **View** | Reset/save camera views, **Show ECG leads**, and the **Orientation axes** gizmo toggle. |

The mesh's `fibrosis` field is always applied: scar slows or blocks conduction and
is drawn gray, so waves route around it automatically. A top-center **transport**
pauses/resumes (or **Space**) and sets playback speed (0.25×–2×).

### The pseudo-ECG

A floating monitor (bottom-right, draggable/minimizable) shows a live 12-lead
signal. A single beat reads as one deflection; the reentry circuit reads as a fast,
regular rhythm — you *see* the VT. Buttons at the top switch leads, and the
morphology changes per lead as on a real ECG. **Show ECG leads** (View section)
toggles a 3D torso outline with electrode positions and the Einthoven triangle.
See [The pseudo-ECG, physically](#the-pseudo-ecg-physically) for the method.

## How it works

The simulation is **not** a biophysical reaction–diffusion solve. It's a fast
**event-driven excitable medium** on the mesh graph — an *eikonal / cellular-automaton*
activation model. This is what makes it run interactively in a browser tab; it's
also what bounds what it can show. This section explains the algorithm and then maps
it onto the [monodomain](#relationship-to-the-monodomain-model) model the field uses.

### Pipeline

```
mesh (.vtu/.vtp)
   └─ buildConductionGraph ──► CSR graph: edge length L, conduction factor f∈[0,1]
        └─ ExcitableMedium.step ──► event-driven front (priority queue of firing times)
             ├─ getPhase ──► colour (action-potential palette)
             └─ Σ ΔVm·edge ──► current dipole D ──► torso electrodes ──► 12-lead ECG
```

### From mesh to conduction graph

`src/mesh/ConductionGraph.js` turns the triangle surface into a **CSR adjacency
graph**. Vertices are excitable cells; each triangle edge becomes a graph edge that
stores:

- its **Euclidean length** `L`, and
- a **conduction factor** `f = min(vf[a], vf[b]) ∈ [0, 1]`, the slower of its two
  endpoints, where the per-vertex velocity field is `vf = clamp(1 − fibrosis, 0, 1)`
  (`src/main.js` `buildVelocityFactor`).

`f = 1` is healthy tissue; `0 < f < 1` is slowed scar; `f = 0` is non-conducting
block. CSR (`offsets` / `neighbors`) keeps neighbour lookup tight for the hot loop.

### Propagation: an event-driven excitable medium

`src/wave/ExcitableMedium.js` advances the front with a **priority queue of future
firing events** (a binary min-heap), keyed by time. Each frame it pops every event
due by the current sim time. For the earliest event `(v, t)`:

1. **Refractory gate** — if `t − lastFired[v] < refractoryPeriod`, **discard** the
   event: the cell hasn't recovered, so it can't re-fire.
2. Otherwise the cell **fires**: record `lastFired[v] = t`, then for each neighbour
   across edge `e` (skipping `f_e ≤ 0`) schedule its activation at

   ```
   t_neighbour = t + L_e / (v_base · f_e)
   ```

This local rule is exactly the **eikonal equation** `‖∇T‖ = 1/c` (with local speed
`c = v_base · f`) solved greedily on the graph — each cell's activation time is the
shortest *time-weighted* path from a stimulus. The base speed
`v_base = (meshScale / 1.2 s) · waveSpeed` auto-scales to the mesh (`src/main.js`).

Colour is **phenomenological**, not voltage. `getPhase(v)` maps time-since-firing to
a normalized action-potential shape: a `0 → 1` upstroke over `waveWidth`, then a
linear repolarization tail back to `0` over the remainder of `refractoryPeriod`.

That single refractory gate is enough to make the right macroscopic behaviour
*emerge*: colliding fronts **annihilate** (both sides are refractory), fibrosis
**blocks and reroutes** fronts, and — given unidirectional block — a sustained
reentrant circuit forms.

### Why reentry needs a one-way gate

A single stimulus produces a symmetric front. Around an obstacle its two arms meet
on the far side and annihilate — no reentry. Sustained anatomical reentry requires
**unidirectional block**: a region that conducts one way but not the other.

`applyOneWayGate` (`src/mesh/ConductionGraph.js`) installs exactly that. Within a
small disc on the surviving scar channel it computes the local **circulation tangent**
`t = sign · (n × radial)` (surface normal `n`, radial from obstacle centre to gate)
and zeroes the conduction factor of every *directed* edge pointing **retrograde** to
`t`. A beat entering the channel then dies one way at the gate and circulates the
other way around the scar — a self-sustaining circuit, emergent from the geometry,
not a scripted animation.

### The pseudo-ECG, physically

`src/ui/ECGMonitor.js` computes the lead signals the physiological way rather than
faking a waveform:

1. **Net current dipole** — `D = Σ ΔVm · edge`, summed over the mesh. Only cells
   that are actively de/repolarizing (changing `Vm`) contribute, so the signal is
   correctly **isoelectric** between QRS and T.
2. **Virtual torso electrodes** read the dipole field via `φ = D · r / |r|³` — limb
   electrodes in the coronal plane, precordials on the anterior chest.
3. **Standard lead combinations** — Einthoven I/II/III, Goldberger aVR/aVL/aVF,
   Wilson V1–V6 vs. the central terminal.

This is a **teaching approximation**, not a forward bidomain solve: phenomenological
phase (not biophysical mV), a thin surface (no transmural wall), and a single central
dipole (so precordial leads are only schematic). But the *pipeline* — wavefront
dipole → torso electrodes → lead differences — is the real method.

### Relationship to the monodomain model

The reference model in cardiac EP is **monodomain**, a reaction–diffusion PDE coupled
to a membrane ionic model:

```
∂Vm/∂t = (1/(β·Cm)) · ∇·(D ∇Vm) − Iion(Vm, w) / Cm
dw/dt   = f(Vm, w)
```

where `D` is the (often anisotropic) conductivity tensor, `Iion` the total ionic
current, and `w` the ionic gating/state variables (e.g. ten Tusscher, Fenton–Karma).
Conduction velocity, action-potential shape, and restitution all **emerge** from
solving this on a fine spatial grid with small time steps — accurate, but far too
heavy for a real-time browser tool.

This app instead solves an **eikonal / cellular-automaton activation model**. The
trade-offs:

| Captured faithfully | Not captured (vs monodomain) |
|---|---|
| Activation sequence & timing (eikonal arrival times) | Emergent CV — speed here is **prescribed** (`v_base · f`), not a result of upstroke + diffusion |
| Wavefront geometry on the surface | Ionic currents / gating variables `w`; phase ≠ transmembrane voltage (mV) |
| Collision **annihilation** (refractory gate) | **Restitution** — CV and APD don't depend on diastolic interval (binary refractory gate) |
| Anatomical **conduction block** & rerouting (fibrosis) | **Curvature-dependent CV** and source–sink / safety-factor effects |
| Macro-**reentry topology** around an obstacle | Subthreshold electrotonic spread; reentry must be *induced* by an imposed one-way gate, not steep restitution |
| Interactive frame rates, **zero PDE solve** | **Fiber anisotropy** `D = D∥ ff⊤ + D⊥(I − ff⊤)`; transmural wall (surface only); resolution-independence (paths live on the mesh graph) |

In short: it reproduces the *geometry and timing* of propagation and macro-reentry
convincingly and cheaply, but it is **not** a substitute for a biophysical solver. For
the full physics, see the eikonal and reaction-eikonal activation models (Colli
Franzone, Keener; Neic et al. 2017) and standard monodomain/bidomain treatments.

## Supported mesh formats

VTK XML files: **UnstructuredGrid** (`.vtu`) and **PolyData** (`.vtp`), with data
arrays in `ascii` or inline `binary` (base64), `header_type` UInt32 or UInt64,
optionally zlib-compressed (`vtkZLibDataCompressor`).

- **Surface meshes** (triangle/quad/polygon cells) are fan-triangulated directly.
- **Volume meshes** (tetra/hex/wedge/pyramid/voxel) are reduced to their **boundary
  surface** in the browser — the faces owned by exactly one cell — so raw simulation
  `.vtu` files render with no pre-processing.

Large volume meshes work but take a few seconds and a few GB of RAM (e.g. a
3.8M-tetra / 394 MB file → ~9 s, 100k surface triangles). For very large files, or to
shrink them, pre-extract the surface with [pyvista](https://docs.pyvista.org/):

```python
import pyvista as pv
pv.read("your_simulation.vtu").extract_surface().save("heart_surface.vtu")
```

**Not supported:** legacy `.vtk` ASCII/binary beyond simple XML, and **appended/raw**
binary VTK. Re-export those as inline binary or ASCII (ParaView: *Data Mode → Binary*;
meshio: `binary=True`).

## Bundled examples

Three examples ship in `public/`, derived from raw `.vtk` meshes by
[`scripts/preprocess_examples.py`](scripts/preprocess_examples.py) (boundary-surface
extraction + decimation to a browser-friendly size):

- **`example_heart.vtu`** — an **anatomical heart**. The source volume mesh's per-cell
  `elemTag` (24 anatomical regions) is carried onto the surface as a per-point
  `region` field and shown by the **Regions** colour view (click a swatch to isolate
  one region). All tissue conducts — no scar.
- **`example_heart_vt.vtu`** — the same surface plus a *synthesized* post-infarct
  **VT substrate**: a dense non-conducting **scar core**, a surviving slow
  **conducting channel** with a single entrance corridor, and the
  `pace_site` / `reentry_s1` / `gate` markers — so the **Reentry** preset induces a
  sustained reentrant circuit (after Kléber & Rudy 2004, de Bakker et al. 1993,
  Stevenson 2009). A teaching heuristic, not anatomically derived.
- **`example_torso.vtu`** — a torso surface used as the wireframe shell for the
  **Show ECG leads** overlay (the heart sits inside it, electrodes on/around it).

Raw `.vtk` sources live in `data/` (git-ignored; too large to ship).

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Production build → self-contained `dist/` |
| `npm run preview` | Serve the built `dist/` |
| `npm test` | Vitest unit tests (mesh loader, wave engine, one-way-gate reentry) |

## Development

```bash
# Tooling for the mesh scripts (needs Python; vtk for the raw .vtk readers):
python3 -m venv --system-site-packages .venv && .venv/bin/pip install meshio numpy vtk

# Rebuild the shipped examples from the raw .vtk in data/ (surface + decimate +
# elemTag→region; also writes the VT-substrate + torso variants):
.venv/bin/python scripts/preprocess_examples.py

# Regenerate the synthetic VT-substrate test fixture + loader fixtures:
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
src/ui/Dock.js              Left icon-rail + flyout that hosts every control section
src/ui/Panel.js             Simulation controls (S1–S2, params, colormap + colour key)
src/ui/PresetsPanel.js      Scenarios: standard presets + saveable custom presets
src/ui/ECGMonitor.js        Floating pseudo-ECG (lead selector + scrolling trace)
src/ui/HelpBar.js           Persistent interaction cheat-sheet (bottom-centre)
src/ui/DropZone.js          Drag-and-drop + file picker
public/example_heart.vtu    Anatomical heart surface + per-point `region` tags
public/example_heart_vt.vtu Same surface + synthesized VT substrate + markers
public/example_torso.vtu    Torso shell for the ECG lead overlay wireframe
data/                       Raw .vtk sources (git-ignored; preprocessed → public/)
scripts/preprocess_examples.py  Raw .vtk → compact browser-ready example .vtu
scripts/                    Fixture generation + smoke/validation scripts
tests/                      Vitest unit tests + fixtures
```

## Roadmap

- **Phase 4 (compare) / Phase 5 (export, share, deploy)** from
  [`CARDIAC_WAVE_VISUALIZER_PLAN.md`](CARDIAC_WAVE_VISUALIZER_PLAN.md).
</content>
</invoke>
