// The usage meter (0.52, 17 Nov): ONE meter for Work, ChatDGC and a Pip's chat. A small icon on the prompt box, beside
// the context meter, shown only when the connection reports how much of its usage limits is used; a click opens a
// pop-up, as the context meter's does: a row per window (% used, a thin bar, "N% left · resets <time>") and one link,
// Manage usage (a plan's own usage page) or Top up (OpenRouter's credits).
//
//   const view = DgcUsageMeter.view(raw);        // raw: { source, windows: [{id, used_percent, window_minutes,
//                                                //   resets_at}], limited } from the host; null when nothing to show
//   container.innerHTML = DgcUsageMeter.buttonHtml(view, { cls: "fbtn" });   // "" when there is no view
//   DgcUsageMeter.toggle(button, view, { link(link) {}, anchor() { return the button now } });
//   DgcUsageMeter.update(view);  DgcUsageMeter.close();
//
// Where the numbers come from is the host's business (dgc/usage_limits.py; OpenRouter's key, read by the extension):
// this module only draws them. A link is said by its name (`page`: "usage" or "credits"), never an address: the host
// knows each connection's page. A classic script, like media/shared/modelpicker.js: Work's and ChatDGC's pages load it
// before their own script and the Pips bundle imports it. The icon is an inline drawing: a Pip's view in the side bar
// is a shadow root the icon font's classes can't reach.
(function (root, make) {
  const api = make(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root && !root.DgcUsageMeter) root.DgcUsageMeter = api;
})(typeof window !== "undefined" ? window : null, function (root) {
  "use strict";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Each source: its name in the pop-up, and its one link (a plan's usage page, or OpenRouter's credits).
  const SOURCES = {
    chatgpt_plan: { name: "ChatGPT plan", link: { page: "usage", label: "Manage usage" } },
    codex: { name: "Codex", link: { page: "usage", label: "Manage usage" } },
    claude: { name: "Claude Code", link: { page: "usage", label: "Manage usage" } },
    openrouter: { name: "OpenRouter", link: { page: "credits", label: "Top up" } },
  };
  const NEED = 80, ERR = 95;              // amber at 80% or more; red above 95%
  const MODEL_SUFFIX = { seven_day_opus: " · Opus", seven_day_sonnet: " · Sonnet" };
  const CREDIT_WINDOWS = { daily: "Daily credit limit", weekly: "Weekly credit limit", monthly: "Monthly credit limit", key: "Key credit limit" };

  /** A window's name, by its length: "5-hour limit", "Weekly limit"; an OpenRouter key's by its reset. */
  function label(w) {
    const id = w && typeof w.id === "string" ? w.id : "";
    if (CREDIT_WINDOWS[id] && !w.window_minutes) return CREDIT_WINDOWS[id];
    const m = Number(w && w.window_minutes) || 0;
    let words = "Usage limit";
    if (m === 10080) words = "Weekly limit";
    else if (m === 1440) words = "Daily limit";
    else if (m > 0 && m % 1440 === 0) words = `${m / 1440}-day limit`;
    else if (m > 0 && m % 60 === 0) words = `${m / 60}-hour limit`;
    else if (m > 0) words = `${m}-minute limit`;
    return words + (MODEL_SUFFIX[id] || "");
  }
  const tone = (pct) => (pct > ERR ? "err" : pct >= NEED ? "need" : "");
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  /** "resets 14:05" today, "resets Thu 09:00" within a week, else "resets 21 Nov"; "" when unknown or past. */
  function resetsWords(at, now = Date.now() / 1000) {
    const t = Number(at) || 0;
    if (!t || t <= now) return "";
    const then = new Date(t * 1000), today = new Date(now * 1000);
    const hm = `${then.getHours()}:${String(then.getMinutes()).padStart(2, "0")}`;
    if (then.toDateString() === today.toDateString()) return `resets ${hm}`;
    if (t - now < 6.5 * 86400) return `resets ${DAYS[then.getDay()]} ${hm}`;
    return `resets ${then.getDate()} ${MONTHS[then.getMonth()]}`;
  }

  /** The host's report made ready to draw, or null when the connection reports nothing to show. */
  function view(raw) {
    if (!raw || typeof raw !== "object" || !SOURCES[raw.source]) return null;
    const windows = (Array.isArray(raw.windows) ? raw.windows : []).filter((w) => w && typeof w === "object" && Number.isFinite(Number(w.used_percent)))
      .slice(0, 6).map((w) => ({ id: String(w.id || ""), used_percent: Math.min(100, Math.max(0, Number(w.used_percent))),
        window_minutes: Number(w.window_minutes) > 0 ? Number(w.window_minutes) : null, resets_at: Number(w.resets_at) > 0 ? Number(w.resets_at) : null }));
    const limited = raw.limited === true;
    if (!windows.length && !limited) return null;
    const source = SOURCES[raw.source];
    return { source: raw.source, name: source.name, windows, limited, link: { ...source.link } };
  }
  /** Its rows: [{label, pct, tone, left}]. */
  function rows(v, now = Date.now() / 1000) {
    if (!v) return [];
    return v.windows.map((w) => {
      const pct = Math.round(w.used_percent), when = resetsWords(w.resets_at, now);
      return { id: w.id, label: label(w), pct, tone: tone(w.used_percent), left: `${100 - pct}% left${when ? ` · ${when}` : ""}` };
    });
  }
  /** The fullest window (what the button says), or the reached limit when no window is known. */
  function top(v, now) {
    const list = rows(v, now);
    if (!list.length) return v && v.limited ? { label: "Usage limit", pct: 100, tone: "err", left: "Limit reached for now" } : null;
    return list.reduce((a, b) => (b.pct > a.pct ? b : a));
  }
  function summary(v, now) {
    const t = top(v, now);
    if (!t) return "";
    if (v.limited && !v.windows.length) return `${v.name} usage: limit reached for now`;
    return `${v.name} usage: ${t.pct}% of the ${t.label.replace(/ limit\b/, "").toLowerCase()} limit used`;
  }

  // A small gauge: an arc and its needle, in the text's colour.
  const GAUGE = '<svg class="dgc-um-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M2.6 11.6a5.8 5.8 0 1 1 10.8 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M8 9.6l2.6-3.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="9.8" r="1.2" fill="currentColor"/></svg>';

  /** The button for the prompt box. `cls`: the surface's own chip class, so it sits like its neighbours. */
  function buttonHtml(v, { cls = "", id = "", now } = {}) {
    if (!v) return "";
    const t = top(v, now), said = summary(v, now);
    return `<button type="button"${id ? ` id="${esc(id)}"` : ""} class="dgc-um-btn${cls ? ` ${esc(cls)}` : ""}" data-usage-meter="" data-tone="${esc(t ? t.tone : "")}"`
      + ` aria-haspopup="dialog" aria-expanded="false" title="${esc(said)}" aria-label="${esc(`${said}. Show usage`)}">${GAUGE}</button>`;
  }
  /** The pop-up's markup: its head, a row per window and its one link. */
  function popHtml(v, now) {
    if (!v) return "";
    const list = rows(v, now);
    const body = list.length ? `<ul class="dgc-um-rows">${list.map((r) => `<li class="dgc-um-row" data-tone="${r.tone}">`
      + `<div class="dgc-um-line"><span class="dgc-um-label">${esc(r.label)}</span><span class="dgc-um-pct">${r.pct}% used</span></div>`
      + `<div class="dgc-um-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${r.pct}" aria-label="${esc(r.label)}"><span class="dgc-um-fill" style="width:${r.pct}%"></span></div>`
      + `<div class="dgc-um-left">${esc(r.left)}</div></li>`).join("")}</ul>` : "";
    const reached = v.limited ? `<p class="dgc-um-reached" data-tone="err">${list.length ? "The limit is reached for now." : "Your usage limit is reached for now. It resets on its own."}</p>` : "";
    return `<div class="dgc-um-head"><span class="dgc-um-kicker">Usage</span><strong class="dgc-um-name">${esc(v.name)}</strong></div>${reached}${body}`
      + `<div class="dgc-um-foot"><button type="button" class="dgc-um-link" data-um-link="${esc(v.link.page)}">${esc(v.link.label)}</button></div>`;
  }

  // ---- the pop-up: one at a time, beside its button, wherever that button's page (or shadow root) is ----
  let open = null;                  // { pop, button, view, on, doc }
  function place() {
    if (!open) return;
    const button = (open.on.anchor && open.on.anchor()) || open.button;
    if (!button || !button.isConnected) { close("gone"); return; }
    open.button = button;
    const win = open.doc.defaultView || root, r = button.getBoundingClientRect(), pop = open.pop;
    const vw = win.innerWidth || 0, vh = win.innerHeight || 0, gutter = 8, width = Math.max(200, Math.min(300, vw - 2 * gutter));
    pop.style.width = `${width}px`;
    pop.style.left = `${Math.max(gutter, Math.min(r.left, vw - width - gutter))}px`;
    const above = r.top > Math.min(260, vh / 2);
    if (above) { pop.style.top = ""; pop.style.bottom = `${Math.max(gutter, vh - r.top + 6)}px`; }
    else { pop.style.bottom = ""; pop.style.top = `${r.bottom + 6}px`; }
  }
  function draw() {
    if (!open) return;
    open.pop.innerHTML = popHtml(open.view);
    open.pop.querySelector("[data-um-link]")?.addEventListener("click", (event) => {
      event.preventDefault(); event.stopPropagation();
      if (open && typeof open.on.link === "function") open.on.link({ ...open.view.link });
    });
    place();
  }
  function onKey(event) {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault(); event.stopPropagation();
    close("escape");
  }
  function onOutside(event) {
    if (!open) return;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    if (path.includes(open.pop) || path.includes(open.button)) return;
    close("outside");
  }
  function close(reason = "") {
    if (!open) return;
    const was = open;
    open = null;
    was.pop.remove();
    was.doc.removeEventListener("pointerdown", onOutside, true);
    was.doc.removeEventListener("keydown", onKey, true);
    const button = (was.on.anchor && was.on.anchor()) || was.button;
    if (button && button.isConnected) {
      button.setAttribute("aria-expanded", "false");
      if (reason === "escape") button.focus();
    }
    if (typeof was.on.close === "function") was.on.close(reason);
  }
  function toggle(button, v, on = {}) {
    if (open && open.button === button) { close("toggle"); return; }
    close("replaced");
    if (!button || !v) return;
    const doc = button.ownerDocument, host = button.getRootNode && button.getRootNode() !== doc ? button.getRootNode() : doc.body;
    const pop = doc.createElement("div");
    pop.className = "dgc-um-pop dgc-popover";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Usage limits");
    pop.tabIndex = -1;
    pop.addEventListener("keydown", onKey);
    for (const type of ["click", "pointerdown"]) pop.addEventListener(type, (event) => event.stopPropagation());
    host.appendChild(pop);
    open = { pop, button, view: v, on, doc };
    button.setAttribute("aria-expanded", "true");
    draw();
    doc.addEventListener("pointerdown", onOutside, true);
    doc.addEventListener("keydown", onKey, true);
  }
  /** New numbers from the host: an open pop-up is drawn again; a view that went away closes it. */
  function update(v) {
    if (!open) return;
    if (!v) { close("gone"); return; }
    open.view = v;
    draw();
  }
  const isOpen = () => !!open;

  return { view, rows, top, summary, label, tone, resetsWords, buttonHtml, popHtml, toggle, update, close, isOpen, place, SOURCES, NEED, ERR };
});
