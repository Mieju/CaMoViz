#!/usr/bin/env python3
"""
Turn the raw example meshes (large legacy .vtk) into compact browser-ready .vtu
surfaces the in-app VTKLoader can read (XML UnstructuredGrid, inline binary +
zlib — the same encoding meshio produces, which the loader is tested against):

  data/example_heart.vtk  (228 MB, VTK 5.1 binary UnstructuredGrid, ~2.7M tets,
                           cell tag `elemTag` = anatomical regions)
        -> public/example_heart.vtu     boundary surface, point data `region`
        -> public/example_heart_vt.vtu  + a synthesized fibrotic reentry substrate
                                         (`fibrosis` + pace_site/reentry_s1/gate markers)

  data/example_torso.vtk  (VTK 4.2 ASCII PolyData, 4355 pts)
        -> public/example_torso.vtu     cleaned shell for the ECG lead overlay

Run:  .venv/bin/python scripts/preprocess_examples.py
"""
import os
import numpy as np
import vtk
from vtk.util.numpy_support import vtk_to_numpy, numpy_to_vtk, numpy_to_vtkIdTypeArray
import meshio

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(HERE, "public")      # shipped .vtu outputs
SRC = os.path.join(HERE, "data")        # raw .vtk inputs (git-ignored, not shipped)
TARGET_TRIS = 140_000                    # decimate the heart surface to ~this many

# Anatomical elemTag groups (Strocchi et al. 2020 four-chamber convention, verified
# against data/example_heart.vtk). We KEEP the great vessels so the anatomy is
# teachable (aorta, pulmonary artery, pulmonary veins, venae cavae — you can point at
# where the blood goes). They are non-myocardial, so at runtime they are made
# non-conducting (see NONCONDUCTING_TAGS in src/main.js): the electrical wave stays in
# the four chambers while the vessels remain as static, coloured anatomy. The
# largest-component pass keeps the outer epicardial+vessel shell (the inner endocardial
# cavity shells are separate components), and smooth_and_cap closes the truncated
# vessel ends and relaxes the surface so nothing looks like a hollow stump.
MYOCARDIUM = {1, 2, 3, 4}                     # LV, RV, LA, RA — conducting chambers
VALVE_ANNULI = {7, 8, 9, 10}                  # MV, TV, AV, PV — fibrous skeleton
GREAT_VESSELS = {5, 6} | set(range(11, 25))   # aorta, pulmonary artery, PVs, cavae + rings


def log(*a):
    print(*a, flush=True)


def read_legacy_ug(path):
    r = vtk.vtkUnstructuredGridReader()
    r.SetFileName(path)
    r.ReadAllScalarsOn()
    r.ReadAllVectorsOn()
    r.ReadAllFieldsOn()
    r.Update()
    return r.GetOutput()


def extract_surface(ug):
    surf = vtk.vtkDataSetSurfaceFilter()
    surf.SetInputData(ug)
    surf.Update()
    tri = vtk.vtkTriangleFilter()
    tri.SetInputConnection(surf.GetOutputPort())
    tri.Update()
    return tri.GetOutput()


def poly_arrays(poly):
    """vtk triangulated polydata -> (points Nx3 float32, tris Mx3 int32)."""
    pts = vtk_to_numpy(poly.GetPoints().GetData()).astype(np.float32)
    tris = vtk_to_numpy(poly.GetPolys().GetConnectivityArray()).astype(np.int32).reshape(-1, 3)
    return pts, tris


def cell_tag_to_point_mode(poly, cell_arr_name):
    """Per-point categorical region = most common incident cell tag (numpy mode)."""
    cell_tags = vtk_to_numpy(poly.GetCellData().GetArray(cell_arr_name)).astype(np.int64)
    pt_ids = vtk_to_numpy(poly.GetPolys().GetConnectivityArray()).astype(np.int64)  # 3 ids / tri
    tag_per_corner = np.repeat(cell_tags, 3)
    npts = poly.GetNumberOfPoints()
    ntags = int(cell_tags.max()) + 1
    counts = np.zeros((npts, ntags), dtype=np.int32)
    np.add.at(counts, (pt_ids, tag_per_corner), 1)
    return counts.argmax(1).astype(np.int32)


def decimate(poly, target_tris):
    n = poly.GetNumberOfCells()
    if n <= target_tris:
        return poly
    dec = vtk.vtkQuadricDecimation()
    dec.SetInputData(poly)
    dec.SetTargetReduction(1.0 - target_tris / n)
    dec.Update()
    return dec.GetOutput()


def remap_nearest(src_poly, src_vals, dst_pts):
    """Assign each dst point the value of the nearest src point (categorical-safe)."""
    loc = vtk.vtkStaticPointLocator()
    loc.SetDataSet(src_poly)
    loc.BuildLocator()
    out = np.empty(len(dst_pts), dtype=src_vals.dtype)
    for i, p in enumerate(dst_pts):
        out[i] = src_vals[loc.FindClosestPoint(p)]
    return out


def drop_regions(pts, tris, region, drop):
    """Remove every triangle that touches a vertex whose `region` tag is in `drop`,
    then compact out the now-unreferenced vertices (remapping tris + region). Because
    a triangle goes as soon as any corner is dropped, no dropped-tag vertex survives
    on the seam — the structure is fully excised, leaving a clean hole where it was
    attached. Returns (pts, tris, region)."""
    drop = set(int(d) for d in drop)
    drop_vert = np.array([r in drop for r in region])
    keep = ~drop_vert[tris].any(axis=1)
    tris = tris[keep]
    used = np.unique(tris)
    remap = np.full(len(pts), -1, np.int64)
    remap[used] = np.arange(len(used))
    tris = remap[tris].astype(np.int32)
    log(f"  dropped regions {sorted(drop)}: -{int((~keep).sum()):,} tris, "
        f"-{len(pts) - len(used):,} verts")
    return pts[used], tris.reshape(-1, 3), region[used]


def make_polydata(pts, tris):
    """numpy (pts Nx3, tris Mx3) -> vtkPolyData triangle surface."""
    vpts = vtk.vtkPoints()
    vpts.SetData(numpy_to_vtk(np.ascontiguousarray(pts, np.float32)))
    # VTK legacy cell array layout: [n, i0, i1, i2, n, ...] with n=3 per triangle.
    ntri = len(tris)
    conn = np.empty((ntri, 4), np.int64)
    conn[:, 0] = 3
    conn[:, 1:] = tris
    cells = vtk.vtkCellArray()
    cells.SetCells(ntri, numpy_to_vtkIdTypeArray(conn.ravel(), deep=1))
    poly = vtk.vtkPolyData()
    poly.SetPoints(vpts)
    poly.SetPolys(cells)
    return poly


def largest_component(pts, tris, region):
    """Keep only the largest connected surface component and merge coincident points
    (vtkConnectivityFilter + vtkCleanPolyData) — drops the small seam fragments that
    decimation/excision leave behind. Region tags are re-assigned by nearest source
    point so they stay aligned after the topology change."""
    src = make_polydata(pts, tris)
    conn = vtk.vtkConnectivityFilter()
    conn.SetInputData(src)
    conn.SetExtractionModeToLargestRegion()
    conn.Update()
    clean = vtk.vtkCleanPolyData()
    clean.SetInputConnection(conn.GetOutputPort())
    clean.ConvertLinesToPointsOff()
    clean.ConvertPolysToLinesOff()
    clean.Update()
    tri = vtk.vtkTriangleFilter()
    tri.SetInputConnection(clean.GetOutputPort())
    tri.Update()
    out_pts, out_tris = poly_arrays(tri.GetOutput())
    out_region = remap_nearest(src, region, out_pts)
    log(f"  largest component + clean: {len(pts):,}->{len(out_pts):,} pts, "
        f"{len(tris):,}->{len(out_tris):,} tris")
    return out_pts, out_tris, out_region


# Clean teaching palette: chambers + the great vessels as solid coloured groups.
TEACH_TAGS = {1: "LV", 2: "RV", 3: "LA", 4: "RA",
              5: "aorta", 6: "pulmonary artery", 7: "pulmonary veins", 8: "venae cavae"}


def consolidate_regions(pts, region):
    """Collapse the 24 raw Strocchi tags into a clean teaching set (see TEACH_TAGS).
    Chambers (1–4), aorta (5) and pulmonary artery (6) keep their tag; every other
    tag (the pulmonary-vein / vena-cava stubs and their many little annulus rings,
    which otherwise speckle the base) is folded into pulmonary veins (7) or venae
    cavae (8) by which atrium it sits nearer — LA drains the pulmonary veins, RA the
    cavae. Prevents multicoloured noise at the vessel/atrium junctions."""
    region = region.astype(np.int32).copy()
    la_c = pts[region == 3].mean(0) if (region == 3).any() else pts.mean(0)
    ra_c = pts[region == 4].mean(0) if (region == 4).any() else pts.mean(0)
    other = ~np.isin(region, [1, 2, 3, 4, 5, 6])
    to_la = np.linalg.norm(pts[other] - la_c, axis=1) < np.linalg.norm(pts[other] - ra_c, axis=1)
    grp = np.where(to_la, 7, 8).astype(np.int32)
    region[other] = grp
    log(f"  consolidated regions -> {sorted(set(int(r) for r in region))}")
    return region


def close_smooth(pts, tris, region, vox=1.0, radius_mm=13, smooth_iters=35, target_tris=90_000):
    """Give the heart a solid, teaching-clean surface. The truncated great vessels
    are hollow tubes (outer wall folding into an inner lumen), which read as dark
    pits — not open holes, so hole-filling can't touch them. Instead we voxelise the
    watertight shell, apply a binary morphological CLOSE (dilate then erode by
    `radius_mm`) that fills the narrow vessel lumens *without* ballooning the heart,
    re-contour (flying edges), decimate, and Taubin-smooth. Region tags are carried
    over from the original shell by nearest point. Result: smooth heart with solid
    vessel stubs, no sharp edges."""
    shell = make_polydata(pts, tris)
    # Pad the grid beyond the close radius so the dilation never reaches the volume
    # boundary (which would open the contour there and punch holes into the surface).
    b = np.array(shell.GetBounds()); pad = radius_mm + 5 * vox
    lo = b[0::2] - pad; hi = b[1::2] + pad
    dims = (np.ceil((hi - lo) / vox).astype(int) + 1)
    img = vtk.vtkImageData(); img.SetDimensions(*dims.tolist())
    img.SetOrigin(*lo.tolist()); img.SetSpacing(vox, vox, vox)
    img.AllocateScalars(vtk.VTK_UNSIGNED_CHAR, 1)
    img.GetPointData().GetScalars().Fill(1)
    sten = vtk.vtkPolyDataToImageStencil()
    sten.SetInputData(shell); sten.SetOutputOrigin(lo.tolist())
    sten.SetOutputSpacing(vox, vox, vox)
    sten.SetOutputWholeExtent(0, dims[0] - 1, 0, dims[1] - 1, 0, dims[2] - 1); sten.Update()
    burn = vtk.vtkImageStencil(); burn.SetInputData(img)
    burn.SetStencilConnection(sten.GetOutputPort())
    burn.ReverseStencilOff(); burn.SetBackgroundValue(0); burn.Update()
    vol = burn.GetOutput()
    a = vtk_to_numpy(vol.GetPointData().GetScalars()).reshape(dims[::-1]).astype(bool)

    def dilate(x):
        o = x.copy()
        o[1:] |= x[:-1]; o[:-1] |= x[1:]; o[:, 1:] |= x[:, :-1]; o[:, :-1] |= x[:, 1:]
        o[:, :, 1:] |= x[:, :, :-1]; o[:, :, :-1] |= x[:, :, 1:]
        return o

    def erode(x):
        o = x.copy()
        o[1:] &= x[:-1]; o[:-1] &= x[1:]; o[:, 1:] &= x[:, :-1]; o[:, :-1] &= x[:, 1:]
        o[:, :, 1:] &= x[:, :, :-1]; o[:, :, :-1] &= x[:, :, 1:]
        return o

    n = int(round(radius_mm / vox))
    for _ in range(n): a = dilate(a)
    for _ in range(n): a = erode(a)
    vol.GetPointData().SetScalars(
        numpy_to_vtk(a.astype(np.uint8).ravel(), deep=1, array_type=vtk.VTK_UNSIGNED_CHAR))

    mc = vtk.vtkFlyingEdges3D(); mc.SetInputData(vol); mc.SetValue(0, 0.5); mc.Update()
    # vtkDecimatePro with topology preservation keeps the surface watertight (quadric
    # decimation can tear small holes into the marching-cubes output → dark specks).
    dec = vtk.vtkDecimatePro(); dec.SetInputConnection(mc.GetOutputPort())
    dec.SetTargetReduction(max(0.0, 1.0 - target_tris / mc.GetOutput().GetNumberOfCells()))
    dec.PreserveTopologyOn(); dec.SplittingOff(); dec.BoundaryVertexDeletionOff(); dec.Update()
    sm = vtk.vtkWindowedSincPolyDataFilter(); sm.SetInputConnection(dec.GetOutputPort())
    sm.SetNumberOfIterations(smooth_iters); sm.SetPassBand(0.03)
    sm.BoundarySmoothingOn(); sm.FeatureEdgeSmoothingOff()
    sm.NonManifoldSmoothingOn(); sm.NormalizeCoordinatesOn(); sm.Update()
    tri = vtk.vtkTriangleFilter(); tri.SetInputConnection(sm.GetOutputPort()); tri.Update()
    out_pts, out_tris = poly_arrays(tri.GetOutput())
    out_region = remap_nearest(shell, region, out_pts)
    log(f"  morphological close + smooth: {len(pts):,}->{len(out_pts):,} pts, "
        f"{len(tris):,}->{len(out_tris):,} tris")
    return out_pts, out_tris, out_region


def write_vtu(path, pts, tris, point_data=None):
    pd = {k: np.ascontiguousarray(v, np.float32) for k, v in (point_data or {}).items()}
    mesh = meshio.Mesh(points=pts.astype(np.float32), cells=[("triangle", tris)], point_data=pd)
    meshio.write(path, mesh, binary=True)   # inline base64 + zlib (loader-tested)
    mb = os.path.getsize(path) / 1e6
    log(f"  wrote {os.path.relpath(path, HERE)}  ({len(pts):,} pts, {len(tris):,} tris, {mb:.1f} MB)")


# --- heart ------------------------------------------------------------------

def process_heart():
    src = os.path.join(SRC, "example_heart.vtk")
    log(f"heart: reading {os.path.relpath(src, HERE)} …")
    ug = read_legacy_ug(src)
    log(f"  volume: {ug.GetNumberOfPoints():,} pts, {ug.GetNumberOfCells():,} cells")

    full = extract_surface(ug)
    log(f"  surface: {full.GetNumberOfPoints():,} pts, {full.GetNumberOfCells():,} tris")
    full_region = cell_tag_to_point_mode(full, "elemTag")

    poly = decimate(full, TARGET_TRIS)
    pts, tris = poly_arrays(poly)
    if poly.GetNumberOfPoints() != full.GetNumberOfPoints():
        log(f"  decimated to {len(tris):,} tris")
        region = remap_nearest(full, full_region, pts)
    else:
        region = full_region
    log(f"  region tags present: {sorted(set(int(r) for r in region))}")

    # --- anatomy example (example_heart.vtu) ---------------------------------
    # Keep the great vessels (aorta, pulmonary artery, pulmonary veins, cavae) so the
    # anatomy is teachable — trace where the blood goes. The outer epicardial shell +
    # vessel walls are one connected component; the four inner endocardial cavity
    # shells are separate, so the largest component is exactly the outer surface.
    # Then consolidate the vessel tags to a clean palette and morphologically close +
    # smooth so vessels are solid smooth stubs with no sharp edges.
    ap, at, ar = largest_component(pts, tris, region)
    ar = consolidate_regions(ap, ar)
    ap, at, ar = close_smooth(ap, at, ar)
    log(f"  anatomy tags: {sorted(set(int(r) for r in ar))}")
    write_vtu(os.path.join(PUB, "example_heart.vtu"), ap, at, {"region": ar})

    # --- VT-substrate example (example_heart_vt.vtu) -------------------------
    # Same beautified geometry as the anatomy heart, plus the fibrotic reentry substrate
    # (fibrosis + pace_site/reentry_s1/gate markers). The scar is sized to the LV (not the
    # vessel-inflated whole-mesh diameter), and at runtime the non-conducting vessels + AV
    # block confine the wave to the ventricle, so the rotor forms cleanly here too.
    write_vtu(os.path.join(PUB, "example_heart_vt.vtu"), ap, at,
              {"region": ar, **vt_substrate(ap, at, ar)})


# --- VT substrate -----------------------------------------------------------
# Post-infarct VT substrate built with the proven core→channel→rim(+corridor)
# topology (cf. scripts/generate_fixtures.py): a dense non-conducting CORE, a thin
# slow surviving CHANNEL ring around it, and a dense RIM blocking the channel from
# the surrounding healthy myocardium *except* a single CORRIDOR mouth. Block on both
# sides forces a wave entering the corridor to travel the channel loop — so a
# one-way GATE in the channel makes it a sustained anatomical-reentry circuit (a
# small scar with no rim cannot sustain reentry: the wave just floods around it
# through healthy tissue and annihilates). Bands are GEODESIC (surface Dijkstra),
# so they stay true rings on the curved surface, and the corridor is an azimuthal
# wedge in the seed's tangent plane. Tuned offline so the Reentry preset sustains
# (see the engine port used for tuning); the same fields are validated by
# tests/wave/Reentry.test.js against this shipped file.
VT_R_CORE = 0.10        # dense core radius (geodesic, fraction of mesh diameter)
VT_R_CHAN = 0.16        # channel outer radius (slow surviving loop)
VT_R_RIM = 0.24         # dense rim outer radius (block beyond the loop)
VT_GAP_HALF = 0.60      # corridor azimuthal half-width (radians)
VT_CHANNEL_BLOCK = 0.90  # slow surviving isthmus (→ factor 0.10, ~60 mm/s). The slow scar
                          # channel is what keeps the reentry cycle longer than the refractory
                          # period at the app's absolute conduction velocity (600 mm/s).


def _adjacency(tris, n):
    nbr = [set() for _ in range(n)]
    for a, b, c in tris:
        nbr[a].update((b, c)); nbr[b].update((a, c)); nbr[c].update((a, b))
    return [sorted(s) for s in nbr]


def _geodesic_from(seed, pts, nbr):
    """Per-vertex geodesic (surface graph) distance from `seed` via Dijkstra."""
    import heapq
    d = np.full(len(pts), np.inf); d[seed] = 0.0
    pq = [(0.0, int(seed))]
    while pq:
        dd, v = heapq.heappop(pq)
        if dd > d[v]:
            continue
        for w in nbr[v]:
            nd = dd + float(np.linalg.norm(pts[v] - pts[w]))
            if nd < d[w]:
                d[w] = nd; heapq.heappush(pq, (nd, w))
    return d


def vt_substrate(pts, tris, region):
    """Synthetic post-infarct VT substrate (fibrosis + pace_site/reentry_s1/gate
    markers) on the LV free wall. See the parameter block above. Geometry-only
    heuristic — not anatomically derived."""
    pts = pts.astype(np.float64)
    tris = np.asarray(tris)
    n = len(pts)
    lv = region == 1
    if lv.sum() < 50:
        lv = np.ones(n, bool)

    # Scale the scar to the myocardium (chambers), not the whole mesh: the great vessels
    # inflate the overall diameter, which would oversize the core/channel/rim and
    # degenerate the reentry loop. (On the old chambers-only mesh the whole-mesh diameter
    # already equalled this, so the scar keeps its proven size.)
    myo = np.isin(region, [1, 2, 3, 4])
    myo = myo if myo.sum() >= 50 else np.ones(n, bool)
    myoc = pts[myo].mean(0)
    diam = np.linalg.norm(pts[myo] - myoc, axis=1).max() * 2
    lvc = pts[lv].mean(0)
    seed = int(np.where(lv)[0][np.argmax(np.linalg.norm(pts[lv] - lvc, axis=1))])
    nbr = _adjacency(tris, n)
    d = _geodesic_from(seed, pts, nbr)

    # Surface normal at the seed (area-weighted) → tangent-plane azimuth for the
    # corridor wedge, undistorted by the surface curvature.
    fnorm = np.cross(pts[tris[:, 1]] - pts[tris[:, 0]], pts[tris[:, 2]] - pts[tris[:, 0]])
    vn = np.zeros((n, 3))
    for k in range(3):
        np.add.at(vn, tris[:, k], fnorm)
    sn = vn[seed] / (np.linalg.norm(vn[seed]) or 1)
    ref = np.array([0.0, 0.0, 1.0])
    e1 = ref - np.dot(ref, sn) * sn
    if np.linalg.norm(e1) < 1e-6:
        e1 = np.array([0.0, 1.0, 0.0]) - np.dot([0, 1, 0], sn) * sn
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(sn, e1)
    vseed = pts - pts[seed]
    alpha = np.arctan2(vseed @ e2, vseed @ e1)

    core, chan, rim = VT_R_CORE * diam, VT_R_CHAN * diam, VT_R_RIM * diam
    fib = np.zeros(n, np.float32)
    inb = lv & (d < rim)
    fib[inb & (d < chan)] = VT_CHANNEL_BLOCK          # slow channel
    fib[inb & (d < core)] = 1.0                       # dense core
    ring = inb & (d >= chan) & (d < rim)
    # Corridor = a single azimuthal gap in the dense rim (the mouth the wave enters).
    # Widen the wedge until it actually captures a mouth — the rim band is thin, so on
    # a coarse/decimated surface a fixed wedge can miss every vertex (leaving a sealed
    # rim = no reentry). Guarantees a non-empty corridor regardless of vertex density.
    ring_idx = np.where(ring)[0]
    ang = np.abs((alpha[ring_idx] + np.pi) % (2 * np.pi) - np.pi)  # angular dist from 0
    corridor = np.zeros(n, bool)
    if len(ring_idx):
        gap = VT_GAP_HALF
        while gap <= np.pi:
            sel = ring_idx[ang < gap]
            if len(sel) >= 6:
                corridor[sel] = True
                break
            gap *= 1.3
        if not corridor.any():                       # last resort: closest-in-angle
            corridor[ring_idx[np.argsort(ang)[:8]]] = True
    fib[ring] = 1.0                                   # dense rim
    fib[corridor] = VT_CHANNEL_BLOCK                  # corridor mouth (gap in rim)

    def one_hot(idx):
        a = np.zeros(n, np.float32); a[idx] = 1.0
        return a

    channel = (fib > 0.3) & (fib < 0.95)
    # gate: channel vertex deepest into the corridor mouth (one-way valve site).
    cc = np.where(corridor & channel)[0]
    gate_idx = int(cc[np.argmax(d[cc])]) if len(cc) else int(np.where(channel)[0][0])
    # reentry_s1: healthy vertex just outside the corridor mouth (S1 enters here).
    ca = float(np.mean(alpha[corridor])) if corridor.any() else 0.0
    healthy = fib <= 0.05
    mouth = healthy & (d > rim) & (d < rim * 1.6) & \
        (np.abs((alpha - ca + np.pi) % (2 * np.pi) - np.pi) < VT_GAP_HALF)
    s1_idx = int(np.where(mouth)[0][np.argmin(d[mouth])]) if mouth.any() \
        else int(np.where(healthy)[0][np.argmin(d[healthy])])
    # pace_site: healthy myocardium far from the scar (clean Healthy-preset wave).
    pace_idx = int(np.where(healthy)[0][np.argmax(d[healthy])])

    log(f"  VT substrate: core={int((fib >= 0.95).sum())} channel={int(channel.sum())} "
        f"corridor={int(corridor.sum())} gate={gate_idx} s1={s1_idx} pace={pace_idx}")
    return {
        "fibrosis": fib,
        "pace_site": one_hot(pace_idx),
        "reentry_s1": one_hot(s1_idx),
        "gate": one_hot(gate_idx),
    }


# --- torso ------------------------------------------------------------------

def process_torso():
    src = os.path.join(SRC, "example_torso.vtk")
    log(f"torso: reading {os.path.relpath(src, HERE)} …")
    r = vtk.vtkPolyDataReader()
    r.SetFileName(src)
    r.Update()
    tri = vtk.vtkTriangleFilter()
    tri.SetInputData(r.GetOutput())
    tri.Update()
    pts, tris = poly_arrays(tri.GetOutput())
    write_vtu(os.path.join(PUB, "example_torso.vtu"), pts, tris)


if __name__ == "__main__":
    process_torso()
    process_heart()
    log("done.")
