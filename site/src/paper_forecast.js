// The per-interval (1/60 s) discrete half of the ACC 2027 models, in plain JS.
// The continuous half is public/modelica/SportCubCommanded.mo, run by Rumoca.
//
// Mirrors ACC_2027 src/acc2027/fixed_wing_model.py (`rollout_states`): every
// interval the delayed sticks, the separation state s_eff and the bounded neural
// residual dC are computed from a 64-sample feature buffer and held while the
// plant integrates. Tags such as [UDE-3] match the paper's method documents.

export const STATE_NAMES = ["pN", "pE", "pD", "u", "v", "w", "phi", "theta", "psi", "p", "q", "r", "da", "de", "dr", "Omega"];
export const FILTER_NAMES = ["za", "ze", "zt", "zr"];
const RESIDUAL_INPUTS = ["dCX", "dCY", "dCZ", "dCl", "dCm", "dCn"];

const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// [OEM-1] flight-path angle from the 12-state (NED, ZYX Euler).
function flightPathAngle(x) {
  const [u, v, w, phi, theta, psi] = [x[3], x[4], x[5], x[6], x[7], x[8]];
  const [cp, sp, ct, st, cs, ss] = [Math.cos(phi), Math.sin(phi), Math.cos(theta), Math.sin(theta), Math.cos(psi), Math.sin(psi)];
  const north = ct * cs * u + (sp * st * cs - cp * ss) * v + (cp * st * cs + sp * ss) * w;
  const east = ct * ss * u + (sp * st * ss + cp * cs) * v + (cp * st * ss - sp * cs) * w;
  const down = -st * u + sp * ct * v + cp * ct * w;
  return Math.atan2(-down, Math.sqrt(north * north + east * east + 1e-8));
}

// [OEM-1] the nine scored outputs [phi, theta, p, q, r, V, gamma, alpha, beta].
export function outputs(x) {
  const speed = Math.hypot(x[3], x[4], x[5]);
  return [wrap(x[6]), wrap(x[7]), x[9], x[10], x[11], speed, flightPathAngle(x),
    Math.atan2(x[5], x[3]), Math.asin(clamp(x[4] / Math.max(speed, 1e-3), -0.99, 0.99))];
}

// [OEM-2] per-axis pure delay by linear interpolation on the stick sequence.
function delayedCommands(sequence, start, length, delaySamples) {
  const last = sequence.length - 1;
  const result = [];
  for (let k = 0; k < length; k += 1) {
    result.push(delaySamples.map((samples, axis) => {
      const source = clamp(start + k - samples, 0, last);
      const lower = Math.floor(source);
      const weight = source - lower;
      return sequence[lower][axis] * (1 - weight) + sequence[Math.min(lower + 1, last)][axis] * weight;
    }));
  }
  return result;
}

function dense(layer, input) {
  return layer.weight.map((row, i) => row.reduce((sum, w, j) => sum + w * input[j], layer.bias[i]));
}

// Valid (unpadded, causal) dilated Conv1D over [time][channel]; kernels are [out][in][tap].
function conv1d(layer, input, dilation) {
  const taps = layer.weight[0][0].length;
  const result = [];
  for (let t = 0; t + (taps - 1) * dilation < input.length; t += 1) {
    result.push(layer.weight.map((kernel, o) => {
      let sum = layer.bias[o];
      for (let c = 0; c < kernel.length; c += 1) {
        for (let tap = 0; tap < taps; tap += 1) sum += kernel[c][tap] * input[t + tap * dilation][c];
      }
      return sum;
    }));
  }
  return result;
}

export class CommandedForecast {
  // method: "oem" | "instantaneous" | "temporal"; `residual: false` switches the
  // network off without changing the physics (a live ablation, not the OEM fit).
  constructor(models, method, airframe, options = {}) {
    const entry = models.methods[method];
    this.models = models;
    this.method = method;
    this.airframe = entry.airframes[airframe];
    this.network = options.residual === false ? null : entry.network || null;
    this.temporalBranch = options.temporal !== false;
    this.separation = entry.separation;
    this.mean = models.feature_mean[method];
    this.std = models.feature_std[method];
    this.dt = 1 / models.rate_hz;
    this.history = models.history_samples;
  }

  // [OEM-3] receiver map: sticks + attitude/rate feedback -> saturated surface commands.
  surfaceCommands(x, command) {
    const k = this.airframe.mapping;
    const [ua, ue, ut, ur] = command;
    return [
      clamp(k.k_aa * ua + k.k_ar * ur + k.k_aphi * x[6] + k.k_ap * x[9] + k.b_a, -1, 1),
      clamp(k.k_ee * ue + k.k_et * (ut - this.models.throttle_center) + k.k_etheta * x[7] + k.k_eq * x[10] + k.b_e, -1, 1),
      clamp(k.k_ra * ua + k.k_rr * ur + k.k_rphi * x[6] + k.k_rrate * x[11] + k.b_r, -1, 1),
    ];
  }

  // Surfaces at the receiver map's output, motor at the throttle, z at the stick.
  initialHidden(x12, command) {
    return { x: [...x12, ...this.surfaceCommands(x12, command), Math.max(command[2], 0)], z: [...command] };
  }

  // [UDE-3] the 16 standardised, clipped features.
  feature(x, z) {
    const y = outputs(x);
    const raw = [y[5] - this.models.speed_reference_m_s, y[7], y[8], x[9], x[10], x[11], y[0], y[1], y[6],
      ...z, x[12], x[13], x[14]];
    const limit = this.models.feature_clip;
    return raw.map((value, i) => clamp((value - this.mean[i]) / this.std[i], -limit, limit));
  }

  // Start a forecast at the last sample of `stateHistory` ([64][12], measured) and
  // `commandHistory` ([64][4]); `command` ([n+1][4]) starts at that same sample.
  begin(stateHistory, commandHistory, command) {
    if (stateHistory.length !== this.history || commandHistory.length !== this.history) {
      throw new Error(`A forecast needs exactly ${this.history} history samples.`);
    }
    const delaySamples = ["roll", "pitch", "throttle", "yaw"].map((axis) => this.airframe.delay_s[axis] / this.dt);
    const pad = Math.ceil(this.models.input_delay_max_s / this.dt) + 1;
    const padded = [...Array(pad).fill(commandHistory[0]), ...commandHistory];
    const delayedHistory = delayedCommands(padded, pad, this.history, delaySamples);
    this.buffer = stateHistory.map((x12, i) => {
      const hidden = this.initialHidden(x12, delayedHistory[i]);
      return this.feature(hidden.x, hidden.z);
    });
    const prefix = commandHistory.slice(0, -1);
    this.delayed = delayedCommands([...prefix, ...command], prefix.length, command.length, delaySamples);
    return this.initialHidden(stateHistory[this.history - 1], this.delayed[0]);
  }

  // [OEM-5b] asymmetric onset / recovery filter of the static gate over the buffer.
  separationState() {
    const prior = this.models.stall_priors;
    const gate = (alpha, shift) => 0.5 * (1 + Math.tanh((alpha + prior.wing_incidence_rad
      - (prior.alpha_stall_rad + shift * prior.blend_width_rad)) / prior.blend_width_rad));
    const alphas = this.buffer.map((f) => f[1] * this.std[1] + this.mean[1]);
    let separation = gate(alphas[0], 0);
    for (let i = 1; i < alphas.length; i += 1) {
      const target = gate(alphas[i], 0);
      const tau = target >= separation ? this.separation.tau_onset_s : this.separation.tau_recovery_s;
      separation += (1 - Math.exp(-this.dt / tau)) * (target - separation);
    }
    const deep = gate(alphas[alphas.length - 1], this.models.deep_incidence_widths);
    const authority = this.separation.authority;
    return clamp(separation * (authority + (1 - authority) * deep), 0, 1);
  }

  // [UDE-1, UDE-4] dC = s_C * tanh(MLP(f_k) + W TCN(f_{k-63:k})).
  residual() {
    if (!this.network) return [0, 0, 0, 0, 0, 0];
    const [first, second, head] = this.network.mlp;
    const current = this.buffer[this.buffer.length - 1];
    let logits = dense(head, dense(second, dense(first, current).map(Math.tanh)).map(Math.tanh));
    if (this.network.encoder && this.temporalBranch) {
      const slope = this.models.leaky_relu_slope;
      let latent = this.buffer;
      this.network.encoder.forEach((layer, i) => {
        latent = conv1d(layer, latent, this.models.dilations[i]).map((row) => row.map((v) => (v >= 0 ? v : slope * v)));
      });
      const temporal = dense(this.network.readout, latent[latent.length - 1]);
      logits = logits.map((value, i) => value + temporal[i]);
    }
    return logits.map((value, i) => this.models.residual_scale[i] * Math.tanh(value));
  }

  // Inputs held by the plant over interval k (call after `begin` / `push`).
  frame(k) {
    const coefficient = this.residual();
    const separation = this.separationState();
    const [ua, ue, ut, ur] = this.delayed[k];
    const inputs = [["u_a", ua], ["u_e", ue], ["u_t", ut], ["u_r", ur], ["s_eff", separation],
      ...RESIDUAL_INPUTS.map((name, i) => [name, coefficient[i]])];
    return { inputs, coefficient, separation };
  }

  // Feed back the plant's state at the end of the interval.
  push(x, z) {
    this.buffer.push(this.feature(x, z));
    this.buffer.shift();
  }
}

// [ARX-1] y_{k+1} = A y_k + sum_l B_l u_{k-l} + c, from the measured start output.
// `commandAt(j)` returns the undelayed stick at forecast sample j (negative = history).
export function arxForecast(models, airframe, startState, commandAt, steps) {
  const { A, B, c } = models.arx.airframes[airframe];
  const x = startState;
  const speed = Math.hypot(x[3], x[4], x[5]);
  // Unwrapped start, as the paper evaluates ARX in continuous angle coordinates.
  let y = [x[6], x[7], x[9], x[10], x[11], speed, flightPathAngle(x), Math.atan2(x[5], x[3]),
    Math.asin(clamp(x[4] / Math.max(speed, 1e-3), -0.99, 0.99))];
  const result = [y];
  for (let j = 0; j < steps; j += 1) {
    const next = A.map((row, i) => row.reduce((sum, a, n) => sum + a * y[n], c[i]));
    B.forEach((matrix, lag) => {
      const u = commandAt(j - lag);
      matrix.forEach((row, i) => { next[i] += row.reduce((sum, b, n) => sum + b * u[n], 0); });
    });
    y = next;
    result.push(y);
  }
  return result;
}
