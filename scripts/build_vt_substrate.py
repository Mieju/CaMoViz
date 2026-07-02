#!/usr/bin/env python3
"""Rewrite public/example_heart_vt.vtu from the existing public/example_heart.vtu,
keeping the heart geometry byte-identical and only (re)computing the VT-substrate
fields (fibrosis + pace_site/reentry_s1/gate). Use this to retune the reentry
substrate without re-extracting from the raw 228 MB .vtk.

Run:  .venv/bin/python scripts/build_vt_substrate.py
"""
import os
import numpy as np
import meshio
from preprocess_examples import vt_substrate, write_vtu, PUB, HERE


def main():
    src = os.path.join(PUB, "example_heart.vtu")
    m = meshio.read(src)
    pts = m.points.astype(np.float32)
    tris = m.cells_dict["triangle"].astype(np.int32)
    region = m.point_data["region"].astype(np.int64)
    print(f"loaded {os.path.relpath(src, HERE)}: {len(pts):,} pts, {len(tris):,} tris")
    fields = vt_substrate(pts, tris, region)
    write_vtu(os.path.join(PUB, "example_heart_vt.vtu"), pts, tris, fields)


if __name__ == "__main__":
    main()
