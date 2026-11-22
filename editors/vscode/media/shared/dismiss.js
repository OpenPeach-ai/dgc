// One × for every line that stays: a warning, an error or a "done" note that a page keeps on screen until something
// else replaces it can be closed, the same way on every surface (Work, ChatDGC, Home, the Library, Settings, the Pips
// page and a Pip's chat, a Pip's computer, Your Browser's tab, an artifact's page). A classic script, like
// media/shared/tip.js: the pages load it after icons.js, the bundles import it, and all share window.DgcDismiss.
//
// The button is the Close glyph in a 26px box with the 6px corner, titled "Dismiss" and named "Dismiss this message".
// Closing a line hides that message only: the same words stay closed while the page keeps saying them, and a line
// that went away and came back (a new try that failed the same way) or says something else shows again. The focus
// goes to the control after the line (else the one before it, else the page's heading), so it is never lost.
//
//   DgcDismiss.html()                       the button, as markup, for a page that draws its own lines
//   DgcDismiss.add(line, { focus, onDismiss })   one line that a page made by hand (a row of Work's transcript)
//   const w = DgcDismiss.watch({ root, lines: [".notice.error", { sel, focus, onDismiss }] });   every such line of a
//       page, whoever draws it and however often: found again after each change. w.refresh(); w.dispose();
//
// Not for a field's own line beside its input, a dialog's own words, anything said in a conversation, or a line
// that counts work in progress: a page names only its lines that state a problem or a result.
(function (root) {
  "use strict";
  if (root.DgcDismiss) return;
  const TITLE = "Dismiss", NAME = "Dismiss this message", GONE = "data-dgc-dismissed", LINE = "dgc-dismissible", BUTTON = "dgc-dismiss";
  // The Close glyph, the one DgcIcons draws; its outline again for a page that loads no icons.
  const CLOSE = "M8.69 8 12.37 4.37Q12.48 4.21 12.48 4Q12.48 3.79 12.35 3.65Q12.21 3.52 12 3.52Q11.79 3.52 11.63 3.63L8 7.31L4.37 3.63Q4.21 3.52 4 3.52Q3.79 3.52 3.65 3.65Q3.52 3.79 3.52 4Q3.52 4.21 3.63 4.37L7.31 8L3.63 11.63Q3.52 11.79 3.52 12Q3.52 12.21 3.65 12.35Q3.79 12.48 4 12.48Q4.21 12.48 4.37 12.37L8 8.69L11.63 12.37Q11.79 12.48 12 12.48Q12.21 12.48 12.35 12.35Q12.48 12.21 12.48 12Q12.48 11.79 12.37 11.63Z";
  const glyph = () => root.DgcIcons?.html?.("close", { size: 14 })
    || `<svg class="dgc-icon" data-icon="close" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="currentColor"><path d="${CLOSE}"/></svg>`;
  const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /** The button as markup. `attrs` is the page's own hook on it (already-safe markup, e.g. data-dismiss-note="error"). */
  function html({ attrs = "", cls = "", label = NAME } = {}) {
    return `<button type="button" class="${BUTTON}${cls ? ` ${escAttr(cls)}` : ""}"${attrs ? ` ${attrs}` : ""} title="${TITLE}" aria-label="${escAttr(label)}" data-dom-own="1">${glyph()}</button>`;
  }
  function button(doc = root.document) {
    const box = doc.createElement("template"); box.innerHTML = html();
    return box.content.firstElementChild;
  }

  const FOCUSABLE = 'button:not([disabled]),a[href],input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
  const shown = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) if (n.hidden || n.hasAttribute(GONE) || n.getAttribute("aria-hidden") === "true") return false; return true; };
  /** Where the focus goes when `line` closes: the control after it, else the one before, else the heading, else the page. */
  function focusAfter(line, scope) {
    const doc = line.ownerDocument, within = scope && scope.querySelectorAll ? scope : doc;
    const all = [...within.querySelectorAll(FOCUSABLE)].filter((el) => !line.contains(el) && shown(el));
    const after = all.find((el) => line.compareDocumentPosition(el) & 4), before = all.reverse().find((el) => line.compareDocumentPosition(el) & 2);
    let to = after || before;
    if (!to) {
      to = within.querySelector("h1,h2,[role=heading]") || doc.body;
      if (to && !to.hasAttribute("tabindex")) to.setAttribute("tabindex", "-1");
    }
    try { to?.focus?.({ preventScroll: true }); } catch { /* a page that is going away */ }
    return to || null;
  }
  function moveFocus(line, focus, scope) {
    const to = typeof focus === "function" ? focus(line) : typeof focus === "string" ? (scope?.querySelector?.(focus) || line.ownerDocument.querySelector(focus)) : focus;
    if (to && typeof to.focus === "function" && shown(to)) { try { to.focus({ preventScroll: true }); return to; } catch { /* falls through */ } }
    return focusAfter(line, scope);
  }

  /** What a line says, without its ×. */
  const wordsOf = (line) => {
    let words = "";
    for (const n of line.childNodes) if (!(n.nodeType === 1 && n.classList.contains(BUTTON))) words += n.textContent || "";
    return words.replace(/\s+/g, " ").trim();
  };
  const own = (line) => { for (const n of line.children) if (n.classList.contains(BUTTON)) return n; return null; };
  function dress(line) {
    let b = own(line);
    const fresh = !b;
    if (!b) { b = button(line.ownerDocument); line.append(b); }
    else if (line.lastElementChild !== b) line.append(b);
    if (!line.classList.contains(LINE)) line.classList.add(LINE);
    if (fresh) level(line, b);
    return b;
  }
  /** The × sits level with the line's first row of words, whatever the line's own padding and line height. */
  function level(line, b) {
    const view = line.ownerDocument.defaultView;
    if (!view || typeof view.getComputedStyle !== "function") return;
    const s = view.getComputedStyle(line), size = parseFloat(s.fontSize) || 13, row = parseFloat(s.lineHeight) || size * 1.45, pad = parseFloat(s.paddingTop) || 0;
    if (Number.isFinite(row) && Number.isFinite(pad)) b.style.top = `${Math.round(pad + (row - 26) / 2)}px`;
  }
  function undress(line) { own(line)?.remove(); line.classList.remove(LINE); }

  /** One line a page made by hand gets its ×. Closing hides it (it stays in the page, out of sight and out of the
   *  reading order) and tells the page. */
  function add(line, { focus = null, onDismiss = null, scope = null } = {}) {
    if (!line || line.nodeType !== 1) return null;
    const b = dress(line);
    b.addEventListener("click", (event) => {
      event.preventDefault(); event.stopPropagation();
      line.setAttribute(GONE, "");
      moveFocus(line, focus, scope);
      onDismiss?.(line);
    });
    return b;
  }

  /** Every line of `root` that matches one of `lines`, now and after each change. */
  function watch({ root: scope = root.document, lines = [], focus = null } = {}) {
    const doc = scope.ownerDocument || scope, view = doc.defaultView || root;
    const rules = lines.map((l) => (typeof l === "string" ? { sel: l } : l)).filter((l) => l && l.sel);
    const closed = new Set();
    const ruleOf = new WeakMap(), mine = new Set();
    let observer = null, busy = false;
    function pass() {
      if (busy) return;
      busy = true;
      const present = new Set(), seen = new Set();
      for (const rule of rules) {
        let found = [];
        try { found = scope.querySelectorAll(rule.sel); } catch { found = []; }
        for (const line of found) {
          if (rule.when && !rule.when(line)) continue;
          seen.add(line); mine.add(line);
          const words = line.hidden ? "" : wordsOf(line);
          if (!words) {                                            // nothing said: nothing to close, nothing kept closed
            if (line.hasAttribute(GONE)) line.removeAttribute(GONE);
            if (own(line)) undress(line);
            continue;
          }
          ruleOf.set(line, rule);
          present.add(words);
          if (closed.has(words)) { if (!line.hasAttribute(GONE)) line.setAttribute(GONE, ""); continue; }
          if (line.hasAttribute(GONE)) line.removeAttribute(GONE);
          dress(line);
        }
      }
      // A line that is no longer one of these (its kind changed, the page left it out) is as the page made it again.
      for (const line of [...mine]) if (!seen.has(line)) { mine.delete(line); ruleOf.delete(line); if (line.isConnected) { line.removeAttribute(GONE); undress(line); } }
      for (const words of [...closed]) if (!present.has(words)) closed.delete(words);   // it went away: the next one shows
      observer?.takeRecords();
      busy = false;
    }
    function click(event) {
      const b = event.target?.closest?.(`.${BUTTON}`), line = b?.parentElement, rule = line && ruleOf.get(line);
      if (!rule || own(line) !== b) return;
      event.preventDefault(); event.stopPropagation();
      closed.add(wordsOf(line));
      line.setAttribute(GONE, "");
      observer?.takeRecords();
      moveFocus(line, rule.focus || focus, scope);
      rule.onDismiss?.(line);
      pass();
    }
    scope.addEventListener("click", click, true);     // before the page's own: a line inside a card that is one button
    if (typeof view.MutationObserver === "function") {
      observer = new view.MutationObserver(pass);
      observer.observe(scope, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class", "data-kind"] });
    }
    pass();
    return { refresh: pass, closed, dispose() { observer?.disconnect(); scope.removeEventListener("click", click, true); } };
  }

  root.DgcDismiss = { html, button, add, watch, focusAfter, TITLE, NAME, GONE, LINE, BUTTON };
})(typeof window !== "undefined" ? window : globalThis);
