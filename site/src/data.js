// Loads the exported flights (float32 tables) and result tables.

const fetchJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
};

export async function loadSiteData(base = "./public/data") {
  const [manifest, results, models] = await Promise.all([
    fetchJson(`${base}/flights.json`), fetchJson(`${base}/results.json`), fetchJson(`${base}/paper_models.json`)]);
  return { base, manifest, results, models, flights: new Map() };
}

// A flight is a row-major float32 table; see flights.json `columns`.
export async function loadFlight(site, name) {
  if (site.flights.has(name)) return site.flights.get(name);
  const entry = site.manifest.flights.find((flight) => flight.name === name);
  const response = await fetch(`${site.base}/${entry.file}`);
  if (!response.ok) throw new Error(`${entry.file}: HTTP ${response.status}`);
  const table = new Float32Array(await response.arrayBuffer());
  const width = site.manifest.columns.length;
  const flight = {
    ...entry,
    rate: site.manifest.rate_hz,
    width,
    table,
    state: (i) => Array.from(table.subarray(i * width, i * width + 12)),
    command: (i) => Array.from(table.subarray(i * width + 12, i * width + 16)),
    good: (i) => table[i * width + 16] === 1 && table[i * width + 17] === 1,
    tracked: (i) => Number.isFinite(table[i * width]),
    arcAt: (i) => entry.arcs.find((arc) => arc.start <= i && i < arc.stop) || null,
  };
  site.flights.set(name, flight);
  return flight;
}

// A forecast may start at sample i when the 64-sample prehistory and the whole
// horizon are valid SAFE data (the paper's eligibility rule, any role).
export function forecastWindow(flight, start, steps, history) {
  const first = start - history + 1;
  if (first < 0 || start + steps >= flight.samples) return null;
  for (let i = first; i <= start; i += 1) if (!flight.good(i)) return null;
  let available = 0;
  while (available < steps && flight.good(start + available + 1)) available += 1;
  if (available < Math.min(steps, 30)) return null;
  const range = (a, b, pick) => Array.from({ length: b - a }, (_, k) => pick(a + k));
  return {
    steps: available,
    stateHistory: range(first, start + 1, flight.state),
    commandHistory: range(first, start + 1, flight.command),
    command: range(start, start + available + 1, flight.command),
    measured: range(start, start + available + 1, flight.state),
  };
}
