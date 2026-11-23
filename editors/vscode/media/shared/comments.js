// Comments on an artifact, one module for every surface that shows one: the artifact panel (a deck, a sheet, a
// checklist, a page, a dashboard: media/artifact.js) and a document's formatted editor (src/canvasEditor.ts). The
// surface says what is picked and where (offer(anchor, rect)); this draws the Comment button by it, the box to write
// the comment in, and the thread rail: each thread with what it points at, its messages, DGC's suggestions to accept
// or reject one by one, Ask DGC, Reply, Resolve; resolved threads fold away under one line. What it is asked to do goes
// to the surface's host as {type: "comments", op, …} (post); the threads come back with set(threads, version).
// Everything a person or a model wrote is put in as text, never as markup. A classic script: window.DgcComments.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcComments) return;
  const MAX_TEXT = 4000;

  /** What a comment points at, in words (the composer's line, a thread whose place the process didn't say). */
  function anchorWords(anchor) {
    const a = anchor && typeof anchor === "object" ? anchor : {};
    const q = typeof a.quote === "string" && a.quote.trim() ? `“${a.quote.trim().replace(/\s+/g, " ").slice(0, 140)}${a.quote.length > 140 ? "…" : ""}”` : "";
    if (a.kind === "cells") return `${/:/.test(a.range || "") ? "Cells" : "Cell"} ${a.range || ""} on “${a.sheet || ""}”`;
    if (a.kind === "slide") return `Slide ${a.slide || "?"}${a.field && a.field !== "slide" ? ` · ${a.field === "bullets" ? "points" : a.field}` : ""}${q ? ` · ${q}` : ""}`;
    if (a.kind === "item") return `${a.item || ""}${a.title ? ` “${a.title}”` : ""}${q ? ` · ${q}` : ""}`;
    if (a.kind === "element") return q || (a.near ? `The page, under “${a.near}”` : "Part of the page");
    if (a.kind === "text") return q;
    return "The whole of it";
  }

  function when(stamp) {
    const at = Date.parse(String(stamp || ""));
    if (!Number.isFinite(at)) return "";
    const d = new Date(at), now = new Date();
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
  }

  /**
   * One surface's comments. opts: {rail: the element the threads are drawn in, post(message), reveal(anchor): show
   * where a thread points, kind: the artifact's type label ("sheet"), changed({open, all, threads}): after each
   * drawing (the surface shows or hides its rail and counts), doc: the page's document}.
   */
  function make(opts) {
    const doc = opts.doc || root.document;
    const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const glyph = (name, size = 14) => { const g = root.DgcIcons?.node?.(name, { size }, doc); if (g) return g; const s = el("span"); s.setAttribute("aria-hidden", "true"); return s; };
    const button = (cls, label, run, extra = {}) => {
      const b = el("button", cls, extra.icon ? undefined : label); b.type = "button";
      if (extra.icon) { b.append(glyph(extra.icon, extra.size || 14)); if (extra.words) b.append(el("span", "dgc-cm-words", label)); }
      if (extra.aria) b.setAttribute("aria-label", extra.aria);
      if (extra.title) b.title = extra.title;
      b.addEventListener("click", (e) => { e.stopPropagation(); run(e); });
      return b;
    };
    let threads = [], version = 0, offered = null, draft = null, showResolved = false, replying = "", locked = false, said = "";
    const rail = opts.rail;
    rail.classList.add("dgc-cm-rail");
    const live = el("div", "dgc-cm-live"); live.setAttribute("aria-live", "polite");
    const say = (text) => { live.textContent = ""; setTimeout(() => { live.textContent = text; }, 30); };

    // ---- the Comment button by what is picked
    const add = el("button", "dgc-btn dgc-cm-add"); add.type = "button"; add.hidden = true;
    add.append(glyph("comment"), el("span", "dgc-cm-words", "Comment"));
    add.title = "Comment on what you picked (Ctrl+Alt+M)";
    add.setAttribute("aria-label", "Comment on what you picked");
    add.addEventListener("mousedown", (e) => e.preventDefault());            // the selection stays
    add.addEventListener("click", (e) => { e.stopPropagation(); if (offered) compose(offered.anchor, add.getBoundingClientRect()); });
    doc.body.append(add);

    // ---- the box to write one in
    const box = el("form", "dgc-cm-compose dgc-popover"); box.hidden = true;
    box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "New comment");
    const boxQuote = el("p", "dgc-cm-compose-on");
    const field = el("textarea", "dgc-cm-field"); field.rows = 3; field.maxLength = MAX_TEXT;
    field.placeholder = "Comment, or ask DGC to change it…"; field.setAttribute("aria-label", "Your comment");
    const boxActs = el("div", "dgc-cm-compose-acts");
    const cancel = button("dgc-btn small text", "Cancel", () => closeBox(true));
    const save = button("dgc-btn small", "Comment", () => send(false), { title: "Keep the comment; DGC answers when you ask it" });
    const ask = button("dgc-btn small primary", "Ask DGC", () => send(true), { title: "Comment, and have DGC answer or make the change (Ctrl+Enter)" });
    boxActs.append(cancel, save, ask);
    box.append(boxQuote, field, boxActs);
    box.addEventListener("submit", (e) => { e.preventDefault(); send(true); });
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeBox(true); }
    });
    doc.body.append(box);
    let boxFrom = null;
    function place(node, rect, gap = 6, beside = false) {
      const vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
      node.style.left = "0px"; node.style.top = "0px";
      const w = node.offsetWidth, h = node.offsetHeight;
      if (beside && rect.right + gap + w <= vw - 8) {
        // (Beside a cell, not over the one under it.)
        node.style.left = `${Math.round(rect.right + gap)}px`;
        node.style.top = `${Math.round(Math.max(8, Math.min(vh - h - 8, rect.top + (rect.bottom - rect.top - h) / 2)))}px`;
        return;
      }
      const left = Math.max(8, Math.min(vw - w - 8, (rect.right ?? rect.left) - w));
      let top = rect.bottom + gap;
      if (top + h > vh - 8) top = Math.max(8, rect.top - h - gap);
      node.style.left = `${Math.round(left)}px`; node.style.top = `${Math.round(top)}px`;
    }
    function compose(anchor, rect) {
      if (locked || !anchor) return;
      draft = anchor;
      boxQuote.textContent = anchorWords(anchor);
      boxFrom = doc.activeElement;
      box.hidden = false; field.value = "";
      place(box, rect || { left: 8, right: 320, top: 8, bottom: 8 });
      field.focus();
    }
    function closeBox(back) {
      if (box.hidden) return;
      box.hidden = true; draft = null;
      if (back) boxFrom?.focus?.();
    }
    function send(askDgc) {
      const text = field.value.trim();
      if (!text) { field.focus(); return; }
      said = "";
      opts.post({ type: "comments", op: "add", anchor: draft, text: text.slice(0, MAX_TEXT), ask: !!askDgc, version });
      closeBox(false); hide();
      say(askDgc ? "Comment sent. DGC is answering." : "Comment kept.");
    }
    doc.addEventListener("mousedown", (e) => { if (!box.hidden && !box.contains(e.target) && e.target !== add) closeBox(false); }, true);
    doc.addEventListener("keydown", (e) => {
      if (e.altKey && (e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "m" || e.key === "M" || e.code === "KeyM")) {
        const now = opts.current?.() || offered?.anchor;
        if (now) { e.preventDefault(); compose(now, offered?.rect || add.getBoundingClientRect()); }
      }
    });

    /** What is picked now, and where on the page (the button stands by its lower right). Null: nothing picked. */
    function offer(anchor, rect, { beside = false } = {}) {
      if (locked || !anchor || !rect) { hide(); return; }
      offered = { anchor, rect };
      add.hidden = false;
      place(add, rect, 4, beside);
    }
    function hide() { add.hidden = true; offered = null; }

    // ---- the rail
    function act(op, thread, extra = {}) { said = ""; opts.post({ type: "comments", op, thread: thread.id, ...extra }); }
    function message(m) {
      const by = String(m.by || "").toLowerCase() === "you" ? "you" : "dgc";
      const li = el("li", "dgc-cm-msg"); li.dataset.by = by; li.dataset.kind = String(m.kind || "");
      const top = el("div", "dgc-cm-msg-top");
      top.append(el("span", "dgc-cm-who", by === "you" ? "You" : "DGC"), el("span", "dgc-cm-when", when(m.at)));
      li.append(top, el("p", "dgc-cm-text", String(m.text || "")));
      return li;
    }
    function suggestion(thread, s) {
      const li = el("li", "dgc-cm-sug"); li.dataset.state = s.state; li.dataset.suggestion = s.id;
      const words = el("div", "dgc-cm-sug-words");
      const was = el("del", "dgc-cm-was", String(s.old || "")), now = el("ins", "dgc-cm-now", String(s.new || ""));
      if (!s.new) now.textContent = "(taken out)";
      words.append(was, now);
      li.append(words);
      if (s.state === "open") {
        const acts = el("div", "dgc-cm-sug-acts");
        const yes = button("dgc-btn small primary", "Accept", () => { yes.disabled = no.disabled = true; act("accept", thread, { suggestion: s.id }); },
          { aria: `Accept: “${String(s.new || "").slice(0, 60)}” instead of “${String(s.old || "").slice(0, 60)}”`, title: "Make this change: a new version" });
        const no = button("dgc-btn small", "Reject", () => { yes.disabled = no.disabled = true; act("reject", thread, { suggestion: s.id }); },
          { aria: `Reject the change to “${String(s.old || "").slice(0, 60)}”`, title: "Leave it as it is" });
        yes.disabled = no.disabled = locked;
        acts.append(yes, no);
        li.append(acts);
      } else {
        li.append(el("span", "dgc-cm-sug-state", s.state === "accepted" ? `Accepted${s.version ? ` · version ${s.version}` : ""}` : "Rejected"));
      }
      return li;
    }
    function replyBox(thread) {
      const form = el("form", "dgc-cm-reply");
      const area = el("textarea", "dgc-cm-field"); area.rows = 2; area.maxLength = MAX_TEXT;
      area.placeholder = "Reply…"; area.setAttribute("aria-label", "Your reply");
      const go = (askDgc) => {
        const text = area.value.trim(); if (!text) { area.focus(); return; }
        replying = ""; act("reply", thread, { text, ask: askDgc });
        paint();
        say(askDgc ? "Reply sent. DGC is answering." : "Reply kept.");
      };
      area.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(true); }
        else if (e.key === "Escape") { e.preventDefault(); replying = ""; paint(); }
      });
      const acts = el("div", "dgc-cm-acts");
      acts.append(button("dgc-btn small text", "Cancel", () => { replying = ""; paint(); }),
                  button("dgc-btn small", "Reply", () => go(false)),
                  button("dgc-btn small primary", "Ask DGC", () => go(true), { title: "Reply, and have DGC answer (Ctrl+Enter)" }));
      form.addEventListener("submit", (e) => { e.preventDefault(); go(true); });
      form.append(area, acts);
      setTimeout(() => area.focus(), 0);
      return form;
    }
    function card(thread) {
      const resolved = thread.status === "resolved";
      const li = el("li", "dgc-cm-thread"); li.dataset.thread = thread.id; li.dataset.status = thread.status; li.dataset.found = thread.found || "here";
      const where = button("dgc-cm-where", thread.where || anchorWords(thread.anchor), () => opts.reveal?.(thread.anchor, thread),
        { title: thread.found === "changed" ? "What it pointed at isn't there any more" : "Show it" });
      if (thread.found === "changed") where.classList.add("dgc-cm-lost");
      const top = el("div", "dgc-cm-thread-top");
      const del = button("dgc-cm-icon", "Delete", () => act("delete", thread), { icon: "delete", aria: "Delete this comment", title: "Delete this comment and its replies" });
      del.disabled = locked;
      top.append(where, del);
      li.append(top);
      const quote = thread.anchor?.quote;
      if (quote && !resolved) li.append(el("blockquote", "dgc-cm-quote", String(quote)));
      const messages = Array.isArray(thread.messages) ? thread.messages : [];
      if (resolved) {
        li.append(el("p", "dgc-cm-text dgc-cm-gist", String(messages[0]?.text || "").slice(0, 160)));
      } else {
        const list = el("ol", "dgc-cm-msgs");
        list.append(...messages.map(message));
        li.append(list);
        const sugs = (Array.isArray(thread.suggestions) ? thread.suggestions : []);
        if (sugs.length) { const ul = el("ul", "dgc-cm-sugs"); ul.setAttribute("aria-label", "Suggested changes"); ul.append(...sugs.map((s) => suggestion(thread, s))); li.append(ul); }
        if (thread.answering) { const busy = el("p", "dgc-cm-busy", "DGC is answering…"); busy.setAttribute("role", "status"); li.append(busy); }
      }
      if (replying === thread.id && !resolved) { li.append(replyBox(thread)); return li; }
      const acts = el("div", "dgc-cm-acts");
      if (resolved) {
        acts.append(button("dgc-btn small", "Reopen", () => act("resolve", thread, { resolved: false }), { aria: "Reopen this comment" }));
      } else {
        const r = button("dgc-btn small", "Reply", () => { replying = thread.id; paint(); }, { aria: "Reply to this comment" });
        const a = button("dgc-btn small primary", "Ask DGC", () => act("ask", thread), { aria: "Ask DGC about this comment", title: "DGC answers here, or makes the change and says so" });
        const done = button("dgc-btn small", "Resolve", () => act("resolve", thread, { resolved: true }), { aria: "Resolve this comment", title: "Done: it folds away" });
        a.disabled = !!thread.answering || locked;
        r.disabled = done.disabled = locked;
        acts.append(r, a, done);
      }
      li.append(acts);
      return li;
    }
    function paint() {
      const open = threads.filter((t) => t.status !== "resolved"), done = threads.filter((t) => t.status === "resolved");
      const keep = doc.activeElement && rail.contains(doc.activeElement) ? [doc.activeElement.closest(".dgc-cm-thread")?.dataset.thread, doc.activeElement.textContent] : null;
      rail.replaceChildren();
      const head = el("div", "dgc-cm-head");
      const title = el("h2", "dgc-cm-title", "Comments");
      const count = el("span", "dgc-cm-count", open.length ? `${open.length} open` : "");
      const fresh = button("dgc-cm-icon dgc-cm-new", "New comment", () => compose({ kind: "whole" }, fresh.getBoundingClientRect()),
        { icon: "comment", aria: `New comment on the whole ${opts.kind || "artifact"}`, title: `Comment on the whole ${opts.kind || "artifact"}` });
      fresh.disabled = locked;
      head.append(title, count, el("span", "dgc-cm-spacer"), fresh);
      rail.append(head);
      if (said && opts.sayInRail) {
        // (What DGC refused, kept on the rail until it is closed or the next thing is asked: the shared Dismiss ×.)
        const line = el("p", "dgc-cm-said", said); line.setAttribute("role", "alert");
        rail.append(line);
        root.DgcDismiss?.add?.(line, { onDismiss: () => { said = ""; } });
      }
      if (!open.length) rail.append(el("p", "dgc-cm-hint", opts.hint || "Pick part of it to comment on it, or comment on the whole of it."));
      if (open.length) { const list = el("ol", "dgc-cm-list"); list.setAttribute("aria-label", "Open comments"); list.append(...open.map(card)); rail.append(list); }
      if (done.length) {
        const fold = button("dgc-btn small text dgc-cm-folded", `${done.length} resolved`, () => { showResolved = !showResolved; paint(); },
          { aria: `${showResolved ? "Hide" : "Show"} ${done.length} resolved comment${done.length === 1 ? "" : "s"}` });
        fold.setAttribute("aria-expanded", String(showResolved));
        rail.append(fold);
        if (showResolved) { const list = el("ol", "dgc-cm-list dgc-cm-resolved"); list.setAttribute("aria-label", "Resolved comments"); list.append(...done.map(card)); rail.append(list); }
      }
      rail.append(live);
      if (keep?.[0]) {
        const again = [...rail.querySelectorAll(".dgc-cm-thread")].find((n) => n.dataset.thread === keep[0]);
        [...(again?.querySelectorAll("button") || [])].find((b) => b.textContent === keep[1])?.focus({ preventScroll: true });
      }
      opts.changed?.({ open: open.length, all: threads.length, threads });
    }
    function set(list, at) {
      threads = Array.isArray(list) ? list.filter((t) => t && typeof t.id === "string") : [];
      version = Number(at) || version;
      paint();
    }
    /** Something asked was refused: said aloud, and on the rail where the surface has no line of its own for it. */
    function rejected(text) {
      const words = String(text || "DGC couldn't do that.").slice(0, 400);
      if (opts.sayInRail) { said = words; paint(); }
      say(words);
    }
    function lock(on) { locked = !!on; if (locked) { hide(); closeBox(false); } paint(); }
    /** Show one thread (a highlight in the artifact was clicked). */
    function focus(id) {
      const t = threads.find((x) => x.id === id);
      if (t && t.status === "resolved" && !showResolved) { showResolved = true; paint(); }
      const node = [...rail.querySelectorAll(".dgc-cm-thread")].find((n) => n.dataset.thread === id);
      if (!node) return;
      node.scrollIntoView({ block: "nearest" });
      node.classList.add("dgc-cm-lit"); setTimeout(() => node.classList.remove("dgc-cm-lit"), 1200);
      node.querySelector("button")?.focus({ preventScroll: true });
    }
    paint();
    return { set, offer, hide, compose, rejected, lock, focus, threads: () => threads, open: () => threads.filter((t) => t.status !== "resolved").length };
  }

  root.DgcComments = Object.freeze({ make, anchorWords });
})();
