// Data page: the flight table with per-flight downloads and the two download links.

const $ = (id) => document.getElementById(id);
const megabytes = (bytes) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e3).toFixed(0)} kB`);
const percent = (fraction) => `${(fraction * 100).toFixed(0)} %`;

async function init() {
  const response = await fetch("./public/data/release.json");
  if (!response.ok) throw new Error(`release.json: HTTP ${response.status}`);
  const release = await response.json();
  // The records are not published yet: the links report that instead of downloading.
  const link = (entry, label) => `<button type="button" class="link record-link">${label}</button> <small class="size">${megabytes(entry.bytes)}</small>`;

  // No rosbag host yet: the button reports that instead of downloading.
  $("rosbag-button").addEventListener("click", () => { $("rosbag-error").hidden = false; });
  $("package-button").addEventListener("click", () => { $("package-error").hidden = false; });
  $("download-note").textContent = `Rosbags: ${release.rosbags.count} ROS 2 bags in MCAP format, ${release.rosbags.megabytes} MB. Code and models: the reproducibility package on GitHub.`;

  const table = document.createElement("table");
  table.innerHTML = `<thead><tr>${["Flight", "Airframe", "What was flown", "Duration", "SAFE", "Tracked", "Download"].map((c) => `<th scope="col"${c === "What was flown" || c === "Download" ? ' class="left"' : ""}>${c}</th>`).join("")}</tr></thead>`;
  const body = table.createTBody();
  release.flights.forEach((flight) => {
    const row = body.insertRow();
    row.innerHTML = `<th scope="row"><code>${flight.name}</code></th><td>${flight.airframe}</td><td class="wrap">${flight.purpose}</td>
      <td>${flight.duration_s.toFixed(0)} s</td><td>${percent(flight.safe_fraction)}</td><td>${percent(flight.valid_fraction)}</td>
      <td class="left">${link(flight.npz, "NPZ")} · ${link(flight.csv, "CSV")}</td>`;
  });
  $("flight-table").replaceChildren(table);
  table.addEventListener("click", (event) => { if (event.target.closest(".record-link")) $("records-error").hidden = false; });
}

init().catch((error) => {
  console.error(error);
  $("flight-table").textContent = `The flight table failed to load: ${error.message}`;
});
