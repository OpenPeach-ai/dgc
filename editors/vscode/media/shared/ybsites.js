// The sites Pips may use in Your Browser (Pips API 105; "new" and seen_your_browser_sites since 113), as ONE module for
// every place that shows them: the Sites panel, which the dock's Your Browser menu ("Sites Pips can use…") and a Pip's
// page ("All sites…") open, and a Pip's own sites on its page (src/pipYourBrowser.js draws those from what this reads
// and says).
//
// Your Browser is the person's own Google Chrome. A site joins the list when they sign in to it there themselves (DGC
// notices it) or when they Allow a Pip's "use this site in Your Browser?" card. Each site is used by every Pip ("All
// Pips"), by only the Pips they tick ("Some Pips"), or by none until they choose ("No Pips"; a bank or payment site
// starts there). Sign out takes a site off the list and clears its sign-in in Your Browser. Nothing here is a Pip's say:
// the panel shows what DGC answers and asks DGC for what the person clicks, one site at a time.
//
// A classic script, like media/shared/pipjob.js: the side bar loads it before main.js and the Pips bundle imports it, so
// both share window.DgcYbSites. Its look is media/shared/ybsites.css, the same on both pages.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcYbSites) return;

  const API = 113, MAX_SITES = 500, MAX_PIPS = 500;
  const SITE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/, PIP = /^pip_[A-Za-z0-9]{1,64}$/;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const record = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const words = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

  const pipOf = (p) => (record(p) && PIP.test(String(p.pip_id)) ? { pip_id: String(p.pip_id), name: words(p.name, 120) || "A Pip" } : null);
  function siteOf(s) {
    if (!record(s) || !SITE.test(String(s.site)) || !["all", "chosen"].includes(s.mode)) return null;
    return { site: String(s.site), shown: words(s.shown, 300) || String(s.site), mode: s.mode, money: s.money === true, fresh: s.new === true,
             pips: s.mode === "chosen" && Array.isArray(s.pips) ? s.pips.map(pipOf).filter(Boolean).slice(0, MAX_PIPS) : [] };
  }
  /** get_your_browser's answer, as these pages use it: the sites (each with its Pips), every Pip that may be chosen, and
      the sites still waiting for their sign-in to be cleared. Anything else in it is left out. */
  function read(said) {
    const list = (key, of, max) => (Array.isArray(said?.[key]) ? said[key].map(of).filter(Boolean).slice(0, max) : []);
    return { available: said?.available !== false, sites: list("sites", siteOf, MAX_SITES), pips: list("pips", pipOf, MAX_PIPS),
             waiting: list("signing_out", (s) => (typeof s === "string" && SITE.test(s) ? s : null), MAX_SITES) };
  }
  /** "all", "some" (only the Pips ticked) or "none" (no Pip until the person chooses). */
  const choice = (site) => (site.mode === "all" ? "all" : site.pips.length ? "some" : "none");
  /** A list of Pips' names in words: "Ava", "Ava and Rook", "Ava, Rook and Quill", "Ava, Rook and 3 more". */
  function names(list) {
    const n = list.map((p) => p.name);
    if (n.length <= 1) return n.join("");
    if (n.length === 2) return `${n[0]} and ${n[1]}`;
    if (n.length === 3) return `${n[0]}, ${n[1]} and ${n[2]}`;
    return `${n[0]}, ${n[1]} and ${n.length - 2} more`;
  }
  /** The one line under a site in the panel: who may use the person's sign-in there. */
  function who(site) {
    const c = choice(site);
    if (c === "all") return "Every Pip may use your sign-in here, each in its own tab.";
    if (c === "some") return `Only ${names(site.pips)} may use your sign-in here.`;
    return site.money ? "No Pip yet. It’s a bank or payment site: a Pip that needs it asks you first."
      : "No Pip yet: a Pip that needs it asks you first in its chat.";
  }
  /** The sites one Pip may use (``mine``) and the others it may be let use (``others``: none chosen for it yet). */
  function forPip(sites, pipId) {
    const mine = sites.filter((s) => s.mode === "all" || s.pips.some((p) => p.pip_id === pipId));
    return { mine, others: sites.filter((s) => !mine.includes(s)) };
  }
  /** set_your_browser_site's fields that take one Pip off a site and leave the others as they were. An All Pips site
      becomes every other Pip's (the ones on this computer now; a Pip made later asks first). */
  function without(site, pipId, allPips) {
    const keep = (site.mode === "all" ? allPips : site.pips).map((p) => p.pip_id).filter((id) => id !== pipId);
    return { site: site.site, mode: "chosen", pips: [...new Set(keep)] };
  }
  /** ...and the fields that let one more Pip use a site (none for an All Pips site: it may already). */
  const withPip = (site, pipId) => (site.mode === "all" ? null : { site: site.site, mode: "chosen", pips: [...new Set([...site.pips.map((p) => p.pip_id), pipId])] });

  // ---- the Sites panel ----------------------------------------------------------------------------------------------
  let shown = null;
  /** Close the panel (Done, Escape), giving the keys back to what had them. */
  function close(refocus = true) {
    const now = shown; if (!now) return;
    shown = null; now.dialog.remove();
    try { now.onClose?.(); } catch { /* (the page's own redraw: never in the way of closing) */ }
    if (refocus && now.focus?.isConnected) now.focus.focus();
  }
  const MODES = [["all", "All Pips"], ["some", "Some Pips"], ["none", "No Pips"]];
  let made = 0;
  /** Open the panel: every site, each with All Pips / Some Pips (tick which) / No Pips and Sign out. ``ask(type,
      fields)`` asks DGC (a Promise of the Pips control's answer); ``onSeen`` runs once the sites noticed until now are
      no longer new (the dock's "N new" goes); ``onClose`` when it closes. */
  function panel({ ask, doc = root.document, onSeen, onClose } = {}) {
    if (typeof ask !== "function" || !doc?.body) return null;
    close(false);
    const id = `yb-sites-${++made}`;
    const dialog = doc.createElement("dialog");
    dialog.className = "yb-sites-dialog dgc-dialog";
    dialog.setAttribute("aria-labelledby", `${id}-title`);
    dialog.innerHTML = `<div class="yb-sites-body"><h2 id="${id}-title" tabindex="-1">Sites Pips can use</h2>
      <p class="yb-sites-intro">The sites you’re signed in to in Your Browser. A Pip works there in its own tab with your sign-in, only on the sites you let it use; anywhere else it asks you first in its chat.</p>
      <p class="yb-sites-status" role="status">Loading…</p><ul class="yb-sites-list" hidden></ul>
      <p class="yb-sites-waiting" hidden></p><p class="yb-sites-error" role="alert" hidden></p><p class="yb-sites-hide yb-sites-said" role="status"></p></div>
      <div class="yb-sites-buttons"><button type="button" class="dgc-btn yb-sites-done">Done</button></div>`;
    const list = dialog.querySelector(".yb-sites-list"), status = dialog.querySelector(".yb-sites-status");
    const waiting = dialog.querySelector(".yb-sites-waiting"), error = dialog.querySelector(".yb-sites-error");
    // (What a change did, said for a reader: the row itself already shows it.)
    const said = dialog.querySelector(".yb-sites-said"), say = (text) => { said.textContent = ""; said.textContent = text; };
    // (``some``: a site the person just set to Some Pips shows its Pips to tick before any is ticked.)
    const state = { sites: [], pips: [], waiting: [], some: new Set(), confirm: "", busy: new Set(), errors: new Map() };
    // (A site and a control's key are plain letters, digits, dots and dashes: safe in a selector as they are.)
    const rowOf = (site) => (SITE.test(site) ? list.querySelector(`li[data-site="${site}"]`) : null);
    const siteNamed = (site) => state.sites.find((s) => s.site === site);
    const choiceOf = (s) => (choice(s) === "none" && state.some.has(s.site) ? "some" : choice(s));
    function rowHtml(s, at) {
      const c = choiceOf(s), off = state.busy.has(s.site) ? " disabled" : "", ticked = new Set(s.pips.map((p) => p.pip_id));
      // (Every Pip that may be chosen, and any the site names that is no longer listed, such as an archived one.)
      const pips = [...state.pips, ...s.pips.filter((p) => !state.pips.some((q) => q.pip_id === p.pip_id))];
      const tags = (s.fresh ? '<span class="yb-site-tag">New</span>' : "") + (s.money ? '<span class="yb-site-tag">Bank or payment</span>' : "");
      const confirm = state.confirm === s.site;
      const fail = state.errors.get(s.site) || "";
      return `<div class="yb-site-top"><span class="yb-site-name" title="${esc(s.site)}">${esc(s.shown)}</span>${tags}`
        + (confirm ? "" : `<button type="button" class="dgc-btn small yb-site-out" data-k="out" aria-label="Sign out of ${esc(s.site)}"${off}>Sign out</button>`) + "</div>"
        + (confirm ? `<div class="yb-site-confirm" role="group" aria-label="Sign out of ${esc(s.site)}"><p>Sign out of ${esc(s.site)}? No Pip can use it, and Your Browser clears your sign-in there.</p>`
            + `<div class="yb-site-confirm-buttons"><button type="button" class="dgc-btn small" data-k="keep"${off}>Keep</button><button type="button" class="dgc-btn small danger" data-k="out-yes"${off}>Sign out</button></div></div>` : "")
        + `<div class="yb-site-modes" role="radiogroup" aria-label="Which Pips may use ${esc(s.site)}">${MODES.map(([value, label]) =>
            `<label class="yb-site-mode"><input type="radio" name="${id}-m${at}" value="${value}" data-k="mode-${value}"${c === value ? " checked" : ""}${off}><span>${label}</span></label>`).join("")}</div>`
        + (c === "some" ? `<fieldset class="yb-site-pips"><legend class="yb-sites-hide">Pips that may use ${esc(s.site)}</legend>${pips.length
            ? pips.map((p) => `<label class="yb-site-pip"><input type="checkbox" value="${esc(p.pip_id)}" data-k="pip-${esc(p.pip_id)}"${ticked.has(p.pip_id) ? " checked" : ""}${off}><span>${esc(p.name)}</span></label>`).join("")
            : '<p class="yb-site-line">No Pips on this computer yet.</p>'}</fieldset>` : "")
        + `<p class="yb-site-line">${esc(c === "some" && !s.pips.length ? "Tick the Pips that may use your sign-in here." : who(s))}</p>`
        + `<p class="yb-site-error" role="alert"${fail ? "" : " hidden"}>${esc(fail)}</p>`;
    }
    /** Draw one site's row again, the keys staying on the control they were on. */
    function paintRow(site) {
      const li = rowOf(site), s = siteNamed(site); if (!li || !s) return;
      const had = li.contains(doc.activeElement) ? doc.activeElement.dataset?.k : "";
      li.innerHTML = rowHtml(s, state.sites.indexOf(s));
      li.classList.toggle("busy", state.busy.has(site));
      const back = had && /^[A-Za-z0-9_-]+$/.test(had) && (li.querySelector(`[data-k="${had}"]`) || (had === "out-yes" || had === "keep" ? li.querySelector('[data-k="out"]') : null));
      (back || (had ? li.querySelector("input:checked, input") : null))?.focus();
    }
    function paint() {
      error.hidden = true;
      list.hidden = !state.sites.length;
      list.innerHTML = state.sites.map((s) => `<li class="yb-site" data-site="${esc(s.site)}"></li>`).join("");
      for (const s of state.sites) paintRow(s.site);
      status.textContent = state.sites.length ? "" : "No sites yet. Sign in to a site in Your Browser and it shows here, for you to choose which Pips may use it.";
      status.hidden = !status.textContent;
      waiting.hidden = !state.waiting.length;
      waiting.textContent = state.waiting.length ? `Signing out of ${state.waiting.join(", ")}: Your Browser clears your sign-in there as soon as it runs.` : "";
    }
    /** Ask DGC for one site's change; its row is off until DGC answers, then drawn from what it says. */
    function change(site, fields) {
      if (state.busy.has(site)) return;
      state.busy.add(site); state.errors.delete(site); paintRow(site);
      ask("set_your_browser_site", { site, ...fields }).then((said) => {
        const next = siteOf(said?.site), s = siteNamed(site);
        if (next && s) { Object.assign(s, { ...next, fresh: s.fresh }); if (choice(s) !== "none") state.some.delete(site); }
        state.busy.delete(site); paintRow(site);
        if (s) say(`${s.site}: ${who(s)}`);
      }, (problem) => {
        state.busy.delete(site); state.errors.set(site, String(problem?.message || "That didn’t change. Try again.").slice(0, 400)); paintRow(site);
      });
    }
    function signOut(site) {
      if (state.busy.has(site)) return;
      state.busy.add(site); state.errors.delete(site); paintRow(site);
      ask("sign_out_your_browser_site", { site }).then(() => {
        state.busy.delete(site); state.confirm = "";
        state.sites = state.sites.filter((s) => s.site !== site);
        if (!state.waiting.includes(site)) state.waiting.push(site);
        paint();
        say(`Signed out of ${site}.`);
        (list.querySelector('[data-k="out"]') || dialog.querySelector(".yb-sites-done")).focus();
      }, (problem) => {
        state.busy.delete(site); state.errors.set(site, String(problem?.message || "Your Browser couldn’t sign out of that site. Try again.").slice(0, 400)); paintRow(site);
      });
    }
    list.addEventListener("change", (e) => {
      const input = e.target, li = input.closest?.("li[data-site]"); if (!li) return;
      const s = siteNamed(li.dataset.site); if (!s || state.busy.has(s.site)) return;
      if (input.type === "radio") {
        const now = choiceOf(s);
        if (input.value === now) return;
        if (input.value === "all") change(s.site, { mode: "all" });
        else if (input.value === "none") { state.some.delete(s.site); if (choice(s) === "none") paintRow(s.site); else change(s.site, { mode: "chosen", pips: [] }); }
        else { state.some.add(s.site); if (choice(s) === "all") change(s.site, { mode: "chosen", pips: [] }); else paintRow(s.site); }
        return;
      }
      if (input.type === "checkbox") {
        const ticked = [...li.querySelectorAll('.yb-site-pips input[type="checkbox"]')].filter((b) => b.checked).map((b) => b.value);
        change(s.site, { mode: "chosen", pips: ticked });
      }
    });
    list.addEventListener("click", (e) => {
      const button = e.target.closest?.("button[data-k]"), li = button?.closest("li[data-site]"); if (!li || button.disabled) return;
      const site = li.dataset.site;
      if (button.dataset.k === "out") { state.confirm = site; paintRow(site); li.querySelector('[data-k="keep"]')?.focus(); }
      else if (button.dataset.k === "keep") { state.confirm = ""; paintRow(site); li.querySelector('[data-k="out"]')?.focus(); }
      else if (button.dataset.k === "out-yes") signOut(site);
    });
    dialog.querySelector(".yb-sites-done").onclick = () => close();
    dialog.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
    dialog.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); close(); } });
    shown = { dialog, focus: doc.activeElement, onClose };
    doc.body.appendChild(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    // (The keys start at its title, as a dialog's do: Tab goes to the first site's choices. Never a ring on a choice
    // the person didn't touch.)
    const title = dialog.querySelector("h2");
    title.focus();
    ask("get_your_browser").then((said) => {
      if (shown?.dialog !== dialog) return;
      const value = read(said);
      // (The sites noticed since you last looked come first, each with New.)
      state.sites = [...value.sites.filter((s) => s.fresh), ...value.sites.filter((s) => !s.fresh)];
      state.pips = value.pips; state.waiting = value.waiting;
      paint();
      if (!dialog.contains(doc.activeElement)) title.focus();
      // (Opened: what was noticed until now is no longer new, here and on the dock.)
      ask("seen_your_browser_sites").then(() => { try { onSeen?.(); } catch { /* (the page's own redraw) */ } }, () => {});
    }, (problem) => {
      if (shown?.dialog !== dialog) return;
      status.hidden = true;
      error.textContent = String(problem?.message || "The sites didn’t load. Close this and try again.").slice(0, 400); error.hidden = false;
    });
    return dialog;
  }

  root.DgcYbSites = { API, read, choice, names, who, forPip, without, withPip, panel, close, isOpen: () => !!shown };
})();
