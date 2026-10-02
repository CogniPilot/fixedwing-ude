#!/usr/bin/env python3
"""Export the downloadable records for the data page.

Reads the reproducibility package (``--acc-root``, default ``../ACC_2027``) and
writes under ``--out`` (``site/public``):

* ``release/records/<session>/`` -- the processed 60 Hz records exactly as
  released (NPZ + diagnostics + session manifest).
* ``release/csv/<flight>.csv`` -- the same records as plain CSV (one row per
  60 Hz sample; the causal arrays are only in the NPZ).
* ``assets/SportsCub.jpg`` -- the airframe photo (video poster on the home page).
* ``data/release.json`` -- what the data page renders: per-flight metadata
  (date, duration, SAFE and tracked fractions, source bag and its SHA-256),
  the files above with size and SHA-256, and the rosbag and package links.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent

# No public host yet; the data page shows an error instead of a link. Set to the URL
# (ideally a DOI) once the bags are published and restore the link in site/src/release.js.
ROSBAG_URL = None
ROSBAG_MB = 609
PACKAGE_REPO = "https://github.com/dbansal02/ACC_2027"
SITE_REPO = "https://github.com/CogniPilot/fixedwing-ude"

# Local start time of each session's first record, from data/README.md; the
# manifests only carry the (machine-local) log clock.
SESSION_START = {"nominal_2026-08-03": dt.datetime(2026, 8, 3, 15, 38), "stall_2026-08-21": dt.datetime(2026, 8, 21, 15, 13)}

CSV_COLUMNS = (["time_s", "frame"]
               + ["x_n", "y_e", "z_d", "u", "v", "w", "q_w", "q_x", "q_y", "q_z", "p", "q", "r"]
               + ["phi", "theta", "psi"]
               + ["throttle", "elevator", "aileron", "rudder"]
               + ["throttle_hold", "elevator_hold", "aileron_hold", "rudder_hold"]
               + ["flight_mode", "mode_changes_in_interval", "mocap_tracked"])

def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--acc-root", type=Path, default=HERE.parents[1] / "ACC_2027")
    parser.add_argument("--out", type=Path, default=HERE.parent / "site" / "public")
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_entry(out: Path, path: Path, **extra) -> dict:
    return {"path": str(path.relative_to(out)).replace("\\", "/"), "bytes": path.stat().st_size, "sha256": sha256(path), **extra}


def copy(source: Path, target: Path) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    return target


def write_csv(npz_path: Path, target: Path) -> None:
    with np.load(npz_path, allow_pickle=False) as z:
        table = np.column_stack((z["time_s"], z["frame"], z["x"], z["euler"], z["u_cmd"], z["u_cmd_hold"],
                                 z["flight_mode"], z["mode_changes_in_interval"], z["mocap_tracked"]))
    assert table.shape[1] == len(CSV_COLUMNS)
    target.parent.mkdir(parents=True, exist_ok=True)
    formats = ["%.8g", "%d"] + ["%.7g"] * 24 + ["%d", "%d", "%d"]
    np.savetxt(target, table, fmt=",".join(formats), header=",".join(CSV_COLUMNS), comments="")


def git_commit(root: Path) -> str | None:
    try:
        return subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def flight_entries(acc: Path, out: Path, params) -> list[dict]:
    flights = []
    for airframe in params.CONFIGURATIONS:
        session = params.SESSION_DIRECTORY[airframe]
        manifest = json.loads((acc / "data" / session / "manifest.json").read_text())
        records = {record["name"]: record for record in manifest["records"]}
        for name in params.SEGMENTS[airframe]:
            record = records[name]
            source_dir = acc / "data" / session
            diagnostics = json.loads((source_dir / f"{name}.diagnostics.json").read_text())
            npz = copy(source_dir / f"{name}.npz", out / "release" / "records" / session / f"{name}.npz")
            diag = copy(source_dir / f"{name}.diagnostics.json", out / "release" / "records" / session / f"{name}.diagnostics.json")
            csv_path = out / "release" / "csv" / f"{name}.csv"
            write_csv(source_dir / f"{name}.npz", csv_path)
            start = SESSION_START[session] + dt.timedelta(seconds=record["session_offset_s"])
            flights.append({
                "name": name, "airframe": airframe, "session": session, "purpose": record.get("purpose", ""),
                "date": start.strftime("%Y-%m-%d"), "start_local": start.strftime("%H:%M"),
                "samples": record["samples"], "duration_s": record["samples"] / record["rate_hz"],
                "safe_fraction": diagnostics["validity"]["safe_fraction"],
                "valid_fraction": diagnostics["validity"]["valid_fraction"],
                "dropped_frames": diagnostics["clock"]["dropped_frames"],
                "raw_messages": diagnostics["clock"]["raw_messages"],
                "position_residual_mm": float(np.mean(diagnostics["fit_residual"]["position_rms_mm"])),
                "rotation_residual_deg": diagnostics["fit_residual"]["rotation_rms_deg"],
                "bag": {"file": diagnostics["source_bag"], "folder": record["source_bag_folder"],
                        "campaign_folder": record["original_campaign_folder"], "sha256": record["source_sha256"]},
                "npz": file_entry(out, npz), "diagnostics": file_entry(out, diag), "csv": file_entry(out, csv_path),
            })
        copy(acc / "data" / session / "manifest.json", out / "release" / "records" / session / "manifest.json")
    return flights


def main():
    args = parse_args()
    acc, out = args.acc_root, args.out
    sys.path.insert(0, str(acc / "src"))
    from acc2027 import params

    for stale in ("release", "assets/SportsCub.jpg"):
        path = out / stale
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()

    flights = flight_entries(acc, out, params)
    manifests = [file_entry(out, out / "release" / "records" / session / "manifest.json", session=session)
                 for session in sorted(set(params.SESSION_DIRECTORY.values()))]

    photo = file_entry(out, copy(acc / "data" / "SportsCub.jpg", out / "assets" / "SportsCub.jpg"))

    release = {
        "generated": dt.date.today().isoformat(),
        "package": {"repo": PACKAGE_REPO, "commit": git_commit(acc), "site_repo": SITE_REPO},
        "rosbags": {"url": ROSBAG_URL, "megabytes": ROSBAG_MB, "count": len(flights)},
        "records": {"manifests": manifests, "csv_columns": CSV_COLUMNS,
                    "total_npz_bytes": sum(f["npz"]["bytes"] for f in flights), "total_csv_bytes": sum(f["csv"]["bytes"] for f in flights)},
        "flights": flights,
        "photo": photo,
    }
    (out / "data" / "release.json").write_text(json.dumps(release, indent=1))
    total = sum(p.stat().st_size for p in (out / "release").rglob("*") if p.is_file())
    print(f"{len(flights)} flights; release/ is {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
