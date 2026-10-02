#!/usr/bin/env python3
"""Export the paper's stored forecasts for the flight explorer.

Reads ``reference/predictions/`` of the reproducibility package (``--acc-root``,
default ``../ACC_2027``) and writes under ``--out`` (``site/public/data``):

* ``forecasts/<name>.f32`` -- little-endian float32 rows, one row per 60 Hz
  sample of a forecast window, 45 columns: the nine measured outputs
  ``[phi, theta, p, q, r, V, gamma, alpha, beta]`` followed by the same nine
  outputs forecast by ARX, OEM, instantaneous UDE and temporal UDE.  Windows of
  one file follow each other; ``forecasts.json`` says where each starts.
* ``forecasts.json`` -- every window: file, first row, number of steps, flight,
  start sample, horizon and kind (held-out test window, stall event, or the
  ten-second representative forecast), plus the stall priors used for the
  incidence reference line.

Nothing is simulated on the site: these are exactly the forecasts the paper's
tables and figures are computed from.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
METHODS = ["arx", "oem", "instantaneous", "temporal"]
HORIZONS = ["0.5", "1", "2", "5"]
GROUPS = ["SC6", "SC7", "SC9_nominal", "SC9_stall"]


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--acc-root", type=Path, default=HERE.parents[1] / "ACC_2027")
    parser.add_argument("--out", type=Path, default=HERE.parent / "site" / "public" / "data")
    return parser.parse_args()


def rows(cache, index=None):
    """(T, 45) float32: measured outputs then each method's forecast."""
    pick = (lambda key: cache[key][index]) if index is not None else (lambda key: cache[key])
    return np.column_stack([pick("measured")] + [pick(method) for method in METHODS]).astype("<f4")


def main():
    args = parse_args()
    sys.path.insert(0, str(args.acc_root / "src"))
    from acc2027 import params

    predictions = args.acc_root / "reference" / "predictions"
    out = args.out / "forecasts"
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("*.f32"):
        stale.unlink()
    windows = []
    rate = params.UDE_RATE_HZ

    for group in GROUPS:
        for horizon in HORIZONS:
            path = predictions / f"{group}_{horizon}s.npz"
            if not path.exists():
                continue
            with np.load(path, allow_pickle=False) as cache:
                steps = len(cache["time_s"]) - 1
                blocks = []
                for k in range(len(cache["segment"])):
                    windows.append({"file": f"forecasts/{group}_{horizon}s.f32", "row": k * (steps + 1), "steps": steps,
                                    "segment": str(cache["segment"][k]), "start": int(cache["start_index"][k]),
                                    "horizon": horizon, "kind": "test", "group": group})
                    blocks.append(rows(cache, k))
            (out / f"{group}_{horizon}s.f32").write_bytes(np.concatenate(blocks).tobytes())

    with (args.acc_root / "reference" / "analysis" / "events.csv").open() as handle:
        measured_rows = [row for row in csv.DictReader(handle) if row["method"] == "measured"]
    for record in measured_rows:
        number = int(float(record["event"]))
        with np.load(predictions / f"event_{number:02d}.npz", allow_pickle=False) as cache:
            table = rows(cache)
        (out / f"event_{number:02d}.f32").write_bytes(table.tobytes())
        windows.append({"file": f"forecasts/event_{number:02d}.f32", "row": 0, "steps": len(table) - 1,
                        "segment": record["segment"], "start": int(round(float(record["forecast_start_s"]) * rate)),
                        "horizon": "event", "kind": "event", "group": "SC9_stall", "event": number})

    with np.load(predictions / "representative_outer_10s.npz", allow_pickle=False) as cache:
        table = rows(cache)
        windows.append({"file": "forecasts/representative_10s.f32", "row": 0, "steps": len(table) - 1,
                        "segment": str(cache["segment"][0]), "start": int(cache["start_index"][0]),
                        "horizon": "10", "kind": "representative", "group": str(cache["group"][0])})
    (out / "representative_10s.f32").write_bytes(table.tobytes())

    priors = params.StallPriors()
    manifest = {
        "source": "reference/predictions of the reproducibility package (run acc2027_v6_motor)",
        "rate_hz": rate, "history_samples": params.HISTORY,
        "columns": ["measured"] + METHODS, "output_names": list(params.OUTPUT_NAMES), "width": 9 * (1 + len(METHODS)),
        "stall_priors": {"wing_incidence_rad": priors.wing_incidence_rad, "alpha_stall_rad": priors.alpha_stall_rad,
                         "blend_width_rad": priors.blend_width_rad},
        "windows": windows,
    }
    (args.out / "forecasts.json").write_text(json.dumps(manifest))
    total = sum(path.stat().st_size for path in out.glob("*.f32"))
    kinds = {kind: sum(w["kind"] == kind for w in windows) for kind in ("test", "event", "representative")}
    print(f"{len(windows)} windows {kinds}; {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
