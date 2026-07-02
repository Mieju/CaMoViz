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
from vtk.util.numpy_support import vtk_to_numpy
import meshio

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(HERE, "public")      # shipped .vtu outputs
SRC = os.path.join(HERE, "data")        # raw .vtk inputs (git-ignored, not shipped)
TARGET_TRIS = 140_000                    # decimate the heart surface to ~this many
DROP_REGIONS = {5}                       # elemTags to cut from the heart surface (5 = aorta)


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

    pts, tris, region = drop_regions(pts, tris, region, DROP_REGIONS)

    write_vtu(os.path.join(PUB, "example_heart.vtu"), pts, tris, {"region": region})
    write_vtu(os.path.join(PUB, "example_heart_vt.vtu"), pts, tris, vt_substrate(pts, tris, region))


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
VT_CHANNEL_BLOCK = 0.62  # slow channel block (→ conduction factor 0.38)


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

    diam = np.linalg.norm(pts - pts.mean(0), axis=1).max() * 2
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
    corridor = ring & (np.abs((alpha + np.pi) % (2 * np.pi) - np.pi) < VT_GAP_HALF)
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
