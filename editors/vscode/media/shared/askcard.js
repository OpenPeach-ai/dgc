// The question card (propose_options): one card for Work and a Pip's chat (0.52, decided 18 Nov: "propose questions
// which user can just select and submit"). One to four questions of two to six options, the recommended one badged and
// preselected in a single choice, multi-select, the free-text "Something else", Next / Skip / Submit, the pager, and
// the keys; then, once settled, the answered panel with every option still listed and the picks marked.
//
// A classic script, like media/shared/menu.js: Work's page loads it before media/main.js, and the Pips bundle imports
// it, so both share window.DgcAskCard. Where the card lives is the page's: Work docks it in the composer frame (#cbox)
// in place of the text box; a Pip's chat draws it under the reply that asked. The page hands over what only it knows:
// how to send (onPost), how to say something to a screen reader (speak), and how to fit it (onFit). Everything else,
// the look (media/shared/askcard.css), the keys and the words, is this one module's.
//
// A card is a state object: create() builds its <section class="ask">, the page mounts state.el, then render(state).
// post() disables it and calls onPost({answers} | {dismissed: true}); rejected() puts it back in play with a line
// saying why; retire() ends it for good. answeredHtml() draws a settled card from {outcome, questions, answers}.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcAskCard) return;

  const KEY_GUARD_MS = 400, CHOSEN_MS = 150, MAX_TEXT = 4096;
  // Moving on to another question has to be seen (reported 2026-10-21: "so quick, it gets hard for me to
  // realise it has moved to the second question"). The pick holds a little longer, the next question
  // streams in a word at a time and its options pop in one after another, and for a moment after the
  // step a second click or a held key cannot answer the new question by landing where the last one was.
  const STEP_MS = 400, STEP_GUARD_MS = 300, STREAM_MS = 260, POP_GAP_MS = 45;
  let serial = 0;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // The card's own drawings, one shape on every surface (a Pip's view in the side bar is in a shadow root the icon
  // font can't reach): close and the pager's chevrons are the font's own outlines (media/shared/icons.js), the pencil
  // by the free-text field is Work's transcript pencil.
  const PENCIL = '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>';
  function glyph(name) {
    if (name === "pencil") {
      return `<svg class="ic ic-xs ask-pencil-ic" data-icon="pencil" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"`
        + ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PENCIL}</svg>`;
    }
    return root.DgcIcons?.html(name) || "";
  }

  function valid(questions) {
    const qs = Array.isArray(questions) ? questions : [];
    return qs.length >= 1 && qs.length <= 4 && qs.every((q) => q && typeof q.id === "string"
      && typeof q.question === "string" && Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 6
      && q.options.every((o) => o && typeof o.label === "string"))
      && new Set(qs.map((q) => q.id)).size === qs.length;
  }
  // A model may still write its recommendation into the text: "SQLite (Recommended)", a description
  // ending "(Recommended)", or "Recommended: …". The badge says it instead (mirrors questions._unmark).
  const MARK = /\(\s*recommended\s*\)/gi, LEAD_MARK = /^\s*recommended\s*(?:[:·–—-]\s*|\.\s+)/i;
  const TRAIL_MARK = /(?:^|[,;:·–—-]|\.(?=\s))\s*recommended\s*[.!]?\s*$/i;
  // `sentence` (a description): text left after a leading "Recommended:" starts with a capital.
  // A plain lowercase word may start a sentence; "iOS", "eBPF" or "package.json" keep their case (questions._SENTENCE_WORD).
  const SENTENCE_WORD = /^[a-z]+[,;:.!?]?(?=\s|$)/;
  function unmark(text, sentence = false) {
    const raw = String(text || "");
    let stripped = raw.replace(/\(\s*recommended\s*:\s*([^()]*)\)/gi, "($1)").replace(MARK, " ");
    let found = stripped !== raw, capital = false;
    const lead = stripped.match(LEAD_MARK);
    if (lead) { stripped = stripped.slice(lead[0].length); found = true; capital = sentence; }
    const trail = stripped.match(TRAIL_MARK);
    if (trail) { stripped = stripped.slice(0, trail.index); found = true; }
    if (!found) return [raw, false];
    stripped = stripped.replace(/\s+([,;.!?])/g, "$1").replace(/([,;])(?:\s*[,;])+/g, "$1")
      .split(/\s+/).filter(Boolean).join(" ").replace(/^[\s,;:·–—-]+|[\s,;:·–—-]+$/g, "");
    if (capital && SENTENCE_WORD.test(stripped)) stripped = stripped.charAt(0).toUpperCase() + stripped.slice(1);
    return [stripped, true];
  }
  function label(option) { return unmark(option.label)[0]; }
  function desc(option) { return unmark(option.description, true)[0]; }
  function flagged(option) {
    return option.recommended === true || unmark(option.label)[1] || unmark(option.description)[1];
  }
  // What a question has picked as shown: in a single choice, written words replace the pick.
  function picked(q, answer) {
    if (q.multi_select) return answer.selected;
    return answer.other.trim() ? [] : answer.selected.slice(0, 1);
  }
  function countLabel(n) { return `${n} question${n === 1 ? "" : "s"}`; }
  const active = (state) => state.el.getRootNode?.()?.activeElement ?? state.el.ownerDocument.activeElement;
  const speak = (state, words) => { try { state.opts.speak?.(words); } catch { /* the card goes on */ } };
  const fit = (state) => { try { state.opts.onFit?.(state); } catch { /* the card goes on */ } };

  /**
   * A new card for `questions` (already checked with valid()). opts: speak(words), onPost(payload), onFit(state),
   * hint (the free-text field's wide placeholder, "Something else? Tell DGC what you want"), label (the card's name for
   * a screen reader, when its question is not enough). The page mounts state.el, then calls render(state).
   */
  function create(questions, opts = {}) {
    const doc = opts.document || root.document;
    const n = ++serial;
    const flags = questions.map((q) => (q.multi_select ? -1 : q.options.findIndex(flagged)));
    const el = doc.createElement("section");
    el.className = "ask";
    el.tabIndex = -1;
    el.setAttribute("role", "group");
    el.setAttribute("aria-labelledby", `ask-q-${n}`);
    const state = {
      el, n, questions, opts, index: 0, armed: false, sending: false, busy: false, retired: false,
      // Single choice: the recommendation (wherever it sits) is preselected, checked and highlighted;
      // multi-select preselects nothing and highlights row 1.
      answers: questions.map((q, k) => ({ selected: flags[k] >= 0 ? [flags[k]] : [], other: "", settled: false })),
      hot: questions.map((q, k) => (flags[k] >= 0 ? flags[k] : 0)),
    };
    setTimeout(() => { state.armed = true; }, KEY_GUARD_MS);
    el.addEventListener("keydown", (event) => key(state, event));
    el.addEventListener("focusin", (event) => {
      if (event.target === el) return;         // the card holding focus for a busy composer keeps its hint
      const hint = el.querySelector(".ask-hint"); if (hint) hint.hidden = true;
    });
    return state;
  }

  function render(state, entering = false) {
    const { el, n, questions } = state;
    const i = state.index, q = questions[i], answer = state.answers[i], multi = !!q.multi_select;
    const draft = el.querySelector(".ask-field");
    if (draft) state.answers[state.drawn ?? i].other = draft.value;
    state.drawn = i;
    const hot = state.hot[i];
    const chosen = picked(q, answer);
    const rows = q.options.map((option, k) => {
      const checked = chosen.includes(k);
      const marked = flagged(option);
      const words = label(option);
      const said = desc(option);
      return `<button type="button" class="ask-opt${k === hot ? " hot" : ""}${checked ? " checked" : ""}" role="${multi ? "checkbox" : "radio"}"`
        + ` aria-checked="${checked}" tabindex="${k === hot ? 0 : -1}" data-i="${k}"`
        + ` aria-label="${esc(words + (marked ? ", recommended" : ""))}"${said ? ` aria-describedby="ask-d-${n}-${k}"` : ""}>`
        + `<span class="ask-n" aria-hidden="true">${checked && multi ? "✓" : k + 1}</span>`
        + `<span class="ask-body"><span class="ask-label">${esc(words)}</span>${marked ? '<span class="ask-badge">Recommended</span>' : ""}`
        + (said ? `<span class="ask-desc" id="ask-d-${n}-${k}">${esc(said)}</span>` : "") + `</span>`
        + `</button>`;
    }).join("");
    const pager = questions.length > 1
      ? `<div class="ask-foot"><button type="button" class="ask-page" data-step="-1" aria-label="Previous question" title="Previous question (←)"${i === 0 ? " disabled" : ""}>${glyph("chevron-left")}</button>`
        + `<span class="ask-pg">Question ${i + 1} of ${questions.length}</span>`
        + `<button type="button" class="ask-page" data-step="1" aria-label="Next question" title="Next question (→)"${i === questions.length - 1 ? " disabled" : ""}>${glyph("chevron-right")}</button></div>`
      : "";
    el.classList.toggle("ask-multi", multi);
    el.innerHTML = `<div class="ask-head"><div class="ask-q" id="ask-q-${n}">${esc(q.question)}</div>`
      + `<button type="button" class="ask-x" aria-label="Dismiss questions" title="Dismiss (Esc)">${glyph("close")}</button></div>`
      + `<div class="ask-hint" hidden>Press Tab to answer</div>`
      + `<div class="ask-opts" role="${multi ? "group" : "radiogroup"}" aria-labelledby="ask-q-${n}">${rows}</div>`
      + `<div class="ask-other"><span class="ask-pencil" aria-hidden="true">${glyph("pencil")}</span>`
      + `<textarea class="ask-field" rows="1" maxlength="${MAX_TEXT}" aria-label="Your own answer" aria-describedby="ask-k-${n}"></textarea><span class="sr-only" id="ask-k-${n}">Enter sends, Shift+Enter adds a line</span>`
      + `<button type="button" class="ask-skip" title="Skip this question" hidden>Skip</button><button type="button" class="ask-act"></button></div>`
      + pager
      + `<div class="ask-error" id="ask-e-${n}" hidden></div>`;
    const field = el.querySelector(".ask-field");
    field.value = answer.other;
    placeholder(state, field);
    field.addEventListener("input", () => { answer.other = field.value; grow(field); paintChecks(state); paintAction(state); fit(state); });
    grow(field);
    el.querySelectorAll(".ask-opt").forEach((row) => {
      row.addEventListener("click", (event) => {
        // A pointer click is never delayed; a synthetic or keyboard click waits out the arrival guard.
        if ((event.detail === 0 && !state.armed) || state.entering) return;
        choose(state, Number(row.dataset.i));
      });
    });
    el.querySelector(".ask-x").addEventListener("click", (event) => { if (event.detail !== 0 || state.armed) dismiss(state); });
    el.querySelector(".ask-act").addEventListener("click", (event) => {
      if ((event.detail === 0 && !state.armed) || state.entering) return;
      action(state);
    });
    el.querySelector(".ask-skip").addEventListener("click", (event) => {
      if ((event.detail === 0 && !state.armed) || state.entering) return;
      skip(state);
    });
    el.querySelectorAll(".ask-page").forEach((button) => button.addEventListener("click", () => page(state, Number(button.dataset.step))));
    paintAction(state);
    el.classList.remove("ask-enter");
    if (entering) enter(state);
    fit(state);
  }

  // The question arrives the way the model's own words do, a word at a time, and its options follow
  // one after another. Only opacity and transform move, so the card's measured fit never changes.
  function enter(state) {
    const { el } = state, doc = el.ownerDocument;
    const view = doc.defaultView || root;
    if (typeof view.matchMedia === "function" && view.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const line = el.querySelector(".ask-q");
    const parts = line.textContent.split(/(\s+)/).filter(Boolean);
    const words = parts.filter((part) => !/^\s+$/.test(part)).length;
    const gap = Math.min(28, Math.floor(STREAM_MS / Math.max(1, words)));
    line.textContent = "";
    let w = 0;
    for (const part of parts) {
      if (/^\s+$/.test(part)) { line.append(part); continue; }
      const word = doc.createElement("span");
      word.className = "ask-w";
      word.textContent = part;
      word.style.animationDelay = `${w++ * gap}ms`;
      line.append(word);
    }
    const start = Math.min(w * gap, 140);
    rowsOf(state).forEach((row, k) => { row.style.animationDelay = `${start + k * POP_GAP_MS}ms`; });
    el.classList.add("ask-enter");
  }
  // After a step, the new question's rows and buttons sit where the last ones were.
  function stepGuard(state) {
    state.entering = true;
    setTimeout(() => { state.entering = false; }, STEP_GUARD_MS);
  }

  // The pill: Next (primary) once the question has a pick or words while another is still open; Submit
  // (Continue on a single question) when nothing else is open, which sends; Skip while the question has
  // neither, which settles it without sending. With a pick, Skip is its own quieter button beside the
  // pill. A question already settled with nothing in it (skipped, or after a rejection) submits as it is.
  function pill(state) {
    const i = state.index, q = state.questions[i], answer = state.answers[i];
    const has = !!answer.other.trim() || picked(q, answer).length > 0;
    const others = state.answers.every((a, k) => k === i || a.settled);
    return others && (has || answer.settled) ? "submit" : has ? "next" : "skip";
  }
  function paintAction(state) {
    if (!state.el.isConnected && state.retired) return;
    const i = state.index, q = state.questions[i], answer = state.answers[i];
    const button = state.el.querySelector(".ask-act"), skipper = state.el.querySelector(".ask-skip");
    if (!button) return;
    const has = !!answer.other.trim() || picked(q, answer).length > 0;
    const now = pill(state), several = state.questions.length > 1;
    button.textContent = now === "submit" ? (several ? "Submit" : "Continue") : now === "next" ? "Next" : "Skip";
    button.classList.toggle("primary", now !== "skip");
    button.title = now === "submit" ? "Send your answers" : now === "next" ? "Go to the next question" : "Skip this question";
    if (skipper) skipper.hidden = !has;
    const pg = state.el.querySelector(".ask-pg");
    if (pg) pg.textContent = `Question ${i + 1} of ${state.questions.length}`
      + (state.answers.every((a) => a.settled) ? " · all answered" : "");
    const field = state.el.querySelector(".ask-field");
    if (field && !field.value) placeholder(state, field);      // Skip and the button just changed its width
  }
  function paintChecks(state) {
    const q = state.questions[state.index], chosen = picked(q, state.answers[state.index]);
    rowsOf(state).forEach((row, k) => {
      const on = chosen.includes(k);
      row.classList.toggle("checked", on);
      row.setAttribute("aria-checked", String(on));
      row.querySelector(".ask-n").textContent = on && q.multi_select ? "✓" : String(k + 1);
    });
  }
  // The hint fits the field, not the window: beside Skip and Continue in a side bar the long one
  // wrapped onto a second line and pushed the pencil out of line; in the narrowest (a 300 px side bar, under a Pip's
  // reply) even "Something else…" was cut to "Somet", so there it is one word.
  function placeholder(state, field) {
    const width = field.clientWidth || field.getBoundingClientRect().width;
    field.placeholder = width && width < 104 ? "Other…" : width && width < 300 ? "Something else…"
      : (state.opts.hint || "Something else? Tell DGC what you want");
  }
  function grow(field) {
    field.style.height = "auto";
    const view = field.ownerDocument.defaultView || root;
    const line = parseFloat(view.getComputedStyle(field).lineHeight) || 18;
    const max = line * 4 + 8;
    // An empty field is one line: Chromium counts a wrapped placeholder in scrollHeight.
    const wanted = field.value ? (field.scrollHeight || line) : line;
    field.style.height = `${Math.min(max, Math.max(line + 4, wanted))}px`;
    field.style.overflowY = wanted > max ? "auto" : "hidden";
  }

  // The page changed size: the free-text field's hint and height follow the room it has now.
  function resized(state) {
    const field = state?.el.querySelector(".ask-field");
    if (field) { placeholder(state, field); grow(field); }
  }

  function rowsOf(state) { return [...state.el.querySelectorAll(".ask-opt")]; }
  function hotRow(state) { return rowsOf(state)[state.hot[state.index]] || rowsOf(state)[0] || null; }
  // The card's focus target: its highlighted row (the preselected recommendation on open).
  function focus(state) {
    if (!state || state.retired || !state.el.isConnected) return false;
    const row = hotRow(state);
    (row || state.el).focus({ preventScroll: true });
    row?.scrollIntoView?.({ block: "nearest" });
    return true;
  }
  function setHot(state, k, moveFocus = true) {
    const rows = rowsOf(state);
    if (!rows.length) return;
    const next = Math.max(0, Math.min(rows.length - 1, k));
    state.hot[state.index] = next;
    rows.forEach((row, index) => { row.classList.toggle("hot", index === next); row.tabIndex = index === next ? 0 : -1; });
    if (moveFocus) rows[next].focus({ preventScroll: true });
    rows[next].scrollIntoView?.({ block: "nearest" });
  }

  function key(state, event) {
    if (state.retired) { event.stopPropagation(); return; }
    const target = event.target;
    const inField = target.classList?.contains("ask-field");
    const onRow = target.classList?.contains("ask-opt");
    const k = event.key;
    if (k === "Escape") {
      // The card owns Escape: it must never reach the composer, where Escape means Stop.
      event.preventDefault(); event.stopPropagation();
      if (!state.armed || state.sending) return;
      if (inField && target.value.trim()) { setHot(state, state.hot[state.index]); return; }
      dismiss(state);
      return;
    }
    if (target === state.el) {
      if (k === "Tab" && !event.shiftKey) { event.preventDefault(); focus(state); }
      return;                                   // keys typed at the card itself are not choices
    }
    if (event.repeat && (k === "Enter" || k === " ") && !(target.classList?.contains("ask-field") && event.shiftKey)) {
      event.preventDefault();
      return;
    }
    if (state.sending || state.busy) {
      if (["Enter", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(k) || /^[1-9]$/.test(k)) event.preventDefault();
      return;
    }
    const q = state.questions[state.index];
    const count = q.options.length;
    if (inField) {
      if (k === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!state.armed || state.entering || event.repeat) return;
        // Enter does what the pill says when it is Next or Continue; skipping stays explicit.
        if (target.value.trim() || picked(q, state.answers[state.index]).length) action(state);
        return;
      }
      if (k === "ArrowUp") {
        const before = target.value.slice(0, target.selectionStart ?? 0);
        if (!before.includes("\n")) { event.preventDefault(); setHot(state, count - 1); }
      }
      return;
    }
    if (k === "ArrowDown" && onRow) {
      event.preventDefault();
      const at = state.hot[state.index];
      if (at >= count - 1) state.el.querySelector(".ask-field")?.focus(); else setHot(state, at + 1);
    } else if (k === "ArrowUp" && onRow) {
      event.preventDefault(); setHot(state, state.hot[state.index] - 1);
    } else if (k === "Home" && onRow) {
      event.preventDefault(); setHot(state, 0);
    } else if (k === "End" && onRow) {
      event.preventDefault(); setHot(state, count - 1);
    } else if ((k === "ArrowLeft" || k === "ArrowRight") && !event.altKey) {
      event.preventDefault(); page(state, k === "ArrowLeft" ? -1 : 1);
    } else if (/^[1-9]$/.test(k) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (!state.armed || state.entering || event.repeat) return;
      const at = Number(k) - 1;
      if (at < count) { setHot(state, at); choose(state, at); }
    } else if ((k === "Enter" || k === " ") && onRow) {
      event.preventDefault();
      if (!state.armed || state.entering || event.repeat) return;
      if (k === "Enter" && (event.ctrlKey || event.metaKey)) {
        if (picked(q, state.answers[state.index]).length || state.answers[state.index].other.trim()) action(state);
        return;
      }
      choose(state, Number(target.dataset.i));
    }
  }

  function choose(state, k) {
    if (state.retired || state.sending || state.busy) return;
    const i = state.index, q = state.questions[i], answer = state.answers[i];
    if (!(k >= 0 && k < q.options.length)) return;
    setHot(state, k, false);
    if (q.multi_select) {
      answer.selected = answer.selected.includes(k) ? answer.selected.filter((x) => x !== k) : [...answer.selected, k].sort((a, b) => a - b);
      answer.settled = false;
      paintChecks(state);
      paintAction(state);
      return;
    }
    answer.selected = [k]; answer.other = "";
    const field = state.el.querySelector(".ask-field"); if (field) { field.value = ""; grow(field); }
    paintChecks(state);
    paintAction(state);
    rowsOf(state).forEach((row, x) => row.classList.toggle("picked", x === k));
    const more = state.answers.some((a, x) => x !== i && !a.settled);
    state.busy = true;
    setTimeout(() => {
      if (state.retired) return;
      state.busy = false;
      settle(state);
    }, more ? STEP_MS : CHOSEN_MS);
  }

  // The pill settles the question with what it shows: the pick (the preselected recommendation
  // included), the written words, or nothing (a skip) when it reads Skip.
  function action(state) {
    if (state.retired || state.sending || state.busy) return;
    const i = state.index, q = state.questions[i], answer = state.answers[i];
    const field = state.el.querySelector(".ask-field");
    answer.other = (field ? field.value : answer.other).slice(0, MAX_TEXT);
    const submit = pill(state) === "submit";
    answer.selected = [...picked(q, answer)];
    if (!answer.other.trim()) answer.other = "";
    settle(state, submit);
  }
  // Skip clears this question's pick and words and settles it as skipped.
  function skip(state) {
    if (state.retired || state.sending || state.busy) return;
    const answer = state.answers[state.index];
    answer.selected = []; answer.other = "";
    const field = state.el.querySelector(".ask-field"); if (field) field.value = "";
    settle(state);
  }

  // One question is answered or skipped: go to the next unsettled question (after this one, wrapping),
  // never skipping one on the reader's behalf. With nothing left, a single question sends; a card of
  // several stays where it is with Submit focused, and only Submit sends.
  function settle(state, submit = false) {
    const i = state.index;
    state.answers[i].settled = true;
    const open = state.answers.map((a, k) => (a.settled ? -1 : k)).filter((k) => k >= 0);
    if (!open.length && (submit || state.questions.length === 1)) {
      post(state, { answers: Object.fromEntries(state.questions.map((q, k) => [q.id, {
        selected: [...picked(q, state.answers[k])], other: state.answers[k].other.trim() }])) });
      return;
    }
    if (!open.length) {
      rowsOf(state).forEach((row) => row.classList.remove("picked"));
      paintAction(state);
      stepGuard(state);
      state.el.querySelector(".ask-act")?.focus({ preventScroll: true });
      speak(state, `All ${state.questions.length} questions answered. Press Submit to send them.`);
      return;
    }
    state.index = open.find((k) => k > i) ?? open[0];
    render(state, true);
    stepGuard(state);
    speak(state, `Question ${state.index + 1} of ${state.questions.length}: ${state.questions[state.index].question}`);
    focus(state);
  }

  function page(state, step) {
    if (state.retired || state.sending) return;
    const next = state.index + step;
    if (next < 0 || next >= state.questions.length) return;
    state.index = next;
    render(state, true);
    focus(state);
  }

  function dismiss(state) {
    if (state.retired || state.sending) return;
    post(state, { dismissed: true });
  }

  function post(state, payload) {
    state.sending = true;
    // Disabling the focused control would drop focus to the page: the card holds it instead, so
    // the composer gets it back when the card closes.
    const at = active(state);
    if (state.el.contains(at) && at !== state.el) state.el.focus({ preventScroll: true });
    state.el.classList.add("sending");
    state.el.setAttribute("aria-busy", "true");
    state.el.querySelectorAll("button, textarea").forEach((control) => { control.disabled = true; });
    speak(state, payload.dismissed ? "Closing the question" : "Sending your answers");
    const error = state.el.querySelector(".ask-error");
    if (error) { error.hidden = true; state.el.removeAttribute("aria-describedby"); }
    let sending = state.el.querySelector(".ask-sending");
    if (!sending) {
      sending = state.el.ownerDocument.createElement("div");
      sending.className = "ask-sending"; sending.textContent = "Sending…";
      sending.setAttribute("aria-hidden", "true"); state.el.appendChild(sending);
    }
    state.opts.onPost?.(payload);
  }

  // The answer was refused: the answers stay settled, so Submit resends them; any question can still be changed first.
  function rejected(state, message) {
    state.sending = false;
    state.el.classList.remove("sending");
    state.el.removeAttribute("aria-busy");
    state.el.querySelector(".ask-sending")?.remove();
    render(state);
    const error = state.el.querySelector(".ask-error");
    const said = message || "DGC could not use that answer. Try again.";
    error.textContent = said;
    error.hidden = false;
    state.el.setAttribute("aria-describedby", error.id);
    speak(state, said);
    fit(state);
    focus(state);
  }

  // Ended for good (answered, dismissed, replaced, gone): nothing on it answers any more. The page takes it away.
  function retire(state) {
    if (!state) return;
    state.retired = true;
    state.el.classList.add("expired");
    state.el.querySelectorAll("button, textarea").forEach((control) => { control.disabled = true; });
  }

  // ---- the answered state ----
  // Kept in full (reported 2026-10-17): "Questions · Answered · 4 questions", open, with every
  // question and every option still there, the ones picked marked (a filled circle for one choice, a ticked
  // box for several) and the rest quieter, so it says what was asked as well as what was chosen.
  function summary(ev) {
    const qs = Array.isArray(ev.questions) ? ev.questions : [];
    const n = countLabel(qs.length);
    if (ev.outcome === "dismissed") return `· Dismissed · ${n}`;
    if (ev.outcome !== "answered") return `· Not answered · ${n}`;
    return `· Answered · ${n}`;
  }
  function answeredOption(option, chosen, multi, extra = "") {
    const said = option.words ?? desc(option);
    return `<li class="asked-opt${chosen ? " picked" : ""}${extra}"><span class="asked-mark ${multi ? "check" : "radio"}" aria-hidden="true"></span>`
      + `<span class="asked-opt-text"><span class="sr-only">${chosen ? "Chosen: " : "Not chosen: "}</span>`
      + `<span class="asked-opt-label">${esc(option.words !== undefined ? option.label : label(option))}</span>`
      + `${option.words === undefined && flagged(option) ? '<span class="ask-badge">Recommended</span>' : ""}`
      + `${said ? `<span class="asked-opt-desc">${esc(said)}</span>` : ""}</span></li>`;
  }
  /** A settled card: {outcome: answered | dismissed | unavailable | cancelled | closed, questions, answers}. */
  function answeredHtml(ev) {
    const qs = Array.isArray(ev.questions) ? ev.questions : [];
    if (ev.outcome === "dismissed") return '<p class="asked-outcome">Dismissed without an answer</p>';
    if (ev.outcome === "unavailable") return '<p class="asked-outcome">Not answered: nobody could answer here</p>';
    if (ev.outcome === "closed") return '<p class="asked-outcome">Not answered: the chat moved on</p>';
    if (ev.outcome !== "answered") return '<p class="asked-outcome">Not answered: the turn stopped</p>';
    return `<div class="asked-panel">${qs.map((q) => {
      const a = (ev.answers || {})[q.id] || {};
      const options = Array.isArray(q.options) ? q.options : [];
      const multi = !!q.multi_select;
      const words = String(a.other || "").trim();
      const selected = Array.isArray(a.selected) ? a.selected : [];
      // In a single choice, written words replace the pick (picked()): only one row is marked.
      const marked = new Set(multi ? selected : words ? [] : selected.slice(0, 1));
      const rows = options.map((o, k) => answeredOption(o, marked.has(k), multi)).join("");
      const said = words ? answeredOption({ label: "Your words", words: `“${words}”` }, true, multi, " asked-words") : "";
      const skipped = !marked.size && !words ? '<p class="asked-skipped">Skipped</p>' : "";
      return `<section class="asked-question"><div class="asked-q">${esc(q.question)}</div>`
        + `<ul class="asked-options">${rows}${said}</ul>${skipped}</section>`;
    }).join("")}</div>`;
  }

  root.DgcAskCard = { valid, unmark, label, desc, flagged, picked, countLabel, create, render, focus, post, rejected,
    retire, dismiss, resized, summary, answeredHtml, glyph, MAX_TEXT };
})();
