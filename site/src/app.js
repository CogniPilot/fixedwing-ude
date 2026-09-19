import { loadSiteData, loadFlight, forecastWindow } from "./data.js";
import { outputs } from "./paper_forecast.js";
import { modelicaParameters, applyParameters } from "./paper_model.js";
import { SERIES, METHOD_ORDER, legend, timeSeriesGrid, horizonChart } from "./charts.js";
import { createScene } from "./scene.js";
import { createEditor } from "./editor.js";

const $ = (id) => document.getElementById(id);
const DEG = 180 / Math.PI;
const METHOD_COLORS = { temporal: "--series-temporal", instantaneous: "--series-instantaneous", arx: "--series-arx", oem: "--series-oem" };
const ROLE_COLORS = { fit: "--role-fit", development: "--role-development", test: "--role-test" };
// Output panels: [title, unit, index into the nine outputs, scale].
const OUTPUT_PANELS = [["Roll φ", "deg", 0, DEG], ["Pitch θ", "deg", 1, DEG], ["Speed V", "m/s", 5, 1],
  ["Roll rate p", "deg/s", 2, DEG], ["Pitch rate q", "deg/s", 3, DEG], ["Yaw rate r", "deg/s", 4, DEG],
  ["Body incidence α", "deg", 7, DEG], ["Sideslip β", "deg", 8, DEG], ["Flight-path angle γ", "deg", 6, DEG]];

const state = {
  site: null, flight: null, position: 0, playing: false, lastMs: 0,
  enabled: new Set(METHOD_ORDER), forecast: null, grid: null, source: "", pristineSource: "", editor: null, job: 0,
};
let scene = null;
let worker = null;

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ---------------------------------------------------------------- playback
function paintRoleStrip() {
  const canvas = $("role-strip");
  const { flight } = state;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  const context = canvas.getContext("2d");
  context.fillStyle = cssVar("--role-none");
  context.fillRect(0, 0, canvas.width, canvas.height);
  flight.arcs.forEach((arc) => {
    context.fillStyle = cssVar(ROLE_COLORS[arc.role]);
    const x = (arc.start / flight.samples) * canvas.width;
    context.fillRect(x, 0, Math.max(1, ((arc.stop - arc.start) / flight.samples) * canvas.width - 1), canvas.height);
  });
}

function showTime() {
  const { flight } = state;
  const index = Math.floor(state.position);
  $("scrub").value = index;
  $("time-readout").textContent = `${(index / flight.rate).toFixed(1)} s`;
  const arc = flight.arcAt(index);
  $("arc-readout").textContent = arc ? `Now: ${arc.role} arc (${arc.group.replace("_", " ")})`
    : flight.tracked(index) ? "Now: not used" : "Now: tracking lost";
  const [roll, pitch, throttle, yaw] = flight.command(index);
  const signed = (node, value) => { node.style.left = `${50 + Math.min(0, value) * 50}%`; node.style.width = `${Math.abs(value) * 50}%`; };
  signed($("stick-roll"), roll);
  signed($("stick-pitch"), pitch);
  signed($("stick-yaw"), yaw);
  $("stick-throttle").style.width = `${Math.max(0, Math.min(1, throttle)) * 100}%`;
  if (state.forecast) state.grid?.setCursor((index - state.forecast.start) / flight.rate);
}

function tick(nowMs) {
  const deltaS = Math.min(0.08, (nowMs - state.lastMs) / 1000 || 0);
  state.lastMs = nowMs;
  if (state.flight) {
    if (state.playing) {
      state.position += deltaS * state.flight.rate;
      // While a forecast is shown, loop over it (with a one-second lead-in) instead of the whole flight.
      const loop = state.forecast && { from: Math.max(0, state.forecast.start - 60), to: state.forecast.start + state.forecast.steps };
      if (loop && (state.position > loop.to || state.position < loop.from)) state.position = loop.from;
      if (state.position >= state.flight.samples - 1) state.position = 0;
      showTime();
    }
    scene?.setTime(state.position, state.playing ? deltaS : 0);
  }
  requestAnimationFrame(tick);
}

function setPlaying(playing) {
  state.playing = playing;
  $("play-toggle").textContent = playing ? "❚❚" : "▶";
  $("play-toggle").setAttribute("aria-label", playing ? "Pause" : "Play");
}

async function selectFlight(name, startIndex = null) {
  state.flight = await loadFlight(state.site, name);
  state.forecast = null;
  scene?.setFlight(state.flight);
  $("scrub").max = state.flight.samples - 1;
  const firstTest = state.flight.arcs.find((arc) => arc.role === "test");
  state.position = startIndex ?? (firstTest ? firstTest.start + state.site.manifest.history_samples : 0);
  paintRoleStrip();
  showTime();
  $("series-grid").replaceChildren();
  $("score-row").replaceChildren();
  $("forecast-status").textContent = "";
  state.onFlightChange?.();
}

// ---------------------------------------------------------------- forecasts
function runForecast(message) {
  return new Promise((resolve, reject) => {
    const id = ++state.job;
    const listener = ({ data }) => {
      if (data.id !== id) return;
      if (data.type === "progress") return;
      worker.removeEventListener("message", listener);
      if (data.type === "result") resolve(data);
      else reject(new Error(data.message));
    };
    worker.addEventListener("message", listener);
    worker.postMessage({ type: "forecast", id, ...message });
  });
}

// The paper's normalised score over [phi, theta, p, q, r, V] for one forecast.
function windowScore(predicted, measured) {
  const scale = state.site.results.output_scale;
  let sum = 0;
  let count = 0;
  predicted.forEach((row, k) => {
    for (let j = 0; j < 6; j += 1) {
      const error = j < 2 ? wrap(row[j] - measured[k][j]) : row[j] - measured[k][j];
      sum += (error / scale[j]) ** 2;
      count += 1;
    }
  });
  return Math.sqrt(sum / count);
}

function renderForecast() {
  const { forecast, flight } = state;
  const time = Array.from({ length: forecast.steps + 1 }, (_, k) => k / flight.rate);
  const measured = forecast.measured.map(outputs);
  const methods = METHOD_ORDER.filter((method) => forecast.results[method]);
  const panels = OUTPUT_PANELS.map(([title, unit, index, scale]) => {
    const series = { measured: measured.map((row) => row[index] * scale) };
    methods.forEach((method) => { series[method] = forecast.results[method].outputs.map((row) => row[index] * scale); });
    return { title, unit, series };
  });
  // Body incidence at which the wing reaches the separation prior's midpoint.
  const priors = state.site.models.stall_priors;
  panels[6].reference = { value: (priors.alpha_stall_rad - priors.wing_incidence_rad) * DEG, label: "separation prior midpoint" };
  const internal = methods.filter((method) => method !== "arx");
  const padded = (values) => [...values, NaN]; // per-interval quantities: one fewer than samples
  if (internal.length) {
    panels.push({ title: "Separation s_eff (model state)", unit: "–",
      series: Object.fromEntries(internal.map((m) => [m, padded(forecast.results[m].separation)])) });
    const neural = internal.filter((method) => method !== "oem");
    [["Residual ΔC_Z (normal force)", 2], ["Residual ΔC_m (pitch moment)", 4]].forEach(([title, index]) => {
      if (neural.length) panels.push({ title, unit: "–", series: Object.fromEntries(neural.map((m) => [m, padded(forecast.results[m].coefficient.map((c) => c[index]))])) });
    });
  }
  legend($("series-legend"), ["measured", ...methods]);
  state.grid = timeSeriesGrid($("series-grid"), time, panels, {
    onHover: (t) => { setPlaying(false); state.position = forecast.start + Math.round(t * flight.rate); showTime(); },
  });

  $("score-row").replaceChildren(...methods.map((method) => {
    const tile = document.createElement("div");
    tile.className = "score-tile";
    const result = forecast.results[method];
    const timing = method === "arx" ? "linear recursion" : `compile ${result.compileMs.toFixed(0)} ms · run ${result.runMs.toFixed(0)} ms`;
    tile.innerHTML = `<span><i class="key key-${method}"></i>${SERIES[method].label}</span><b>${windowScore(result.outputs, measured).toFixed(3)}</b><small>score on this window · ${timing}</small>`;
    return tile;
  }));
}

async function forecastHere() {
  const { flight, site } = state;
  const start = Math.floor(state.position);
  const steps = Math.round(Number($("horizon-select").value) * flight.rate);
  const window = forecastWindow(flight, start, steps, site.manifest.history_samples);
  const status = $("forecast-status");
  if (!window) {
    status.textContent = "A forecast needs 1.07 s of valid SAFE-mode history before this moment and at least 0.5 s after it. Scrub into a coloured arc.";
    return;
  }
  const button = $("forecast-button");
  button.disabled = true;
  setPlaying(false);
  scene?.clearForecasts();
  state.forecast = { start, steps: window.steps, measured: window.measured, results: {} };
  const arc = flight.arcAt(start);
  const edited = $("use-edited").checked;
  try {
    for (const method of METHOD_ORDER.filter((m) => state.enabled.has(m))) {
      status.textContent = `Forecasting ${(window.steps / flight.rate).toFixed(1)} s with ${SERIES[method].label}…`;
      const result = await runForecast({ method, airframe: flight.airframe, source: edited ? state.editor.getSource() : state.pristineSource,
        useSourceParameters: edited, stateHistory: window.stateHistory, commandHistory: window.commandHistory, command: window.command });
      state.forecast.results[method] = result;
      scene?.setForecast(method, result.states, start);
      renderForecast();
    }
    const shortened = window.steps < steps ? ` Shortened to ${(window.steps / flight.rate).toFixed(1)} s: valid data ends there.` : "";
    const role = arc ? (arc.role === "test" ? "This window is held-out test data." : `This window is ${arc.role} data, which the models saw during identification.`) : "This window is outside the paper's arcs.";
    status.textContent = `${role}${shortened}${edited ? " Physics: your edited source." : ""}`;
    setPlaying(true);
  } catch (error) {
    status.textContent = `Forecast failed: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------- tables
const METHOD_LABEL = { arx: "ARX", oem: "OEM", instantaneous: "Inst. UDE", temporal: "Temporal UDE" };
function table(host, caption, columns, rows, best = []) {
  const element = document.createElement("table");
  element.innerHTML = `<caption>${caption}</caption><thead><tr>${columns.map((c) => `<th scope="col">${c}</th>`).join("")}</tr></thead>`;
  const body = element.createTBody();
  rows.forEach((cells, r) => {
    const row = body.insertRow();
    cells.forEach((cell, c) => {
      const node = c === 0 ? document.createElement("th") : document.createElement("td");
      if (c === 0) node.scope = "row";
      node.innerHTML = cell;
      if (best[r]?.has(c)) node.className = "best";
      row.appendChild(node);
    });
  });
  host.replaceChildren(element);
}

function renderResults() {
  const { results } = state.site;
  legend($("horizon-legend"), METHOD_ORDER);
  horizonChart($("horizon-chart"), results);
  const horizons = Object.keys(results.pooled).sort((a, b) => a - b);
  const pooledRows = horizons.map((h) => [`${Number(h)} s`, ...results.methods.map((m) => results.pooled[h].common_score[m].toFixed(3)), results.pooled[h].windows]);
  const pooledBest = horizons.map((h) => {
    const values = results.methods.map((m) => results.pooled[h].common_score[m]);
    return new Set([values.indexOf(Math.min(...values)) + 1]);
  });
  table($("pooled-table"), "Pooled normalised score on all test windows (best in bold)", ["Horizon", ...results.methods.map((m) => METHOD_LABEL[m]), "Windows"], pooledRows, pooledBest);

  const select = $("regime-horizon");
  select.replaceChildren(...horizons.map((h) => new Option(`${Number(h)} s`, h, false, Number(h) === 1)));
  const units = ["deg", "deg", "deg/s", "deg/s", "deg/s", "m/s", "deg", "deg", "deg"];
  const names = ["φ", "θ", "p", "q", "r", "V", "γ", "α", "β"];
  const renderRegimes = () => {
    const rows = results.by_regime.filter((row) => row.horizon_s === Number(select.value));
    const best = rows.map((row) => new Set(results.output_names.map((name, j) => {
      const peers = rows.filter((other) => other.regime === row.regime).map((other) => other[name]);
      return row[name] === Math.min(...peers) ? j + 3 : -1;
    })));
    table($("regime-table"), `Simulation RMSE by regime at ${Number(select.value)} s (best per regime in bold)`,
      ["Regime", "Samples", "Method", ...names.map((n, j) => `${n} <small>${units[j]}</small>`)],
      rows.map((row) => [row.regime, row.samples, METHOD_LABEL[row.method], ...results.output_names.map((name) => row[name].toFixed(2))]), best);
  };
  select.addEventListener("change", renderRegimes);
  renderRegimes();

  const dash = (value, digits) => (value === null || value === undefined ? "—" : value.toFixed(digits));
  table($("event-table"), "The three held-out stall arcs: onset and recovery are the crossings of the separation-prior midpoint",
    ["Event", "Series", "Peak α <small>deg</small>", "Onset <small>s</small>", "Recovery <small>s</small>", "Min V <small>m/s</small>", "RMSE α <small>deg</small>", "RMSE q <small>deg/s</small>", ""],
    results.events.map((row) => [`${row.event}`, row.method === "measured" ? "Measured" : METHOD_LABEL[row.method], dash(row.peak_alpha_deg, 1), dash(row.onset_s, 2),
      dash(row.recovery_s, 2), dash(row.min_speed_m_s, 2), row.method === "measured" ? "—" : dash(row.rmse_alpha_deg, 2), row.method === "measured" ? "—" : dash(row.rmse_q_deg_s, 1),
      row.method === "measured" ? `<button type="button" class="link" data-event="${row.event}">Open in explorer</button>` : ""]));
  $("event-table").addEventListener("click", async (event) => {
    const target = event.target.closest("[data-event]");
    if (!target) return;
    const record = results.events.find((row) => String(row.event) === target.dataset.event && row.method === "measured");
    $("flight-select").value = record.segment;
    await selectFlight(record.segment, Math.round(record.forecast_start_s * state.site.manifest.rate_hz));
    $("horizon-select").value = "5";
    $("explorer").scrollIntoView({ behavior: "smooth" });
    forecastHere();
  });

  const { flights } = state.site.manifest;
  table($("flight-table"), "Flight records", ["Flight", "Airframe", "What was flown", "Duration <small>s</small>", "Fit arcs", "Development arcs", "Test arcs"],
    flights.map((f) => [f.name, f.airframe, f.purpose, (f.samples / state.site.manifest.rate_hz).toFixed(0),
      ...["fit", "development", "test"].map((role) => f.arcs.filter((arc) => arc.role === role).length)]));
}

// ---------------------------------------------------------------- start-up
async function init() {
  state.site = await loadSiteData();
  const { manifest, models } = state.site;
  worker = new Worker(new URL("./forecast_worker.js", import.meta.url), { type: "module" });
  worker.postMessage({ type: "init", models });
  scene = createScene($("scene"), METHOD_COLORS);

  $("flight-select").replaceChildren(...manifest.flights.map((f) => new Option(`${f.name.replace(/_/g, " ")} — ${f.purpose}`, f.name)));
  $("method-toggles").append(...METHOD_ORDER.map((method) => {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" checked value="${method}"><i class="key key-${method}"></i>${SERIES[method].label}`;
    label.firstChild.addEventListener("change", (event) => { state.enabled[event.target.checked ? "add" : "delete"](method); });
    return label;
  }));
  $("flight-select").addEventListener("change", (event) => selectFlight(event.target.value));
  $("camera-select").addEventListener("change", (event) => scene?.setCamera(event.target.value));
  $("play-toggle").addEventListener("click", () => setPlaying(!state.playing));
  $("scrub").addEventListener("input", (event) => { setPlaying(false); state.position = Number(event.target.value); showTime(); });
  $("forecast-button").addEventListener("click", forecastHere);
  window.addEventListener("resize", () => state.flight && paintRoleStrip());
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => state.flight && paintRoleStrip());

  renderResults();
  // Open on the held-out stall arc that crosses the separation prior, already forecast.
  const opening = state.site.results.events.find((row) => row.method === "measured" && row.onset_s !== null);
  $("flight-select").value = opening.segment;
  await selectFlight(opening.segment, Math.round(opening.forecast_start_s * manifest.rate_hz));
  $("horizon-select").value = "5";
  requestAnimationFrame(tick);

  state.pristineSource = await (await fetch("./public/modelica/SportCubCommanded.mo")).text();
  const sourceFor = (method) => applyParameters(state.pristineSource, modelicaParameters(models, method, state.flight.airframe));
  state.editor = await createEditor($("editor"), sourceFor("temporal"), (diagnostics) => {
    const errors = diagnostics.filter((d) => String(d.severity).toLowerCase() === "error" || d.severity === 1);
    $("editor-status").textContent = errors.length ? `${errors.length} error${errors.length > 1 ? "s" : ""}: ${errors[0].message}` : "Compiles cleanly.";
  });
  const reload = () => state.editor.setSource(sourceFor($("parameter-method").value));
  $("parameter-method").addEventListener("change", reload);
  $("editor-reset").addEventListener("click", reload);
  state.onFlightChange = () => { if (!$("use-edited").checked) reload(); };
  forecastHere();
}

init().catch((error) => {
  console.error(error);
  $("forecast-status").textContent = `The page failed to start: ${error.message}`;
});
