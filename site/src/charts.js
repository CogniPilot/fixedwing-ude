// SVG charts: shared-crosshair time-series small multiples and the score-vs-horizon plot.
// Series identity is colour + dash pattern + legend (four overlapping lines do not
// clear the colour-blind separation target on colour alone).

export const SERIES = {
  measured: { label: "Measured", color: "var(--text-primary)", dash: "", width: 2.5 },
  temporal: { label: "Temporal UDE", color: "var(--series-temporal)", dash: "", width: 2 },
  instantaneous: { label: "Instantaneous UDE", color: "var(--series-instantaneous)", dash: "7 4", width: 2 },
  arx: { label: "ARX", color: "var(--series-arx)", dash: "9 3 2 3", width: 2 },
  oem: { label: "OEM", color: "var(--series-oem)", dash: "2 4", width: 2 },
};
export const METHOD_ORDER = ["temporal", "instantaneous", "arx", "oem"];

const NS = "http://www.w3.org/2000/svg";
function svg(tag, attributes = {}, parent = null) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (parent) parent.appendChild(node);
  return node;
}

function niceTicks(low, high, count = 4) {
  const span = high - low || 1;
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.ceil(low / step) * step; v <= high + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  // Just enough decimals to tell neighbouring ticks apart.
  ticks.decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9) + (Math.round(step / power * 10) % 10 ? 1 : 0));
  return ticks;
}

const format = (value) => (Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 10 ? value.toFixed(1)
  : Math.abs(value) >= 0.1 || value === 0 ? value.toFixed(2) : value.toPrecision(2));

export function legend(container, keys) {
  container.replaceChildren(...keys.map((key) => {
    const item = document.createElement("span");
    item.className = "legend-item";
    const swatch = svg("svg", { width: 28, height: 10, "aria-hidden": "true" });
    svg("line", { x1: 1, x2: 27, y1: 5, y2: 5, stroke: SERIES[key].color, "stroke-width": SERIES[key].width,
      "stroke-dasharray": SERIES[key].dash, "stroke-linecap": "round" }, swatch);
    item.append(swatch, SERIES[key].label);
    return item;
  }));
}

// panels: [{ title, unit, series: { key: number[] }, bands?: [{ from, to, label }], reference?: { value, label } }]
// `time` is shared. Returns { setCursor(t) } so the 3D playback can drive the crosshair.
export function timeSeriesGrid(container, time, panels, options = {}) {
  container.replaceChildren();
  const width = 320;
  const height = 150;
  const margin = { left: 44, right: 10, top: 22, bottom: 22 };
  const x0 = time[0];
  const x1 = time[time.length - 1];
  const sx = (t) => margin.left + ((t - x0) / (x1 - x0 || 1)) * (width - margin.left - margin.right);
  const cursors = [];
  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  tooltip.hidden = true;

  panels.forEach((panel) => {
    const figure = document.createElement("figure");
    figure.className = "chart-panel";
    const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img",
      "aria-label": `${panel.title} over the forecast, measured and predicted` }, figure);
    const values = Object.values(panel.series).flat().filter(Number.isFinite);
    if (panel.reference) values.push(panel.reference.value);
    let low = Math.min(...values);
    let high = Math.max(...values);
    const pad = (high - low || 1) * 0.08;
    low -= pad;
    high += pad;
    const sy = (v) => height - margin.bottom - ((v - low) / (high - low)) * (height - margin.top - margin.bottom);

    (panel.bands || []).forEach((band) => {
      svg("rect", { x: sx(band.from), y: margin.top, width: Math.max(1, sx(band.to) - sx(band.from)),
        height: height - margin.top - margin.bottom, fill: "var(--band)" }, root);
    });
    const yTicks = niceTicks(low, high);
    yTicks.forEach((tick) => {
      svg("line", { x1: margin.left, x2: width - margin.right, y1: sy(tick), y2: sy(tick), stroke: "var(--grid)", "stroke-width": 1 }, root);
      svg("text", { x: margin.left - 6, y: sy(tick) + 3.5, "text-anchor": "end", class: "tick" }, root).textContent = tick.toFixed(Math.min(yTicks.decimals, 4));
    });
    niceTicks(x0, x1, 5).forEach((tick) => {
      svg("text", { x: sx(tick), y: height - 6, "text-anchor": "middle", class: "tick" }, root).textContent = `${tick}`;
    });
    if (panel.reference) {
      svg("line", { x1: margin.left, x2: width - margin.right, y1: sy(panel.reference.value), y2: sy(panel.reference.value),
        stroke: "var(--axis)", "stroke-width": 1 }, root);
      svg("text", { x: width - margin.right, y: sy(panel.reference.value) - 4, "text-anchor": "end", class: "tick" }, root)
        .textContent = panel.reference.label;
    }
    svg("text", { x: margin.left, y: 13, class: "panel-title" }, root).textContent = `${panel.title} [${panel.unit}]`;

    // Measured on top, methods beneath in a fixed order.
    [...METHOD_ORDER.slice().reverse(), "measured"].forEach((key) => {
      const data = panel.series[key];
      if (!data) return;
      let path = "";
      let pen = false;
      data.forEach((value, i) => {
        if (!Number.isFinite(value)) { pen = false; return; }
        path += `${pen ? "L" : "M"}${sx(time[i]).toFixed(1)},${sy(value).toFixed(1)}`;
        pen = true;
      });
      svg("path", { d: path, fill: "none", stroke: SERIES[key].color, "stroke-width": SERIES[key].width,
        "stroke-dasharray": SERIES[key].dash, "stroke-linejoin": "round", "stroke-linecap": "round" }, root);
    });

    const cursor = svg("line", { y1: margin.top, y2: height - margin.bottom, stroke: "var(--text-secondary)", "stroke-width": 1, visibility: "hidden" }, root);
    cursors.push(cursor);
    const hit = svg("rect", { x: margin.left, y: margin.top, width: width - margin.left - margin.right,
      height: height - margin.top - margin.bottom, fill: "transparent" }, root);
    hit.addEventListener("pointermove", (event) => {
      const box = root.getBoundingClientRect();
      const t = x0 + (((event.clientX - box.left) / box.width) * width - margin.left) / (width - margin.left - margin.right) * (x1 - x0);
      const index = Math.max(0, Math.min(time.length - 1, Math.round((t - x0) / ((x1 - x0) / (time.length - 1 || 1)))));
      setCursor(time[index]);
      tooltip.hidden = false;
      tooltip.replaceChildren();
      const heading = document.createElement("strong");
      heading.textContent = `${panel.title} at ${time[index].toFixed(2)} s`;
      tooltip.append(heading);
      ["measured", ...METHOD_ORDER].forEach((key) => {
        const value = panel.series[key]?.[index];
        if (!Number.isFinite(value)) return;
        const row = document.createElement("span");
        row.innerHTML = `<i style="background:${SERIES[key].color}"></i>${SERIES[key].label}<b>${format(value)} ${panel.unit}</b>`;
        tooltip.append(row);
      });
      const host = container.getBoundingClientRect();
      tooltip.style.left = `${Math.min(event.clientX - host.left + 14, host.width - 210)}px`;
      tooltip.style.top = `${event.clientY - host.top + 14}px`;
      options.onHover?.(time[index]);
    });
    hit.addEventListener("pointerleave", () => { tooltip.hidden = true; });
    container.appendChild(figure);
  });
  container.appendChild(tooltip);

  function setCursor(t) {
    const visible = t >= x0 && t <= x1;
    cursors.forEach((cursor) => {
      cursor.setAttribute("visibility", visible ? "visible" : "hidden");
      cursor.setAttribute("x1", sx(t));
      cursor.setAttribute("x2", sx(t));
    });
  }
  return { setCursor };
}

// Pooled normalised score against forecast horizon, one line per method.
export function horizonChart(container, results, scoreKey = "common_score") {
  container.replaceChildren();
  const width = 560;
  const height = 300;
  const margin = { left: 48, right: 128, top: 16, bottom: 40 };
  const horizons = Object.keys(results.pooled).map(Number).sort((a, b) => a - b);
  const value = (h, method) => results.pooled[h.toFixed(1)]?.[scoreKey][method] ?? results.pooled[String(h)][scoreKey][method];
  const all = horizons.flatMap((h) => Object.keys(SERIES).filter((k) => k !== "measured").map((m) => value(h, m)));
  const high = Math.ceil(Math.max(...all) * 20) / 20;
  const low = Math.floor(Math.min(...all) * 20) / 20;
  const sx = (h) => margin.left + (Math.log(h / horizons[0]) / Math.log(horizons[horizons.length - 1] / horizons[0])) * (width - margin.left - margin.right);
  const sy = (v) => height - margin.bottom - ((v - low) / (high - low)) * (height - margin.top - margin.bottom);
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img",
    "aria-label": "Pooled normalised prediction error against forecast horizon for the four methods" }, container);
  niceTicks(low, high, 5).forEach((tick) => {
    svg("line", { x1: margin.left, x2: width - margin.right, y1: sy(tick), y2: sy(tick), stroke: "var(--grid)", "stroke-width": 1 }, root);
    svg("text", { x: margin.left - 8, y: sy(tick) + 4, "text-anchor": "end", class: "tick" }, root).textContent = tick.toFixed(2);
  });
  horizons.forEach((h) => {
    svg("text", { x: sx(h), y: height - margin.bottom + 18, "text-anchor": "middle", class: "tick" }, root).textContent = `${h} s`;
  });
  svg("text", { x: (margin.left + width - margin.right) / 2, y: height - 4, "text-anchor": "middle", class: "axis-label" }, root).textContent = "Forecast horizon (log scale)";
  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  tooltip.hidden = true;

  // End labels, nudged apart with leader-free spacing only when they would overlap.
  const ends = METHOD_ORDER.map((method) => ({ method, y: sy(value(horizons[horizons.length - 1], method)) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i += 1) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;

  METHOD_ORDER.slice().reverse().forEach((method) => {
    const points = horizons.map((h) => [sx(h), sy(value(h, method))]);
    svg("path", { d: points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(""), fill: "none",
      stroke: SERIES[method].color, "stroke-width": 2, "stroke-dasharray": SERIES[method].dash, "stroke-linejoin": "round", "stroke-linecap": "round" }, root);
    points.forEach(([x, y], i) => {
      const dot = svg("circle", { cx: x, cy: y, r: 4.5, fill: SERIES[method].color, stroke: "var(--surface-1)", "stroke-width": 2 }, root);
      const target = svg("circle", { cx: x, cy: y, r: 12, fill: "transparent" }, root);
      target.addEventListener("pointerenter", () => {
        tooltip.hidden = false;
        tooltip.innerHTML = `<strong>${SERIES[method].label}, ${horizons[i]} s</strong><span>Score<b>${value(horizons[i], method).toFixed(3)}</b></span>`
          + `<span>Windows<b>${results.pooled[horizons[i].toFixed(1)].windows}</b></span>`;
        const host = container.getBoundingClientRect();
        const box = dot.getBoundingClientRect();
        tooltip.style.left = `${Math.min(box.left - host.left + 14, host.width - 200)}px`;
        tooltip.style.top = `${box.top - host.top + 14}px`;
      });
      target.addEventListener("pointerleave", () => { tooltip.hidden = true; });
    });
    const end = ends.find((item) => item.method === method);
    svg("text", { x: width - margin.right + 10, y: end.y + 4, class: "end-label" }, root).textContent = SERIES[method].label;
  });
  container.appendChild(tooltip);
}
