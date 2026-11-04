// A context size, typed or picked: the one box Settings asks for a context size with (DGC Router's "Context each" and
// Sub-agents' "Context window"). A text box with the usual sizes listed under it, not a closed select: type "24K",
// "24k", "24576" or "24,576", or pick 4K … 256K. What you typed is said back as it will be saved ("24K = 24,576
// tokens"); below 2K, or above what the model handles, a one-line note says so (saving above the model's maximum is
// still allowed: DGC uses the model's maximum). Arrow keys open and move through the list, Enter picks, Esc closes.
export const CONTEXT_SIZES = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
export const CONTEXT_MIN = 2048, CONTEXT_MAX = 16777216;

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** "16K" for a whole number of kilotokens (1,024), else the number with its commas. */
export function contextShort(tokens) {
  const n = Number(tokens) || 0;
  return n > 0 && n % 1024 === 0 ? `${n / 1024}K` : n > 0 ? n.toLocaleString("en-US") : "";
}
/** What a box holds, in tokens: a number, "" (blank: the default, where the box has one), or null (not a size). */
export function parseContext(text) {
  const raw = String(text ?? "").trim().toLowerCase().replace(/[,_\s]/g, "");
  if (!raw) return "";
  const scale = raw.endsWith("k") ? 1024 : 1;
  const digits = scale > 1 ? raw.slice(0, -1) : raw;
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  if (scale === 1 && !/^\d+$/.test(digits)) return null;
  const tokens = Math.round(Number(digits) * scale);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
}
/** The line under the box: what will be saved. */
export function contextSaid(tokens, blankWords = "") {
  if (tokens === "") return blankWords;
  if (tokens === null) return "";
  return tokens % 1024 === 0 ? `${tokens / 1024}K = ${tokens.toLocaleString("en-US")} tokens` : `${tokens.toLocaleString("en-US")} tokens`;
}
/** The one-line note, or "": not a size, below 2K, past DGC's limit, or past what this model handles. */
export function contextNote(tokens, max = 0) {
  if (tokens === null) return "Type a size like 24K or 24576.";
  if (tokens === "") return "";
  if (tokens < CONTEXT_MIN) return "Below 2K: DGC needs at least 2K (2,048 tokens) for its own instructions.";
  if (tokens > CONTEXT_MAX) return "DGC takes up to 16,384K (16,777,216 tokens).";
  if (max > 0 && tokens > max) return `This model handles up to ${contextShort(max)}; DGC will use ${contextShort(max)}.`;
  return "";
}

let seq = 0;
/** The box. `name`: its id (and how a page reads it); `value`: tokens, or "" for the default (`blank`: its words,
 *  e.g. "Same as the main chat"; without it the box has no default). `max`: the model's own maximum when known (the
 *  list stops there). `attrs`: more attributes for the input (data-edit…), as a string. */
export function contextComboHTML({ id = "", value = "", max = 0, blank = "", label = "Context size", attrs = "", disabled = false } = {}) {
  const key = id || `ctx-combo-${++seq}`;
  const sizes = CONTEXT_SIZES.filter((n) => !(max > 0) || n <= max);
  if (max > 0 && !sizes.includes(max) && max >= CONTEXT_MIN && max < CONTEXT_SIZES[CONTEXT_SIZES.length - 1]) sizes.push(max);
  const options = [...(blank ? [["", blank]] : []), ...sizes.map((n) => [String(n), contextShort(n)])];
  // A number is shown as a size ("16K"); text is what was typed, kept as it is through a redraw.
  const shown = value === "" || value === null || value === undefined ? "" : typeof value === "number" ? contextShort(value) : String(value);
  const tokens = parseContext(shown);
  const note = contextNote(tokens, max);
  return `<span class="ctx-combo" data-ctx-combo data-max="${Number(max) || 0}"${blank ? ` data-blank="${esc(blank)}"` : ""}>`
    + `<span class="ctx-combo-box"><input type="text" class="ctx-combo-input" id="${esc(key)}" role="combobox" aria-autocomplete="list"`
    + ` aria-expanded="false" aria-controls="${esc(key)}-list" aria-label="${esc(label)}" autocomplete="off" spellcheck="false" inputmode="text"`
    + ` value="${esc(shown)}" placeholder="${esc(blank || "e.g. 24K")}" ${attrs}${disabled ? " disabled" : ""}>`
    + `<button type="button" class="ctx-combo-toggle" tabindex="-1" aria-label="Sizes" aria-controls="${esc(key)}-list"${disabled ? " disabled" : ""}>`
    + '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button></span>'
    + `<ul class="ctx-combo-list" role="listbox" id="${esc(key)}-list" aria-label="${esc(label)}" hidden>`
    + options.map(([v, words], i) => `<li role="option" id="${esc(key)}-o${i}" data-value="${esc(v)}" aria-selected="false">${esc(words)}</li>`).join("")
    + "</ul>"
    + `<span class="ctx-combo-said" aria-live="polite">${esc(contextSaid(tokens, blank))}</span>`
    + `<span class="ctx-combo-note" role="note"${note ? "" : " hidden"}>${esc(note)}</span>`
    + '<span class="ctx-combo-cost" hidden></span></span>';
}

/** Wires every box under `root` (once each). `cost(input, tokens)` -> a line of what the choice costs, or "" (DGC
 *  Router's memory arithmetic); `onChange(input, tokens)` hears every change. */
export function bindContextCombos(root, { cost = null, onChange = null } = {}) {
  for (const box of root.querySelectorAll("[data-ctx-combo]")) {
    if (box.dataset.bound === "1") continue;
    box.dataset.bound = "1";
    const input = box.querySelector(".ctx-combo-input"), list = box.querySelector(".ctx-combo-list");
    const toggle = box.querySelector(".ctx-combo-toggle");
    const said = box.querySelector(".ctx-combo-said"), noted = box.querySelector(".ctx-combo-note"), costLine = box.querySelector(".ctx-combo-cost");
    const options = () => [...list.querySelectorAll('[role="option"]')];
    const max = Number(box.dataset.max) || 0, blank = box.dataset.blank || "";
    let active = -1, selected = false;
    const open = () => { if (list.hidden) { list.hidden = false; input.setAttribute("aria-expanded", "true"); } };
    const close = () => { selected = false; list.hidden = true; input.setAttribute("aria-expanded", "false"); highlight(-1); };
    function highlight(i) {
      const all = options();
      active = i;
      all.forEach((o, k) => { o.classList.toggle("active", k === i); o.setAttribute("aria-selected", String(k === i)); });
      if (i >= 0 && all[i]) { input.setAttribute("aria-activedescendant", all[i].id); all[i].scrollIntoView?.({ block: "nearest" }); }
      else input.removeAttribute("aria-activedescendant");
    }
    /** The entry nearest what is typed: the same size, else the closest one. */
    function nearest() {
      const tokens = parseContext(input.value), all = options();
      if (tokens === "") return all.findIndex((o) => o.dataset.value === "");
      if (tokens === null) {
        const typed = input.value.trim().toLowerCase();
        return all.findIndex((o) => o.textContent.toLowerCase().startsWith(typed));
      }
      let best = -1, gap = Infinity;
      all.forEach((o, k) => {
        const n = Number(o.dataset.value);
        if (!n) return;
        const d = Math.abs(Math.log(n) - Math.log(tokens));
        if (d < gap) { gap = d; best = k; }
      });
      return best;
    }
    function refresh() {
      const tokens = parseContext(input.value);
      const note = contextNote(tokens, max);
      said.textContent = contextSaid(tokens, blank);
      noted.textContent = note; noted.hidden = !note;
      input.setAttribute("aria-invalid", String(tokens === null || (typeof tokens === "number" && (tokens < CONTEXT_MIN || tokens > CONTEXT_MAX))));
      const line = cost && typeof tokens === "number" ? cost(input, tokens) || "" : "";
      costLine.textContent = line; costLine.hidden = !line;
      costLine.classList.toggle("over", /won't fit/i.test(line));
      onChange?.(input, tokens);
    }
    function pick(i) {
      const o = options()[i];
      if (!o) return;
      input.value = o.dataset.value === "" ? "" : o.textContent;
      close();
      refresh();
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    input.addEventListener("input", () => { selected = false; open(); highlight(nearest()); refresh(); });
    input.addEventListener("keydown", (e) => {
      const all = options();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        selected = true;
        if (list.hidden) { open(); highlight(active >= 0 ? active : Math.max(0, nearest())); return; }
        const step = e.key === "ArrowDown" ? 1 : -1;
        highlight(active < 0 ? (step > 0 ? 0 : all.length - 1) : (active + step + all.length) % all.length);
      } else if (e.key === "Enter") {
        if (!list.hidden && selected && active >= 0) { e.preventDefault(); pick(active); }
        else if (!list.hidden) { e.preventDefault(); close(); refresh(); }
      } else if (e.key === "Escape") {
        if (!list.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
      } else if (e.key === "Tab") close();
    });
    input.addEventListener("change", () => refresh());
    toggle.addEventListener("mousedown", (e) => e.preventDefault());       // the box keeps the keys
    toggle.addEventListener("click", () => { if (list.hidden) { open(); highlight(Math.max(0, nearest())); } else close(); input.focus(); });
    list.addEventListener("mousedown", (e) => e.preventDefault());
    list.addEventListener("click", (e) => { const o = e.target.closest('[role="option"]'); if (o) pick(options().indexOf(o)); });
    box.addEventListener("focusout", (e) => { if (!box.contains(e.relatedTarget)) close(); });
    refresh();
  }
}
