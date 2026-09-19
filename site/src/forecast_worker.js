// Runs one recursive forecast off the main thread: the JS discrete half
// (paper_forecast.js) in lockstep with the Rumoca plant (rumoca_plant.js).
//
// in : { type: "init", models }
//      { type: "forecast", id, method, airframe, source, options,
//        stateHistory [64][12], commandHistory [64][4], command [n+1][4] }
// out: { type: "ready" } | { type: "progress", id, step, steps }
//      { type: "result", id, method, states [n+1][12], outputs [n+1][9],
//        coefficient [n][6], separation [n], compileMs, runMs }
//      { type: "error", id, message }
import init, { WasmSimulationSession } from "../public/vendor/rumoca/rumoca_bind_wasm.js";
import { CommandedForecast, arxForecast, outputs } from "./paper_forecast.js";
import { modelicaParameters } from "./paper_model.js";
import { startPlant } from "./rumoca_plant.js";

let models = null;
const ready = init();

// ARX predicts the nine outputs only; heading and position follow from them
// kinematically (forward Euler on the 60 Hz grid), for the 3D view.
function arxStates(start, rows, dt) {
  const states = [start.slice(0, 12)];
  let [pN, pE, pD] = start;
  let psi = start[8];
  rows.slice(1).forEach((y, k) => {
    const previous = rows[k];
    const [phi, theta, , q, r, V, gamma] = previous;
    psi += dt * (q * Math.sin(phi) + r * Math.cos(phi)) / Math.cos(theta);
    const beta = previous[8];
    const alpha = previous[7];
    const body = [V * Math.cos(alpha) * Math.cos(beta), V * Math.sin(beta), V * Math.sin(alpha) * Math.cos(beta)];
    const [cp, sp, ct, st, cs, ss] = [Math.cos(phi), Math.sin(phi), Math.cos(theta), Math.sin(theta), Math.cos(psi), Math.sin(psi)];
    pN += dt * (ct * cs * body[0] + (sp * st * cs - cp * ss) * body[1] + (cp * st * cs + sp * ss) * body[2]);
    pE += dt * (ct * ss * body[0] + (sp * st * ss + cp * cs) * body[1] + (cp * st * ss - sp * cs) * body[2]);
    pD -= dt * V * Math.sin(gamma);
    const next = [V * Math.cos(y[7]) * Math.cos(y[8]), V * Math.sin(y[8]), V * Math.sin(y[7]) * Math.cos(y[8])];
    states.push([pN, pE, pD, ...next, y[0], y[1], psi, y[2], y[3], y[4]]);
  });
  return states;
}

function forecast(msg) {
  const steps = msg.command.length - 1;
  const dt = 1 / models.rate_hz;
  if (msg.method === "arx") {
    const last = msg.commandHistory.length - 1;
    const commandAt = (j) => (j >= 0 ? msg.command[j] : msg.commandHistory[last + j]);
    const started = performance.now();
    const rows = arxForecast(models, msg.airframe, msg.stateHistory[last], commandAt, steps);
    return { states: arxStates(msg.stateHistory[last], rows, dt), outputs: rows, coefficient: [], separation: [],
      compileMs: 0, runMs: performance.now() - started };
  }
  const model = new CommandedForecast(models, msg.method, msg.airframe, msg.options || {});
  const initial = model.begin(msg.stateHistory, msg.commandHistory, msg.command);
  let frame = model.frame(0);
  let started = performance.now();
  const parameters = msg.useSourceParameters ? {} : modelicaParameters(models, msg.method, msg.airframe);
  const plant = startPlant(WasmSimulationSession, msg.source, parameters, initial, frame.inputs, { dt });
  const compileMs = performance.now() - started;
  started = performance.now();
  const states = [initial.x.slice(0, 12)];
  const coefficient = [];
  const separation = [];
  try {
    for (let k = 0; k < steps; k += 1) {
      if (k > 0) frame = model.frame(k);
      const state = plant.advance(frame.inputs);
      if (!state.x.every(Number.isFinite)) throw new Error(`The model diverged ${(k * dt).toFixed(2)} s into the forecast.`);
      model.push(state.x, state.z);
      states.push(state.x.slice(0, 12));
      coefficient.push(frame.coefficient);
      separation.push(frame.separation);
      if (k % 30 === 29) self.postMessage({ type: "progress", id: msg.id, step: k + 1, steps });
    }
  } finally {
    plant.free();
  }
  return { states, outputs: states.map(outputs), coefficient, separation, compileMs, runMs: performance.now() - started };
}

self.onmessage = async ({ data: msg }) => {
  try {
    await ready;
    if (msg.type === "init") {
      models = msg.models;
      self.postMessage({ type: "ready" });
    } else if (msg.type === "forecast") {
      self.postMessage({ type: "result", id: msg.id, method: msg.method, ...forecast(msg) });
    }
  } catch (error) {
    self.postMessage({ type: "error", id: msg.id, message: String(error?.message || error) });
  }
};
