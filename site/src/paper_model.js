// Bridges the exported ACC 2027 parameters (parameters.json) to the Modelica
// plant: the released value of every `parameter Real` for one method / airframe.

const DIRECT_MAPPING = ["k_aa", "k_ar", "k_aphi", "k_ap", "k_ra", "k_rr", "k_rphi", "k_rrate",
  "k_ee", "k_et", "k_etheta", "k_eq", "b_a", "b_e", "b_r"];

export function modelicaParameters(parameters, method, airframe) {
  const entry = parameters.methods[method].airframes[airframe];
  const values = { ...entry.physical, KTV: entry.KTV, tau_m: entry.tau_motor_s, tau_z: entry.tau_z_s[0] };
  for (const name of DIRECT_MAPPING) values[name] = entry.mapping[name];
  values.tau_a = Math.exp(entry.mapping.log_tau_a);
  values.tau_e = Math.exp(entry.mapping.log_tau_e);
  values.tau_r = Math.exp(entry.mapping.log_tau_r);
  return values;
}

// Rewrites `parameter Real <name> = <number>` declarations in place, so the
// editor keeps showing ordinary Modelica.
export function applyParameters(source, values) {
  let text = source;
  const missing = [];
  for (const [name, value] of Object.entries(values)) {
    const pattern = new RegExp(`(parameter\\s+Real\\s+${name}\\s*=\\s*)[-+0-9.eE]+`);
    if (!pattern.test(text)) { missing.push(name); continue; }
    text = text.replace(pattern, `$1${Number(value).toPrecision(17)}`);
  }
  if (missing.length) throw new Error(`Model does not declare parameter(s): ${missing.join(", ")}`);
  return text;
}
