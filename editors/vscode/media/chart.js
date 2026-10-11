// Charts in ChatDGC (ChatGPT's interactive charts): a reply's ```chart block, JSON the model wrote, drawn as SVG here
// with no library and nothing loaded from anywhere. Bar (grouped, stacked, horizontal), line, area, pie and scatter;
// hover for values, the legend shows or hides a series, and the card offers the numbers as a table, Copy data and
// Save image. Words in it (title, labels, names) are always text, never markup.
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const W = 640, H = 340, PAD = { top: 16, right: 20, bottom: 56, left: 64 };
  const KINDS = ["bar", "line", "area", "pie", "scatter"];
  const MAX_SERIES = 8, MAX_POINTS = 60, MAX_SCATTER = 500;

  const svgEl = (tag, attrs = {}, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, String(v));
    if (text !== undefined) n.textContent = String(text);
    return n;
  };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = String(text); return n; };
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v.replace(/,/g, ""))) ? Number(v.replace(/,/g, "")) : null);

  /** The model's JSON, checked and bounded; null when it isn't a chart we can draw (the block stays as code). */
  function normalize(raw) {
    if (!raw || typeof raw !== "object") return null;
    const type = String(raw.type || "bar").toLowerCase();
    if (!KINDS.includes(type)) return null;
    const series = (Array.isArray(raw.series) ? raw.series : []).slice(0, MAX_SERIES).map((s, i) => ({
      name: String(s?.name ?? `Series ${i + 1}`).slice(0, 60),
      values: Array.isArray(s?.values) ? s.values.slice(0, MAX_POINTS).map(num) : [],
      points: Array.isArray(s?.points) ? s.points.slice(0, MAX_SCATTER).map((p) => [num(p?.[0]), num(p?.[1])]).filter(([x, y]) => x !== null && y !== null) : [],
    }));
    if (!series.length) return null;
    const x = (Array.isArray(raw.x) ? raw.x : Array.isArray(raw.labels) ? raw.labels : []).slice(0, MAX_POINTS).map((v) => String(v ?? "").slice(0, 40));
    if (type === "scatter") { if (!series.some((s) => s.points.length)) return null; }
    else {
      const n = Math.max(x.length, ...series.map((s) => s.values.length));
      if (!n || series.every((s) => s.values.every((v) => v === null))) return null;
      while (x.length < n) x.push(String(x.length + 1));
      for (const s of series) while (s.values.length < n) s.values.push(null);
    }
    const unit = String(raw.unit || "").slice(0, 8);
    // A label that's only the unit (or a lone symbol) says nothing the ticks don't, and drew as a stray glyph.
    const label = (v) => { const t = String(v || "").trim().slice(0, 60); return t.length < 3 || t === unit ? "" : t; };
    return { type, x, series, title: String(raw.title || "").slice(0, 120), xLabel: label(raw.x_label),
             yLabel: label(raw.y_label), unit,
             stacked: raw.stacked === true && type !== "scatter", horizontal: raw.horizontal === true && type === "bar" };
  }

  /** Round tick steps (1, 2, 2.5, 5 × 10^n) covering [lo, hi], zero included for bars. */
  function ticks(lo, hi, count = 5) {
    if (lo === hi) { hi = lo + 1; lo = Math.min(0, lo); }
    const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
    const start = Math.floor(lo / step) * step, end = Math.ceil(hi / step) * step;
    const out = [];
    for (let v = start; v <= end + step / 2; v += step) out.push(Math.round(v / step) * step);
    return out;
  }
  function format(v, unit) {
    if (v === null || v === undefined) return "–";
    const abs = Math.abs(v);
    const text = abs >= 1e5 ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(v)
      : new Intl.NumberFormat(undefined, { maximumFractionDigits: abs < 1 ? 3 : abs < 100 ? 2 : 0 }).format(v);
    if (!unit) return text;
    return /^[$₹€£¥]$/.test(unit) ? (v < 0 ? `-${unit}${text.slice(1)}` : `${unit}${text}`) : `${text}${unit === "%" ? "%" : " " + unit}`;
  }

  function draw(spec, hidden, tip) {
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "cd-chart-svg", role: "img", "aria-label": spec.title || `${spec.type} chart` });
    const shown = spec.series.map((s, i) => ({ ...s, i })).filter((s) => !hidden.has(s.i));
    const show = (evt, text) => tip(evt, text), hide = () => tip(null);
    const mark = (node, text) => { node.append(svgEl("title", {}, text)); node.addEventListener("mousemove", (e) => show(e, text)); node.addEventListener("mouseleave", hide); return node; };
    if (spec.type === "pie") {
      const s = shown[0] || spec.series[0];
      const values = spec.x.map((label, j) => ({ label, v: Math.max(0, s.values[j] || 0), j })).filter((d) => d.v > 0);
      const total = values.reduce((a, d) => a + d.v, 0) || 1;
      let angle = -Math.PI / 2;
      const cx = W / 2, cy = (H - 20) / 2 + 6, r = 130, inner = 70;
      for (const d of values) {
        const sweep = (d.v / total) * Math.PI * 2, end = angle + sweep, large = sweep > Math.PI ? 1 : 0;
        const p = (a, rad) => `${cx + rad * Math.cos(a)} ${cy + rad * Math.sin(a)}`;
        const path = sweep >= Math.PI * 2 - 1e-9
          ? `M ${p(angle, r)} A ${r} ${r} 0 1 1 ${p(angle + Math.PI, r)} A ${r} ${r} 0 1 1 ${p(angle, r)} M ${p(angle, inner)} A ${inner} ${inner} 0 1 0 ${p(angle + Math.PI, inner)} A ${inner} ${inner} 0 1 0 ${p(angle, inner)} Z`
          : `M ${p(angle, r)} A ${r} ${r} 0 ${large} 1 ${p(end, r)} L ${p(end, inner)} A ${inner} ${inner} 0 ${large} 0 ${p(angle, inner)} Z`;
        svg.append(mark(svgEl("path", { d: path, class: `cd-chart-mark cd-chart-c${d.j % MAX_SERIES}`, "fill-rule": "evenodd" }),
                        `${d.label}: ${format(d.v, spec.unit)} (${Math.round((d.v / total) * 100)}%)`));
        angle = end;
      }
      if (spec.unit !== "%") svg.append(svgEl("text", { x: cx, y: cy + 5, "text-anchor": "middle", class: "cd-chart-total" }, format(total, spec.unit)));
      return svg;
    }
    const plot = { x: PAD.left, y: PAD.top, w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom };
    const g = svgEl("g");
    svg.append(g);
    if (spec.type === "scatter") {
      const pts = shown.flatMap((s) => s.points);
      if (!pts.length) return svg;
      const xt = ticks(Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0])));
      const yt = ticks(Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1])));
      const X = (v) => plot.x + ((v - xt[0]) / (xt.at(-1) - xt[0])) * plot.w, Y = (v) => plot.y + plot.h - ((v - yt[0]) / (yt.at(-1) - yt[0])) * plot.h;
      axes(g, plot, yt.map((v) => [Y(v), format(v, spec.unit)]), xt.map((v) => [X(v), format(v)]), spec);
      for (const s of shown) for (const [x, y] of s.points) {
        g.append(mark(svgEl("circle", { cx: X(x), cy: Y(y), r: 4, class: `cd-chart-mark cd-chart-c${s.i}` }), `${s.name}: ${format(x)}, ${format(y, spec.unit)}`));
      }
      return svg;
    }
    const n = spec.x.length;
    const sums = spec.x.map((_, j) => shown.reduce((a, s) => a + Math.max(0, s.values[j] || 0), 0));
    const negs = spec.x.map((_, j) => shown.reduce((a, s) => a + Math.min(0, s.values[j] || 0), 0));
    const all = shown.flatMap((s) => s.values.filter((v) => v !== null));
    // Bars and areas stand on zero; a line fits its data, so a change from 1,000 to 1,100 is visible.
    const fit = spec.type === "line" && !spec.stacked;
    const lo = spec.stacked ? Math.min(0, ...negs) : fit ? Math.min(...all) : Math.min(0, ...all);
    const hi = spec.stacked ? Math.max(0, ...sums) : fit ? Math.max(...all) : Math.max(0, ...all);
    const vt = ticks(lo, hi === lo ? lo + 1 : hi);
    const span = vt.at(-1) - vt[0] || 1;
    if (spec.horizontal) {
      const V = (v) => plot.x + ((v - vt[0]) / span) * plot.w, band = plot.h / n;
      axes(g, plot, spec.x.map((label, j) => [plot.y + band * (j + 0.5), label]), vt.map((v) => [V(v), format(v, spec.unit)]), spec, true);
      bars(g, spec, shown, n, band, (j) => plot.y + band * j, V, mark, true);
      return svg;
    }
    const V = (v) => plot.y + plot.h - ((v - vt[0]) / span) * plot.h, band = plot.w / n;
    axes(g, plot, vt.map((v) => [V(v), format(v, spec.unit)]), spec.x.map((label, j) => [plot.x + band * (j + 0.5), label]), spec);
    if (spec.type === "bar") { bars(g, spec, shown, n, band, (j) => plot.x + band * j, V, mark, false); return svg; }
    const base = spec.x.map(() => 0);
    for (const s of shown) {
      const pts = s.values.map((v, j) => (v === null ? null : [plot.x + band * (j + 0.5), V(spec.stacked ? (base[j] += v) : v)]));
      const line = pts.reduce((d, p, j) => (p ? d + `${d && pts[j - 1] ? "L" : "M"} ${p[0]} ${p[1]} ` : d), "");
      if (spec.type === "area") {
        const kept = pts.filter(Boolean);
        if (kept.length > 1) g.append(svgEl("path", { d: `${line}L ${kept.at(-1)[0]} ${V(0)} L ${kept[0][0]} ${V(0)} Z`, class: `cd-chart-area cd-chart-c${s.i}` }));
      }
      g.append(svgEl("path", { d: line, class: `cd-chart-line cd-chart-c${s.i}`, fill: "none" }));
      s.values.forEach((v, j) => {
        if (pts[j]) g.append(mark(svgEl("circle", { cx: pts[j][0], cy: pts[j][1], r: n > 30 ? 2.5 : 4, class: `cd-chart-mark cd-chart-c${s.i}` }),
                                  `${spec.x[j]} · ${s.name}: ${format(v, spec.unit)}`));
      });
    }
    return svg;
  }

  function bars(g, spec, shown, n, band, start, V, mark, horizontal) {
    const gap = band * 0.2, inner = band - gap, width = spec.stacked ? inner : inner / Math.max(1, shown.length);
    const up = spec.x.map(() => 0), down = spec.x.map(() => 0);
    shown.forEach((s, k) => s.values.forEach((v, j) => {
      if (v === null) return;
      const from = spec.stacked ? (v >= 0 ? up[j] : down[j]) : 0, to = from + v;
      if (spec.stacked) { if (v >= 0) up[j] = to; else down[j] = to; }
      const a = V(Math.min(from, to)), b = V(Math.max(from, to));
      const offset = start(j) + gap / 2 + (spec.stacked ? 0 : width * k);
      const rect = horizontal ? svgEl("rect", { x: a, y: offset, width: Math.max(1, b - a), height: width, rx: 2 })
                              : svgEl("rect", { x: offset, y: b, width, height: Math.max(1, a - b), rx: 2 });
      rect.setAttribute("class", `cd-chart-mark cd-chart-c${s.i}`);
      g.append(mark(rect, `${spec.x[j]} · ${s.name}: ${format(v, spec.unit)}`));
    }));
  }

  function axes(g, plot, valueTicks, categoryTicks, spec, horizontal = false) {
    // valueTicks lie along the value axis (y, or x when horizontal); categoryTicks along the other.
    const crowded = categoryTicks.length > 8 && !horizontal;
    for (const [pos, label] of valueTicks) {
      if (horizontal) {
        g.append(svgEl("line", { x1: pos, x2: pos, y1: plot.y, y2: plot.y + plot.h, class: "cd-chart-grid" }));
        g.append(svgEl("text", { x: pos, y: plot.y + plot.h + 16, "text-anchor": "middle", class: "cd-chart-tick" }, label));
      } else {
        g.append(svgEl("line", { x1: plot.x, x2: plot.x + plot.w, y1: pos, y2: pos, class: "cd-chart-grid" }));
        g.append(svgEl("text", { x: plot.x - 8, y: pos + 4, "text-anchor": "end", class: "cd-chart-tick" }, label));
      }
    }
    const every = Math.ceil(categoryTicks.length / (horizontal ? 14 : crowded ? 16 : 12));
    categoryTicks.forEach(([pos, label], j) => {
      if (j % every) return;
      const short = label.length > 14 ? label.slice(0, 13) + "…" : label;
      if (horizontal) g.append(svgEl("text", { x: plot.x - 8, y: pos + 4, "text-anchor": "end", class: "cd-chart-tick" }, short));
      else if (crowded) g.append(svgEl("text", { x: pos, y: plot.y + plot.h + 14, "text-anchor": "end", transform: `rotate(-35 ${pos} ${plot.y + plot.h + 14})`, class: "cd-chart-tick" }, short));
      else g.append(svgEl("text", { x: pos, y: plot.y + plot.h + 18, "text-anchor": "middle", class: "cd-chart-tick" }, short));
    });
    g.append(svgEl("line", { x1: plot.x, x2: plot.x + plot.w, y1: plot.y + plot.h, y2: plot.y + plot.h, class: "cd-chart-axis" }));
    if (spec.yLabel && !horizontal) g.append(svgEl("text", { x: 14, y: plot.y + plot.h / 2, transform: `rotate(-90 14 ${plot.y + plot.h / 2})`, "text-anchor": "middle", class: "cd-chart-label" }, spec.yLabel));
    if (spec.xLabel) g.append(svgEl("text", { x: plot.x + plot.w / 2, y: H - 6, "text-anchor": "middle", class: "cd-chart-label" }, spec.xLabel));
  }

  /** The numbers as a table and as CSV (what Copy data gives). */
  function rows(spec) {
    if (spec.type === "scatter") return [["series", "x", "y"], ...spec.series.flatMap((s) => s.points.map(([x, y]) => [s.name, x, y]))];
    return [[spec.xLabel || "", ...spec.series.map((s) => s.name)], ...spec.x.map((label, j) => [label, ...spec.series.map((s) => s.values[j] ?? "")])];
  }
  const csv = (table) => table.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(",")).join("\n");

  /** The chart as a PNG: the SVG with its colours made concrete, its title above, on the theme's background, at 2x. */
  function png(svg, callback, title = "", legend = []) {
    const copy = svg.cloneNode(true);
    const top = title ? 34 : 0, bottom = legend.length ? 30 : 0, height = H + top + bottom;
    copy.setAttribute("viewBox", `0 0 ${W} ${height}`);
    copy.setAttribute("width", String(W * 2)); copy.setAttribute("height", String(height * 2));
    const live = [svg, ...svg.querySelectorAll("*")], cloned = [copy, ...copy.querySelectorAll("*")];
    live.forEach((node, i) => {
      const cs = getComputedStyle(node);
      for (const prop of ["fill", "stroke", "stroke-width", "opacity", "font-size", "font-family", "font-weight"]) cloned[i].style.setProperty(prop, cs.getPropertyValue(prop));
    });
    copy.querySelectorAll("title").forEach((t) => t.remove());
    const shifted = svgEl("g", { transform: `translate(0 ${top})` });
    while (copy.firstChild) shifted.append(copy.firstChild);
    const ink = getComputedStyle(document.body).color || "#000000";
    copy.append(svgEl("rect", { x: 0, y: 0, width: W, height, fill: getComputedStyle(document.body).backgroundColor || "#ffffff" }), shifted);
    if (title) copy.append(svgEl("text", { x: 16, y: 24, fill: ink, "font-size": 15, "font-weight": 600, "font-family": "sans-serif" }, title));
    let x = 16;                                   // the legend, as the card shows it: what each colour is
    for (const { name, color } of legend) {
      copy.append(svgEl("rect", { x, y: H + top + 10, width: 10, height: 10, rx: 2, fill: color }));
      const label = svgEl("text", { x: x + 16, y: H + top + 19, fill: ink, "font-size": 12, "font-family": "sans-serif" }, name);
      copy.append(label);
      x += 28 + Math.min(220, name.length * 7);
      if (x > W - 60) break;
    }
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = W * 2; canvas.height = height * 2;
      canvas.getContext("2d").drawImage(image, 0, 0);
      try { callback(canvas.toDataURL("image/png")); } catch { callback(null); }
    };
    image.onerror = () => callback(null);
    image.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(copy))));
  }

  /** A chart card for a spec, or null. ``actions``: {copy(text), save(name, dataUrl)}. */
  function render(raw, actions = {}) {
    const spec = normalize(raw);
    if (!spec) return null;
    const hidden = new Set();
    const box = el("figure", "cd-chart");
    box.dataset.type = spec.type;
    const head = el("figcaption", "cd-chart-head");
    head.append(el("span", "cd-chart-title", spec.title || ""));
    const tools = el("span", "cd-chart-tools");
    const tool = (label, onClick) => { const b = el("button", "cd-chart-tool", label); b.type = "button"; b.addEventListener("click", onClick); tools.append(b); return b; };
    const area = el("div", "cd-chart-area-box");
    const tipBox = el("div", "cd-chart-tip"); tipBox.hidden = true;
    const tip = (evt, text) => {
      if (!evt) { tipBox.hidden = true; return; }
      tipBox.textContent = text; tipBox.hidden = false;
      const r = area.getBoundingClientRect();
      tipBox.style.left = `${Math.min(r.width - 160, Math.max(0, evt.clientX - r.left + 12))}px`;
      tipBox.style.top = `${Math.max(0, evt.clientY - r.top - 34)}px`;
    };
    const legend = el("div", "cd-chart-legend");
    const table = el("table", "cd-chart-table"); table.hidden = true;
    const paint = () => {
      area.replaceChildren(draw(spec, hidden, tip), tipBox);
      legend.replaceChildren();
      const entries = spec.type === "pie" ? spec.x.map((name, i) => ({ name, i, toggle: false })) : spec.series.map((s) => ({ name: s.name, i: s.i ?? spec.series.indexOf(s), toggle: spec.series.length > 1 }));
      if (entries.length > 1 || spec.type === "pie") {
        for (const entry of entries) {
          const item = el("button", "cd-chart-key");
          item.type = "button";
          item.disabled = !entry.toggle;
          item.setAttribute("aria-pressed", String(!hidden.has(entry.i)));
          const swatch = el("span", `cd-chart-swatch cd-chart-c${entry.i % MAX_SERIES}`);
          item.append(swatch, el("span", "", entry.name));
          if (entry.toggle) item.addEventListener("click", () => { if (hidden.has(entry.i)) hidden.delete(entry.i); else if (hidden.size < spec.series.length - 1) hidden.add(entry.i); paint(); });
          legend.append(item);
        }
      }
    };
    spec.series.forEach((s, i) => { s.i = i; });
    const data = rows(spec);
    const thead = el("thead"), tbody = el("tbody");
    const tr = el("tr"); for (const c of data[0]) tr.append(el("th", "", c)); thead.append(tr);
    for (const r of data.slice(1)) { const row = el("tr"); r.forEach((c, k) => row.append(el("td", k ? "num" : "", typeof c === "number" ? format(c, spec.unit) : c))); tbody.append(row); }
    table.append(thead, tbody);
    const toggle = tool("Data", () => { table.hidden = !table.hidden; toggle.setAttribute("aria-pressed", String(!table.hidden)); });
    toggle.setAttribute("aria-pressed", "false");
    tool("Copy data", () => actions.copy?.(csv(data)));
    tool("Save image", () => {
      const keys = [...legend.querySelectorAll(".cd-chart-key")].filter((k) => k.getAttribute("aria-pressed") !== "false")
        .map((k) => ({ name: k.textContent, color: getComputedStyle(k.querySelector(".cd-chart-swatch")).backgroundColor }));
      png(area.querySelector("svg"), (url) => actions.save?.(`${(spec.title || "chart").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60) || "chart"}.png`, url),
          spec.title, keys);
    });
    head.append(tools);
    box.append(head, area, legend, table);
    paint();
    return box;
  }

  window.DgcChart = { render, normalize, ticks, format };
})();
