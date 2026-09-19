// Parity of the JS discrete half (site/src/paper_forecast.js) against torch.
//   replay  the plant is the torch trajectory itself, so delays, features, the
//           separation filter and the networks must agree to rounding;
//   closed  the full loop with the Rumoca plant, against the converged rollout
//           (CLOSED_FIXTURE=paper measures the distance to the paper's RK4 instead);
//   arx     the ARX recursion.
// Usage: node test/parity_forecast.mjs
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CommandedForecast, arxForecast, outputs } from "../site/src/paper_forecast.js";
import { modelicaParameters } from "../site/src/paper_model.js";
import { startPlant } from "../site/src/rumoca_plant.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));
const pkg = process.env.RUMOCA_PKG || path.join(root, "site/node_modules/@cognipilot/rumoca");
const { default: init, WasmSimulationSession } = await import(path.join(pkg, "rumoca_bind_wasm.js"));
await init({ module_or_path: await readFile(path.join(pkg, "rumoca_bind_wasm_bg.wasm")) });
const source = await readFile(path.join(root, "site/public/modelica/SportCubCommanded.mo"), "utf8");
const models = await read("site/public/data/paper_models.json");

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const peak = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
let failed = false;
function report(label, worst, tolerance) {
  const ok = worst < tolerance;
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: worst ${worst.toExponential(2)} (tolerance ${tolerance})`);
}

for (const method of ["oem", "instantaneous", "temporal"]) {
  const { cases } = await read(`test/fixtures/paper/parity_${method}.json`);
  let worst = 0;
  for (const item of cases) {
    const forecast = new CommandedForecast(models, method, item.airframe);
    const initial = forecast.begin(item.state_history, item.command_history, item.command);
    worst = Math.max(worst, peak(initial.x, item.x[0]), peak(initial.z, item.z[0]));
    for (let k = 0; k < item.coefficient.length; k += 1) {
      const frame = forecast.frame(k);
      worst = Math.max(worst, peak(frame.coefficient, item.coefficient[k]), Math.abs(frame.separation - item.separation[k]),
        peak(frame.inputs.slice(0, 4).map(([, v]) => v), item.delayed_command[k]));
      forecast.push(item.x[k + 1], item.z[k + 1]);
    }
  }
  report(`replay ${method}`, worst, 1e-9);
}

const closedFixture = process.env.CLOSED_FIXTURE || "converged";
for (const method of closedFixture === "paper" ? ["oem", "instantaneous", "temporal"] : ["oem", "temporal"]) {
  const { cases } = await read(`test/fixtures/${closedFixture}/parity_${method}.json`);
  let worst = 0;
  let elapsed = 0;
  for (const item of cases) {
    const started = performance.now();
    const forecast = new CommandedForecast(models, method, item.airframe);
    const initial = forecast.begin(item.state_history, item.command_history, item.command);
    let frame = forecast.frame(0);
    const plant = startPlant(WasmSimulationSession, source, modelicaParameters(models, method, item.airframe), initial, frame.inputs);
    for (let k = 0; k < item.coefficient.length; k += 1) {
      if (k > 0) frame = forecast.frame(k);
      const state = plant.advance(frame.inputs);
      forecast.push(state.x, state.z);
      const expected = outputs(item.x[k + 1]);
      worst = Math.max(worst, outputs(state.x).reduce((m, v, i) => Math.max(m, Math.abs(i < 2 || i > 5 ? wrap(v - expected[i]) : v - expected[i])), 0));
    }
    plant.free();
    elapsed += performance.now() - started;
    if (process.env.VERBOSE) console.log(`     ${item.segment}@${item.start_index}: running worst ${worst.toExponential(2)}`);
  }
  console.log(`     closed ${method}: ${(elapsed / cases.length).toFixed(0)} ms per 2 s forecast (compile + ${cases[0].coefficient.length} intervals)`);
  report(`closed ${method} vs ${closedFixture} (nine outputs, rad | rad/s | m/s)`, worst, closedFixture === "paper" ? 1e-2 : 2e-4);
}

{
  const { cases } = await read("test/fixtures/paper/parity_oem.json");
  let worst = 0;
  for (const item of cases) {
    const last = item.command_history.length - 1;
    const commandAt = (j) => (j >= 0 ? item.command[j] : item.command_history[last + j]);
    const prediction = arxForecast(models, item.airframe, item.x[0], commandAt, item.arx.length - 1);
    prediction.forEach((row, k) => { worst = Math.max(worst, peak(row, item.arx[k])); });
  }
  // The fixture stores the start state and sticks as float32; the oracle used float64 data.
  report("arx", worst, 2e-6);
}
process.exit(failed ? 1 : 0);
