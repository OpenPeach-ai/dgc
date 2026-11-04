/** Experimental, bounded presentation format for model replies. It never runs model HTML or JavaScript. */
type Row = Record<string, unknown>;

const esc = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** A text field: a string, or a finite number or true/false read as its text, the same rule as the SDK readers.
 *  Models write {"value": 42} and [["a.py", 120]] as often as strings. */
const text = (value: unknown): string | null => typeof value === "string" ? value
  : typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ? String(value) : null;
const word = (value: unknown, max = 160): string => (text(value) ?? "").trim().slice(0, max);
const record = (value: unknown): Row | null => value && typeof value === "object" && !Array.isArray(value)
  ? value as Row : null;
const items = (value: unknown, limit: number): Row[] | null => Array.isArray(value) && value.length > 0
  && value.length <= limit && value.every((item) => record(item)) ? value as Row[] : null;

function metrics(block: Row): string | null {
  const entries = items(block.items, 8);
  if (!entries) return null;
  const rows = entries.map((item) => {
    const label = word(item.label, 60), value = word(item.value, 40);
    if (!label || !value) return "";
    return `<div class="genui-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong>`
      + `<small>${esc(word(item.detail, 100))}</small></div>`;
  });
  return rows.some((row) => !row) ? null : `<div class="genui-metrics">${rows.join("")}</div>`;
}

function choices(block: Row): string | null {
  const entries = items(block.items, 4);
  if (!entries) return null;
  const rows = entries.map((item) => {
    const label = word(item.label, 70), reply = word(item.reply, 500);
    // A choice is a message, never a slash command or an editor control.
    if (!label || !reply || reply.startsWith("/") || /\s\/(?:goal|plan|review|init)$/i.test(reply)) return "";
    // The exact words a click sends are on the button: never a label over hidden text.
    return `<button type="button" class="genui-choice genui-send" data-genui-send="${esc(reply)}"`
      + ` aria-label="${esc(label)}. Sends: ${esc(reply)}"><strong>${esc(label)}</strong>`
      + `<span>${esc(word(item.description, 180))}</span><span class="genui-choice-sends">Sends “${esc(reply)}”</span>`
      + `<span class="genui-choice-arrow" aria-hidden="true">↗</span></button>`;
  });
  if (rows.some((row) => !row)) return null;
  return `<section class="genui-block"><h4>${esc(word(block.label, 100) || "Choose a direction")}</h4>`
    + `<div class="genui-choices">${rows.join("")}</div><small>One click sends the request shown, as your message. Actions still follow your permissions.</small></section>`;
}

function steps(block: Row): string | null {
  const entries = items(block.items, 8);
  if (!entries) return null;
  const rows = entries.map((item) => {
    const label = word(item.label, 110);
    if (!label) return "";
    const state = ["done", "running", "attention", "waiting"].includes(String(item.state))
      ? String(item.state) : "waiting";
    return `<li data-state="${state}"><span class="genui-step-dot" aria-hidden="true"></span>`
      + `<span><strong>${esc(label)}</strong><small>${esc(word(item.detail, 180))}</small></span></li>`;
  });
  if (rows.some((row) => !row)) return null;
  return `<section class="genui-block"><h4>${esc(word(block.label, 100) || "Progress")}</h4>`
    + `<ol class="genui-steps">${rows.join("")}</ol></section>`;
}

function bars(block: Row): string | null {
  const entries = items(block.items, 12);
  if (!entries) return null;
  const values = entries.map((item) => Number(item.value));
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1_000_000)) return null;
  const max = Math.max(1, ...values);
  const rows = entries.map((item, index) => {
    const label = word(item.label, 45);
    if (!label) return "";
    const height = values[index] === 0 ? 0 : Math.max(2, Math.round(values[index] / max * 100));
    return `<div class="genui-bar-item" title="${esc(label)}: ${values[index]}">`
      + `<span class="genui-bar-track"><span class="genui-bar" style="height:${height}%"></span></span>`
      + `<span class="genui-bar-label">${esc(label)}</span></div>`;
  });
  if (rows.some((row) => !row)) return null;
  return `<section class="genui-block"><h4>${esc(word(block.label, 100) || "Comparison")}</h4>`
    + `<div class="genui-bars" role="img" aria-label="${esc(entries.map((item, index) => `${word(item.label, 45)}: ${values[index]}`).join(", "))}">`
    + `${rows.join("")}</div></section>`;
}

function table(block: Row): string | null {
  if (!Array.isArray(block.columns) || !Array.isArray(block.rows) || block.columns.length < 1
      || block.columns.length > 5 || block.rows.length < 1 || block.rows.length > 8) return null;
  const columns = block.columns.map((column) => word(column, 70));
  if (columns.some((column) => !column)) return null;
  const rows = block.rows.map((row) => Array.isArray(row) && row.length === columns.length
    && row.every((cell) => text(cell) !== null) ? row.map((cell) => word(cell, 150)) : null);
  if (rows.some((row) => !row)) return null;
  return `<section class="genui-block"><h4>${esc(word(block.label, 100) || "Details")}</h4>`
    + `<div class="genui-table-scroll"><table><thead><tr>${columns.map((column) => `<th>${esc(column)}</th>`).join("")}</tr></thead>`
    + `<tbody>${rows.map((row) => `<tr>${row!.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>`;
}

/** Return null for malformed payloads; the markdown renderer then shows the original code fence. */
export function renderGenerativeUi(source: string): string | null {
  if (source.length > 16_384) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { return null; }
  const data = record(parsed), blocks = data && items(data.blocks, 6);
  if (!data || !blocks || word(data.version, 4) !== "1") return null;
  const title = word(data.title, 120);
  if (!title) return null;
  const rendered = blocks.map((block) => {
    switch (block.type) {
      case "metrics": return metrics(block);
      case "choices": return choices(block);
      case "steps": return steps(block);
      case "bars": return bars(block);
      case "table": return table(block);
      default: return null;
    }
  });
  if (rendered.some((block) => block === null)) return null;
  return `<div class="genui-card" role="group" aria-label="${esc(title)}"><div class="genui-head">`
    + `<span class="genui-mark" aria-hidden="true"><svg viewBox="0 0 90 90" fill="currentColor" focusable="false">`
    + `<path d="M32 24 L20 30 L13 72 L25 66 Z"/><path d="M54 18 L42 24 L35 72 L47 66 Z"/>`
    + `<path d="M76 24 L64 30 L57 66 L69 60 Z"/></svg></span>`
    + `<span><strong>${esc(title)}</strong><small>${esc(word(data.subtitle, 180))}</small></span>`
    + `<span class="genui-tag">Interactive</span></div>${rendered.join("")}</div>`;
}
