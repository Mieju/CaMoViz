#!/usr/bin/env python3
"""Generate demo + test mesh fixtures for the Cardiac Wave Visualizer.

Outputs (ASCII .vtu so the vtk.js reader and unit tests parse them trivially):
  public/example_mesh.vtu   synthetic prolate-spheroid LV surface (demo)
  tests/fixtures/cube.vtu   8-vertex / 12-triangle cube (loader unit test)

Usage:
    pip install meshio numpy
    python3 scripts/generate_fixtures.py
"""
import os
import numpy as np
import meshio

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# --- example-mesh substrate parameters --------------------------------------
# Physiologically motivated post-infarct ventricular-tachycardia (VT) substrate.
# Healed transmural scar is non-conducting except for narrow surviving myocyte
# bundles, which form a *protected conducting channel*. When that channel closes
# on itself it is a reentry circuit; a wave trapped circulating in it is sustained
# monomorphic VT, periodically exiting to activate the rest of the ventricle.
# After:
#   - Kléber AG, Rudy Y. "Basic mechanisms of cardiac impulse propagation and
#     associated arrhythmias." Physiol Rev 84:431-488 (2004) — normal ventricular
#     CV ~0.5-0.7 m/s, with strong regional/structural variation.
#   - de Bakker JMT et al. "Slow conduction in the infarcted human heart.
#     'Zigzag' course of activation." Circulation 88:915-926 (1993) — surviving
#     bundles in dense scar form a slow protected channel.
#   - Stevenson WG. "Ventricular scars and ventricular tachycardia." (2009) — the
#     VT circuit runs through a slow isthmus/channel bounded by dense scar, with
#     an entrance and exit to the surrounding myocardium.
#
# Geometry (geodesic radius d and azimuth α about the scar centre):
#   d < R_CORE                       dense scar core           block 1.00
#   R_CORE ≤ d < R_CHAN              surviving channel (loop)  block CHANNEL_BLOCK
#   R_CHAN ≤ d < R_RIM, |α-α_gap|<g  entrance/exit corridor    block CHANNEL_BLOCK
#   R_CHAN ≤ d < R_RIM (elsewhere)   dense scar rim            block 1.00
#   d ≥ R_RIM                        healthy myocardium        block 0.00
# The channel band is a closed conducting ring (a true one-way circuit when
# unidirectional block is set up); the corridor is its single mouth to the
# healthy tissue. Block 0→1 maps to conduction velocity factor 1→0 in the app.
SCAR_TH0, SCAR_PH0 = 1.20, 0.0     # scar centre on the shell (polar, azimuth)
SCAR_R_CORE = 0.17                 # dense core radius (inner wall of the channel)
SCAR_R_CHAN = 0.31                 # channel outer radius (outer wall of the loop)
SCAR_R_RIM = 0.46                  # dense rim outer radius (block beyond the loop)
CHANNEL_BLOCK = 0.62               # slow surviving channel (factor 0.38)
GAP_HALF = 0.22                    # azimuthal half-width of the entrance corridor
GAP_ALPHA = 0.0                    # corridor azimuth about the scar (0 = toward base)

# Site anchors (stored as xyz so the nearest mesh vertex is marked, robust to
# remeshing). PACE_SITE is healthy myocardium for the Healthy preset's clean
# wave. The Reentry preset induces a real anatomical-reentry circuit: a
# unidirectional GATE in the scar channel (one-way conduction block) plus a
# single S1 beat at REENTRY_S1 (the channel's entrance corridor). The wave dies
# one way at the gate and circulates the other way around the channel loop — a
# sustained, *emergent* reentry (no seeded spiral). Gate/S1 found by
# scripts/experiment_gate.mjs.
PACE_SITE_XYZ = (0.30, 0.62, 1.21)
REENTRY_S1_XYZ = (0.99, 0.00, -0.26)
GATE_XYZ = (0.805, 0.085, 0.999)


def _sphere_dir(th, ph):
    return np.array([np.sin(th) * np.cos(ph), np.sin(th) * np.sin(ph), np.cos(th)])


def prolate_spheroid_surface(n_theta=90, n_phi=180, a=1.0, c=1.7):
    """Triangulated prolate spheroid (a = equatorial radius, c = polar) ~ an LV shell.

    Theta is offset off the exact poles (THETA_MIN) so the apex/base are small
    openings rather than rings of coincident vertices — the UV-sphere pole would
    otherwise collapse n_phi points onto one location, creating zero-length edges
    that corrupt the conduction graph. A basal opening is anatomically apt (the
    LV is open at the valve plane).
    """
    THETA_MIN = 0.06
    thetas = np.linspace(THETA_MIN, np.pi - THETA_MIN, n_theta)   # polar angle
    phis = np.linspace(0.0, 2.0 * np.pi, n_phi, endpoint=False)

    pts = []
    for th in thetas:
        for ph in phis:
            x = a * np.sin(th) * np.cos(ph)
            y = a * np.sin(th) * np.sin(ph)
            z = c * np.cos(th)
            pts.append((x, y, z))
    pts = np.array(pts, dtype=np.float64)

    def vid(i, j):
        return i * n_phi + (j % n_phi)

    tris = []
    for i in range(n_theta - 1):
        for j in range(n_phi):
            a0, b0 = vid(i, j), vid(i, j + 1)
            a1, b1 = vid(i + 1, j), vid(i + 1, j + 1)
            tris.append((a0, b0, a1))
            tris.append((b0, b1, a1))
    tris = np.array(tris, dtype=np.int64)

    # A simple scalar field (apex-to-base gradient) so later phases have point data.
    activation = (pts[:, 2] - pts[:, 2].min()) / (np.ptp(pts[:, 2]) + 1e-9)

    # Regional conduction-block field (see the parameter block above). Distance is
    # geodesic on the unit sphere; azimuth α about the scar centre is measured in
    # the tangent plane there (a log map), so the channel/corridor are true
    # geodesic shapes, undistorted near the poles.
    p0 = _sphere_dir(SCAR_TH0, SCAR_PH0)
    e1 = np.array([np.cos(SCAR_TH0) * np.cos(SCAR_PH0),   # tangent in +theta
                   np.cos(SCAR_TH0) * np.sin(SCAR_PH0),
                   -np.sin(SCAR_TH0)])
    e2 = np.array([-np.sin(SCAR_PH0), np.cos(SCAR_PH0), 0.0])  # tangent in +phi

    fib = []
    for th in thetas:
        for ph in phis:
            u = _sphere_dir(th, ph)
            d = np.arccos(np.clip(np.dot(u, p0), -1.0, 1.0))  # geodesic distance
            alpha = np.arctan2(np.dot(u, e2), np.dot(u, e1))  # azimuth about scar
            if d < SCAR_R_CORE:
                fib.append(1.0)                               # dense core
            elif d < SCAR_R_CHAN:
                fib.append(CHANNEL_BLOCK)                     # surviving channel (loop)
            elif d < SCAR_R_RIM:
                dα = abs((alpha - GAP_ALPHA + np.pi) % (2 * np.pi) - np.pi)
                fib.append(CHANNEL_BLOCK if dα < GAP_HALF else 1.0)  # corridor vs rim
            else:
                fib.append(0.0)                               # healthy myocardium
    fibrosis = np.array(fib, dtype=np.float64)

    # One-hot site markers (nearest vertex to each anchor). Pace + reentry-S1 are
    # restricted to healthy tissue; the gate is restricted to the scar channel.
    healthy = fibrosis < 0.1
    channel = (fibrosis > 0.3) & (fibrosis < 0.95)
    pace_site = _one_hot_nearest(pts, np.array(PACE_SITE_XYZ), mask=healthy)
    reentry_s1 = _one_hot_nearest(pts, np.array(REENTRY_S1_XYZ), mask=healthy)
    gate = _one_hot_nearest(pts, np.array(GATE_XYZ), mask=channel)

    return meshio.Mesh(
        points=pts,
        cells=[("triangle", tris)],
        point_data={
            "apex_base": activation.astype(np.float64),
            "fibrosis": fibrosis,
            "pace_site": pace_site,
            "reentry_s1": reentry_s1,
            "gate": gate,
        },
    )


def _one_hot_nearest(pts, target, mask=None):
    """1.0 at the single vertex nearest `target` (within `mask` if given), else 0."""
    d2 = np.sum((pts - target) ** 2, axis=1)
    if mask is not None:
        d2 = np.where(mask, d2, np.inf)
    out = np.zeros(len(pts), dtype=np.float64)
    out[int(np.argmin(d2))] = 1.0
    return out


def unit_cube_surface():
    """8 vertices, 12 triangles — a closed cube surface."""
    pts = np.array([
        [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
        [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
    ], dtype=np.float64)
    tris = np.array([
        [0, 2, 1], [0, 3, 2],   # bottom (z=0)
        [4, 5, 6], [4, 6, 7],   # top (z=1)
        [0, 1, 5], [0, 5, 4],   # front (y=0)
        [2, 3, 7], [2, 7, 6],   # back (y=1)
        [1, 2, 6], [1, 6, 5],   # right (x=1)
        [3, 0, 4], [3, 4, 7],   # left (x=0)
    ], dtype=np.int64)
    return meshio.Mesh(points=pts, cells=[("triangle", tris)])


def write_uint64_uncompressed_tets(path):
    """Hand-write a UInt64 / uncompressed / inline-binary .vtu of two tetrahedra
    sharing one face — mirrors a raw simulation export (e.g. block.vtu).

    Boundary surface = 8 cell faces − 2 shared = 6 triangles.
    """
    import base64

    points = np.array([
        [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1],
    ], dtype="<f8")
    # Tet A = (0,1,2,3), Tet B = (1,2,3,4); they share face (1,2,3).
    connectivity = np.array([0, 1, 2, 3, 1, 2, 3, 4], dtype="<i8")
    offsets = np.array([4, 8], dtype="<i8")
    types = np.array([10, 10], dtype="<u1")  # VTK_TETRA

    def data_array(arr, vtk_type, name, ncomp=1):
        payload = arr.tobytes()
        header = np.array([len(payload)], dtype="<u8").tobytes()
        b64 = base64.b64encode(header + payload).decode("ascii")
        comp = f' NumberOfComponents="{ncomp}"' if ncomp != 1 else ""
        return (f'<DataArray type="{vtk_type}" Name="{name}" '
                f'format="binary"{comp}>{b64}</DataArray>')

    xml = (
        '<?xml version="1.0"?>\n'
        '<VTKFile type="UnstructuredGrid" byte_order="LittleEndian" header_type="UInt64">\n'
        '<UnstructuredGrid>\n'
        f'<Piece NumberOfPoints="{len(points)}" NumberOfCells="{len(offsets)}">\n'
        '<Points>\n'
        + data_array(points, "Float64", "Points", ncomp=3) + '\n'
        '</Points>\n<Cells>\n'
        + data_array(connectivity, "Int64", "connectivity") + '\n'
        + data_array(offsets, "Int64", "offsets") + '\n'
        + data_array(types, "UInt8", "types") + '\n'
        '</Cells>\n</Piece>\n</UnstructuredGrid>\n</VTKFile>\n'
    )
    with open(path, "w") as f:
        f.write(xml)


def main():
    example_path = os.path.join(ROOT, "public", "example_mesh.vtu")
    cube_path = os.path.join(ROOT, "tests", "fixtures", "cube.vtu")
    os.makedirs(os.path.dirname(example_path), exist_ok=True)
    os.makedirs(os.path.dirname(cube_path), exist_ok=True)

    # ASCII so the output is small-dependency-friendly and test-readable.
    meshio.write(example_path, prolate_spheroid_surface(), binary=False)
    meshio.write(cube_path, unit_cube_surface(), binary=False)
    # Compressed-binary twin of the cube — exercises the base64 + zlib read path
    # (the encoding real simulation .vtu files use).
    cube_bin_path = os.path.join(ROOT, "tests", "fixtures", "cube_binary.vtu")
    meshio.write(cube_bin_path, unit_cube_surface(), binary=True)
    # UInt64 / uncompressed / volume tetrahedra — mirrors raw simulation exports.
    tet_path = os.path.join(ROOT, "tests", "fixtures", "tets_uint64.vtu")
    write_uint64_uncompressed_tets(tet_path)
    print(f"wrote {example_path}")
    print(f"wrote {cube_path}")
    print(f"wrote {cube_bin_path}")
    print(f"wrote {tet_path}")


if __name__ == "__main__":
    main()
