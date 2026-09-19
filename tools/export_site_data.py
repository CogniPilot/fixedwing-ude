#!/usr/bin/env python3
"""Export the flights and the paper's result tables for the companion site.

Reads the reproducibility package (``--acc-root``, default ``../ACC_2027``) and
writes under ``--out`` (``site/public/data``):

* ``flights/<name>.f32`` -- little-endian float32 rows on the 60 Hz model grid:
  the 12-state ``[pN,pE,pD,u,v,w,phi,theta,psi,p,q,r]``, the four sticks
  ``[roll,pitch,throttle,yaw]``, ``good`` (passes the paper's validity guards)
  and ``safe`` (SAFE mode).  Untracked samples are NaN.
* ``flights.json`` -- the manifest: per flight the airframe, what was flown, and
  the fit / development / test arcs; the hand-reviewed stall events.
* ``results.json`` -- the reference run's tables (pooled scores, by regime, by
  airframe group, paired improvement, held-out stall events).
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
COLUMNS = ["pN", "pE", "pD", "u", "v", "w", "phi", "theta", "psi", "p", "q", "r",
           "u_roll", "u_pitch", "u_throttle", "u_yaw", "good", "safe"]
ROLE_LABEL = {"fit": "fit", "development": "development", "outer": "test"}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--acc-root", type=Path, default=HERE.parents[1] / "ACC_2027")
    parser.add_argument("--out", type=Path, default=HERE.parent / "site" / "public" / "data")
    return parser.parse_args()


def numeric_rows(path):
    def convert(value):
        if value == "":
            return None
        try:
            return float(value)
        except ValueError:
            return value
    with path.open() as handle:
        return [{key: convert(value) for key, value in row.items()} for row in csv.DictReader(handle)]


def main():
    args = parse_args()
    sys.path.insert(0, str(args.acc_root / "src"))
    from acc2027 import params
    from acc2027.data import load_dataset

    data, roles = load_dataset(params.settings())
    (args.out / "flights").mkdir(parents=True, exist_ok=True)

    purposes = {}
    for session in set(params.SESSION_DIRECTORY.values()):
        manifest = json.loads((args.acc_root / "data" / session / "manifest.json").read_text())
        for record in manifest["records"]:
            purposes[record["name"]] = {"session": session, "purpose": record.get("purpose", ""),
                                        "aircraft": record.get("aircraft", "")}

    flights = []
    for airframe in params.CONFIGURATIONS:
        for name in params.SEGMENTS[airframe]:
            flight = data[name]
            state = flight["x"].astype(np.float32).copy()
            state[~np.isfinite(state).all(axis=1)] = np.nan
            table = np.column_stack((state, flight["u"], flight["good"], flight["mode"] == 1)).astype("<f4")
            (args.out / "flights" / f"{name}.f32").write_bytes(table.tobytes())
            arcs = [{"group": group, "role": ROLE_LABEL[role], "start": start, "stop": stop}
                    for group, parts in roles.items() for role, items in parts.items()
                    for segment, start, stop in items if segment == name]
            flights.append({"name": name, "airframe": airframe, **purposes.get(name, {}),
                            "samples": int(len(table)), "file": f"flights/{name}.f32",
                            "arcs": sorted(arcs, key=lambda arc: arc["start"])})

    (args.out / "flights.json").write_text(json.dumps({
        "rate_hz": params.UDE_RATE_HZ, "columns": COLUMNS, "history_samples": params.HISTORY,
        "frames": "position NED [m]; body velocity FRD [m/s]; ZYX Euler [rad]; body rates [rad/s]",
        "flights": flights}, indent=1))

    evaluation = json.loads((args.acc_root / "reference/evaluation.json").read_text())
    analysis = args.acc_root / "reference/analysis"
    results = {
        "run": json.loads((analysis / "summary.json").read_text())["run"],
        "output_names": list(params.OUTPUT_NAMES),
        "output_scale": params.OUTPUT_SCALE.tolist(),
        "methods": list(params.METHODS),
        "pooled": {horizon: {"windows": record["n_windows"],
                             "common_score": {m: v["common_score"] for m, v in record["methods"].items()},
                             "all_output_score": {m: v["all_output_score"] for m, v in record["methods"].items()}}
                   for horizon, record in evaluation["pooled"].items()},
        "by_regime": numeric_rows(analysis / "simulation_by_regime.csv"),
        "by_group": numeric_rows(analysis / "simulation_by_group.csv"),
        "events": numeric_rows(analysis / "events.csv"),
        "representative_trajectory": evaluation["representative_trajectory"],
    }
    (args.out / "results.json").write_text(json.dumps(results))
    total = sum((args.out / flight["file"]).stat().st_size for flight in flights)
    print(f"{len(flights)} flights, {total / 1e6:.1f} MB; results.json written")


if __name__ == "__main__":
    main()
