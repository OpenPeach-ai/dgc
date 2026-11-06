/* A response trace is a replay of observed turn events, never a generated video or an inferred transcript. */
(() => {
  "use strict";
  const at = (trace, event) => Number.isFinite(event?.trace_at_ms) && event.trace_at_ms > 0
    ? event.trace_at_ms : trace.live ? Date.now() : null;
  const fmt = (ms) => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
  const clock = (ms) => `${(ms / 1000).toFixed(2)}s`;
  const clean = (value, length = 90) => String(value || "").replace(/\s+/g, " ").trim().slice(0, length);
  function create(start, id, model, live = false) {
    if (!Number.isFinite(start) || start <= 0) return null;
    return { start, id: clean(id, 40), model: clean(model, 80), cursor: start, live,
      modelStart: start, pendingTokens: null, rows: [], calls: new Map(), end: null, incomplete: false };
  }
  function modelEnd(trace, event) {
    if (!trace || trace.modelStart == null) return;
    const when = at(trace, event);
    if (when == null) { trace.incomplete = true; return; }
    const end = Math.max(trace.modelStart, when);
    if (end > trace.modelStart) trace.rows.push({ kind: "model", label: "model.response",
      start: trace.modelStart, end, tokens: Number.isInteger(event?.trace_tokens) ? event.trace_tokens : trace.pendingTokens });
    trace.pendingTokens = null;
    trace.modelStart = null;
    trace.cursor = end;
  }
  function modelUsage(trace, tokens) {
    if (!trace || !Number.isSafeInteger(tokens) || tokens <= 0) return;
    if (trace.modelStart != null) trace.pendingTokens = tokens;
    else {
      const row = [...trace.rows].reverse().find((item) => item.kind === "model");
      if (row) row.tokens = tokens;
    }
  }
  function toolStart(trace, event) {
    if (!trace) return;
    if (event.call_id && trace.calls.has(clean(event.call_id, 100))) return;
    modelEnd(trace, event);
    const start = at(trace, event);
    if (start == null || trace.rows.length >= 512) { trace.incomplete = true; return; }
    const id = clean(event.call_id || `${event.name}:${trace.rows.length}`, 100);
    const summary = clean(event.summary, 110);
    const search = event.name === "grep" || /(?:^|\s)(?:rg|grep)(?:\s|$)/i.test(summary);
    const row = { kind: "tool", label: search ? "grep" : clean(event.name, 72) || "tool", detail: summary,
      search,
      start, end: null, error: false, id };
    trace.rows.push(row); trace.calls.set(id, row);
  }
  function toolEnd(trace, event) {
    if (!trace) return;
    const end = at(trace, event), id = clean(event.call_id || "", 100);
    if (end == null) { trace.incomplete = true; return; }
    const row = trace.calls.get(id);
    if (!row || row.end != null) return;
    row.end = Math.max(row.start, end);
    row.error = event.is_error === true;
    if (event.denied === true) row.detail = "Denied";
    else if (row.error) row.detail = "Failed";
    else if (event.is_diff) row.detail = "Changed files";
    else if (row.search) {
      const found = String(event.output || "").trim();
      const lines = /^no matches/i.test(found) ? 0 : found.split("\n").filter(Boolean).length;
      row.detail = `${lines} ${lines === 1 ? "hit" : "hits"}`;
    } else if (!row.detail) {
      const lines = String(event.output || "").trim().split("\n").filter(Boolean).length;
      row.detail = lines ? `${lines} lines` : "Done";
    }
    trace.cursor = Math.max(trace.cursor, row.end);
    // The next model request can begin after the last outstanding tool. Parallel tools retain their own lanes.
    if ([...trace.calls.values()].every((item) => item.end != null)) trace.modelStart = trace.cursor;
  }
  function finish(trace, end) {
    if (!trace || trace.incomplete || !Number.isFinite(end) || end <= 0) return null;
    // A missing tool result can be a repaired transcript after interruption. Its end time
    // is unknown, so the turn end must never be used as a made-up tool duration.
    if (trace.rows.some((row) => row.kind === "tool" && row.end == null)) return null;
    // A model round also needs its own observed stream end (or a following tool call).
    if (trace.modelStart != null) return null;
    trace.end = Math.max(trace.start, end);
    return !trace.incomplete && trace.rows.length && trace.end > trace.start ? trace : null;
  }
  // A reply's steps as ChatDGC and a Pip save them (dgc/reply_trace.py): times from its first step, each measured. Anything
  // that isn't whole gives no Trace, never a guess.
  function fromSaved(saved, id, model) {
    if (saved?.v !== 1 || !Number.isSafeInteger(saved.ms) || saved.ms <= 0
      || !Array.isArray(saved.steps) || !saved.steps.length || saved.steps.length > 512) return null;
    const rows = [];
    for (const step of saved.steps) {
      const { start, end, kind } = step || {};
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > saved.ms) return null;
      if (kind !== "model" && kind !== "tool") return null;
      const hits = Number.isSafeInteger(step.hits) && step.hits >= 0 ? step.hits : null;
      const detail = step.denied === true ? "Denied" : step.error === true ? "Failed"
        : hits !== null ? `${hits} ${hits === 1 ? "hit" : "hits"}` : clean(step.detail, 110);
      rows.push({ kind, label: clean(step.label, 72) || kind, detail, start, end, error: step.error === true,
        tokens: Number.isSafeInteger(step.tokens) && step.tokens > 0 ? step.tokens : null });
    }
    return { start: 0, end: saved.ms, id: clean(id, 40), model: clean(model, 80), rows };
  }
  function open(trace) {
    if (!trace?.rows?.length) return;
    document.querySelector(".dgc-trace-backdrop")?.remove();
    const backdrop = document.createElement("div"); backdrop.className = "dgc-trace-backdrop";
    const dialog = document.createElement("section"); dialog.className = "dgc-trace-dialog";
    dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Response trace");
    const header = document.createElement("header"); header.className = "dgc-trace-head";
    const title = document.createElement("strong"); title.textContent = trace.id || "Response trace";
    const model = document.createElement("span"); model.className = "dgc-trace-model";
    model.textContent = [trace.model, `${trace.rows.length} ${trace.rows.length === 1 ? "span" : "spans"}`].filter(Boolean).join(" · ");
    const state = document.createElement("span"); state.className = "dgc-trace-state"; state.textContent = "Complete";
    const close = document.createElement("button"); close.type = "button"; close.className = "dgc-trace-close";
    close.setAttribute("aria-label", "Close trace"); close.textContent = "×";
    header.append(title, model, state, close);
    const duration = Math.max(1, trace.end - trace.start);
    const ruler = document.createElement("div"); ruler.className = "dgc-trace-ruler";
    const ticks = document.createElement("div"); ticks.className = "dgc-trace-ticks";
    for (let i = 1; i <= 5; i++) { const tick = document.createElement("span"); tick.style.left = `${i * 16.66}%`;
      tick.textContent = clock(duration * i / 6); ticks.appendChild(tick); }
    ruler.appendChild(ticks);
    const body = document.createElement("div"); body.className = "dgc-trace-body";
    const grid = document.createElement("div"); grid.className = "dgc-trace-grid";
    for (let i = 1; i <= 5; i++) { const line = document.createElement("i"); line.style.left = `${i * 16.66}%`; grid.appendChild(line); }
    body.appendChild(grid);
    for (const row of trace.rows) {
      const item = document.createElement("div"); item.className = `dgc-trace-row ${row.kind}${row.error ? " error" : ""}`;
      const label = document.createElement("span"); label.className = "dgc-trace-label";
      const glyph = document.createElement("span"); glyph.className = "dgc-trace-glyph codicon " + (row.kind === "model" ? "codicon-chip" : "codicon-tools");
      glyph.setAttribute("aria-hidden", "true"); const name = document.createElement("span"); name.textContent = row.label;
      label.append(glyph, name);
      const lane = document.createElement("span"); lane.className = "dgc-trace-lane";
      const bar = document.createElement("span"); bar.className = "dgc-trace-bar";
      bar.style.left = `${Math.max(0, (row.start - trace.start) / duration * 100)}%`;
      bar.style.width = `${Math.max(.35, (row.end - row.start) / duration * 100)}%`; lane.appendChild(bar);
      const meta = document.createElement("span"); meta.className = "dgc-trace-meta";
      const detail = document.createElement("span"); detail.textContent = row.tokens && !row.error ? `${row.tokens.toLocaleString()} tk` : row.detail || "";
      const time = document.createElement("span"); time.textContent = fmt(row.end - row.start);
      meta.append(detail, time); item.append(label, lane, meta); body.appendChild(item);
    }
    const cursor = document.createElement("div"); cursor.className = "dgc-trace-cursor"; body.appendChild(cursor);
    const transport = document.createElement("div"); transport.className = "dgc-trace-transport";
    const play = document.createElement("button"); play.type = "button"; play.className = "dgc-trace-play";
    play.setAttribute("aria-label", "Play trace"); play.textContent = "▶";
    const scrub = document.createElement("input"); scrub.type = "range"; scrub.className = "dgc-trace-scrub";
    scrub.min = "0"; scrub.max = String(duration); scrub.value = String(duration); scrub.step = "1";
    scrub.setAttribute("aria-label", "Trace playback position");
    const elapsed = document.createElement("span"); elapsed.className = "dgc-trace-clock";
    transport.append(play, scrub, elapsed); dialog.append(header, ruler, body, transport); backdrop.appendChild(dialog);
    let frame = 0, last = 0, position = duration;
    const paint = () => { const fraction = position / duration;
      cursor.style.left = `calc(var(--trace-name-width) + (100% - var(--trace-name-width) - var(--trace-meta-width)) * ${fraction})`;
      scrub.value = String(Math.round(position)); elapsed.textContent = `${clock(position)} / ${clock(duration)}`;
      body.querySelectorAll(".dgc-trace-row").forEach((item, index) =>
        item.classList.toggle("future", trace.rows[index].start - trace.start > position));
    };
    const stop = () => { cancelAnimationFrame(frame); frame = 0; play.textContent = "▶"; play.setAttribute("aria-label", "Play trace"); };
    // A long work turn remains scrubbed in real elapsed time; playback finishes in about 12 seconds.
    const speed = Math.max(1, duration / 12000);
    const tick = (now) => { if (!last) last = now; position = Math.min(duration, position + (now - last) * speed); last = now; paint();
      if (position >= duration) stop(); else frame = requestAnimationFrame(tick); };
    play.onclick = () => { if (frame) { stop(); return; } if (position >= duration) position = 0;
      last = 0; play.textContent = "Ⅱ"; play.setAttribute("aria-label", "Pause trace"); frame = requestAnimationFrame(tick); };
    scrub.oninput = () => { position = Number(scrub.value); paint(); };
    // A Pip's chat is inside a shadow root: what had the keyboard is the element in there, not its host.
    let previous = document.activeElement;
    while (previous?.shadowRoot?.activeElement) previous = previous.shadowRoot.activeElement;
    const dismiss = () => { stop(); backdrop.remove(); document.removeEventListener("keydown", keydown, true); previous?.focus?.(); };
    // First, so Esc closes this and nothing behind it hears it (a Pip's chat, a running reply's Stop).
    const keydown = (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); return; }
      if (event.key === "Tab") { const controls = [close, play, scrub];
        const index = controls.indexOf(document.activeElement); if (event.shiftKey && index === 0) { event.preventDefault(); scrub.focus(); }
        else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); close.focus(); } } };
    close.onclick = dismiss; backdrop.onclick = (event) => { if (event.target === backdrop) dismiss(); };
    document.body.appendChild(backdrop); document.addEventListener("keydown", keydown, true); paint(); close.focus();
  }
  window.DgcTrace = { create, modelEnd, modelUsage, toolStart, toolEnd, finish, fromSaved, open };
})();
