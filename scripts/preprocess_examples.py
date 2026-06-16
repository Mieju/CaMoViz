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

    write_vtu(os.path.join(PUB, "example_heart.vtu"), pts, tris, {"region": region})
    write_vtu(os.path.join(PUB, "example_heart_vt.vtu"), pts, tris, vt_substrate(pts, region))


def vt_substrate(pts, region):
    """
    Best-effort synthetic VT substrate on the new anatomy: a dense scar core + a
    thin surviving conducting channel with one entrance corridor on the LV free
    wall, plus the markers the Reentry preset needs (pace_site / reentry_s1 /
    gate). Geometry-only heuristic — not anatomically derived.
    """
    pts = pts.astype(np.float64)
    n = len(pts)
    lv = region == 1
    if lv.sum() < 50:
        lv = np.ones(n, bool)

    c = pts[lv].mean(0)
    diam = np.linalg.norm(pts - c, axis=1).max() * 2
    seed = np.where(lv)[0][np.argmax(np.linalg.norm(pts[lv] - c, axis=1))]
    s = pts[seed]
    ds = np.linalg.norm(pts - s, axis=1)

    core_r, chan_r = 0.16 * diam, 0.26 * diam
    fib = np.zeros(n, np.float32)
    fib[ds < chan_r] = 0.55                       # surviving slow channel ring
    fib[ds < core_r] = 1.0                        # dense non-conducting core
    ang = np.arctan2((pts - s)[:, 1], (pts - s)[:, 0])
    corridor = (np.abs(ang) < 0.5) & (ds < chan_r) & (ds > core_r * 0.8)
    fib[corridor] = 0.55                          # open one entrance corridor
    fib[~lv] = 0.0

    def one_hot(idx):
        a = np.zeros(n, np.float32)
        a[idx] = 1.0
        return a

    healthy = np.where(fib < 0.05)[0]
    pace_idx = healthy[np.argmax(ds[healthy])] if len(healthy) else int(np.argmax(ds))
    ent = np.where(corridor)[0]
    s1_idx = int(ent[0]) if len(ent) else int(np.argmin(np.abs(ds - chan_r)))
    gate_idx = int(ent[len(ent) // 2]) if len(ent) else s1_idx

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
