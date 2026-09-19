# ACC 2027 companion site (working name)

Interactive companion to *Physics-Structured Temporal Neural Modeling of Commanded
Fixed-Wing UAV Dynamics* (ACC 2027). Private while the paper is unreleased.

The paper's model runs live in the browser, split the same way its code is:

- **Modelica, compiled and integrated by [Rumoca](https://github.com/CogniPilot/rumoca) WASM** —
  the 16-state commanded-aircraft physics plus the command filters:
  [`site/public/modelica/SportCubCommanded.mo`](site/public/modelica/SportCubCommanded.mo).
- **JavaScript, once per 1/60 s interval** — stick delays, the feature buffer, the
  neural residual ΔC and the separation state `s_eff`, fed to the plant as inputs:
  [`site/src/paper_forecast.js`](site/src/paper_forecast.js) (also the ARX baseline).

## Run the site locally

```bash
(cd site && npm ci)      # also copies the Rumoca browser files into site/public/vendor/rumoca
python3 site/serve.py    # http://127.0.0.1:8765/
```

The page opens on a held-out stall arc with a 5 s forecast from all four methods.
Nothing is deployed: there is no Pages workflow, and the repository is private.

## Layout

- `site/public/modelica/` — the plant.
- `tools/export_reference.py` — reads the reproducibility package (`../ACC_2027`) and exports
  `site/public/data/paper_models.json` (parameters, network weights, ARX) and reference rollouts.
- `tools/export_site_data.py` — exports the eight flights (float32 tables), their
  fit / development / test arcs and the reference run's result tables.
- `test/` — parity tests against those rollouts; `test/fixtures/` is generated.
- `site/` — the static site (`src/app.js` wiring, `scene.js` 3D view, `charts.js`,
  `forecast_worker.js` running the forecasts off the main thread, `editor.js` Monaco + Rumoca diagnostics). `@cognipilot/rumoca` 0.10.0 is vendored in `site/vendor/npm/`
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
