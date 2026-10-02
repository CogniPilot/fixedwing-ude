import { loadSiteData, loadFlight, loadForecastTable } from "./data.js";
import { SERIES, METHOD_ORDER, legend, timeSeriesGrid } from "./charts.js";

const $ = (id) => document.getElementById(id);
const DEG = 180 / Math.PI;
const ROLE_COLORS = { fit: "--role-fit", development: "--role-development", test: "--role-test" };
// Output panels: [title, unit, index into the nine outputs, scale].
const OUTPUT_PANELS = [["Roll φ", "deg", 0, DEG], ["Pitch θ", "deg", 1, DEG], ["Speed V", "m/s", 5, 1],
  ["Roll rate p", "deg/s", 2, DEG], ["Pitch rate q", "deg/s", 3, DEG], ["Yaw rate r", "deg/s", 4, DEG],
  ["Body incidence α", "deg", 7, DEG], ["Sideslip β", "deg", 8, DEG], ["Flight-path angle γ", "deg", 6, DEG]];
const HORIZON_LABEL = { "0.5": "0.5 s", 1: "1 s", 2: "2 s", 5: "5 s", 10: "10 s (one representative window)", event: "the held-out stall arcs" };

const state = {
  site: null, flight: null, position: 0, playing: false, lastMs: 0,
  enabled: new Set(METHOD_ORDER), windows: [], forecast: null, grid: null,
};

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
  // Where the paper's stored forecasts at the selected horizon start.
  context.fillStyle = cssVar("--text-primary");
  state.windows.forEach((window) => {
    const x = (window.start / flight.samples) * canvas.width;
    context.fillRect(Math.round(x), 0, Math.max(1, devicePixelRatio), canvas.height / 2);
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
  if (state.flight && state.playing) {
    state.position += deltaS * state.flight.rate;
    // While a forecast is shown, loop over it (with a one-second lead-in) instead of the whole flight.
    const loop = state.forecast && { from: Math.max(0, state.forecast.start - 60), to: state.forecast.start + state.forecast.steps };
    if (loop && (state.position > loop.to || state.position < loop.from)) state.position = loop.from;
    if (state.position >= state.flight.samples - 1) state.position = 0;
    showTime();
  }
  requestAnimationFrame(tick);
}

function setPlaying(playing) {
  state.playing = playing;
  $("play-toggle").textContent = playing ? "❚❚" : "▶";
  $("play-toggle").setAttribute("aria-label", playing ? "Pause" : "Play");
}

// The stored windows of the current flight at the selected horizon, in time order.
function collectWindows() {
  const horizon = $("horizon-select").value;
  state.windows = state.site.forecasts.windows
    .filter((window) => window.segment === state.flight.name && window.horizon === horizon)
    .sort((a, b) => a.start - b.start);
  const count = state.windows.length;
  $("window-count").textContent = count ? `${count} stored forecast${count > 1 ? "s" : ""} at ${HORIZON_LABEL[horizon]} on this flight.`
    : `No stored forecast at ${HORIZON_LABEL[horizon]} on this flight.`;
  $("window-prev").disabled = $("window-next").disabled = count < 2;
  $("forecast-button").disabled = count === 0;
}

async function selectFlight(name, startIndex = null) {
  state.flight = await loadFlight(state.site, name);
  state.forecast = null;
  $("scrub").max = state.flight.samples - 1;
  collectWindows();
  state.position = startIndex ?? state.windows[0]?.start ?? 0;
  paintRoleStrip();
  showTime();
  $("series-grid").replaceChildren();
  $("series-legend").replaceChildren();
  $("score-row").replaceChildren();
  $("forecast-status").textContent = "";
}

// ---------------------------------------------------------------- forecasts
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
  if (!forecast) return;
  const time = Array.from({ length: forecast.steps + 1 }, (_, k) => k / flight.rate);
  const methods = METHOD_ORDER.filter((method) => state.enabled.has(method));
  const panels = OUTPUT_PANELS.map(([title, unit, index, scale]) => {
    const series = { measured: forecast.measured.map((row) => row[index] * scale) };
    methods.forEach((method) => { series[method] = forecast.results[method].map((row) => row[index] * scale); });
    return { title, unit, series };
  });
  // Body incidence at which the wing reaches the separation prior's midpoint.
  const priors = state.site.forecasts.stall_priors;
  panels[6].reference = { value: (priors.alpha_stall_rad - priors.wing_incidence_rad) * DEG, label: "separation prior midpoint" };
  legend($("series-legend"), ["measured", ...methods]);
  state.grid = timeSeriesGrid($("series-grid"), time, panels, {
    onHover: (t) => { setPlaying(false); state.position = forecast.start + Math.round(t * flight.rate); showTime(); },
  });
  $("score-row").replaceChildren(...methods.map((method) => {
    const tile = document.createElement("div");
    tile.className = "score-tile";
    tile.innerHTML = `<span><i class="key key-${method}"></i>${SERIES[method].label}</span><b>${windowScore(forecast.results[method], forecast.measured).toFixed(3)}</b><small>score on this window</small>`;
    return tile;
  }));
}

// Show stored window number `index` of the current flight and horizon.
async function showWindow(index) {
  const window = state.windows[index];
  if (!window) return;
  const { forecasts } = state.site;
  const table = await loadForecastTable(state.site, window.file);
  const { width } = forecasts;
  const rowsOf = (column) => Array.from({ length: window.steps + 1 }, (_, k) => {
    const offset = (window.row + k) * width + column * 9;
    return Array.from(table.subarray(offset, offset + 9));
  });
  const results = {};
  forecasts.columns.forEach((name, column) => { if (name !== "measured") results[name] = rowsOf(column); });
  state.forecast = { index, start: window.start, steps: window.steps, measured: rowsOf(0), results };
  state.position = window.start;
  showTime();
  renderForecast();
  const kind = window.kind === "event" ? `Held-out stall arc ${window.event} (${index + 1} of ${state.windows.length})`
    : window.kind === "representative" ? "The paper's representative ten-second forecast, a held-out window"
    : `Held-out test window ${index + 1} of ${state.windows.length}`;
  $("forecast-status").textContent = `${kind}, starting at ${(window.start / state.flight.rate).toFixed(1)} s, ${(window.steps / state.flight.rate).toFixed(1)} s long.`;
  setPlaying(true);
}

// The stored window whose start is nearest the scrub position.
function forecastHere() {
  if (!state.windows.length) return;
  const here = state.position;
  let best = 0;
  state.windows.forEach((window, i) => { if (Math.abs(window.start - here) < Math.abs(state.windows[best].start - here)) best = i; });
  showWindow(best);
}

function stepWindow(delta) {
  const count = state.windows.length;
  if (!count) return;
  const current = state.forecast?.index ?? -1;
  showWindow(current < 0 ? (delta > 0 ? 0 : count - 1) : (current + delta + count) % count);
}

async function openEvent(number) {
  const window = state.site.forecasts.windows.find((w) => w.kind === "event" && w.event === number);
  if (!window) return;
  $("flight-select").value = window.segment;
  $("horizon-select").value = "event";
  await selectFlight(window.segment, window.start);
  showWindow(state.windows.indexOf(window));
}

// ---------------------------------------------------------------- start-up
async function init() {
  state.site = await loadSiteData();
  const { manifest } = state.site;

  $("flight-select").replaceChildren(...manifest.flights.map((f) => new Option(`${f.name.replace(/_/g, " ")} — ${f.purpose}`, f.name)));
  $("method-toggles").append(...METHOD_ORDER.map((method) => {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" checked value="${method}"><i class="key key-${method}"></i>${SERIES[method].label}`;
    label.firstChild.addEventListener("change", (event) => { state.enabled[event.target.checked ? "add" : "delete"](method); renderForecast(); });
    return label;
  }));
  $("flight-select").addEventListener("change", (event) => selectFlight(event.target.value));
  $("horizon-select").addEventListener("change", () => {
    const shown = state.forecast !== null;
    state.forecast = null;
    collectWindows();
    paintRoleStrip();
    if (shown) forecastHere();
  });
  $("play-toggle").addEventListener("click", () => setPlaying(!state.playing));
  $("scrub").addEventListener("input", (event) => { setPlaying(false); state.position = Number(event.target.value); showTime(); });
  $("forecast-button").addEventListener("click", forecastHere);
  $("window-prev").addEventListener("click", () => stepWindow(-1));
  $("window-next").addEventListener("click", () => stepWindow(1));
  window.addEventListener("resize", () => state.flight && paintRoleStrip());
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => state.flight && paintRoleStrip());

  requestAnimationFrame(tick);
  // Open on the held-out stall arc that crosses the separation prior.
  const opening = state.site.results.events.find((row) => row.method === "measured" && row.onset_s !== null);
  await openEvent(Number(opening.event));
}

init().catch((error) => {
  console.error(error);
  $("forecast-status").textContent = `The page failed to start: ${error.message}`;
});
