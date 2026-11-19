// A job a chat handed a Pip with @ (Pips API 111), as one card in Work, ChatDGC and a Pip's chat: the Pip's face and
// name, where it stands (Waiting for you, Starts after its current reply, On it, Answered), its answer, and its change
// with Apply, Review, Discard and Undo. The change is the Pip's own change of its copy (the same id its chat shows), so
// Apply here and Apply in the Pip's chat are one command, and each place reads the other's. In the Pip's own chat the
// job is the "From <where it was asked>: <the words>" line above its answer, and a job waiting at Ask me first is a card
// with Start and Not now.
//
// A classic script, like media/shared/card.js: Work's and ChatDGC's pages load it before their own script, and the Pips
// bundle imports it, so all three share window.DgcPipJob. Its look is media/shared/card.css (.dgc-card and its parts)
// plus media/shared/pipjob.css. What only the page knows it hands over: how to ask DGC (ask(type, fields), a Promise of
// the Pips control's result), how to open the Pip's chat (openChat) and where the job came from (openAsker), how to draw
// a Pip's face (face) and the page's words for its surface (place: "work", "chatdgc" or "pip").
//
// A store follows each job it is asked about: it reads get_pip_job while the job is not done, and for a while after
// while its change waits (so an Apply made in the Pip's chat shows here), then stops. A page that builds nodes (Work,
// ChatDGC) mounts an element per card and the store redraws it; a page that redraws itself from markup (a Pip's chat)
// asks html() for the card and is told (onChange) when to redraw. Clicks are the store's (click(target)).
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcPipJob) return;

  const API = 111, TOOL = "ask_pip";
  const JOB = /^pipjob_[0-9a-f]{32}$/, PIP = /^pip_[0-9a-f]{32}$/, CHANGE = /^pchange_[0-9a-f]{32}$/, CONV = /^conv_[0-9a-f]{32}$/;
  const STATES = ["asking", "queued", "working", "done", "failed", "declined", "stopped"];
  const LIVE = ["asking", "queued", "working"];
  const TYPES = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"];
  const POLL_MS = 2500, AFTER_MS = 8000, AFTER_FOR_MS = 15 * 60 * 1000, MAX_DIFF_LINES = 400;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const record = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const words = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

  /** The job a tool's answer names ("Handed to Scout (job pipjob_…)"), or "". */
  function jobIdIn(text) {
    const found = /\bpipjob_[0-9a-f]{32}\b/.exec(String(text || ""));
    return found ? found[0] : "";
  }

  /** A job as DGC sent it, checked: only what a card draws. Throws on anything else. */
  function checked(value) {
    if (!record(value) || !JOB.test(String(value.id)) || !STATES.includes(value.state) || !record(value.pip)
      || !PIP.test(String(value.pip.id)) || !record(value.asked_from)) throw new Error("This job didn't load.");
    const pip = { id: value.pip.id, name: words(value.pip.name, 120) || "A Pip",
                  pip_type: TYPES.includes(value.pip.pip_type) ? value.pip.pip_type : "rook" };
    const from = { kind: ["work", "chatdgc", "pip"].includes(value.asked_from.kind) ? value.asked_from.kind : "work",
                   id: words(value.asked_from.id, 160), title: words(value.asked_from.title, 200) };
    let change = null;
    if (record(value.change) && CHANGE.test(String(value.change.id))) {
      const c = value.change;
      change = { id: c.id, status: String(c.status || ""), digest: String(c.digest || "").slice(0, 128), name: words(c.name, 80),
                 files: (Array.isArray(c.files) ? c.files : []).filter((f) => record(f) && typeof f.path === "string").slice(0, 40)
                   .map((f) => ({ path: f.path.slice(0, 4096), change: String(f.change || "modified"), plus: count(f.plus), minus: count(f.minus), binary: f.binary === true })),
                 more: count(c.more), plus: count(c.plus), minus: count(c.minus),
                 held: Array.isArray(c.result?.held_back) ? c.result.held_back.length : 0,
                 byItself: typeof c.result?.by === "string" && c.result.by.startsWith("pip-level:") };
    }
    return { id: value.id, pip, from, state: value.state, stateWords: words(value.state_words, 300), words: words(value.words, 600),
             answer: typeof value.answer === "string" ? value.answer.slice(0, 8000) : "", more: value.answer_more === true,
             error: words(value.error, 600), change, conversation: CONV.test(String(value.conversation_id || "")) ? value.conversation_id : "",
             at: String(value.ended_at || value.updated_at || value.created_at || ""),
             folder: record(value.folder) ? { name: words(value.folder.name, 80), note: words(value.folder.note, 400) } : null };
  }

  function ago(iso) {
    const at = Date.parse(iso), now = Date.now();
    if (!Number.isFinite(at)) return "";
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function faceOf(pip, opts, key) {
    if (typeof opts.face === "function") { const drawn = opts.face(pip, key); if (drawn) return drawn; }
    const index = TYPES.indexOf(pip.pip_type), plush = root.PipConcepts?.plush;
    if (index >= 0 && plush?.markup) {
      // The faces' one stylesheet goes in the page once (media/mentions.js), so each face is the drawing alone.
      let shared = false;
      try { const doc = opts.document || root.document; if (doc && root.DgcMentions?.ensureFaceStyles) { root.DgcMentions.ensureFaceStyles(doc); shared = true; } } catch { shared = false; }
      try { return plush.markup({ index, name: pip.name }, "idle", `pipjob-${key}`.replace(/[^A-Za-z0-9_-]/g, ""), { paused: true, includeStyles: !shared }); } catch { /* the letter, below */ }
    }
    return `<span class="pipjob-letter">${esc(pip.name.slice(0, 1).toUpperCase())}</span>`;
  }

  const FOR = { work: "for this session", chatdgc: "for this chat", pip: "for this chat" };
  function head(job, opts) {
    const name = job.pip.name;
    const title = { asking: `Waiting for you in ${name}'s chat`, queued: `${name} has the job`, working: `${name} is on it`,
                    done: `${name} answered`, failed: `${name} couldn't finish`, declined: `${name} didn't take it`,
                    stopped: `${name} stopped` }[job.state];
    const when = job.state === "done" ? ago(job.at) : "";
    const sub = job.state === "done" ? [when, FOR[opts.place] || ""].filter(Boolean).join(" · ")
      : job.state === "declined" ? "You said not now in its chat"
      : job.state === "asking" ? "It asks before it starts: it's at Ask me first"
      : job.state === "failed" ? "" : job.stateWords;
    return { title, sub };
  }

  function changeLine(change) {
    if (!change) return "";
    const n = change.files.length + change.more;
    const files = `${plural(n, "file")} · <span class="pipjob-plus">+${change.plus}</span> <span class="pipjob-minus">−${change.minus}</span>`;
    const where = change.status === "pending" ? "not in your folder yet"
      : change.status === "applied" ? (change.byItself ? "applied by itself (Do it all)" : "applied to your folder")
      : change.status === "partial" ? `applied, ${plural(change.held, "file")} held back`
      : change.status === "not_applied" ? "nothing applied: your files changed meanwhile"
      : change.status === "discarded" ? "discarded" : change.status === "undone" ? "undone" : change.status;
    return `<p class="pipjob-change">${files} · ${esc(where)}</p>`;
  }

  function diffHtml(text) {
    const lines = String(text || "").split("\n").slice(0, MAX_DIFF_LINES);
    return `<pre class="pipjob-diff">${lines.map((line) => {
      const cls = line.startsWith("+++") || line.startsWith("---") ? "meta" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "";
      return `<span${cls ? ` class="pipjob-diff-${cls}"` : ""}>${esc(line)}</span>`;
    }).join("\n")}</pre>`;
  }

  /** A whole card for a job, as markup. `state`: what the store knows of it beside the job (busy, error, open, diffs). */
  function markup(job, opts = {}, state = {}) {
    const { title, sub } = head(job, opts);
    const key = `${opts.place || "chat"}-${job.id.slice(7, 19)}`;
    const busy = !!state.busy, change = job.change;
    const render = typeof opts.render === "function" ? opts.render
      : (root.DgcMarkdown?.render ? (t) => root.DgcMarkdown.render(t) : (t) => `<p>${esc(t).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>")}</p>`);
    let body = "";
    const live = job.state === "queued" || job.state === "working";
    if (job.state === "done" && job.answer) {
      let html = "";
      try { html = render(job.answer); } catch { html = `<p>${esc(job.answer)}</p>`; }
      body = `<div class="pipjob-answer">${html}</div>` + (job.more ? `<p class="dgc-card-note">The rest is in ${esc(job.pip.name)}'s chat.</p>` : "");
    }
    if (job.state === "failed" && job.error) body = `<p class="dgc-card-note">${esc(job.error)}</p>`;
    if (job.folder?.note && LIVE.includes(job.state)) body += `<p class="dgc-card-note">It has no copy of ${esc(job.folder.name || "the folder")}: ${esc(job.folder.note)}</p>`;
    const pending = change?.status === "pending", applied = change && ["applied", "partial"].includes(change.status);
    const open = !!state.open && !!change;
    const details = change ? `<div class="dgc-card-details pipjob-files"${open ? "" : " hidden"}>${change.files.map((f) => {
      const shown = state.diffs?.[f.path];
      return `<div class="pipjob-file"><button type="button" class="dgc-card-link pipjob-file-link" data-pipjob-act="file" data-pipjob="${esc(job.id)}" data-path="${esc(f.path)}" aria-expanded="${shown ? "true" : "false"}">${esc(f.path)}</button>`
        + `<span class="pipjob-file-count">${f.binary ? "binary" : `<span class="pipjob-plus">+${f.plus}</span> <span class="pipjob-minus">−${f.minus}</span>`}</span>`
        + (shown ? diffHtml(shown) : "") + `</div>`;
    }).join("")}${change.more ? `<p class="dgc-card-note">and ${plural(change.more, "more file")} in ${esc(job.pip.name)}'s chat</p>` : ""}</div>` : "";
    const act = (name, label, cls = "dgc-card-btn") => `<button type="button" class="${cls}" data-pipjob-act="${name}" data-pipjob="${esc(job.id)}"${busy ? " disabled" : ""}${name === "review" ? ` aria-expanded="${open}"` : ""}>${esc(label)}</button>`;
    const actions = [];
    if (job.state === "asking" && opts.place === "pip-own") actions.push(act("start", "Start", "dgc-card-btn primary"), act("decline", "Not now"));
    if (pending) actions.push(act("apply", "Apply", "dgc-card-btn primary"), act("review", open ? "Hide" : "Review"), act("discard", "Discard", "dgc-card-link pipjob-discard"));
    else if (applied) actions.push(act("undo", "Undo"), act("review", open ? "Hide" : "Review"));
    // Open its chat sits in the quiet line under the title ("4m · for this session · Open its chat"), as the job's own
    // line does in the picture of it: the answers below stay Apply, Review and Discard.
    const open_ = opts.place !== "pip-own" ? `<button type="button" class="pipjob-open" data-pipjob-act="open" data-pipjob="${esc(job.id)}">Open its chat</button>` : "";
    // (While it works, a slow pulse before its words says it is still going.)
    const pulse = live ? `<span class="pipjob-pulse" aria-hidden="true"></span>` : "";
    const subLine = sub || open_ ? `<span class="dgc-card-sub">${pulse}${esc(sub)}${sub && open_ ? `<span class="pipjob-dot" aria-hidden="true"> · </span>` : ""}${open_}</span>` : "";
    return `<section class="dgc-card pipjob" data-pipjob="${esc(job.id)}" data-state="${esc(job.state)}" role="group" aria-label="${esc(title)}">`
      + `<div class="dgc-card-head"><span class="dgc-card-icon dgc-card-face" aria-hidden="true">${faceOf(job.pip, opts, key)}</span>`
      + `<div class="dgc-card-words"><strong class="dgc-card-title">${esc(title)}</strong>${subLine}</div></div>`
      + body + changeLine(change) + details
      + (state.error ? `<p class="dgc-card-error" role="alert">${esc(state.error)}</p>` : "")
      + (actions.length ? `<div class="dgc-card-actions">${actions.join("")}</div>` : "")
      + `</section>`;
  }

  /** A job before DGC has said where it stands (a reload, the moment it was handed): its Pip and its words. */
  function placeholder(id, pip, words_, opts = {}) {
    const p = record(pip) && PIP.test(String(pip.id)) ? { id: pip.id, name: words(pip.name, 120) || "A Pip", pip_type: TYPES.includes(pip.pip_type) ? pip.pip_type : "rook" }
      : { id: "pip_" + "0".repeat(32), name: words(pip?.name, 120) || "A Pip", pip_type: "rook" };
    return markup({ id, pip: p, from: { kind: "work", id: "", title: "" }, state: "working", stateWords: "Reading where it stands…",
                    words: words(words_, 600), answer: "", more: false, error: "", change: null, conversation: "", at: "", folder: null }, opts);
  }

  const MARKS = { work: "code", chatdgc: "ask", pip: "pip" };
  /** The job's own line in the Pip's chat, above its answer: "From <where it was asked>: <the words>", linked back. */
  function fromLine(value, opts = {}) {
    if (!record(value) || !JOB.test(String(value.id)) || !record(value.asked_from)) return "";
    const from = value.asked_from, kind = ["work", "chatdgc", "pip"].includes(from.kind) ? from.kind : "work";
    const where = words(from.title, 200) || { work: "a Work session", chatdgc: "a ChatDGC chat", pip: "a Pip" }[kind];
    const mark = root.DgcCard?.icon ? root.DgcCard.icon(MARKS[kind]) : "";
    const link = opts.openAsker ? `<button type="button" class="pipjob-from-link" data-pipjob-act="asker" data-pipjob="${esc(value.id)}" data-kind="${kind}" data-id="${esc(from.id)}" data-title="${esc(where)}">${esc(where)}</button>` : `<em>${esc(where)}</em>`;
    return `<div class="pipjob-from" data-pipjob="${esc(value.id)}"><span class="pipjob-from-mark" aria-hidden="true">${mark}</span>`
      + `<p class="pipjob-from-words">From ${link}: ${esc(words(value.words, 600))}</p></div>`;
  }

  /** A job waiting at Ask me first, in the Pip's own chat: where it came from, its words, Start and Not now. */
  function askingHtml(value, opts = {}, state = {}) {
    let job;
    try { job = checked(value); } catch { return ""; }
    const where = job.from.title || "a chat";
    const busy = !!state.busy;
    const link = opts.openAsker ? `<button type="button" class="dgc-card-link" data-pipjob-act="asker" data-pipjob="${esc(job.id)}" data-kind="${job.from.kind}" data-id="${esc(job.from.id)}" data-title="${esc(where)}">Open where it was asked</button>` : "";
    return `<section class="dgc-card pipjob pipjob-asking" data-pipjob="${esc(job.id)}" data-state="asking" role="group" aria-label="A job from ${esc(where)}">`
      + `<div class="dgc-card-head"><span class="dgc-card-icon" aria-hidden="true">${root.DgcCard?.icon ? root.DgcCard.icon(MARKS[job.from.kind]) : ""}</span>`
      + `<div class="dgc-card-words"><strong class="dgc-card-title">A job from “${esc(where)}”</strong><span class="dgc-card-sub">${esc(job.words)}</span></div></div>`
      + `<p class="dgc-card-note">It waits for your Start: this Pip is at Ask me first.</p>`
      + (state.error ? `<p class="dgc-card-error" role="alert">${esc(state.error)}</p>` : "")
      + `<div class="dgc-card-actions"><button type="button" class="dgc-card-btn primary" data-pipjob-act="start" data-pipjob="${esc(job.id)}" data-pip="${esc(job.pip.id)}"${busy ? " disabled" : ""}>Start</button>`
      + `<button type="button" class="dgc-card-btn" data-pipjob-act="decline" data-pipjob="${esc(job.id)}" data-pip="${esc(job.pip.id)}"${busy ? " disabled" : ""}>Not now</button>${link}</div></section>`;
  }

  /**
   * One page's jobs. opts: { ask(type, fields) → Promise, openChat(pip, conversationId), openAsker({kind, id, title}),
   * face(pip, key), render(text), place, onChange(id) (a page that redraws from markup), document }.
   */
  function store(opts = {}) {
    const jobs = new Map();          // id -> { job, busy, error, open, diffs, polled, timer, until, mounted: Set }
    const doc = opts.document || root.document;
    const entry = (id) => { let e = jobs.get(id); if (!e) { e = { job: null, busy: false, error: "", open: false, diffs: {}, timer: 0, until: 0, mounted: new Set(), seed: null }; jobs.set(id, e); } return e; };
    const changed = (id) => {
      const e = jobs.get(id); if (!e) return;
      for (const node of [...e.mounted]) {
        if (!node.isConnected && e.polled) { e.mounted.delete(node); continue; }
        const fresh = drawn(id);
        if (!fresh) continue;
        for (const name of ["data-state", "aria-label", "class"]) node.setAttribute(name, fresh.getAttribute(name) || "");
        node.innerHTML = fresh.innerHTML;
      }
      try { opts.onChange?.(id); } catch { /* a page's redraw is its own */ }
    };
    const drawn = (id) => {
      const e = jobs.get(id); const html = e?.job ? markup(e.job, opts, e) : placeholder(id, e?.seed?.pip, e?.seed?.words, opts);
      const t = doc.createElement("template"); t.innerHTML = html; return t.content.firstElementChild;
    };
    const alive = (e) => e.mounted.size === 0 || [...e.mounted].some((n) => n.isConnected);
    function schedule(id) {
      const e = jobs.get(id); if (!e) return;
      clearTimeout(e.timer); e.timer = 0;
      const job = e.job, now = Date.now();
      const live = !job || LIVE.includes(job.state);
      const waiting = job && job.change && job.change.status === "pending";
      if (!live && !(waiting && now < e.until)) return;
      if (!alive(e) && e.polled) return;
      e.timer = setTimeout(() => read(id), live ? POLL_MS : AFTER_MS);
    }
    function read(id) {
      const e = entry(id);
      if (typeof opts.ask !== "function") return Promise.resolve();
      return Promise.resolve(opts.ask("get_pip_job", { job_id: id })).then((result) => {
        const job = checked(result?.job);
        const was = e.job ? JSON.stringify(e.job) : "";
        if (!e.job || LIVE.includes(e.job.state) || job.change?.status === "pending") e.until = Date.now() + AFTER_FOR_MS;
        e.job = job; e.polled = true;
        if (JSON.stringify(job) !== was) changed(id);
      }, (error) => {
        e.polled = true;
        if (!e.job) { e.error = String(error?.message || "DGC didn't answer.").slice(0, 300); changed(id); }
      }).finally(() => schedule(id));
    }
    /** Follow a job (its card is shown somewhere). seed: {pip, words} to draw before DGC answers. */
    function want(id, seed) {
      if (!JOB.test(String(id))) return;
      const e = entry(id);
      if (seed && !e.seed) e.seed = seed;
      if (!e.timer && (!e.polled || !e.job || LIVE.includes(e.job.state) || (e.job.change?.status === "pending"))) read(id);
    }
    /** A card element for the job, kept drawn by the store (Work, ChatDGC). */
    function mount(id, seed) {
      const t = doc.createElement("template");
      const e = entry(id);
      if (seed && !e.seed) e.seed = seed;
      t.innerHTML = e.job ? markup(e.job, opts, e) : placeholder(id, e.seed?.pip, e.seed?.words, opts);
      const node = t.content.firstElementChild;
      e.mounted.add(node);
      want(id, seed);
      return node;
    }
    /** The card's markup, for a page that redraws from markup (a Pip's chat); `brief` is what the page has of it. */
    function html(id, brief) {
      const e = entry(id);
      if (!e.job && brief) { try { e.job = checked({ ...brief, change: null }); } catch { /* drawn as waiting */ } }
      want(id);
      return e.job ? markup(e.job, opts, e) : placeholder(id, brief?.pip, brief?.words, opts);
    }
    async function act(id, action, extra = {}) {
      const e = entry(id), job = e.job;
      if (!job || e.busy) return;
      const change = job.change;
      const call = {
        apply: change && ["apply_pip_project_change", { pip_id: job.pip.id, change_id: change.id, expected_digest: change.digest }],
        discard: change && ["discard_pip_project_change", { pip_id: job.pip.id, change_id: change.id }],
        undo: change && ["undo_pip_project_change", { pip_id: job.pip.id, change_id: change.id }],
        start: ["start_pip_job", { pip_id: job.pip.id, job_id: job.id }],
        decline: ["decline_pip_job", { pip_id: job.pip.id, job_id: job.id }],
      }[action];
      if (!call) return;
      e.busy = true; e.error = ""; changed(id);
      try {
        await opts.ask(call[0], call[1]);
        e.until = Date.now() + AFTER_FOR_MS;
      } catch (error) {
        e.error = String(error?.message || "DGC didn't do that. Try again.").slice(0, 300);
      }
      e.busy = false;
      await read(id);
      changed(id);
      void extra;
    }
    async function file(id, path) {
      const e = entry(id), job = e.job;
      if (!job?.change) return;
      if (e.diffs[path]) { delete e.diffs[path]; changed(id); return; }
      try {
        const got = await opts.ask("get_pip_project_change", { pip_id: job.pip.id, change_id: job.change.id, path });
        e.diffs[path] = String(got?.diff || "").slice(0, 200000) || "(No difference to show.)";
      } catch (error) {
        e.error = String(error?.message || "That file's change didn't load.").slice(0, 300);
      }
      changed(id);
    }
    /** A click in the page: true when it was one of these cards' (and it has been done). */
    function click(target) {
      const button = target?.closest ? target.closest("[data-pipjob-act]") : null;
      if (!button || button.disabled) return false;
      const id = button.getAttribute("data-pipjob"), action = button.getAttribute("data-pipjob-act");
      if (!JOB.test(String(id))) return false;
      const e = entry(id);
      if (action === "open") { if (e.job) opts.openChat?.(e.job.pip, e.job.conversation); return true; }
      if (action === "asker") {
        opts.openAsker?.({ kind: button.getAttribute("data-kind"), id: button.getAttribute("data-id"), title: button.getAttribute("data-title") });
        return true;
      }
      if (action === "review") { e.open = !e.open; changed(id); return true; }
      if (action === "file") { void file(id, button.getAttribute("data-path") || ""); return true; }
      if ((action === "start" || action === "decline") && !e.job) {
        // An Ask me first card drawn from the chat's own list: the job is the one it names.
        const pip = button.getAttribute("data-pip");
        if (!PIP.test(String(pip))) return true;
        e.busy = true; changed(id);
        Promise.resolve(opts.ask(action === "start" ? "start_pip_job" : "decline_pip_job", { pip_id: pip, job_id: id }))
          .then(() => read(id), (error) => { e.error = String(error?.message || "DGC didn't do that.").slice(0, 300); })
          .finally(() => { e.busy = false; changed(id); });
        return true;
      }
      void act(id, action);
      return true;
    }
    function state(id) { const e = jobs.get(id); return e ? { busy: e.busy, error: e.error, open: e.open, diffs: e.diffs } : {}; }
    function get(id) { return jobs.get(id)?.job || null; }
    /** The page went away (or reconnected): every timer stops; a later want() starts again. */
    function stop() { for (const e of jobs.values()) { clearTimeout(e.timer); e.timer = 0; } }
    return { want, mount, html, click, act, get, state, stop, read };
  }

  root.DgcPipJob = Object.freeze({ API, TOOL, jobIdIn, checked, markup, placeholder, fromLine, askingHtml, store, ago });
})();
