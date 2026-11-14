// The two migration notes of 0.52 (pips-flow-design §3.3, items 2 and 3), the page's half.
//
// "Your Pips moved into one list": a pop-up over the Pips tab, once, for someone whose Pips came from 0.51. It names
// the user's own Pips: the ones that were Project Pips, by folder, the Personal ones, what is different, and who was
// on Do it all. Got it, Esc and a click outside close it for good: the page says {type: "pipsWelcomeSeen"} and the
// editor remembers (src/pipsWelcome.ts). A Pip's name opens that Pip.
//
// The quiet note above a Work session that used to get Pip cards: "Pips report in their own chats now", the Pips of
// those cards by name, each with "Open <name>". Not a pop-up, never the focus, not in the transcript. × closes it for
// good, and so does opening one of its Pips.
//
// A classic script, loaded before the side bar's own (window.DgcPipsWelcome). The pop-up draws into #pips-welcome and
// the note into #pip-session-note (src/panel.ts); the look is media/shared/pipswelcome.css. Everything is built with
// textContent: no markup is ever taken from a message.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcPipsWelcome) return;

  const PIP = /^pip_[0-9a-f]{32}$/;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const pips = (list) => (Array.isArray(list) ? list : []).filter((p) => p && typeof p === "object" && PIP.test(String(p.id || "")) && typeof p.name === "string" && p.name.trim())
    .map((p) => ({ id: p.id, name: p.name.trim() }));
  const face = (tone) => { const f = el("span", "pw-face"); f.dataset.tone = tone; f.setAttribute("aria-hidden", "true"); f.append(el("i"), el("i")); return f; };
  /** A name that opens its Pip. */
  function nameButton(pip, cls, open, label) {
    const b = el("button", cls, label || pip.name); b.type = "button"; b.dataset.pip = pip.id; b.title = `Open ${pip.name}`;
    b.addEventListener("click", (e) => { e.stopPropagation(); open(pip.id); });
    return b;
  }
  /** A group's names, each a button. As a heading: up to three, "A · B · C"; more: "A, B and 4 more".
   *  In a sentence: "A", "A and B", "A, B and C"; more: "A, B and 4 more". */
  function names(list, open, sentence = false) {
    const out = el("span", "pw-names");
    const shown = list.length > 3 ? list.slice(0, 2) : list, more = list.length - shown.length;
    shown.forEach((pip, i) => {
      if (i) out.append(more || sentence ? (i === shown.length - 1 && !more ? " and " : ", ") : " · ");
      out.append(nameButton(pip, "pw-pip", open));
    });
    if (more) out.append(el("span", "pw-more", ` and ${more} more`));
    return out;
  }
  const DIFFERENT = "A Pip now tells you what it finds in its own chat, not in a Work session. What needs you is on Home and under Needs attention here. All your Pips start at Ask me first.";

  // ---- the pop-up -------------------------------------------------------------------------------------------------
  function mount(layer, { onSeen, onOpenPip } = {}) {
    let back = null;
    const dialog = el("div", "pw-dialog dgc-dialog");
    const body = el("div", "pw-body"), foot = el("div", "pw-foot");
    const title = el("h2", "pw-title"); title.id = "pw-title"; title.tabIndex = -1;
    const how = el("button", "pw-how", "How Pips work now"), got = el("button", "pw-got dgc-btn primary", "Got it");
    how.type = got.type = "button";
    how.title = "How Pips work now";
    foot.append(how, got);
    dialog.append(body, foot);
    layer.replaceChildren(dialog);
    layer.setAttribute("aria-labelledby", "pw-title");

    function close(seen = true) {
      if (layer.hidden) return;
      layer.hidden = true;
      document.removeEventListener("keydown", keys, true);
      if (seen && typeof onSeen === "function") onSeen();
      try { if (back && back.isConnected) back.focus(); } catch { /* the page's own focus */ }
      back = null;
    }
    const openPip = (id) => { close(true); if (typeof onOpenPip === "function") onOpenPip(id); };
    function row(mark, head, says, cls) {
      const r = el("div", "pw-row" + (cls ? " " + cls : ""));
      const words = el("div", "pw-words");
      words.append(head, says);
      r.append(mark, words);
      return r;
    }
    function draw(welcome) {
      const folders = (Array.isArray(welcome.folders) ? welcome.folders : []).map((f) => ({ folder: f && typeof f.folder === "string" ? f.folder.trim() : "", pips: pips(f && f.pips) })).filter((f) => f.pips.length);
      const personal = pips(welcome.personal), full = pips(welcome.do_it_all), moved = welcome.had_pips === true && (folders.length > 0 || personal.length > 0);
      title.textContent = moved ? "Your Pips moved into one list" : "How Pips work now";
      const rows = el("div", "pw-rows");
      if (moved) {
        for (const f of folders) {
          const one = f.pips.length === 1, where = f.folder ? ` in ${f.folder}` : "";
          rows.append(row(face("green"), names(f.pips, openPip), el("p", "pw-says", one
            ? `Was a Project Pip${where}. Now it has its own computer and reads your files as they are, not only what is committed.`
            : `Were Project Pips${where}. Now each has its own computer and reads your files as they are, not only what is committed.`)));
        }
        if (personal.length) rows.append(row(face("blue"), names(personal, openPip), el("p", "pw-says", personal.length === 1 ? "Was a Personal Pip. Nothing changes for it." : "Were Personal Pips. Nothing changes for them.")));
      }
      rows.append(row(el("span", "pw-dot"), el("span", "pw-names pw-head", "What is different"), el("p", "pw-says", DIFFERENT), "pw-different"));
      if (moved && full.length) {
        // One sentence: "Mornings was on Do it all. It keeps what that meant before; …"
        const one = full.length === 1, line = el("p", "pw-line");
        line.append(names(full, openPip, true), " ", el("span", "pw-says", one
          ? "was on Do it all. It keeps what that meant before; choose Do it all again to let it do more."
          : "were on Do it all. They keep what that meant before; choose Do it all again to let them do more."));
        const r = el("div", "pw-row pw-full"); r.append(el("span", "pw-dot quiet"), line);
        rows.append(r);
      }
      body.replaceChildren(title, ...(moved ? [el("p", "pw-lead", "Nothing was lost. Every Pip kept its name, its job, its schedule and its history.")] : []), rows);
      body.scrollTop = 0;
    }
    function keys(e) {
      if (layer.hidden) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); return; }
      if (e.key === "Tab") {
        // The keyboard stays in the pop-up while it is open.
        const stops = [...layer.querySelectorAll("button")].filter((b) => !b.hidden && !b.disabled);
        const here = stops.indexOf(document.activeElement);
        e.preventDefault(); e.stopPropagation();
        const to = here < 0 ? (e.shiftKey ? stops.length - 1 : 0) : (here + (e.shiftKey ? -1 : 1) + stops.length) % stops.length;
        stops[to]?.focus();
      }
    }
    // A click on the page behind it closes it for good, as Got it does (the design's words; What's new differs).
    layer.addEventListener("click", (e) => { if (e.target === layer) close(true); });
    got.addEventListener("click", () => close(true));
    // For now the pop-up is what "How Pips work now" opens (a docs page comes later): it stays, back at its top.
    how.addEventListener("click", () => { body.scrollTop = 0; try { title.focus({ preventScroll: true }); } catch { /* stays where it is */ } });

    return {
      /** Opens it on what DGC said moved. False when that is not a welcome. */
      open(welcome) {
        if (!welcome || typeof welcome !== "object") return false;
        draw(welcome);
        if (layer.hidden) back = document.activeElement;
        layer.hidden = false;
        document.removeEventListener("keydown", keys, true);
        document.addEventListener("keydown", keys, true);
        try { got.focus({ preventScroll: true }); } catch { /* no focus to give */ }
        return true;
      },
      close, isOpen: () => !layer.hidden,
    };
  }

  // ---- the note above an old Work session ------------------------------------------------------------------------
  /** The Pips of a history's report cards, each once, in the order their cards come. */
  function reporters(items) {
    const seen = new Set(), out = [];
    for (const it of Array.isArray(items) ? items : []) {
      const r = it && it.role === "pip_report" ? it.report : null;
      if (!r || typeof r !== "object" || !PIP.test(String(r.pip_id || "")) || typeof r.name !== "string" || !r.name.trim() || seen.has(r.pip_id)) continue;
      seen.add(r.pip_id);
      out.push({ id: r.pip_id, name: r.name.trim().slice(0, 120) });
    }
    return out;
  }
  /** "A", "A and B", "A, B and C"; more than three: "A, B, C and 2 more". */
  function sentenceNames(list) {
    const n = list.map((p) => p.name);
    if (n.length > 3) return `${n.slice(0, 3).join(", ")} and ${n.length - 3} more`;
    return n.length < 2 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
  }
  /** Draws the note into `host` and shows it. onClose: its ×; onOpen(id): one of its Pips (the caller hides it then). */
  function note(host, list, { onClose, onOpen } = {}) {
    const who = pips(list);
    if (!host || !who.length) return false;
    const one = who.length === 1;
    const words = el("div", "psn-words");
    words.append(el("strong", "psn-title", "Pips report in their own chats now"),
      el("p", "psn-text", `${sentenceNames(who)} used to post ${one ? "its" : "their"} reports here. From now on ${one ? "it tells you in its own chat" : "they tell you in their own chats"}, and what needs you is on Home. `
        + "The cards below stay as history. You can still ask about them here, or @ a Pip to give it a job."));
    const links = el("div", "psn-links");
    for (const pip of who.slice(0, 3)) links.append(nameButton(pip, "psn-open", (id) => { if (typeof onOpen === "function") onOpen(id); }, `Open ${pip.name}`));
    if (who.length > 3) links.append(el("span", "psn-more", `and ${who.length - 3} more`));
    words.append(links);
    const x = el("button", "psn-close"); x.type = "button"; x.setAttribute("aria-label", "Close"); x.title = "Close this note for good";
    const mark = el("span", "codicon codicon-close"); mark.setAttribute("aria-hidden", "true"); x.append(mark);
    x.addEventListener("click", () => { if (typeof onClose === "function") onClose(); });
    host.replaceChildren(face("green"), words, x);
    host.hidden = false;
    return true;
  }

  root.DgcPipsWelcome = { mount, note, reporters, sentenceNames };
})();
