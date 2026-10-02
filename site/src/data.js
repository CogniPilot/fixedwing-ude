// Loads the exported flights (float32 tables), the paper's stored forecasts
// and the score scales.

const fetchJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
};

const fetchFloat32 = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Float32Array(await response.arrayBuffer());
};

export async function loadSiteData(base = "./public/data") {
  const [manifest, results, forecasts] = await Promise.all([
    fetchJson(`${base}/flights.json`), fetchJson(`${base}/results.json`), fetchJson(`${base}/forecasts.json`)]);
  return { base, manifest, results, forecasts, flights: new Map(), tables: new Map() };
}

// A flight is a row-major float32 table; see flights.json `columns`.
export async function loadFlight(site, name) {
  if (site.flights.has(name)) return site.flights.get(name);
  const entry = site.manifest.flights.find((flight) => flight.name === name);
  const table = await fetchFloat32(`${site.base}/${entry.file}`);
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

// One file of stored forecasts (row-major float32, forecasts.json `width` columns), cached.
export async function loadForecastTable(site, file) {
  if (!site.tables.has(file)) site.tables.set(file, fetchFloat32(`${site.base}/${file}`));
  return site.tables.get(file);
}
