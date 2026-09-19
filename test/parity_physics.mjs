// Parity of modelica/SportCubCommanded.mo (Rumoca WASM) against the torch
// rollouts exported by tools/export_reference.py. The per-interval quantities
// (delayed sticks, s_eff, dC) are replayed from the fixture, so this isolates
// the continuous physics.
//
// Rumoca integrates adaptively, the paper with RK4 at 1/120 s. So the equations
// are checked against a converged torch rollout (fixtures/converged, 40 substeps)
// and the distance to the paper's own discretisation (fixtures/paper) is bounded
// separately; that gap is the paper's truncation error in the 20 ms elevator lag.
// Usage: node test/parity_physics.mjs [method] [converged|paper]
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { modelicaParameters, applyParameters } from "../site/src/paper_model.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const method = process.argv[2] || "oem";
const DT = 1 / 60;
const SUBSTEPS = 2;
const STATES = ["pN", "pE", "pD", "u", "v", "w", "phi", "theta", "psi", "p", "q", "r", "da", "de", "dr", "Omega"];
const Z = ["za", "ze", "zt", "zr"];
const ANGLES = new Set(["phi", "theta", "psi"]);
const fixture = process.argv[3] || "converged";
const TOLERANCE = { converged: 2e-4, paper: 5e-3 }[fixture];

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// RUMOCA_PKG selects another build of @cognipilot/rumoca (e.g. an unpacked 0.10 artifact).
const pkg = process.env.RUMOCA_PKG || path.join(root, "site/node_modules/@cognipilot/rumoca");
const { default: init, WasmSimulationSession } = await import(path.join(pkg, "rumoca_bind_wasm.js"));
await init({ module_or_path: await readFile(path.join(pkg, "rumoca_bind_wasm_bg.wasm")) });
console.log(`rumoca ${JSON.parse(await readFile(path.join(pkg, "package.json"), "utf8")).version}`);
const source = await readFile(path.join(root, "modelica/SportCubCommanded.mo"), "utf8");
const parameters = JSON.parse(await readFile(path.join(root, "test/fixtures/parameters.json"), "utf8"));
const { cases } = JSON.parse(await readFile(path.join(root, `test/fixtures/${fixture}/parity_${method}.json`), "utf8"));

// The measured start state goes in through the model's `<state>0` parameters, so
// every forecast is one compile (0.10 has no way to overwrite states in place).
let compileMs = 0;
function sessionFor(airframe, initial, firstFrame) {
  const started = performance.now();
  const start = Object.fromEntries(Object.entries(initial).map(([name, value]) => [`${name}0`, value]));
  const text = applyParameters(source, { ...modelicaParameters(parameters, method, airframe), ...start });
  const session = typeof WasmSimulationSession.withInteractiveOptions === "function"
    ? WasmSimulationSession.withInteractiveOptions(text, "SportCubCommanded", DT / SUBSTEPS, "rk4", 1e-6, 1e-6, JSON.stringify(firstFrame))
    : WasmSimulationSession.withOptions(text, "SportCubCommanded", 3600, DT / SUBSTEPS, "rk4", 1e-6, 1e-6);
  compileMs += performance.now() - started;
  return session;
}

let worst = 0;
for (const item of cases) {
  const initial = Object.fromEntries([...STATES.map((n, i) => [n, item.x[0][i]]), ...Z.map((n, i) => [n, item.z[0][i]])]);
  const frame = (k) => {
    const [ua, ue, ut, ur] = item.delayed_command[k];
    const dC = item.coefficient[k];
    return [["u_a", ua], ["u_e", ue], ["u_t", ut], ["u_r", ur], ["s_eff", item.separation[k]],
      ["dCX", dC[0]], ["dCY", dC[1]], ["dCZ", dC[2]], ["dCl", dC[3]], ["dCm", dC[4]], ["dCn", dC[5]]];
  };
  // 0.10 requires every input to have a value when the session is created.
  const session = sessionFor(item.airframe, initial, frame(0));
  const peak = Object.fromEntries(STATES.map((n) => [n, 0]));
  for (let k = 0; k < item.coefficient.length; k += 1) {
    if (typeof session.set_inputs === "function") session.set_inputs(JSON.stringify(frame(k)));
    else for (const [name, value] of frame(k)) session.set_input(name, value);
    for (let s = 0; s < SUBSTEPS; s += 1) session.step(DT / SUBSTEPS);
    STATES.forEach((name, i) => {
      const delta = session.get(name) - item.x[k + 1][i];
      peak[name] = Math.max(peak[name], Math.abs(ANGLES.has(name) ? wrap(delta) : delta));
    });
  }
  session.free();
  const top = Object.entries(peak).sort((a, b) => b[1] - a[1])[0];
  worst = Math.max(worst, top[1]);
  console.log(`${method} ${item.group.padEnd(11)} ${item.segment}@${item.start_index}: max |error| ${top[1].toExponential(2)} (${top[0]})`);
}
console.log(`compile ${(compileMs / cases.length).toFixed(0)} ms per forecast`);
console.log(`${fixture}: worst ${worst.toExponential(2)} (tolerance ${TOLERANCE})`);
process.exit(worst < TOLERANCE ? 0 : 1);
