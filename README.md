# ACC 2027 companion site (working name)

Interactive companion to *Physics-Structured Temporal Neural Modeling of Commanded
Fixed-Wing UAV Dynamics* (ACC 2027). Private while the paper is unreleased.

The paper's model runs live in the browser, split the same way its code is:

- **Modelica, compiled and integrated by [Rumoca](https://github.com/CogniPilot/rumoca) WASM** —
  the 16-state commanded-aircraft physics plus the command filters:
  [`modelica/SportCubCommanded.mo`](modelica/SportCubCommanded.mo).
- **JavaScript, once per 1/60 s interval** — stick delays, the feature buffer, the
  neural residual ΔC and the separation state `s_eff`, fed to the plant as inputs:
  [`site/src/paper_forecast.js`](site/src/paper_forecast.js) (also the ARX baseline).

## Layout

- `modelica/` — the plant.
- `tools/export_reference.py` — reads the reproducibility package (`../ACC_2027`)
  and exports identified parameters and step-by-step reference rollouts.
- `test/` — parity tests against those rollouts; `test/fixtures/` is generated.
- `site/` — the static site. `@cognipilot/rumoca` 0.10.0 is vendored in `site/vendor/npm/`
  (packed from the v0.10.0 CI `wasm-package` artifact; switch to the npm registry once
  0.10.0 is published there).

## Check the port against the released models

```bash
(cd site && npm ci)
python3 tools/export_reference.py                 # site/public/data/paper_models.json + paper fixtures (RK4, 2 substeps)
python3 tools/export_reference.py --substeps 40   # converged ODE solution
node test/parity_physics.mjs temporal converged   # Modelica equations, inputs replayed: < 2e-4
node test/parity_physics.mjs oem paper            # distance to the paper's numbers: < 5e-3
node test/parity_forecast.mjs                     # JS half exact (1e-16); full closed loop < 2e-4; ARX
CLOSED_FIXTURE=paper node test/parity_forecast.mjs  # closed loop vs the paper's own forecasts: < 3e-3
```

Rumoca integrates adaptively while the paper uses RK4 at 1/120 s, so the port is
checked against a converged torch rollout. The remaining gap to the paper's own
forecasts (≤ 3e-3, in the effective elevator state) is the paper's truncation error
in the 20 ms elevator lag.
