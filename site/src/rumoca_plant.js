// Runs modelica/SportCubCommanded.mo in a Rumoca simulation session, one 1/60 s
// interval at a time with held inputs.
import { applyParameters } from "./paper_model.js";
import { STATE_NAMES, FILTER_NAMES } from "./paper_forecast.js";

export const PLANT_MODEL = "SportCubCommanded";

// Rumoca 0.10 cannot overwrite states of a live session, so the start state is
// written into the model's `<state>0` parameters: one compile per forecast.
export function startPlant(Session, source, parameters, initial, firstInputs, options = {}) {
  const dt = options.dt ?? 1 / 60;
  const start = {};
  STATE_NAMES.forEach((name, i) => { start[`${name}0`] = initial.x[i]; });
  FILTER_NAMES.forEach((name, i) => { start[`${name}0`] = initial.z[i]; });
  const text = applyParameters(source, { ...parameters, ...start });
  // Every input needs a value when the session is created.
  const session = Session.withInteractiveOptions(text, PLANT_MODEL, dt / 2, "rk4", 1e-6, 1e-6, JSON.stringify(firstInputs));
  return {
    advance(inputs) {
      session.set_inputs(JSON.stringify(inputs));
      session.step(dt);
      return { x: STATE_NAMES.map((name) => session.get(name)), z: FILTER_NAMES.map((name) => session.get(name)) };
    },
    free() {
      session.free();
    },
  };
}
