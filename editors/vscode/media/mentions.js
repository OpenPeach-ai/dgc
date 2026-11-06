// window.DgcMentions: the inline marks of a prompt box -- @plugins, @Outputs, @Pips, @files and / commands -- and the
// box that holds them, one implementation for Work's box (media/main.js), ChatDGC's (media/chatdgc.js) and a Pip chat's
// (src/pipsClient.js). The marks are words in a sentence: what the model reads is the pill's wire text, what a copy
// reads is the token that made it, and what a reload redraws is a short list of display-only positions.
//
// Two measured facts drive the text half of this file:
//
//   * Chromium does NOT insert "\n" for a newline. It wraps the following content in a block:
//     typing a, Enter, b gives `a<div>b</div>`, whose textContent is "ab". Reading textContent
//     would silently JOIN every line the user typed.
//   * After an edit it leaves a trailing filler <br> in an otherwise empty host, so the DOM
//     looking non-empty says nothing about whether there is a draft.
//
// walk() is the single definition of the text, and rangeAt() is its exact inverse. Everything -- the wire, drafts, the
// pickers' arithmetic, the empty check -- comes from here, so they cannot disagree with each other.
(function () {
  if (globalThis.DgcMentions) return;

  const BLOCK = new Set(["DIV", "P", "LI", "TR", "SECTION", "ARTICLE", "BLOCKQUOTE", "PRE"]);
  const PIP_TYPES = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"];
  const MARK_KINDS = ["plugin", "artifact", "pip", "skill", "template", "file", "command"];
  // What a selected attachment contributes to the prompt's text: nothing, unless it says otherwise (`wired`).
  const ZERO_WIDTH = new Set(["pip", "skill", "template", "file"]);
  // The character that stands for a pill while a selection is split into its words and pills.
  const PILL_MARK = "";

  function walk(root, stopNode, stopOffset, pillText = (pill) => pill.dataset.pill) {
    // Returns [text, offsetAtStop]. A null stopNode just serializes the whole subtree. `pillText`
    // is what a pill reads as: its wire text for the model, its typed token for the clipboard.
    let text = "";
    let found = stopNode == null ? 0 : -1;
    let endedByBr = false;   // a real <br> ended the last line, as opposed to a block boundary
    const visit = (node) => {
      if (node.nodeType === 3) {
        if (stopNode === node && found < 0) found = text.length + Math.min(stopOffset, node.data.length);
        text += node.data;
        if (node.data) endedByBr = false;
        return;
      }
      if (node.nodeType !== 1) {
        if (stopNode === node && found < 0) found = text.length;
        return;
      }
      // A <br> and a pill are atomic: an offset into one only says which side of it the caret is
      // on. Everything else takes its offset from the child index, below. This used to be one
      // blanket "found = text.length" on entry, which pinned every element-anchored caret to the
      // position BEFORE that element's contents and left the child-index checks unreachable --
      // and an element anchor with a non-zero offset is exactly what Chromium hands back after an
      // uneditable pill, so the caret read as sitting in front of the pill it was placed after.
      const atomic = node.tagName === "BR" || (node.hasAttribute && node.hasAttribute("data-pill"));
      if (atomic) {
        const before = text.length;
        // Chromium ends every block with a <br> so the block's last line can hold a caret. That
        // line is already represented by the boundary the block opened with, so charging for both
        // made one Shift+Enter serialize as "\n\n" and a visually empty box serialize as "\n" --
        // which kept the placeholder off and made the three draft guards call an empty composer
        // non-empty, so "Restore message to draft" answered "Send or clear the current draft
        // first." against a box that was empty on screen.
        const filler = node.tagName === "BR" && node === node.parentNode.lastChild;
        if (!filler) {
          text += node.tagName === "BR" ? "\n" : pillText(node);
          endedByBr = node.tagName === "BR";
        }
        if (stopNode === node && found < 0) found = stopOffset > 0 ? text.length : before;
        return;
      }
      const block = BLOCK.has(node.tagName) && node !== root;
      // A block starts a new line unless nothing has been written yet, or unless a <br> just ended
      // one: in the flat text<br>text shape setComposerValue builds, the <br> IS the break and a
      // following block must not add a second. Between two BLOCKS it must, because the empty line
      // Shift+Enter leaves behind is the boundary itself -- its filler <br> contributed nothing
      // just above. Asking only whether the text already ended in a newline could not tell those
      // two apart, and collapsed every blank line in the draft.
      if (block && text && !endedByBr) text += "\n";
      endedByBr = false;
      const kids = [...node.childNodes];
      kids.forEach((kid, i) => {
        if (stopNode === node && i === stopOffset && found < 0) found = text.length;
        visit(kid);
      });
      if (stopNode === node && stopOffset >= kids.length && found < 0) found = text.length;
    };
    visit(root);
    if (found < 0) found = text.length;
    // (The filler <br> is dropped where it is visited, above. Trimming a trailing newline here as
    // well would eat the block boundary a real last line stands on.)
    return [text, Math.min(found, text.length)];
  }

  function rangeAt(root, target) {
    // The inverse of walk(): the DOM position whose serialized offset is `target`.
    // This and walk() must count identically. walk() opened a block's line only when the text did
    // not already end in a newline; this charged for every block while seen < target -- two
    // different rules. Blink turns Shift+Enter and any multi-line paste into paragraph separators,
    // so one blank line anywhere in the draft put the two out of step, and insertComposerPill --
    // which, unlike editComposer, has no verification step and no fallback -- spliced the pill a
    // character early into the text that was actually sent.
    let seen = 0, hit = null, endedByBr = false;
    const visit = (node) => {
      if (hit) return;
      if (node.nodeType === 3) {
        if (seen + node.data.length >= target) { hit = [node, target - seen]; return; }
        seen += node.data.length;
        if (node.data) endedByBr = false;
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.tagName === "BR") {
        if (node === node.parentNode.lastChild) return;   // the block's filler, as in walk()
        if (seen >= target) { hit = [node.parentNode, [...node.parentNode.childNodes].indexOf(node)]; return; }
        seen += 1; endedByBr = true;
        return;
      }
      if (node.hasAttribute && node.hasAttribute("data-pill")) {
        const len = node.dataset.pill.length;
        if (seen + len >= target) {
          const parent = node.parentNode;
          hit = [parent, [...parent.childNodes].indexOf(node) + (target > seen ? 1 : 0)];
          return;
        }
        seen += len;
        if (len) endedByBr = false;
        return;
      }
      if (BLOCK.has(node.tagName) && node !== root && seen && !endedByBr) {
        // The newline this block contributes sits AT offset `seen`, so a target of exactly `seen`
        // is the position in front of it -- the end of the line above, which is the position just
        // before this block in its parent. Answering [node, 0] put it after the newline instead,
        // one offset further on than walk() reads that same position back as.
        if (seen >= target) {
          const parent = node.parentNode;
          hit = [parent, [...parent.childNodes].indexOf(node)];
          return;
        }
        seen += 1;
      }
      endedByBr = false;
      [...node.childNodes].forEach(visit);
    };
    visit(root);
    if (hit) return hit;
    return [root, root.childNodes.length];
  }

  // The selection a box's nodes are in. In a shadow root (a Pip's chat in the side bar) the window's selection is
  // retargeted to the shadow's host, so the root's own is the one that can say where the caret is.
  function selectionOf(el) {
    const host = el.getRootNode ? el.getRootNode() : null;
    if (host && host.nodeType === 11 && typeof host.getSelection === "function") {
      const inside = host.getSelection();
      if (inside) return inside;
    }
    return (el.ownerDocument?.defaultView || window).getSelection();
  }

  function setRange(root, start, end = start) {
    const sel = selectionOf(root);
    if (!sel) return;
    const range = root.ownerDocument.createRange();
    const [sn, so] = rangeAt(root, Math.max(0, start));
    const [en, eo] = rangeAt(root, Math.max(0, end));
    try {
      range.setStart(sn, so);
      range.setEnd(en, eo);
    } catch { range.selectNodeContents(root); range.collapse(false); }
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function selectedOffsets(root) {
    const sel = selectionOf(root);
    const end = () => walk(root, null, 0)[0].length;
    if (!sel || sel.rangeCount === 0) return [end(), end()];
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer)) return [end(), end()];
    const a = walk(root, range.startContainer, range.startOffset)[1];
    const b = walk(root, range.endContainer, range.endOffset)[1];
    return a <= b ? [a, b] : [b, a];
  }

  // One text node per line, separated by <br>. Never innerHTML: the string may be a draft that came back from storage,
  // or a pasted payload, and neither may bring markup into the host.
  function textFragment(doc, text) {
    const frag = doc.createDocumentFragment();
    const lines = String(text ?? "").split("\n");
    lines.forEach((line, i) => {
      if (i) frag.appendChild(doc.createElement("br"));
      if (line) frag.appendChild(doc.createTextNode(line));
    });
    // A TRAILING newline takes TWO <br>, which is what Chromium itself emits: the second is the
    // filler that lets the new empty line hold a caret, and walk() drops a <br> that is its
    // parent's lastChild for exactly that reason. Writing one made the separator and the filler the
    // same node, so the reader could not tell "ends in a newline" from "ends in a line" -- a draft
    // finished with Shift+Enter lost one newline on every save and restore, silently, accumulating
    // across chat switches. This is the writer's half of walk()'s contract: setComposerValue(t)
    // followed by composerText() is t, for every t.
    if (lines.length > 1 && lines[lines.length - 1] === "") frag.appendChild(doc.createElement("br"));
    return frag;
  }

  // The DOM write insertText would have made, for where Chromium refuses to run it: the selection's
  // contents out, the text in as text and <br>, the caret after it. Pills outside the selection are
  // left exactly where they are.
  function spliceText(root, text) {
    const sel = selectionOf(root);
    if (!sel || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return false;
    range.deleteContents();
    const doc = root.ownerDocument;
    const frag = doc.createDocumentFragment();
    String(text).split("\n").forEach((line, i) => {
      if (i) frag.appendChild(doc.createElement("br"));
      if (line) frag.appendChild(doc.createTextNode(line));
    });
    const last = frag.lastChild;
    if (!last) return true;
    range.insertNode(frag);
    // A <br> that ends its line is the line's filler and reads as nothing, so a text that ends in a
    // newline needs a second one -- the rule setComposerValue writes by.
    if (last.nodeName === "BR" && !last.nextSibling) last.after(doc.createElement("br"));
    range.setStartAfter(last);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  /** The clipboard's text, from whichever flavour carries it.
   *
   *  Some applications put ONLY `text/html` on the clipboard. A box prevents the default action on
   *  every paste -- it has to, an editing host would otherwise take the markup -- so a missing
   *  `text/plain` used to mean the paste vanished with no message at all. The HTML is never
   *  inserted; it is parsed, and only its TEXT is taken, with a newline wherever the markup put a
   *  block boundary or a <br>, so a list pasted from a rich-text app keeps the shape it was copied
   *  with instead of running into one line. */
  function clipboardText(data) {
    const plain = data ? String(data.getData("text/plain") || "") : "";
    if (plain || !data) return plain;
    const html = String(data.getData("text/html") || "");
    if (!html) return "";
    let parsed;
    try { parsed = new DOMParser().parseFromString(html, "text/html"); } catch { return ""; }
    const BLOCKS = new Set(["P", "DIV", "LI", "TR", "BR", "H1", "H2", "H3", "H4", "H5", "H6",
                            "BLOCKQUOTE", "PRE", "SECTION", "ARTICLE", "UL", "OL", "TABLE", "HR"]);
    let out = "";
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { out += child.nodeValue.replace(/\s+/g, " "); continue; }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName;
        if (tag === "SCRIPT" || tag === "STYLE") continue;
        if (tag === "BR") { out += "\n"; continue; }
        const block = BLOCKS.has(tag);
        if (block && out && !out.endsWith("\n")) out += "\n";
        visit(child);
        if (block && out && !out.endsWith("\n")) out += "\n";
      }
    };
    visit(parsed.body || parsed);
    return out.replace(/\n{3,}/g, "\n\n").trim();
  }

  // ---- the marks ----------------------------------------------------------------------------
  // `data-pill` is the pill's WIRE text. The attribute's PRESENCE marks a pill; its value is what the model reads. A
  // skill's is deliberately the empty string: the payload travels in `skills`, never in prompt.text. contenteditable=false
  // makes it one object to the caret, so the browser steps over it and selects it whole.
  function ensureFaceStyles(doc) {
    const plush = globalThis.PipConcepts?.plush;
    if (plush?.styles && !doc.getElementById("dgc-composer-plush-styles")) {
      const style = doc.createElement("style");
      style.id = "dgc-composer-plush-styles";
      style.textContent = plush.styles;
      doc.head.appendChild(style);
    }
  }

  /** A pill's element. `opts`: doc; pipType, faceId and faceStyles (false where the page's own root holds the plush
   *  styles: a shadow root's document head doesn't reach it) for a Pip; logo and plug (the mark's markup with no logo)
   *  for a plugin; glyph for an Output (the codicon its row in the Output menu has). */
  function pill(kind, label, wire = "", identity = "", opts = {}) {
    const doc = opts.doc || document;
    const node = doc.createElement("span");
    node.className = `composer-pill pill-${kind}`;
    node.setAttribute("contenteditable", "false");
    node.setAttribute("data-pill", wire);
    node.dataset.kind = kind;
    if (kind === "pip") {
      node.dataset.pipId = identity;
      const type = opts.pipType || "";
      if (type) node.dataset.pipType = type;
      const index = PIP_TYPES.indexOf(type);
      const face = doc.createElement("span"); face.className = "composer-pip-face"; face.setAttribute("aria-hidden", "true");
      if (index >= 0 && globalThis.PipConcepts?.plush) {
        if (opts.faceStyles !== false) ensureFaceStyles(doc);
        face.innerHTML = globalThis.PipConcepts.plush.markup(
          { index, name: label }, "idle", opts.faceId || `composerPip${Math.random().toString(36).slice(2, 12)}`,
          { includeStyles: false });
      }
      else face.innerHTML = opts.plug || '<span class="codicon codicon-hubot"></span>';
      const name = doc.createElement("span"); name.className = "composer-pip-name"; name.textContent = label;
      node.append(face, name);
      node.title = `${label} · Pip reference`;
      return node;
    }
    if (kind === "plugin") {
      node.dataset.pluginId = identity;
      const mark = doc.createElement("span"); mark.className = "composer-plugin-mark"; mark.setAttribute("aria-hidden", "true");
      mark.dataset.pluginMark = identity;
      if (opts.logo) { const img = doc.createElement("img"); img.alt = ""; img.src = opts.logo; mark.appendChild(img); }
      else mark.innerHTML = opts.plug || '<span class="codicon codicon-plug"></span>';
      const name = doc.createElement("span"); name.className = "composer-plugin-name"; name.textContent = label;
      node.append(mark, name);
      node.title = `${label} · connected plugin`;
      return node;
    }
    if (kind === "artifact") {
      node.dataset.artifactKind = identity;
      const mark = doc.createElement("span"); mark.className = `composer-artifact-mark codicon codicon-${opts.glyph || "output"}`;
      mark.setAttribute("aria-hidden", "true");
      const name = doc.createElement("span"); name.className = "composer-artifact-name"; name.textContent = label;
      node.append(mark, name);
      node.title = `${label} · Artifact format`;
      return node;
    }
    if (kind === "link") {
      // NO FAVICON HERE, and that is the whole point. Setting img.src fetches from Google's icon
      // service the instant the element is built -- on a DETACHED node, before insertComposerPill
      // has even tried to splice it in, so it fired on the path where the insertion throws and no
      // pill ever renders. That moved the disclosure boundary from "when you send" to "when you
      // paste": paste an internal wiki or Jira URL, think better of it, delete the pill, never
      // send, and the host has already left the machine. The transcript's trade is that Google
      // learns the hosts you SENT; this would have covered hosts you merely considered, which is
      // not the same trade. Nothing is lost after send: promptFavicon draws the site's own icon on
      // the prompt bubble, which is where it was drawn before pills existed, and dgc.linkFavicons
      // still governs that. The pill carries the host as text, which is what a reader needs.
      let shown = label;
      try { const u = new URL(label); shown = u.host + (u.pathname === "/" ? "" : u.pathname); }
      catch { /* keep the raw text if it will not parse */ }
      node.appendChild(doc.createTextNode(shown.length > 48 ? shown.slice(0, 47) + "…" : shown));
      node.title = label;
      return node;
    }
    node.textContent = label;
    return node;
  }

  function pillLabel(node) {
    // Plush faces can include a scoped <style>. textContent on the whole Pip pill copies that CSS.
    return node.dataset.kind === "pip" ? node.querySelector(".composer-pip-name")?.textContent || node.lastChild?.textContent || "" : node.textContent;
  }
  // What a pill reads as on the clipboard: the token that made it, or for a link the URL itself.
  function pillToken(node) {
    const kind = node.dataset.kind, name = pillLabel(node);
    if (kind === "link") return node.dataset.pill || node.title || name;
    return (kind === "skill" ? "$" : ["file", "pip", "plugin", "artifact"].includes(kind) ? "@" : "/") + name;
  }

  // The box's words and pills in order: a string for words, {kind, label, wire, identity} for a pill. null with no pills.
  function parts(root) {
    const pills = [...root.querySelectorAll("[data-pill]")];
    if (!pills.length) return null;
    const whole = walk(root, null, 0)[0];
    const marker = [...Array(32)].map((_, i) => String.fromCharCode(0xe000 + i)).find((c) => !whole.includes(c));
    if (!marker) return null;
    const marked = walk(root, null, 0, () => marker)[0].split(marker);
    if (marked.length !== pills.length + 1) return null;
    const out = [];
    marked.forEach((words, i) => {
      if (words) out.push(words);
      if (i < pills.length) {
        const node = pills[i], kind = node.dataset.kind;
        const label = kind === "link" ? node.title : node.lastChild?.textContent || "";
        const identity = kind === "pip" ? node.dataset.pipId
          : kind === "plugin" ? node.dataset.pluginId : kind === "artifact" ? node.dataset.artifactKind : node.dataset.identity;
        const part = { kind, label, wire: node.dataset.pill || "", identity: identity || "" };
        if (node.dataset.pipType) part.pipType = node.dataset.pipType;
        out.push(part);
      }
    });
    return out;
  }

  const lengthOf = (text) => Array.from(text).length;

  /** The display-only positions of a prompt's marks, in characters of `text` (the prompt as it is sent). None when the
   *  parts don't spell that text: the model's words never bend to fit a mark. */
  function displayMarks(list, text, { rich = true, pipType = (part) => part.pipType } = {}) {
    if (!list || list.length > 49) return [];
    const raw = list.map((part) => (typeof part === "string" ? part : part.wire)).join("");
    if (raw !== text && raw.trim() !== text) return [];
    const leading = raw === text ? 0 : lengthOf(raw.slice(0, raw.length - raw.trimStart().length));
    let offset = -leading;
    const marks = [];
    for (const part of list) {
      if (typeof part === "string") { offset += lengthOf(part); continue; }
      if (["plugin", "artifact", "pip"].includes(part.kind)
          || (rich && ["skill", "template", "file", "command"].includes(part.kind) && part.label.length <= 120)) {
        // A selection that adds no words: a trailing space before one is removed by submit(), so an end-of-prompt
        // mark anchors at the trimmed text's end. One whose name IS the words (a Pip named in ChatDGC) says so.
        const zero = ZERO_WIDTH.has(part.kind);
        const wired = zero && part.wire !== "";
        const entry = { start: zero && !wired ? Math.min(offset, lengthOf(text)) : offset,
          kind: part.kind, label: part.label, identity: part.kind === "file" ? "file" : part.identity || part.kind };
        if (part.kind === "pip") {
          const type = pipType(part);
          if (type) entry.pip_type = type;
        }
        if (wired) entry.wired = true;
        marks.push(entry);
      }
      offset += lengthOf(part.wire);
    }
    return marks.length <= 24 && marks.every((m) => m.start >= 0) ? marks : [];
  }

  // How many characters of the text a mark stands on.
  function markWidth(mark) {
    if (ZERO_WIDTH.has(mark.kind) && mark.wired !== true) return 0;
    return lengthOf(mark.label) + (mark.kind === "command" ? 1 : 0);
  }
  function markSpelled(mark, chars, start, end) {
    return end === start || chars.slice(start, end).join("") === (mark.kind === "command" ? "/" + mark.label : mark.label);
  }
  function usableMark(mark) {
    const { start, kind, label, identity, pip_type: pipType, wired } = mark || {};
    return Number.isInteger(start) && MARK_KINDS.includes(kind) && typeof label === "string" && typeof identity === "string"
      && (kind !== "pip" || PIP_TYPES.includes(pipType)) && (wired === undefined || (wired === true && ZERO_WIDTH.has(kind)));
  }
  /** Whether every saved position still fits this text. A malformed mark must leave the plain words on screen. */
  function validMarks(body, marks) {
    if (!Array.isArray(marks) || marks.length > 24) return false;
    const chars = Array.from(body);
    let at = 0;
    for (const mark of marks) {
      if (!usableMark(mark) || mark.start < at || mark.start > chars.length) return false;
      const end = mark.start + markWidth(mark);
      if (end > chars.length || !markSpelled(mark, chars, mark.start, end)) return false;
      at = end;
    }
    return true;
  }

  /** A sent prompt with its marks where they were. `words(text)`: the node holding plain words, whose children are
   *  taken (Work's makes URLs links); `pillFor(mark)`: the options of its pill; `decorate(pill, mark)`: anything the
   *  surface adds. Null when the marks don't fit: the caller draws the plain text. */
  function sentNode(body, marks, { doc = document, hostClass = "prompt-text", words, pillFor = () => ({}), decorate = () => {} } = {}) {
    if (!validMarks(body, marks) || !marks.length) return null;
    const chars = Array.from(body), host = doc.createElement("div");
    host.className = hostClass;
    const plain = words || ((text) => { const box = doc.createElement("div"); box.textContent = text; return box; });
    let at = 0;
    for (const mark of marks) {
      const end = mark.start + markWidth(mark);
      host.append(...plain(chars.slice(at, mark.start).join("")).childNodes);
      const node = pill(mark.kind, mark.label, "", mark.identity, { doc, pipType: mark.pip_type, ...pillFor(mark) });
      if (mark.kind === "command") node.textContent = "/" + mark.label;
      node.classList.add("sent-mention");
      node.removeAttribute("contenteditable");
      node.removeAttribute("data-pill");
      decorate(node, mark);
      host.appendChild(node);
      at = end;
    }
    host.append(...plain(chars.slice(at).join("")).childNodes);
    return host;
  }

  // ---- the box's edits -----------------------------------------------------------------------
  /** Put a built pill at the selection. Through execCommand still, because insertHTML is what puts the caret, the
   *  selection and the surrounding text right. */
  function placePill(root, built) {
    const doc = root.ownerDocument;
    // Tag it so the caret repair below can find exactly the node just inserted, rather than
    // guessing at "the last pill" -- there may already be others, in any order.
    const stamp = `p${Math.random().toString(36).slice(2, 10)}`;
    built.dataset.fresh = stamp;
    try {
      const ok = typeof doc.execCommand === "function"
        && doc.execCommand("insertHTML", false, built.outerHTML);
      if (!ok) {
        const range = selectionOf(root)?.getRangeAt(0);
        if (range) {
          range.deleteContents();
          range.insertNode(built);
          range.collapse(false);
        }
      }
    } catch { /* leave the draft as it was rather than half-edit it */ }
    // THE CARET REPAIR, and why it is not optional. An inline contenteditable=false span has no
    // editable position after it, so Blink collapses the caret to the END OF THE PRECEDING TEXT
    // NODE -- before the pill, not after. Everything typed next goes in front of it: measured in
    // Chromium, "Review $fix" + Tab + " the diff" produced "Review  the diff[fixture]", the pill
    // having migrated to the end of the message. Two pills came out reversed, Backspace looked on
    // the wrong side and could never remove one, and a link pill's URL -- whose wire text is the
    // URL itself -- landed in the wrong place in what the model was sent.
    //
    // jsdom never showed any of this: it has no execCommand, so every test took the fallback
    // above, whose range.collapse(false) puts the caret after the pill. The tests exercised the
    // branch that does not ship.
    const fresh = root.querySelector(`[data-fresh="${stamp}"]`);
    if (fresh) {
      delete fresh.dataset.fresh;
      // Give the caret somewhere to be. Without a following text node there is no editable
      // position after an inline uneditable element at the end of the host.
      let after = fresh.nextSibling;
      if (!after || after.nodeType !== 3) {
        after = doc.createTextNode("");
        fresh.parentNode.insertBefore(after, fresh.nextSibling);
      }
      const sel = selectionOf(root);
      if (sel) {
        const range = doc.createRange();
        range.setStart(after, 0);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    return fresh;
  }

  // Backspace against a pill removes the whole thing. Without this the browser walks into it and
  // deletes one character of a label that is not text the user typed.
  function pillAgainstCaret(root, key) {
    const sel = selectionOf(root);
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer)) return null;
    const back = key === "Backspace";
    if (range.startContainer.nodeType === 1) {
      const kids = range.startContainer.childNodes;
      const at = back ? range.startOffset - 1 : range.startOffset;
      const node = kids[at];
      if (node && node.nodeType === 1 && node.hasAttribute("data-pill")) return node;
    } else if (back && range.startOffset === 0) {
      const prev = range.startContainer.previousSibling;
      if (prev && prev.nodeType === 1 && prev.hasAttribute("data-pill")) return prev;
    }
    return null;
  }

  // The selection out of the box, by the editing command where Chromium runs it and by hand where it
  // will not (inside a cut, which VS Code delivers as execCommand("cut")).
  function deleteSelection(root) {
    const doc = root.ownerDocument;
    if (typeof doc.execCommand === "function" && doc.execCommand("delete", false)) return;
    const sel = selectionOf(root);
    if (sel && sel.rangeCount && root.contains(sel.getRangeAt(0).commonAncestorContainer)) sel.getRangeAt(0).deleteContents();
  }

  /** A copy out of a box: the clipboard gets words and tokens, never a pill's label (a truncated host for a link) or
   *  its markup; the plush face's stylesheet once landed in someone's clipboard. Returns null with nothing selected,
   *  else {text, parts}: `parts` is how the same copy pastes back as pills (`extras(pill)`: what a pill's selection
   *  needs). */
  function copySelection(root, event, extras = () => ({})) {
    const sel = selectionOf(root);
    if (!sel || !sel.rangeCount || sel.isCollapsed || !event.clipboardData) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const holder = root.ownerDocument.createElement("div");
    holder.appendChild(range.cloneContents());
    const text = walk(holder, null, 0, pillToken)[0];
    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
    const pills = [];
    const marked = walk(holder, null, 0, (node) => { pills.push(node); return PILL_MARK; })[0];
    if (!pills.length || text.includes(PILL_MARK)) return { text, parts: null };
    const list = [];
    marked.split(PILL_MARK).forEach((piece, i) => {
      if (i) {
        const node = pills[i - 1], kind = node.dataset.kind, label = node.title && kind === "link" ? node.title : pillLabel(node);
        list.push({ kind, label, wire: node.dataset.pill || "", token: pillToken(node),
          identity: kind === "plugin" ? node.dataset.pluginId : kind === "artifact" ? node.dataset.artifactKind : kind === "pip" ? node.dataset.pipId : node.dataset.identity || "",
          ...(node.dataset.pipType ? { pipType: node.dataset.pipType } : {}),
          ...extras(node) });
      }
      if (piece) list.push(piece);
    });
    return { text, parts: list };
  }

  function nodePath(root, node) {
    const path = [];
    for (; node && node !== root; node = node.parentNode) {
      if (!node.parentNode) return null;
      path.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node));
    }
    return node === root ? path : null;
  }
  function nodeAtPath(root, path) {
    let node = root;
    for (const index of path || []) node = node ? node.childNodes[index] : null;
    return node || null;
  }
  // A step of a box's history: its nodes, pills and all, and the caret as a DOM position, not a text offset. A skill
  // pill reads as "", so the offsets on either side of it are the same number, and a caret restored by offset lands in
  // FRONT of the pill it was after -- and the next word typed goes there too.
  function capture(root) {
    let caret = null;
    const sel = selectionOf(root);
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0), start = nodePath(root, r.startContainer), end = nodePath(root, r.endContainer);
      if (start && end) caret = { start, startOffset: r.startOffset, end, endOffset: r.endOffset };
    }
    return { nodes: [...root.childNodes].map((node) => node.cloneNode(true)), markup: root.innerHTML, caret, at: selectedOffsets(root) };
  }
  function restore(root, state) {
    root.replaceChildren(...state.nodes.map((node) => node.cloneNode(true)));
    restoreCaret(root, state);
  }
  function restoreCaret(root, state) {
    root.focus({ preventScroll: true });
    const sel = selectionOf(root), c = state.caret;
    const start = c && nodeAtPath(root, c.start), end = c && nodeAtPath(root, c.end);
    const room = (node) => (node.nodeType === 3 ? node.data.length : node.childNodes.length);
    try {
      if (!sel || !start || !end) throw new Error("no caret");
      const range = root.ownerDocument.createRange();
      range.setStart(start, Math.min(c.startOffset, room(start)));
      range.setEnd(end, Math.min(c.endOffset, room(end)));
      sel.removeAllRanges(); sel.addRange(range);
    } catch { setRange(root, state.at[0], state.at[1]); }
  }

  // ---- a rich box for a page that had a <textarea> ---------------------------------------------
  /** Make `el` (a contenteditable) answer as the <textarea> its page was written against: value, selectionStart/End,
   *  setSelectionRange, setRangeText, select, disabled, readOnly, placeholder, maxLength. The trap this guards is the
   *  one main.js documents: assigning `.value` to a div doesn't fail, it creates an expando, and everything reading it
   *  stays green against a box that renders nothing.
   *
   *  opts: edit(change) wraps an edit in the page's undo history; pillOptions(part) gives a pill's look (its logo, its
   *  face's type); pasteBack(part) says whether a copied pill can be a pill again here, and does what it stands for;
   *  removed() runs after pills went, so the page can drop what they stood for. */
  function box(el, opts = {}) {
    const doc = el.ownerDocument, view = doc.defaultView || window;
    let editing = false, copied = null, disabled = false, readOnly = false, maxLength = opts.maxLength || 0;
    const edit = (change) => (opts.edit ? opts.edit(change) : change());
    const text = () => walk(el, null, 0)[0];
    const announce = () => el.dispatchEvent(new (view.Event || Event)("input", { bubbles: true, composed: true }));
    // Our own edits fire the browser's input events as they go; the page hears of each once, when it is whole.
    const quietly = (change) => { const was = editing; editing = true; try { return change(); } finally { editing = was; } };
    el.addEventListener("input", (event) => { if (editing) event.stopImmediatePropagation(); else markEmpty(); }, true);

    function markEmpty() {
      el.classList.toggle("is-empty", text() === "" && !el.querySelector("[data-pill]"));
    }
    // Whether the caret is this box's to move, decided BEFORE the nodes it points at are gone: only with the focus here.
    // A selection set in an editing host takes the focus to it, so a box redrawn in the background (a Pip's, as a reply
    // streams in) would pull it out of whatever else the user was typing in.
    const focused = () => el.getRootNode().activeElement === el;
    function write(value) {
      const ours = focused();
      el.replaceChildren(textFragment(doc, value));
      // Assigning a textarea's value leaves the caret at the end of the new text, and every caller here was written
      // against that.
      if (ours) setRange(el, text().length);
      markEmpty();
    }
    function insertText(value) {
      // What the box must hold afterwards, computed BEFORE the insert so it can be checked.
      const [start, end] = selectedOffsets(el);
      const whole = text();
      const want = whole.slice(0, start) + value + whole.slice(end);
      el.focus({ preventScroll: true });
      setRange(el, start, end);
      // Guarded: where execCommand does not exist, CALLING it throws rather than returning falsy. Chromium will not
      // run an editing command from inside another one, and VS Code hands a page every paste as one, so the text then
      // goes in at the selection by hand. Verified, because what `insertText` does with consecutive newlines is the
      // host's business: where the native path isn't faithful, the exact text is put in by hand.
      const native = typeof doc.execCommand === "function";
      const inserted = native && quietly(() => doc.execCommand("insertText", false, value));
      if (native && !inserted) spliceText(el, value);
      if (text() !== want) { write(want); setRange(el, start + value.length); }
      markEmpty();
    }
    function replace(start, end, value) {
      const length = text().length;
      start = Math.max(0, Math.min(start, length));
      end = Math.max(start, Math.min(end, length));
      if (start === end && !value) return;
      setRange(el, start, end);
      if (value) insertText(value);
      else { quietly(() => deleteSelection(el)); markEmpty(); }
    }
    function pillOf(part) {
      return pill(part.kind, part.label, part.wire, part.identity, { doc, faceStyles: opts.faceStyles, pipType: part.pipType, ...(opts.pillOptions ? opts.pillOptions(part) : {}) });
    }
    /** A picked mark, in place of [start, end]: one edit. A null start puts it at the caret as it stands. */
    function insertPill(start, end, part) {
      el.focus({ preventScroll: true });
      if (start != null) setRange(el, start, end);
      const built = pillOf(part);
      if (part.identity && !["pip", "plugin", "artifact"].includes(part.kind)) built.dataset.identity = part.identity;
      quietly(() => placePill(el, built));
      markEmpty();
    }
    function writeParts(list) {
      const frag = doc.createDocumentFragment();
      for (const part of list) {
        if (typeof part === "string") frag.appendChild(textFragment(doc, part));
        else {
          const built = pillOf(part);
          if (part.identity && !["pip", "plugin", "artifact"].includes(part.kind)) built.dataset.identity = part.identity;
          frag.appendChild(built);
        }
      }
      // A caret needs a text node after a pill at the end of the host.
      if (frag.lastChild?.nodeType === 1 && frag.lastChild.hasAttribute("data-pill")) frag.appendChild(doc.createTextNode(""));
      const ours = focused();
      el.replaceChildren(frag);
      if (ours) {
        const sel = selectionOf(el), range = doc.createRange();
        range.selectNodeContents(el); range.collapse(false);
        sel?.removeAllRanges(); sel?.addRange(range);
      }
      markEmpty();
    }

    Object.defineProperty(el, "value", {
      get: text,
      set: (value) => {
        const next = String(value ?? "");
        // The same words keep their pills; "" empties a box of pills that add no words as well.
        if (next === text() && (next !== "" || !el.querySelector("[data-pill]"))) return;
        write(next);
      },
      configurable: true,
    });
    // Writable, because a textarea's are, and clamped as the platform clamps: moving the start past the end drags the
    // end with it, and vice versa.
    Object.defineProperty(el, "selectionStart", {
      get: () => selectedOffsets(el)[0],
      set: (at) => { const end = selectedOffsets(el)[1]; setRange(el, at, Math.max(at, end)); },
      configurable: true,
    });
    Object.defineProperty(el, "selectionEnd", {
      get: () => selectedOffsets(el)[1],
      set: (at) => { const start = selectedOffsets(el)[0]; setRange(el, Math.min(start, at), at); },
      configurable: true,
    });
    el.setSelectionRange = (start, end) => setRange(el, start, end);
    el.select = () => setRange(el, 0, text().length);
    el.setRangeText = (value, start = selectedOffsets(el)[0], end = selectedOffsets(el)[1], mode = "preserve") => {
      replace(start, end, String(value ?? ""));
      if (mode === "end") setRange(el, start + String(value ?? "").length);
      else if (mode === "select") setRange(el, start, start + String(value ?? "").length);
    };
    const held = () => {
      el.setAttribute("contenteditable", disabled || readOnly ? "false" : "true");
      el.toggleAttribute("aria-disabled", disabled);
      if (disabled) el.setAttribute("aria-disabled", "true");
    };
    Object.defineProperty(el, "disabled", { get: () => disabled, set: (on) => { disabled = !!on; held(); }, configurable: true });
    Object.defineProperty(el, "readOnly", { get: () => readOnly, set: (on) => { readOnly = !!on; held(); }, configurable: true });
    Object.defineProperty(el, "placeholder", {
      get: () => el.dataset.placeholder || "",
      set: (words) => {
        if (el.dataset.placeholder === String(words)) return;
        el.dataset.placeholder = String(words);
        el.setAttribute("placeholder", String(words));    // what a textarea's reads as, for anything asking the page
      },
      configurable: true,
    });
    Object.defineProperty(el, "maxLength", { get: () => maxLength, set: (n) => { maxLength = Number(n) || 0; }, configurable: true });

    el.addEventListener("beforeinput", (event) => {
      const type = event.inputType || "";
      // Cmd+B and Cmd+I would bold and italicise in an editing host. The box is plain text.
      if (/^format/.test(type)) { event.preventDefault(); return; }
      if (type === "insertFromDrop" || type === "insertFromYank") {
        // An editing host takes a drop's markup. Only its words come in.
        const words = clipboardText(event.dataTransfer);
        event.preventDefault();
        if (words) { edit(() => { insertText(words); }); announce(); }
        return;
      }
      if (maxLength && !editing && /^insert(Text|CompositionText|ReplacementText)$/.test(type) && typeof event.data === "string") {
        const [start, end] = selectedOffsets(el);
        if (text().length - (end - start) + event.data.length > maxLength && !event.isComposing) event.preventDefault();
      }
    }, true);
    el.addEventListener("keydown", (event) => {
      if (event.key !== "Backspace" && event.key !== "Delete") return;
      const victim = pillAgainstCaret(el, event.key);
      if (!victim) return;
      event.preventDefault();
      edit(() => { victim.remove(); opts.removed?.(); });
      markEmpty();
      announce();
    }, true);
    el.addEventListener("copy", (event) => { const made = copySelection(el, event, opts.pillExtras); if (made) copied = made.parts ? made : null; });
    el.addEventListener("cut", (event) => {
      const made = copySelection(el, event, opts.pillExtras);
      if (!made) return;
      copied = made.parts ? made : null;
      edit(() => { quietly(() => deleteSelection(el)); markEmpty(); opts.removed?.(); });
      announce();
    });
    // After the page's own paste handlers, on the box or on its root: what they leave is words. The page's take files
    // and long text; everything else is prevented here and put in as plain text, because an editing host would take
    // the clipboard's HTML, and a CSP stops <script> but not `<img src="https://tracker/...">` nor
    // `style="position:fixed"` laid over the Send button.
    const onPaste = (event) => {
      if (event.defaultPrevented) return;
      const sel = selectionOf(el);
      if (!sel || !sel.rangeCount || !el.contains(sel.getRangeAt(0).startContainer)) return;
      event.preventDefault();
      if (disabled || readOnly) return;
      const pasted = clipboardText(event.clipboardData);
      if (!pasted) return;
      // A copy or cut out of this box that held pills is pills again here. Nothing is trusted from the clipboard for
      // that -- the pills come from this box's memory of its last copy, and only when the clipboard holds that text.
      if (copied && pasted === copied.text) {
        const list = copied.parts;
        edit(() => {
          const now = selectionOf(el);
          if (now && now.rangeCount && !now.isCollapsed) quietly(() => deleteSelection(el));
          for (const part of list) {
            if (typeof part === "string") { insertText(part); continue; }
            if (opts.pasteBack ? opts.pasteBack(part) : false) insertPill(null, null, part);
            else insertText(part.token);
          }
        });
        announce();
        return;
      }
      const [start, end] = selectedOffsets(el);
      const room = maxLength ? Math.max(0, maxLength - (text().length - (end - start))) : pasted.length;
      const words = pasted.slice(0, room);
      if (!words) return;
      edit(() => { insertText(words); });
      announce();
    };
    view.addEventListener("paste", onPaste);

    markEmpty();
    return el.mentionBox = {
      el, text, insertPill, parts: () => parts(el), writeParts, replace, insertText, markEmpty,
      marks: (sent, options) => displayMarks(parts(el), sent, options),
      capture: () => capture(el), restore: (state) => { restore(el, state); markEmpty(); },
      dispose: () => view.removeEventListener("paste", onPaste),
    };
  }

  // ---- the @ list ------------------------------------------------------------------------------
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // A row's kind as a codicon, where the page has them.
  const rowIconClass = (it) => (it.skill ? "codicon-package"
    : it.template ? "codicon-symbol-snippet" : it.modCommand || it.action === "mods" ? "codicon-extensions" : "codicon-terminal");
  /** A row of the list, the same in every box: an icon for WHAT this is, then the bare name. `face(item, i)`: a Pip's
   *  face; `icon(item)`: the row's mark when it has no face. */
  function rowMarkup(it, i, { esc, face, icon }) {
    const mark = (face && face(it, i)) || icon(it);
    return `<div id="pop-option-${i}" role="option" aria-disabled="${it.disabled === true}" aria-selected="${i === 0}" class="pi${i === 0 ? " sel" : ""}" data-i="${i}"><span class="pi-label">${mark}${esc(String(it.label || "").replace(/^[/$@]/, ""))}</span>${it.kind ? `<span class="pi-kind">${esc(it.kind)}</span>` : ""}${it.detail ? `<span class="pd">${esc(it.detail)}</span>` : ""}</div>`;
  }

  /** The @ list of a box that isn't Work's. `sources()`: what this box can really use, right now -- {plugins: [{id,
   *  name}], outputs: [[value, label, desc, glyph]], pips: [{pip_id, name, pip_type, kind, detail}] or null, pipsLoading,
   *  pipsError, files: [{label, ...}]}; `refresh()`: asks for it again (it answers through update()); `fileRow(file)`
   *  and `pipPart(row)` and `plainFile`: how those become marks; `icon(it)`: a row's own icon markup, `logo(id)`. */
  function picker(field, pop, opts) {
    const el = field.el;
    let items = [], index = 0, start = 0, end = 0, open = false, pipMode = false;
    const hide = () => {
      pipMode = false; items = [];
      pop.style.display = "none"; pop.replaceChildren();
      // Only this list's: a page's other list on the same box (ChatDGC's mods menu) answers for itself.
      if (open) { el.setAttribute("aria-expanded", "false"); el.removeAttribute("aria-activedescendant"); }
      open = false;
    };
    const show = (rows) => {
      items = rows; index = 0;
      if (!rows.length) { const keep = pipMode; hide(); pipMode = keep; return; }
      open = true;
      pop.innerHTML = rows.map((it, i) => rowMarkup(it, i, { esc, face: opts.face, icon: opts.icon })).join("");
      for (const row of pop.querySelectorAll(".pi")) {
        // The box keeps its caret while a row is chosen with the mouse.
        row.addEventListener("mousedown", (event) => event.preventDefault());
        row.addEventListener("click", () => choose(Number(row.dataset.i)));
      }
      pop.style.display = "block";
      el.setAttribute("aria-expanded", "true"); el.setAttribute("aria-activedescendant", "pop-option-0");
      opts.drawn?.(pop);
    };
    const move = (by) => {
      index = (index + by + items.length) % items.length;
      [...pop.children].forEach((row, i) => { const on = i === index; row.className = "pi" + (on ? " sel" : ""); row.setAttribute("aria-selected", String(on)); });
      el.setAttribute("aria-activedescendant", `pop-option-${index}`);
      pop.children[index]?.scrollIntoView?.({ block: "nearest" });
    };
    function pipRows() {
      const { pips, pipsLoading, pipsError, pipsEmpty } = opts.sources();
      const query = pipMode.query || "";
      const rows = (pips || []).filter((p) => !query || `${p.name} ${p.pip_type}`.toLowerCase().includes(query))
        .map((p) => ({ label: p.name.replace(/\s+/g, " "), kind: p.kind || `${p.pip_type} Pip`, detail: p.detail || "", pipRow: p }));
      if (pipsLoading) rows.push({ label: "Loading Pips…", disabled: true });
      else if (pipsError) rows.push({ label: pipsError, disabled: true });
      else if (!rows.length) rows.push({ label: pipsEmpty || "No matching Pips", disabled: true });
      return rows;
    }
    function refresh() {
      if (el.disabled || el.readOnly) return hide();
      const value = el.value, [from, to] = selectedOffsets(el);
      if (from !== to) return hide();
      const token = /(^|\s)(@[^\s]*)$/.exec(value.slice(0, from));
      if (!token) return hide();
      const next = from - token[2].length;
      if (pipMode && next !== start) pipMode = false;
      start = next;
      end = from + (value.slice(from).match(/^[^\s]*/)?.[0].length || 0);
      const query = token[2].slice(1).toLowerCase();
      const source = opts.sources();
      const pipsOffered = source.pips !== undefined;
      if (pipMode) { pipMode = { query: query === "pip" ? "" : query.startsWith("pip:") ? query.slice(4) : query }; return show(pipRows()); }
      if (query === "pip" && pipsOffered) { pipMode = { query: "" }; opts.refresh?.(); return show(pipRows()); }
      opts.refresh?.();
      const rows = [];
      if (pipsOffered && (!query || "pips".includes(query))) rows.push({ label: "Reference a Pip…", kind: "Pips", detail: opts.pipsDetail || "No work starts", pipPicker: true });
      for (const row of source.plugins || []) {
        const label = String(row.name || row.id).trim().slice(0, 80);
        if (label && `${label} ${row.id}`.toLowerCase().includes(query)) rows.push({ label, kind: "Plugin", detail: "Connected", pluginId: row.id });
      }
      for (const [value, label, , glyph] of source.outputs || []) {
        if (value !== "auto" && `${label} ${value}`.toLowerCase().includes(query)) rows.push({ label, kind: "Artifact", detail: `Create ${label.toLowerCase()}`, artifactKind: value, artifactGlyph: glyph });
      }
      rows.push(...(source.files || []).filter((f) => f.label.toLowerCase().includes(query)).slice(0, 30));
      show(rows.slice(0, 40));
    }
    function choose(i) {
      const it = items[i];
      if (!it || it.disabled) return;
      if (it.pipPicker) {
        pipMode = { query: "" };
        opts.edit(() => field.replace(start, end, "@"));
        end = start + 1;
        el.dispatchEvent(new (el.ownerDocument.defaultView?.Event || Event)("input", { bubbles: true, composed: true }));
        opts.refresh?.();
        return;
      }
      const name = String(it.label || "").trim();
      const part = it.pipRow ? opts.pipPart(it.pipRow)
        : it.pluginId ? { kind: "plugin", label: name, wire: name, identity: it.pluginId }
        : it.artifactKind ? { kind: "artifact", label: name, wire: name, identity: it.artifactKind, glyph: it.artifactGlyph }
        : opts.filePart ? opts.filePart(it) : null;
      if (!part) { hide(); return; }
      if (opts.allow && !opts.allow(part)) return;
      const [from, to] = [start, end];
      hide();
      opts.edit(() => { opts.picked?.(part, it); field.insertPill(from, to, part); });
      el.focus({ preventScroll: true });
      el.dispatchEvent(new (el.ownerDocument.defaultView?.Event || Event)("input", { bubbles: true, composed: true }));
    }
    el.addEventListener("input", refresh);
    el.addEventListener("click", refresh);
    el.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229 || !open) return;
      const key = event.key;
      if (key === "ArrowDown" || key === "ArrowUp") { event.preventDefault(); event.stopImmediatePropagation(); move(key === "ArrowDown" ? 1 : -1); }
      else if ((key === "Enter" && !event.shiftKey) || key === "Tab") { event.preventDefault(); event.stopImmediatePropagation(); choose(index); }
      else if (key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); hide(); }
    }, true);
    el.addEventListener("blur", () => { setTimeout(() => { if (!el.matches(":focus")) hide(); }, 0); });
    hide();
    // The sources changed under an open list (a catalog arriving): the list is drawn again where it stands.
    return { refresh: () => { if (open || pipMode) refresh(); }, hide };
  }

  globalThis.DgcMentions = {
    PIP_TYPES, walk, rangeAt, selectionOf, setRange, selectedOffsets, textFragment, spliceText, clipboardText,
    ensureFaceStyles, pill, pillLabel, pillToken, parts, displayMarks, validMarks, sentNode, placePill, pillAgainstCaret,
    deleteSelection, copySelection, capture, restore, restoreCaret, box, esc, rowIconClass, rowMarkup, picker,
  };
})();
