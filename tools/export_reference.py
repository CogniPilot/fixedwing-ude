#!/usr/bin/env python3
"""Export the released ACC 2027 models for the companion site.

Reads the reproducibility package (``--acc-root``, default ``../ACC_2027``) and
writes:

* ``--models`` (``site/public/data/paper_models.json``) -- every number needed to
  rebuild the four methods outside torch: constants, stall priors, feature
  normalisation, per method / airframe the physical, receiver-map, delay, motor,
  command-filter and separation parameters, the network weights, and the ARX
  matrices.
* ``--out``/``paper/parity_<method>.json`` -- step-by-step internals of a few held-out
  2 s forecasts (delayed sticks, s_eff, dC, the 16-state and z), used as the
  oracle for the Modelica/JS re-implementation. With ``--substeps N`` the same
  forecasts are integrated finely and written to ``converged/`` instead.

CPU only; nothing is trained.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--acc-root", type=Path, default=HERE.parents[1] / "ACC_2027")
    parser.add_argument("--out", type=Path, default=HERE.parent / "test" / "fixtures")
    parser.add_argument("--models", type=Path, default=HERE.parent / "site" / "public" / "data" / "paper_models.json")
    parser.add_argument("--horizon", type=float, default=2.0)
    parser.add_argument("--windows-per-group", type=int, default=2)
    parser.add_argument("--substeps", type=int, default=None,
                        help="override the RK4 substeps per interval (paper: 2); large values give the converged ODE solution")
    return parser.parse_args()


def model_parameters(population, params):
    """All identified values of one released model, per airframe."""
    core = population.core
    onset, recovery = core.separation_time_constants().tolist()
    result = {
        "separation": {"tau_onset_s": onset, "tau_recovery_s": recovery,
                       "authority": float(core.separation_authority())},
        "airframes": {},
    }
    for cfg in params.CONFIGURATIONS:
        model = population.models[cfg]
        result["airframes"][cfg] = {
            "physical": dict(zip(params.PHYSICAL_PARAMETER_NAMES, model.physics_vector().tolist())),
            "mapping": dict(zip(params.SAFE_MAP_PARAMETER_NAMES, model.mapping_vector().tolist())),
            "KTV": float(model.thrust_lapse()),
            "delay_s": dict(zip(("roll", "pitch", "throttle", "yaw"), model.delay().tolist())),
            "tau_motor_s": float(model.motor_tau()),
            "tau_z_s": model.tau().tolist(),
        }
    return result


def network_weights(core):
    """Weights of the residual network; conv kernels stay [out, in, kernel]."""
    state = core.state_dict()
    layers = lambda prefix, indices: [{"weight": state[f"{prefix}.{i}.weight"].tolist(),
                                       "bias": state[f"{prefix}.{i}.bias"].tolist()} for i in indices]
    weights = {"mlp": layers("instantaneous", (0, 2, 4))}
    if "readout.weight" in state:
        weights["encoder"] = layers("encoder", range(len(core.encoder)))
        weights["readout"] = {"weight": state["readout.weight"].tolist(), "bias": state["readout.bias"].tolist()}
    return weights


@torch.no_grad()
def traced_rollout(model, x0, command, history, command_history):
    """``FixedWingModel.rollout_states`` with every per-interval quantity recorded."""
    features = model.history_features(history, command_history)
    prefix = command_history[:, :-1] if torch.equal(command_history[:, -1], command[:, 0]) else command_history
    extended = torch.cat((prefix, command), dim=1)
    delayed = model.delayed_commands(extended, prefix.shape[1], command.shape[1])
    x, z = model.init_hidden(x0, delayed[:, 0])
    buffer = features
    trace = {"x": [x[0].tolist()], "z": [z[0].tolist()], "coefficient": [], "separation": []}
    for index in range(command.shape[1] - 1):
        coefficient, separation = model.coefficient_and_separation(buffer)
        x, z, _ = model.step(x, z, delayed[:, index], coeff_override=coefficient, separation_override=separation)
        trace["x"].append(x[0].tolist())
        trace["z"].append(z[0].tolist())
        trace["coefficient"].append(coefficient[0].tolist())
        trace["separation"].append(float(separation[0]))
        buffer = torch.cat((buffer[:, 1:], model.feature(x, z)[:, None]), dim=1)
    trace["delayed_command"] = delayed[0].tolist()
    return trace


def main():
    args = parse_args()
    sys.path.insert(0, str(args.acc_root / "src"))
    from acc2027 import params
    from acc2027.data import load_dataset, make_batch, windows
    from acc2027.evaluation import load_population
    from acc2027.arx import predict as arx_predict

    torch.set_num_threads(4)
    args.out.mkdir(parents=True, exist_ok=True)
    data, roles = load_dataset(params.settings())
    methods = ("oem", "instantaneous", "temporal")
    populations = {m: load_population(args.acc_root / f"reference/{m}.pt")[0].double() for m in methods}

    if args.substeps:
        for population in populations.values():
            for model in population.models.values():
                model.substeps = args.substeps
    exported = {
        "source": "ACC_2027 reference/",
        "rate_hz": params.UDE_RATE_HZ,
        "substeps": params.UDE_SUBSTEPS,
        "history_samples": params.HISTORY,
        "aircraft": params.AIRCRAFT,
        "max_deflection_deg": params.MAX_DEFLECTION_DEG,
        "inertia_coefficients": params.inertia_coefficients(),
        # The released models hold these as float32 buffers; export what they compute with.
        "stall_priors": dict(zip(params.StallPriors().to_dict(), populations["oem"].models["SC6"].stall_constants.tolist())),
        "deep_incidence_widths": params.DEEP_INCIDENCE_WIDTHS,
        "speed_reference_m_s": params.SPEED_REFERENCE,
        "throttle_center": params.THROTTLE_CENTER,
        "residual_scale": populations["oem"].models["SC6"].res_scale.tolist(),
        "feature_clip": params.FEATURE_CLIP,
        "feature_mean": {m: populations[m].models["SC6"].fm.tolist() for m in methods},
        "feature_std": {m: populations[m].models["SC6"].fs.tolist() for m in methods},
        "dilations": list(params.UNIFIED_DILATIONS),
        "leaky_relu_slope": params.LEAKY_RELU_SLOPE,
        "input_delay_max_s": params.INPUT_DELAY_MAX_S,
        "output_names": list(params.OUTPUT_NAMES),
        "output_scale": params.OUTPUT_SCALE.tolist(),
        "methods": {m: model_parameters(populations[m], params) for m in methods},
    }
    for method in ("instantaneous", "temporal"):
        exported["methods"][method]["network"] = network_weights(populations[method].core)
    arx = json.loads((args.acc_root / "reference/arx.json").read_text())
    exported["arx"] = {"n_lags": arx["n_lags"],
                       "airframes": {cfg: {k: v[k] for k in ("A", "B", "c")} for cfg, v in arx["configurations"].items()}}
    if not args.substeps:
        args.models.parent.mkdir(parents=True, exist_ok=True)
        args.models.write_text(json.dumps(exported))

    for method, population in populations.items():
        cases = []
        for group in params.GROUPS:
            cfg = params.GROUP_CONFIGURATION[group]
            candidates = windows(roles[group]["outer"], args.horizon)
            picks = np.linspace(0, len(candidates) - 1, args.windows_per_group).round().astype(int)
            for pick in picks:
                name, start = candidates[int(pick)]
                # float64 oracle: the float32 released weights are exact in double, so a
                # faithful re-implementation agrees to rounding, not to ~1e-3.
                x0, command, _, history, command_history = (
                    t.double() for t in make_batch(data, [(name, start)], args.horizon, "cpu"))
                trace = traced_rollout(population.models[cfg], x0, command, history, command_history)
                if method == "oem":
                    trace["arx"] = arx_predict(arx, cfg, data, [(name, start)], args.horizon)[0].tolist()
                cases.append({"group": group, "airframe": cfg, "segment": name, "start_index": int(start),
                              "command": command[0].tolist(),
                              "command_history": command_history[0].tolist(),
                              "state_history": history[0].tolist(), **trace})
        traces = args.out / ("converged" if args.substeps else "paper")
        traces.mkdir(exist_ok=True)
        (traces / f"parity_{method}.json").write_text(json.dumps({"method": method, "cases": cases}))
        print(f"{method}: {len(cases)} parity cases")


if __name__ == "__main__":
    main()
