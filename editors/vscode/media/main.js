(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $("log"), input = $("input"), send = $("send"), atts = $("attachments"), pop = $("pop");
  const composerPlaceholder = input.dataset.placeholder;
  let composerLocked = false;
  // What the locked box says, and its Send: an agent's page ("Return to the chat…"), or a session open elsewhere.
  let composerLockWords = "Return to the chat to send a message";

  // ---- the composer's five primitives ----------------------------------------------------
  // Everything that touches the draft goes through these, and nothing else reads `input.value`
  // or its selection directly. Today they are a thin skin over a <textarea>, so this changes no
  // behaviour whatsoever -- that is the point of landing it on its own.
  //
  // They exist because the element is going to become a contenteditable that can hold inline
  // pills, and a textarea's two guarantees do not survive that: `.value` stops being the text,
  // and the selection stops being a pair of integer offsets into it. Thirty-eight value sites and
  // twenty selection sites cannot each be re-reasoned at that moment. They are re-pointed once,
  // here, when the answers are still obvious.
  //
  // The trap this also guards: assigning `.value` to a div does not fail, it creates an expando.
  // A test that drives the panel with `input.value = "..."` would keep passing against a composer
  // that renders nothing at all. When the element changes, these five are reimplemented over the
  // DOM and the accessors are defined in terms of THEM, so a test that goes through `.value`
  // still moves the real composer.
  // The composer is a contenteditable, so "the text" and "the caret" have to be computed rather
  // than read off the element. Two measured facts drive every line of this:
  //
  //   * Chromium does NOT insert "\n" for a newline. It wraps the following content in a block:
  //     typing a, Enter, b gives `a<div>b</div>`, whose textContent is "ab". Reading textContent
  //     would silently JOIN every line the user typed.
  //   * After an edit it leaves a trailing filler <br> in an otherwise empty host, so the DOM
  //     looking non-empty says nothing about whether there is a draft.
  //
  // walk() is the single definition of the text, and offsetOf/rangeAt are its exact inverse.
  // Everything -- the wire, drafts, the pickers' arithmetic, the empty check -- comes from here,
  // so they cannot disagree with each other.
  const BLOCK = new Set(["DIV", "P", "LI", "TR", "SECTION", "ARTICLE", "BLOCKQUOTE", "PRE"]);

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

  const composerText = () => walk(input, null, 0)[0];

  function setComposerValue(text) {
    // One text node per line, separated by <br>. Never innerHTML: the string may be a draft that
    // came back from storage, or a pasted payload, and neither may bring markup into the host.
    const frag = document.createDocumentFragment();
    const lines = String(text ?? "").split("\n");
    lines.forEach((line, i) => {
      if (i) frag.appendChild(document.createElement("br"));
      if (line) frag.appendChild(document.createTextNode(line));
    });
    // A TRAILING newline takes TWO <br>, which is what Chromium itself emits: the second is the
    // filler that lets the new empty line hold a caret, and walk() drops a <br> that is its
    // parent's lastChild for exactly that reason. Writing one made the separator and the filler the
    // same node, so the reader could not tell "ends in a newline" from "ends in a line" -- a draft
    // finished with Shift+Enter lost one newline on every save and restore, silently, accumulating
    // across chat switches. This is the writer's half of walk()'s contract: setComposerValue(t)
    // followed by composerText() is t, for every t.
    if (lines.length > 1 && lines[lines.length - 1] === "") frag.appendChild(document.createElement("br"));
    // Whether the caret was ours to move must be decided BEFORE the nodes it points at are gone.
    const sel = window.getSelection();
    const wasOurs = !sel || sel.rangeCount === 0 || input.contains(sel.getRangeAt(0).startContainer);
    input.replaceChildren(frag);
    // Assigning a textarea's value leaves the caret at the end of the new text, and every caller
    // here was written against that. replaceChildren instead leaves the old range pointing at
    // nodes that no longer exist, so the pickers read a stale offset into text that has changed.
    // Only reclaim the caret if it was already inside the composer: doing it unconditionally
    // would yank the selection out of whatever else the user was typing in.
    if (wasOurs) setComposerRange(composerText().length);
    markComposerEmpty();
    // Rebuilding from text destroys any pills, because a pill serialises to "". The SELECTIONS
    // they showed are still live in `attachments`, so the row has to be redrawn or they become
    // invisible AND unremovable -- no pill to backspace, no chip to close. Losing the pill is
    // acceptable; losing the user's ability to see what they selected is not.
    //
    // And no pill governs them any more: this rebuild removed every one of them, and the user did
    // not. reconcilePills() withdraws a selection whose pill has gone, which is right when the
    // user deleted it and wrong here -- a draft restored after a rejected prompt came back with
    // its skills silently dropped. Hand those selections back to the row.
    for (const a of attachments) delete a.fromPill;
    if (typeof renderAtts === "function") renderAtts();
  }

  function offsetOf(node, offset) {
    return walk(input, node, offset)[1];
  }

  function composerSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return [composerText().length, composerText().length];
    const range = sel.getRangeAt(0);
    if (!input.contains(range.startContainer)) {
      const end = composerText().length;
      return [end, end];
    }
    const a = offsetOf(range.startContainer, range.startOffset);
    const b = offsetOf(range.endContainer, range.endOffset);
    return a <= b ? [a, b] : [b, a];
  }

  function rangeAt(target) {
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
      if (BLOCK.has(node.tagName) && node !== input && seen && !endedByBr) {
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
    visit(input);
    if (hit) return hit;
    return [input, input.childNodes.length];
  }

  function setComposerRange(start, end = start) {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    const [sn, so] = rangeAt(Math.max(0, start));
    const [en, eo] = rangeAt(Math.max(0, end));
    try {
      range.setStart(sn, so);
      range.setEnd(en, eo);
    } catch { range.selectNodeContents(input); range.collapse(false); }
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Set for as long as an IME session is open. There were no composition listeners at all before:
  // harmless for a textarea, which handles it internally, and not harmless here.
  let composing = false;
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; onInput(); });

  // ---- inline pills -------------------------------------------------------------------------
  // A picked skill, template or @file used to vanish from the box and reappear as a chip in a row
  // underneath, because a <textarea> cannot contain an element. It can now sit where it was typed.
  //
  // `data-pill` is the pill's WIRE text, and for these kinds it is deliberately the empty string:
  // the payload travels in `skills`, `templates` or `context`, never in prompt.text, and the tests
  // that pin "Review  after" are asserting exactly that. The attribute's PRESENCE marks a pill;
  // its value is what the model reads. contenteditable=false makes it one object to the caret, so
  // the browser steps over it and selects it whole.
  function pillElement(kind, label, wire = "") {
    const pill = document.createElement("span");
    pill.className = `composer-pill pill-${kind}`;
    pill.setAttribute("contenteditable", "false");
    pill.setAttribute("data-pill", wire);
    pill.dataset.kind = kind;
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
      pill.appendChild(document.createTextNode(shown.length > 48 ? shown.slice(0, 47) + "\u2026" : shown));
      pill.title = label;
      return pill;
    }
    pill.textContent = label;
    return pill;
  }

  // A null `start` puts the pill at the caret as it stands. Text offsets cannot say which side of
  // a pill whose wire text is "" they mean, so a paste that rebuilds several pills in a row places
  // each one where the last left the caret.
  function insertComposerPill(start, end, kind, label, wire = "") {
    return recordComposerEdit(() => placeComposerPill(start, end, kind, label, wire));
  }
  function placeComposerPill(start, end, kind, label, wire) {
    // Through execCommand still, because insertHTML is what puts the caret, the selection and the
    // surrounding text right; the undo step itself is the composer's own (recordComposerEdit).
    input.focus({ preventScroll: true });
    if (start != null) setComposerRange(start, end);
    const built = pillElement(kind, label, wire);
    // Tag it so the caret repair below can find exactly the node just inserted, rather than
    // guessing at "the last pill" -- there may already be others, in any order.
    const stamp = `p${Math.random().toString(36).slice(2, 10)}`;
    built.dataset.fresh = stamp;
    composerEditing = true;
    try {
      const ok = typeof document.execCommand === "function"
        && document.execCommand("insertHTML", false, built.outerHTML);
      if (!ok) {
        const range = window.getSelection()?.getRangeAt(0);
        if (range) {
          range.deleteContents();
          range.insertNode(built);
          range.collapse(false);
        }
      }
    } catch { /* leave the draft as it was rather than half-edit it */ }
    finally { composerEditing = false; }
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
    const fresh = input.querySelector(`[data-fresh="${stamp}"]`);
    if (fresh) {
      delete fresh.dataset.fresh;
      // Give the caret somewhere to be. Without a following text node there is no editable
      // position after an inline uneditable element at the end of the host.
      let after = fresh.nextSibling;
      if (!after || after.nodeType !== 3) {
        after = document.createTextNode("");
        fresh.parentNode.insertBefore(after, fresh.nextSibling);
      }
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.setStart(after, 0);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    markComposerEmpty();
    // Remember that this selection arrived as a pill. A selection added from the + menu or the
    // Skills surface has no pill and must not be governed by one; reconcilePills() below only
    // withdraws the ones that came in this way.
    const owner = attachments.find((a) => (kind === "file" ? a.label === label && a.resource
      : a[kind] === label));
    if (owner) owner.fromPill = true;
    // The row was drawn before this pill existed -- attachInvocation renders it, then the pill is
    // inserted -- so redraw now that there is something inline to defer to.
    renderAtts();
    scheduleDraftSave();
  }

  // Backspace against a pill removes the whole thing. Without this the browser walks into it and
  // deletes one character of a label that is not text the user typed.
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Backspace" && event.key !== "Delete") return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!input.contains(range.startContainer)) return;
    const back = event.key === "Backspace";
    let victim = null;
    if (range.startContainer.nodeType === 1) {
      const kids = range.startContainer.childNodes;
      const at = back ? range.startOffset - 1 : range.startOffset;
      const node = kids[at];
      if (node && node.nodeType === 1 && node.hasAttribute("data-pill")) victim = node;
    } else if (back && range.startOffset === 0) {
      const prev = range.startContainer.previousSibling;
      if (prev && prev.nodeType === 1 && prev.hasAttribute("data-pill")) victim = prev;
    }
    if (!victim) return;
    event.preventDefault();
    // An edit like any other, so Cmd+Z brings the pill back with the skill or file it stood for.
    // Removed by hand outside the history, the next Cmd+Z jumped past it and undid the pill's
    // insertion instead: the picker token came back and the pill never did.
    recordComposerEdit(() => { releasePill(victim); victim.remove(); });
    markComposerEmpty();
    onInput();
  }, true);

  // Removing a pill gives back whatever it was standing for, so the selection it represents does
  // not linger after the thing the reader can see has gone.
  // Pills and the attachment row are two views of one selection, and only the Backspace handler
  // kept them in step: releasePill has a single caller, and it bails on a non-collapsed selection.
  // So mouse-selecting a pill and deleting it, Ctrl+A then Delete, or undoing the insertion left
  // the selection attached with nothing on screen standing for it -- and persistDraft saves a
  // draft that has attachments even with no text, so every skill and @-file of an abandoned draft
  // rode along with the next, unrelated prompt, after a reload too.
  function reconcilePills() {
    const shown = new Set([...input.querySelectorAll(".composer-pill")]
      .map((pill) => `${pill.dataset.kind}\u0000${pill.textContent}`));
    let dropped = false;
    for (let i = attachments.length - 1; i >= 0; i--) {
      const a = attachments[i];
      if (!a.fromPill) continue;
      const kind = a.skill ? "skill" : a.template ? "template" : (a.resource ? "file" : "");
      const name = kind === "file" ? a.label : a[kind];
      if (kind && !shown.has(`${kind}\u0000${name}`)) { attachments.splice(i, 1); dropped = true; }
    }
    if (dropped) { renderAtts(); scheduleDraftSave(); }
  }
  function releasePill(pill) {
    // Match on the SELECTION's own identity, not on the pill's text: an invocation is stored as
    // {label: "$fixture", skill: "fixture"} while the pill shows the bare name, so comparing
    // labels silently matched nothing and the selection outlived the pill that showed it.
    const kind = pill.dataset.kind, name = pill.textContent;
    // One selection can stand behind more than one pill: attachInvocation dedupes, so picking the
    // same skill twice makes two pills and a single attachment. Handing the selection back on the
    // first removal dropped it while a pill for it was still on screen, and the message went out
    // with no skills at all. Only the last pill standing for a selection gives it back. Files are
    // exempt: the @file branch pushes unconditionally, so those are already one-to-one.
    if (kind !== "file" && [...input.querySelectorAll(".composer-pill")].some((other) =>
      other !== pill && other.dataset.kind === kind && other.textContent === name)) return;
    const index = attachments.findIndex((a) => (
      kind === "file" ? a.label === name && a.resource : a[kind] === name));
    if (index >= 0) { attachments.splice(index, 1); renderAtts(); }
  }

  function insertComposerText(text) {
    return recordComposerEdit(() => placeComposerText(text));
  }
  function placeComposerText(text) {
    input.focus();
    // What the composer must hold afterwards, computed BEFORE the insert so it can be checked.
    const [start, end] = composerSelection();
    const whole = composerText();
    const want = whole.slice(0, start) + text + whole.slice(end);
    // Guarded exactly as editComposer guards it: where execCommand does not exist, CALLING it
    // throws rather than returning falsy, and the text would be silently dropped instead of
    // falling through to the assignment below.
    const native = typeof document.execCommand === "function";
    const inserted = native && document.execCommand("insertText", false, text);
    // Chromium will not run an editing command from inside another one, and VS Code hands this page
    // every paste as one: its Paste runs execCommand("paste") here, so the paste handler is already
    // inside an editing command and insertText returns false. Every paste in VS Code used to fall
    // through to the rebuild below, which writes the box back as plain text -- every pill in it gone.
    // Put the text in at the selection by hand first; the rebuild is only for a result that is still
    // not what it must be.
    if (native && !inserted) spliceComposer(text);
    // ...and then VERIFIED, because what `insertText` does with consecutive newlines is the host's
    // business, not ours. A paste of a numbered list with blank lines between the items came back
    // with the blank lines gone on one Chromium and intact on another, and a composer whose
    // contents depend on which editor is embedding it is not a composer. Where the native path is
    // faithful it is kept, because it is the one that keeps the caret and the scroll where Chromium
    // puts them; where it is not, the exact text is put in by hand. Neither costs the undo step,
    // which the composer's own history records around this. `composerText()` is the same
    // serializer the wire uses, so this compares what the model would receive.
    if (composerText() !== want) {
      setComposerValue(want);
      setComposerRange(start + text.length);
    }
    markComposerEmpty();
  }
  // The DOM write insertText would have made, for where Chromium refuses to run it: the selection's
  // contents out, the text in as text and <br>, the caret after it. Pills outside the selection are
  // left exactly where they are.
  function spliceComposer(text) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (!input.contains(range.startContainer) || !input.contains(range.endContainer)) return false;
    range.deleteContents();
    const frag = document.createDocumentFragment();
    String(text).split("\n").forEach((line, i) => {
      if (i) frag.appendChild(document.createElement("br"));
      if (line) frag.appendChild(document.createTextNode(line));
    });
    const last = frag.lastChild;
    if (!last) return true;
    range.insertNode(frag);
    // A <br> that ends its line is the line's filler and reads as nothing, so a text that ends in a
    // newline needs a second one -- the rule setComposerValue writes by.
    if (last.nodeName === "BR" && !last.nextSibling) last.after(document.createElement("br"));
    range.setStartAfter(last);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }
  // The selection out of the box, by the editing command where Chromium runs it and by hand where it
  // will not (inside a cut, which VS Code delivers as execCommand("cut")).
  function deleteComposerSelection() {
    if (typeof document.execCommand === "function") {
      composerEditing = true;
      try { if (document.execCommand("delete", false)) return; } finally { composerEditing = false; }
    }
    const sel = window.getSelection();
    if (sel && sel.rangeCount && input.contains(sel.getRangeAt(0).commonAncestorContainer)) sel.getRangeAt(0).deleteContents();
  }

  /** The clipboard's text, from whichever flavour carries it.
   *
   *  Some applications put ONLY `text/html` on the clipboard. This handler prevents the default
   *  action on every paste -- it has to, an editing host would otherwise take the markup -- so a
   *  missing `text/plain` used to mean the paste vanished with no message at all. The HTML is never
   *  inserted; it is parsed, and only its TEXT is taken, with a newline wherever the markup put a
   *  block boundary or a <br>, so a list pasted from a rich-text app keeps the shape it was copied
   *  with instead of running into one line. */
  function clipboardText(data) {
    const plain = data ? String(data.getData("text/plain") || "") : "";
    if (plain || !data) return plain;
    const html = String(data.getData("text/html") || "");
    if (!html) return "";
    let doc;
    try { doc = new DOMParser().parseFromString(html, "text/html"); } catch { return ""; }
    const BLOCK = new Set(["P", "DIV", "LI", "TR", "BR", "H1", "H2", "H3", "H4", "H5", "H6",
                           "BLOCKQUOTE", "PRE", "SECTION", "ARTICLE", "UL", "OL", "TABLE", "HR"]);
    let out = "";
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { out += child.nodeValue.replace(/\s+/g, " "); continue; }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName;
        if (tag === "SCRIPT" || tag === "STYLE") continue;
        if (tag === "BR") { out += "\n"; continue; }
        const block = BLOCK.has(tag);
        if (block && out && !out.endsWith("\n")) out += "\n";
        walk(child);
        if (block && out && !out.endsWith("\n")) out += "\n";
      }
    };
    walk(doc.body || doc);
    return out.replace(/\n{3,}/g, "\n\n").trim();
  }

  // The placeholder cannot key off :empty, because of the filler <br>. It keys off the serializer.
  function markComposerEmpty() {
    // A pill carries no wire text -- a skill's is "" by design -- so a composer holding one
    // serializes to "" and used to be called empty. The ::before placeholder is the first inline
    // box in the editing host, so it laid out AHEAD of the pill: "Ask DGC to build, fix or
    // explain…/fixture" on one line. hasComposerInput() already counts attachments; this is the
    // same notion of not-empty, read from what is on screen.
    input.classList.toggle("is-empty",
      composerText() === "" && !input.querySelector("[data-pill]"));
  }

  // THE TRAP THIS GUARDS. Almost every composer test drives the panel with `input.value = "..."`.
  // Assigning `.value` to a div does not fail -- it creates an expando, the read returns what was
  // written, and the whole suite stays green against a composer that renders nothing. Defining the
  // accessors in terms of the primitives above means a test going through `.value` moves the real
  // composer, and a test asserting on it sees what the model would actually be sent.
  Object.defineProperty(input, "value", {
    get: () => composerText(),
    set: (text) => { recordComposerEdit(() => setComposerValue(text)); },
    configurable: true,
  });
  // Writable, because a textarea's are: `input.selectionStart = 8; input.selectionEnd = 11` is the
  // idiom throughout the panel and its tests, and a getter-only property turns that into a thrown
  // TypeError. The clamping mirrors the platform -- moving the start past the end drags the end
  // with it, and vice versa -- so the two assignments compose in either order.
  Object.defineProperty(input, "selectionStart", {
    get: () => composerSelection()[0],
    set: (at) => { const end = composerSelection()[1]; setComposerRange(at, Math.max(at, end)); },
    configurable: true,
  });
  Object.defineProperty(input, "selectionEnd", {
    get: () => composerSelection()[1],
    set: (at) => { const start = composerSelection()[0]; setComposerRange(Math.min(start, at), at); },
    configurable: true,
  });
  input.setSelectionRange = (start, end) => setComposerRange(start, end);
  // Another method a <textarea> supplied. Callers use it to select the whole draft before
  // replacing or deleting it, and on a div it simply does not exist.
  input.select = () => setComposerRange(0, composerText().length);

  // ---- undo and redo ------------------------------------------------------------------------
  // The box keeps its own history, as Codex's composer does (a ProseMirror history, bound to
  // Mod-z, Mod-Shift-z and Mod-y in the composer's own keymap), instead of leaning on the
  // browser's. Chromium's undo stack was measured in this box and does not do what Cmd+Z means,
  // however carefully each edit is routed through execCommand:
  //
  //   * every insertText joins the typing run still open before it, so a paste, a dictated phrase
  //     or a picked completion was taken back together with the words typed ahead of it;
  //   * a typing run never ends by itself: a paragraph written over a minute went in one press;
  //   * what lives beside the text is not in it -- the selection a pill stands for, a paste folded
  //     into a chip, the Goal choice -- so a redone pill no longer attached its skill or file, and
  //     a pill removed with Backspace could not be brought back at all;
  //   * every DOM write the panel makes (a restored draft, the fallback that keeps a paste's blank
  //     lines) leaves the native steps pointing at nodes that are gone, and Cmd+Z does nothing.
  //
  // In VS Code the key does not reach the browser's undo in any case. The webview host cancels
  // Cmd/Ctrl+Z, hands it to the workbench, and the workbench's Undo calls execCommand("undo") on
  // this document. So the history answers every way in: the key itself, stopped here so the
  // workbench does not undo a second time; execCommand("undo"/"redo"), which is the Edit menu;
  // and beforeinput historyUndo/historyRedo, which is anything else.
  //
  // A step is a snapshot of the box: its nodes, pills and all, the selection, the selections and
  // chips beside it, and the Goal choice. Typing and deleting group as ProseMirror groups them --
  // a run of one kind at the caret, broken by a pause of HISTORY_GROUP_MS -- and everything the
  // panel does itself is a step of its own.
  const HISTORY_DEPTH = 100, HISTORY_GROUP_MS = 500;
  const MAC = /Mac|iP(hone|[oa]d)/.test(navigator.platform || "");
  const composerHistory = { done: [], undone: [], open: null, pending: null, depth: 0, before: null, restoring: false };
  // Which selections the history may put back or take away. One added or removed BY an edit is
  // the history's; one added from outside the box (the explorer, the Skills page) is not, and
  // undoing some typing must not drop it. A chip closed by hand is a decision, never undone.
  const historyManaged = new WeakSet(), historyDismissed = new WeakSet();
  function dismissAttachment(item) { if (item && typeof item === "object") historyDismissed.add(item); }

  function nodePath(node) {
    const path = [];
    for (; node && node !== input; node = node.parentNode) {
      if (!node.parentNode) return null;
      path.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node));
    }
    return node === input ? path : null;
  }
  function nodeAtPath(path) {
    let node = input;
    for (const index of path || []) node = node ? node.childNodes[index] : null;
    return node || null;
  }
  function captureComposer() {
    // The caret as a DOM position, not a text offset: a skill pill reads as "", so the offsets on
    // either side of it are the same number, and a caret restored by offset lands in FRONT of the
    // pill it was after -- and the next word typed goes there too.
    let caret = null;
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0), start = nodePath(r.startContainer), end = nodePath(r.endContainer);
      if (start && end) caret = { start, startOffset: r.startOffset, end, endOffset: r.endOffset };
    }
    return { nodes: [...input.childNodes].map((node) => node.cloneNode(true)), markup: input.innerHTML,
      caret, at: composerSelection(), goal: goalDraftArmed,
      atts: attachments.map((item) => ({ item, fromPill: item.fromPill === true })) };
  }
  function sameComposer(a, b) {
    return a.markup === b.markup && a.goal === b.goal && a.atts.length === b.atts.length
      && a.atts.every((entry, i) => entry.item === b.atts[i].item && entry.fromPill === b.atts[i].fromPill);
  }
  function restoreComposer(state) {
    input.replaceChildren(...state.nodes.map((node) => node.cloneNode(true)));
    const present = new Set(state.atts.map((entry) => entry.item));
    for (let i = attachments.length - 1; i >= 0; i -= 1) {
      const item = attachments[i];
      if (!present.has(item) && (item.fromPill || historyManaged.has(item))) attachments.splice(i, 1);
    }
    state.atts.forEach((entry, index) => {
      const { item } = entry;
      if (!attachments.includes(item) && (entry.fromPill || historyManaged.has(item)) && !historyDismissed.has(item)) {
        attachments.splice(Math.min(index, attachments.length), 0, item);
      }
      if (entry.fromPill) item.fromPill = true; else delete item.fromPill;
    });
    if (state.goal !== goalDraftArmed) setGoalDraftArmed(state.goal);
    input.focus({ preventScroll: true });
    const sel = window.getSelection(), c = state.caret;
    const start = c && nodeAtPath(c.start), end = c && nodeAtPath(c.end);
    const room = (node) => (node.nodeType === 3 ? node.data.length : node.childNodes.length);
    try {
      if (!sel || !start || !end) throw new Error("no caret");
      const range = document.createRange();
      range.setStart(start, Math.min(c.startOffset, room(start)));
      range.setEnd(end, Math.min(c.endOffset, room(end)));
      sel.removeAllRanges(); sel.addRange(range);
    } catch { setComposerRange(state.at[0], state.at[1]); }
  }
  function pushComposerUndo(state) {
    composerHistory.done.push(state);
    if (composerHistory.done.length > HISTORY_DEPTH) composerHistory.done.shift();
    composerHistory.undone.length = 0;
  }
  function resetComposerHistory() {
    Object.assign(composerHistory, { open: null, pending: null });
    composerHistory.done.length = 0; composerHistory.undone.length = 0;
  }
  // Whether an edit of this kind, made now, carries on the typing run before it.
  function typingContinues(kind) {
    const open = composerHistory.open;
    if (!kind || !open || open.kind !== kind) return false;
    if (composing) return true;
    const [start, end] = composerSelection();
    return start === end && start === open.end && Date.now() - open.time < HISTORY_GROUP_MS;
  }
  // Every change the panel makes to the box goes through here, and nested calls are one step: a
  // picked @file is the token removed, the pill put in and the file attached, undone together.
  // `kind` ("insert" or "delete") makes the edit part of a typing run instead -- Shift+Enter is
  // typing; a paste, a completion or dictation is not.
  function recordComposerEdit(edit, kind = "") {
    const h = composerHistory;
    if (h.restoring) return edit();
    const outer = h.depth === 0;
    if (outer) { h.before = typingContinues(kind) ? null : captureComposer(); h.open = null; h.pending = null; }
    h.depth += 1;
    try { return edit(); }
    finally {
      h.depth -= 1;
      if (outer) {
        const before = h.before;
        h.before = null;
        if (before) {
          const had = new Set(before.atts.map((entry) => entry.item));
          for (const item of attachments) if (!had.has(item)) historyManaged.add(item);
          for (const item of had) if (!attachments.includes(item)) historyManaged.add(item);
          // An edit that changed nothing is not a step: Cmd+Z would seem to do nothing.
          if (!sameComposer(before, captureComposer())) pushComposerUndo(before);
        }
        h.open = kind ? { kind, end: composerSelection()[0], time: Date.now() } : null;
      }
    }
  }
  function moveComposerHistory(from, to) {
    const h = composerHistory;
    if (composing || h.depth || !from.length) return false;
    h.open = null; h.pending = null;
    to.push(captureComposer());
    h.restoring = true;
    try { restoreComposer(from.pop()); } finally { h.restoring = false; }
    markComposerEmpty(); hidePop(); renderAtts(); renderPasteNotice();
    renderComposerControls(); autosizeComposer(); persistDraft();
    return true;
  }
  const undoComposer = () => moveComposerHistory(composerHistory.done, composerHistory.undone);
  const redoComposer = () => moveComposerHistory(composerHistory.undone, composerHistory.done);

  // Cmd+Z, Cmd+Shift+Z and Cmd+Y on a Mac; Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y elsewhere -- Codex's
  // Mod-z, Mod-Shift-z and Mod-y. Read from the layout's letter, and from the physical key when the
  // layout's letter is not Latin, so a Cyrillic or Greek keyboard still undoes.
  function composerHistoryKey(event) {
    if (event.altKey || event.isComposing || event.keyCode === 229) return "";
    if (MAC ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return "";
    const key = /^[a-z]$/i.test(event.key || "") ? event.key.toLowerCase()
      : String(event.code || "").replace(/^Key/, "").toLowerCase();
    if (key === "z") return event.shiftKey ? "redo" : "undo";
    return key === "y" && !event.shiftKey ? "redo" : "";
  }
  input.addEventListener("keydown", (event) => {
    const op = composerHistoryKey(event);
    if (!op) return;
    // Taken even when there is nothing to undo: let through, VS Code would run the browser's own
    // undo on this page, over nodes that history has since replaced.
    event.preventDefault();
    event.stopPropagation();
    if (op === "undo") undoComposer(); else redoComposer();
  }, true);
  // The Edit menu's Undo and Redo: the workbench sends them to the focused webview as
  // execCommand on this document, which would otherwise run the browser's stack.
  if (typeof document.execCommand === "function") {
    const nativeExecCommand = document.execCommand;
    document.execCommand = function (command, ...rest) {
      const name = String(command || "").toLowerCase();
      if ((name === "undo" || name === "redo") && input.contains(document.activeElement)) {
        return name === "undo" ? undoComposer() : redoComposer();
      }
      return nativeExecCommand.call(this, command, ...rest);
    };
  }
  input.addEventListener("beforeinput", (event) => {
    const type = event.inputType || "";
    if (type === "historyUndo" || type === "historyRedo") {
      event.preventDefault();
      if (type === "historyUndo") undoComposer(); else redoComposer();
      return;
    }
    // Cmd+B and Cmd+I would bold and italicise in an editing host. The box is plain text: the
    // serializer drops the markup anyway, so all it did was make words look different from what
    // is sent.
    if (/^format/.test(type)) { event.preventDefault(); return; }
    const h = composerHistory;
    if (h.depth || h.restoring) return;
    // Captured now, while the DOM is still as it was; kept only if an input event follows, so a
    // Backspace in an empty box does not leave a step that changes nothing.
    const kind = /^insert(Text|CompositionText)$/.test(type) ? "insert"
      : /^delete(Content|Word|SoftLine|HardLine)(Backward|Forward)$/.test(type) ? "delete" : "";
    h.pending = typingContinues(kind) ? { kind } : { kind, state: captureComposer() };
  }, true);
  input.addEventListener("input", () => {
    const h = composerHistory, pending = h.pending;
    h.pending = null;
    if (h.depth || h.restoring || !pending) return;
    if (pending.state) pushComposerUndo(pending.state);
    h.open = pending.kind ? { kind: pending.kind, end: composerSelection()[0], time: Date.now() } : null;
  }, true);

  // ---- copy, cut and paste back -------------------------------------------------------------
  // A pill copied out of the box reads as the token that made it -- $skill, @file, /command -- or,
  // for a link, as the URL itself; Chromium's own copy wrote the pill's label (a truncated host
  // for a link) and its markup. Pasted back into the box, the same copy is pills again, with the
  // skills and files they stand for: Codex's composer does the same through its own clipboard
  // serializer. Nothing is trusted from the clipboard for that -- the pills come from this
  // panel's memory of its last copy, and only when the clipboard still holds that exact text.
  const PILL_MARK = "";
  var composerCopy = null;
  function pillToken(pill) {
    const kind = pill.dataset.kind, name = pill.textContent;
    if (kind === "link") return pill.dataset.pill || pill.title || name;
    return (kind === "skill" ? "$" : kind === "file" ? "@" : "/") + name;
  }
  function copyComposerSelection(event) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed || !event.clipboardData) return false;
    const range = sel.getRangeAt(0);
    if (!input.contains(range.startContainer) || !input.contains(range.endContainer)) return false;
    const holder = document.createElement("div");
    holder.appendChild(range.cloneContents());
    const text = walk(holder, null, 0, pillToken)[0];
    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
    const pills = [];
    const marked = walk(holder, null, 0, (pill) => { pills.push(pill); return PILL_MARK; })[0];
    composerCopy = null;
    if (pills.length && !text.includes(PILL_MARK)) {
      const parts = [];
      marked.split(PILL_MARK).forEach((piece, i) => {
        if (i) {
          const pill = pills[i - 1], kind = pill.dataset.kind, label = pill.title && kind === "link" ? pill.title : pill.textContent;
          const att = kind === "file" ? attachments.find((a) => a.resource && a.label === pill.textContent) : null;
          parts.push({ kind, label, wire: pill.dataset.pill || "", token: pillToken(pill),
            resource: att ? { ...att.resource } : null });
        }
        if (piece) parts.push(piece);
      });
      composerCopy = { text, parts };
    }
    return true;
  }
  input.addEventListener("copy", copyComposerSelection);
  input.addEventListener("cut", (event) => {
    if (!copyComposerSelection(event)) return;
    recordComposerEdit(() => { deleteComposerSelection(); reconcilePills(); });
    markComposerEmpty();
    onInput();
  });
  function pasteComposerCopy(parts) {
    recordComposerEdit(() => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && !sel.isCollapsed) deleteComposerSelection();
      for (const part of parts) {
        if (typeof part === "string") { insertComposerText(part); continue; }
        const { kind, label, wire, token, resource } = part;
        let ok = true;
        if (kind === "skill" || kind === "template") ok = attachInvocation(kind, label);
        else if (kind === "file") {
          // One selection per @file pill, as the picker makes them: releasePill relies on it.
          ok = !!resource && canAttach();
          if (ok) attachments.push({ label, resource: { ...resource }, fromPill: true });
        } else if (kind === "command") ok = !input.querySelector('[data-kind="command"]');   // one per prompt
        if (ok) insertComposerPill(null, null, kind, label, wire);
        else insertComposerText(token);
      }
      reconcilePills();
    });
    renderAtts(); onInput();
  }
  // What the backend is sent. Identity while the composer is plain text; once a pill can sit in
  // the draft this is where its placeholder is turned back into the words the model should read.
  const wireText = (text) => text;
  const goalBar = $("goalbar"), changesBar = $("changesbar"), tasksBar = $("tasksbar"), composerRail = $("composer-rail");
  const monitorsBar = $("monitorsbar"), pasteBar = $("pastebar"), pipsBar = $("pipsbar"), troupeBar = $("troupebar");
  // The kinds of work the rail can hold, in the order their chips stand on the chip line (B2). The
  // invisible-characters notice is not one of them: it is about the message being typed.
  const RAIL_KINDS = [["goal", goalBar], ["troupe", troupeBar], ["monitors", monitorsBar], ["tasks", tasksBar],
    ["changes", changesBar], ["pips", pipsBar]].filter(([, bar]) => bar);
  const announcer = $("announcer");
  const queuedEl = $("queued");
  // Pips has its own durable conversations. Hiding the main chat preserves its
  // live stream, draft, scroll position and session; it never changes that session.
  let pipsApp = null, pipsOpen = false, pipsViewVisible = true;
  const pipsListeners = new Set();
  let pipSetupCards = null;
  function setupCards() {
    if (!pipSetupCards && window.DgcPips?.mountSetupCards && document.documentElement.dataset.pipsDocumentId) {
      pipSetupCards = window.DgcPips.mountSetupCards({
        document,
        postMessage: message => vscode.postMessage({...message, documentId:document.documentElement.dataset.pipsDocumentId}),
        onOpenRun: navigation => { showPips(); pipsApp?.navigate?.(navigation); },
        // A waiting Pip docks where questions dock (the founder chose it over a card in the reply).
        // A question docked first keeps the place; the Pip docks again when it is answered.
        dock: { show: dockPipCard, hide: undockPipCard },
        // The Pip runs this chat started are background tasks: the pill counts them, the map lists them.
        onRunsChange: () => renderAgents(),
      });
    }
    return pipSetupCards;
  }
  let pipDock = null;
  function dockPipCard(el) {
    if (ask) return false;
    const cbox = $("cbox"), textBox = cbox.querySelector(".cinput");
    if (pipDock) pipDock.el.remove();
    else pipDock = { hid: { textBox: textBox ? textBox.hidden : false, atts: atts.hidden } };
    pipDock.el = el;
    cbox.insertBefore(el, cbox.firstChild);
    cbox.classList.add("asking");
    if (textBox) textBox.hidden = true;            // hidden, not rebuilt: an unsent draft stays in it
    atts.hidden = true;
    closeRailPop({ restore: false });              // the chip line steps aside for a docked card in a short panel
    document.body.classList.add("ask-docked");
    renderComposerControls();
    return true;
  }
  function undockPipCard(el) {
    if (!pipDock || pipDock.el !== el) return;
    const focusWasInside = el.contains(document.activeElement);
    el.remove();
    const cbox = $("cbox"), textBox = cbox.querySelector(".cinput");
    if (!ask) {
      cbox.classList.remove("asking");
      if (textBox) textBox.hidden = !!pipDock.hid.textBox;
      atts.hidden = !!pipDock.hid.atts;
      document.body.classList.remove("ask-docked");
    }
    pipDock = null;
    renderComposerControls();
    if (focusWasInside) input.focus({ preventScroll: true });
  }
  // The Pips bar above the composer: today's digest, shown when the backend says it is due.
  let pipDigestBar = null;
  // The bar above the composer is the single-chat page's. A session's tab is about its session (the
  // founder: a Pips notice there "has nothing to do with that session"), and the side bar's
  // Sessions home shows the Pips above its list instead (homePips).
  function digestBar() {
    if (!pipDigestBar && chatPlace === "chat" && window.DgcPips?.mountDigestBar && document.documentElement.dataset.pipsDocumentId) {
      pipDigestBar = window.DgcPips.mountDigestBar({
        document,
        postMessage: message => vscode.postMessage({...message, documentId:document.documentElement.dataset.pipsDocumentId}),
        onOpen: navigation => { showPips(); if (navigation) pipsApp?.navigate?.(navigation); },
        onChange: () => syncComposerRail(),
      });
    }
    return pipDigestBar;
  }
  function showPips() {
    const host = $("pips-host");
    if (!host || !window.DgcPips?.mount) return;
    if (!pipsApp) {
      const root = host.attachShadow({mode:"open"});
      pipsApp = window.DgcPips.mount({
        root, stylesheetUri:host.dataset.styleUri,
        postMessage:message => vscode.postMessage({...message,documentId:document.documentElement.dataset.pipsDocumentId}),
        onMessage:listener => { pipsListeners.add(listener); return () => pipsListeners.delete(listener); },
        getState:() => { const state=vscode.getState(); return state?.pipsScope===document.documentElement.dataset.draftScope ? state.pips : undefined; },
        setState:state => vscode.setState({...vscode.getState(),pips:state,pipsScope:document.documentElement.dataset.draftScope}),
        close:closePips,
        // Ask DGC to fix, from a Pip's own chat (Pips API 51): the prompt the Work chat's card sends, sent once.
        onAskDgc:({report, session} = {}) => askDgcFromPips(report, session),
        // What the fix did, in the run's post (Pips API 65): a click goes to its card in the chat it ran in.
        onOpenFix:({session, run_id} = {}) => openPipFixFromPips(session, run_id),
        onSetupPrompt:prompt => {
          // Preparing a message is never sending it or replacing the user's work.
          if (composerText() || input.querySelector(".composer-pill") || attachments.length || pendingImageFiles || pendingImageBytes) return 'The main chat already has a draft or attachments. Send or save that draft before describing this setup.';
          if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 10000) return 'The setup prompt is invalid. Nothing was added to the main chat.';
          setComposerText(prompt); onInput(); persistDraft(); closePips();
          setComposerRange(composerText().length);
          input.focus();
          return true;
        },
      });
    }
    if (sessionsOpen) hideSessions();
    pipsOpen = true;
    document.body.classList.add("pips-active");
    host.hidden = false;
    $("btn-pips-back").hidden = false;
    $("btn-pips").setAttribute("aria-pressed","true");
    pipsApp.setVisible?.(pipsViewVisible && !document.hidden);
  }
  // `back`: whether to go back to what was there before -- the side bar's Sessions home goes back to
  // its list. False when the list itself is what is taking over.
  function closePips(back = true) {
    pipsOpen = false;
    pipsApp?.setVisible?.(false);
    document.body.classList.remove("pips-active");
    $("pips-host").hidden = true;
    $("btn-pips-back").hidden = true;
    $("btn-pips").setAttribute("aria-pressed","false");
    if (chatPlace === "home") { if (back) showSessions(); }
    else input.focus();
  }
  // ---- #3 Sessions home ----
  // The side bar opens on this project's sessions, newest first. Each opens in an editor tab of its
  // own -- "Open in Editor", a double-click or Enter -- and so does New session. In a session's tab
  // the page is the chat, without the Pips (they stay in the side bar), its + opening another tab.
  const chatPlace = document.documentElement.dataset.chatPlace || "chat";
  let sessionsOpen = false, homePips = null;
  function showSessions() {
    if (chatPlace !== "home") return;
    if (pipsOpen) closePips(false);
    sessionsOpen = true;
    document.body.classList.add("sessions-active");
    $("sessions-host").hidden = false;
  }
  function hideSessions() {
    sessionsOpen = false;
    document.body.classList.remove("sessions-active");
    $("sessions-host").hidden = true;
  }
  const sessionTitle = (item) => item.name || item.preview || "Untitled session";
  function openSession(item) { vscode.postMessage({ type: "openSessionInEditor", id: item.id, title: sessionTitle(item) }); }
  function sessionButton(cls, codicon, onClick) {
    const button = el("button", cls); button.type = "button";
    const glyph = el("span", `codicon codicon-${codicon}`); glyph.setAttribute("aria-hidden", "true");
    button.append(glyph);
    button.onclick = (e) => { e.stopPropagation(); onClick(); };
    button.ondblclick = (e) => e.stopPropagation();
    return button;
  }
  let sessionsSearchTimer = 0;
  // One search over both lists: your chats and this project's sessions.
  $("sessions-search")?.addEventListener("input", (e) => {
    clearTimeout(sessionsSearchTimer);
    sessionsSearchTimer = setTimeout(() => {
      vscode.postMessage({ type: "sessionsSearch", query: e.target.value });
      if (chatsAvailable) vscode.postMessage({ type: "chatdgcSearch", query: e.target.value });
    }, 250);
  });
  $("sessions-more")?.addEventListener("click", (e) => {
    e.currentTarget.disabled = true; e.currentTarget.textContent = "Loading…";
    vscode.postMessage({ type: "sessionsMore" });
  });
  // Session names and previews are the user's own words: text nodes only, never markup.
  function renderSessions(msg) {
    const list = $("sessions-list"), status = $("sessions-status");
    const items = Array.isArray(msg.items) ? msg.items : [];
    const focused = document.activeElement?.closest?.(".session-row")?.dataset.id;
    list.replaceChildren();
    // Thousands of sessions: a search over names, first messages and everything said, and Load more.
    const search = $("sessions-search"), more = $("sessions-more"), query = String(msg.query || "");
    sessionsSearchable = msg.searchable === true;
    if (search) { search.hidden = !sessionsSearchable && !chatsAvailable; if (document.activeElement !== search) search.value = query; }
    if (more) { more.hidden = msg.more !== true; more.disabled = false; more.textContent = "Load more"; }
    homeCount("work", query ? items.length : null, msg.more === true);
    status.textContent = msg.error ? String(msg.error)
      : items.length ? "" : query ? `No session mentions “${query}”.`
      : "No sessions in this project yet. Start one with New session: it opens in an editor tab.";
    if (msg.error) status.dataset.kind = "error"; else delete status.dataset.kind;
    status.hidden = !status.textContent;
    for (const item of items) {
      const title = sessionTitle(item);
      const row = el("li", "session-row");
      row.tabIndex = 0; row.dataset.id = item.id;
      const main = el("div", "session-main");
      const name = el("span", "session-name"); name.textContent = title; name.title = title;
      const meta = el("span", "session-meta");
      const count = Number(item.count) || 0;
      for (const part of [item.when, `${count} message${count === 1 ? "" : "s"}`]) {
        if (part) { const span = el("span"); span.textContent = part; meta.append(span); }
      }
      if (item.open) { const open = el("span", "session-tab"); open.textContent = "Open in a tab"; meta.append(open); }
      // Still running with no window (a reload, a closed window or tab): opening it picks it up where it is.
      else if (item.windowless) {
        const live = el("span", "session-tab session-windowless"); live.textContent = "Running, no window";
        live.title = `${String(item.windowless).slice(0, 200)}. Open it to pick it up, or stop it in Settings › Running sessions.`;
        meta.append(live);
      }
      main.append(name, meta);
      if (typeof item.match === "string" && item.match) {
        const found = el("span", "session-match"); found.textContent = item.match; main.append(found);
      }
      const open = sessionButton("session-open", "go-to-file", () => openSession(item));
      const word = el("span", "session-open-label"); word.textContent = "Open in Editor"; open.append(word);
      open.title = "Open in an editor tab";
      open.setAttribute("aria-label", `Open in Editor: ${title}`);
      const remove = sessionButton("session-delete", "trash", () => vscode.postMessage({ type: "deleteSession", id: item.id, title }));
      remove.title = item.open ? "Close its tab to delete this session" : "Delete this session";
      remove.setAttribute("aria-label", `Delete session: ${title}`);
      row.append(main, open, remove);
      // A click opens it, as a chat in the Chat tab opens: the second click of a double-click opens nothing more.
      row.onclick = (e) => { if (e.detail < 2) openSession(item); };
      row.onkeydown = (e) => {
        if (e.target !== row) return;
        if (e.key === "Enter") { e.preventDefault(); openSession(item); }
        else if (e.key === "Delete") { e.preventDefault(); remove.click(); }
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const next = e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling;
          if (next) next.focus();
        }
      };
      list.append(row);
      if (item.id === focused) row.focus();
    }
  }
  // ---- ChatDGC: your chats, the same in every folder, above this project's sessions (Work) ----
  // A chat opens in an editor tab of its own (src/chatdgc.ts). Titles and previews are the user's and
  // the model's words: text nodes only. The section stays hidden with a CLI that has no ChatDGC.
  let chatsAvailable = false, sessionsSearchable = false;
  function chatWhen(stamp) {
    const at = Date.parse(String(stamp || ""));
    if (!Number.isFinite(at)) return "";
    const minutes = Math.round((Date.now() - at) / 60000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days} days ago`;
    return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: new Date(at).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  }
  /** The last message's words without its Markdown: a table's pipes, emphasis marks and link targets. */
  function plainPreview(text) {
    return String(text || "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_#>|~]+|-{3,}/g, " ")
      .replace(/\s+/g, " ").trim();
  }
  function renderChats(msg) {
    const section = $("chats-home"), list = $("chats-list"), status = $("chats-status"), more = $("chats-more");
    if (!section || !list) return;
    chatsAvailable = msg.available === true;
    homeTabs();
    $("sessions-title").textContent = chatsAvailable ? "Work" : "Sessions";
    const search = $("sessions-search");
    if (search) {
      search.hidden = !sessionsSearchable && !chatsAvailable;
      search.placeholder = chatsAvailable ? "Search chats and sessions" : "Search sessions";
      search.setAttribute("aria-label", chatsAvailable ? "Search your chats and this project's sessions" : "Search sessions: names and everything said");
    }
    if (!chatsAvailable) return;
    const items = Array.isArray(msg.items) ? msg.items : [];
    const open = new Set(Array.isArray(msg.open) ? msg.open : []);
    const query = String(msg.query || "");
    homeCount("chat", query ? items.length : null, msg.more === true);
    status.textContent = msg.error ? String(msg.error) : items.length ? "" : query ? `No chat mentions “${query}”.`
      : "No chats yet. Start one with New chat: it's the same in every folder.";
    if (msg.error) status.dataset.kind = "error"; else delete status.dataset.kind;
    status.hidden = !status.textContent;
    if (more) { more.hidden = msg.more !== true; more.disabled = false; more.textContent = "Show more"; }
    const focused = document.activeElement?.closest?.(".chat-row")?.dataset.id;
    openChats = open;
    homeQuery = query;
    list.replaceChildren();
    for (const item of items) {
      const row = chatRow(item);
      list.append(row);
      if (item.id === focused) row.focus();
    }
    renderProjects();
  }
  /** One chat in the list: its name, when, where it's open, the words found (or its last message), Delete. A chat
   *  can be dragged onto a project to move it there, or back onto Chats to take it out. */
  let openChats = new Set(), homeQuery = "";
  const CHAT_DRAG = "application/x-dgc-chat", CHAT_IN_PROJECT = "application/x-dgc-chat-in-project";
  function chatRow(item, nested = false) {
    const title = String(item.title || "New chat");
    const row = el("li", "session-row chat-row" + (nested ? " chat-row-nested" : ""));
    row.tabIndex = 0; row.dataset.id = String(item.id || "");
    const main = el("div", "session-main");
    const name = el("span", "session-name"); name.textContent = title; name.title = title;
    const meta = el("span", "session-meta");
    if (item.pinned) { const pin = el("span", "chat-pinned"); pin.textContent = "Pinned"; meta.append(pin); }
    // Found by a search, in a project: which one.
    const home = !nested && item.project ? projects.find((x) => x.id === item.project) : null;
    if (home) { const tag = el("span", "chat-project"); tag.textContent = home.name; meta.append(tag); }
    const when = chatWhen(item.updated_at);
    if (when) { const span = el("span"); span.textContent = when; meta.append(span); }
    if (openChats.has(item.id)) { const tab = el("span", "session-tab"); tab.textContent = "Open in a tab"; meta.append(tab); }
    main.append(name, meta);
    // Found by something said in it: the words around that, rather than its last message.
    const words = nested ? "" : plainPreview(typeof item.match === "string" && item.match ? item.match : item.preview);
    if (words) { const preview = el("span", "session-match chat-preview"); preview.textContent = words; main.append(preview); }
    const remove = sessionButton("session-delete", "trash", () => vscode.postMessage({ type: "chatdgcDelete", id: item.id, title }));
    remove.title = "Delete this chat";
    remove.setAttribute("aria-label", `Delete chat: ${title}`);
    row.append(main, remove);
    const openIt = () => vscode.postMessage({ type: "chatdgcOpen", id: item.id });
    row.onclick = (e) => { if (e.detail < 2) openIt(); };
    row.onkeydown = (e) => {
      if (e.target !== row) return;
      if (e.key === "Enter") { e.preventDefault(); openIt(); }
      else if (e.key === "Delete") { e.preventDefault(); remove.click(); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling;
        next?.focus();
      }
    };
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData(CHAT_DRAG, String(item.id || ""));
      if (item.project || nested) e.dataTransfer.setData(CHAT_IN_PROJECT, "1");
      e.dataTransfer.effectAllowed = "move";
    });
    return row;
  }
  // ---- Projects (ChatGPT's): chats, files and instructions together. A project opens its page in a tab; its
  // chevron lists its chats here. While searching, the results say each chat's project instead.
  let projects = [], lastProjects = "";
  const projectChats = new Map();
  const projectsOpen = new Set((() => { try { return vscode.getState()?.projectsOpen || []; } catch { return []; } })());
  function dropTarget(node, accepts, onDrop) {
    node.addEventListener("dragover", (e) => {
      if (!accepts(e.dataTransfer.types)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move"; node.classList.add("drop-here");
    });
    node.addEventListener("dragleave", (e) => { if (!node.contains(e.relatedTarget)) node.classList.remove("drop-here"); });
    node.addEventListener("drop", (e) => {
      node.classList.remove("drop-here");
      const chat = e.dataTransfer.getData(CHAT_DRAG);
      if (chat && accepts(e.dataTransfer.types)) { e.preventDefault(); onDrop(chat); }
    });
  }
  function toggleProject(id) {
    if (projectsOpen.has(id)) projectsOpen.delete(id); else { projectsOpen.add(id); projectChats.delete(id); }
    try { vscode.setState({ ...(vscode.getState() || {}), projectsOpen: [...projectsOpen] }); } catch {}
    renderProjects();
  }
  function renderProjects() {
    const box = $("projects-home"), list = $("projects-list");
    if (!box || !list) return;
    box.hidden = !chatsAvailable || !!homeQuery;
    $("chats-sub").hidden = box.hidden || !projects.length;
    if ($("chats-library")) $("chats-library").hidden = box.hidden;
    if (box.hidden) return;
    // Drawn again only when something changed: the home refreshes after every turn, and a redraw replaces the
    // buttons under a pointer, so a click that lands mid-redraw would be lost.
    const drawn = JSON.stringify([projects, [...projectsOpen], [...projectChats], [...openChats]]);
    if (drawn === lastProjects && list.childElementCount) return;
    lastProjects = drawn;
    const focused = document.activeElement?.closest?.(".project-row, .chat-row-nested")?.dataset.id;
    list.replaceChildren();
    if (!projects.length) {
      const start = el("li", "project-item");
      const button = el("button", "project-start"); button.type = "button";
      const glyph = el("span", "codicon codicon-new-folder"); glyph.setAttribute("aria-hidden", "true");
      const words = el("span"); words.textContent = "New project";
      button.append(glyph, words);
      button.title = "Keep chats, files and instructions together, as ChatGPT's projects do";
      button.onclick = () => vscode.postMessage({ type: "chatdgcProjectNew" });
      start.append(button);
      list.append(start);
    }
    for (const project of projects) {
      const id = String(project.id || ""), named = String(project.name || "Project");
      const item = el("li", "project-item");
      const row = el("div", "session-row project-row");
      row.tabIndex = 0; row.dataset.id = id;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `Open the project ${named}: ${project.chats || 0} chat${project.chats === 1 ? "" : "s"}`);
      const open = projectsOpen.has(id);
      const toggle = sessionButton("project-toggle", open ? "chevron-down" : "chevron-right", () => toggleProject(id));
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", `${open ? "Hide" : "Show"} the chats in ${named}`);
      toggle.title = open ? "Hide its chats" : "Show its chats";
      const folder = el("span", "codicon codicon-folder project-icon"); folder.setAttribute("aria-hidden", "true");
      folder.dataset.color = String(project.color || "purple");
      const name = el("span", "session-name project-name"); name.textContent = named; name.title = named;
      const count = el("span", "project-count"); count.textContent = String(project.chats || 0);
      row.append(toggle, folder, name, count);
      const openIt = () => vscode.postMessage({ type: "chatdgcProjectOpen", id });
      row.onclick = (e) => { if (e.detail < 2) openIt(); };
      row.onkeydown = (e) => {
        if (e.target !== row) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openIt(); }
        else if (e.key === "ArrowRight" && !open) { e.preventDefault(); toggleProject(id); }
        else if (e.key === "ArrowLeft" && open) { e.preventDefault(); toggleProject(id); }
      };
      dropTarget(row, (types) => types.includes(CHAT_DRAG), (chat) => vscode.postMessage({ type: "chatdgcMove", id: chat, project: id }));
      item.append(row);
      if (open) {
        const inner = el("ul", "project-chats");
        inner.setAttribute("aria-label", `Chats in ${named}`);
        const chats = projectChats.get(id);
        if (!chats) {
          vscode.postMessage({ type: "chatdgcProjectChats", id });
          const wait = el("li", "project-empty"); wait.textContent = "Loading…"; inner.append(wait);
        } else if (!chats.length) {
          const none = el("li", "project-empty"); none.textContent = "No chats yet: open the project to start one."; inner.append(none);
        } else for (const chat of chats) inner.append(chatRow(chat, true));
        item.append(inner);
      }
      list.append(item);
    }
    const back = list.querySelector(`[data-id="${CSS.escape(focused || "")}"]`);
    if (focused && back) back.focus();
  }
  // Dragged back onto your chats: out of its project.
  for (const target of ["chats-sub", "chats-list"]) {
    const node = $(target);
    if (node) dropTarget(node, (types) => types.includes(CHAT_IN_PROJECT), (chat) => vscode.postMessage({ type: "chatdgcMove", id: chat, project: "" }));
  }
  $("projects-new")?.addEventListener("click", () => vscode.postMessage({ type: "chatdgcProjectNew" }));
  $("chats-library")?.addEventListener("click", () => vscode.postMessage({ type: "chatdgcLibrary" }));
  // Chat | Work: two tabs when ChatDGC is here, so each list has the whole height (stacked, a long list of chats
  // pushed this project's sessions out of sight). The one search covers both, and while it's on, each tab says how
  // much it found. Without ChatDGC (an older CLI) there are no tabs: the sessions, as before.
  let homeTab = (() => { try { return vscode.getState()?.homeTab === "work" ? "work" : "chat"; } catch { return "chat"; } })();
  function homeTabs() {
    const bar = $("home-tabs"), panels = { chat: $("chats-home"), work: $("work-home") };
    if (!bar || !panels.chat || !panels.work) return;
    const tabbed = chatsAvailable;
    bar.hidden = !tabbed;
    $("sessions-host")?.classList.toggle("home-tabbed", tabbed);
    for (const name of ["chat", "work"]) {
      const tab = $(`home-tab-${name}`), panel = panels[name], chosen = homeTab === name;
      tab.setAttribute("aria-selected", String(tabbed && chosen));
      tab.tabIndex = tabbed && chosen ? 0 : -1;
      panel.hidden = tabbed ? !chosen : name === "chat";
      if (tabbed) { panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", `home-tab-${name}`); }
      else { panel.removeAttribute("role"); panel.setAttribute("aria-labelledby", name === "chat" ? "chats-title" : "sessions-title"); }
    }
  }
  // ChatDGC was here last time: Chat | Work show at once, rather than when this window's backend has started. Its
  // answer still decides (renderChats): a CLI without ChatDGC takes the tabs away again.
  if (chatPlace === "home" && document.documentElement.dataset.chatdgcSeen === "1") {
    chatsAvailable = true;
    homeTabs();
    $("sessions-title").textContent = "Work";
    const status = $("chats-status"), search = $("sessions-search");
    if (status) { status.textContent = "Loading your chats…"; status.hidden = false; }
    if (search) { search.hidden = false; search.placeholder = "Search chats and sessions"; search.setAttribute("aria-label", "Search your chats and this project's sessions"); }
  }
  function showHomeTab(name, focus = false) {
    homeTab = name === "work" ? "work" : "chat";
    try { vscode.setState({ ...(vscode.getState() || {}), homeTab }); } catch {}
    homeTabs();
    if (focus) $(`home-tab-${homeTab}`)?.focus();
  }
  /** While a search is on: how many each list found ("12+": more to load). */
  function homeCount(name, found, more) {
    const badge = $(`home-tab-${name}-count`);
    if (!badge) return;
    badge.hidden = found === null;
    badge.textContent = found === null ? "" : `${found}${more ? "+" : ""}`;
    $(`home-tab-${name}`)?.setAttribute("aria-label", found === null ? (name === "chat" ? "Chat" : "Work")
      : `${name === "chat" ? "Chat" : "Work"}: ${found}${more ? " or more" : ""} found`);
  }
  for (const name of ["chat", "work"]) {
    $(`home-tab-${name}`)?.addEventListener("click", () => showHomeTab(name));
    $(`home-tab-${name}`)?.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      showHomeTab(e.key === "Home" ? "chat" : e.key === "End" ? "work" : homeTab === "chat" ? "work" : "chat", true);
    });
  }
  $("chats-new")?.addEventListener("click", () => vscode.postMessage({ type: "chatdgcNew" }));
  $("chats-more")?.addEventListener("click", (e) => {
    e.currentTarget.disabled = true; e.currentTarget.textContent = "Loading…";
    vscode.postMessage({ type: "chatdgcMore" });
  });
  function rememberTab(session) {
    if (chatPlace !== "tab") return;
    const key = document.documentElement.dataset.tabKey || "";
    try { vscode.setState({ ...vscode.getState(), chatTab: { key, session: String(session || "") } }); } catch {}
  }
  document.addEventListener("visibilitychange",()=>pipsApp?.setVisible?.(pipsOpen && pipsViewVisible && !document.hidden));
  // The inline ceilings: what fits in the 4 MiB protocol frame once base64 has inflated it.
  const MAX_IMAGE_FILES = 4, MAX_IMAGE_TOTAL_BYTES = 2 * 1024 * 1024;
  // What a backend that takes images out of band allows instead. The count limit goes entirely --
  // it only ever existed to keep the frame small -- and the budget becomes what a model can be
  // sent rather than what a JSON line can carry. `imageSpool` is set from ready.capabilities.
  const SPOOL_IMAGE_TOTAL_BYTES = 32 * 1024 * 1024;
  let imageSpool = false;
  // An iPhone photo (HEIC/HEIF): Chromium can't show one, but a backend with capabilities.heic_images takes it
  // through the spool and sends the model a JPEG (photos.heic_to_jpeg).
  let heicImages = false;
  const HEIC_IMAGE_TYPES = new Set(["image/heic", "image/heif"]);
  const heicFile = (file) => HEIC_IMAGE_TYPES.has(String(file.type || "").toLowerCase())
    || (!file.type && /\.hei[cf]$/i.test(String(file.name || "")));
  const imageFileCeiling = () => (imageSpool ? Infinity : MAX_IMAGE_FILES);
  const imageByteCeiling = () => (imageSpool ? SPOOL_IMAGE_TOTAL_BYTES : MAX_IMAGE_TOTAL_BYTES);
  const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);
  const PASTED_TEXT_LIMIT = 5000;   // characters; past this a paste becomes an attachment
  let pendingImageFiles = 0, pendingImageBytes = 0;
  let queuedCount = 0, customCommands = [], skillRows = [];
  let skillManagement = false;
  let liveSteering = false, nativeSteering = false;
  // The backend reports its sub-agents as agent frames (capabilities.agents): their lines in the
  // transcript then say what the backend's own spawn notices used to.
  let agentsLive = false;
  // What the agent map may ask for: stopping one agent (`agent_control`; a foreground one only with
  // `agent_control_foreground`), and the background shells with their output (`background_tasks`).
  let agentControlLive = false, agentControlForeground = false, backgroundTasksLive = false;
  let pipReportsLive = false;            // ready.capabilities.pip_reports: Dismiss is saved with the chat
  let pipFixLive = false;                // ready.capabilities.pip_fix: Ask DGC to fix runs in the background
  // Declared up here: the rail's chip line reads them while the panel is still starting up.
  const pipFixes = new Map();            // run_id -> the latest fix record of that report in this chat
  const pipFixSteps = new Map();         // agent id -> what the fixer is doing now ("Running npm test")
  const PIP_FIX_ACTIVE = ["queued", "preparing", "running", "applying"];
  // ready.capabilities.pip_runs_running: which of this chat's Pips are running now, as the backend says (the chip).
  let pipRunsLive = false;
  const pipRunning = new Map();          // run_id -> {run_id, pip_id, name, pip_type, started_at, trigger, at (ms)}
  let steerQueuedLive = false;           // ready.capabilities.steer_queued: a queued message can be steered in now
  // ready.capabilities.turn_files: the CLI counts each turn's Edited card (turn_files, before turn_end), from what the
  // turn's recovery point will restore. Without it the card counts this turn's edit-tool diffs, as it always has.
  let turnFilesLive = false;
  let mcpContextSupported = false, mcpManagement = false, mcpContextSequence = 0, mcpContextPending = "", mcpView = "servers";
  function renderQueued() {
    queuedEl.textContent = queuedCount > 0 ? `${queuedCount} queued` : "";
    // Steer all: every queued message of this chat into the running turn at once.
    const waiting = [...queuedPrompts.values()].filter((entry) => entry.node?.isConnected && !entry.node.querySelector(".steer-now:disabled"));
    if (queuedCount > 1 && steerQueuedLive && waiting.length > 1) {
      const all = el("button", "steer-all", "Steer all");
      all.type = "button";
      all.title = "Send every queued message to the running turn now";
      all.addEventListener("click", () => steerQueuedNow(waiting.map((entry) => entry.node)));
      queuedEl.append(" · ", all);
    }
  }

  // ---- one renderer, two sources ----
  // A restored turn is built by the builders that build a live one -- same classes, same answer
  // promotion, same tool cards -- because a second projection is how the panel came to disagree
  // with itself about what an answer was. `replaying` is the only thing that tells the two apart,
  // and it suppresses exactly what would lie (clocks, spinners, announcements, "new" pills) or
  // cost (posts to the extension host). `appendTarget` is where a new block lands: the transcript
  // live, a detached fragment while a history page is being built.
  let replaying = false, appendTarget = log;

  // permission modes — codicon glyph, one-liner (matches the CLI's mode ladder)
  const MODES = {
    default:     { icon: "shield",    desc: "ask before edits & commands" },
    acceptEdits: { icon: "edit",      desc: "auto-approve file edits" },
    plan:        { icon: "checklist", desc: "read-only — plan first" },
    auto:        { icon: "zap",       desc: "approve everything" },
  };
  const MODE_ORDER = ["default", "acceptEdits", "plan", "auto"];
  const THINK = ["off", "low", "medium", "high", "xhigh"];
  let reasoningControl = "provider";
  function reasoningNote() {
    const detail = reasoningControl === "glm-flash-levels"
      ? "GLM Flash always reasons: Off/Low send Low, Medium/High send High, Extra high/Ultra send Max. DGC’s instructions also vary by profile."
      : reasoningControl === "glm-levels"
      ? "GLM always reasons (with thinking off it writes its reasoning into the answer): Off/Low send Low, Medium and High send those levels, Extra high/Ultra send Max. DGC’s instructions also vary by profile."
      : reasoningControl === "ollama-levels"
      ? "Off turns thinking off. Low, Medium and High are sent as Ollama’s thinking levels and Extra high as Max. A model that grades its thinking follows them; one that does not treats every level as on. DGC’s instructions also vary by profile."
      : reasoningControl === "toggle"
      ? "This model accepts thinking on/off. Low–Extra high change DGC’s instructions, not native reasoning levels."
      : reasoningControl === "levels"
      ? "This model accepts Low, Medium and High. Off uses Low; Extra high uses High with deeper DGC instructions."
      : reasoningControl === "instructions"
      ? "This model has no supported reasoning control. These profiles change DGC’s instructions only."
      : "Native reasoning support depends on the model and provider.";
    return detail + " Ultra adds guidance for deeper work and bounded parallel agents; it cannot guarantee better answers.";
  }
  let curMode = "default", curThink = "off", curModel = "", curSubscription = "", curUltra = false;
  let curWorkers = 4;
  let lastConfig = null;
  let contextBreakdown = null;      // what fills the window, part by part (context_breakdown), once asked for
  // The window a vLLM, SGLang or llama.cpp server was started with (server_window): {window, server, trained}, or null
  // when DGC sizes the window itself. The meter then says the server set it, and how to change it there.
  let serverWindow = null;
  let contextState = { used: 0, size: 0, input_tokens: 0, output_tokens: 0,
    cached_input_tokens: 0, reasoning_tokens: 0, requests: 0, compact_threshold: .85 };
  let lastCompaction = null, compacting = false;

  // The chat's own name, without the "New chat" fallback: the agent map's root says "This chat" then.
  let chatTitleName = "";
  function setThreadTitle(name, sessionId = "", fresh = false) {
    const safeName = String(name || "").replace(/\s+/g, " ").trim();
    chatTitleName = safeName.slice(0, 200);
    const safeId = String(sessionId || "").replace(/[^A-Za-z0-9_-]/g, "");
    const fallback = fresh ? "New chat" : (safeId ? `Chat · ${safeId.slice(-8)}` : "Untitled chat");
    const title = (safeName || fallback).slice(0, 200);
    const node = $("thread-title");
    node.textContent = title;
    node.title = `${title} — click to rename`;
    node.setAttribute("aria-label", `Current chat: ${title}. Click to rename`);
    document.title = `${title} — DGC`;
    agentMapChanged();
  }

  function applyMode(m) {
    if (!MODES[m]) return;
    curMode = m;
    $("cbox").dataset.mode = m; send.dataset.mode = m;
    $("modeicon").className = "codicon codicon-" + MODES[m].icon; $("modelabel").textContent = m;
    $("btn-mode").title = MODES[m].desc + " — Shift+Tab to cycle";
    $("btn-mode").setAttribute("aria-label", `Permission mode: ${m}. ${MODES[m].desc}`);
    paintMonitorsRow();                  // plan mode holds monitor events for the next message
  }
  // The extension host owns the auto-mode confirmation. Update only when the backend
  // echoes mode_changed/state so cancelling the modal cannot leave a false "auto" badge.
  function setMode(m) { vscode.postMessage({ type: "setMode", mode: m }); hideModeMenu(); }
  function cycleMode() { setMode(MODE_ORDER[(MODE_ORDER.indexOf(curMode) + 1) % MODE_ORDER.length]); }
  function hideModeMenu() { $("modemenu").hidden = true; $("btn-mode").setAttribute("aria-expanded", "false"); }
  function toggleModeMenu() {
    const mm = $("modemenu");
    if (!mm.hidden) { hideModeMenu(); return; }
    hideModelMenu(); hideContextMenu(); hideAgentsMenu();
    mm.innerHTML =
      `<div role="group" aria-label="Permission mode"><div class="mhead" role="presentation"><span>Permission mode</span><kbd>⇧Tab</kbd></div>` +
      MODE_ORDER.map((m) => `<button type="button" role="menuitemradio" aria-checked="${m === curMode}" class="mrow${m === curMode ? " sel" : ""}" data-mode="${m}"><span class="mi codicon codicon-${MODES[m].icon}" aria-hidden="true"></span><span>${m}</span><span class="md">${MODES[m].desc}</span></button>`).join("") +
      `</div>`;
    mm.querySelectorAll("[data-mode]").forEach((r) => r.onclick = () => setMode(r.dataset.mode));
    mm.hidden = false; $("btn-mode").setAttribute("aria-expanded", "true");
    (mm.querySelector(".sel") || mm.querySelector("button"))?.focus();
  }

  // in-composer model menu (rendered from the `models` message the extension posts)
  function hideModelMenu() { $("modelmenu").hidden = true; $("btn-model").setAttribute("aria-expanded", "false"); }
  function hideContextMenu() { $("ctxmenu").hidden = true; $("btn-ctx").setAttribute("aria-expanded", "false"); }
  function fmtTokens(n) { return Number(n || 0).toLocaleString(); }
  function compactionLabel(strategy) {
    return ({ provider_native: "Provider-native", model_summary: "Model summary",
      mechanical: "Safe local fallback", tool_prune: "Local tool-output prune",
      none: "No change" })[strategy] || "Not compacted yet";
  }
  // A window as the size menu names it: 262,144 is "256k", 1,048,576 is "1M".
  function windowShort(n) {
    const tokens = Math.max(0, Math.floor(Number(n) || 0));
    if (tokens >= 1048576 && tokens % 1048576 === 0) return `${tokens / 1048576}M`;
    if (tokens >= 1024) return `${Math.round(tokens / 1024)}k`;
    return String(tokens);
  }
  // "256k · this model's max" when the window in use is the model's own maximum, below the one chosen; "8k · set by the
  // server" when it is the window a vLLM or llama.cpp server was started with.
  function modelMaxLabel() {
    const configured = Math.floor(Number(lastConfig?.context_size || 0));
    const effective = Math.floor(Number(contextState.size || 0));
    if (!(configured > 0 && effective > 0 && effective < configured)) return "";
    return `${windowShort(effective)} · ${serverWindow && effective === serverWindow.window ? "set by the server" : "this model's max"}`;
  }
  // How to change a server's window: where it starts, with the option that sizes it.
  const SERVER_WINDOW_OPTIONS = { vllm: ["vLLM", "--max-model-len"], sglang: ["SGLang", "--context-length"], llamacpp: ["llama-server", "-c"] };
  function serverWindowHint(server) {
    const [name, option] = SERVER_WINDOW_OPTIONS[String(server || "").toLowerCase()] || [];
    return name ? `To change it, restart ${name} with ${option}.` : "To change it, restart the server with a larger context.";
  }
  function onServerWindow(ev) {
    const tokens = Math.floor(Number(ev.window) || 0);
    serverWindow = tokens > 0 ? { window: tokens, server: String(ev.server || ""), trained: Math.floor(Number(ev.trained) || 0) } : null;
    renderContext();
  }
  function renderContextMenu() {
    const used = Math.max(0, Number(contextState.used || 0));
    const size = Math.max(0, Number(contextState.size || 0));
    const pct = size ? Math.min(100, Math.round((used / size) * 100)) : 0;
    $("ctx-used").textContent = `${fmtTokens(used)} / ${fmtTokens(size)}`;
    const capped = modelMaxLabel();
    $("ctx-max").textContent = capped;
    $("ctx-max").hidden = !capped || !!serverWindow;     // a server's window: the Window size row below says it
    $("ctx-pct").textContent = `${pct}%`;
    $("ctx-fill").style.width = `${pct}%`;
    $("ctx-free").textContent = `${fmtTokens(Math.max(0, size - used))} free`;
    const threshold = Math.max(.01, Math.min(1, Number(contextState.compact_threshold || .85)));
    const thresholdPct = Math.round(threshold * 100);
    $("ctx-auto").textContent = `auto at ${thresholdPct}%`;
    $("ctx-usage").textContent = `${fmtTokens(contextState.input_tokens)} in · ` +
      `${fmtTokens(contextState.output_tokens)} out · ${fmtTokens(contextState.requests)} requests`;
    syncContextSizeControl();
    // What fills the window, part by part (as Claude's Usage sheet), once the backend has counted it: its bar and its
    // list take the place of the single bar and the free/auto line.
    const parts = contextBreakdown && window.DgcBreakdown ? window.DgcBreakdown.render(contextBreakdown) : null;
    $("ctx-breakdown").replaceChildren(...(parts ? [parts] : []));
    $("ctx-breakdown").hidden = !parts;
    for (const plain of [$("ctxmenu").querySelector(".context-track"), $("ctxmenu").querySelector(".context-split")]) if (plain) plain.hidden = !!parts;
    $("ctx-compact").disabled = compacting;
    $("ctx-compact").textContent = compacting ? "Compacting…" : "Compact now";
    if (lastCompaction) {
      const before = fmtTokens(lastCompaction.before_tokens), after = fmtTokens(lastCompaction.after_tokens);
      $("ctx-last").textContent = `${compactionLabel(lastCompaction.strategy)} · ${before} → ${after}`;
      const detail = String(lastCompaction.fallback_reason || "");
      $("ctx-detail").textContent = detail;
      $("ctx-detail").hidden = !detail;
    } else {
      $("ctx-last").textContent = `DGC compacts automatically near ${thresholdPct}%.`;
      $("ctx-detail").textContent = ""; $("ctx-detail").hidden = true;
    }
  }
  // The window size row shows the configured window; the meter above shows the one in use, which
  // is the smaller of that and the model's own maximum.
  const CONTEXT_SIZES = [8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576];
  function syncContextSizeControl() {
    const select = $("ctx-size"), custom = $("ctx-size-custom"), note = $("ctx-size-note"), served = $("ctx-size-server");
    if (!select || !custom || !note) return;
    if (served) served.hidden = !serverWindow;
    if (serverWindow && served) {
      // The server set it when it started: no sizes to offer that can't apply. DGC's own smaller window (Settings) only
      // decides when it compacts.
      select.hidden = true; custom.hidden = true;
      served.textContent = `Set by the server: ${windowShort(serverWindow.window).replace(/k$/, "K")}`;
      const effective = Math.floor(Number(contextState.size || 0));
      note.hidden = false;
      note.textContent = serverWindowHint(serverWindow.server)
        + (effective > 0 && effective < serverWindow.window ? ` DGC keeps to ${windowShort(effective).replace(/k$/, "K")}, as set in Settings.` : "");
      return;
    }
    select.hidden = false;
    const configured = Math.floor(Number(lastConfig?.context_size || contextState.size || 0));
    if (document.activeElement !== custom && document.activeElement !== select) {
      const known = CONTEXT_SIZES.includes(configured);
      select.value = known ? String(configured) : "custom";
      custom.hidden = known;
      if (!known) custom.value = configured ? String(configured) : "";
    }
    const effective = Math.floor(Number(contextState.size || 0));
    const capped = configured > 0 && effective > 0 && effective < configured;
    note.hidden = !capped;
    note.textContent = capped ? `This model holds ${fmtTokens(effective)} tokens, so DGC uses that.` : "";
  }
  function renderContext() {
    const used = Math.max(0, Number(contextState.used || 0));
    const size = Math.max(0, Number(contextState.size || 0));
    const pct = size ? Math.min(100, Math.round((used / size) * 100)) : 0;
    const threshold = Math.max(.01, Math.min(1, Number(contextState.compact_threshold || .85)));
    $("ctx").textContent = pct + "%";
    $("btn-ctx").classList.toggle("warn", pct >= Math.round(threshold * 100));
    $("btn-ctx").classList.toggle("busy", compacting);
    const capped = modelMaxLabel();
    $("btn-ctx").title = `Context ${fmtTokens(used)} / ${fmtTokens(size)} estimated tokens${capped ? ` (${capped})` : ""} · ` +
      `provider ${fmtTokens(contextState.input_tokens)} in / ${fmtTokens(contextState.output_tokens)} out · ` +
      `${fmtTokens(contextState.cached_input_tokens)} cached · ${fmtTokens(contextState.reasoning_tokens)} reasoning · ` +
      `${fmtTokens(contextState.requests)} requests · click for details`;
    $("btn-ctx").setAttribute("aria-label", `Context used: ${pct} percent; open context details`);
    renderContextMenu();
  }
  // ---- the prompt cache's clock (0.48, Work only; dgc/cache_clock.py) ----------------------------------
  // Copied from Claude Code: unknown -> hidden; warm -> a clock and the whole minutes left ("4m"), changed
  // at most once a minute (no seconds, no animation); gone -> the clock alone in the error colour. Shown
  // only where the backend knows it from the provider itself (Anthropic's own cache report, a local
  // Ollama's /api/ps), after a reply that used a cache. Reopening a chat whose cache has gone says so once.
  let cacheClock = null, cacheClockTimer = null;
  const cacheClockNoted = new Set();
  function cacheIdle(ms) {
    const minutes = Math.max(0, Math.floor(ms / 60000));
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  }
  function cacheTokens(n) {
    return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  }
  function cacheWindow(now = Date.now()) {
    const c = cacheClock;
    if (!c || !["warm", "cold"].includes(c.state)) return { kind: "unknown" };
    const anchor = Number(c.anchor_ms) || now, idleMs = Math.max(0, now - anchor);
    const tokens = Number(c.tokens) > 0 ? Number(c.tokens) : undefined;
    if (c.state === "cold") return { kind: "cold", reason: c.reason || "expired", idleMs, tokens, source: c.source };
    if (!c.expires_ms) return { kind: "warm", kept: true };
    const ttl = Number(c.ttl_s) > 0 ? Number(c.ttl_s) * 1000 : Infinity;
    const left = Math.min(ttl, Number(c.expires_ms) - now);
    if (left > 0) return { kind: "warm", msLeft: left, minutesLeft: Math.ceil(left / 60000) };
    return { kind: "cold", reason: c.source === "ollama" ? "unloaded" : "expired", idleMs, tokens, source: c.source };
  }
  function cacheLeftText(win) {
    if (win.kind !== "warm" || win.kept) return "";
    return win.minutesLeft < 60 ? `${win.minutesLeft}m` : `${Math.floor(win.minutesLeft / 60)}h`;
  }
  function cacheTooltip(win) {
    if (win.kind === "warm") {
      if (win.kept) return "Prompt cache warm: Ollama keeps the model loaded.";
      const m = win.minutesLeft;
      return `Prompt cache warm, about ${m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`} left.`;
    }
    if (win.kind !== "cold") return "";
    if (win.reason === "compacted") return "Prompt cache does not cover the compacted conversation.";
    if (win.reason === "unloaded") return `Prompt cache expired: Ollama unloaded the model (idle ${cacheIdle(win.idleMs)}).`;
    return `Prompt cache likely expired (idle ${cacheIdle(win.idleMs)}).`;
  }
  function cacheReopenNote(win) {
    if (win.kind !== "cold") return "";
    if (win.reason === "compacted") return "The conversation was compacted, so your next message will re-cache it.";
    const what = win.tokens === undefined ? "the conversation" : `about ${cacheTokens(win.tokens)} tokens`;
    return `Idle ${cacheIdle(win.idleMs)}. The prompt cache has likely expired, so your next message will re-cache ${what}.`;
  }
  function renderCacheClock() {
    const node = $("cache-clock");
    if (!node) return;
    if (cacheClockTimer) { clearTimeout(cacheClockTimer); cacheClockTimer = null; }
    const win = cacheWindow();
    node.hidden = win.kind === "unknown";
    node.dataset.cacheWindow = win.kind;
    node.classList.toggle("cold", win.kind === "cold");
    $("cache-clock-left").textContent = cacheLeftText(win);
    const tip = cacheTooltip(win);
    node.title = tip;
    if (tip) node.setAttribute("aria-label", tip); else node.removeAttribute("aria-label");
    // The next change is the next whole minute (or the moment it runs out): one wake-up, never a tick.
    if (win.kind === "warm" && !win.kept) {
      cacheClockTimer = setTimeout(renderCacheClock, win.msLeft - (win.minutesLeft - 1) * 60000 + 50);
    }
  }
  function onCacheClock(ev) {
    cacheClock = { ...ev };
    renderCacheClock();
    if (ev.resumed !== true) return;
    const note = cacheReopenNote(cacheWindow());
    const key = `${ev.session_id || ""}:${ev.anchor_ms || ""}:${ev.reason || ""}`;
    if (note && !cacheClockNoted.has(key)) { cacheClockNoted.add(key); sysLine(note); }
  }
  function cacheClockOnSessionReset() { cacheClock = null; renderCacheClock(); }
  // A cold clock's "idle" is read when you look at it, not counted on screen.
  $("cache-clock")?.addEventListener("mouseenter", () => { if (cacheWindow().kind === "cold") renderCacheClock(); });
  function toggleContextMenu() {
    const menu = $("ctxmenu");
    if (!menu.hidden) { hideContextMenu(); return; }
    hideModelMenu(); hideModeMenu(); hideAgentsMenu(); renderContextMenu();
    menu.hidden = false; $("btn-ctx").setAttribute("aria-expanded", "true");
    vscode.postMessage({ type: "contextBreakdown" });            // what fills it, part by part, as it opens
    $("ctx-compact").focus();
  }
  function effortLabel(value, subscription = curSubscription) {
    return ({ off: subscription ? "Default" : "Off", low: "Low", medium: "Medium",
      high: "High", xhigh: "Extra high", max: "Maximum", ultra: "Ultra" })[value] || value;
  }
  function profileMenu(subscription, supportsEffort) {
    const levels = subscription && supportsEffort === false ? ["off"]
      : subscription && curSubscription !== "codex" ? [...THINK, "max"] : THINK;
    const profiles = [...levels, "ultra"];
    const selected = curUltra ? "ultra" : curThink;
    const index = Math.max(0, profiles.indexOf(selected));
    return `<section class="reasoning-card${curUltra ? " is-ultra" : ""}" aria-label="Model and reasoning"><button type="button" class="mrow model-summary" aria-expanded="false"><span class="codicon codicon-zap" aria-hidden="true"></span><span class="model-summary-label">${esc(curModel || "Select model")} <span class="muted">${effortLabel(selected, subscription)}</span></span><span class="codicon codicon-chevron-right" aria-hidden="true"></span></button><div class="effort-control" style="--effort:${index / (profiles.length - 1) * 100}%"><input class="effort-slider" type="range" min="0" max="${profiles.length - 1}" step="1" value="${index}" data-profiles="${profiles.join(",")}" aria-label="Thinking effort" aria-valuetext="${effortLabel(selected, subscription)}"/><div class="effort-labels"><span>${effortLabel(profiles[0], subscription)}</span><output>${effortLabel(selected, subscription)}</output><span>Ultra</span></div></div><p class="reasoning-note clamped">${esc(subscription ? "Uses the selected CLI’s supported effort. Ultra adds DGC orchestration guidance." : reasoningNote())}</p><button type="button" class="reasoning-more" aria-expanded="false" hidden>Show more</button></section>`;
  }
  // The note under the slider is three lines at most, with Show more when there is more to read: a
  // long one (Ollama's levels) took over the menu. Measured once the menu is on screen.
  function bindNote(card) {
    const note = card.querySelector(".reasoning-note"), more = card.querySelector(".reasoning-more");
    if (!note || !more) return;
    const measure = () => {
      if (!note.classList.contains("clamped")) return;
      const laidOut = note.clientHeight > 0;
      more.hidden = laidOut ? note.scrollHeight <= note.clientHeight + 1 : note.textContent.length <= 160;
      note.classList.toggle("has-more", !more.hidden);
    };
    more.onclick = (e) => {
      e.stopPropagation();
      const open = note.classList.toggle("clamped") === false;
      more.textContent = open ? "Show less" : "Show more";
      more.setAttribute("aria-expanded", String(open));
    };
    measure();
    requestAnimationFrame(measure);
  }
  function bindProfiles(mm) {
    const card = mm.querySelector(".reasoning-card"), slider = mm.querySelector(".effort-slider");
    bindNote(card);
    const options = el("div", "model-options"); options.hidden = true;
    [...mm.children].filter(node => node !== card).forEach(node => options.appendChild(node));
    mm.appendChild(options);
    const toggle = card.querySelector(".model-summary");
    toggle.onclick = () => {
      options.hidden = !options.hidden;
      toggle.setAttribute("aria-expanded", String(!options.hidden));
      card.querySelector(".effort-control").hidden = !options.hidden;
      if (!options.hidden) (options.querySelector(".sel") || options.querySelector("button"))?.focus();
    };
    slider.oninput = () => {
      const profiles = slider.dataset.profiles.split(","), value = profiles[Number(slider.value)];
      slider.parentElement.style.setProperty("--effort", `${Number(slider.value) / (profiles.length - 1) * 100}%`);
      slider.setAttribute("aria-valuetext", effortLabel(value));
      card.querySelector("output").textContent = effortLabel(value);
      // Acknowledge the step. Restarting the class is what replays the keyframe.
      const control = slider.parentElement;
      control.classList.remove("bumped");
      void control.offsetWidth;
      control.classList.add("bumped");
    };
    slider.onchange = () => {
      vscode.postMessage({ type: "setReasoningProfile", level: slider.dataset.profiles.split(",")[Number(slider.value)] });
      hideModelMenu();
    };
  }
  function renderModelMenu(ids, current, err, subscription, label, supportsEffort) {
    const mm = $("modelmenu");
    const profile = profileMenu(subscription, supportsEffort);
    if (subscription) {
      mm.innerHTML = profile + `<div class="mhead"><span>${esc(label || "Subscription")} model</span></div>`
        + `<button type="button" role="menuitemradio" aria-checked="${!current}" class="mrow${!current ? " sel" : ""}" data-default="1"><span class="mi ${!current ? "codicon codicon-check" : ""}" aria-hidden="true"></span><span>CLI default</span></button>`
        + ids.map((id, i) => `<button type="button" role="menuitemradio" aria-checked="${id === current}" class="mrow${id === current ? " sel" : ""}" data-i="${i}"><span class="mi ${id === current ? "codicon codicon-check" : ""}" aria-hidden="true"></span><span>${esc(id)}</span></button>`).join("")
        + `<button type="button" role="menuitem" class="mrow" data-custom="1"><span class="mi codicon codicon-edit" aria-hidden="true"></span><span>Enter another model…</span></button>`;
      bindProfiles(mm);
      mm.querySelector("[data-default]").onclick = () => { vscode.postMessage({ type: "setModel", model: "" }); hideModelMenu(); };
      mm.querySelectorAll("[data-i]").forEach((r) => r.onclick = () => { vscode.postMessage({ type: "setModel", model: ids[+r.dataset.i] }); hideModelMenu(); });
      mm.querySelector("[data-custom]").onclick = () => { vscode.postMessage({ type: "pickModel" }); hideModelMenu(); };
      mm.hidden = false; $("btn-model").setAttribute("aria-expanded", "true");
      mm.querySelector(".model-summary")?.focus(); return;
    }
    if (err || !ids.length) {
      mm.innerHTML = profile + `<button type="button" role="menuitem" class="mrow" data-connect="1"><span class="mi codicon codicon-plug" aria-hidden="true"></span><span>${err ? "Can’t reach endpoint — connect…" : "No models — connect…"}</span></button>`;
      bindProfiles(mm);
      mm.querySelector("[data-connect]").onclick = () => { vscode.postMessage({ type: "connect" }); hideModelMenu(); };
      mm.hidden = false; $("btn-model").setAttribute("aria-expanded", "true"); mm.querySelector("button")?.focus(); return;
    }
    mm.innerHTML = profile + `<div class="mhead"><span>Model</span></div>` +
      ids.map((id, i) => `<button type="button" role="menuitemradio" aria-checked="${id === current}" class="mrow${id === current ? " sel" : ""}" data-i="${i}"><span class="mi ${id === current ? "codicon codicon-check" : ""}" aria-hidden="true"></span><span>${esc(id)}</span></button>`).join("");
    bindProfiles(mm);
    mm.querySelectorAll("[data-i]").forEach((r) => r.onclick = () => { vscode.postMessage({ type: "setModel", model: ids[+r.dataset.i] }); hideModelMenu(); });
    mm.hidden = false; $("btn-model").setAttribute("aria-expanded", "true");
    mm.querySelector(".model-summary")?.focus();
  }

  // "xhigh" capitalised reads "Xhigh", which is not a thing. Spell the profiles out.
  const EFFORT_LABEL = { off: "Off", low: "Low", medium: "Medium", high: "High",
                         xhigh: "Extra High", max: "Max", default: "Default" };

  function updateModelControl() {
    const model = curModel || "dgc";
    const raw = curUltra ? "Ultra" : (curSubscription && curThink === "off" ? "default" : curThink);
    const effort = EFFORT_LABEL[raw] || raw;
    $("modelname").textContent = model;
    $("effortname").textContent = effort;
    $("btn-model").classList.toggle("ultra", curUltra);
    $("btn-model").title = `${model} · ${effort} reasoning — click to change`;
    $("btn-model").setAttribute("aria-label", `Change model and reasoning. Current model: ${model}. Profile: ${effort}.`);
  }

  function menuKeys(menu, close, trigger, e) {
    if (e.key === "Escape") { e.preventDefault(); close(); trigger.focus(); return; }
    if (e.target.matches?.("input[type=range]")) return;
    const items = [...menu.querySelectorAll("button[role^='menuitem']")].filter(item => !item.closest("[hidden]"));
    if (!items.length) return;
    const current = Math.max(0, items.indexOf(document.activeElement));
    let next = null;
    if (e.key === "ArrowDown") next = (current + 1) % items.length;
    else if (e.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next !== null) { e.preventDefault(); items[next].focus(); }
  }
  $("modemenu").addEventListener("keydown", (e) => menuKeys($("modemenu"), hideModeMenu, $("btn-mode"), e));
  $("modelmenu").addEventListener("keydown", (e) => menuKeys($("modelmenu"), hideModelMenu, $("btn-model"), e));

  // animated DGC mark — the three stripes light up one-by-one, hold all three,
  // then repeat (CSS-driven, ~1.2s loop, single purple). Replaces the old braille
  // spinner; the reduced-motion case (in main.css) renders all three lit + static.
  const MARK = '<svg class="tmark" viewBox="0 0 90 90" fill="currentColor" aria-hidden="true">'
    + '<path class="s1" d="M32 24 L20 30 L13 72 L25 66 Z"/>'
    + '<path class="s2" d="M54 18 L42 24 L35 72 L47 66 Z"/>'
    + '<path class="s3" d="M76 24 L64 30 L57 66 L69 60 Z"/></svg>';
  // Transcript icons. One thin outline set for everything that describes WORK in the conversation:
  // the tool-group header, every tool card, diffs, cards, notices. VS Code's own codicons stay on
  // panel chrome (header, composer, menus, settings), where they read as the editor's furniture.
  // The geometry is Lucide 1.24.0's, verbatim, on its 24x24 grid: fill none, stroke currentColor,
  // round caps and joins, so an icon is exactly the colour of the words beside it and nothing else.
  // Inline markup, not a font or a file: a <svg> in the DOM is not a CSP resource load.
  // Lucide is ISC-licensed (some icons Feather-derived, MIT). See THIRD_PARTY_NOTICES.md and
  // licenses/LUCIDE-LICENSES.txt.
  const ICON_PATHS = {
    "activity": '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
    "app-window": '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>',
    "blocks": '<path d="M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2"/><rect x="14" y="2" width="8" height="8" rx="1"/>',
    "book-open": '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    "bookmark": '<path d="M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z"/>',
    "bot": '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
    "braces": '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
    "circle-alert": '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    "circle-check": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    "circle-help": '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',  // circle-question-mark
    "circle-slash": '<circle cx="12" cy="12" r="10"/><line x1="9" x2="15" y1="15" y2="9"/>',
    "clipboard-list": '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
    "code": '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
    "external-link": '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    "file-diff": '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M9 10h6"/><path d="M12 13V7"/><path d="M9 17h6"/>',
    "file-plus": '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M9 15h6"/><path d="M12 18v-6"/>',
    "file-text": '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    "folder-tree": '<path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M3 5a2 2 0 0 0 2 2h3"/><path d="M3 3v13a2 2 0 0 0 2 2h3"/>',
    "globe": '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    "history": '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    "image": '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    "image-off": '<line x1="2" x2="22" y1="2" y2="22"/><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/><line x1="13.5" x2="6" y1="13.5" y2="21"/><line x1="18" x2="21" y1="12" y2="15"/><path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"/><path d="M21 15V5a2 2 0 0 0-2-2H9"/>',
    "list-todo": '<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><rect x="3" y="4" width="6" height="6" rx="1"/>',
    "message-square": '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/>',
    "notebook-pen": '<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/>',
    "pencil": '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    "play": '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
    "refresh-cw": '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    "search": '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
    "shield": '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    "shield-plus": '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M9 12h6"/><path d="M12 9v6"/>',
    "sparkle": '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/>',
    "square-pen": '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>',
    "square-terminal": '<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>',
    "target": '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    "triangle-alert": '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    "wrench": '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/>',
  };
  const ICON_STROKE = { md: 2, xs: 2, lg: 1.5 };   // painted 1.167 / 1.000 / 1.250 CSS px
  // The box is sized in CSS (--icon / --icon-xs / --icon-lg), so the stroke scales with it.
  function icon(name, size = "md") {
    // Resolve the key BEFORE writing it. data-icon is the handle everything else goes by — the
    // tests, the render census, a reader's grep — so it has to name the artwork actually drawn.
    // Emitting the name that was ASKED for meant a typo in one of the tables or at one of the
    // call sites would paint the fallback while still claiming to be the icon it missed, and
    // every assertion in the suite would pass.
    const key = ICON_PATHS[name] ? name : ICON_FALLBACK;
    const body = ICON_PATHS[key];
    return `<svg class="ic ic-${size}" data-icon="${key}" viewBox="0 0 24 24"`
      + ` fill="none" stroke="currentColor" stroke-width="${ICON_STROKE[size] || 2}"`
      + ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  }
  // Draw an icon into a stable wrapper, and only when it actually changed: re-setting the markup
  // on every event would restart the running group's CSS pulse and make the header stutter.
  // Every wrapper that repaints is a --icon one; a size here would only ever be wrong silently.
  function setIcon(wrap, name) {
    const key = ICON_PATHS[name] ? name : ICON_FALLBACK;   // the wrapper's handle never lies either
    if (!wrap || wrap.dataset.icon === key) return wrap;
    wrap.dataset.icon = key;
    wrap.innerHTML = icon(key);
    return wrap;
  }
  // What kind of step this is. The header of a group and the cards under it speak the same
  // vocabulary, so a book in the header is visibly the same mark as the Read card beneath it.
  const TOOL_ICON = {
    read_file: "book-open", glob: "search", grep: "search", repo_map: "folder-tree",
    code_intel: "braces", git_diff: "file-diff", write_file: "file-plus", create_file: "file-plus",
    edit_file: "pencil", apply_patch: "pencil", multi_edit: "pencil", save_memory: "bookmark", remember: "bookmark", forget: "bookmark",
    bash: "square-terminal", bash_output: "square-terminal", bash_kill: "square-terminal", python: "code",
    web_search: "globe", web_fetch: "globe", browser: "globe", view_image: "image",
    present_plan: "clipboard-list", present_document: "file-text", propose_options: "circle-help",
    task: "bot", todo: "list-todo", skill: "sparkle", add_skill: "sparkle", notes: "notebook-pen",
    monitor: "activity", monitor_stop: "activity", artifact: "app-window", update_goal: "target",
    // Supervising sub-agents. Steering one wears a fixed mark, never the agent's own face: the
    // row is about the parent talking to it.
    list_tasks: "bot", wait_tasks: "bot", message_task: "message-square", close_task: "circle-slash",
    // DGC's own MCP broker, exposed when a server's catalog is too large to inline (dgc/agent.py).
    // It is the same route as an mcp__server__tool call, so it wears the same mark.
    mcp_call: "blocks", mcp_search: "blocks",
  };
  // The group header's icon, per bucket (see TOOL_BUCKET): it wears the leading action of the
  // sentence it already prints, so "Read files, ran a command" is a book and not a terminal.
  const BUCKET_ICON = {
    read: "book-open", edited: "pencil", created: "file-plus", ran: "square-terminal",
    searched: "search", mapped: "folder-tree", looked: "globe", viewed: "image", web: "globe",
    other: "wrench",
  };
  const ICON_FALLBACK = "wrench";        // the one deliberately generic mark: "no better word"
  function canonicalTool(name) {
    const plain = String(name || "").replace(/^functions\./, "").toLowerCase();
    return ({ read: "read_file", write: "write_file", edit: "edit_file", shell: "bash",
      exec_command: "bash", shell_command: "bash", search: "grep",
      // The Claude engine's own names, which used to fall through to "Used tool" and a fallback mark.
      multiedit: "multi_edit", bashoutput: "bash_output", killshell: "bash_kill",
      webfetch: "web_fetch", websearch: "web_search", todowrite: "todo",
      notebookedit: "edit_file", exitplanmode: "present_plan",
      askuserquestion: "propose_options",
      // A vendor engine's own name for writing a file (dgc/subscriptions.py knows it too).
      writefile: "write_file" })[plain] || plain;
  }
  // An MCP server's tool, however the engine spells it: DGC's mcp__server__tool, the bare name
  // "mcp", or the Codex engine's server.tool. The dotted form only ever applies to a name DGC has
  // no mapping for, so it can never shadow a real tool. More than one dot, because a server is
  // named by the user against [A-Za-z0-9][A-Za-z0-9_.-]{0,63} and "sentry.io" or "api.github.com"
  // are perfectly ordinary names — "sentry.io.list_issues" is still one server's tool.
  function isMcpName(name) {
    const plain = canonicalTool(name);
    return plain === "mcp" || String(name || "").startsWith("mcp__")
      || (!TOOL_ICON[plain] && /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/.test(plain));
  }
  const iconForTool = (name) => TOOL_ICON[canonicalTool(name)] || (isMcpName(name) ? "blocks" : ICON_FALLBACK);
  const TOOL_COPY = {
    read_file: ["Reading", "Read"], glob: ["Finding files", "Found files"], repo_map: ["Mapping repository", "Mapped repository"],
    // The CLI's own word for it (dgc/ui.py's activity verbs), so both surfaces name the step alike.
    code_intel: ["Reading code structure", "Read code structure"],
    git_diff: ["Inspecting changes", "Inspected changes"],
    write_file: ["Writing", "Wrote"], create_file: ["Creating", "Created"],
    edit_file: ["Editing", "Edited"], multi_edit: ["Editing", "Edited"],
    apply_patch: ["Applying patch", "Applied patch"], save_memory: ["Saving memory", "Saved memory"],
    remember: ["Remembering", "Remembered"], forget: ["Forgetting", "Forgot"],
    bash: ["Running", "Ran"], bash_output: ["Checking process", "Checked process"], bash_kill: ["Stopping process", "Stopped process"],
    grep: ["Searching", "Searched"], web_search: ["Searching the web", "Searched the web"], web_fetch: ["Fetching", "Fetched"],
    view_image: ["Viewing image", "Viewed image"], browser: ["Using browser", "Used browser"],
    present_plan: ["Preparing plan", "Prepared plan"],
    present_document: ["Preparing document", "Prepared document"],
    propose_options: ["Asking", "Asked"],
    task: ["Delegating", "Delegated"], todo: ["Updating plan", "Updated plan"], skill: ["Loading skill", "Loaded skill"],
    list_tasks: ["Checking sub-agents", "Checked sub-agents"],
    wait_tasks: ["Waiting for a sub-agent", "Waited for a sub-agent"],
    // The parent steering a child it started; the card's detail is that child, by what it was
    // asked to do (the backend resolves it from the id): "Sent message to Write the parser".
    message_task: ["Sending message to", "Sent message to"],
    close_task: ["Stopping", "Stopped"],
  };
  // A lone step names itself in its group's sentence, and a folded group shows only that sentence.
  // These two take their object from the card's detail -- the agent, by what it was asked to do --
  // so the sentence carries it, in both tenses: "Sent message to Write the parser", where it used
  // to say "Used 1 tool". Without a detail they fall back to the CLI's own words (dgc/ui.py).
  // A delegation names the agent it started the same way: a spawn no agent line has taken (an older
  // CLI, a task that was refused or never started, an agent the backend stopped listing) reads
  // "Delegated Write the parser", which is also what a reload of it draws.
  const NAMES_ITS_AGENT = new Set(["message_task", "close_task", "task"]);
  const LONE_PRESENT = { message_task: "messaging a sub-agent", close_task: "stopping a sub-agent",
    task: "delegating to a sub-agent" };
  function pluginLogoHtml(name) {
    const match = /^mcp__([a-z0-9_-]+)__/.exec(String(name || ""));
    const src = match && pluginLogos[match[1]];
    return src ? `<img class="plugin-logo" alt="" src="${esc(src)}">` : "";
  }
  function toolCopy(name) {
    const known = TOOL_COPY[canonicalTool(name)];
    if (known) return { present: known[0], past: known[1], target: "" };
    if (String(name).startsWith("mcp__")) {
      return { present: "Calling MCP tool", past: "Called MCP tool",
        target: String(name).slice(5).replaceAll("__", " · ").replaceAll("_", " ") };
    }
    return { present: "Using tool", past: "Used tool", target: String(name || "tool").replaceAll("_", " ") };
  }
  let builtinCommands = [
    { name: "model", description: "pick the model", action: "pickModel" },
    { name: "connect", description: "provider or a custom LAN host", action: "connect" },
    { name: "mode", description: "permission mode", action: "pickMode" },
    { name: "think", description: "how hard the model reasons", action: "pickThink" },
    { name: "ultra", description: "deep reasoning + bounded parallel agents", action: "toggleUltra" },
    { name: "goal", description: "inspect, set, pause, resume, or clear the standing objective", action: "goal", accepts_args: true },
    { name: "plan", description: "enter read-only mode and plan a task", action: "workflow:plan", accepts_args: true },
    { name: "review", description: "review changes for bugs and regressions", action: "workflow:review", accepts_args: true },
    { name: "init", description: "inspect the project and prepare DGC.md", action: "workflow:init", accepts_args: true },
    { name: "view-plan", description: "reopen the saved plan", action: "viewPlan" },
  ];

  // `/agents` is the agent map, opened in the panel (the CLI's own /agents opened the sub-agent
  // settings, which the map links to). `/tasks` keeps its meaning: retained worktrees.
  function agentMapCommands(list) {
    const entry = { name: "agents", description: "open the agent map: every agent and background task in this chat", action: "agentMap" };
    const out = list.map((c) => (c && c.name === "agents" ? { ...c, ...entry, accepts_args: false } : c));
    return out.some((c) => c && c.name === "agents") ? out : [...out, entry];
  }
  let streaming = false, turn = null;
  let viewerStreaming = null;          // set by the image viewer: keeps its Stop in step with the turn
  // A custom slash command sent while idle shows Stop before its turn exists. Holds the command's
  // name until that turn starts or the backend answers that command with an error or refusal.
  let customCommandPending = "";
  const attachments = [];
  let pipReferencesSupported = false;
  // Pips are on and can take a setup card from this chat: an answer offers "Make this a Pip".
  let pipsOffered = false;
  const pipPicker = { active: false, id: "", query: "", rows: [], cursor: null, workspace: "", loading: false, error: "", emptyLabel:"", timer: null, timeout: null };
  function validPipReference(p) {
    return p && typeof p === "object" && !Array.isArray(p)
      && typeof p.pip_id === "string" && /^pip_[a-f0-9]{32}$/.test(p.pip_id) && p.pip_id.length === 36
      && typeof p.workspace_id === "string" && /^ws_[a-f0-9]{32}$/.test(p.workspace_id) && p.workspace_id.length === 35
      && typeof p.name === "string" && p.name.length > 0 && [...p.name].length <= 160 && new TextEncoder().encode(p.name).length <= 640
      && ["core","scout","lens","patch","rook","pulse","lock","quill"].includes(p.pip_type)
      && ["active","paused","archived"].includes(p.status)
      && Number.isSafeInteger(p.job_version) && p.job_version >= 1 && p.job_version <= 999999
      && Number.isSafeInteger(p.lifecycle_revision) && p.lifecycle_revision >= 0;
  }
  function clearPipPicker() {
    clearTimeout(pipPicker.timer); clearTimeout(pipPicker.timeout); Object.assign(pipPicker, {active:false,id:"",query:"",rows:[],cursor:null,workspace:"",loading:false,error:"",emptyLabel:"",timer:null});
  }
  function pipReferenceLabel(p) { return `@${p.name.replace(/\s+/g," ")} · Pip v${p.job_version}`; }

  let promptSequence = 0;
  const promptPrefix = `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const pendingPrompts = new Map();
  // Prompts the backend acknowledged as queued, in the order they will run. They used to be
  // dropped from pendingPrompts on that acknowledgement, so a backend that stopped before running
  // them lost the user's words with no way to restore them.
  const queuedPrompts = new Map();
  // Queued prompts given back as not sent (Stop, a backend exit, DGC: Restart Backend). A backend
  // being brought back clears the transcript to replay the chat, which took their bubbles with it;
  // they are kept until that reconnect is done and put back under the replay. The ids also stop the
  // extension, which hands back what a dead backend held, from giving the same message back twice.
  const returnedPrompts = [];            // { node, session }
  const returnedIds = new Set();
  const returnedNodes = new Map();       // id -> its bubble, whose own Restore makes a second notice redundant
  let reconnectPending = false;
  const draftScope = document.documentElement.dataset.draftScope || "";
  const draftEntries = new Map();
  const pendingImages = new Set();
  let draftSession = "unbound", sessionReady = !draftScope, draftTimer = null, restoringDraft = false;
  let goalDraftArmed = false;
  // The Tasks row: which chats keep the checklist expanded (keyed by session id; a chat never seen
  // starts collapsed), a Clear waiting for the backend's answer, and whether a backend is up.
  const tasksExpanded = new Set();
  // `backendDown`: the backend exited and the extension is not bringing it back on its own.
  let todoClear = null, backendLive = false, backendDown = false;
  // The exit line of a backend that is being brought back, kept until the reconnect has replayed
  // the chat it belongs to (see the "session" event).
  let backendExitNotice = null;
  let draftWarning = false, unconfirmedDrafts = [];
  const DRAFT_STORAGE_BYTES = 8 * 1024 * 1024;
  function cleanDraft(value) {
    if (!value || typeof value !== "object" || typeof value.text !== "string" || value.text.length > 1_000_000
        || !Array.isArray(value.attachments) || value.attachments.length > 64) return null;
    try {
      if (JSON.stringify(value).length > 4 * 1024 * 1024) return null;
      const items = [];
      for (const source of value.attachments) {
        if (!source || typeof source !== "object" || typeof source.label !== "string" || source.label.length > 8192) return null;
        const item = { label: source.label };
        if (source.pipReference) {
          if (!validPipReference(source.pipReference) || items.filter(a => a.pipReference).length >= 8
              || items.some(a => a.pipReference?.pip_id === source.pipReference.pip_id)) return null;
          item.pipReference = {...source.pipReference}; item.label = pipReferenceLabel(item.pipReference);
        } else if (source.skill || source.template) {
          const key = source.skill ? "skill" : "template";
          if (typeof source[key] !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(source[key])) return null;
          item[key] = source[key];
        } else if (source.img) {
          if (typeof source.data !== "string" || !/^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/.test(source.data)) return null;
          item.img = true; item.data = source.data; item.bytes = Math.max(0, Number(source.bytes) || 0);
        } else if (source.resource && typeof source.resource === "object") {
          item.resource = JSON.parse(JSON.stringify(source.resource));
        } else if (typeof source.pasted === "string" && source.pasted.length <= 1_000_000) {
          // A long paste folded into a chip is part of the draft; dropping it lost the whole draft.
          item.pasted = source.pasted; item.chars = source.pasted.length;
        } else return null;
        items.push(item);
      }
      const text = value.text;
      const start = Math.max(0, Math.min(text.length, Number(value.start) || 0));
      const end = Math.max(start, Math.min(text.length, Number(value.end) || start));
      const clean = { text, attachments: items, start, end,
        updated: Number(value.updated) || Date.now() };
      if (value.goal === true) clean.goal = true;
      return clean;
    } catch { return null; }
  }
  function captureDraft() {
    return { text: composerText(), attachments: [...attachments], start: composerSelection()[0],
      end: composerSelection()[1], goal: goalDraftArmed, updated: Date.now() };
  }
  function persistDraft() {
    if (restoringDraft) return;
    clearTimeout(draftTimer); draftTimer = null;
    const current = captureDraft();
    if (current.text || current.attachments.length || current.goal) draftEntries.set(draftSession, current);
    else draftEntries.delete(draftSession);
    const entries = [], pending = [];
    let bytes = 0, omitted = false;
    for (const row of unconfirmedDrafts) {
      const draft = cleanDraft(row.draft);
      const clean = draft && { ...row, draft };
      const size = clean ? new TextEncoder().encode(JSON.stringify(clean)).length : DRAFT_STORAGE_BYTES + 1;
      if (!clean || bytes + size > DRAFT_STORAGE_BYTES || pending.length >= 17) { omitted = true; continue; }
      pending.push(clean); bytes += size;
    }
    const ordered = [...draftEntries].sort((a, b) => (b[0] === draftSession) - (a[0] === draftSession)
      || b[1].updated - a[1].updated);
    for (const [session, draft] of ordered) {
      const clean = cleanDraft(draft);
      const size = clean ? new TextEncoder().encode(JSON.stringify(clean)).length : DRAFT_STORAGE_BYTES + 1;
      if (!clean || entries.length >= 32 || bytes + size > DRAFT_STORAGE_BYTES) { omitted = true; continue; }
      entries.push([session, clean]); bytes += size;
    }
    for (const [id, request] of pendingPrompts) {
      if (request.acknowledged) continue;      // the backend has it; the extension gives it back if lost
      const draft = cleanDraft({ text: request.text, attachments: request.attachments,
        start: 0, end: request.text.length, goal: request.goal === true });
      const size = draft ? new TextEncoder().encode(JSON.stringify(draft)).length : DRAFT_STORAGE_BYTES + 1;
      if (!draft || bytes + size > DRAFT_STORAGE_BYTES || pending.length >= 17) { omitted = true; continue; }
      pending.push({ id, session: request.session || draftSession, draft }); bytes += size;
    }
    // Which chats keep their checklist open: webview-local, like the drafts, and bounded the same way.
    const tasksOpen = [...tasksExpanded].slice(-32);
    try { vscode.setState({ ...vscode.getState(), version: 1, scope: draftScope, active: draftSession, entries, pending, tasksOpen }); }
    catch { omitted = true; }
    if (omitted && !draftWarning) {
      draftWarning = true;
      sysLine("Some drafts exceed saved-draft storage limits and remain only in this window. Send or reduce them before reloading.", true);
    }
  }
  function scheduleDraftSave() {
    if (restoringDraft) return;
    clearTimeout(draftTimer); draftTimer = setTimeout(persistDraft, 150);
  }
  function selectDraftSession(session, adoptFrom = "") {
    if (typeof session !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(session)) return;
    // The same chat announced again is not a switch. `session_ready` goes out on every webview
    // repaint (panel.ts:769) and on every backend handshake (:941), both carrying the CURRENT
    // session id -- so a crashed backend coming back, or a `dgc serve` restart, used to run the
    // whole restore below against the chat the user was already in. setComposerValue rebuilds the
    // draft from serialized text, and a pill serializes to "", so every pill in a draft being
    // typed vanished with no user action and nothing on screen saying why. There is nothing to
    // restore here: persistDraft has been keeping this chat's entry and the box in step.
    if (session === draftSession && !adoptFrom) return;
    persistDraft();
    const prior = draftSession;
    clearPipPicker();
    draftSession = session;
    const source = adoptFrom || (prior === "unbound" ? prior : "");
    if (source && tasksExpanded.delete(source)) tasksExpanded.add(session);
    paintTasksExpanded();
    if (!draftEntries.has(session) && source && draftEntries.has(source)) {
      draftEntries.set(session, draftEntries.get(source)); draftEntries.delete(source);
    }
    if (source) for (const row of unconfirmedDrafts) if (row.session === source) row.session = session;
    if (source) for (const image of pendingImages) if (image.session === source) image.session = session;
    const draft = cleanDraft(draftEntries.get(session))
      || { text: "", attachments: [], start: 0, end: 0, goal: false };
    restoringDraft = true;
    setComposerValue(draft.text); attachments.splice(0, attachments.length, ...draft.attachments);
    setGoalDraftArmed(draft.goal);
    // Another chat gets its own undo history: Ctrl+Z in a new chat must not bring back the prompt
    // sent in the chat that was left, nor that chat's draft.
    if (session !== prior) resetComposerHistory();
    setComposerRange(draft.start, draft.end);
    renderAtts(); autosizeComposer();
    hidePop(); restoringDraft = false; persistDraft();
  }
  function loadDraftState() {
    try {
      const saved = vscode.getState();
      if (saved?.version !== 1 || saved.scope !== draftScope || !Array.isArray(saved.entries)
          || JSON.stringify(saved).length > 12 * 1024 * 1024) return;
      for (const entry of saved.entries.slice(0, 32)) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [session, raw] = entry;
        const draft = cleanDraft(raw);
        if (typeof session === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(session) && draft) draftEntries.set(session, draft);
      }
      if (typeof saved.active === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(saved.active)) draftSession = saved.active;
      for (const session of (Array.isArray(saved.tasksOpen) ? saved.tasksOpen : []).slice(-32)) {
        if (typeof session === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(session)) tasksExpanded.add(session);
      }
      paintTasksExpanded();
      unconfirmedDrafts = (Array.isArray(saved.pending) ? saved.pending : []).slice(0, 17).flatMap(row => {
        const draft = cleanDraft(row?.draft);
        return draft && typeof row.id === "string" && row.id.length <= 128
          && typeof row.session === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(row.session)
          ? [{ id: row.id, session: row.session, draft, rejected: row.rejected === true }] : [];
      });
      const draft = draftEntries.get(draftSession);
      if (draft) {
        restoringDraft = true;
        setComposerValue(draft.text); attachments.push(...draft.attachments);
        setGoalDraftArmed(draft.goal);
        setComposerRange(draft.start, draft.end);
        renderAtts(); autosizeComposer();
        restoringDraft = false;
      }
    } catch { restoringDraft = false; }
  }
  function renderUnconfirmedDrafts() {
    log.querySelectorAll(".draft-delivery-notice").forEach(node => node.remove());
    for (const row of unconfirmedDrafts.filter(row => row.session === draftSession)) {
      if (returnedNodes.get(row.id)?.isConnected) continue;     // its not-sent bubble offers the restore
      const node = el("div", "sys draft-delivery-notice");
      node.textContent = row.rejected ? "A rejected message is available to restore."
        : "Delivery of a message from the previous connection was not confirmed. Check the chat before retrying.";
      const button = el("button", "act", "Restore message to draft"); button.type = "button";
      button.onclick = () => {
        if (composerText() || attachments.length) { sysLine("Send or clear the current draft first."); return; }
        // One step, so Cmd+Z puts the box back as it was before the restore.
        recordComposerEdit(() => {
          setComposerValue(row.draft.text); attachments.push(...row.draft.attachments);
          setGoalDraftArmed(row.draft.goal);
        });
        unconfirmedDrafts = unconfirmedDrafts.filter(item => item.id !== row.id);
        node.remove(); renderAtts(); onInput(); persistDraft();
      };
      node.appendChild(button); log.appendChild(node);
    }
  }
  function rejectPrompt(id, confirmed = true) {
    const pending = pendingPrompts.get(id) || queuedPrompts.get(id);
    if (!pending) return;
    // Queued, or steering the backend acknowledged but had not applied: known unsent, not in doubt.
    if (confirmed && (queuedPrompts.has(id) || pending.acknowledged)) {
      returnedIds.add(id);
      returnedPrompts.push({ node: pending.node, session: pending.session || "" });
      if (returnedPrompts.length > 17) returnedPrompts.shift();
      returnedNodes.set(id, pending.node);
      if (returnedNodes.size > 17) returnedNodes.delete(returnedNodes.keys().next().value);
    }
    pendingPrompts.delete(id); queuedPrompts.delete(id);
    pending.node.classList.add(confirmed ? "rejected" : "unconfirmed");
    // A bubble that still said "you" or "you · queued" read as a message that went through.
    const role = pending.node.querySelector(".role");
    if (role && role.textContent.startsWith("you")) role.textContent = confirmed ? "you · not sent" : "you · delivery unconfirmed";
    const restore = () => {
      if (pending.session && pending.session !== draftSession) {
        sysLine("Reopen this message's original chat to restore its draft."); return;
      }
      if (composerText() || attachments.length) {
        sysLine("Send or clear the current draft before restoring this message."); return;
      }
      // A queued or refused prompt put back is one step of the box's history, like a paste.
      recordComposerEdit(() => {
        setComposerValue(pending.text); attachments.push(...pending.attachments);
        setGoalDraftArmed(pending.goal === true);
      });
      unconfirmedDrafts = unconfirmedDrafts.filter(item => item.id !== id);
      renderAtts(); onInput(); persistDraft(); input.focus();
    };
    const retry = el("button", "act", confirmed ? "Restore unsent message" : "Review delivery before restoring"); retry.type = "button";
    retry.onclick = restore; pending.node.appendChild(retry);
    if (confirmed && (!pending.session || pending.session === draftSession) && !composerText() && !attachments.length) restore();
    else {
      unconfirmedDrafts.push({ id, session: pending.session || draftSession, rejected: confirmed,
        draft: { text: pending.text, attachments: pending.attachments, start: 0,
          end: pending.text.length, goal: pending.goal === true, updated: Date.now() } });
      persistDraft();
    }
    if (!turn && !queuedCount && !pendingPrompts.size) setSending(false);
  }
  // A message the extension knows about but this webview does not (it was reloaded since): the same
  // bubble submit() drew, and the same restore entry.
  function promptEntry(item, label) {
    const draft = cleanDraft({ ...(item?.draft || {}), start: 0, end: 0 })
      || { text: String(item?.text || "").slice(0, 1_000_000), attachments: [] };
    const node = el("div", "msg user"); node.appendChild(el("div", "role", label));
    const bubble = el("div", "bubble");
    fillUserBubble(bubble, String(item?.text || "").slice(0, 1_000_000), draft.attachments);
    node.appendChild(bubble);
    return { text: draft.text, attachments: draft.attachments, goal: draft.goal === true, node,
             session: typeof item?.session === "string" ? item.session : "" };
  }
  const promptId = (item) => typeof item?.requestId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(item.requestId) ? item.requestId : "";
  // After a webview reload: the messages still queued in the running backend, so turn_start, Stop and
  // a backend exit find them here as they would have before the reload.
  // A steering message the backend acknowledged but has not applied yet comes back the same way,
  // still pending, so its steering_update finds it.
  function adoptQueuedPrompts(items) {
    let doubted = false;
    for (const item of Array.isArray(items) ? items.slice(0, 17) : []) {
      const id = promptId(item);
      if (!id || queuedPrompts.has(id) || returnedIds.has(id)) continue;
      const steering = item.steering === true;
      const label = steering ? "you · steering pending" : "you · queued";
      const entry = pendingPrompts.get(id) || promptEntry(item, label);
      // Saved before the reload as a delivery in doubt; the extension now vouches for it.
      if (unconfirmedDrafts.some((row) => row.id === id)) {
        unconfirmedDrafts = unconfirmedDrafts.filter((row) => row.id !== id); doubted = true;
      }
      const role = entry.node.querySelector(".role");
      if (role) role.textContent = label;
      entry.node.dataset.promptId = id;
      setSteerState(entry.node, steering ? "pending" : "queued");
      if (!entry.node.isConnected) { log.appendChild(entry.node); settleBlock(entry.node); }
      if (steering) { entry.acknowledged = true; pendingPrompts.set(id, entry); }
      else { pendingPrompts.delete(id); queuedPrompts.set(id, entry); }
    }
    queuedCount = Math.max(queuedCount, queuedPrompts.size); renderQueued();
    if (doubted) { renderUnconfirmedDrafts(); persistDraft(); }
  }
  // The extension's word that a backend holding these messages is gone (a restart, a window reload,
  // an exit): they were never sent. The same give-back as Stop.
  function adoptUnsentPrompts(items) {
    for (const item of Array.isArray(items) ? items.slice(0, 17) : []) {
      const id = promptId(item);
      if (!id || returnedIds.has(id)) continue;
      unconfirmedDrafts = unconfirmedDrafts.filter((row) => row.id !== id);
      const entry = queuedPrompts.get(id) || pendingPrompts.get(id) || promptEntry(item, "you");
      pendingPrompts.delete(id);
      if (!entry.node.isConnected) { log.appendChild(entry.node); settleBlock(entry.node); }
      queuedPrompts.set(id, entry);
      rejectPrompt(id, true);
    }
    queuedCount = queuedPrompts.size; renderQueued();
  }
  function putBackReturnedPrompts(session) {
    for (const { node, session: owner } of returnedPrompts) {
      if (!owner || !session || owner === session) log.appendChild(node);
    }
  }
  let files = [];              // workspace files for @-mentions
  let popMode = null, popItems = [], popIdx = 0, popStart = 0, popEnd = 0;
  let disclosureId = 0;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  // Replay says nothing: a restored transcript is not something that just happened, and
  // announcing fifty saved turns on reload buries whatever the reader is actually doing.
  function speak(message) { if (replaying) return; announcer.textContent = String(message || ""); }

  // One CommonMark renderer for live answers, history, skills, and documentation.
  // The renderer builds an HTML string, so it cannot read the setting per call. Tell it once,
  // before anything renders, or `dgc.linkFavicons: false` would still emit an <img> per link.
  DgcMarkdown.setFavicons?.(document.body.dataset.linkFavicons !== "off");
  const md = (source) => DgcMarkdown.render(source);
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
  // ---- hover labels ----
  // The panel relied on the browser's `title` tooltip: about a second of delay, operating-system
  // chrome that matches nothing else on screen, and nothing at all for a keyboard user. This is
  // one shared label that appears quickly, follows the panel's own type and surfaces, and works
  // on focus as well as hover. `title` stays in the DOM as the source of truth — it is the
  // accessible fallback and what the tests read — and is lifted off only while ours is showing,
  // so a control never explains itself twice.
  // A hover label should feel deliberate, not twitchy: it waits long enough that passing the
  // pointer over a row does not summon one, and short enough that asking for one is not a chore.
  const TIP_DELAY_MS = 700;
  const TIP_WARM_MS = 300;
  const hoverTip = (() => {
    const node = el("div", "tip");
    node.hidden = true; node.setAttribute("role", "tooltip"); node.id = "hover-tip";
    document.body.appendChild(node);
    let timer = 0, warm = 0, target = null, native = "";
    function hide() {
      clearTimeout(timer);
      if (target && native) target.setAttribute("title", native);
      if (node.hidden === false) warm = Date.now();
      target = null; native = ""; node.hidden = true; node.className = "tip";
    }
    function paint(el0, label) {
      const [head, ...rest] = label.split("\n").map((line) => line.trim()).filter(Boolean);
      node.textContent = head;
      if (rest.length) {
        const detail = document.createElement("span");
        detail.className = "tip-detail"; detail.textContent = rest.join(" ");
        node.appendChild(detail);
      }
      node.hidden = false;
      // Above by default, below when there is no room, and never off the side of the panel.
      const anchorBox = el0.getBoundingClientRect(), box = node.getBoundingClientRect(), gap = 6;
      let top = anchorBox.top - box.height - gap, side = "above";
      if (top < 4) { top = anchorBox.bottom + gap; side = "below"; }
      const left = Math.max(4, Math.min(Math.round(anchorBox.left + anchorBox.width / 2 - box.width / 2),
                                        window.innerWidth - box.width - 4));
      node.style.top = `${Math.round(top)}px`;
      node.style.left = `${left}px`;
      // The arrow points at the control, not at the middle of the label — they part company
      // whenever the label has been nudged away from the edge of the panel.
      const centre = anchorBox.left + anchorBox.width / 2 - left;
      node.style.setProperty("--tip-arrow", `${Math.round(Math.max(8, Math.min(centre, box.width - 8)))}px`);
      node.classList.add(side);
    }
    function show(el0, instant) {
      if (el0 === target) return;
      const label = (el0.getAttribute("title") || el0.dataset.tip || "").trim();
      if (!label || el0.closest("[hidden]")) return;
      hide();
      target = el0; native = el0.getAttribute("title") || "";
      // Moving to a neighbouring control should not make you wait again -- but the window in
      // which that holds is short, or scanning a toolbar makes every label feel instant.
      //
      // Both numbers are Codex's, read from its shipped webview bundle (delayDuration 700,
      // skipDelayDuration 300). Ours were 380 and 500: twice as eager to appear, and staying in
      // the instant mode nearly twice as long.
      const delay = instant || Date.now() - warm < TIP_WARM_MS ? 0 : TIP_DELAY_MS;
      timer = setTimeout(() => {
        if (target !== el0 || !el0.isConnected) return;
        if (native) el0.removeAttribute("title");
        paint(el0, (native || el0.dataset.tip || "").trim() || label);
      }, delay);
    }
    // A control that changes its own `title` while its label is up or about to be (the agents pill
    // as its agents end) goes through here: setting `title` directly would be undone by hide(),
    // which puts back the copy it lifted, and the label on screen would keep the old words.
    function retitle(el0, label) {
      if (el0 !== target) {
        if (el0.getAttribute("title") !== label) el0.setAttribute("title", label);
        return;
      }
      native = label;
      if (node.hidden) { el0.setAttribute("title", label); return; }
      if (!label) { hide(); el0.removeAttribute("title"); return; }
      node.className = "tip";
      paint(el0, label);
    }
    return { show, hide, retitle, node };
  })();
  const tipTarget = (event) => event.target?.closest?.("[title], [data-tip]") || null;
  // Focus DGC puts back for the reader as a dialog closes is not a request for a label: the label on
  // the control it lands on (the agents pill) would cover what the dialog was opened over, such as a
  // docked question's pager. Only this one programmatic focus is quiet; the next one labels as usual.
  let quietFocusTarget = null;
  function focusQuietly(node, options) {
    if (!node || typeof node.focus !== "function") return;
    quietFocusTarget = node;
    try { node.focus(options); } finally { quietFocusTarget = null; }
    hoverTip.hide();
  }
  document.addEventListener("pointerover", (e) => {
    const found = tipTarget(e);
    if (found) hoverTip.show(found, false); else hoverTip.hide();
  });
  document.addEventListener("pointerdown", () => hoverTip.hide(), true);
  document.addEventListener("focusin", (e) => {
    if (quietFocusTarget && e.target === quietFocusTarget) { hoverTip.hide(); return; }
    const found = tipTarget(e);
    // Only for keyboard focus: a label that pops up on every click is noise. A host that cannot
    // evaluate the selector should still get labels, so an unsupported pseudo-class means yes.
    let keyboard = true;
    try { keyboard = found ? found.matches(":focus-visible") : false; } catch { keyboard = !!found; }
    if (found && keyboard) hoverTip.show(found, true); else hoverTip.hide();
  });
  document.addEventListener("focusout", () => hoverTip.hide());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hoverTip.hide(); }, true);
  window.addEventListener("blur", () => hoverTip.hide());

  // ---- keeping the transcript's height honest while still skipping what is off screen ----
  // `content-visibility: auto` lets the browser skip rendering a block that has scrolled away,
  // but a skipped block is laid out at its `contain-intrinsic-size`, not its real height. A
  // guessed placeholder therefore changes the page's length every time a block is skipped or
  // rendered, which is what moved the viewport. Measure once, pin the measured value, and keep
  // it current with a ResizeObserver: skipped and rendered then occupy exactly the same space.
  const blockSizes = typeof ResizeObserver === "function" ? new ResizeObserver((entries) => {
    for (const entry of entries) pinBlockHeight(entry.target);
  }) : null;
  // A height is only true at the width and in the fonts it was measured with, so every pin records
  // both. `fontEpoch` moves whenever the transcript's fonts change (see fontProbe below).
  let fontEpoch = 0;
  // `width` is passed in by a caller writing many pins: reading it after each write forced a layout
  // per block.
  function recordPin(node, height, width = log.clientWidth) {
    node._pinnedWidth = width;
    node._pinnedFont = fontEpoch;
    node._pinnedHeight = height;
    node.style.containIntrinsicSize = `auto ${height}px`;
  }
  function pinBlockHeight(node) {
    const height = Math.round(node.offsetHeight);
    // A skipped block reports no size — to itself and to the observer. Writing that back would
    // replace the measurement with zero, which is the guessed placeholder all over again.
    if (height < 8 || Math.abs((node._pinnedHeight || 0) - height) < 2) return false;
    // Whatever width this was measured at is the width the pin now belongs to. The observer also
    // measures a rendered block while the panel is collapsed to a sliver; recording that width is
    // what lets the re-measure find the block once the panel is back, instead of leaving an
    // 11,000px pin that claims to belong to the old, restored width.
    recordPin(node, height);
    return true;
  }
  // What became of a message you sent mid-turn, as a line UNDER the bubble.
  //
  // It sat inside the bubble for a while, which was wrong twice over: a status line about the
  // message read as words you had typed, and it was only in there to keep the transcript's own
  // spacing measurements quiet. It is a real element rather than a ::after so that it is exposed
  // to a screen reader and so the spacing check can measure the prompt's real foot.
  const STEER_NOTE = {
    pending: "\u21b3 steering \u2026",
    queued: "\u21b3 queued for the next turn",
    applied: "\u21b3 steered \u2014 the model has read this",
  };
  function setSteerState(node, state) {
    if (!node) return;
    node.dataset.steer = state;
    const words = STEER_NOTE[state];
    let note = node.querySelector(":scope > .steer-note");
    if (!words) { if (note) note.remove(); return; }
    if (!note) { note = el("div", "steer-note"); node.appendChild(note); }
    note.textContent = words;
    // A queued message can be steered into the running turn instead of waiting for it to end (the founder,
    // 19 Oct): the same as pressing Enter while the model works, so it keeps going and reads it at its next step.
    if (state === "queued" && steerQueuedLive && !replaying) {
      const now = el("button", "steer-now", "Steer now");
      now.type = "button";
      now.title = "Send this to the running turn now, instead of after it";
      now.addEventListener("click", () => steerQueuedNow([node]));
      note.append(" · ", now);
    }
  }
  // Move queued messages (their request ids) into the running turn; the backend answers each that moved with
  // prompt_accepted "steered", which needs the row back among the pending prompts.
  function steerQueuedNow(nodes) {
    const ids = [];
    for (const [id, entry] of [...queuedPrompts]) {
      if (!nodes.includes(entry.node)) continue;
      queuedPrompts.delete(id); pendingPrompts.set(id, entry); ids.push(id);
      const button = entry.node.querySelector(".steer-now");
      if (button) { button.disabled = true; button.textContent = "Steering…"; }
    }
    if (ids.length) vscode.postMessage({ type: "steerQueued", request_ids: ids });
    renderQueued();
  }
  // A Steer now the backend could not do (the turn just ended, or can't take a message): those rows are queued again.
  function steerQueuedRefused() {
    for (const [id, entry] of [...pendingPrompts]) {
      const button = entry.node?.querySelector?.(".steer-now");
      if (!button || !button.disabled) continue;
      pendingPrompts.delete(id); queuedPrompts.set(id, entry);
      button.disabled = false; button.textContent = "Steer now";
    }
    renderQueued();
  }

  function settleBlock(node) {
    if (!node || node.classList.contains("settled")) return;
    // A block inside another (a steering message placed in its turn before a retry below came
    // round) is part of that block: measured, pinned and skipped with it, never on its own.
    if (node.parentElement?.closest(".msg")) return;
    fitPromptFolds(node);   // a prompt's fold is part of its height: decide it before the pin
    if (!pinBlockHeight(node)) {          // not laid out yet; settle on a later frame
      requestAnimationFrame(() => settleBlock(node));
      return;
    }
    node.classList.add("settled");        // only now may the browser skip it
    blockSizes?.observe(node);
  }
  // A pin is a height at one width. When the panel's width changes the text re-wraps, but a block
  // that is skipped is never laid out again, so it keeps the old height -- and so does the size the
  // browser itself remembers for it. Scrolling back then met blocks that grew or shrank as they came
  // into view, and the page under the reader jumped by the difference: 100-200px after dragging the
  // sidebar narrower, 20,000px of phantom transcript after a run went on while the panel was
  // collapsed to nothing. Once the width has held still, lay every block measured at another width
  // out again, pin what it really is, and keep what is on screen where it was. A few dozen blocks a
  // frame, nearest the view first: all at once was a quarter-second stall on a 200-turn chat, and
  // the blocks near the view are the ones a scroll reaches first.
  const REPIN_BATCH = 24;
  let repinTimer = null;
  function scheduleRepin(delay) {
    clearTimeout(repinTimer); repinTimer = setTimeout(() => repinStaleBlocks(), delay);
  }
  // The top-level block at the top of the view: the one a reader is reading, which must not move
  // when something above it changes height.
  function readingAnchor() {
    const top = log.getBoundingClientRect().top;
    // Never a turn's prompt: pinned, it stays put whatever moves above it, so holding it still would
    // let the block actually being read jump (0.47 pinned prompt).
    return [...log.querySelectorAll(".msg, .resume-note, .sys, .compaction, .history-older")]
      .find((node) => !node.parentElement.closest(".msg") && !node.classList.contains("turn-head")
        && node.getBoundingClientRect().bottom > top) || null;
  }
  // Change the transcript without moving what is being read: whatever the change did to the height
  // of the blocks above the view, the block at its top stays where it was (#log sets
  // overflow-anchor: none, so the browser does not do this for us). A reader following the end
  // gets the follow scroll instead.
  function holdReadingPlace(mutate) {
    const anchor = following ? null : readingAnchor();
    const before = anchor?.getBoundingClientRect().top;
    mutate();
    if (anchor?.isConnected) log.scrollTop += anchor.getBoundingClientRect().top - before;
  }
  // A settled block that changed inside may be skipped right now, laid out at its pinned height: mark
  // its pin stale, so it is measured again (with the reader held in place) before a scroll reaches it.
  function repinBlockOf(node) {
    const block = node?.closest?.(".msg.settled");
    if (block) { block._pinnedWidth = -1; scheduleRepin(0); }
  }
  // `nearView`: only the blocks a scroll is about to reach, leaving the rest to the timer. Chromium
  // renders skippable blocks up to 150% of the view's height beyond either edge, so that is where a
  // block starts drawing at its real height: within three view heights of the middle covers that
  // margin and a screen of scrolling on top.
  function repinStaleBlocks(nearView = false) {
    if (!nearView) { clearTimeout(repinTimer); repinTimer = null; }
    const width = log.clientWidth;
    const pad = getComputedStyle(log);
    // Hidden, or too narrow to hold a word: whatever is measured now is not what anyone will read.
    if (width - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight) < 48) return;
    // A prompt's fold is part of its block's height, decided at one width in one set of fonts. A block
    // on screen is re-pinned by blockSizes the moment its height moves -- at the NEW width (recordPin)
    // -- so the pin test below never offers it again: its folds are found by their own record.
    const folds = [...log.querySelectorAll(".msg.user > .bubble > .prompt-text")].map((text) => text.parentElement)
      .filter((bubble) => bubble._foldWidth !== width || bubble._foldFont !== fontEpoch);
    const holders = new Set(folds.map((bubble) => bubble.closest(".msg.settled")));
    // A prompt in no settled block (the turn still running, or not laid out yet): re-decided every pass.
    const loose = folds.filter((bubble) => !bubble.closest(".msg.settled"));
    const candidates = [...log.querySelectorAll(".msg.settled")]
      .filter((node) => node._pinnedWidth !== width || node._pinnedFont !== fontEpoch || holders.has(node));
    if (!candidates.length && !loose.length) return;
    const view = log.getBoundingClientRect();
    const middle = view.top + view.height / 2;
    const distance = (node) => { const r = node.getBoundingClientRect(); return r.bottom < middle ? middle - r.bottom : Math.max(0, r.top - middle); };
    const stale = candidates.map((node) => [distance(node), node])
      .filter(([far]) => !nearView || far < view.height * 3).sort((a, b) => a[0] - b[0])
      .slice(0, REPIN_BATCH).map(([, node]) => node);
    if (!stale.length && !loose.length) return;
    if (!nearView && candidates.length > REPIN_BATCH) repinTimer = setTimeout(() => repinStaleBlocks(), 16);
    const anchor = following ? null : readingAnchor();
    const anchorTop = anchor?.getBoundingClientRect().top;
    for (const node of stale) node.classList.remove("settled");   // rendered again, so laid out at this width
    // Inside the anchor above, so a fold appearing or going away over the reader does not move them.
    fitPromptFolds([...stale, ...loose.map((bubble) => bubble.parentElement)], width);   // the pins below are the folded heights
    // Every height read before any is written: one layout for the lot, not one per block.
    const heights = stale.map((node) => Math.round(node.offsetHeight));
    stale.forEach((node, i) => {
      if (heights[i] >= 8) recordPin(node, heights[i], width);
      else { node._pinnedWidth = width; node._pinnedFont = fontEpoch; }
    });
    if (anchor?.isConnected) log.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    else if (following) scroll();
    // Skippable again only after a frame rendered them: that is when the browser records the size
    // it will use for a skipped block, and it must record this one, not the old width's. (If the
    // width moved again meanwhile, the pass that follows finds these by their width, not their class.)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      for (const node of stale) if (node.isConnected) node.classList.add("settled");
      if (following) scroll();
    }));
  }
  if (typeof ResizeObserver === "function") {
    let lastWidth = -1;
    new ResizeObserver(() => {
      if (log.clientWidth === lastWidth) return;
      lastWidth = log.clientWidth;
      scheduleRepin(150);
    }).observe(log);
    // The fonts are the host's (VS Code rewrites its --vscode-* variables when the setting changes),
    // and new fonts re-wrap every block exactly as a new width does. Two lines of text that nothing
    // but the fonts can resize tell us when that happened, however the host did it.
    const fontProbe = el("div", "font-probe", '<span class="font-probe-sans">Mg The quick brown fox 0123</span><span class="font-probe-mono">Mg {x} =&gt; 0123</span>');
    fontProbe.setAttribute("aria-hidden", "true");
    document.body.appendChild(fontProbe);
    let lastFonts = "";
    const fontsObserver = new ResizeObserver(() => {
      const boxes = [...fontProbe.children].map((n) => n.getBoundingClientRect());
      if (boxes.some((r) => !r.width || !r.height)) return;   // hidden: nothing was measured
      const fonts = boxes.map((r) => `${r.width.toFixed(2)}x${r.height.toFixed(2)}`).join("|");
      if (fonts === lastFonts) return;
      if (lastFonts) { fontEpoch += 1; scheduleRepin(150); }
      lastFonts = fonts;
    });
    for (const line of fontProbe.children) fontsObserver.observe(line);
  }
  // Is the view still tracking the end of the run? It stops when you scroll away yourself, and when
  // you open a long prompt whose new height pushes the end out of view (togglePromptFold): you are
  // reading that prompt, and the next streamed line must not drag you off it. The Latest pill brings
  // you back, and following resumes there.
  // Following "whenever we happen to be at the bottom" is not enough: anything that moves the
  // transcript once — a focused control scrolled into view, a card resolving, the composer
  // growing — leaves it more than a screen-edge away, and from then on nothing ever scrolls
  // again, so a run keeps writing into a part of the panel nobody is looking at.
  window.__dgcPanelBuild = "follow-5";   // proves which panel code a recording actually ran
  let following = true, userScrolledAt = 0;
  function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 60; }
  function scroll() { if (replaying) return; log.scrollTop = log.scrollHeight; following = true; }
  // ---- reading back without losing the end ----
  // Scrolling up during a run is normal; being stranded there is not. The pill appears only
  // while you are away from the bottom, and turns into the accent once something has arrived
  // that you have not seen.
  const toLatest = $("to-latest");
  let unread = false;
  function renderToLatest() {
    const away = !atBottom();
    if (!away) { unread = false; following = true; }
    toLatest.hidden = !away;
    toLatest.classList.toggle("unread", away && unread);
    $("to-latest-label").textContent = away && unread ? "New" : "Latest";
    toLatest.title = away && unread
      ? "DGC has written more since you scrolled up \u2014 jump to it"
      : "Jump to the newest message";
  }
  function noteNewContent() { if (!atBottom()) { unread = true; renderToLatest(); } }
  // Only a gesture counts as "I want to read back". A scroll the page did to itself does not —
  // and neither does pressing a button that happens to live inside the transcript. Approval
  // cards, plan cards and question forms are all in there, so a plain pointerdown on the
  // scroller is usually someone answering DGC, not someone scrolling away from it.
  const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);
  const readingBack = () => { userScrolledAt = Date.now(); };
  log.addEventListener("wheel", readingBack, { passive: true });
  log.addEventListener("touchmove", readingBack, { passive: true });
  log.addEventListener("pointerdown", (e) => {
    if (e.offsetX > log.clientWidth) readingBack();          // the scrollbar, not the content
  }, { passive: true });
  log.addEventListener("keydown", (e) => {
    if (SCROLL_KEYS.has(e.key) && !e.target.closest("input, textarea, select, [contenteditable]")) {
      readingBack();
    }
  }, { passive: true });
  log.addEventListener("scroll", () => {
    if (Date.now() - userScrolledAt < 700) following = atBottom();
    // Pins still waiting for the width (or the fonts) to hold still are exactly what a scroll is
    // about to reach: re-measure the blocks nearest the view now, before they come into view at
    // their old height, rather than after the debounce -- a scroll inside that window jumped ~200px.
    // After `following` is updated: a reader scrolling up from the end is no longer following, and
    // the re-measure must hold their place instead of taking them back to the end.
    if (repinTimer !== null) repinStaleBlocks(true);
    renderToLatest();
  }, { passive: true });
  toLatest.onclick = () => { scroll(); unread = false; renderToLatest(); input.focus(); };
  // The composer grows and shrinks under the transcript: the goal rail and the changed-files
  // rail appear as a turn ends, the follow-up hint comes and goes, attachments wrap. Every one
  // of those takes height from the transcript while its scroll position stays put, which walks
  // the newest content off the bottom of the view — the end-of-turn summary went with it. If we
  // were following the run, keep following it.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => { if (atBottom() || following) scroll(); })
      .observe(document.querySelector("footer"));
  }

  // ---- 0.47 pinned prompt ----
  // The prompt you sent stays at the top of the transcript while you read its answer; the next prompt
  // pushes it off, and scrolling back up hands the pin back -- the Claude Code extension's behaviour,
  // and its method: pure CSS (main.css, "0.47 pinned prompt"). Each prompt is `position: sticky`
  // INSIDE its own box (wrapTurn), so the end of that box is what pushes it off, with no scroll
  // handler. Script only decides what a box holds, keeps a prompt that is too tall for this window
  // from pinning, takes a click on a prompt back to where it was sent, and keeps keyboard focus out
  // from under a pinned prompt. Nothing here runs per scroll frame. A long prompt pins folded
  // ("long prompts" keeps it to five lines); opened, it is read in place and does not pin (CSS).
  const PIN_GROUND_PX = 28;        // the strip around a pinned bubble: 16px of ground above it, a 12px fade below
  const PIN_FADE_PX = 12;          // = --sp-3, the fade under the bubble
  const PIN_SHARE = 0.3;           // a strip taller than this share of the window does not pin
  const PIN_JUMP_DELAY_MS = 300;   // a single click waits this long for a second one (the reference's 300ms)
  function fitPin(head, room) {
    if (head._pinH > 0) head.classList.toggle("pin-off", head._pinH + PIN_GROUND_PX > room);
  }
  // Reads no layout: the observer hands over each head's height, kept on the head. The window's height
  // is the measure, not #log's: a draft growing in the composer must not flip a pin per keystroke.
  const pinFit = typeof ResizeObserver === "function" ? new ResizeObserver((entries) => {
    const room = window.innerHeight * PIN_SHARE;
    for (const entry of entries) {
      const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect?.height ?? 0;
      if (height > 0) entry.target._pinH = height;   // 0: not rendered (agent page, hidden panel); keep the last
      fitPin(entry.target, room);
    }
  }) : null;
  window.addEventListener("resize", () => {
    const room = window.innerHeight * PIN_SHARE;
    for (const head of log.querySelectorAll(".turn > .msg.user.turn-head")) fitPin(head, room);
  });
  // Where a head is laid out: the top of its box (it is always the box's first child) plus its own
  // margin. Its rect says where it is drawn, which while it is pinned is the rest line.
  function laidOutTop(head) {
    const box = head.parentElement;
    if (!box || box.firstElementChild !== head) return head.getBoundingClientRect().top;
    return box.getBoundingClientRect().top + (parseFloat(getComputedStyle(head).marginTop) || 0);
  }
  // Where a pinned head rests: on #log's top padding, where a chat's first prompt sits (Chromium keeps
  // a sticky edge inside the scroller's padding).
  function restLine() { return log.getBoundingClientRect().top + (parseFloat(getComputedStyle(log).paddingTop) || 0); }
  // Drawn below its own place and still over the view. (A turn scrolled wholly past the top leaves its
  // prompt parked at the end of its box, out of sight: displaced, but covering nothing.)
  function isPinned(head) {
    if (!head?.isConnected) return false;
    const drawn = head.getBoundingClientRect();
    return drawn.top - laidOutTop(head) > 1 && drawn.bottom > log.getBoundingClientRect().top;
  }
  // Back to where a prompt was sent: its own place, on the rest line. A pinned prompt stays where it is
  // on screen and its answer rewinds under it to the start of the turn. Instant, like the Latest pill,
  // and a reading gesture like any scroll back: following stops, and the pill offers the end again.
  function goToPrompt(head) {
    const delta = laidOutTop(head) - restLine();
    if (Math.abs(delta) < 2) return false;
    readingBack(); following = false;
    log.scrollTop += delta;
    renderToLatest();
    return true;
  }
  // Focus is never left under a pinned prompt (WCAG 2.2, 2.4.11 Focus Not Obscured): a control in the
  // same box whose top is under the prompt or its fade is scrolled down out from under it. Only a box's
  // own prompt can cover it -- the end of a box pushes its prompt off before the next one begins. A
  // control in the prompt itself is where it should be.
  function clearOfPin(target) {
    if (!target?.closest || target.closest(".turn-head")) return;
    const head = target.closest(".turn")?.querySelector(":scope > .msg.user.turn-head");
    if (!head || !isPinned(head)) return;
    const box = target.getBoundingClientRect();
    // Only what is under the strip. Out of view above it, a control is the browser's to bring in, or was
    // focused without scrolling, which this must not undo.
    if (box.bottom <= log.getBoundingClientRect().top) return;
    const covered = head.getBoundingClientRect().bottom + PIN_FADE_PX - box.top;
    if (covered > 0) log.scrollTop -= covered;
  }
  // A click on a turn's prompt, pinned or not, goes back to where it was sent (the reference does the
  // same, after the same 300ms). Only a single plain click on the bubble: never one on a link, a chip or
  // a button, never with a modifier, never the click that clears a selection or that focused the panel,
  // never a double-click (a word being selected), and never once a selection has been made.
  let pinJump = 0, pinDown = null;
  log.addEventListener("pointerdown", () => {
    const selection = window.getSelection?.();
    pinDown = { selected: !!selection && !selection.isCollapsed, focused: document.hasFocus?.() !== false };
  }, { capture: true, passive: true });
  log.addEventListener("click", (event) => {
    clearTimeout(pinJump);
    const down = pinDown;
    pinDown = null;
    if (event.button !== 0 || event.detail !== 1 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (down && (down.selected || !down.focused)) return;
    const bubble = event.target.closest?.(".turn > .msg.user.turn-head > .bubble");
    if (!bubble || event.target.closest("button, a, input, textarea, select, summary, [role=button], [tabindex]")) return;
    const head = bubble.parentElement;
    pinJump = setTimeout(() => {
      const selection = window.getSelection?.();
      if ((selection && !selection.isCollapsed) || !head.isConnected) return;
      goToPrompt(head);
    }, PIN_JUMP_DELAY_MS);
  });
  // Keyboard focus only, decided as the hover labels decide it: a mouse press focuses a button too, and
  // moving that button would take it out from under the pointer before the click lands. (A control
  // focused from out of view is the browser's to bring in, after this runs; Chromium centres it.)
  log.addEventListener("focusin", (event) => {
    let keyboard = true;
    try { keyboard = event.target.matches(":focus-visible"); } catch {}
    if (keyboard) clearOfPin(event.target);
  });
  // ---- end 0.47 pinned prompt ----

  // ---- the prompt rail (media/promptrail.js, the same as ChatDGC's; the founder chose it for Work chats 2026-10-18) ----
  // From five prompts, a short tick per prompt in the transcript's right margin, the one being read bright; hover or
  // Tab to it for a card of every prompt with its time; a click, or Alt+Up and Alt+Down from anywhere (the message box
  // too), goes there and outlines it. A chat opens on its latest pages, so the prompts before what's on screen come
  // from the session's outline (get_outline, offered as ready.capabilities.outline), asked for each time the
  // transcript is drawn from a history snapshot: a reload, a reattach, a resume, a switch. Going to one of those loads
  // the pages before it first. With an older CLI the rail lists the prompts on screen, and its card offers to load
  // the earlier messages. Only this chat's own transcript: a Pip's chat has none of these rows.
  let railOffered = false;            // ready.capabilities.outline
  let railOutline = null;             // {prompts}: the answer to the latest get_outline
  let railAsked = 0;                  // that request's token: an older answer is dropped
  let railHeld = new Set();           // the turn ids of the prompts in the latest history snapshot (reachable here)
  let railSerial = 0, railSeeking = null;
  const railTurnIds = new WeakMap();  // a prompt row -> its turn's id ("h3", "t2") or its place in the archive ("a1")
  const railIds = new WeakMap();      // a prompt row -> the rail's own id for one with neither
  const RAIL_ARCHIVED = "Before the summary";   // the card's heading over prompts compaction folded away (no times kept)
  // Each turn's prompt row, in the order the transcript shows them: the archived ones, the saved ones, this window's.
  const railHeads = () => [...log.querySelectorAll(":scope > .turn > .msg.user.turn-head, :scope > .history-pages > .turn > .msg.user.turn-head")];
  function railHeadText(head) {
    const bubble = head.querySelector(":scope > .bubble");
    const words = (bubble?.querySelector(":scope > .prompt-text")?.textContent || "").slice(0, 2000).replace(/\s+/g, " ").trim();
    if (words) return words.slice(0, 160);
    const chips = [...(bubble?.querySelectorAll(":scope > .prompt-atts .prompt-att") || [])]
      .map((chip) => chip.textContent.replace(/\s+/g, " ").trim()).filter(Boolean);
    return chips.join(", ").slice(0, 160) || "Image";
  }
  function railPrompts() {
    const heads = railHeads();
    const told = railOutline?.prompts || null;
    if (told) {
      // The archive's rows on screen are its latest prompts: they take the outline's ids for them ("a<n>").
      const archived = told.filter((p) => p.archived), rows = heads.filter((h) => h.classList.contains("archived"));
      const total = archived.length ? Number(archived[archived.length - 1].id.slice(1)) + 1 : 0;
      rows.forEach((head, j) => { const n = total - rows.length + j; if (n >= 0) railTurnIds.set(head, `a${n}`); else railTurnIds.delete(head); });
    }
    const seen = new Set(), shown = [];
    for (const head of heads) {
      let id = railTurnIds.get(head) || railIds.get(head);
      if (!id || seen.has(id)) { id = railIds.get(head) || `p${++railSerial}`; railIds.set(head, id); }
      seen.add(id);
      const time = head.querySelector(":scope > .msg-time");
      shown.push({ id, text: railHeadText(head), at: time ? Date.parse(time.dateTime) : NaN, loaded: true, node: head,
                   ...(head.classList.contains("archived") ? { heading: RAIL_ARCHIVED } : {}) });
    }
    // The ones before what's on screen, from the outline: those this window can reach (an archived one, or one in the
    // snapshot it holds; a long session's snapshot leaves its oldest turns out).
    const before = (told || []).filter((p) => !seen.has(p.id) && (p.archived || railHeld.has(p.id)))
      .map((p) => ({ id: p.id, text: p.text, at: typeof p.at === "number" ? p.at * 1000 : NaN, loaded: false,
                     ...(p.archived ? { heading: RAIL_ARCHIVED } : {}) }));
    return [...before, ...shown];
  }
  const railOlder = () => log.querySelector(":scope > .history-pages > .history-older");
  function railNode(id) { return railPrompts().find((p) => p.id === id && p.loaded)?.node || null; }
  // To a prompt not on screen: the pages before what's shown, held here or asked of the archive, until it is there.
  function railReach(p, then) {
    railSeeking = { id: p.id, then, pages: 0 };
    railSeek();
  }
  function railSeek() {
    const seeking = railSeeking;
    while (seeking && railSeeking === seeking) {
      if (railNode(seeking.id)) { railSeeking = null; seeking.then(); return; }
      const older = railOlder();
      if (!older || older.hidden || seeking.pages++ > 5000) { railSeeking = null; speak("That part of the chat isn't shown here."); return; }
      if (older.disabled) return;                  // the archive's next page is on its way: its answer carries on
      older.click();
    }
  }
  // Eased to its own place (where a pinned prompt rests), at once for a reader who asked for less motion; then put
  // exactly there, since the blocks it passed may have taken their real height on the way.
  let railGliding = 0;
  function railGlide(head) {
    cancelAnimationFrame(railGliding);
    readingBack(); following = false;
    const bound = () => Math.max(0, log.scrollHeight - log.clientHeight);
    const from = log.scrollTop, to = Math.min(bound(), Math.max(0, from + laidOutTop(head) - restLine()));
    const settle = (left) => {
      const delta = laidOutTop(head) - restLine();
      if (Math.abs(delta) > 1 && head.isConnected) {
        const before = log.scrollTop;
        log.scrollTop = Math.min(bound(), Math.max(0, before + delta));
        if (left > 0 && log.scrollTop !== before) { railGliding = requestAnimationFrame(() => settle(left - 1)); return; }
      }
      renderToLatest();
    };
    const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still || Math.abs(to - from) < 2) { log.scrollTop = to; settle(3); return; }
    const t0 = performance.now(), ms = 320;
    const frame = (now) => {
      readingBack();
      const t = Math.min(1, (now - t0) / ms);
      log.scrollTop = from + (to - from) * (1 - (1 - t) ** 3);
      if (t < 1) railGliding = requestAnimationFrame(frame); else settle(3);
    };
    railGliding = requestAnimationFrame(frame);
  }
  function railFlash(node) {
    node.classList.remove("prompt-flash");
    void node.offsetWidth;                  // so it plays again on a node that just played it
    node.classList.add("prompt-flash");
    setTimeout(() => node.classList.remove("prompt-flash"), 1600);
  }
  const promptRail = window.DgcPromptRail?.create({
    id: "prompt-rail", scroller: log, input, reveal: "hover",
    visible: () => log.clientHeight > 0 && !document.body.hasAttribute("data-agent-page"),
    prompts: railPrompts,
    top: (p) => (p.node?.isConnected ? laidOutTop(p.node) : null),
    landing: restLine,
    go: railReach,
    show: (p) => {
      const head = p.node?.isConnected ? p.node : railNode(p.id);
      if (!head) return false;
      railGlide(head);
      railFlash(head.querySelector(":scope > .bubble") || head);
      return true;
    },
    // An older CLI: the prompts before what's on screen can't be listed until they're loaded.
    more: (list) => {
      const older = railOlder();
      return !railOutline && older && !older.hidden && !list.some((p) => !p.loaded)
        ? { label: "Earlier messages aren't listed yet: load them", run: () => older.click() } : null;
    },
    announce: speak,
  });
  // The rows change when the transcript does: a turn's box added or taken away, a page of history landing.
  let railFrame = 0;
  const railSoon = () => { if (promptRail && !railFrame) railFrame = requestAnimationFrame(() => { railFrame = 0; railWatch(); promptRail.refresh(); }); };
  const railObserver = typeof MutationObserver === "function" ? new MutationObserver(railSoon) : null;
  function railWatch() {
    const pages = log.querySelector(":scope > .history-pages");
    if (pages && railObserver) railObserver.observe(pages, { childList: true });
  }
  railObserver?.observe(log, { childList: true });
  // A history snapshot drew the transcript again: the prompts it holds, and the outline asked for afresh.
  function railSnapshot(items) {
    railHeld = new Set();
    for (const it of items || []) {
      if (it && it.type === "turn_start" && (it.kind || "prompt") === "prompt" && typeof it.turn_id === "string") railHeld.add(it.turn_id);
    }
    railOutline = null; railSeeking = null;
    if (railOffered) vscode.postMessage({ type: "getOutline", token: ++railAsked });
    railSoon();
  }
  function railOutlined(ev) {
    if (ev.request_id !== `outline-${railAsked}` || !Array.isArray(ev.prompts)) return;
    railOutline = { prompts: ev.prompts.filter((p) => p && typeof p.id === "string" && p.id && typeof p.text === "string").slice(-5000) };
    railSoon();
  }
  function railReset() { railOutline = null; railHeld = new Set(); railSeeking = null; railAsked++; railSoon(); }

  // ---- turn lifecycle ----
  // Two prompts are "the same" when their opening prose matches; the composer's own bubble may
  // carry attachment chips the backend never echoes, and the backend may expand a template.
  function sameProse(a, b) {
    const norm = (v) => String(v || "").replace(/📷/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
    const x = norm(a), y = norm(b);
    return !!x && !!y && (x.startsWith(y) || y.startsWith(x));
  }
  function bubbleProse(node) {
    return (node?.querySelector?.(".prompt-text") || node)?.textContent || "";
  }
  function splitPromptMarks(text) {
    const raw = String(text || "");
    const marked = /📷/.test(raw);
    return {
      text: raw.replace(/\s*📷\s*/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\s+$/g, "").trimEnd(),
      attachments: marked ? [{ label: "image", img: true }] : [],
    };
  }
  // ---- long prompts fold ----
  // A sent prompt of 4+ lines shows its first 3 until "Show more" (main.css, "long prompts"). Decided
  // only from the text's real height once it is in the transcript (settleBlock), and again whenever
  // the width or fonts change (repinStaleBlocks). Never from a guess, so a live bubble and the same
  // prompt replayed from history run the same code. Only `.prompt-text` folds: chips, image tiles and
  // an answered question above it always stay whole. The one place the state lives is the bubble's
  // `data-fold` ("folded" | "open", absent when the prompt fits); setPromptFold is its only writer.
  const PROMPT_FOLD_LINES = 3;    // = --prompt-fold-lines in main.css (prompt-fold.test.mjs pins both)
  const PROMPT_FOLD_SPARE = 1;    // fold once a line would be hidden: 4 lines fold, 3 do not
  // Prompts opened in this panel's life. A chat switch, reconnect or rewind rebuilds the transcript,
  // and a prompt being read must not fold back. Keyed by the chat tab (chat_switched/chat_slots) AND
  // the conversation, so a new chat with no session id yet, or /new in the same tab, starts clean.
  // Memory only: a reloaded webview starts folded. Grows only by clicks (<=512 chars a key).
  let promptChat = "";
  const promptsOpened = new Map();
  const promptChatKey = () => `${promptChat}\n${draftSession}`;
  // Live, the bubble shows the composer's trimmed text; replayed, the backend's text after
  // splitPromptMarks. Same words, different whitespace.
  function promptFoldKey(bubble) {
    const text = bubble.querySelector(":scope > .prompt-text")?.textContent || "";
    return text.slice(0, 4096).replace(/\s+/g, " ").trim().slice(0, 512);
  }
  function promptRemembered(bubble) { return !!promptsOpened.get(promptChatKey())?.has(promptFoldKey(bubble)); }
  function rememberPrompt(bubble, open) {
    const chat = promptChatKey();
    if (!promptsOpened.has(chat)) promptsOpened.set(chat, new Set());
    promptsOpened.get(chat)[open ? "add" : "delete"](promptFoldKey(bubble));
  }
  function setPromptFold(bubble, state) {          // "folded" | "open" | "" (fits)
    const body = bubble.querySelector(":scope > .prompt-text");
    let toggle = bubble.querySelector(":scope > .prompt-fold");
    if (!state || !body) {
      delete bubble.dataset.fold;
      if (toggle && toggle === document.activeElement && body) {
        // A keyboard user keeps their place: the text the control belonged to takes focus.
        body.tabIndex = -1; body.focus({ preventScroll: true });
        body.addEventListener("blur", () => body.removeAttribute("tabindex"), { once: true });
      }
      toggle?.remove();
      return;
    }
    bubble.dataset.fold = state;
    if (!toggle) {
      toggle = el("button", "prompt-fold"); toggle.type = "button";
      if (!body.id) body.id = `prompt-text-${++disclosureId}`;
      toggle.setAttribute("aria-controls", body.id);
      toggle.onclick = () => togglePromptFold(bubble);
      // A held key auto-repeats: one press is one toggle (Claude Code does the same).
      toggle.onkeydown = (event) => { if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault(); };
      bubble.appendChild(toggle);
    }
    const open = state === "open", label = open ? "Show less" : "Show more";
    toggle.dataset.label = label;            // drawn by ::before: never in textContent or a copy
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.innerHTML = `<span class="codicon codicon-chevron-${open ? "up" : "down"}" aria-hidden="true"></span>`;
  }
  function promptLine(node) {
    const style = getComputedStyle(node), px = parseFloat(style.lineHeight);
    return /px$/.test(style.lineHeight) && px > 0 ? px : (parseFloat(style.fontSize) || 13) * 1.62;
  }
  // true: fold. false: fits. null: not laid out (hidden panel, agent page, detached page, jsdom).
  // scrollHeight is the natural height folded or not, so the verdict never depends on the state.
  function measurePromptFold(bubble) {
    const body = bubble.querySelector(":scope > .prompt-text");
    if (!body?.isConnected || !body.clientWidth) return null;
    return body.scrollHeight > promptLine(body) * (PROMPT_FOLD_LINES + PROMPT_FOLD_SPARE - 0.5);
  }
  // `blocks`: .msg elements (or one). A block's own bubble is found too: querySelectorAll matches
  // ".msg.user > .bubble" against the whole tree. Every height is read before any fold is written.
  function fitPromptFolds(blocks, width = log.clientWidth) {
    const bubbles = new Set();
    for (const block of [].concat(blocks)) for (const bubble of block?.querySelectorAll?.(".msg.user > .bubble") || []) bubbles.add(bubble);
    const verdicts = [];
    for (const bubble of bubbles) {
      bubble._foldWidth = width; bubble._foldFont = fontEpoch;   // as the pins do, even unmeasured
      const long = measurePromptFold(bubble);
      if (long !== null) verdicts.push([bubble, long]);
    }
    for (const [bubble, long] of verdicts) {
      const state = bubble.dataset.fold || "";
      if (long && !state) setPromptFold(bubble, promptRemembered(bubble) ? "open" : "folded");
      else if (!long && state) setPromptFold(bubble, "");
    }
    for (const [bubble] of verdicts) syncPromptLinks(bubble);
  }
  // A link not wholly inside the visible lines leaves the tab order until the prompt opens: Tab never
  // lands on what nobody can see, and never opens a prompt by itself. Screen readers keep every link.
  function syncPromptLinks(bubble) {
    const body = bubble.querySelector(":scope > .prompt-text");
    const links = body ? [...body.querySelectorAll(".prompt-link")] : [];
    if (!links.length) return;
    const edge = bubble.dataset.fold === "folded" && body.clientHeight ? body.getBoundingClientRect().top + body.clientHeight : null;
    for (const link of links) {
      if (edge !== null && link.getBoundingClientRect().bottom > edge + 1) link.tabIndex = -1;
      else link.removeAttribute("tabindex");
    }
  }
  function togglePromptFold(bubble) {
    const open = bubble.dataset.fold !== "open";
    const row = bubble.parentElement;
    const head = row?.matches(".turn > .msg.user.turn-head") ? row : null;
    // A pinned prompt opens in its own place, not grown down over its answer from the top of the view
    // (0.47 pinned prompt): back to where it was sent first. Open, it does not pin (main.css).
    if (open && head && isPinned(head)) goToPrompt(head);
    setPromptFold(bubble, open ? "open" : "folded");
    syncPromptLinks(bubble);
    rememberPrompt(bubble, open);
    if (open) {
      // Opened, a prompt is being read: a running turn must not scroll() the reader away from it.
      if (!atBottom()) following = false;
    } else {
      // Folded while read from inside: its top is above the view. Bring it back, 16px clear. Read once
      // folded (the transcript may have got shorter than the view), from where it is laid out: folded, a
      // turn's prompt pins again, and is drawn on the rest line wherever its own place is.
      const pinnedBy = head ? head.getBoundingClientRect().top - laidOutTop(head) : 0;
      const above = bubble.getBoundingClientRect().top - pinnedBy - log.getBoundingClientRect().top;
      if (above < 0) log.scrollTop += above - 16;
      // A prompt inside a turn whose own prompt is pinned (a steer) comes back below that prompt.
      if (!head) clearOfPin(row);
    }
    renderToLatest();   // the Latest pill while away; following again once back at the end
  }
  function fillUserBubble(bubble, text, attachments) {
    bubble.replaceChildren();
    const items = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
    if (items.length) {
      const row = el("ul", "prompt-atts");
      row.setAttribute("role", "list");
      row.setAttribute("aria-label", "Attachments");
      const images = [];
      items.forEach((item) => {
        const li = el("li");
        li.appendChild(promptAttachmentChip(item, images, bubble));
        row.appendChild(li);
      });
      if (images.length) bubble._images = images;
      bubble.appendChild(row);
    }
    const body = String(text || "");
    if (body || !items.length) bubble.appendChild(promptText(body));
  }
  // A URL the user typed is a link they can open, not grey text to select and copy by hand.
  //
  // Built out of DOM nodes rather than an escaped HTML string: this is verbatim user input, and
  // the one place in the panel where getting escaping wrong would be an injection instead of a
  // cosmetic bug. textContent is byte-identical to what the old `esc(body)` produced, which is
  // what bubbleProse() compares against to avoid echoing a prompt twice.
  //
  // The trailing class excludes sentence punctuation, so "see https://vibedgc.com." does not
  // swallow the full stop and "(https://x.dev)" does not swallow the bracket.
  const PROMPT_URL = /https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}]/gi;
  function promptText(body) {
    const host = el("div", "prompt-text");
    const text = String(body || "");
    let at = 0;
    for (const match of text.matchAll(PROMPT_URL)) {
      if (match.index > at) host.appendChild(document.createTextNode(text.slice(at, match.index)));
      host.appendChild(promptLink(match[0]));
      at = match.index + match[0].length;
    }
    if (at < text.length) host.appendChild(document.createTextNode(text.slice(at)));
    return host;
  }
  function promptLink(raw) {
    const target = window.DgcMarkdown?.linkTarget?.(raw);
    if (!target || target.kind !== "external") return document.createTextNode(raw);
    // The same element, class and delegated click handler an answer's links use, so there is
    // still exactly ONE route out of the panel and the extension host re-validates it there.
    const link = el("button", "md-link prompt-link");
    link.type = "button";
    link.dataset.linkKind = "external";
    link.dataset.target = target.target;
    link.title = target.target;
    const mark = window.DgcMarkdown.linkSource(target.target);
    const icon = promptFavicon(target.target, link, mark);
    if (icon) link.appendChild(icon); else link.dataset.linkSource = mark;
    link.appendChild(document.createTextNode(raw));
    return link;
  }
  function promptFavicon(url, link, mark) {
    if (!faviconsEnabled()) return null;
    const src = window.DgcMarkdown?.faviconUrl?.(url);
    if (!src) return null;
    const img = el("img", "link-favicon");
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    img.referrerPolicy = "no-referrer";
    // The mark travels as a fallback rather than rendering now: the global handler below puts it
    // back if the image cannot load. Setting data-link-source here would draw BOTH.
    link.dataset.linkFallback = mark;
    img.src = src;
    return img;
  }
  function faviconsEnabled() { return document.body.dataset.linkFavicons !== "off"; }
  // ONE fallback for every favicon in the panel, wherever it came from -- a link the user typed,
  // a link in an answer, a link in a skill's documentation. `error` does not bubble, but it does
  // capture, so a single listener at the document catches every one without the renderer having
  // to attach a closure per image (it cannot: the markdown path builds an HTML string).
  //
  // A blank gap where a link's mark should be is worse than no favicon at all: when the icon
  // service is unreachable, blocked, or has nothing for that host, the bundled glyph comes back.
  document.addEventListener("error", (event) => {
    const img = event.target;
    if (!img || img.tagName !== "IMG" || !img.classList?.contains("link-favicon")) return;
    const link = img.closest?.(".md-link");
    img.remove();
    if (link) {
      link.dataset.linkSource = link.dataset.linkFallback || "web";
      delete link.dataset.linkFallback;
    }
  }, true);
  function promptAttachmentChip(item, images, bubble) {
    if (item.pipReference) {
      const chip = el("span", "prompt-att chip pip-reference-chip");
      chip.textContent = pipReferenceLabel(item.pipReference);
      chip.title = `${item.pipReference.pip_id} · ${item.pipReference.status} · lifecycle ${item.pipReference.lifecycle_revision} · Reference only`;
      return chip;
    }
    if (item.img && item.heic) {
      // Chromium can't draw an iPhone photo: the chip names it, and the model is sent it as a JPEG.
      const chip = el("span", "prompt-att chip");
      chip.appendChild(el("span", "codicon codicon-file-media"));
      chip.lastChild.setAttribute("aria-hidden", "true");
      chip.appendChild(el("span", "chip-label", esc(item.label || "iPhone photo")));
      chip.title = "An iPhone photo, sent as a JPEG";
      return chip;
    }
    if (item.img) {
      const record = {
        name: String(item.label || "Image").replace(/^📷\s*/, "") || "Image",
        bytes: Number(item.bytes) || 0,
        source: "view_image",
        owner: bubble,
        state: item.data && String(item.data).startsWith("data:image/") ? "ready" : "failed",
        src: item.data && String(item.data).startsWith("data:image/") ? item.data : "",
        reason: item.data && String(item.data).startsWith("data:image/") ? "" : "not_found",
        compact: true,
      };
      images.push(record);
      return imageChip(record, images.length - 1, images.length);
    }
    const chip = el("button", `prompt-att chip${item.skill || item.template ? " invocation-chip" : ""}${item.pasted ? " pasted-chip" : ""}`);
    chip.type = "button";
    const icon = item.pasted ? "copy" : item.skill ? "sparkle" : item.template ? "file-code" : item.resource?.path ? "file" : "link";
    const label = item.pasted
      ? `Pasted text · ${(item.chars || String(item.pasted).length).toLocaleString()} chars`
      : (item.label || "Attachment");
    chip.appendChild(el("span", `codicon codicon-${icon}`));
    chip.lastChild.setAttribute("aria-hidden", "true");
    chip.appendChild(el("span", "chip-label", esc(label)));
    chip.title = label;
    chip.setAttribute("aria-label", `Open attachment ${label}`);
    chip.onclick = () => openPromptAttachment(item);
    return chip;
  }
  function producedFileChip(item) {
    const rel = String(item.rel || "");
    const name = String(item.name || rel.split("/").pop() || "file");
    const chip = el("button", "chip made-file");
    chip.type = "button";
    // The same kind mark a file link wears, from the same table, so a produced .py and a
    // mentioned .py look like the same kind of thing.
    chip.dataset.linkKind = "file";
    chip.dataset.fileKind = window.DgcMarkdown?.fileKind?.(rel) || "file";
    chip.appendChild(el("span", "chip-label", esc(name)));
    const size = Number(item.bytes) || 0;
    if (size) chip.appendChild(el("span", "chip-size", esc(humanSize(size))));
    const caption = String(item.caption || "");
    const label = caption ? `${name} — ${caption}` : name;
    chip.title = `${rel}${caption ? ` — ${caption}` : ""}`;
    chip.setAttribute("aria-label", `Open ${label}`);
    // The extension host re-validates the path; the webview never opens anything itself.
    chip.onclick = () => vscode.postMessage({ type: "openFile", path: rel });
    return chip;
  }
  function humanSize(bytes) {
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  }
  function openPromptAttachment(item) {
    if (item.pasted) { openTextAttachment("Pasted text", item.pasted); return; }
    if (item.skill) { vscode.postMessage({ type: "slash", action: "skills" }); return; }
    if (item.template) { openTextAttachment(item.label || item.template, `/${item.template}`); return; }
    const path = item.resource?.path || item.resource?.relative_path;
    if (path) { vscode.postMessage({ type: "openFile", path }); return; }
    const preview = item.resource?.text || item.resource?.uri || item.label || "";
    openTextAttachment(item.label || "Attachment", String(preview));
  }
  let textViewer = null;
  function openTextAttachment(title, body) {
    closeTextAttachment(false);
    const viewer = el("div");
    viewer.id = "att-viewer";
    viewer.setAttribute("role", "dialog");
    viewer.setAttribute("aria-modal", "true");
    viewer.setAttribute("aria-labelledby", "att-title");
    viewer.innerHTML = `<div class="att-bar"><h2 id="att-title" class="att-title"></h2><button type="button" class="iv-btn att-close" aria-label="Close attachment preview" title="Close (Esc)"><span class="codicon codicon-close" aria-hidden="true"></span></button></div><pre class="att-body"></pre>`;
    viewer.querySelector("#att-title").textContent = title;
    viewer.querySelector(".att-body").textContent = String(body || "");
    const inert = [...document.body.children]
      .filter((node) => node !== viewer && node.id !== "announcer" && !node.classList.contains("tip"))
      .map((node) => ({ node, attr: node.hasAttribute("inert"), prop: node.inert }));
    for (const saved of inert) { saved.node.setAttribute("inert", ""); try { saved.node.inert = true; } catch {} }
    const onKey = (event) => { if (event.key === "Escape") { event.preventDefault(); closeTextAttachment(true); } };
    viewer.querySelector(".att-close").onclick = () => closeTextAttachment(true);
    viewer.addEventListener("click", (event) => { if (event.target === viewer) closeTextAttachment(true); });
    viewer.addEventListener("keydown", onKey);
    textViewer = { el: viewer, inert, onKey };
    document.body.appendChild(viewer);
    viewer.querySelector(".att-close").focus();
  }
  function closeTextAttachment(restoreFocus) {
    if (!textViewer) return;
    const { el: viewer, inert } = textViewer;
    textViewer = null;
    viewer.remove();
    for (const saved of inert) {
      if (!saved.attr) saved.node.removeAttribute("inert");
      try { saved.node.inert = saved.prop; } catch {}
    }
    if (restoreFocus) input.focus();
  }
  // The row that heads a turn (0.47 pinned prompt): the one this panel already drew for it, or one
  // drawn now, or null for a turn with nothing to show.
  function echoPrompt(text, requestId = "") {
    // The row drawn for this request -- the composer's, a goal's, an answer to a question, a queued
    // message put back after a reload -- found by its id whether or not prompt_accepted came first.
    // It used to be found only as "the last bubble", and only while still pending: turn_start comes
    // from the backend's worker thread and can beat prompt_accepted, and then the prompt just sent
    // counted as one still waiting and was moved below its own answer.
    const own = !replaying && requestId ? sentPromptRow(requestId) : null;
    if (own) return claimRow(own);
    const parsed = splitPromptMarks(text);
    const body = parsed.text.trim();
    if (!body && !parsed.attachments.length) return null;
    // The composer renders what the user typed there. A turn begun anywhere else — a slash
    // command, an editor action, a queued follow-up, a retry, the terminal beside us — must
    // still show its prompt, or the transcript reads as answers to questions nobody asked.
    if (!replaying) {
      // No id: a goal's first turn, /plan /review /init, a custom command, a turn begun elsewhere. Only
      // a row drawn since the last prompt's box can be this turn's prompt (a box with no prompt in it,
      // drawn by events that came first, is passed over), and never a queued row: only its own id
      // claims one of those.
      const queued = new Set([...queuedPrompts.values()].map((entry) => entry?.node));
      for (let row = log.lastElementChild; row && !row.matches(".history-pages")
          && !(row.classList.contains("turn") && row.querySelector(":scope > .turn-head")); row = row.previousElementSibling) {
        if (row.matches(".msg.user:not(.rejected):not(.unconfirmed)") && !queued.has(row)
            && sameProse(bubbleProse(row.querySelector(":scope > .bubble")), body)) return claimRow(row);
      }
    }
    // Replay never matches: every saved turn_start is a prompt someone sent, the same words twice
    // included. (Comparing with the last bubble on the page dropped the second of two.)
    const m = el("div", replaying ? "msg user hist" : "msg user"); m.appendChild(el("div", "role", "you"));
    const bubble = el("div", "bubble");
    fillUserBubble(bubble, parsed.text, parsed.attachments);
    m.appendChild(bubble);
    appendTarget.appendChild(m); if (!replaying) settleBlock(m);
    markPipReportsNamedIn(parsed.text);
    return m;
  }
  // Top-level only: a row already claimed is inside its turn's box.
  function sentPromptRow(id) {
    for (let row = log.lastElementChild; row; row = row.previousElementSibling) {
      if (row.dataset?.promptId === id && row.matches(".msg.user:not(.rejected):not(.unconfirmed)")) return row;
    }
    return null;
  }
  // A turn that started proves its prompt was delivered: it is no longer a draft in doubt (persistDraft),
  // and nothing that arrives for that request later -- a late acknowledgement, a steering update, a
  // reject -- can relabel, move or reject the prompt heading the turn.
  function claimRow(row) {
    for (const [id, entry] of pendingPrompts) {
      if (entry?.node === row) { pendingPrompts.delete(id); persistDraft(); break; }
    }
    return row;
  }
  // A prompt that was queued behind a running turn already has its bubble, drawn when it was sent,
  // below that turn. When its own turn starts, that bubble IS the prompt: echoing the text again
  // drew it twice, and a second queued prompt then sat between the first and its reply. The bubble
  // moves up past any prompt still waiting (the backend may have reordered them), and its turn is
  // placed straight beneath it, so the prompts still waiting stay at the bottom, as they did.
  function claimQueuedPrompt(requestId) {
    const node = typeof requestId === "string" && requestId ? queuedPrompts.get(requestId)?.node : null;
    if (!node?.isConnected || node.parentElement !== log || !node.classList.contains("user")) return null;
    const waiting = [...queuedPrompts].map(([id, entry]) => id !== requestId && entry.node)
      .filter((other) => other && other.isConnected && other.parentElement === log
        && (other.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
    const first = waiting.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))[0];
    if (first) keepingFocus(() => first.before(node));
    const role = node.querySelector(".role");
    if (role && role.textContent.startsWith("you")) role.textContent = "you";
    return node;
  }
  // A webview (re)loaded while a turn runs is told so by the extension before the history snapshot
  // arrives (`turn_active`). The snapshot then ends with that turn still open, and it becomes the
  // live turn instead of being settled as "Stopped": its later events, the question it is waiting
  // on and its turn_end all land in it. With no snapshot coming, or none that holds the turn yet,
  // the turn starts here from what its turn_start said.
  let liveTurnHint = null;
  // Until the snapshot turn_active announced lands, the running turn's live events are held and
  // then applied to the turn the snapshot leaves open: applied at once, the first of them started a
  // second, promptless turn above which the snapshot's own turn was settled as finished.
  let heldForSnapshot = null, heldTimer = null;
  let hostSessionSeen = false;       // set by the first session_ready: before it no turn is known here
  function noteLiveTurn(msg) {
    liveTurnHint = {
      id: String(msg.turnId || "").slice(0, 128), kind: ["resume", "continue", "monitor", "pip_setup"].includes(msg.kind) ? msg.kind : "prompt",
      prompt: String(msg.prompt || ""), handoff: msg.handoff === true,
      startedAt: Number.isFinite(msg.startedAt) && msg.startedAt > 0 ? Math.min(Date.now(), msg.startedAt) : Date.now(),
    };
    if (msg.history === true) {
      // Events the extension forwarded before this webview said it was ready drew a promptless
      // block; everything they showed that was saved is in the snapshot on its way, so that block
      // goes (a step waiting on a decision is announced again after the snapshot).
      if (turn && turn.beforeSession) dropTurnBlock();
      heldForSnapshot = heldForSnapshot || [];
      clearTimeout(heldTimer);
      heldTimer = setTimeout(releaseHeldEvents, 10000);   // a snapshot that never comes holds nothing for long
    }
    setSending(true);
    if (msg.history !== true) startHintedTurn();
  }
  function releaseHeldEvents(throughSeq = -1) {
    clearTimeout(heldTimer); heldTimer = null;
    const held = heldForSnapshot;
    heldForSnapshot = null;
    if (held) for (const ev of held) {
      // A complete snapshot includes the running round, even the text not saved to disk yet.
      // Its wire sequence is the boundary: playing those same bytes again duplicates the answer.
      if (Number.isFinite(ev.seq) && ev.seq <= throughSeq) {
        if (REPLAYABLE.has(ev.type)) continue;
        if (ev.type === "steering_update" && ev.state === "applied") {
          const entry = queuedPrompts.get(ev.request_id) || pendingPrompts.get(ev.request_id);
          entry?.node?.remove();
          queuedPrompts.delete(ev.request_id); pendingPrompts.delete(ev.request_id);
          continue;
        }
      }
      onEvent(ev);
    }
  }
  function dropTurnBlock() {
    clearInterval(turn.timer);
    clearTimeout(turn.renderTimer);
    turn.block.querySelectorAll(".tool").forEach((card) => clearInterval(card._timer));
    const box = turn.block.parentElement;
    turn.block.remove();
    // A box left with no turn in it goes too: its rows are plain rows again, as before it opened. (A
    // provisional block that joined a prompt's box leaves that box and its prompt as they were.)
    if (box?.classList.contains("turn") && !box.querySelector(":scope > .msg.dgc")) unwrapTurn(box);
    turn = null;
  }
  function startHintedTurn() {
    const hint = liveTurnHint;
    liveTurnHint = null;
    if (!hint || turn) return;
    startTurn(hint.prompt, hint.kind, hint.id);
    resumeLiveTurn(turn, hint);
  }
  function adoptLiveTurn(replayed) {
    const hint = liveTurnHint;
    liveTurnHint = null;
    turn = replayed;
    turn.block.classList.remove("hist");
    turn.block.querySelectorAll('.tool[data-status="running"] .dot').forEach((dot) => dot.classList.add("run"));
    if (hint.id) turn.id = hint.id;
    turn.timer = setInterval(renderTurnMeta, 200);
    resumeLiveTurn(turn, hint);
    syncLiveStep();                          // the stretch the reload caught working gets its live row
  }
  function resumeLiveTurn(t, hint) {
    if (!t) return;
    t.t0 = t.phaseT0 = hint.startedAt;
    t.handoff = hint.handoff;
    renderTurnMeta();
  }
  // `requestId`: the id turn_start carries for a prompt someone sent (its row is found by it).
  function startTurn(prompt = "", kind = "prompt", id = "", promptNode = null, requestId = "") {
    // A page of restored turns is a sequence of finished turns, not one turn interrupting another.
    if (turn) endTurn(replaying ? "completed" : "cancelled");
    speak("DGC is working");
    // What opens this turn's box (wrapTurn): its prompt row, or the note of a turn nobody typed.
    let wakeNote = null, head = promptNode;
    // A resumed goal is not something the user just typed. Show it as what it is instead of
    // echoing the objective back into the chat as a fresh prompt. The same holds for a turn the
    // Continue card started after the backend stopped: DGC wrote that instruction, not the user.
    if (kind === "pip_setup") {
      const note = el("div", "resume-note pip-approval-note");
      let receipt;try{receipt=JSON.parse(prompt);}catch{}
      const kinds=['core','scout','lens','patch','rook','pulse','lock','quill'];
      if(receipt && kinds.includes(receipt.pip_type) && typeof receipt.name==='string'){
        const face=el('span','pip-run-avatar');face.setAttribute('aria-hidden','true');
        if(window.PipConcepts?.plush)face.innerHTML=window.PipConcepts.plush.markup({index:kinds.indexOf(receipt.pip_type),name:receipt.name},'success',`approval-${id.replace(/[^a-z0-9]/gi,'')}`,{paused:true});
        note.append(face,el('span','pip-approval-name',receipt.name),el('span','pip-approval-status','Created'));
      }else note.append(el('span','','Pip created'));
      appendTarget.appendChild(note);head=note;
    } else if (kind === "resume" || kind === "continue") {
      const note = el("div", replaying ? "resume-note hist" : "resume-note");
      note.innerHTML = `<span class="note-icon" data-icon="play">${icon("play")}</span>`
        + `<span>${kind === "continue" ? "Continued the interrupted turn" : "Resumed the standing goal"}</span>`;
      if (kind === "continue") note.classList.add("continue-note");
      appendTarget.appendChild(note);
      head = note;
    } else if (kind === "monitor" || kind === "wake") {
      // DGC started this turn because a background monitor printed something, or a detached
      // specialist finished. The label is backend-written, never a "you" bubble.
      const note = el("div", replaying ? "resume-note monitor-note hist" : "resume-note monitor-note");
      const lead = kind === "wake" ? "Woke on agent" : "Woke on monitor";
      note.innerHTML = `<span class="note-icon" data-icon="${kind === "wake" ? "bot" : "activity"}">`
        + `${icon(kind === "wake" ? "bot" : "activity")}</span>`
        + `<span>${lead} · ${esc(String(prompt || "").slice(0, 200))}</span>`;
      appendTarget.appendChild(note);
      wakeNote = note; head = note;
    } else if (!promptNode) {
      head = echoPrompt(prompt, requestId);
    }
    const block = el("div", replaying ? "msg dgc hist" : "msg dgc");
    block._turnId = String(id || "");               // a turn_files for it after it ended finds its card
    block.appendChild(el("div", "role dgc", "DGC"));
    // The verb starts empty and is written only by renderTurnMeta, from what the backend says the
    // turn is doing. A literal here is a claim the panel cannot keep: it was "working…" from the
    // first byte to the last, through six gates and every tool call.
    const act = el("div", "thinking", `<span class="spin">${MARK}</span> <span class="verb"></span> <span class="meta"></span>`);
    block.appendChild(act);
    appendTarget.appendChild(block);
    // A claimed queued prompt: the turn goes at the end like any other, so whatever the log said
    // between that prompt being sent and its turn starting (a compaction, a notice, an error) stays
    // above the turn, where it happened. The prompts still waiting are the ones that move: back
    // below the running turn, in their order. A turn with no bubble of its own (a queued slash
    // command, echoed above) moves every waiting prompt the same way.
    // The turn's own prompt is never one of them, even before prompt_accepted has said it started.
    if (!replaying) {
      const anchor = promptNode || block;
      const waiting = [...queuedPrompts.values(), ...pendingPrompts.values()].map((entry) => entry?.node)
        .filter((node) => node && node !== promptNode && node !== head && node.isConnected && node.parentElement === log
          && (promptNode ? (anchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
            : (anchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING)));
      waiting.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      if (waiting.length) keepingFocus(() => { for (const node of new Set(waiting)) log.appendChild(node); });
    }
    wrapTurn(head, block);
    // No clock for a replayed turn: the session file does not record when it started, and a
    // fabricated 0s is worse than no number at all.
    const t0 = replaying ? null : Date.now();
    turn = { block, act, t0, chars: 0, textEl: null, reasonEl: null, _buf: "", eta: "",
             id: String(id || ""), activity: null, phaseT0: t0, handoff: false,
             prompt: String(prompt || ""), edits: new Map() };
    if (wakeNote) turn.wake = { note: wakeNote, label: String(prompt || "").slice(0, 200), kinds: [], ids: new Set(), kind };
    // The prompt's time goes under its bubble: when its turn started, live. A saved turn's comes with its
    // history (a {role: "time"} item, legacyItem), so a reopened chat says when each prompt was sent.
    turn.head = head?.matches?.(".msg.user") ? head : null;
    if (turn.head && id) railTurnIds.set(turn.head, String(id));    // the prompt rail knows it by its turn (an outline's id)
    if (!replaying) stampPrompt(turn.head, Date.now());
    if (!replaying) {
      turn.timer = setInterval(renderTurnMeta, 200);
      renderTurnMeta();
      // A prompt just asked for is worth taking the reader to. A turn nobody asked for just now --
      // a monitor waking DGC, a goal resuming, a continuation, a prompt queued minutes ago -- is
      // news: it follows a reader at the end and leaves one who scrolled back where they are, with
      // the "New" pill, like every other event.
      if (following || (kind === "prompt" && !promptNode)) scroll(); else noteNewContent();
    }
  }
  // When a prompt was sent (media/msgtime.js), under its bubble; the whole date is the tooltip.
  function stampPrompt(node, at) {
    const time = node && window.DgcTime?.node(at);
    if (!time) return;
    const old = node.querySelector(":scope > .msg-time");
    const bubble = node.querySelector(":scope > .bubble");
    if (old) old.replaceWith(time); else if (bubble) bubble.after(time); else node.appendChild(time);
  }
  // ---- the box a turn goes in (0.47 pinned prompt) ----
  // A prompt opens a box: its row, then anything the log wrote between that prompt and its turn
  // starting (where it happened), then the turn's block. The row becomes the box's .turn-head, the
  // prompt main.css pins. A turn nobody typed -- resumed, continued, a monitor or agent wake, a
  // handoff, events with no turn_start -- joins the box above it with whatever lies between, so the
  // prompt it continues stays pinned through it (the reference groups every item that is not a real
  // prompt into the turn above it, the same way); with no box above, it gets one with nothing to pin.
  // Live and replayed turns both come through here, so both build the same boxes. A box never holds
  // another box, never crosses the restored history's container, and never takes in a prompt row
  // still waiting for its turn. It adds nothing to the layout: a column with #log's own gap.
  function wrapTurn(head, block) {
    const parent = block.parentNode;
    if (!parent) return null;
    let first = head && head !== block && head.parentNode === parent
      && (head.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING) ? head : block;
    const prompt = first !== block && first.matches(".msg.user");
    let box = null;
    const place = () => {
      if (prompt) {
        // A box drawn between this row and its turn (events that came first) stays above the row.
        let inner = null;
        for (let n = first.nextElementSibling; n && n !== block; n = n.nextElementSibling) if (n.classList.contains("turn")) inner = n;
        if (inner) inner.after(first);
      } else {
        for (let n = first.previousElementSibling; n && !n.matches(".history-pages, .history-older, .msg.user:not(.rejected):not(.unconfirmed)"); n = n.previousElementSibling) {
          if (n.classList.contains("turn")) { box = n; first = n.nextSibling; break; }
        }
      }
      if (!box) { box = el("div", "turn"); parent.insertBefore(box, first); }
      for (let n = first; n;) { const next = n.nextSibling; box.appendChild(n); if (n === block) break; n = next; }
    };
    if (replaying) place(); else keepingFocus(place);
    if (prompt) {
      first.classList.add("turn-head");
      // No longer waiting: what the row said about its wait goes, and live reads as replay does.
      delete first.dataset.steer;
      first.querySelector(":scope > .steer-note")?.remove();
      const role = first.querySelector(":scope > .role");
      if (role?.textContent.startsWith("you")) role.textContent = "you";
      pinFit?.observe(first);
    }
    return box;
  }
  // Moving a node out of the document and back blurs whatever was focused inside it and collapses a
  // selection that ran through it: both are put back, quietly (no scroll, no hover label).
  function keepingFocus(move) {
    const active = log.contains(document.activeElement) ? document.activeElement : null;
    const selection = window.getSelection?.();
    const ends = selection?.rangeCount && log.contains(selection.anchorNode) && log.contains(selection.focusNode)
      ? [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset] : null;
    move();
    if (active?.isConnected && document.activeElement !== active) focusQuietly(active, { preventScroll: true });
    if (ends && (selection.anchorNode !== ends[0] || selection.anchorOffset !== ends[1]
        || selection.focusNode !== ends[2] || selection.focusOffset !== ends[3])) {
      try { selection.setBaseAndExtent(...ends); } catch {}
    }
  }
  function unwrapTurn(box) {
    const head = box.querySelector(":scope > .msg.user.turn-head");
    if (head) { head.classList.remove("turn-head", "pin-off"); pinFit?.unobserve(head); }
    box.replaceWith(...box.childNodes);
  }
  // A page of history lands above newer turns, and those may begin with a turn nobody typed: it
  // continues this page's last prompt, so it joins that box, as one pass over the whole chat would have
  // drawn it. Layout-neutral: a box's gap is #log's.
  function joinAcrossPage(lastLanded) {
    let next = lastLanded?.nextElementSibling;
    while (next && !next.classList.contains("turn")) next = next.nextElementSibling;
    if (!next || next.querySelector(":scope > .msg.user.turn-head")) return;
    let box = null;
    for (let n = next.previousElementSibling; n && !n.matches(".history-older, .msg.user:not(.rejected):not(.unconfirmed)"); n = n.previousElementSibling) {
      if (n.classList.contains("turn")) { box = n; break; }
    }
    if (!box) return;
    keepingFocus(() => {
      while (box.nextSibling !== next) box.appendChild(box.nextSibling);
      box.append(...next.childNodes);
      next.remove();
    });
  }
  // The marker above a wake turn names what woke it. It is drawn from turn_start, which carries
  // only the label, so it said "Woke on monitor" even when the only thing that woke the turn was a
  // background command exiting, right above a card titled "Background command". The wake's own
  // events arrive next and say which it was.
  function paintWakeNote(wake, ev) {
    wake.kinds.push(String(ev.kind || "output")); wake.ids.add(String(ev.id || ""));
    const background = wake.kinds.every((k) => k === "background_exit");
    const mark = wake.note.querySelector(".note-icon"), text = wake.note.querySelector(".note-icon + span");
    setIcon(mark, background ? "square-terminal" : "activity");
    if (text) text.textContent = `Woke on ${background ? (wake.ids.size > 1 ? "background commands" : "background command") : "monitor"} · ${wake.label}`;
  }
  // ---- a finished background agent's report (ready.capabilities.agent_reports) ----
  // A background agent that ends starts a turn on the idle chat, and its report comes right after
  // turn_start (`agent_report`): one muted line per agent, in place of the bare "Woke on agent" note,
  // which a click or Enter/Space opens to the whole report, drawn as the agent's page draws it -- what
  // became of its changes (said in the transcript's own colour when work was held back, with where the
  // worktree is kept), what it said, the files it named -- and "Open in agent map". Folded, live and as
  // a reload replays it (the history carries the same event). It is a note, never a "you" bubble, and
  // pins nothing. An older CLI sends none, and the note stays what it was.
  let handbackSeq = 0;
  function splitAgentReport(report) {
    let text = String(report || "").trim();
    if (text.startsWith("error: ")) text = text.slice("error: ".length);      // the model's word, not the reader's
    // "...path(s): a, b.\nSummary:\n", or "...was unavailable. Summary:\n" for one that ran in the shared checkout.
    const mark = /[ \n]Summary:\n/.exec(text);
    if (!mark) return /^(?:Sub-task |The user stopped sub-task )/.test(text) ? [text, ""] : ["", text];
    return [text.slice(0, mark.index).trim(), text.slice(mark.index + mark[0].length).trim()];
  }
  function paintAgentReport(ev) {
    ensureTurn();
    const t = turn, id = String(ev.id || "").slice(0, 64);
    t.handbacks = t.handbacks || [];
    // A live event held while the snapshot that already drew it landed: one line per agent, never two.
    if (id && t.handbacks.some((line) => line.dataset.agentId === id)) return;
    const wake = t.wake;
    // Placed, not connected: a replayed turn is drawn into a fragment that joins the page afterwards.
    const noted = !!wake?.note?.parentNode;
    let line;
    if (wake?.kind === "wake" && !wake.reported && noted) {
      line = wake.note;                     // the wake's own note becomes the first agent's line
      wake.reported = true;
      line.replaceChildren();
    } else {
      line = el("div");
      const after = t.handbacks.at(-1) || (noted ? wake.note : null);
      if (after) after.after(line);         // the next agent's line, under the one before
      else { appendTurnContent(line); breakText(); }   // a report that reached a running turn: where it came
    }
    buildHandbackLine(line, id, String(ev.description || id || "agent").slice(0, 200), String(ev.report || ""));
    t.handbacks.push(line);
  }
  function buildHandbackLine(line, id, label, report) {
    line.className = replaying ? "resume-note monitor-note handback-line hist" : "resume-note monitor-note handback-line";
    if (id) line.dataset.agentId = id; else delete line.dataset.agentId;
    const n = ++handbackSeq;
    const toggle = el("button", "handback-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", `handback-${n}`);
    toggle.innerHTML = `<span class="note-icon" data-icon="bot">${icon("bot")}</span>`;
    toggle.appendChild(el("span", "handback-label")).textContent = `Woke on agent · ${label}`;
    const chevron = toggle.appendChild(el("span", "handback-chevron"));
    chevron.setAttribute("aria-hidden", "true");
    const body = el("div", "handback-body");
    body.id = `handback-${n}`;
    body.hidden = true;
    body.setAttribute("role", "region");
    body.setAttribute("aria-label", `Report from ${label}`);
    line._handback = { report, label };
    toggle.addEventListener("click", () => setHandbackOpen(line, toggle.getAttribute("aria-expanded") !== "true"));
    line.append(toggle, body);
  }
  // Drawn the first time it opens: a long chat of finished agents renders none of their Markdown until read.
  function fillHandbackBody(line, body) {
    const { report, label } = line._handback || { report: "", label: "" };
    const [note, said] = splitAgentReport(report);
    if (note) {
      const p = body.appendChild(el("p", "agent-page-outcome handback-note"));
      p.textContent = note.slice(0, 4000);
      if (AGENT_OUTCOME_HELD.test(note) || /^Sub-task '[\s\S]*?' completed but was not integrated/.test(note)) p.dataset.held = "1";
    }
    const answer = agentAnswerText({ message: said });
    if (answer) {
      const block = body.appendChild(el("div", "surface-markdown handback-answer"));
      block.innerHTML = md(answer);
      enrichMarkdown(block);
    }
    paintAgentFiles(body, { message: said });
    if (!note && !answer) body.appendChild(el("p", "agent-page-outcome", "The agent reported nothing."));
    const map = body.appendChild(el("button", "handback-map", "Open in agent map"));
    map.type = "button";
    map.setAttribute("aria-label", `Open ${label} in the agent map`);
    map.addEventListener("click", () => openReportInMap(line, map));
  }
  function setHandbackOpen(line, open) {
    const toggle = line.querySelector(":scope > .handback-toggle"), body = line.querySelector(":scope > .handback-body");
    if (!toggle || !body) return;
    if (open && !body.childElementCount) fillHandbackBody(line, body);
    body.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    line.classList.toggle("open", open);
    // Opened, the report is being read: a turn running below must not scroll() the reader away from it.
    if (open && !atBottom()) following = false;
    renderToLatest();
  }
  // The agent this report is from, as the agents list knows it now. A reopened chat numbers its agents
  // afresh, but the spawn's own result still names the id the agent ran under.
  function reportAgentId(id) {
    if (!id || agentRecords.has(id)) return id;
    const named = `(id ${id})`;
    for (const record of agentRecords.values()) {
      if ((agentAnchor(record.id)?.querySelector(".body pre")?.textContent || "").includes(named)) return record.id;
    }
    return "";
  }
  function openReportInMap(line, from) {
    const id = reportAgentId(line.dataset.agentId || "");
    openAgentMap({ from });
    if (!agentMapOpen()) return;
    const row = id ? amRevealRow(`agent:${id}`) : null;    // Earlier opens when that is where it is
    if (row) amOpenCard({ kind: "agent", id }, row);       // its card: what it was asked, its steps, its report
  }
  // The one writer of the activity row. Everything it can say is a fact somebody stated: the
  // panel's own open request card, the handoff this panel asked for, or the backend's
  // `turn_activity`. "Working" is the floor, and only until the first activity arrives.
  function renderTurnMeta() {
    if (!turn?.act) return;
    const verb = turn.act.querySelector(".verb"), meta = turn.act.querySelector(".meta");
    if (!verb || !meta) return;
    // A question on screen is a fact about THIS client and beats anything the backend is doing.
    const waiting = !!turn.block.querySelector(".card[data-request-id]:not(.resolved)") || askCardDocked();
    turn.act.classList.toggle("waiting-input", waiting);
    const activity = turn.activity;
    // A tool step's detail is its argument (the command, the path), and that tool's card is already
    // on screen holding it: the row says only what kind of step is running, beside the clocks and
    // tokens. Detail stays for states with no card to show it, such as a stalled model
    // ("<model> at <host> · no reply for 45s+"). Decided here, so it holds for any CLI.
    // Below ~360 px the row keeps only the label: the detail (a reconnect's cause, host, backoff and
    // count) wrapped it to three lines, and the reconnect line in the transcript already says it all.
    const full = activity && activity.state !== "tool" ? activity.detail : "";
    const narrow = !!full && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 360px)").matches;
    const detail = narrow ? "" : full;
    const shortened = narrow && !waiting && !turn.handoff ? `${activity.label} · ${full}` : "";
    if ((turn.act.getAttribute("title") || "") !== shortened) hoverTip.retitle(turn.act, shortened);
    verb.textContent = waiting ? "waiting for your input"
      : turn.handoff ? "generating handoff…"
        : activity ? activity.label + (detail ? ` · ${detail}` : "")
          : "Working";
    if (turn.t0 == null) { meta.textContent = ""; return; }   // a replayed turn has no clock
    const now = Date.now();
    const total = Math.floor((now - turn.t0) / 1000);
    const phase = Math.floor((now - (turn.phaseT0 || turn.t0)) / 1000);
    // Two clocks only once they differ: how long this step has taken, then the whole turn. It is
    // the TUI's shape, and it is what makes a long gate visible instead of a growing total.
    const clock = activity && phase !== total ? `${phase}s · ${total}s` : `${total}s`;
    const eta = turn.eta ? ` · ${turn.eta}` : "";
    meta.textContent = `(${clock}${eta} · ↓ ${Math.round(turn.chars / 4)} tok)`;
  }
  function toolArgChars(args) {
    if (args == null) return 0;
    try { return typeof args === "string" ? args.length : JSON.stringify(args).length; } catch { return 0; }
  }
  // `finalId` is the backend's own designation of which prose block this turn answered with
  // (`turn_end.final_message_id`). The panel used to guess it from the position of the last
  // `.text` node, which made a gate round's prose the answer and left the block the user had
  // actually read as bare, unclassified text.
  function showToolProgress(card, ev) {
    const numeric = Number.isFinite(ev.progress);
    const hasTotal = numeric && Number.isFinite(ev.total) && ev.total !== 0;
    setToolOutput(card, String(ev.message || "").slice(0, 500));
    card.querySelector(".badge").textContent = hasTotal
      ? Math.max(0, Math.min(100, Math.round(ev.progress / ev.total * 100))) + "%"
      : (numeric ? String(ev.progress) : "");
  }
  // A background sub-task outlives the turn that started it, and so does the step it is in the
  // middle of: its result arrives later, on the same card. Stopping that card drew a command still
  // running as stopped, and the result then made a second card with no command.
  function outlivesTheTurn(card) {
    const record = agentRecords.get(agentIdFromCall(card.dataset.callId));
    return Boolean(record && record.background === true && AGENT_ACTIVE.has(record.state));
  }
  // ---- a finished turn's work folds into its "Worked for 43s" row ----
  // Once a turn has given its final answer, the work that led there folds into the turn's "Worked for
  // 43s ›" row, which moves to the top of the turn: the one-line progress updates, the tool rows and
  // their groups, thinking, a reconnect that recovered, a sub-agent line whose agents are done, and the
  // card of a background command or monitor that reported while it worked (up to 40 lines of build
  // output each, which stayed open under the answer: founder, 25 Oct). One
  // click shows them again, in place under the row, and the row folds them again once the next turn has
  // answered. What a reader still needs stays: a detailed message (a diagnosis, a plan), a message you
  // sent mid-turn, question and approval cards, notices, the files and artifacts the turn made, a
  // sub-agent still working, and the answer with what it changed. A stopped or failed turn does not
  // fold: its work is all it has to show. Codex collapses its commentary the same way once the final
  // answer is shown, and the model is told the answer must stand on its own (dgc/presentation.py).
  // endTurn draws it, live and replayed alike, so a reload, a reattach and a resume draw the same fold.
  const WORK_STEPS = [".text.commentary:not(.commentary-detail)", ".tool-group", ".tg-live",
    '.tool:not([data-tool-name="propose_options"])', ".disclosure", ".reasoning", ".thought-note",
    ".thought-static", '.model-retry[data-state="recovered"]', ".agent-line", ".monitor-event"].join(", ");
  function isWorkStep(node) {
    return node.matches(WORK_STEPS) && !(node.matches(".agent-line") && node.querySelector(".agent-mark.is-live"));
  }
  // Which of the turn's blocks the row holds, and the spacing of what stays: a hidden step is still a
  // sibling, so the rules that space a message sent mid-turn by its neighbour (main.css, `.msg.dgc >
  // .msg.user`) took a folded step for that neighbour. Each block left showing is told what is drawn
  // beside it instead. A background sub-agent still working when the turn folded keeps its line on
  // screen; done, the line goes into the fold the next time the turn folds (the next turn's answer, or
  // a click), never at the moment it finishes, under a reader who may be reading beside it. A reload
  // draws it folded at once. `keep`: what this fold already decided stays as it was; only a block it
  // has not seen (a sub-agent line the agents snapshot draws after a reload) is decided now.
  const workFoldSeen = new WeakSet();
  function paintWorkFold(block, keep = false) {
    const shown = [];
    for (const node of block.children) {
      if (node.matches(".role")) continue;
      const step = keep && workFoldSeen.has(node) ? node.classList.contains("work-step") : isWorkStep(node);
      workFoldSeen.add(node);
      node.classList.toggle("work-step", step);
      if (!step) shown.push(node);
    }
    shown.forEach((node, i) => {
      node.classList.toggle("wf-before-prompt", Boolean(shown[i + 1]?.matches(".msg.user")));
      node.classList.toggle("wf-after-prompt", Boolean(shown[i - 1]?.matches(".msg.user")) && !node.matches(".msg.user"));
      node.classList.toggle("wf-last", i === shown.length - 1);
    });
  }
  function foldTurnWork(block, act) {
    // Nothing to fold (the answer was all the turn did): the row stays a plain line.
    if ([...block.children].some(isWorkStep)) {
      act.classList.add("work-toggle");
      act.setAttribute("role", "button");
      act.setAttribute("aria-expanded", "false");
      act.tabIndex = 0;
      const role = block.querySelector(":scope > .role");
      if (role) role.after(act); else block.prepend(act);
      block.classList.add("has-work-fold", "work-folded");
      paintWorkFold(block);
    }
    if (replaying) return;      // an older page drawn into the chat leaves alone what you opened below it
    // A turn opened to read folds again once the next one has answered, and one whose sub-agent has
    // since finished takes its line in.
    const others = [...log.querySelectorAll(".msg.dgc.has-work-fold")].filter((other) => other !== block
      && (!other.classList.contains("work-folded") || other.querySelector(":scope > .agent-line:not(.work-step)")));
    if (others.length) holdReadingPlace(() => { for (const other of others) setWorkOpen(other, false); });
  }
  function setWorkOpen(block, open) {
    if (!open) paintWorkFold(block);
    block.classList.toggle("work-folded", !open);
    block.querySelector(":scope > .work-toggle")?.setAttribute("aria-expanded", String(open));
    repinBlockOf(block);        // off screen it is skipped at its old height: measure it again
  }
  function toggleWorkFold(block) {
    const open = block.classList.contains("work-folded");
    setWorkOpen(block, open);
    // Opened, the work is being read: a turn running below must not scroll() the reader away from it.
    if (open && !atBottom()) following = false;
    renderToLatest();
  }
  log.addEventListener("click", (event) => {
    const row = event.target.closest?.(".msg.dgc.has-work-fold > .work-toggle");
    if (row) toggleWorkFold(row.parentElement);
  });
  log.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest?.(".msg.dgc.has-work-fold > .work-toggle");
    if (!row) return;
    event.preventDefault();
    toggleWorkFold(row.parentElement);
  });
  function endTurn(reason = "completed", finalId) {
    if (!turn) return;
    flushText();
    finishReasoning();
    settleRetryLines(turn, reason);
    if (!replaying) undockAskCard("turn_end");
    turn.block.querySelectorAll(".card:not(.resolved)").forEach(resolveCard);
    turn.block.querySelectorAll('.tool[data-status="running"]').forEach((card) => {
      if (outlivesTheTurn(card) || reason === "moved") return;   // moved: it is still running, elsewhere
      setToolStatus(card, "stopped");
      const dot = card.querySelector(".dot");
      if (dot) dot.className = "dot deny";
    });
    clearInterval(turn.timer);
    clearTimeout(turn.recoverTimer);
    // A turn whose last act was a tool call has no prose after it to retire the group, so fold it
    // here. Every OTHER group in the turn was already folded when the model moved on; without
    // this the final one stays open and the turn reads inconsistently with the ones above it.
    releaseToolGroup();
    const nodes = [...turn.block.querySelectorAll(".text")];
    let answer = finalId != null ? nodes.find((n) => n.dataset.messageId === String(finalId)) : null;
    // Absent and null are different answers to the same question. A backend that never states the
    // field (or an internal caller ending a turn the protocol did not) keeps the old positional
    // rule -- the compatibility floor, exactly as a null MessagePhase means "legacy behaviour".
    // An explicit null is a statement: this turn designated no answer (it ended mid-tool), and
    // inventing one from the last node on screen is the guess this change exists to remove.
    if (!answer && (finalId === undefined
        // A stated id the panel has no node for is a lost message, not a statement that the turn
        // had no answer: without this the turn rendered with no answer block at all.
        || (finalId != null && !nodes.some((n) => n.dataset.messageId === String(finalId))))) {
      const last = nodes.at(-1);
      if (last && !last.classList.contains("commentary")) answer = last;
    }
    // After a turn ends there is no third state left: every block is either the answer or the
    // commentary around it. A bare `.text` was how a gate-round answer came to look finished.
    for (const n of nodes) if (n !== answer) markCommentary(n);
    if (answer) {
      answer.classList.remove("commentary", "commentary-detail");   // the stated id outranks any earlier guess
      answer.querySelector(":scope > .commentary-actions")?.remove();
      const complete = reason === "completed";
      if (complete) answer.classList.add("final");   // unfinished prose is not a final answer
      // The answer gets a block of its own: separated from the work above it, with room to
      // breathe, and its own actions inside it rather than floating underneath the turn.
      // What this turn changed, then what you can do about it — the two things a reader wants
      // at the end of an answer, in that order. A stopped or failed turn gets the actions too:
      // a partial answer is exactly the one a reader wants to copy or retry, and denying Copy
      // there was the opposite of helpful. The change summary stays gated on completion, because
      // a turn that did not finish has not finished changing things.
      const box = el("div", complete ? "answer complete" : "answer partial");
      answer.replaceWith(box);
      box.appendChild(answer);
      // The CLI's count of what this turn's recovery point restores, when it sent one (turn_files); else the
      // diffs this turn's own edit tools drew, as an older CLI (or a subscription engine's turn) leaves it.
      const summary = complete ? turnSummaryCard(turn.files ? turn.files.edits : turn.edits, turn.prompt, turn.files) : null;
      if (summary) box.appendChild(summary);
      box._turnPrompt = turn.prompt;                 // a later turn_files redraws this card with the same Undo
      // ...and finds it by its recovery point when the card was drawn from history (a reloaded window's turn ids are
      // the history's, not the backend's live ones).
      box._checkpoint = turn.files?.checkpoint || null;
      const actions = responseActions(answer, turn.prompt, !complete);
      // When the reply was written, first in its row: now, live; a saved turn's from its history.
      const writtenAt = window.DgcTime?.node(turn.replyAt ?? (replaying ? NaN : Date.now()));
      if (writtenAt) actions.prepend(writtenAt);
      box.appendChild(actions);
      // The work summary separates the collapsed activity from the final response.
      turn.block.insertBefore(turn.act, box);
    }
    turn.act.classList.add("done");
    turn.act.removeAttribute("title");
    const outcome = reason === "paused" ? "Paused" : reason === "cancelled" ? "Stopped" : reason === "error" ? "Failed"
      : reason === "moved" ? "Carrying on in another window" : "Worked";
    // A replayed turn has no running clock. A finished one whose history says when the prompt was sent and the
    // reply written worked from one to the other. A stopped or failed one ended some time after its last message,
    // which the session file doesn't say, and a session saved before DGC kept times says nothing: those say what
    // happened and stop there rather than printing a made-up number.
    const took = turn.t0 != null ? Date.now() - turn.t0
      : reason === "completed" && turn.promptAt > 0 && turn.replyAt >= turn.promptAt ? turn.replyAt - turn.promptAt : null;
    turn.act.textContent = took == null || reason === "moved" ? outcome : `${outcome} for ${Math.floor(took / 1000)}s`;
    if (answer && reason === "completed") foldTurnWork(turn.block, turn.act);
    const finished = turn.block;
    pipSetupCards?.finish(finished);
    pipDigestBar?.refresh();
    turn = null;
    // Repaint the checklist now that no turn is live. The row hides itself only when it renders
    // with every item done AND nothing running, and nothing re-rendered it at the end of a turn --
    // so a finished list sat at "Tasks 4/4 · all done" above the composer for the whole idle gap,
    // saying work was in hand when nothing was. It cleared only when the next prompt was sent.
    renderTodos(paintedTodos);
    if (replaying) return;
    // After every mutation this turn will make, so the height that gets pinned is the final one.
    // The end of a finished turn is its result — the summary of what it changed and what you can
    // do about it — so unless you have scrolled away to read something else, show it. Once now
    // and once on the next frame, because the rails and the composer settle a frame later and
    // each of them takes height from the transcript.
    requestAnimationFrame(() => {
      settleBlock(finished);
      if (following) scroll();
    });
    if (following) scroll();
  }
  // ---- what the turn changed, and what you can do about it ----
  // Codex shows three files then "Show N more files". A turn that touched twenty files should not
  // push its own Undo/Review controls off the screen.
  const TS_VISIBLE_ROWS = 3;
  function turnSummaryCard(edits, prompt, cli = null) {
    const files = [...(edits || new Map()).entries()];
    if (!files.length) return null;
    const additions = files.reduce((n, [, v]) => n + v.additions, 0);
    const deletions = files.reduce((n, [, v]) => n + v.deletions, 0);
    const card = el("div", "turn-summary");
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", "Files changed in this turn");
    // The directory is context and the filename is the thing, so they are drawn at different
    // weights -- one span at one colour makes the reader parse the path themselves.
    const splitPath = (path) => {
      const cut = String(path).lastIndexOf("/");
      return cut < 0 ? ["", String(path)] : [String(path).slice(0, cut + 1), String(path).slice(cut + 1)];
    };
    const row = ([path, v], i) => {
      const [dir, name] = splitPath(path);
      return `<button type="button" class="ts-row" data-file="${i}" title="Review ${esc(path)}">`
        + `<span class="change-path">${dir ? `<span class="path-dir">${esc(dir)}</span>` : ""}`
        + `<span class="path-name">${esc(name)}</span></span>`
        // A file outside the project changed by a DGC that has since restarted: its earlier version went with that
        // process (it is never saved), so Undo leaves it as it is, and says so here and in its count.
        + (v.command
            // One of the turn's own commands changed it, and DGC has no exact copy from before (uncommitted changes,
            // or Git doesn't track it): Undo leaves it, and says so here, in its count and in its last line.
            ? `<span class="ts-uncounted ts-no-undo ts-by-command" title="${esc(byCommandWhy(v.limit))}">Changed by a command — Undo leaves it</span>`
            : v.undoable === false
            ? `<span class="ts-uncounted ts-no-undo" title="Outside the project. DGC keeps the version from before this turn only while the session that changed it is running, so Undo leaves this file as it is now.">Can't undo</span>`
            : "")
        // "not diffable" is not "no change": a binary write or an oversized diff has no numbers
        // to show, and printing +0 −0 for it claims the file was untouched.
        + (v.command ? ""
          : v.counted === false
            ? uncountedLabel(v.status)
            : `<span class="change-add">+${v.additions}</span><span class="change-del">\u2212${v.deletions}</span>`)
        + `</button>`;
    };
    const counted = files.filter(([, v]) => v.counted !== false);
    const totals = counted.length
      ? `<span class="change-add">+${additions}</span><span class="change-del">\u2212${deletions}</span>`
      : `<span class="ts-uncounted">no line count</span>`;
    // The CLI lists at most 500 files and says how many there are in all.
    const many = cli ? Math.max(Number(cli.total) || 0, files.length) : files.length;
    const head = many === 1 ? "Edited 1 file" : `Edited ${many} files`;
    const shown = files.slice(0, TS_VISIBLE_ROWS);
    const rest = files.slice(TS_VISIBLE_ROWS);
    card.innerHTML = `<div class="ts-head"><span class="ts-mark">${icon("file-diff")}</span>`
      + `<span class="ts-heading"><span class="ts-title">${head}</span>`
      + `<span class="ts-totals">${totals}</span></span>`
      + `<span class="ts-actions">`
      + `<button type="button" class="ts-undo" title="Put these files back as they were before this turn">Undo <span class="codicon codicon-discard" aria-hidden="true"></span></button>`
      + `<button type="button" class="act ts-review" title="Open the diff for every file this chat changed">Review</button>`
      + `</span></div>`
      + `<div class="ts-list">${shown.map(row).join("")}`
      + (rest.length
          ? `<div class="ts-more" hidden>${rest.map((entry, i) => row(entry, i + TS_VISIBLE_ROWS)).join("")}</div>`
            + `<button type="button" class="ts-expand" aria-expanded="false">Show ${rest.length} more `
            + `${rest.length === 1 ? "file" : "files"} <span class="codicon codicon-chevron-down" aria-hidden="true"></span></button>`
          : "")
      + `</div>`;
    card.querySelectorAll("[data-file]").forEach((row) => row.onclick = () => {
      const entry = files[Number(row.dataset.file)];
      if (entry) vscode.postMessage({ type: "reviewChange", path: entry[0], scope: "chat" });
    });
    const expand = card.querySelector(".ts-expand");
    if (expand) expand.onclick = () => {
      const more = card.querySelector(".ts-more");
      const open = more.hidden;      // about to open?
      more.hidden = !open;
      expand.setAttribute("aria-expanded", String(open));
      // A one-way control is a trap: expanding a twenty-file list used to hide the only button on
      // the card, leaving no way back to three rows. The button stays and says what it does next.
      expand.innerHTML = open
        ? 'Show fewer <span class="codicon codicon-chevron-up" aria-hidden="true"></span>'
        : `Show ${rest.length} more ${rest.length === 1 ? "file" : "files"} `
          + '<span class="codicon codicon-chevron-down" aria-hidden="true"></span>';
    };
    card.querySelector(".ts-review").onclick = () => openChangesReview("chat");
    // Undo restores the workspace to the recovery point this turn opened. The extension
    // identifies it by the prompt, refuses when it can no longer find it, and confirms first.
    // With the CLI's card, Undo's question names the card's count (`exact`) -- the files Undo can put back -- and finds
    // the recovery point the CLI named. `later`: the turns after this one in the chat, which the rewind takes back too.
    const undoable = many - files.filter(([, v]) => v.undoable === false || v.command).length;
    // The files Undo puts back from Git because a command changed them (`by_command`): its question names them.
    card._byCommand = files.filter(([, v]) => v.byCommand).map(([path]) => path);
    card._gitMoved = !!(cli && cli.gitMoved);
    card.querySelector(".ts-undo").onclick = () => {
      const byCommand = commandRestores(card);
      const gitMoved = gitMovedFrom(card);
      vscode.postMessage({
        type: "undoTurn", prompt: String(prompt || ""), files: files.map(([path]) => path), later: laterTurns(card),
        ...(cli ? { exact: true, total: undoable, checkpoint: cli.checkpoint } : {}),
        ...(byCommand.length ? { byCommand } : {}), ...(gitMoved ? { gitMoved: true } : {}) });
    };
    return card;
  }
  // Why a file a command changed is one Undo leaves: the limit that kept DGC from copying it first, when one did.
  function byCommandWhy(limit) {
    const lead = "A command this turn ran changed this file, ";
    if (limit === "size") return `${lead}and it is over 5 MB, so DGC kept no copy of it from before: Undo leaves it as it is now.`;
    if (limit === "count") return `${lead}and it was past the 500 files with uncommitted changes DGC copies before one command: Undo leaves it as it is now.`;
    if (limit === "budget") return `${lead}and this session's room for copies was used up, so DGC kept no copy of it from before: Undo leaves it as it is now.`;
    return `${lead}and DGC has no exact copy of it from before (Git converts it, or an ignore rule changed with it), so Undo leaves it as it is now.`;
  }
  // Did a command in this turn or a later one move HEAD, the index or a stash? Undo leaves those, and its question says so.
  function gitMovedFrom(card) {
    const cards = [...log.querySelectorAll(".turn-summary")];
    const at = cards.indexOf(card);
    return (at < 0 ? [card] : cards.slice(at)).some((each) => each._gitMoved);
  }
  // What Undo on this card puts back from Git because a command changed it, across this turn and every later one (the
  // rewind takes them all back), each named once.
  function commandRestores(card) {
    const cards = [...log.querySelectorAll(".turn-summary")];
    const at = cards.indexOf(card);
    const names = [];
    for (const each of at < 0 ? [card] : cards.slice(at)) {
      for (const name of each._byCommand || []) if (!names.includes(name)) names.push(name);
    }
    return names;
  }
  // How many turns follow the one this card belongs to in the chat: Undo rewinds the conversation to just before its
  // prompt, so every one of them goes too.
  function laterTurns(card) {
    const block = card.closest(".msg.dgc");
    const turns = [...log.querySelectorAll(".msg.dgc:not(.archived)")];
    const at = turns.indexOf(block);
    return at < 0 ? 0 : turns.length - at - 1;
  }
  // What a row with no line count says instead. A file DGC counted (turn_files) says which kind it is; one from an
  // edit tool's result with no diff is the case it always was.
  function uncountedLabel(status) {
    const [label, why] = status === "new" ? ["New", "A new file: no line count"]
      : status === "deleted" ? ["Deleted", "Deleted: Undo puts it back"]
        : status === "modified" ? ["Changed", "No line count: a binary or very large file, or only its permissions changed"]
          : ["New", "No line count: a new, binary or oversized file"];
    return `<span class="ts-uncounted" title="${why}">${label}</span>`;
  }
  // A turn_files: what the turn's recovery point will restore, as the CLI counted it. For the running turn (or the one
  // being replayed) it is held until its turn_end draws the card; for a turn that has already ended -- a background
  // helper integrated into its recovery point later -- that turn's card is drawn again, in place.
  function turnFilesCard(ev) {
    const edits = new Map();
    for (const f of Array.isArray(ev.files) ? ev.files : []) {
      const path = String(f?.path || "").trim();
      if (!path) continue;
      edits.set(path, { additions: Number(f.additions) || 0, deletions: Number(f.deletions) || 0,
                        counted: f.counted === true, status: String(f.status || "modified"),
                        ...(f.undoable === false ? { undoable: false } : {}),
                        ...(f.command === true ? { command: true } : {}),
                        ...(f.by_command === true ? { byCommand: true } : {}),
                        ...(["size", "count", "budget"].includes(f.limit) ? { limit: f.limit } : {}) });
    }
    const checkpoint = Number.isInteger(ev.checkpoint_index) && typeof ev.checkpoint_preview === "string"
      ? { index: ev.checkpoint_index, preview: ev.checkpoint_preview } : null;
    return { edits, total: Number(ev.total) || edits.size, checkpoint, gitMoved: ev.git_moved === true };
  }
  function onTurnFiles(ev) {
    const id = String(ev.turn_id || "");
    if (turn && (!id || !turn.id || turn.id === id)) { turn.files = turnFilesCard(ev); return; }
    if (replaying || !id) return;
    const files = turnFilesCard(ev);
    const block = [...log.querySelectorAll(".msg.dgc")].find((node) => node._turnId === id);
    // A turn drawn from history (the window was reloaded) carries the history's turn id: it is found by the recovery
    // point its card named instead, which is the same in both.
    const box = block?.querySelector(":scope > .answer.complete")
      || (files.checkpoint && [...log.querySelectorAll(".answer.complete")].find((node) =>
        node._checkpoint?.index === files.checkpoint.index && node._checkpoint?.preview === files.checkpoint.preview));
    if (!box) return;
    box._checkpoint = files.checkpoint || box._checkpoint;
    const fresh = turnSummaryCard(files.edits, box._turnPrompt, files);
    const old = box.querySelector(":scope > .turn-summary");
    if (old && fresh) old.replaceWith(fresh);
    else if (old) old.remove();
    else if (fresh) box.insertBefore(fresh, box.querySelector(":scope > .response-actions"));
    repinBlockOf(box);
  }
  //: One rating per response, kept in this workspace and sent nowhere.
  // `partial` is a turn that stopped or failed. Its prose is not an answer and must not be styled
  // as one, but it is exactly the text a reader wants to keep or try again — so Copy and Retry
  // stay, and rating something half-written does not.
  // A fence longer than this buries the answer and pushes the response actions off screen.
  const CODE_FOLD_LINES = 24;
  // ---- mermaid diagrams ----
  // The runtime is ~5MB, so it is fetched the first time a diagram actually appears and never by
  // a panel that shows none. Two deliberate choices: the source is model output, so rendering
  // stays at mermaid's "strict" security level (no click bindings, no raw HTML in labels); and a
  // block that fails to parse keeps its original fence, because a broken diagram must not delete
  // the text the model wrote. The fence is kept either way behind a Show source toggle, so the
  // Copy button a reader expects on a code block never disappears.
  const SCRIPT_NONCE = (document.currentScript && document.currentScript.nonce) || "";
  let mermaidReady = null;
  function loadMermaid() {
    if (mermaidReady) return mermaidReady;
    const src = (document.body && document.body.dataset && document.body.dataset.mermaidSrc) || "";
    if (!src) return (mermaidReady = Promise.resolve(null));
    mermaidReady = new Promise((resolve) => {
      const tag = document.createElement("script");
      if (SCRIPT_NONCE) tag.nonce = SCRIPT_NONCE;   // the panel CSP admits scripts by nonce only
      tag.src = src;
      tag.onload = () => resolve(window.mermaid || null);
      tag.onerror = () => resolve(null);
      document.head.appendChild(tag);
    }).then((lib) => {
      if (!lib) return null;
      // Diagrams are read against the panel's own surfaces, so the theme comes from the same
      // tokens every other block uses rather than mermaid's stock palette.
      const token = (name, fallback) =>
        (getComputedStyle(document.documentElement).getPropertyValue(name) || "").trim() || fallback;
      try {
        lib.initialize({
          startOnLoad: false, securityLevel: "strict", theme: "base",
          // Without this, a diagram mermaid cannot parse is answered by appending a full-width
          // "Syntax error" bomb graphic to document.body -- outside the transcript, outside the
          // panel's layout, and impossible to dismiss. DGC handles the failure itself instead.
          suppressErrorRendering: true,
          fontFamily: token("--sans", "system-ui"), fontSize: 13,
          themeVariables: {
            background: token("--surface", "#202021"),
            primaryColor: token("--surface2", "#29292B"),
            primaryTextColor: token("--text", "#d4d4d6"),
            primaryBorderColor: token("--border-strong", "#3A3A3D"),
            secondaryColor: token("--code", "#151516"),
            tertiaryColor: token("--code", "#151516"),
            lineColor: token("--muted", "#9a9aa0"),
            textColor: token("--text", "#d4d4d6"),
          },
        });
      } catch { return null; }
      return lib;
    });
    return mermaidReady;
  }
  let mermaidSeq = 0;
  function renderMermaid(root) {
    const blocks = [...root.querySelectorAll('pre.code[data-language="mermaid"]:not([data-mermaid])')];
    if (!blocks.length) return;
    blocks.forEach((pre) => { pre.dataset.mermaid = "pending"; });
    loadMermaid().then((lib) => {
      if (!lib) { blocks.forEach((pre) => { pre.dataset.mermaid = "unavailable"; }); return; }
      blocks.forEach((pre) => drawMermaid(lib, pre));
    });
  }
  async function drawMermaid(lib, pre) {
    const code = pre.querySelector("code");
    const source = code ? code.textContent : "";
    if (!source.trim()) { pre.dataset.mermaid = "empty"; return; }
    let svg = "";
    try {
      // parse() first: it validates without touching the DOM, so an invalid diagram costs
      // nothing and never reaches the renderer.
      if (await lib.parse(source, { suppressErrors: true }) === false) {
        pre.dataset.mermaid = "failed"; return;
      }
      ({ svg } = await lib.render(`dgc-mermaid-${++mermaidSeq}`, source));
    } catch { pre.dataset.mermaid = "failed"; return; }
    if (!pre.parentNode) return;
    const figure = el("figure", "mermaid-figure");
    const art = el("div", "mermaid-art");
    art.innerHTML = svg;                       // mermaid sanitises at securityLevel "strict"
    const bar = el("figcaption", "mermaid-bar");
    const toggle = el("button", "fold", "Show source");
    toggle.type = "button";
    toggle.onclick = () => {
      pre.hidden = !pre.hidden;
      toggle.textContent = pre.hidden ? "Show source" : "Hide source";
    };
    bar.appendChild(toggle);
    pre.replaceWith(figure);
    pre.hidden = true;
    figure.append(art, bar, pre);
    pre.dataset.mermaid = "done";
  }

  // Everything that has to happen to rendered markdown after it lands in the DOM.
  function enrichMarkdown(root) {
    if (!root) return;
    foldLongCode(root);
    renderMermaid(root);
  }
  function foldLongCode(root) {
    root.querySelectorAll("pre.code:not([data-folded])").forEach((pre) => {
      pre.dataset.folded = "1";
      const code = pre.querySelector("code");
      const lines = code ? code.textContent.split("\n").length : 0;
      if (lines <= CODE_FOLD_LINES) return;
      pre.classList.add("foldable");
      const fold = el("button", "fold", `See all ${lines} lines`);
      fold.type = "button";
      fold.onclick = () => {
        const open = pre.classList.toggle("open");
        fold.textContent = open ? "Hide lines" : `See all ${lines} lines`;
      };
      pre.appendChild(fold);
    });
  }

  // ---- read aloud: the speaker under a reply (media/readaloud.js). In the side bar the Pips box has its own.
  // (var: a transcript restored before this line runs reads it as not-yet-made rather than throwing.)
  var replySeq = 0;
  var reader = window.DgcReadAloud ? window.DgcReadAloud.create({ post: (m) => vscode.postMessage({ ...m, from: "chat" }) }) : null;
  reader?.onError((text, kind) => sysLine(text, kind !== "info"));
  if (reader) new MutationObserver(() => reader.sync()).observe(log, { childList: true, subtree: true });

  function responseActions(textEl, prompt, partial = false) {
    const actions = el("div", "response-actions");
    if (partial) actions.classList.add("partial");
    const add = (act, icon, label) => {
      const b = el("button", `ract ract-${act}`, `<span class="codicon codicon-${icon}" aria-hidden="true"></span>`);
      b.type = "button"; b.title = label; b.setAttribute("aria-label", label); b.dataset.act = act;
      actions.appendChild(b); return b;
    };
    add("copy", "copy", partial ? "Copy what was written" : "Copy response");
    if (reader) {
      // Read aloud, in the voice Settings -> Voice chose (media/readaloud.js).
      const read = el("button", "ract ract-read",
        '<span class="codicon codicon-unmute ra-play" aria-hidden="true"></span><span class="codicon codicon-debug-stop ra-stop" aria-hidden="true"></span>');
      read.type = "button"; read.title = "Read aloud"; read.setAttribute("aria-label", "Read aloud"); read.setAttribute("aria-pressed", "false");
      read.dataset.act = "read"; read.dataset.readAloud = textEl.dataset.readId ||= `reply-${++replySeq}`;
      actions.appendChild(read);
    }
    if (!partial) {
      // Ratings are toggles, so they carry aria-pressed: without it a screen reader announces
      // "Good response, button" whether or not the rating is already applied, and gives no hint
      // that pressing again removes it. The visual `.on` class is the same state, seen.
      for (const [act, icon, label] of [
        ["up", "thumbsup", "Good response \u2014 kept in this workspace, sent nowhere"],
        ["down", "thumbsdown", "Poor response \u2014 kept in this workspace, sent nowhere"]]) {
        add(act, icon, label).setAttribute("aria-pressed", "false");
      }
      add("branch", "git-branch", "Branch into a new chat from here");
      // Recurring work belongs in a Pip. This only drafts the ask; nothing is sent or created.
      if (pipsOffered && String(prompt || "").trim()) add("pip", "calendar", "Make this a Pip that does it on a schedule");
    }
    add("retry", "refresh", "Run this prompt again");
    if (!partial) add("edit", "edit", "Edit this prompt and send it again");
    const body = () => textEl._markdown || textEl.textContent;
    actions.onclick = (event) => {
      const button = event.target.closest("[data-act]");
      if (!button) return;
      const act = button.dataset.act;
      if (act === "copy") { vscode.postMessage({ type: "copy", text: body() }); flashAction(button, "check"); return; }
      if (act === "read") { reader?.toggle(button.dataset.readAloud, body()); return; }
      if (act === "up" || act === "down") {
        const on = button.classList.contains("on");
        actions.querySelectorAll(".ract-up, .ract-down").forEach((b) => {
          b.classList.remove("on"); b.setAttribute("aria-pressed", "false");
        });
        if (!on) { button.classList.add("on"); button.setAttribute("aria-pressed", "true"); }
        vscode.postMessage({ type: "rateResponse", rating: on ? "none" : act, prompt: String(prompt || "") });
        return;
      }
      if (act === "branch") { vscode.postMessage({ type: "branchChat", prompt: String(prompt || "") }); return; }
      if (act === "pip") {
        setComposerText("Make this a Pip that does it on a schedule. Prepare a setup card for me to approve, "
          + "and ask me how often if that is not clear.\n\nThe task: " + String(prompt || "").trim());
        setComposerRange(composerText().length); input.focus(); onInput(); scroll();
        return;
      }
      if (act === "retry") { resend(prompt); return; }
      if (act === "edit") {
        setComposerText(String(prompt || "")); setComposerRange(composerText().length);
        input.focus(); onInput(); scroll();
      }
    };
    return actions;
  }
  // The most quotable text in a transcript was the only text you could not copy: response
  // actions attach to one block per turn, the final answer, while every mid-turn line is
  // commentary. This gives commentary its own copy, revealed on hover and on keyboard focus --
  // the button stays in the DOM and is only faded, so it can still be reached with Tab.
  // A mid-turn message is commentary. Most are one line ("Baseline is green. Starting change 1.").
  // One the user should read in full -- a diagnosis, or a plan before substantial work, which the
  // model is told it may write out with formatting and then keep working -- is laid out like an
  // answer instead (.commentary-detail): room above and below it and its Copy under it, so it is not
  // read as one more progress line between tool rows. The wire phase stays "commentary" (a new value
  // breaks older SDKs); the shape is read here, from the rendered block.
  const DETAIL_MIN_CHARS = 320;
  function isDetailedCommentary(textEl) {
    if (textEl.querySelector("h1, h2, h3, h4, h5, h6, ul, ol, pre, table, blockquote")) return true;
    if (textEl.querySelectorAll(":scope > p").length >= 2) return true;
    return String(textEl._markdown || textEl.textContent || "").trim().length >= DETAIL_MIN_CHARS;
  }
  function markCommentary(textEl) {
    if (!textEl) return;
    textEl.classList.add("commentary");
    textEl.classList.toggle("commentary-detail", isDetailedCommentary(textEl));
    commentaryCopy(textEl);
  }
  function commentaryCopy(textEl) {
    if (!textEl || textEl.querySelector(":scope > .commentary-actions")) return;
    const actions = el("div", "commentary-actions");
    const button = el("button", "ract ract-copy",
                      `<span class="codicon codicon-copy" aria-hidden="true"></span>`);
    button.type = "button";
    const what = textEl.classList.contains("commentary-detail") ? "Copy this message" : "Copy this line";
    button.title = what;
    button.setAttribute("aria-label", what);
    actions.appendChild(button);
    button.onclick = (event) => {
      event.stopPropagation();          // a commentary block can sit inside a clickable card
      vscode.postMessage({ type: "copy", text: textEl._markdown || textEl.textContent });
      flashAction(button, "check");
    };
    textEl.appendChild(actions);
  }
  function flashAction(button, icon) {
    const glyph = button.querySelector(".codicon"), was = glyph.className;
    glyph.className = `codicon codicon-${icon}`;
    setTimeout(() => { glyph.className = was; }, 1100);
  }
  // Retry runs the same prompt again without eating whatever is half-typed in the composer.
  function resend(prompt) {
    const text = String(prompt || "").trim();
    if (!text) return;
    const draft = composerText();
    // Borrowing the box to send is not an edit of the draft, so it leaves no steps behind: the box
    // reads the same before and after, and recordComposerEdit drops a step that changed nothing.
    let restored = false;
    recordComposerEdit(() => {
      setComposerText(text); submit();
      if (composerText() === "" && draft) { setComposerText(draft); restored = true; }
    });
    if (restored) onInput();
  }
  function discardTurn() {
    liveTurnHint = null;
    heldForSnapshot = null; clearTimeout(heldTimer); heldTimer = null;
    if (turn) {
      clearInterval(turn.timer);
      clearTimeout(turn.renderTimer);
      turn.block.querySelectorAll(".tool").forEach((card) => clearInterval(card._timer));
    }
    expireOpenRequests();
    turn = null;
    // Match the terminal: an all-done checklist folds away when idle so the next prompt's
    // list replaces it instead of sitting at "Tasks 4/4" above the composer.
    if (paintedTodos.length) renderTodos(paintedTodos);
  }
  // A checklist belongs to the session, not to a single assistant bubble, so it is not a card
  // in the transcript. It is a row in the composer rail, directly above the goal row and built from
  // the same parts: collapsed it reads "Tasks 2/5 · <the step in progress>", and expanded the full
  // list opens above the row inside the rail, scrolling within its own bounded panel. Every update
  // — a `todos` event mid-turn, or the `history` snapshot on resume and reload — repaints that one
  // row without inventing a running turn or starting a timer. Nothing here scrolls the transcript
  // or touches follow mode: a reader who scrolled up must stay where they are while the list ticks.
  const TODO_GLYPHS = {
    pending:     ["□", "pend",   "pending"],
    in_progress: ["▶", "doing",  "in progress"],
    done:        ["✓", "done",   "done"],
    blocked:     ["⊘", "block",  "blocked"],
    cancelled:   ["✗", "cancel", "cancelled"],
  };
  const TASKS_TIMEOUT_MS = 5000;
  // How long a Clear may wait for a backend that is reconnecting, the same bound a turn gets
  // (the backend_exit handler's thirty seconds) before it is reported as unanswered.
  const TASKS_RECONNECT_MS = 30000;
  const TASKS_NOT_RUNNING = "DGC is not running. Run DGC: Restart Backend, then clear the checklist again.";
  function tasksOpen() { return tasksExpanded.has(draftSession); }
  function paintTasksExpanded() {
    const open = tasksOpen(), toggle = $("tasks-toggle");
    $("tasks-panel").hidden = !open;
    const label = open ? "Hide the checklist" : "Show the checklist";
    for (const button of [$("tasks-main"), toggle]) button.setAttribute("aria-expanded", String(open));
    toggle.title = label; toggle.setAttribute("aria-label", label);
    $("tasks-main").title = label;
    toggle.querySelector(".codicon").className = `codicon codicon-chevron-${open ? "down" : "up"}`;
  }
  function toggleTasks() {
    if (tasksOpen()) tasksExpanded.delete(draftSession); else tasksExpanded.add(draftSession);
    paintTasksExpanded();
    persistDraft();
  }
  function showTasksNote(message) {
    const note = $("tasks-note");
    note.textContent = message || ""; note.title = message || ""; note.hidden = !message;
    tasksBar.classList.toggle("noted", Boolean(message));
    $("tasks-text").hidden = Boolean(message);   // the note takes the summary's place, never both
  }
  function paintTodoClearBusy(busy) {
    const button = $("tasks-clear"), icon = button.querySelector(".codicon");
    if (busy) button.setAttribute("aria-busy", "true"); else button.removeAttribute("aria-busy");
    icon.className = busy ? "codicon codicon-loading codicon-modifier-spin" : "codicon codicon-trash";
    const label = busy ? "Clearing the checklist" : "Clear the checklist";
    button.title = label; button.setAttribute("aria-label", label);
  }
  // A clear waiting on a backend that is restarting or still handshaking is not unanswered yet:
  // the command is held until it is back. The clock only runs against a live backend.
  function armTodoClearTimer() {
    if (!todoClear || todoClear.timer || !backendLive || !sessionReady) return;
    if (todoClear.reconnect) { clearTimeout(todoClear.reconnect); todoClear.reconnect = null; }
    todoClear.timer = setTimeout(() => {
      if (todoClear) todoClear.timer = null;
      settleTodoClear("DGC did not confirm the clear. Try again, or run DGC: Restart Backend.");
    }, TASKS_TIMEOUT_MS);
  }
  // The backend went away. Recovering, the clear is held for the new backend and its clock stops,
  // bounded by the reconnect allowance so a recovery that never completes cannot spin for ever.
  // Not recovering, nothing will ever answer: say so now.
  function pauseTodoClearTimer(recovering = true) {
    if (!todoClear) return;
    if (todoClear.timer) { clearTimeout(todoClear.timer); todoClear.timer = null; }
    if (!recovering) { settleTodoClear(TASKS_NOT_RUNNING); return; }
    if (!todoClear.reconnect) {
      todoClear.reconnect = setTimeout(() => {
        if (todoClear) todoClear.reconnect = null;
        settleTodoClear("DGC did not confirm the clear. Try again, or run DGC: Restart Backend.");
      }, TASKS_RECONNECT_MS);
    }
  }
  function requestTodoClear() {
    if (todoClear) return;                      // one clear at a time; the answer settles it
    // A backend that exited and is not coming back by itself cannot answer. Posting would start a
    // fresh one whose session restore could bring the list straight back, so say what to do.
    if (backendDown) { showTasksNote(TASKS_NOT_RUNNING); return; }
    todoClear = { timer: null, reconnect: null };
    showTasksNote("");
    paintTodoClearBusy(true);
    vscode.postMessage({ type: "clear_todos" });
    armTodoClearTimer();
  }
  // Every way a clear ends goes through here, and every one of them takes the old note down: a
  // refusal or timeout note must never sit beside a list it was not about.
  function settleTodoClear(message = "") {
    if (todoClear?.timer) clearTimeout(todoClear.timer);
    if (todoClear?.reconnect) clearTimeout(todoClear.reconnect);
    todoClear = null;
    paintTodoClearBusy(false);
    showTasksNote(message);
  }
  let paintedTodos = [];
  function renderTodos(value) {
    const rows = (Array.isArray(value) ? value : paintedTodos).filter((t) => t && typeof t.content === "string").slice(0, 100);
    if (Array.isArray(value)) paintedTodos = rows;
    const list = $("tasks-list"), count = $("tasks-count");
    if (!rows.length) {
      const hadFocus = tasksBar.contains(document.activeElement);
      settleTodoClear();
      list.innerHTML = ""; count.textContent = "Tasks 0/0"; $("tasks-text").textContent = "";
      $("tasks-blocked").hidden = true;
      tasksBar.hidden = true;
      syncComposerRail();
      // Clear removed the row the focus was on: land in the composer, the next thing to use.
      if (hadFocus) input.focus();
      return;
    }
    // A fresh list is never shown beside a stale note. A pending clear stays pending: the
    // backend's empty list or its refusal is what settles it.
    if (!todoClear) showTasksNote("");
    // Own keys only — a status of "constructor" must not fish a function out of the prototype.
    const statusOf = (t) => Object.hasOwn(TODO_GLYPHS, t.status) ? t.status : "pending";
    // Blocked items are not done: the counter is the same one the backend's completion gate reads.
    const complete = rows.filter((t) => t.status === "done").length;
    const doing = rows.find((t) => statusOf(t) === "in_progress");
    const pending = rows.filter((t) => statusOf(t) === "pending").length;
    const blocked = rows.filter((t) => statusOf(t) === "blocked").length;
    const cancelled = rows.filter((t) => statusOf(t) === "cancelled").length;
    count.textContent = `Tasks ${complete}/${rows.length}`;
    // "all done" only when every row is done. Cancelled rows are finished but not done, so a list
    // with nothing left open says how many were cancelled instead of contradicting its own count.
    const settled = doing ? "" : pending ? `${pending} pending` : blocked ? ""
      : cancelled ? `${cancelled} cancelled` : "all done";
    const summary = doing ? doing.content.replace(/\s+/g, " ").trim() : settled;
    $("tasks-text").textContent = summary;
    $("tasks-blocked").textContent = `${blocked} blocked`;
    $("tasks-blocked").hidden = blocked === 0;
    tasksBar.dataset.status = doing ? "active" : blocked ? "blocked" : pending ? "pending" : "done";
    $("tasks-main").setAttribute("aria-label", `Tasks, ${complete} of ${rows.length} done`
      + (doing ? `, in progress: ${summary.slice(0, 180)}` : settled ? `, ${settled}` : "")
      + (blocked ? `, ${blocked} blocked` : ""));
    list.innerHTML = rows.map((t) => {
      const g = TODO_GLYPHS[statusOf(t)];
      return `<div class="t ${g[1]}" role="listitem"><span class="ti" role="img" aria-label="${g[2]}">${g[0]}</span><span class="tc">${esc(t.content)}</span></div>`;
    }).join("");
    const open = Boolean(doing) || pending > 0 || blocked > 0;
    // Idle + every row done/cancelled: hide, same as the terminal todo pane.
    tasksBar.hidden = !open && !turn;
    paintTasksExpanded();
    syncComposerRail();
  }

  function ensureTurn() {
    if (turn) return;
    startTurn();
    if (!hostSessionSeen && !replaying) turn.beforeSession = true;
  }
  // Keep the live activity row at the visual edge of the active turn. New response text,
  // tool cards, diffs and decisions are inserted immediately before it, so a user following
  // the stream always sees that DGC is still running beneath the newest content.
  function appendTurnContent(node) { turn.block.insertBefore(node, turn.act); return node; }
  function appendConversationContent(node) {
    if (turn) return appendTurnContent(node);
    log.appendChild(node); return node;
  }
  function textBlock() { if (!turn.textEl) { turn.textEl = appendTurnContent(el("div", "text")); } return turn.textEl; }
  function flushText() {
    if (!turn) return;
    clearTimeout(turn.renderTimer); turn.renderTimer = null;
    if (turn.textEl && turn._buf) {
      turn.textEl._markdown = turn._buf;
      turn.textEl.innerHTML = md(turn._buf); turn.renderedAt = Date.now();
      enrichMarkdown(turn.textEl);
    }
  }
  function appendText(value) {
    turn._buf = (turn._buf || "") + value;
    const node = textBlock(); node._markdown = turn._buf;
    // A block the backend left open across a stall or length continuation keeps growing after the
    // "↻ … continuing from the partial output" line, the reconnect line (and any reasoning of the
    // continuation) was placed under it. Left there, that line ended up below the whole merged
    // answer card, reading as if the continuation came after the answer. It is part of the work
    // that led to the answer, so it moves above the block the moment the continuation's text
    // arrives. A replay draws the same order: the saved answer's reconnect lines come before it.
    let after = node.nextElementSibling;
    const passed = [];
    while (after && after !== turn.act
      && after.matches(".sys, .disclosure, .reasoning, .thought-note, .thought-static, .model-retry")) {
      passed.push(after); after = after.nextElementSibling;
    }
    if (passed.length && after === turn.act) for (const moved of passed) node.before(moved);
    // Replay renders inline: a batch timer would hand the fragment back to the pager half empty.
    if (replaying || !turn.renderedAt || Date.now() - turn.renderedAt >= 48) flushText();
    else if (!turn.renderTimer) turn.renderTimer = setTimeout(() => {
      const stick = atBottom(); flushText(); if (stick || following) scroll(); else noteNewContent();
    }, 48);
  }
  function breakText() { if (turn) { flushText(); turn.textEl = null; turn._buf = ""; turn.renderedAt = 0; } }

  // Closes the reasoning group (or streaming progress note) that is still taking deltas. Its label
  // then reads "Thought for Ns" from the backend's own seconds (see the 0.40 thinking section).
  function finishReasoning() {
    if (!turn) return;
    const group = turn.reasonGroup;
    turn.reasonGroup = null; turn.reasonNote = null; turn.reasonEl = null;
    if (group) { group.open = false; paintReasonGroup(group); }
  }

  // Say what the cards did (or are doing) in a sentence, the way a colleague would: "Read 5 files
  // and searched code", not a tally of function names. Counts only where the number tells you
  // something. The present tense uses the same buckets, so a running header and the finished one
  // it becomes read as the same sentence in two tenses.
  const TOOL_BUCKET = {
    read_file: "read", grep: "searched", glob: "searched", repo_map: "mapped",
    code_intel: "mapped", write_file: "created", create_file: "created",
    edit_file: "edited", apply_patch: "edited", multi_edit: "edited",
    bash: "ran", browser: "looked", web_search: "web", web_fetch: "web",
    view_image: "viewed",
  };
  // "viewed 2 images" counts the images the viewing steps returned, not the steps. Finished, it also
  // counts the images other steps in the group produced (a screenshot), so the count is said once.
  function viewedPhrase(cards, past) {
    const n = cards.reduce((total, card) => total + (TOOL_BUCKET[canonicalTool(card.dataset.toolName)] === "viewed"
      ? Math.max(1, card._images?.length || 0) : past ? card._images?.length || 0 : 0), 0);
    return past ? `viewed ${n} ${n === 1 ? "image" : "images"}` : n === 1 ? "viewing an image" : `viewing ${n} images`;
  }
  function toolSentence(cards, tense) {
    const counts = Object.create(null);
    for (const card of cards) {
      const key = TOOL_BUCKET[canonicalTool(card.dataset.toolName)] || "other";
      counts[key] = (counts[key] || 0) + 1;
    }
    const past = tense !== "present";
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    // The present tense reads "a file" for one: "Reading a file", not "Reading 1 file".
    const some = (n, one, many) => (past ? plural(n, one, many) : n === 1 ? `a ${one}` : `${n} ${many}`);
    // One running tool DGC has a specific verb for ("Updating plan", "Delegating") keeps it.
    const loneOther = counts.other === 1
      ? cards.find((card) => !TOOL_BUCKET[canonicalTool(card.dataset.toolName)]) : null;
    const loneName = loneOther && canonicalTool(loneOther.dataset.toolName);
    const agent = loneOther && NAMES_ITS_AGENT.has(loneName)
      ? String(loneOther.querySelector(".arg")?.textContent || "").trim() : "";
    const named = agent ? `${TOOL_COPY[loneName][past ? 1 : 0].toLowerCase()} ${agent}` : "";
    const lone = !past ? loneOther : null;
    const loneCopy = lone && (named || LONE_PRESENT[loneName] || TOOL_COPY[loneName]?.[0].toLowerCase());
    const otherPresent = loneCopy ? loneCopy
      : lone && String(lone.dataset.toolName).startsWith("mcp__") ? "calling an MCP tool"
        : `using ${some(counts.other || 0, "tool", "tools")}`;
    const phrases = [
      counts.read && `${past ? "read" : "reading"} ${some(counts.read, "file", "files")}`,
      counts.edited && `${past ? "edited" : "editing"} ${some(counts.edited, "file", "files")}`,
      counts.created && `${past ? "created" : "creating"} ${some(counts.created, "file", "files")}`,
      counts.ran && `${past ? "ran" : "running"} ${some(counts.ran, "command", "commands")}`,
      counts.searched && (past ? "searched code" : "searching code"),
      counts.mapped && (past ? "mapped the project" : "mapping the project"),
      counts.looked && `${past ? "looked at" : "looking at"} ${some(counts.looked, "page", "pages")}`,
      counts.viewed && viewedPhrase(cards, past),
      counts.web && (past ? "searched the web" : "searching the web"),
      counts.other && (past ? named || `used ${plural(counts.other, "tool", "tools")}` : otherPresent),
    ].filter(Boolean);
    const sentence = phrases.length > 1
      ? `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`
      : (phrases[0] || (past ? "Worked" : "Working"));
    return sentence.charAt(0).toUpperCase() + sentence.slice(1);
  }
  // The order toolSentence() joins its phrases in. "The first phrase" is therefore already a
  // computed thing, and the header can wear it.
  const BUCKET_ORDER = ["read", "edited", "created", "ran", "searched", "mapped", "looked", "viewed", "web", "other"];
  // The header wears the leading action of the sentence it already prints — and, when one kind of
  // tool did that action, that tool's own mark. The counts come from the same buckets that wrote
  // the words, so the icon and the sentence can never disagree: "Read files, ran a command" is a
  // book, "Edited a file, ran commands" a pencil, "Ran 1 command" a terminal.
  function headerIcon(cards) {
    const bucketOf = (card) => TOOL_BUCKET[canonicalTool(card.dataset.toolName)] || "other";
    const lead = BUCKET_ORDER.find((key) => cards.some((card) => bucketOf(card) === key));
    if (!lead) return ICON_FALLBACK;
    // One kind of tool led the sentence: say which one. Five tools and nine CLI names live in
    // `other`, so without this a group that only updated the plan, or only loaded a skill, wore
    // the same generic wrench as a genuinely mixed bag.
    const marks = new Set(cards.filter((card) => bucketOf(card) === lead)
      .map((card) => iconForTool(card.dataset.toolName)));
    const only = marks.size === 1 ? [...marks][0] : null;
    if (only && only !== ICON_FALLBACK) return only;
    return BUCKET_ICON[lead] || ICON_FALLBACK;
  }
  function refreshToolGroup(group) {
    if (!group) return;
    const all = [...group.querySelectorAll(":scope > .tool")];
    const cards = all.filter((card) => !card.classList.contains("agent-owned") && !card.classList.contains("pip-run-owned"));
    if (!cards.length) {
      if (all.length) group.classList.add("agent-owned");
      if (turn && turn.toolGroup === group) turn.toolGroup = null;
      syncLiveStep();
      return;
    }
    group.classList.remove("agent-owned");
    const running = cards.filter(card => card.dataset.status === "running");
    const failures = cards.filter(card => ["failed", "denied", "stopped"].includes(card.dataset.status));
    const summary = group.querySelector(".tool-group-label");
    group.classList.toggle("running", running.length > 0);
    // Running, the header says what is happening in the present tense ("Running a command",
    // "Editing 2 files and running a command") and never repeats a card's argument: the card
    // below holds the command or path, and the header used to print it a second time.
    const executed = cards.filter(card => !["denied", "blocked"].includes(card.dataset.status));
    let sentence = running.length ? toolSentence(running, "present")
      : executed.length ? toolSentence(executed, "past") : "No tools ran";
    // Images a step produced, where the sentence did not already count them ("viewed 2 images").
    const viewing = cards.some((card) => TOOL_BUCKET[canonicalTool(card.dataset.toolName)] === "viewed");
    const images = viewing ? 0 : cards.reduce((n, card) => n + (card._images?.length || 0), 0);
    if (!running.length && images) sentence += ` · ${images} ${images === 1 ? "image" : "images"}`;
    if (!running.length && failures.length) {
      sentence += ` · ${failures.length} ${failures.length === 1 ? "issue" : "issues"}`;
    }
    summary.textContent = sentence;
    // The thinking that led to the steps rides on them as marks; the line adds it up: "· thought 13s".
    const thought = thoughtWords(group);
    if (thought) summary.appendChild(el("span", "tg-thought")).textContent = ` · ${thought}`;
    // The icon tracks what is happening NOW: running cards while any is running, then everything
    // that actually ran. "No tools ran" keeps the denied steps' own mark — a refused `rm -rf dist`
    // is still a command, and saying so is strictly more useful than a shrug.
    setIcon(group.querySelector(":scope > summary > .tg-icon"),
      headerIcon(running.length ? running : executed.length ? executed : cards));
    // Error counts stay visible in the summary. Tool output only expands on
    // the reader's click; progress and failures never take over their scroll.
    syncLiveStep();
  }
  // "thought 13s": the main model's finished thinking inside a group (the marks on its steps and a
  // thought that ended the stretch), from the seconds the backend stated. A block still streaming
  // is not counted yet; blocks that kept no timing make it plain "thought".
  function thoughtWords(group) {
    const ended = [...group.querySelectorAll(".disclosure:not(.agent-owned), .thought-static:not(.agent-owned)")]
      .filter((node) => node.dataset.seconds !== undefined);
    if (!ended.length) return "";
    const seconds = ended.reduce((sum, node) => sum + (Number(node.dataset.seconds) || 0), 0);
    return seconds >= 0.5 ? `thought ${Math.round(seconds)}s` : "thought";
  }
  // A thought's label as a mark on a step: "thought 2s", "thought", "thinking…". The word is its own
  // span, so a narrow side bar can keep just the seconds beside the mark's bulb (main.css).
  function markWords(label) {
    const text = String(label || "").trim();
    return text === "Thinking…" ? "thinking…" : text.replace(/^Thought for /, "thought ").replace(/^Thought$/, "thought");
  }
  function paintMarkLabel(label, words) {
    if (!label || label.textContent === words) return;
    const [word, ...rest] = words.split(" ");
    label.replaceChildren(el("span", "tm-word"), document.createTextNode(rest.length ? ` ${rest.join(" ")}` : ""));
    label.firstChild.textContent = word;
  }
  // One line per stretch of work. Everything the model does between two pieces of prose it wrote is one
  // group, and its thinking no longer ends the group (that was decision D7: think, step, think, step drew
  // a "Thought" row and a "Ran 1 command" row each time, twelve rows for six commands). The main model's
  // thinking since the stretch's last step -- drawn inside the open group while the stretch works, or
  // just above the activity row before its first step -- becomes marks on the step it led to. A
  // sub-agent's hidden rows are passed over; anything else on screen (prose, a note, a notice, an
  // approval card) is where the thinking stops belonging to this step, and it stays where it is.
  function pendingThoughts() {
    const found = [];
    let node = turn.toolGroup ? turn.toolGroup.lastElementChild
      : turn.act ? turn.act.previousElementSibling : turn.block.lastElementChild;
    for (; node && node.tagName !== "SUMMARY"; node = node.previousElementSibling) {
      if (node.classList.contains("agent-owned")) continue;
      if (!node.matches(".disclosure, .reasoning, .thought-static")) break;
      found.unshift(node);
    }
    return found;
  }
  // The same rows, moved, never redrawn: a header becomes a small mark after the step's name, and its
  // body (the thought's text, as it was) opens under the step's head. A block that is somehow still
  // streaming keeps streaming into it.
  function markThoughts(card, nodes) {
    const head = card.querySelector(":scope > .head");
    let at = head?.querySelector(":scope > .tool-toggle");
    if (!at) return;
    let below = head;
    for (const node of nodes) {
      if (node.matches(".reasoning")) { below.after(node); below = node; continue; }
      node.classList.add("thought-mark");
      at.after(node); at = node;
      if (node._reason) paintReasonGroup(node._reason);
      else {
        const label = node.querySelector(".thought-label");
        paintMarkLabel(label, markWords(label?.textContent));
      }
    }
  }
  // A DGC delegation from the chat's own model: the step that starts a sub-agent the transcript
  // draws as an agent line. The exact name, not canonicalTool(): Claude's and Codex's own "Task"
  // send no agent frames, so their card is the only view of that work and keeps today's grouping.
  // A child's spawn (a sub- prefixed call id) is the child's work and is grouped like its other steps.
  function isTopLevelSpawn(card) { return card.dataset.toolName === "task" && !agentIdFromCall(card.dataset.callId); }
  function appendTool(card) {
    if (!turn) return;
    // Every delegation gets a group of its own, and the step's next tool opens a new one below it,
    // so the agent line drawn after the spawn sits between them. Live, the claim hides the spawn's
    // group the moment its agent starts; a replay draws every call of the step before any result,
    // and without this a [task, bash] step put the bash group above the line after a reload and
    // below it live. The group the spawn left folds when the model moves on, like any other.
    // A question the chat's own model asked you is part of the conversation, not tool work: it stands in the
    // transcript between the groups around it (Claude Code's "Questions"), rather than folding away inside
    // "Used 1 tool" when the model moves on. A sub-agent's question stays with that agent's steps.
    if (card.dataset.toolName === "propose_options" && !agentIdFromCall(card.dataset.callId)) {
      if (turn.toolGroup) { (turn.leftGroups ||= []).push(turn.toolGroup); turn.toolGroup = null; }
      card.classList.add("asked-standalone");
      appendTurnContent(card);
      syncLiveStep();
      return;
    }
    const spawn = isTopLevelSpawn(card) || (card.dataset.toolName === "run_pip_now" && !agentIdFromCall(card.dataset.callId));
    if (spawn && turn.toolGroup) { (turn.leftGroups ||= []).push(turn.toolGroup); turn.toolGroup = null; }
    // The thinking that led to a step of the main model's own rides on it. A delegation's thinking
    // stays a row: its group hides once the agent starts, and the thought must not hide with it.
    const thoughts = spawn || agentIdFromCall(card.dataset.callId) ? [] : pendingThoughts();
    if (!turn.toolGroup) {
      turn.toolGroup = appendTurnContent(el("details", "tool-group"));
      turn.toolGroup.innerHTML = `<summary><span class="tg-icon" data-icon="wrench" aria-hidden="true">${icon("wrench")}</span>`
        + '<span class="tool-group-label">Working</span></summary>';
      // Start compact during live work and replay. Opening this native details
      // control is the reader's choice and survives later tool updates.
      turn.toolGroup.open = false;
    }
    turn.toolGroup.appendChild(card);
    if (thoughts.length) markThoughts(card, thoughts);
    refreshToolGroup(turn.toolGroup);
    if (spawn) { turn.toolGroup = null; syncLiveStep(); }
  }
  // ---- the step running now -----------------------------------------------------------------------
  // While a stretch works, one row under its line says what it is doing now: the step running, with
  // its timer ("Running npm test 2.1s"), "Thinking… 3s" while the model thinks between steps, or the
  // last step done until the next one starts. It is one row, updated in place, from the stretch's first
  // step until prose (or the turn's end) closes the stretch; then it goes and the line stays. An opened
  // group shows the steps themselves, so the row hides under it. A replayed turn has nothing running.
  function syncLiveStep() {
    if (!turn) return;
    const owner = turn;
    // (A reloaded turn is adopted while its page is still a fragment on its way into the log, so the
    // group need not be connected yet.)
    const group = !replaying && owner.toolGroup?.parentNode && !owner.toolGroup.classList.contains("agent-owned")
      ? owner.toolGroup : null;
    if (!group) {
      owner.liveStep?.remove(); owner.liveStep = null;
      clearInterval(owner.liveTick); owner.liveTick = 0;
      return;
    }
    let live = owner.liveStep;
    if (!live) {
      live = owner.liveStep = el("div", "tg-live");
      live.innerHTML = '<span class="tg-live-spin codicon codicon-loading" aria-hidden="true"></span>'
        + '<span class="tg-live-verb"></span> <span class="tg-live-arg"></span> <span class="tg-live-time"></span>';
    }
    if (group.nextElementSibling !== live) group.after(live);
    paintLiveStep(owner);
    if (!owner.liveTick) {
      owner.liveTick = setInterval(() => {
        if (turn !== owner || !owner.liveStep?.isConnected) { clearInterval(owner.liveTick); owner.liveTick = 0; return; }
        paintLiveStep(owner);
      }, 250);
    }
  }
  function paintLiveStep(owner) {
    const live = owner.liveStep, group = owner.toolGroup;
    if (!live || !group) return;
    const items = [...group.children].filter((node) => node.matches(".tool, .disclosure, .thought-static")
      && !node.classList.contains("agent-owned") && !node.classList.contains("pip-run-owned"));
    const last = items.at(-1);
    const runningCard = items.filter((node) => node.matches(".tool") && node.dataset.status === "running").at(-1);
    const reason = last?._reason;
    let state = "done", verb = "", arg = "", time = "";
    if (reason && reasonLabel(reason) === "Thinking…") {
      state = "thinking"; verb = "Thinking…";
      const seconds = reason.startedAt == null ? 0 : Math.floor((Date.now() - reason.startedAt) / 1000);
      time = seconds >= 1 ? `${seconds}s` : "";
    } else if (runningCard || last?.matches(".tool")) {
      const card = runningCard || last;
      state = runningCard ? "running" : "done";
      verb = card.querySelector(".verb")?.textContent || "";
      arg = card.querySelector(".arg")?.textContent || "";
      time = card.querySelector(".tool-time")?.textContent || "";
    } else if (reason) verb = reasonLabel(reason);
    else if (last) verb = (last.querySelector(".thought-label")?.textContent || "").trim();
    if (live.dataset.state !== state) live.dataset.state = state;
    for (const [selector, text] of [[".tg-live-verb", verb], [".tg-live-arg", arg], [".tg-live-time", time]]) {
      const node = live.querySelector(selector);
      if (node.textContent !== text) node.textContent = text;
    }
  }

  // Tools whose summary is a shell command, so there is something worth copying verbatim.
  const COMMAND_TOOLS = new Set(["bash", "bash_output", "monitor"]);

  function copyCommandBtn(command) {
    const button = el("button", "ract tool-copy-cmd",
                      `<span class="codicon codicon-copy" aria-hidden="true"></span>`);
    button.type = "button";
    button.title = "Copy command";
    button.setAttribute("aria-label", "Copy command");
    button.onclick = (event) => {
      event.stopPropagation();       // the head is a toggle; copying must not open the card
      vscode.postMessage({ type: "copy", text: String(command || "") });
      flashAction(button, "check");
    };
    return button;
  }

  function openFileBtn(path, line) {
    const b = el("button", "link open-file", icon("external-link", "xs") + "<span>open</span>"); b.type = "button";
    b.dataset.path = path;
    if (line) b.dataset.line = String(line);
    b.setAttribute("aria-label", `Open ${path}${line ? ` at line ${line}` : ""}`);
    b.title = `Open ${path}${line ? ` at line ${line}` : ""} in the editor`;
    b.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: "openFile", path, line }); };
    return b;
  }

  function setToolStatus(card, status) {
    const value = String(status || "");
    card.dataset.status = value;
    const label = card.querySelector(".tool-status");
    if (label) label.textContent = value;
    const copy = toolCopy(card.dataset.toolName || "");
    const verb = card.querySelector(".verb");
    if (verb) {
      verb.textContent = value === "running" ? copy.present
        : value === "completed" ? copy.past
          : value === "failed" ? `${copy.past} · failed`
            : value === "blocked" ? `${copy.past} · blocked, repeated call`
              : value === "denied" ? `${copy.present} · denied`
              : value === "stopped" ? `${copy.past} · stopped` : copy.past;
    }
    if (value !== "running") {
      clearInterval(card._timer);
      const elapsed = card.querySelector(".tool-time");
      if (elapsed && card._startedAt) {
        const seconds = (Date.now() - card._startedAt) / 1000;
        elapsed.textContent = seconds >= 1 ? `${seconds.toFixed(1)}s` : "";
      }
    }
    refreshToolGroup(card.closest(".tool-group"));
  }

  function startToolClock(c) {
    if (c._timer) return;
    const elapsed = c.querySelector(".tool-time");
    c._timer = setInterval(() => {
      const seconds = (Date.now() - c._startedAt) / 1000;
      if (elapsed) elapsed.textContent = seconds >= 1 ? `${seconds.toFixed(1)}s` : "";
    }, 200);
  }
  // `detached`: a card drawn somewhere other than the live turn (an agent page rebuilt from the
  // agent's own step log). It is never put in the turn, never breaks the turn's streaming text, never
  // runs a clock and is never offered to the agents lane.
  function toolCard(ev, { detached = false } = {}) {
    const c = el("div", "tool");
    c.dataset.toolName = String(ev.name || "");
    c.dataset.callId = String(ev.call_id || "");
    c.dataset.summary = String(ev.summary || "");
    c._startedAt = Date.now();
    const copy = toolCopy(ev.name);
    // A delegation is named by what it was asked to do. The CLI's summary of a task call is empty
    // (dgc/ui.py arg_summary has no key for it), and a refused one carries the refusal there.
    const described = canonicalTool(ev.name) === "task" && typeof ev.args?.description === "string"
      ? ev.args.description.replace(/\s+/g, " ").trim() : "";
    // The prompt a delegation was given, which its agent's card in the agent map shows. Not drawn on
    // the card itself: the transcript names the agent, its page shows the work.
    if (canonicalTool(ev.name) === "task" && typeof ev.args?.prompt === "string") c._agentPrompt = ev.args.prompt.slice(0, 20000);
    const detail = [copy.target, described || ev.summary || ""].filter(Boolean).join(" · ");
    const bodyId = `tool-output-${++disclosureId}`;
    const pluginMark = pluginLogoHtml(ev.name);
    c.innerHTML = `<div class="head"><button type="button" class="tool-toggle" aria-expanded="false" aria-controls="${bodyId}" title="${esc(ev.name || "tool")}"><span class="chev" aria-hidden="true">›</span><span class="glyph" aria-hidden="true">${pluginMark || icon(iconForTool(ev.name))}</span><span class="verb">${copy.present}</span><span class="arg">${esc(detail)}</span></button></div><div class="body" id="${bodyId}"><pre></pre></div>`;
    const head = c.querySelector(".head");
    const toggle = c.querySelector(".tool-toggle");
    toggle.onclick = () => {
      if (c.classList.contains("no-body")) return;
      const open = c.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
      if (open) imagesOnCardOpen(c);          // images: the chip row is drawn on first open
    };
    if (["read_file", "write_file", "edit_file", "apply_patch"].includes(ev.name) && ev.summary) head.appendChild(openFileBtn(ev.summary));
    // The command a card ran is the thing people most often want out of a transcript -- to paste
    // into a terminal, or into a bug report. Only for cards whose summary IS a command; a file
    // path already has Open beside it, and copying a verb would be noise.
    if (COMMAND_TOOLS.has(canonicalTool(ev.name)) && ev.summary) head.appendChild(copyCommandBtn(ev.summary));
    const status = el("span", "sr-only tool-status", "running");
    toggle.appendChild(status);
    // Nothing is running in a replayed turn, so neither the pulse nor the stopwatch is started:
    // both would be animating a step that finished before the window was reopened.
    const dot = el("span", replaying || detached ? "dot" : "dot run"); dot.setAttribute("aria-hidden", "true");
    head.appendChild(dot);
    head.appendChild(el("span", "badge"));
    head.appendChild(el("span", "tool-time", ""));
    if (!replaying && !detached) startToolClock(c);
    setToolStatus(c, "running");
    if (detached) return c;
    appendTool(c); breakText(); agentsOnToolCard(c, ev); return c;
  }
  // A tool card shows its output as soon as there is any: the head says what ran, the body shows
  // the first few lines of what came back, and the toggle opens the rest. The body used to be
  // hidden until clicked, so a collapsed group inside a collapsed body meant the work was
  // invisible twice over.
  function setToolOutput(card, text) {
    const value = String(text || "");
    const pre = card.querySelector(".body pre");
    if (pre) pre.textContent = value;
    card.classList.toggle("has-output", !!value.trim());
    return value;
  }
  function renderDiff(diff) {
    const wrap = el("div", "diff open");
    const newPath = (diff.match(/^\+\+\+\s+([^\n\t]+)/m) || [])[1];
    const oldPath = (diff.match(/^---\s+([^\n\t]+)/m) || [])[1];
    const rawPath = newPath && newPath !== "/dev/null" ? newPath : oldPath;
    const path = String(rawPath || "changed file").replace(/^[ab]\//, "").replace(/^\/+/, "");
    let additions = 0, deletions = 0, oldLine = null, newLine = null;
    const body = diff.split("\n").map((line) => {
      const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
      let cls = "ctx", oldNo = "", newNo = "";
      if (hunk) { cls = "hh"; oldLine = Number(hunk[1]); newLine = Number(hunk[2]); }
      else if (line.startsWith("---") || line.startsWith("+++")) cls = "hh";
      else if (line.startsWith("+")) { cls = "add"; newNo = newLine ?? ""; if (newLine !== null) newLine++; additions++; }
      else if (line.startsWith("-")) { cls = "del"; oldNo = oldLine ?? ""; if (oldLine !== null) oldLine++; deletions++; }
      else { oldNo = oldLine ?? ""; newNo = newLine ?? ""; if (oldLine !== null) oldLine++; if (newLine !== null) newLine++; }
      return `<span class="${cls}"><span class="ln old">${oldNo}</span><span class="ln new">${newNo}</span><span class="dc">${esc(line) || " "}</span></span>`;
    }).join("");
    const bodyId = `diff-body-${++disclosureId}`;
    wrap.innerHTML = `<div class="dhead"><button type="button" class="diff-toggle" aria-expanded="true" aria-controls="${bodyId}"><span class="chev" aria-hidden="true">⌄</span><span class="dg" aria-hidden="true">${icon("file-diff")}</span><span class="f">${esc(path)}</span><span class="diff-stat add-stat">+${additions}</span><span class="diff-stat del-stat">−${deletions}</span><span class="diff-action sr-only">Hide diff</span></button></div><pre id="${bodyId}">${body}</pre>`;
    const toggle = wrap.querySelector(".diff-toggle");
    toggle.title = "Collapse this diff";
    toggle.onclick = () => {
      const open = wrap.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.querySelector(".chev").textContent = open ? "⌄" : "›";
      toggle.querySelector(".diff-action").textContent = open ? "Hide diff" : "Review";
      toggle.title = open ? "Collapse this diff" : "Show what changed in this file";
    };
    if (path !== "changed file") wrap.querySelector(".dhead").appendChild(openFileBtn(path));
    wrap.dataset.path = path; wrap.dataset.add = String(additions); wrap.dataset.del = String(deletions);
    return wrap;
  }
  //: Tools that change files on disk. Their diffs are what the end-of-turn summary counts.
  // The only image URIs the panel ever renders: an inline base64 image of an allowed type.
  const IMAGE_DATA = /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/;

  const EDIT_TOOLS = new Set(["edit_file", "write_file", "multi_edit", "apply_patch", "create_file"]);
  // A diff is this turn's edit only when a file-editing tool made it: DGC's own, or a subscription
  // engine's under its vendor name (Claude Code's Edit/Write/MultiEdit, Gemini's and Qwen's replace).
  // A shell printing `git diff`, or an MCP tool returning a pull request's diff, shows a diff of
  // changes made elsewhere; listing those as edits offered an Undo for them.
  const VENDOR_EDIT_TOOLS = /^(edit|multiedit|write|writefile|create|replace|str_replace_editor|str_replace_based_edit_tool|notebookedit)$/i;
  const isEditTool = (name) => EDIT_TOOLS.has(String(name || "")) || VENDOR_EDIT_TOOLS.test(String(name || ""));
  // `counted` separates "we diffed it and the totals are these" from "we never had a diff to
  // count" -- a brand-new file, a binary write, or a change over MAX_DIFF_BYTES. Without it both
  // arrive as 0/0, and the summary printed "+0 −0", which reads as "nothing changed" when it
  // means "not diffable". The review panel already draws that distinction; this is the same data
  // reaching the other renderer.
  function recordEdit(path, additions = 0, deletions = 0, counted = true) {
    const name = String(path || "").replace(/^[ab]\//, "").replace(/^\/+/, "").trim();
    if (!turn || !name || name === "changed file") return;
    const prior = turn.edits.get(name) || { additions: 0, deletions: 0, counted: false };
    turn.edits.set(name, { additions: prior.additions + (Number(additions) || 0),
                           deletions: prior.deletions + (Number(deletions) || 0),
                           counted: prior.counted || !!counted });
  }
  function decisionCard(inner, label = "DGC decision") { const c = el("div", "card"); c.setAttribute("role", "group"); c.setAttribute("aria-label", label); c.innerHTML = inner; appendConversationContent(c); breakText(); return c; }
  function requestArtifactStop(id, container, button) {
    if (!id || button.disabled) return;
    container.dataset.artifactId = String(id);
    container.classList.add("stopping");
    button.disabled = true;
    button.textContent = "Stopping…";
    vscode.postMessage({ type: "stopArtifact", id });
  }
  function settleArtifactStop(message) {
    const id = String(message.id || "");
    const targets = [...document.querySelectorAll("[data-artifact-id]")]
      .filter((node) => node.dataset.artifactId === id);
    targets.forEach((node) => {
      const stop = node.querySelector("[data-artifact-stop]");
      node.classList.remove("stopping");
      if (message.state === "stopped") {
        if (node.classList.contains("artifact-list-row")) { node.remove(); return; }
        node.classList.add("stopped");
        node.querySelectorAll("button").forEach((button) => { button.disabled = true; });
        const label = node.querySelector(".anm"); if (label) label.textContent = "Artifact stopped";
        if (stop) stop.textContent = "Stopped";
      } else if (message.state === "error" && stop) {
        stop.disabled = false;
        stop.textContent = "Retry stop";
      }
    });
    if (message.state === "error") {
      sysLine(String(message.error || "DGC could not stop the artifact preview."), true);
    }
  }
  // A troupe (many sub-agents on one work order, in the background) is a row in the composer rail, not a card in the
  // chat: the newest troupe's title, the stage it is on and Stop on one line; open, every troupe's stages with their
  // progress. troupe_started adds one, progress and the end update it, and a `troupes` snapshot (a reconnect) brings
  // back a running one. A finished troupe stays to say how it ended and where its results are until it is
  // dismissed, the next message is sent, or the chat changes.
  const troupeRuns = new Map();        // run_id -> its latest event, oldest first
  const troupeStopping = new Set();    // Stop was pressed; the run's own end settles it
  let troupesOpen = false;
  const TROUPE_STATES = { running: "Running", done: "Done", stopped: "Stopped", failed: "Failed" };
  // The mark: four tiles in the agent faces' colours (media/agents/), each a pale base under blurred orbs, as a face
  // is. Clockwise, so a running troupe's tiles light up in turn around the square.
  const TROUPE_TILES = [[2, 2, ["#D2E7DD", "#BEE2D1", "#50E5CB", "#4261D9"]], [12.6, 2, ["#EBD8CE", "#E8C8B7", "#EB4A4A", "#DF3C83"]],
                        [12.6, 12.6, ["#EAE8CF", "#E6E4B9", "#EBAD4A", "#DF653C"]], [2, 12.6, ["#CED7EB", "#B7C7E8", "#5C4AEB", "#AB3CDF"]]];
  // `id` prefixes its gradients' ids. A second copy (the troupe's chip) needs its own: url(#…) finds the first element
  // with that id in the page, and the row's copy is not drawn while the row is folded into its chip.
  function troupeMark(id = "troupe-mark") {
    const defs = [`<filter id="${id}-blur" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="1.1"/></filter>`];
    const tiles = TROUPE_TILES.map(([x, y, [base, ...hues]], i) => {
      defs.push(`<clipPath id="${id}-c${i}"><rect x="${x}" y="${y}" width="9.4" height="9.4" rx="2.6"/></clipPath>`);
      const orbs = [[2.2, 2, 6], [4.6, 4.8, 5], [7.6, 7.6, 5.4]].map(([dx, dy, r], j) => {
        defs.push(`<radialGradient id="${id}-g${i}${j}" cx="${x + dx}" cy="${y + dy}" r="${r}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${hues[j]}"/><stop offset="1" stop-color="${hues[j]}" stop-opacity="0"/></radialGradient>`);
        return `<circle cx="${x + dx}" cy="${y + dy}" r="${r}" fill="url(#${id}-g${i}${j})"/>`;
      }).join("");
      return `<g class="tm-part" clip-path="url(#${id}-c${i})"><rect x="${x}" y="${y}" width="9.4" height="9.4" fill="${base}"/><g filter="url(#${id}-blur)">${orbs}</g></g>`;
    });
    return `<svg viewBox="0 0 24 24" focusable="false"><defs>${defs.join("")}</defs>${tiles.join("")}</svg>`;
  }
  $("troupe-mark").innerHTML = troupeMark();
  function troupeStages(ev) { return Array.isArray(ev.stages) ? ev.stages.filter((s) => s && typeof s === "object") : []; }
  function troupeCounts(s) {
    const total = Math.max(0, Number(s.total) || 0), done = Math.max(0, Number(s.done) || 0), failed = Math.max(0, Number(s.failed) || 0);
    return { total, done, failed, settled: done + failed };
  }
  function troupeStateWords(ev) {
    const state = String(ev.state || "running");
    return (TROUPE_STATES[state] || state) + (ev.reason && state !== "running" ? ` · ${ev.reason}` : "");
  }
  // One line for a troupe: the stage at work (the first not through all its items; a later stage's total is 0 until
  // it begins) while it runs, and how it ended once it has.
  function troupeSummary(ev) {
    const state = String(ev.state || "running"), stages = troupeStages(ev);
    if (state === "running") {
      const stage = stages.find((s) => { const c = troupeCounts(s); return !c.total || c.settled < c.total; }) || stages.at(-1);
      if (!stage) return { text: "Starting", share: 0 };
      const c = troupeCounts(stage), name = String(stage.name || "");
      return { text: c.total ? `${name} ${Math.min(c.settled, c.total)}/${c.total}` : `${name} starting`,
               share: c.total ? Math.min(100, Math.round((c.settled / c.total) * 100)) : 0 };
    }
    const last = [...stages].reverse().find((s) => troupeCounts(s).total > 0);
    return { text: (TROUPE_STATES[state] || state) + (state === "done" && last ? ` · ${Number(last.kept) || 0} kept` : ""), share: 100 };
  }
  function troupeEvent(ev, create) {
    const id = String(ev.run_id || "");
    if (!id || (!troupeRuns.has(id) && !create)) return;
    troupeRuns.set(id, ev);
    if (String(ev.state || "running") !== "running") troupeStopping.delete(id);
    while (troupeRuns.size > 20) troupeRuns.delete(troupeRuns.keys().next().value);
    paintTroupes();
  }
  function stopTroupe(id) {
    const ev = troupeRuns.get(id);
    if (!ev || String(ev.state || "running") !== "running" || troupeStopping.has(id)) return;
    troupeStopping.add(id);
    vscode.postMessage({ type: "stopTroupe", run_id: id });
    paintTroupes();
  }
  // Finished troupes leave the row; a running one never does.
  function dropFinishedTroupes() {
    let dropped = false;
    for (const [id, ev] of troupeRuns) if (String(ev.state || "running") !== "running") { troupeRuns.delete(id); dropped = true; }
    if (dropped) paintTroupes();
  }
  function resetTroupes() { troupeRuns.clear(); troupeStopping.clear(); troupesOpen = false; paintTroupes(); }
  function troupeStageRows(ev) {
    return troupeStages(ev).map((s) => {
      const c = troupeCounts(s);
      const share = c.total ? Math.min(100, Math.round((c.settled / c.total) * 100)) : 0;
      const counts = c.total ? `${c.settled} of ${c.total}` : "waiting";
      const extra = [c.failed ? `${c.failed} failed` : "", c.total && c.settled >= c.total ? `${Number(s.kept) || 0} kept` : "",
                     s.dropped ? `${Number(s.dropped)} not started` : ""].filter(Boolean).join(" · ");
      return `<li><span class="troupe-stage-name">${esc(String(s.name || ""))}</span><span class="troupe-bar" role="progressbar" aria-label="${esc(String(s.name || "Stage"))}" aria-valuemin="0" aria-valuemax="${c.total}" aria-valuenow="${Math.min(c.settled, c.total)}"><span style="width:${share}%"></span></span><span class="troupe-count">${esc(counts)}${extra ? ` · ${esc(extra)}` : ""}</span></li>`;
    }).join("");
  }
  function paintTroupes() {
    const bar = $("troupebar"), panel = $("troupe-panel");
    const runs = [...troupeRuns.values()];
    if (!runs.length) {
      const hadFocus = bar.contains(document.activeElement);
      troupesOpen = false; panel.innerHTML = ""; bar.hidden = true;
      paintTroupesOpen(); syncComposerRail();
      if (hadFocus) input.focus();
      renderAgents();
      return;
    }
    const running = runs.filter((ev) => String(ev.state || "running") === "running");
    const lead = running.at(-1) || runs.at(-1);   // the newest at work, else the newest to end
    const leadId = String(lead.run_id), sum = troupeSummary(lead), title = String(lead.title || "");
    bar.dataset.state = running.length ? "running" : String(lead.state || "done");
    $("troupe-label").textContent = runs.length > 1 ? `${runs.length} troupes` : "Troupe";
    $("troupe-title").textContent = title;
    $("troupe-title").title = title;
    $("troupe-count").textContent = sum.text;
    $("troupe-mini").querySelector("span").style.width = `${sum.share}%`;
    $("troupe-main").setAttribute("aria-label", `Troupe ${title}: ${sum.text}`
      + (runs.length > 1 ? `, ${running.length} of ${runs.length} troupes running` : ""));
    const stop = $("troupe-stop"), stopping = troupeStopping.has(leadId);
    stop.hidden = !running.length;
    stop.dataset.troupeStop = leadId;
    stop.disabled = stopping;
    const stopLabel = stopping ? "Stopping…" : `Stop ${title || "the troupe"}`;
    stop.title = stopLabel; stop.setAttribute("aria-label", stopLabel);
    stop.querySelector(".codicon").className = stopping ? "codicon codicon-loading codicon-modifier-spin" : "codicon codicon-debug-stop";
    $("troupe-dismiss").hidden = running.length > 0;
    // The panel is rebuilt on every progress event: a Stop in it that had the focus gets it back.
    const focused = panel.contains(document.activeElement) ? document.activeElement.dataset.troupeStop || "" : "";
    panel.innerHTML = [...runs].reverse().map((ev) => {
      const id = String(ev.run_id), state = String(ev.state || "running"), planned = Number(ev.agents_planned) || 0, reused = Number(ev.reused) || 0;
      const note = state === "running"
        ? `About ${planned} agents. This chat continues when it ends.` + (reused ? ` ${reused} results reused.` : "")
        : `Results: ${String(ev.journal || "")}`;
      const stopButton = state === "running" && runs.length > 1
        ? `<button type="button" class="rail-text-action" data-troupe-stop="${esc(id)}"${troupeStopping.has(id) ? " disabled" : ""}>${troupeStopping.has(id) ? "Stopping…" : "Stop"}</button>` : "";
      return `<div class="troupe-run" data-troupe-id="${esc(id)}" data-state="${esc(state)}"><div class="troupe-run-head"><span class="troupe-run-title">${esc(String(ev.title || ""))}</span><span class="troupe-run-state">${esc(troupeStateWords(ev))}</span>${stopButton}</div><ol class="troupe-stages">${troupeStageRows(ev)}</ol><div class="troupe-note">${esc(note)}</div></div>`;
    }).join("");
    panel.querySelectorAll("[data-troupe-stop]").forEach((button) => { button.onclick = () => stopTroupe(button.dataset.troupeStop); });
    if (focused) panel.querySelector(`[data-troupe-stop="${cssEscape(focused)}"]`)?.focus();
    // Said once when it changes, not on every tick: a troupe starting or ending, never its counts.
    const status = runs.map((ev) => `${ev.title || "Troupe"}: ${troupeStateWords(ev)}`).join("; ");
    if ($("troupe-status").dataset.said !== status) { $("troupe-status").dataset.said = status; $("troupe-status").textContent = status; }
    bar.hidden = false;
    paintTroupesOpen();
    syncComposerRail();
    renderAgents();                    // a running troupe is a background task: the pill counts it, the map lists it
  }
  function paintTroupesOpen() {
    const label = troupesOpen ? "Hide the troupe's stages" : "Show the troupe's stages";
    $("troupe-panel").hidden = !troupesOpen;
    for (const button of [$("troupe-main"), $("troupe-toggle")]) button.setAttribute("aria-expanded", String(troupesOpen));
    $("troupe-toggle").title = label; $("troupe-toggle").setAttribute("aria-label", label);
    $("troupe-main").title = label;
    $("troupe-toggle").querySelector(".codicon").className = `codicon codicon-chevron-${troupesOpen ? "down" : "up"}`;
  }
  function toggleTroupes() { troupesOpen = !troupesOpen; paintTroupesOpen(); }
  $("troupe-main").onclick = toggleTroupes;
  $("troupe-toggle").onclick = toggleTroupes;
  $("troupe-stop").onclick = () => stopTroupe($("troupe-stop").dataset.troupeStop || "");
  $("troupe-dismiss").onclick = dropFinishedTroupes;
  // Request ids restart with every backend process (r1, r2, ...), so a card remembers which backend
  // asked: a new backend's r1 is a new request even while the last one's answered r1 is on screen.
  let requestEpoch = 0;
  // A Pip setup or change is approved by its permission card, so the card shows the job in words,
  // not its JSON: what the Pip is, what it does, what it reads, and what Allow does.
  function pipPermissionDetail(name, args) {
    if (!args || typeof args !== "object") return "";
    if (name === "troupe") {
      const row = (label, value) => (value ? `<dt>${label}</dt><dd>${esc(String(value))}</dd>` : "");
      const items = Array.isArray(args.items) ? args.items.map(String) : [];
      const listed = items.slice(0, 5).join("\n") + (items.length > 5 ? `\n… and ${items.length - 5} more` : "");
      const stages = Array.isArray(args.stages) ? args.stages.map((s) => `${(s && s.name) || "?"} (${(s && s.agent) || "explorer"}${s && s.votes > 1 ? `, ${s.votes} votes` : ""})`).join(" → ") : "";
      const plan = args.template ? { review: "Review each, then 3 verifiers check every finding", research: "Research each, then a critic checks each answer",
        change: "A worker changes each place in its own checkout, then a verifier checks it", compare: "Work out each option, then 3 judges pick the best" }[args.template] || args.template : stages;
      const routine = args.routine && typeof args.routine === "object" ? args.routine : null;
      if (routine) {
        // On a schedule, as a Pip routine (dgc/troupe_routines.py): when, which items each time, and who reports.
        const at = typeof routine.at === "string" && routine.at ? routine.at : "09:00";
        const day = typeof routine.day === "string" && routine.day ? routine.day[0].toUpperCase() + routine.day.slice(1).toLowerCase() : "Monday";
        const when = { day: `Every day at ${at}`, weekday: `Weekdays at ${at}`, week: `Every ${day} at ${at}`,
          hours: `Every ${Number(routine.hours) || "?"} hours` }[routine.every] || String(routine.every || "");
        const source = routine.items || "changed";
        const each = source === "matching" ? `The files matching ${routine.pattern || "?"}`
          : source === "these" ? listed : "The files changed since it last ran (the first time, the last 7 days)";
        return `<dl class="pip-permission">${row("Work", args.title)}${row("Plan", plan)}${row("Goal", args.goal)}${row("When", when)}`
          + `${row(source === "these" ? `Items (${items.length})` : "Each time", each)}${row("Results", routine.pip ? `${routine.pip}, in its chat` : "Your Primary Pip, in its chat")}</dl>`
          + `<div class="muted pip-permission-note">Allow adds it to the Pip's routines, on at once. It only reads this project's committed code. Turn it off in the Pip's Settings, Routines.</div>`;
      }
      return `<dl class="pip-permission">${row("Work", args.title)}${row("Plan", plan)}${row("Goal", args.goal)}${row(`Items (${items.length})`, listed)}${row("Resume", args.resume)}</dl>`
        + `<div class="muted pip-permission-note">Allow starts it in the background: one agent per item. Its progress shows above the message box, where you can stop it, and this chat continues when it ends.</div>`;
    }
    const row = (label, value) => (value ? `<dt>${label}</dt><dd>${esc(String(value))}</dd>` : "");
    // A Pip's model and context window in the user's words (the main chat changes them from Pips API 66).
    const modelWords = (choice) => (!choice || typeof choice !== "object" ? ""
      : choice.mode === "model" ? String(choice.model || "")
      : choice.mode === "subscription" ? `${{ claude: "Claude Code", codex: "Codex" }[choice.engine] || String(choice.engine || "")}, on your own plan`
      : "Default: the model Pips use by default");
    const windowWords = (n) => (Number.isSafeInteger(n) && n > 0
      ? `${n === 1048576 ? "1M" : n % 1024 === 0 ? `${n / 1024}K` : n.toLocaleString()} tokens` : "");
    if (name === "pips_propose") {
      const changes = args.changes && typeof args.changes === "object" ? Object.entries(args.changes) : [];
      if (!changes.length) return "";
      const label = { name: "Name", goal: "Goal", source_ref: "Branch", source_exclude: "Leave out", model_choice: "Model", context_window: "Context window" };
      const shown = (key, value) => (key === "model_choice" ? modelWords(value) : key === "context_window" ? windowWords(value)
        : Array.isArray(value) ? value.map(String).join(", ") || "Nothing" : value && typeof value === "object" ? JSON.stringify(value) : value);
      return `<dl class="pip-permission">${changes.map(([key, value]) => row(esc(label[key] || key.replace(/_/g, " ")), shown(key, value))).join("")}${row("Why", args.reason)}</dl>`
        + `<div class="muted pip-permission-note">Allow applies this change to the Pip. It starts no work, and what the Pip may do stays the same.</div>`;
    }
    if (name === "pips_settings") {
      return `<dl class="pip-permission">${row("Model for Pips", String(args.default_model || "") || "Same as DGC")}${row("Why", args.reason)}</dl>`
        + `<div class="muted pip-permission-note">Allow saves it in Settings, Agents, Pips: every Pip on Default uses it from its next run. A Pip with a model of its own keeps it.</div>`;
    }
    if (name !== "pips_setup") return "";
    const reads = args.web_plan && Array.isArray(args.web_plan.reads) ? args.web_plan.reads : [];
    const readText = reads.map((r) => (r && r.kind === "search" ? `Search: ${r.query || ""}` : String((r && r.url) || ""))).join("\n");
    const kind = `${args.pip_type || ""}, ${args.scope === "personal" ? "personal (across your projects)" : "this project"}`;
    const model = args.model_choice && args.model_choice.mode && args.model_choice.mode !== "default" ? modelWords(args.model_choice) : "";
    const fresh = !args.pip_id;
    return `<dl class="pip-permission">${row("Pip", args.name)}${row("Job", args.goal)}${row("Kind", kind)}`
      + `${row("Reads", readText)}${row("Model", model)}${row("Context window", windowWords(args.context_window))}${row("First run", args.run_now ? "Now, then on its schedule" : "")}</dl>`
      + `<div class="muted pip-permission-note">${fresh ? "Allow creates this Pip and turns it on." : "Allow applies this setup to the existing Pip."} `
      + `Pause, change or delete it any time in Pips.</div>`;
  }
  function requestCard(c, id) { c.dataset.requestId = String(id); c._requestEpoch = requestEpoch; renderTurnMeta(); return c; }
  // The backend announces an open decision again after a history snapshot; one card per request.
  function requestShown(id) {
    return [...document.querySelectorAll(".card[data-request-id]")]
      .some((card) => card.dataset.requestId === String(id) && card._requestEpoch === requestEpoch);
  }
  // `decision`: what settled the card, in words ("Allowed once"). An answered card used to keep only
  // its question, so one answered "Allow once" read like one still waiting.
  function resolveCard(c, decision = "") {
    if (!c || c.classList.contains("resolved")) return false;
    c.classList.add("resolved"); c.setAttribute("aria-disabled", "true");
    c.querySelectorAll("button, input, select, textarea")
      .forEach((control) => { control.disabled = true; });
    if (decision) {
      const line = el("div", "decision");
      line.textContent = String(decision).slice(0, 2400);
      c.appendChild(line);
    }
    renderTurnMeta();
    return true;
  }
  function expireOpenRequests() {
    document.querySelectorAll(".card[data-request-id]:not(.resolved)")
      .forEach((card) => resolveCard(card, "Not answered: DGC's backend stopped"));
  }
  function permissionDecision(decision, rule, note) {
    if (decision === "once") return "Allowed once";
    if (decision === "always") return rule ? `Always allowed · ${rule}` : "Always allowed";
    return note ? `Denied · note for the model: ${note}` : "Denied";
  }
  function compactPermissionCard(card, name) {
    if (!card?.classList.contains("resolved") || card.classList.contains("compact-permission")) return;
    const decision = card.querySelector(".decision")?.textContent || "Recorded decision";
    const details = el("details", "permission-receipt"), summary = el("summary");
    summary.textContent = `${name || "Tool"} · ${decision.length > 120 ? decision.slice(0, 119) + "…" : decision}`;
    const evidence = el("div", "permission-evidence");
    while (card.firstChild) evidence.appendChild(card.firstChild);
    details.append(summary, evidence); card.appendChild(details);
    card.classList.add("compact-permission");
    // The resolved action controls remain disabled. Reading its receipt is not.
    card.removeAttribute("aria-disabled");
  }
  // A plan review keeps its feedback only when planning goes on (the backend drops it on approval).
  function planDecision(decision, feedback) {
    if (decision !== "reject") return `Approved · ${decision} mode`;
    return feedback ? `Kept planning · feedback: ${feedback}` : "Kept planning";
  }
  const MCP_DECISIONS = { accept: "Approved once", decline: "Declined", cancel: "Cancelled" };
  // The two cards a backend death can leave: Continue for an ordinary turn it cut off, and Resume
  // goal when the same death kept repeating and automatic resume stood down. Each is a DGC marker
  // with buttons — clicking Continue sends no words on the user's behalf.
  function removeRecoveryCards() { log.querySelectorAll(".recovery-card").forEach((node) => node.remove()); }
  function recoveryCard(kind, text, actionLabel, onAction) {
    removeRecoveryCards();
    const card = el("div", `sys recovery-card ${kind}`);
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", actionLabel);
    card.appendChild(el("span", "note-icon", icon("play")));
    card.lastChild.dataset.icon = "play";
    card.appendChild(el("span", "recovery-text", esc(text)));
    const actions = el("span", "recovery-actions");
    const go = el("button", "act primary", esc(actionLabel)); go.type = "button";
    go.onclick = () => { card.remove(); onAction(); };
    const dismiss = el("button", "act", "Dismiss"); dismiss.type = "button";
    dismiss.onclick = () => card.remove();
    actions.appendChild(go); actions.appendChild(dismiss); card.appendChild(actions);
    appendConversationContent(card);
    if (!replaying) { speak(text); scroll(); }
    return card;
  }
  // ---- background monitors ----
  // One card per event, inside the turn it arrived in. Lines are command output: they go in as
  // textContent, never as markup.
  function monitorEventCard(ev) {
    const card = el("div", "monitor-event");
    card.dataset.monitorId = String(ev.id || "");
    card.dataset.kind = String(ev.kind || "output");
    card.setAttribute("role", "group");
    const background = ev.kind === "background_exit";
    const ended = ev.kind === "ended" || background;
    const lines = (Array.isArray(ev.lines) ? ev.lines : []).map((line) => String(line)).slice(0, 40);
    const head = el("div", "monitor-event-head");
    // A command run with `bash` in background mode is not a monitor; its card says what it is.
    const kind = background ? "Background command" : "Monitor";
    const state = background ? "exited" : ended ? "ended" : `event ${Math.max(0, Number(ev.event_index) || 0)}`;
    head.innerHTML = icon(background ? "square-terminal" : "activity")
      + `<span class="me-title">${kind} · ${esc(String(ev.description || ev.id || "").slice(0, 120))}</span>`
      + `<span class="me-meta">${esc(state)}</span>`;
    card.setAttribute("aria-label", `${kind} ${String(ev.description || ev.id || "")}, ${state}`);
    card.appendChild(head);
    const body = ended ? lines.slice(1) : lines;
    if (ended && lines[0]) {
      const summary = el("div", "monitor-event-summary");
      summary.textContent = lines[0];
      card.appendChild(summary);
    }
    if (body.length) {
      const pre = el("pre", "monitor-lines");
      pre.textContent = body.join("\n");
      card.appendChild(pre);
    }
    const omitted = Math.max(0, Number(ev.omitted_lines) || 0);
    if (omitted) {
      const more = el("div", "monitor-more");
      more.textContent = `${omitted} more line${omitted === 1 ? "" : "s"} · ask DGC to read ${String(ev.id || "the monitor")}`;
      card.appendChild(more);
    }
    return card;
  }
  // The monitors of THIS chat: every id a monitors list or a monitor_started named since the chat
  // began. A new chat, clear or resume empties it, so the end of a monitor from the chat that was
  // left (it can reach the webview after the new chat's acknowledgement) is not shown in this one.
  const eventCount = (value) => { const n = Math.max(0, Number(value) || 0); return `${n} event${n === 1 ? "" : "s"}`; };
  let monitorItems = [], monitorsPaused = false, monitorsPending = 0, monitorsHeld = false;
  const knownMonitorIds = new Set();
  function renderMonitors(ev) {
    monitorItems = (Array.isArray(ev?.items) ? ev.items : [])
      .filter((item) => item && typeof item.id === "string").slice(0, 32);
    if (ev?.reset) knownMonitorIds.clear();
    monitorItems.forEach((item) => knownMonitorIds.add(item.id));
    monitorsPaused = ev?.wake_paused === true;
    monitorsPending = Math.max(0, Number(ev?.pending_events) || 0);
    paintMonitorsRow();
    if (String(ev?.request_id || "").startsWith("monitors-list")) renderMonitorsList();
  }
  // The row above the prompt: a chip per running monitor, and, whenever events are held back for
  // the person rather than about to wake DGC (wake-ups paused, Wake on monitor events off, plan
  // mode), how many are waiting for their next message. Repainted when the config or mode changes.
  function paintMonitorsRow() {
    const live = monitorItems.filter((item) => item.state === "running" || item.state === "stopping");
    const pending = monitorsPending;
    const wakeOff = lastConfig?.monitor_wake === false;
    const held = monitorsPaused || wakeOff || curMode === "plan";
    monitorsHeld = held;
    const chips = $("monitor-chips");
    chips.innerHTML = "";
    live.forEach((item) => {
      const chip = el("span", "monitor-chip");
      chip.setAttribute("role", "listitem");
      chip.dataset.monitorId = item.id;
      chip.dataset.state = item.state;
      const label = el("span", "monitor-chip-label");
      label.textContent = `${String(item.description || item.id).slice(0, 60)} · ${Math.max(0, Number(item.events) || 0)}`;
      label.title = `${item.id} · ${String(item.command || "")}`;
      chip.appendChild(label);
      const stop = el("button", "rail-icon-button monitor-stop");
      stop.type = "button";
      stop.innerHTML = '<span class="codicon codicon-debug-stop" aria-hidden="true"></span>';
      stop.title = item.state === "stopping" ? "Stopping…" : `Stop ${item.id}`;
      stop.setAttribute("aria-label", `Stop monitor ${String(item.description || item.id)}`);
      stop.disabled = item.state === "stopping";
      stop.onclick = () => { stop.disabled = true; chip.dataset.state = "stopping"; vscode.postMessage({ type: "stopMonitor", id: item.id }); };
      chip.appendChild(stop);
      chips.appendChild(chip);
    });
    const waiting = held && pending ? `${eventCount(pending)} waiting for your next message` : "";
    const summary = waiting || (live.length
      ? `${live.length} monitor${live.length === 1 ? "" : "s"}`
      : `${eventCount(pending)} waiting`);
    // With chips on the row they are the count; the words fill a row that has none. Events held for
    // you are counted even beside the chips, in two words there so the chips keep their room.
    $("monitors-count").textContent = live.length && waiting ? `${pending} waiting` : summary;
    $("monitors-count").title = waiting;
    $("monitors-count").hidden = live.length > 0 && !waiting;
    const pausedLabel = monitorsPaused ? "paused" : wakeOff ? "wake off" : "";
    monitorsBar.setAttribute("aria-label", `Background monitors: ${summary}`
      + (monitorsPaused ? ", wake-ups paused" : wakeOff ? ", wake-ups off" : ""));
    $("monitors-paused").hidden = !pausedLabel;
    $("monitors-paused").textContent = pausedLabel || "paused";
    $("monitors-paused").title = wakeOff && !monitorsPaused
      ? "Wake on monitor events is off: new events wait for your next message"
      : "Wake-ups are paused: new events wait for your next message";
    monitorsBar.dataset.paused = String(Boolean(pausedLabel));
    monitorsBar.hidden = !live.length && !(held && pending);
    syncComposerRail();
  }
  // A chat opened again after DGC stopped brings back the monitors that were running (dgc/monitor_restart.py):
  // one line each, saying what was not watched in between, or why it was not started. Live and replayed alike;
  // only the live line offers Restart (a replayed one belongs to an earlier opening of the chat).
  const restartedMonitorIds = new Set();
  // A live note and its replayed marker are one line. The restore's history snapshot can land before or after the live
  // note (the note is saved with the chat first), so whichever comes second gives way: a replay skips a marker whose
  // live line is on screen, and a live line takes the place of its replayed marker (the live one has the buttons).
  const restartNoteId = (ev) => `${String(ev?.key || "")}:${String(ev?.state || "")}:${Number(ev?.at) || 0}`;
  function placeRestartNote(line, ev, live) {
    line.dataset.note = restartNoteId(ev);
    const twins = [...log.querySelectorAll(".monitor-restart")].filter((n) => n.dataset.note === line.dataset.note);
    if (!live) {
      if (twins.some((n) => !n.classList.contains("hist"))) return;
      appendTarget.appendChild(line);
      return;
    }
    twins.filter((n) => n.classList.contains("hist")).forEach((n) => n.remove());
    // Running again: the earlier line's Restart / Run again / Resume has done its job.
    if (["restarted", "started", "resumed"].includes(String(ev?.state || "")) && ev?.key) {
      for (const earlier of log.querySelectorAll(".monitor-restart:not(.hist)")) {
        if (earlier.dataset.note.startsWith(`${String(ev.key)}:`)) earlier.querySelectorAll("button").forEach((b) => b.remove());
      }
    }
    appendConversationContent(line);
  }
  const MONITOR_RESTART_ICONS = { restarted: "refresh-cw", stopped: "circle-slash", expired: "history", failed: "triangle-alert" };
  function monitorRestartLine(ev, live) {
    const state = String(ev?.state || "");
    if (!MONITOR_RESTART_ICONS[state]) return;
    const line = el("div", "sys sys-marked monitor-restart" + (live ? "" : " hist") + (state === "failed" ? " err" : ""));
    line.dataset.state = state;
    line.innerHTML = icon(MONITOR_RESTART_ICONS[state]) + `<span>${esc(String(ev.message || "").slice(0, 600))}</span>`;
    if (live && ev.restart === true && ev.key) {
      const again = el("button", "act monitor-restart-again", "Restart");
      again.type = "button";
      again.title = "Start this monitor again with the same command, folder and sandbox";
      again.onclick = () => { again.disabled = true; vscode.postMessage({ type: "restartMonitor", key: String(ev.key) }); };
      line.appendChild(again);
    }
    if (live && state === "restarted" && ev.id) restartedMonitorIds.add(String(ev.id));
    placeRestartNote(line, ev, live);
  }
  // A background command, sub-agent or troupe the restart stopped (dgc/stopped_work.py). Never run again on its own:
  // the live line offers Resume / Run again; a replayed one is the record of it.
  const TASK_INTERRUPTED_ICONS = { stopped: "circle-slash", started: "play", resumed: "refresh-cw", failed: "triangle-alert" };
  const TASK_ACTIONS = { resume: ["Resume", "Start a new one that picks up from what the stopped one had done"],
    run_again: ["Run again", "The same command in the same folder, or the same task from scratch"] };
  function taskInterruptedLine(ev, live) {
    const state = String(ev?.state || "");
    if (!TASK_INTERRUPTED_ICONS[state]) return;
    const line = el("div", "sys sys-marked monitor-restart task-interrupted" + (live ? "" : " hist") + (state === "failed" ? " err" : ""));
    line.dataset.state = state;
    line.dataset.kind = String(ev.kind || "");
    line.innerHTML = icon(TASK_INTERRUPTED_ICONS[state]) + `<span>${esc(String(ev.message || "").slice(0, 600))}</span>`;
    const actions = live && ev.key && Array.isArray(ev.actions) ? ev.actions.filter((a) => TASK_ACTIONS[a]) : [];
    for (const action of actions) {
      const [label, title] = TASK_ACTIONS[action];
      const button = el("button", "act monitor-restart-again", label);
      button.type = "button"; button.title = title;
      button.onclick = () => {
        line.querySelectorAll("button").forEach((b) => { b.disabled = true; });
        vscode.postMessage({ type: "rerunTask", key: String(ev.key), how: action === "resume" ? "resume" : "again" });
      };
      line.appendChild(button);
    }
    placeRestartNote(line, ev, live);
  }
  function renderMonitorsList() {
    if (!monitorItems.length) { sysLine("No background monitors in this chat."); return; }
    const c = decisionCard(`<div class="q">${icon("activity")} Background monitors</div><div class="monitor-list"></div>`, "Background monitors");
    const list = c.querySelector(".monitor-list");
    monitorItems.forEach((item) => {
      const row = el("div", "abtns monitor-list-row");
      const text = el("span", "monitor-list-text");
      text.textContent = `${item.id} · ${String(item.description || "")} · ${item.state}`
        + `${item.end_reason ? ` (${item.end_reason})` : ""} · ${eventCount(item.events)}`;
      row.appendChild(text);
      if (item.state === "running") {
        const stop = el("button", "abtn", "Stop"); stop.type = "button";
        stop.onclick = () => { stop.disabled = true; vscode.postMessage({ type: "stopMonitor", id: item.id }); };
        row.appendChild(stop);
      }
      list.appendChild(row);
    });
  }
  // Every error line is shown. Repeats are deduplicated where they start: the backend reports a
  // skipped unknown event type once per connection, so the webview never hides a real reason.
  // A few notices carry a mark: the backend going away, a rule the user just granted, context
  // being summarised. Most do not — a plain line is the quietest thing in the transcript, and that
  // is the point of it.
  function sysLine(msg, isErr, mark) {
    const line = el("div", "sys" + (isErr ? " err" : "") + (mark ? " sys-marked" : ""),
      (mark ? icon(mark) : "") + esc(msg));
    if (isErr) line.setAttribute("role", "alert");
    appendConversationContent(line);
  }

  // ---- memory that learns (dgc/memory_review.py, dgc/skill_learn.py) ------------------------------
  // What a look back over this session kept: one quiet line, with Forget (the one memory every surface shares).
  function memoryLearnedLine(ev) {
    const facts = (Array.isArray(ev.facts) ? ev.facts : [])
      .filter((f) => f && /^mem_[0-9a-f]{12}$/.test(String(f.id || "")) && typeof f.text === "string").slice(0, 3);
    if (!facts.length) return;
    const box = el("div", "sys sys-marked memory-learned");
    box.setAttribute("role", "note");
    box.setAttribute("aria-label", "Remembered");
    box.innerHTML = icon("bookmark");
    const rows = el("span", "memory-learned-rows");
    for (const fact of facts) {
      const row = el("span", "memory-learned-row");
      const words = el("span", "memory-learned-text", `Remembered: ${esc(fact.text)}`);
      const forget = el("button", "link memory-learned-forget", "Forget");
      forget.type = "button";
      forget.setAttribute("aria-label", `Forget: ${fact.text}`);
      forget.addEventListener("click", () => {
        vscode.postMessage({ type: "memoryForgetFact", id: fact.id });
        words.textContent = `Forgotten: ${fact.text}`;
        forget.remove();
      });
      row.append(words, document.createTextNode(" · "), forget);
      rows.append(row);
    }
    box.append(rows);
    appendConversationContent(box);
  }

  // /learn: the draft skill, shown before anything is written, with Save, Edit and Cancel.
  const learnCards = new Map();
  function learnCard(requestId) {
    let card = learnCards.get(requestId);
    if (!card) {
      card = el("div", "learn-card");
      card.setAttribute("role", "group");
      card.setAttribute("aria-label", "New skill");
      learnCards.set(requestId, card);
      appendConversationContent(card);
    }
    return card;
  }
  function learnPending(msg) {
    const card = learnCard(String(msg.requestId || ""));
    card.innerHTML = `<div class="learn-head">${icon("sparkle")}<span>Writing a skill from this session${msg.request ? `: ${esc(String(msg.request).slice(0, 120))}` : ""}…</span></div>`;
  }
  function skillBody(markdown) {
    return String(markdown || "").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  }
  function learnDraft(ev) {
    const requestId = String(ev.request_id || "");
    const card = learnCard(requestId);
    if (!ev.ok) {
      card.innerHTML = `<div class="learn-head">${icon("circle-alert")}<span>${esc(String(ev.message || "DGC couldn't write a skill this time."))}</span></div>`;
      return;
    }
    const draft = { markdown: String(ev.markdown || ""), scope: ev.scope === "project" ? "project" : "user",
                    name: String(ev.name || "skill"), editing: false };
    const where = draft.scope === "project" ? "this project's skills (.dgc/skills)" : "your own skills (~/.dgc/skills)";
    const render = () => {
      card.innerHTML = `<div class="learn-head">${icon("sparkle")}<span><strong>New skill: ${esc(draft.name)}</strong></span></div>`
        + `<p class="learn-description">${esc(String(ev.description || ""))}</p>`
        + `<p class="learn-where">Save puts it in ${esc(where)}. Nothing is written until you save.</p>`;
      if (draft.editing) {
        const area = el("textarea", "learn-edit");
        area.value = draft.markdown;
        area.rows = 16;
        area.setAttribute("aria-label", "The skill, in its SKILL.md form");
        area.addEventListener("input", () => { draft.markdown = area.value; });
        card.append(area);
      } else {
        const body = el("div", "learn-body md", md(skillBody(draft.markdown)));
        card.append(body);
      }
      const actions = el("div", "learn-actions");
      const save = el("button", "act primary", "Save");
      const edit = el("button", "act", draft.editing ? "Done editing" : "Edit");
      const cancel = el("button", "act", "Cancel");
      for (const b of [save, edit, cancel]) b.type = "button";
      save.addEventListener("click", () => {
        for (const b of [save, edit, cancel]) b.disabled = true;
        save.textContent = "Saving…";
        vscode.postMessage({ type: "learnSave", requestId: requestId + "-save", markdown: draft.markdown, scope: draft.scope });
        learnCards.set(requestId + "-save", card);
      });
      edit.addEventListener("click", () => { draft.editing = !draft.editing; render(); card.querySelector("textarea")?.focus(); });
      cancel.addEventListener("click", () => {
        card.innerHTML = `<div class="learn-head muted">${icon("circle-slash")}<span>Not saved: the skill ${esc(draft.name)} was discarded.</span></div>`;
      });
      actions.append(save, edit, cancel);
      card.append(actions);
    };
    render();
  }
  function learnSaved(ev) {
    const card = learnCards.get(String(ev.request_id || ""));
    if (!card) { if (!ev.ok) sysLine(String(ev.message || "The skill wasn't saved."), true); return; }
    if (ev.ok) {
      card.innerHTML = `<div class="learn-head">${icon("circle-check")}<span>Saved the skill <strong>${esc(String(ev.name || ""))}</strong>. `
        + `Ask for it by name, or it's used when a task fits. Undo is in Settings → Memory.</span></div>`;
      const open = el("button", "link learn-memory", "Settings → Memory");
      open.type = "button";
      open.addEventListener("click", () => vscode.postMessage({ type: "openSettings", section: "memory" }));
      card.append(open);
      return;
    }
    const note = card.querySelector(".learn-error") || el("p", "learn-error");
    note.setAttribute("role", "alert");
    note.textContent = String(ev.message || "The skill wasn't saved.");
    card.append(note);
    card.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    const save = [...card.querySelectorAll("button")].find((b) => b.textContent === "Saving…");
    if (save) save.textContent = "Save";
  }

  // ---- Codex-style composer rail: durable workspace changes and standing goal ----
  let changeState = { total: 0, additions: 0, deletions: 0, files: [] };
  let workspaceChangeState = { ...changeState }, reviewScope = "chat";
  // ---- invisible characters in a paste -------------------------------------------------------
  // A mirror of dgc/textsafety.py, deliberately: the panel, the TUI and the backend must give the
  // same answer, and tests/test_invisible_characters.py owns the definition. If you change a rule
  // here, change it there in the same commit -- three slightly different answers is worse than
  // none, because the notice starts disagreeing with what the strip removes.
  //
  // Most invisible characters are harmless residue from a web page. Three kinds are not: bidi
  // overrides reorder how text DISPLAYS without changing its bytes, so what the reader sees and
  // what the model reads can differ; tag characters encode a whole ASCII string inside something
  // that renders as nothing at all; zero-width characters pad text invisibly. DGC hands a paste to
  // a model and then acts on it, so text that hides instructions from the person who pasted it is
  // a real problem. Counted and offered, never stripped on its own: silently altering what someone
  // pasted is its own bug.
  const INVIS_OVERRIDES = new Set([0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069]);
  const INVIS_MARKS = new Set([0x200E, 0x200F, 0x061C]);
  const INVIS_ZERO = new Set([0x200B, 0x2060, 0xFEFF, 0x00AD, 0x180E, 0x034F, 0x115F, 0x1160, 0x3164, 0xFFA0]);
  const INVIS_JOINERS = new Set([0x200C, 0x200D]);
  // The only tag sequences Unicode defines. Checking the SHAPE of a subdivision flag -- a leading
  // U+1F3F4 and a trailing U+E007F -- accepts any hidden string wearing one character as a
  // costume, which is a one-character bypass of the exact thing this exists to catch.
  const INVIS_RGI = new Set(["gbeng", "gbsct", "gbwls"]);
  // U+061C and U+FEFF sit inside the naive Arabic ranges, so a class written the obvious way lets
  // each of them declare the text RTL and thereby excuse itself. Split around both.
  const INVIS_RTL = /[\u0590-\u05FF\u0600-\u061B\u061D-\u06FF\u0700-\u074F\u0780-\u07BF\u0860-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFE]|[\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
  const INVIS_WORD = /[0-9A-Za-z]/;
  const isTag = (n) => n >= 0xE0000 && n <= 0xE007F;
  const isHiddenMark = (n) => n >= 0xE0100 && n <= 0xE01EF;
  const isControl = (n) => (n < 0x20 || n === 0x7F || (n >= 0x80 && n <= 0x9F))
    && n !== 0x09 && n !== 0x0A && n !== 0x0D;

  function classifyInvisible(text) {
    const cps = [...String(text ?? "")];
    const rtl = INVIS_RTL.test(String(text ?? ""));
    const counts = Object.create(null);
    const keep = [];
    const bump = (kind, n = 1) => { counts[kind] = (counts[kind] || 0) + n; };
    const drops = (n) => INVIS_OVERRIDES.has(n) || INVIS_ZERO.has(n) || isControl(n)
      || isHiddenMark(n) || (INVIS_MARKS.has(n) && !rtl);
    // The next codepoint that will SURVIVE. Reading the original neighbours instead lets a dropped
    // one change the verdict on a second pass, and then one click is not enough to clean the box.
    const nextKept = (from) => {
      for (let j = from; j < cps.length; j++) {
        const n = cps[j].codePointAt(0);
        if (INVIS_JOINERS.has(n) || drops(n)) continue;
        return cps[j];
      }
      return "";
    };
    const tagLetters = (run) => {
      let out = "";
      for (const ch of run) {
        const n = ch.codePointAt(0);
        if (n < 0xE0020 || n > 0xE007E) return "";
        out += String.fromCharCode(n - 0xE0000);
      }
      return out;
    };
    for (let i = 0; i < cps.length; ) {
      const n = cps[i].codePointAt(0);
      if (isTag(n)) {
        let j = i;
        while (j < cps.length && isTag(cps[j].codePointAt(0))) j++;
        const run = cps.slice(i, j);
        const closed = run.length > 1 && run[run.length - 1].codePointAt(0) === 0xE007F;
        const spelled = closed ? tagLetters(run.slice(0, -1)) : "";
        if (i > 0 && cps[i - 1].codePointAt(0) === 0x1F3F4 && INVIS_RGI.has(spelled)) {
          keep.push(...run);                       // a flag people actually type
        } else {
          bump("hidden", run.length);
        }
        i = j; continue;
      }
      if (INVIS_OVERRIDES.has(n)) { bump("bidi"); i++; continue; }
      if (INVIS_MARKS.has(n)) { rtl ? keep.push(cps[i]) : bump("bidi"); i++; continue; }
      if (INVIS_JOINERS.has(n)) {
        const before = keep.length ? keep[keep.length - 1] : "";
        if (INVIS_WORD.test(before) && INVIS_WORD.test(nextKept(i + 1))) bump("zero-width");
        else keep.push(cps[i]);                    // emoji, Indic and Persian shaping keep theirs
        i++; continue;
      }
      if (INVIS_ZERO.has(n)) { bump("zero-width"); i++; continue; }
      if (isHiddenMark(n)) { bump("hidden"); i++; continue; }
      if (isControl(n)) { bump("control"); i++; continue; }
      keep.push(cps[i]); i++;
    }
    return { counts, clean: keep.join("") };
  }

  function invisibleTotal(counts) {
    return Object.values(counts).reduce((sum, n) => sum + n, 0);
  }

  function renderPasteNotice() {
    const { counts } = classifyInvisible(composerText());
    const n = invisibleTotal(counts);
    pasteBar.hidden = n === 0;
    if (!n) { syncComposerRail(); return; }
    // Name the danger only when it is earned. Saying "hidden instruction" over a stray BOM from a
    // web page is the crying-wolf failure wearing a different costume.
    const risky = (counts["bidi"] || 0) + (counts["hidden"] || 0);
    pasteBar.dataset.status = risky ? "hidden" : "noise";
    $("paste-count").textContent = `Remove ${n} invisible character${n === 1 ? "" : "s"}`
      + (risky ? ` — ${risky} can carry a hidden instruction` : "");
    syncComposerRail();
  }

  // One click, never automatic. Strip removes exactly what the notice counted -- one walk produces
  // both, so they cannot disagree -- and Keep says the text is deliberate and dismisses the row
  // until the draft changes again.
  $("paste-strip").onclick = () => {
    const { clean } = classifyInvisible(composerText());
    setComposerText(clean);
    renderPasteNotice();
    input.focus({ preventScroll: true });
  };
  $("paste-keep").onclick = () => { pasteBar.hidden = true; syncComposerRail(); input.focus({ preventScroll: true }); };

  // One kind of work showing keeps its full row above the box. Two or more fold into one line of chips
  // (renderRailChips), and the rail itself then holds only the invisible-characters notice, if any. Pip fixes count
  // as a kind (founder, 24 Oct): a fix's chip beside this chat's changes folds the changes into a chip too, as the
  // checklist does, so the space above the box stays one line.
  function syncComposerRail() {
    const present = RAIL_KINDS.filter(([, bar]) => !bar.hidden).map(([kind]) => kind);
    const fixes = pipFixesForChip().length ? ["pipfixes"] : [];
    if (pipRunning.size) fixes.push("piprunning");
    const asChips = present.length + fixes.length >= 2;
    composerRail.classList.toggle("as-chips", asChips);
    composerRail.hidden = pasteBar.hidden && (asChips || !present.length);
    composerRail.classList.toggle("has-monitors", !monitorsBar.hidden);
    composerRail.classList.toggle("has-troupes", !troupeBar.hidden);
    composerRail.classList.toggle("has-changes", !changesBar.hidden);
    composerRail.classList.toggle("has-tasks", !tasksBar.hidden);
    composerRail.classList.toggle("has-goal", !goalBar.hidden);
    // Pip fixes and running Pips are always chips on this line: they have no row of their own.
    renderRailChips([...(asChips ? present : []), ...fixes]);
  }
  function setChatChanges(next) {
    const files = Array.isArray(next?.files) ? next.files.filter((item) => item
      && typeof item.path === "string").slice(0, 500) : [];
    changeState = {
      total: Math.max(0, Number(next?.total) || files.length),
      additions: Math.max(0, Number(next?.additions) || 0),
      deletions: Math.max(0, Number(next?.deletions) || 0), files,
      notices: Array.isArray(next?.notices) ? next.notices.map(String).slice(0, 34) : [],
    };
    changesBar.hidden = changeState.total === 0 && !changeState.notices.length;
    // A notice means the scan could not check every file. `capture()` compares only what BOTH
    // sides know, so what it recorded is real but some changes may be missing: the counts are a
    // floor, not totals. "+1 −82173 · partial scan" read as a total and was wrong; say "At least"
    // instead. "Changes unavailable" read as "this is broken" for the empty case, which is the same
    // statement with nothing recorded yet. The reason itself is on the bar's title.
    const partialChanges = changeState.notices.length > 0;
    const changedFiles = `${changeState.total} ${changeState.total === 1 ? "file" : "files"} changed in this chat`;
    $("changes-count").textContent = partialChanges
      ? (changeState.total ? `At least ${changedFiles}` : "Changes not recorded · partial scan")
      : changedFiles;
    changesBar.title = ["Changes recorded during runs in this chat; existing workspace changes are excluded",
      ...(partialChanges && changeState.total ? ["Not every file could be checked, so the real totals may be higher."] : []),
      ...changeState.notices].join("\n");
    $("changes-add").hidden = $("changes-del").hidden = changeState.total === 0;
    $("changes-add").textContent = `+${changeState.additions}`;
    $("changes-del").textContent = `−${changeState.deletions}`;
    syncComposerRail();
    if (!$("changes-review").hidden) renderChangesReview();
  }
  function renderChangesReview() {
    const changeState = reviewScope === "chat" ? currentChatChanges() : workspaceChangeState;
    $("changes-review-title").textContent = reviewScope === "chat" ? "Changes in this chat" : "Workspace changes";
    $("changes-review-description").textContent = reviewScope === "chat"
      ? "Saved before/after snapshots from this chat’s runs in this chat’s folder. Existing changes and edits between runs are excluded. Concurrent edits during a run may be included."
      : "All pending changes since the last Git commit, including edits made before this chat or by other tools.";
    const summary = $("changes-review-summary"), list = $("changes-review-list");
    const floor = reviewScope === "chat" && changeState.total && changeState.notices?.length ? "At least " : "";
    summary.innerHTML = `<span>${floor}${changeState.total} ${changeState.total === 1 ? "file" : "files"} changed</span><span class="change-add">+${changeState.additions}</span><span class="change-del">−${changeState.deletions}</span>`;
    list.innerHTML = changeState.files.length ? changeState.files.map((item, index) =>
      `<button type="button" class="change-row" data-change="${index}" title="${esc(item.error || (item.staged ? "Includes staged changes" : "Review change"))}"><span class="change-kind codicon codicon-${item.deleted ? "trash" : item.untracked ? "new-file" : "diff-modified"}" aria-hidden="true"></span><span class="change-path">${esc(item.path)}</span><span class="change-add">${item.counted === false || item.binary ? "—" : "+" + Math.max(0, Number(item.additions) || 0)}</span><span class="change-del">${item.counted === false || item.binary ? "—" : "−" + Math.max(0, Number(item.deletions) || 0)}</span><span class="codicon codicon-chevron-right" aria-hidden="true"></span></button>`).join("")
      : '<div class="surface-empty">No workspace changes remain.</div>';
    if (changeState.notices?.length) {
      const note = el("div", "surface-notice"); note.textContent = changeState.notices.join(" ");
      list.prepend(note);
      if (!changeState.files.length) list.querySelector(".surface-empty")?.remove();
    }
    list.querySelectorAll("[data-change]").forEach((button) => button.onclick = () => {
      const item = changeState.files[Number(button.dataset.change)];
      if (item) vscode.postMessage({ type: "reviewChange", path: item.id || item.path, scope: reviewScope });
    });
  }
  function currentChatChanges() { return changeState; }
  function setWorkspaceChanges(next) {
    workspaceChangeState = { total: 0, additions: 0, deletions: 0, files: [], ...next };
    if (!$("changes-review").hidden && reviewScope === "workspace") renderChangesReview();
  }
  function openChangesReview(scope = "chat") {
    reviewScope = scope === "workspace" ? "workspace" : "chat";
    renderChangesReview();
    $("changes-review").hidden = false;
    $("changes-review-close").focus();
  }
  function closeChangesReview() {
    $("changes-review").hidden = true;
    (reviewScope === "workspace" || changesBar.hidden ? $("workspace-changes") : $("changes-main")).focus();
  }

  // Standing goal — the objective and clock stay attached immediately above the composer.
  let goalState = { text: "", status: "none", elapsed: 0, running: false }, goalObservedAt = Date.now();
  function currentGoalElapsed() {
    return goalState.elapsed + (goalState.status === "active" && goalState.running
      ? Math.max(0, (Date.now() - goalObservedAt) / 1000) : 0);
  }
  function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), secs = total % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
      : `${minutes}:${String(secs).padStart(2, "0")}`;
  }
  function paintGoalClock() {
    if (goalBar.hidden) return;
    const clock = $("goal-time"), before = clock.textContent;
    clock.textContent = formatDuration(currentGoalElapsed());
    if (clock.textContent.length !== before.length) fitGoalText();   // "9:59" -> "10:00" takes room
    if (clock.textContent !== before) paintRailChip("goal");         // its chip keeps the same time
  }
  // The objective shares the rail with the status, the clock and four buttons. In a narrow sidebar the
  // room left for it is a letter or two ("S…"), which says nothing: below about four characters it is
  // left out, and the row's tooltip and label still carry the whole objective.
  function fitGoalText() {
    const main = $("goal-main"), text = $("goal-text");
    if (goalBar.hidden || !main.isConnected) return;
    const style = getComputedStyle(main);
    const gap = parseFloat(style.columnGap) || 0;
    const others = [...main.children].filter((child) => child !== text && getComputedStyle(child).display !== "none");
    const room = main.clientWidth - others.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0)
      - gap * others.length;
    const useful = 4 * (parseFloat(getComputedStyle(text).fontSize) || 12);
    const hide = main.clientWidth > 0 && room < useful;
    if (text.hidden !== hide) text.hidden = hide;
  }
  if (typeof ResizeObserver === "function") new ResizeObserver(() => fitGoalText()).observe($("goal-main"));
  function setGoalState(next) {
    const text = String(next?.text ?? next?.goal ?? "");
    const status = text ? String(next?.status || "active") : "none";
    const priorElapsed = currentGoalElapsed();
    const explicit = Number(next?.elapsed_seconds);
    goalState = { ...next, text, status, running: next?.running === true,
      elapsed: Number.isFinite(explicit) && explicit >= 0 ? explicit
        : (text === goalState.text ? priorElapsed : 0) };
    goalObservedAt = Date.now();
    // A finished goal stops being a pinned goal. Leaving it on the rail with a play button meant
    // the obvious next click RESUMED work that was already done -- which is exactly what happened:
    // a completed objective was resumed and started over. The transcript keeps the record.
    goalBar.hidden = !text || status === "completed";
    syncComposerRail();
    if (!text) { renderGoalControl(); closeGoalEditor(false); closeGoalReview(false); return; }
    const paused = status === "paused", blocked = status === "blocked", completed = status === "completed";
    // A blocked goal put "Blocked goal" beside the objective and nothing about WHY, so the one
    // thing the reader needs -- what stopped it -- was behind the Review button. It was already in
    // hand: goal_snapshot sends `reason` and setGoalState spreads it into goalState; only the
    // review dialog ever read it. Once a goal is blocked or paused you know what you asked for,
    // so the reason takes the line and the objective stays on the tooltip, the way a blocked task
    // shows what blocked it rather than repeating its own title.
    const reason = String(goalState.reason || "").trim();
    const why = (blocked || paused) && reason ? reason : "";
    $("goal-text").textContent = why || text;
    $("goal-text").classList.toggle("goal-why", !!why);
    $("goal-status").textContent = paused ? "Paused goal" : blocked ? "Blocked goal" : completed ? "Completed goal" : "Pursuing goal";
    goalBar.dataset.status = status;
    const toggle = $("goal-toggle"), icon = toggle.querySelector(".codicon");
    toggle.hidden = false;
    const resume = paused || blocked;   // never offer to resume something already finished
    icon.className = `codicon codicon-${resume ? "debug-continue" : "debug-pause"}`;
    toggle.title = resume ? "Resume goal" : "Pause goal";
    toggle.setAttribute("aria-label", resume ? "Resume goal" : "Pause goal");
    $("goal-main").title = why ? `${text}\n\n${why}` : text;
    $("goal-main").setAttribute("aria-label",
      why ? `Expand and edit goal: ${text.slice(0, 180)}. ${status}: ${why.slice(0, 220)}`
          : `Expand and edit goal: ${text.slice(0, 180)}`);
    paintGoalClock();
    fitGoalText();
    renderGoalDetail();
    renderGoalControl();
    if (!$("goal-review").hidden) renderGoalReview();
  }
  /** Open or close the three-line detail panel under the goal bar.
   *
   *  What it holds is the thing the bar has no room for: the objective in full, and then what has
   *  actually happened to it -- the reason it is blocked or paused, or the evidence recorded when
   *  it was met. Both already travel on `goal_snapshot`; until now only the review dialog read
   *  them. Three lines with its own scroller, so a long reason is readable without the bar growing
   *  to fill the panel. */
  function toggleGoalDetail(force) {
    const panel = $("goal-detail");
    const open = typeof force === "boolean" ? force : panel.hidden;
    panel.hidden = !open;
    $("goal-main").setAttribute("aria-expanded", String(open));
    if (open) renderGoalDetail();
  }

  function renderGoalDetail() {
    const panel = $("goal-detail");
    if (panel.hidden) return;
    panel.replaceChildren();
    panel.appendChild(el("p", "goal-detail-objective", goalState.text || ""));
    const status = String(goalState.status || "");
    const reason = String(goalState.reason || "").trim();
    const evidence = Array.isArray(goalState.evidence)
      ? goalState.evidence.map((item) => String(item || "").trim()).filter(Boolean) : [];
    if (reason) {
      const label = status === "blocked" ? "Blocked" : status === "paused" ? "Paused" : "Note";
      panel.appendChild(el("p", "goal-detail-why", `${label}: ${reason}`));
    }
    if (evidence.length) {
      panel.appendChild(el("p", "goal-detail-label", evidence.length === 1 ? "Evidence" : "Evidence"));
      const list = el("ul", "goal-detail-evidence");
      for (const item of evidence) list.appendChild(el("li", "", item));
      panel.appendChild(list);
    }
    if (!reason && !evidence.length) {
      panel.appendChild(el("p", "goal-detail-why goal-detail-quiet",
        status === "active" ? "No blocker recorded. Nothing has stopped it." : "Nothing recorded yet."));
    }
  }

  let goalEditPending = false;
  function setGoalEditPending(pending) {
    goalEditPending = pending;
    $("goal-editor-text").disabled = pending;
    $("goal-editor-budget").disabled = pending;
    $("goal-editor-save").disabled = pending;
    $("goal-editor-save").textContent = pending ? "Applying after current request…" : "Save";
    $("goal-editor-cancel").textContent = pending ? "Close" : "Cancel";
  }
  function openGoalEditor() {
    if (!goalState.text) return;
    const editor = $("goal-editor-text");
    if (!goalEditPending) {
      editor.value = goalState.text;
      $("goal-editor-budget").value = goalState.token_budget ? String(goalState.token_budget) : "";
    }
    setGoalEditPending(goalEditPending);
    $("goal-editor").hidden = false;
    editor.focus(); editor.selectionStart = editor.selectionEnd = editor.value.length;
  }
  function closeGoalEditor(restoreFocus = true) {
    $("goal-editor").hidden = true;
    if (restoreFocus && !goalBar.hidden) focusQuietly($("goal-main"));
  }
  function saveGoalEditor() {
    if (goalEditPending) return;
    const text = $("goal-editor-text").value.trim();
    if (!text) return;
    const rawBudget = $("goal-editor-budget").value.trim();
    const budget = rawBudget === "" ? 0 : Number(rawBudget);
    if (!Number.isSafeInteger(budget) || budget < 0 || budget > 1e12) {
      $("goal-editor-budget").setCustomValidity("Enter a whole number from 0 to 1,000,000,000,000, or leave blank for no limit.");
      $("goal-editor-budget").reportValidity();
      return;
    }
    $("goal-editor-budget").setCustomValidity("");
    $("goal-editor-save").disabled = true;
    vscode.postMessage({ type: "updateGoal", text,
                         tokenBudget: Number.isSafeInteger(budget) && budget > 0 ? budget : 0 });
  }
  function renderGoalReview() {
    const body = $("goal-review-body");
    body.replaceChildren();
    body.appendChild(el("div", "text", md(goalState.text)));
    const status = el("p");
    status.textContent = `${goalState.status} · ${formatDuration(currentGoalElapsed())} worked · ${Number(goalState.cycles || 0)} cycles`;
    body.appendChild(status);
    const attached = goalState.attachments || {};
    const labels = [...(Array.isArray(attached.skills) ? attached.skills.map(name => "$" + name) : []),
      ...(Array.isArray(attached.templates) ? attached.templates.map(name => "/" + name) : [])];
    if (attached.context) labels.push(`${Number(attached.context)} context attachment${Number(attached.context) === 1 ? "" : "s"}`);
    if (attached.images) labels.push(`${Number(attached.images)} image${Number(attached.images) === 1 ? "" : "s"}`);
    if (labels.length || attached.invalid) {
      const summary = el("p", "goal-attachments");
      summary.textContent = attached.invalid ? "Saved attachments could not be restored. Replace this goal before resuming."
        : "Attached to this goal: " + labels.join(" · ");
      body.appendChild(summary);
    }
    if (goalState.reason) { const reason = el("p"); reason.textContent = goalState.reason; body.appendChild(reason); }
    if (Array.isArray(goalState.evidence) && goalState.evidence.length) {
      body.appendChild(el("h3", "", "Evidence"));
      const list = el("ul");
      goalState.evidence.forEach(item => { const li = el("li"); li.textContent = String(item); list.appendChild(li); });
      body.appendChild(list);
    }
    const usage = el("p");
    usage.textContent = goalState.usage_known === false ? "Token usage unavailable for this route"
      : `${Number(goalState.tokens_used || 0).toLocaleString()} reported tokens${goalState.token_budget ? ` / ${Number(goalState.token_budget).toLocaleString()} budget` : ""}`;
    body.appendChild(usage);
    if (Array.isArray(goalState.history) && goalState.history.length) {
      const history = el("details"), list = el("ul");
      history.appendChild(el("summary", "", "Goal history"));
      goalState.history.forEach(item => { const li = el("li");
        li.textContent = `${String(item.status)} · ${String(item.reason || "")}`; list.appendChild(li); });
      history.appendChild(list); body.appendChild(history);
    }
  }
  function openGoalReview() {
    if (!goalState.text) return;
    renderGoalReview(); $("goal-review").hidden = false; $("goal-review-close").focus();
    vscode.postMessage({ type: "reviewGoal" });
  }
  function closeGoalReview(restoreFocus = true) {
    $("goal-review").hidden = true;
    if (restoreFocus) focusQuietly($("goal-review-button"));
  }
  const goalClockTimer = setInterval(paintGoalClock, 500);
  if (goalClockTimer && typeof goalClockTimer.unref === "function") goalClockTimer.unref();

  // ---- the rail as one line of chips (B2) ----
  // A goal, a troupe, monitors, the checklist and this chat's changes each took a full row above the box: 204px of a
  // 460x820 side bar, a third of what the transcript had. With two or more kinds showing, each is one chip on a single
  // line ("◎ 1:12:00", "Troupe 5/8", "2 monitors", "Tasks 4/7", "6 files +214 −37"), and a chip opens that kind's REAL
  // row -- the same element, with every control it has -- in a popover just above the box, over the end of the
  // transcript. One kind alone keeps its full row: there is room for it. A kind that needs you (a blocked task, monitor
  // events waiting for your next message, a blocked goal, a failed troupe, a Pips alert) turns its chip amber and says
  // why. The chips are one toolbar: a single Tab stop, the arrows move along it, Enter or Space opens a chip, focus goes
  // into its popover and back to the chip when it closes (Esc, a click elsewhere, × or the chip again).
  var railChipsReady = false;                    // `var`: the rail syncs while the panel is still starting up
  const railLine = $("rail-line"), railChips = $("rail-chips"), railPop = $("rail-pop");
  const railPopBody = $("rail-pop-body"), railPopLinks = $("rail-pop-links");
  // Where each row lives in the rail, so a row a popover borrowed goes back to its own place.
  const RAIL_ROW_ORDER = ["pipsbar", "monitorsbar", "troupebar", "changesbar", "tasksbar", "goalbar", "pastebar"];
  const RAIL_POP_TITLES = { goal: "Goal", troupe: "Troupe", monitors: "Monitors", tasks: "Tasks",
    changes: "Changes in this chat", pips: "Pips", pipfixes: "Pip fixes", piprunning: "Pips running" };
  const RAIL_FITS = ["full", "compact", "tight", "tighter", "wrap"];
  const railChipNodes = new Map();               // kind -> its chip, kept across repaints so a focused chip keeps focus
  let railKinds = [], railStop = "", railOpen = null, railFit = { width: -1, shape: "" }, railLinksSig = "";
  // A kind's real row; Pip fixes have no row (their cards are in the chat): their popover lists them.
  const railBar = (kind) => (kind === "pipfixes" ? paintPipFixesPanel() : kind === "piprunning" ? paintPipRunningPanel()
    : (RAIL_KINDS.find(([name]) => name === kind) || [])[1] || null);
  const railCount = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  function railTroupeLead() {
    const runs = [...troupeRuns.values()];
    return runs.filter((ev) => String(ev.state || "running") === "running").at(-1) || runs.at(-1) || null;
  }

  // What a chip says: an icon, a word (the first thing a short line drops), the number, extras (dropped next) and,
  // when the kind needs you, an amber dot with the reason (the words go last; the amber and the label never do).
  function railChipSpec(kind) {
    if (kind === "goal") {
      const status = goalState.status, blocked = status === "blocked", paused = status === "paused";
      const state = blocked ? "blocked" : paused ? "paused" : "pursuing";
      return { icon: "target", word: paused ? "Paused" : "Goal", num: formatDuration(currentGoalElapsed()),
        live: status === "active", need: blocked, tone: "error", needWord: blocked ? "blocked" : "",
        label: `Goal, ${state}: ${String(goalState.text || "").replace(/\s+/g, " ").slice(0, 160)}`,
        tip: `Goal · ${blocked ? "blocked: it needs your decision" : state}` };
    }
    if (kind === "troupe") {
      const lead = railTroupeLead();
      if (!lead) return null;
      const runs = [...troupeRuns.values()], state = String(lead.state || "running"), sum = troupeSummary(lead);
      let num = TROUPE_STATES[state] || state;
      if (state === "running") {
        const stages = troupeStages(lead);
        const stage = stages.find((s) => { const c = troupeCounts(s); return !c.total || c.settled < c.total; }) || stages.at(-1);
        const c = stage ? troupeCounts(stage) : { total: 0, settled: 0 };
        num = c.total ? `${Math.min(c.settled, c.total)}/${c.total}` : "starting";
      }
      const failed = runs.filter((ev) => String(ev.state || "") === "failed").length, title = String(lead.title || "");
      // A failed lead says so in its number ("Failed"); one that failed behind a running lead says it beside it.
      return { icon: "troupe", word: runs.length > 1 ? `${runs.length} troupes` : "Troupe", num, live: state === "running",
        share: sum.share, need: failed > 0, tone: "error", needWord: failed && state !== "failed" ? `${failed} failed` : "",
        label: `Troupe${title ? ` ${title}` : ""}: ${sum.text}`, tip: `Troupe · ${title ? `${title} · ` : ""}${sum.text}` };
    }
    if (kind === "monitors") {
      const live = monitorItems.filter((item) => item.state === "running" || item.state === "stopping").length;
      const waiting = monitorsHeld ? monitorsPending : 0;
      const paused = monitorsPaused || lastConfig?.monitor_wake === false;
      const said = [live ? `${railCount(live, "monitor")} running` : "",
        waiting ? `${eventCount(waiting)} waiting for your next message` : "", paused ? "wake-ups paused" : ""].filter(Boolean);
      return { icon: "pulse", num: live ? String(live) : `${waiting} waiting`, after: live ? (live === 1 ? "monitor" : "monitors") : "",
        live: live > 0 && !paused, need: waiting > 0, tone: "warn", needWord: live && waiting ? `${waiting} waiting` : "",
        label: `Monitors: ${said.join(", ")}`, tip: `Monitors · ${said.join(" · ")}` };
    }
    if (kind === "tasks") {
      const statusOf = (t) => (Object.hasOwn(TODO_GLYPHS, t.status) ? t.status : "pending");
      const rows = paintedTodos, done = rows.filter((t) => t.status === "done").length;
      const blocked = rows.filter((t) => statusOf(t) === "blocked").length;
      return { icon: "checklist", word: "Tasks", num: `${done}/${rows.length}`, live: rows.some((t) => statusOf(t) === "in_progress"),
        need: blocked > 0, tone: "error", needWord: blocked ? `${blocked} blocked` : "",
        label: $("tasks-main").getAttribute("aria-label") || `Tasks, ${done} of ${rows.length} done`,
        tip: `Tasks · ${done} of ${rows.length} done${blocked ? ` · ${blocked} blocked: needs you` : ""}` };
    }
    if (kind === "changes") {
      const { total, additions, deletions } = changeState;
      const count = $("changes-count").textContent;
      return { icon: "diff-multiple", num: total ? String(total) : "Changes", after: total ? (total === 1 ? "file" : "files") : "",
        extra: total ? [[`+${additions}`, "change-add"], [`−${deletions}`, "change-del"]] : [["partial scan", ""]],
        label: total ? `${count}, ${railCount(additions, "line")} added, ${railCount(deletions, "line")} removed` : count,
        tip: total ? `${count} · +${additions} −${deletions}` : count };
    }
    if (kind === "pipfixes") {
      const shown = pipFixesForChip(), live = shown.filter(pipFixActive);
      const waiting = live.filter((fix) => agentRecords.get(fix.agent_id)?.state === "waiting").length;
      const said = shown.map((fix) => `${fix.name || "Pip"}: ${pipFixHeadline(fix)}`).join("; ");
      return { icon: "tools", word: "Pip fixes", num: String(live.length || shown.length), live: live.length > 0,
        need: waiting > 0, tone: "warn", needWord: waiting ? "needs you" : "",
        label: `Pip fixes: ${said}`, tip: `Pip fixes · ${said}` };
    }
    if (kind === "piprunning") {
      // "Billing audit running · 0:42"; two or more, "2 Pips running". As room runs out, "running" goes first, then
      // the clock; the name stays.
      const runs = pipRunningList();
      if (!runs.length) return null;
      if (runs.length === 1) {
        const run = runs[0], name = String(run.name || "A Pip"), clock = formatDuration(pipRunningSeconds(run));
        return { icon: "play-circle", num: name, after: "running", extra: [[`· ${clock}`, ""]], live: true,
          label: `${name} is running, ${clock}, ${pipStartedWords(run).toLowerCase()}. Open its chat`,
          tip: `${name} · running ${clock} · ${pipStartedWords(run)}\nOpen its chat in Pips` };
      }
      const said = runs.map((run) => `${run.name || "A Pip"} (${formatDuration(pipRunningSeconds(run))})`).join(", ");
      return { icon: "play-circle", num: `${runs.length} Pips`, after: "running", live: true,
        label: `${runs.length} Pips running: ${said}`, tip: `${runs.length} Pips running · ${said}` };
    }
    if (kind === "pips") {
      const alert = pipsBar.dataset.reason === "alert", headline = $("pips-digest-text").textContent;
      return { icon: "bell", num: "Pips", need: alert, tone: "warn", needWord: alert ? "alert" : "",
        label: `Pips: ${headline}`, tip: `Pips · ${headline}` };
    }
    return null;
  }
  function railChipFace(spec) {
    const icon = spec.icon === "troupe"
      ? `<span class="chip-mark" aria-hidden="true">${troupeMark("rail-chip-troupe")}</span>`
      : `<span class="codicon codicon-${spec.icon}" aria-hidden="true"></span>`;
    const part = (cls, text) => (text ? `<span class="${cls}">${esc(text)}</span>` : "");
    const mini = typeof spec.share === "number"
      ? `<span class="chip-mini troupe-bar" aria-hidden="true"><span style="width:${spec.share}%"></span></span>` : "";
    const extra = (spec.extra || []).map(([text, cls]) => part(`chip-extra ${cls}`.trim(), text)).join("");
    // What needs you is said in words and coloured as the rows were before the chip line (the founder, 19 Oct):
    // blocked or failed in the error red, the icon with it; waiting or an alert in amber. No dot, no outline.
    const need = spec.need ? part("chip-need", spec.needWord) : "";
    return icon + part("chip-word", spec.word) + part("chip-num", spec.num) + part("chip-word", spec.after) + mini + extra + need;
  }
  function railChip(kind) {
    const chip = el("button", "rail-chip");
    chip.type = "button";
    chip.dataset.kind = kind;
    chip.tabIndex = -1;
    chip.setAttribute("aria-haspopup", "dialog");
    chip.setAttribute("aria-expanded", "false");
    chip.setAttribute("aria-controls", "rail-pop");
    chip.addEventListener("click", () => {
      // One Pip running: its chip goes straight to that Pip's chat, at the run's live post.
      if (kind === "piprunning" && pipRunningList().length === 1) { openRunningPip(pipRunningList()[0]); return; }
      if (railOpen?.kind === kind) closeRailPop(); else openRailPop(kind);
    });
    chip.addEventListener("focus", () => { if (railStop !== kind) { railStop = kind; railRove(); } });
    return chip;
  }
  function paintRailChip(kind) {
    if (!railChipsReady) return;
    const chip = railChipNodes.get(kind), spec = chip ? railChipSpec(kind) : null;
    if (!spec) return;
    const sig = JSON.stringify(spec);
    if (chip._sig === sig) return;
    chip._sig = sig;
    chip.innerHTML = railChipFace(spec);
    chip.toggleAttribute("data-live", !!spec.live);
    if (kind === "piprunning" && pipRunningList().length === 1) chip.removeAttribute("aria-haspopup");
    else chip.setAttribute("aria-haspopup", "dialog");
    if (spec.need) chip.dataset.need = spec.tone === "error" ? "error" : "warn"; else delete chip.dataset.need;
    chip.setAttribute("aria-label", spec.label + (spec.need ? `. Needs you${spec.needWord ? `: ${spec.needWord}` : ""}` : ""));
    hoverTip.retitle(chip, spec.tip);
    // Only a change of shape can change what fits: a ticking clock keeps its width.
    const shape = sig.replace(/\d/g, "0");
    if (chip._shape !== shape) { chip._shape = shape; fitRailChips(); }
  }
  function renderRailChips(present) {
    if (!railChipsReady) return;
    const focusWas = document.activeElement;
    const hadFocus = railPop.contains(focusWas) || railChips.contains(focusWas);
    railKinds = present;
    railChips.hidden = !present.length;
    railLine.classList.toggle("has-chips", present.length > 0);
    // Its kind ended (a cleared checklist, a dismissed troupe), or it is the last one left and has its row back.
    if (railOpen && !present.includes(railOpen.kind)) closeRailPop({ restore: false });
    for (const [kind, chip] of railChipNodes) {
      if (!present.includes(kind)) { chip.remove(); railChipNodes.delete(kind); }
    }
    present.forEach((kind, index) => {
      let chip = railChipNodes.get(kind);
      if (!chip) { chip = railChip(kind); railChipNodes.set(kind, chip); }
      if (railChips.children[index] !== chip) railChips.insertBefore(chip, railChips.children[index] || null);
      paintRailChip(kind);
    });
    railRove();
    if (railOpen) paintRailPopLinks(railOpen.kind);
    fitRailChips();
    // Focus that was on the line or in its popover and has nowhere left to be goes to the line, else the prompt.
    if (hadFocus && !railShown(document.activeElement)) {
      const stop = railChips.querySelector('.rail-chip[tabindex="0"]');
      if (stop && !railChips.hidden) focusQuietly(stop); else input.focus({ preventScroll: true });
    }
  }
  // Whether the focus is somewhere a reader can see: not on the page itself, not in a hidden row, not in a row
  // folded into its chip.
  function railShown(node) {
    return !!node && node !== document.body && node.isConnected && !node.closest("[hidden]")
      && !(composerRail.classList.contains("as-chips") && composerRail.contains(node) && !pasteBar.contains(node));
  }
  // One Tab stop for the whole line: the chip last used, else the first.
  function railRove() {
    const chips = [...railChips.children];
    const keep = chips.find((chip) => chip.dataset.kind === railStop) || chips[0];
    for (const chip of chips) { const want = chip === keep ? 0 : -1; if (chip.tabIndex !== want) chip.tabIndex = want; }
  }
  // The line never scrolls sideways and never clips a chip: as room runs out it drops the words, then the extras
  // (the diff counts and the troupe's bar), then the number of a chip that needs you (its reason, dot and amber
  // stay), and only then wraps onto a second line.
  function fitRailChips(force = false) {
    if (!railChipsReady) return;
    if (!railKinds.length) { delete railLine.dataset.fit; railFit = { width: -1, shape: "" }; return; }
    const width = railLine.clientWidth;
    const shape = railKinds.map((kind) => railChipNodes.get(kind)?._shape || "").join("|");
    if (!force && width === railFit.width && shape === railFit.shape) return;
    railFit = { width, shape };
    for (const fit of RAIL_FITS) {
      railLine.dataset.fit = fit;
      if (fit === "wrap" || railChips.scrollWidth <= railChips.clientWidth + 1) break;
    }
  }
  if (typeof ResizeObserver === "function") new ResizeObserver(() => { fitRailChips(); sizeRailPop(); }).observe(railLine);
  window.addEventListener("resize", () => sizeRailPop());
  // The popover may use the height between the header and the chip line, and scrolls past that.
  function sizeRailPop() {
    if (!railOpen) return;
    const room = Math.floor(railLine.getBoundingClientRect().top - ($("phead")?.getBoundingClientRect().bottom || 0) - 12);
    railPop.style.maxHeight = room > 0 ? `${Math.max(160, room)}px` : "";
  }
  // Ways further than the row goes, under it: the troupe's journal, and the agent map that lists troupes and
  // monitors under its background tasks.
  function paintRailPopLinks(kind) {
    const links = [];
    if (kind === "troupe") {
      const lead = railTroupeLead(), id = String(lead?.run_id || "");
      if (/^tr-[0-9a-f]{10}$/.test(id)) {
        links.push(["Open the journal", "Open this troupe's journal: its plan, every agent's result and the report",
          () => vscode.postMessage({ type: "openTroupeJournal", runId: id })]);
      }
      // The map lists what runs now: an ended troupe is not on it.
      if (id && String(lead.state || "running") === "running") {
        links.push(["Show in the agent map", "Open the agent map at this troupe", () => railShowInMap(`troupe:${id}`)]);
      }
    }
    if (kind === "monitors") {
      const first = monitorItems.find((item) => item.state === "running" || item.state === "stopping");
      if (first) links.push(["Show in the agent map", "Open the agent map at the monitors", () => railShowInMap(`monitor:${first.id}`)]);
    }
    const sig = links.map(([text, title]) => `${text}\n${title}`).join("\n") + (links.length ? kind + railTroupeLead()?.run_id : "");
    if (sig === railLinksSig) return;
    railLinksSig = sig;
    railPopLinks.replaceChildren(...links.map(([text, title, run]) => {
      const link = el("button", "link rail-pop-link");
      link.type = "button"; link.textContent = text; link.title = title; link.onclick = run;
      return link;
    }));
    railPopLinks.hidden = !links.length;
  }
  function railShowInMap(key) {
    const chip = railOpen?.chip || null;
    closeRailPop({ restore: false });
    openAgentMap({ from: chip });
    const row = amRevealRow(key);
    if (row) amFocusRow(row, { quiet: false });
  }
  function openRailPop(kind) {
    const chip = railChipNodes.get(kind), bar = railBar(kind);
    if (!chip || !bar || bar.hidden) return;
    if (railOpen) closeRailPop({ restore: false });
    hoverTip.hide();
    railOpen = { kind, bar, chip, unfolded: [] };
    railPopBody.replaceChildren(bar);          // the row itself moves: its ids, controls and live updates come with it
    // The stages and the checklist are what the chip summed up, so they come open; closing folds them again.
    if (kind === "troupe" && !troupesOpen) { toggleTroupes(); railOpen.unfolded.push(() => { if (troupesOpen) toggleTroupes(); }); }
    if (kind === "tasks" && !tasksOpen()) { toggleTasks(); railOpen.unfolded.push(() => { if (tasksOpen()) toggleTasks(); }); }
    $("rail-pop-title").textContent = RAIL_POP_TITLES[kind] || "";
    if (kind === "pipfixes") for (const fix of pipFixes.values()) if (!pipFixActive(fix)) fix._seen = true;
    railLinksSig = "";
    paintRailPopLinks(kind);
    railPop.dataset.kind = kind;
    railPop.hidden = false;
    railLine.classList.add("pop-open");
    sizeRailPop();
    chip.setAttribute("aria-expanded", "true");
    railStop = kind; railRove();
    // Into the popover: the row's own main control (never a Stop), else the popover itself.
    const main = [...bar.querySelectorAll(".rail-main")].find((node) => !node.disabled && !node.closest("[hidden]"));
    focusQuietly(main || railPop, { preventScroll: true });
  }
  // `restore`: put the focus back on the chip if it was inside the popover (Esc, ×, the chip again). A click
  // elsewhere, or Tab out of it, leaves the focus where it went.
  function closeRailPop({ restore = true } = {}) {
    if (!railChipsReady || !railOpen) return;
    const { bar, chip, unfolded } = railOpen;
    const active = document.activeElement, inside = railPop.contains(active);
    railOpen = null;
    unfolded.forEach((fold) => fold());
    if (bar === pipRunningPanel) bar.remove();   // the running Pips list is the popover's own too
    else if (bar === pipFixesPanel) {
      bar.remove();                    // the Pip fixes list is the popover's own, never a rail row
      setTimeout(syncComposerRail, 0); // the fixes it showed are seen now: an ended one leaves the chip
    } else {
      const next = RAIL_ROW_ORDER.slice(RAIL_ROW_ORDER.indexOf(bar.id) + 1).map((id) => $(id))
        .find((node) => node && node.parentElement === composerRail);
      composerRail.insertBefore(bar, next || null);
    }
    railPop.hidden = true;
    railPop.style.maxHeight = "";
    delete railPop.dataset.kind;
    railPopLinks.replaceChildren(); railPopLinks.hidden = true; railLinksSig = "";
    railLine.classList.remove("pop-open");
    chip.setAttribute("aria-expanded", "false");
    if (!inside) return;
    if (restore && chip.isConnected && !railChips.hidden) { focusQuietly(chip); return; }
    // Moving the row took the focus off it. Where the row is on screen again (the last kind left has its full row
    // back), the focus goes back to the same control.
    if (active?.isConnected && bar.contains(active) && railShown(active)) focusQuietly(active);
  }
  $("rail-pop-close").onclick = () => closeRailPop();
  railPop.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !railOpen) return;
    event.preventDefault(); event.stopPropagation();    // Esc in the composer is Stop: this one must not reach it
    closeRailPop();
  });
  // A control that went away under the focus (Stop, once its troupe has stopped) leaves the focus on the page itself:
  // Esc there still closes the popover, and the focus goes back to its chip.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !railOpen || event.defaultPrevented) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    event.preventDefault();
    const chip = railOpen.chip;
    closeRailPop();
    if (chip.isConnected && !railChips.hidden) focusQuietly(chip);
  });
  railChips.addEventListener("keydown", (event) => {
    const chips = [...railChips.children], at = chips.indexOf(event.target);
    if (at < 0) return;
    if (event.key === "Escape") {
      if (!railOpen) return;
      event.preventDefault(); event.stopPropagation();
      closeRailPop();
      return;
    }
    const to = event.key === "ArrowRight" ? (at + 1) % chips.length : event.key === "ArrowLeft" ? (at - 1 + chips.length) % chips.length
      : event.key === "Home" ? 0 : event.key === "End" ? chips.length - 1 : -1;
    if (to < 0) return;
    event.preventDefault();
    railStop = chips[to].dataset.kind; railRove();
    chips[to].focus();
  });
  // A dialog opened from the popover (the goal editor, the changes review) sits over it: working in it is not
  // "elsewhere", and the popover is still there, with the focus coming back to it, when the dialog closes.
  const railAway = (node) => node instanceof Element && !railPop.contains(node) && !railChips.contains(node)
    && !node.closest(".modal-layer, .panel-overlay, #hover-tip");
  document.addEventListener("pointerdown", (event) => { if (railOpen && railAway(event.target)) closeRailPop({ restore: false }); }, true);
  railPop.addEventListener("focusout", (event) => {
    // Focus that went nowhere (a repaint took the focused control away) leaves it open.
    if (railOpen && event.relatedTarget && railAway(event.relatedTarget)) closeRailPop({ restore: false });
  });
  railChipsReady = true;
  syncComposerRail();

  // ---- dedicated non-chat surfaces (skills, MCP, docs, permissions, memory, hooks) ----
  const SURFACE_META = {
    skills: ["Skills", "library"], mcp: ["MCP servers", "plug"],
    docs: ["Documentation", "book"], permissions: ["Permission rules", "shield"],
    memory: ["Memory", "bookmark"], hooks: ["Lifecycle hooks", "run-all"],
  };
  let surfaceKind = "", surfaceReturnFocus = null, surfaceRows = [], mcpRows = [], mcpTools = [];
  let pluginLogos = {};
  const surfaceBody = $("surface-body"), surfaceSearch = $("surface-search");

  function openSurface(kind) {
    if (!SURFACE_META[kind]) return;
    surfaceKind = kind;
    if ($("surface").hidden) surfaceReturnFocus = document.activeElement;
    $("surface-title-text").textContent = SURFACE_META[kind][0];
    $("surface-icon").className = "codicon codicon-" + SURFACE_META[kind][1];
    $("surface").hidden = false; surfaceSearch.value = "";
    surfaceBody.innerHTML = '<div class="surface-empty">Loading…</div>';
    $("surface-primary").hidden = true; $("surface-secondary").hidden = true;
    surfaceSearch.focus();
  }
  function closeSurface() {
    $("surface").hidden = true; surfaceKind = "";
    const target = surfaceReturnFocus && typeof surfaceReturnFocus.focus === "function"
      ? surfaceReturnFocus : input;
    surfaceReturnFocus = null; target.focus();
  }
  function dismissSurface() {
    if (mcpContextPending) { vscode.postMessage({ type: "cancel" }); mcpContextPending = ""; }
    closeSurface();
  }
  function surfaceButtons(primary, primaryAction, secondary, secondaryAction) {
    const p = $("surface-primary"), s = $("surface-secondary");
    for (const button of [p, s]) { delete button.dataset.skillMutation; button.disabled = false; }
    p.hidden = !primary; p.textContent = primary || ""; p.onclick = primaryAction || null;
    s.hidden = !secondary; s.textContent = secondary || ""; s.onclick = secondaryAction || null;
  }
  function filterSurface() {
    const query = surfaceSearch.value.trim().toLowerCase();
    surfaceBody.querySelectorAll("[data-filter]").forEach((node) => {
      node.hidden = Boolean(query) && !String(node.dataset.filter || "").includes(query);
    });
  }
  function useSkill(name) {
    const skill = skillRows.find((row) => row.name === name);
    if (skill?.enabled === false) return;
    if (!attachInvocation("skill", name)) return;
    if (!composerText().trim() && skill?.default_prompt) {
      setComposerText(String(skill.default_prompt).slice(0, 4096));
      autosizeComposer();
    }
    closeSurface(); input.focus();
  }
  function attachInvocation(kind, name) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) return false;
    if (!attachments.some((a) => a[kind] === name)) {
      if (attachments.filter(item => item.skill || item.template).length >= 8) {
        sysLine("Select at most eight skills and prompt templates per message."); return false;
      }
      if (!canAttach()) return false;
      attachments.push({ label: `${kind === "skill" ? "$" : "/"}${name}`, [kind]: name });
    }
    renderAtts();
    return true;
  }
  function canAttach() {
    const waiting = [...pendingImages].filter(owner => owner.session === draftSession).length;
    if (attachments.length + waiting >= 64) { sysLine("Select at most 64 attachments per message."); return false; }
    return true;
  }
  // The chat has no Plugins browser: the standalone Settings tab owns that surface, and it is
  // strictly richer -- directory browse, an install review with per-server checkboxes, marketplaces,
  // uninstall. The in-chat one shipped behind a dialog that could not be opened, and its single
  // button posted `installPlugin`, which the host answers by opening that same Settings tab.
  //
  // The catalog still arrives here, for one live consumer: a tool card belonging to a plugin's MCP
  // server draws that package's own mark (pluginLogoHtml, above). This is where that cache fills.
  function cachePluginLogos(items) {
    pluginLogos = {};
    for (const row of Array.isArray(items) ? items : []) {
      if (row.logo) pluginLogos[row.name] = row.logo;
    }
  }
  function renderSkills(items) {
    const query = surfaceKind === "skills" ? surfaceSearch.value : "";
    surfaceRows = Array.isArray(items) ? items : [];
    openSurface("skills");
    surfaceSearch.value = query;
    surfaceBody.innerHTML = surfaceRows.length ? surfaceRows.map((skill, i) =>
      `<article class="surface-card" data-filter="${esc(`${skill.name} ${skill.display_name || ""} ${skill.source} ${skill.description}`.toLowerCase())}"><div class="surface-card-head"><button type="button" class="surface-name" data-skill-view="${i}">${esc(skill.display_name || "$" + skill.name)}</button><span class="surface-badge">${esc(skill.source || "unknown")}${skill.enabled === false ? " · disabled" : skill.allow_implicit_invocation === false ? " · explicit only" : ""}</span></div><p>${esc(skill.short_description || skill.description || "Reusable agent instructions")}</p>${(Array.isArray(skill.diagnostics) ? skill.diagnostics : []).map((line) => `<p class="muted">${esc(line)}</p>`).join("")}<div class="surface-actions"><button type="button" class="act primary" data-skill-use="${i}"${skill.enabled === false ? " disabled" : ""}>Use skill</button><button type="button" class="act" data-skill-view="${i}">View instructions</button>${skillManagement ? `<button type="button" class="act" data-skill-toggle="${i}" aria-pressed="${skill.enabled !== false}">${skill.enabled === false ? "Enable" : "Disable"}</button>` : ""}</div></article>`).join("")
      : '<div class="surface-empty">No skills are installed. Add a project skill at <code>.dgc/skills/&lt;name&gt;/SKILL.md</code>.</div>';
    surfaceBody.querySelectorAll("[data-skill-use]").forEach((button) => button.onclick = () => useSkill(surfaceRows[+button.dataset.skillUse].name));
    surfaceBody.querySelectorAll("[data-skill-view]").forEach((button) => button.onclick = () => vscode.postMessage({ type: "getSkill", name: surfaceRows[+button.dataset.skillView].name }));
    surfaceBody.querySelectorAll("[data-skill-toggle]").forEach((button) => button.onclick = () => {
      const skill = surfaceRows[+button.dataset.skillToggle]; button.disabled = true;
      vscode.postMessage({ type: "skillToggle", name: skill.name, enabled: skill.enabled === false });
    });
    surfaceButtons("Reload", () => vscode.postMessage({ type: "skillsReload" }),
      skillManagement ? "Create / install" : "", () => vscode.postMessage({ type: "skillsManage" }));
    for (const button of [$("surface-primary"), $("surface-secondary"), ...surfaceBody.querySelectorAll("[data-skill-toggle]")]) {
      button.dataset.skillMutation = "true";
      button.disabled = streaming;
      button.title = streaming ? "Available after this turn finishes" : "";
    }
    filterSurface();
  }
  function renderSkillDetail(ev) {
    openSurface("skills");
    if (!ev.found) { surfaceBody.innerHTML = '<div class="surface-empty">That skill is no longer installed.</div>'; return; }
    surfaceBody.innerHTML = `<button type="button" class="surface-back">← All skills</button><div class="surface-detail-head"><h2>$${esc(ev.name)}</h2><span class="surface-badge">${esc(ev.source)}</span></div><p class="muted">${esc(ev.description || "")}</p><div class="surface-markdown">${md(ev.markdown || "")}</div>`;
    surfaceBody.querySelector(".surface-back").onclick = () => renderSkills(surfaceRows);
    const enabled = skillRows.find((skill) => skill.name === ev.name)?.enabled !== false;
    surfaceButtons(enabled ? "Use skill" : "", () => useSkill(ev.name));
  }
  function mcpStateClass(value) { return ["connected", "configured"].includes(value) ? "ok" : value === "failed" ? "err" : ""; }
  function showMcpForm(item) {
    const value = item || { name: "", transport: "stdio", command: "", args: [], env_names: [], url: "", log_level: "warning" };
    const remote = value.transport === "remote";
    surfaceBody.innerHTML = `<button type="button" class="surface-back">← MCP servers</button><form id="mcp-config-form" class="surface-form"><input id="mcp-original" type="hidden" value="${esc(value.name || "")}"><label>Server name<input id="mcp-name" required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" value="${esc(value.name || "")}" placeholder="github"></label><label>Transport<select id="mcp-transport"><option value="stdio"${remote ? "" : " selected"}>Local STDIO</option><option value="remote"${remote ? " selected" : ""}>Remote (Streamable HTTP or SSE)</option></select></label><label id="mcp-target-label">${remote ? "Server URL" : "Command"}<input id="mcp-target" required value="${esc(remote ? value.url : value.command)}" placeholder="${remote ? "https://mcp.example.com/mcp" : "npx"}"></label><label id="mcp-args-label">Arguments <span class="set-hint">one argument per line; no shell parsing</span><textarea id="mcp-args" rows="4" spellcheck="false">${esc((value.args || []).join("\n"))}</textarea></label><label id="mcp-env-label">Environment <span class="set-hint">KEY=value → SecretStorage · KEY → ambient lookup</span><textarea id="mcp-env" rows="4" spellcheck="false" placeholder="${esc((value.env_names || []).map((name) => `${name}=…`).join("\n") || "GITHUB_TOKEN=…")}"></textarea></label><label id="mcp-token-label">Bearer token <span class="set-hint">blank preserves the saved token</span><input id="mcp-token" type="password" spellcheck="false" placeholder="optional"></label><label class="surface-check"><input id="mcp-clear-secrets" type="checkbox"> Clear stored credentials before saving</label><label>Log level<select id="mcp-log"><option>warning</option><option>info</option><option>debug</option><option>error</option><option>off</option></select></label><div class="surface-actions"><button type="submit" class="act primary">Save and connect</button><button type="button" class="act" id="mcp-cancel">Cancel</button></div></form>`;
    $("mcp-log").value = value.log_level || "warning";
    const updateTransport = () => {
      const isRemote = $("mcp-transport").value === "remote";
      $("mcp-target-label").firstChild.textContent = isRemote ? "Server URL" : "Command";
      $("mcp-args-label").hidden = isRemote; $("mcp-env-label").hidden = isRemote;
      $("mcp-token-label").hidden = !isRemote;
    };
    $("mcp-transport").onchange = updateTransport; updateTransport();
    surfaceBody.querySelector(".surface-back").onclick = () => renderMcp();
    $("mcp-cancel").onclick = () => renderMcp();
    $("mcp-config-form").onsubmit = (event) => {
      event.preventDefault();
      if (!event.target.reportValidity()) return;
      vscode.postMessage({ type: "mcpSave", values: {
        original_name: $("mcp-original").value, name: $("mcp-name").value,
        transport: $("mcp-transport").value, target: $("mcp-target").value,
        args: $("mcp-args").value, env: $("mcp-env").value,
        env_names: value.env_names || [], token: $("mcp-token").value,
        clear_secrets: $("mcp-clear-secrets").checked,
        log_level: $("mcp-log").value,
      } });
      closeSurface(); // Keep browser sign-in and permission cards visible while the host connects.
    };
    surfaceButtons(); $("mcp-name").focus();
  }
  function renderMcp() {
    mcpView = "servers";
    openSurface("mcp");
    const servers = mcpRows.length ? mcpRows.map((item, i) =>
      `<article class="surface-card" data-filter="${esc(`${item.name} ${item.state} ${item.command} ${item.url}`.toLowerCase())}"><div class="surface-card-head"><strong>${esc(item.name)}</strong><span class="surface-state ${mcpStateClass(item.state)}">${esc(item.state || "configured")}</span></div><div class="surface-meta">${esc(item.transport === "remote" ? item.url : [item.command, ...(item.args || [])].join(" "))}</div><p>${Number(item.tool_count || 0)} tool(s)${item.protocol_era ? ` · ${esc(item.protocol_era)}` : ""}</p>${item.error ? `<div class="err">${esc(item.error)}</div>` : ""}<div class="surface-actions"><button type="button" class="act" data-mcp-edit="${i}">Edit</button><button type="button" class="act danger" data-mcp-remove="${i}">Remove</button></div></article>`).join("")
      : '<div class="surface-empty">No MCP servers configured.</div>';
    const tools = mcpTools.length ? `<h2 class="surface-subtitle">Available tools · ${mcpTools.length}</h2>${mcpTools.map((tool) => `<article class="surface-card compact" data-filter="${esc(`${tool.name} ${tool.description}`.toLowerCase())}"><strong>${esc(tool.name)}</strong><p>${esc(tool.description || "")}</p></article>`).join("")}` : "";
    surfaceBody.innerHTML = servers + tools;
    if (mcpManagement) {
      surfaceBody.querySelectorAll("[data-mcp-edit]").forEach((button) => {
        const item = mcpRows[+button.dataset.mcpEdit];
        const toggle = el("button", "act", item.enabled === false ? "Enable" : "Disable"); toggle.type = "button";
        toggle.dataset.mcpToggle = item.name;
        toggle.onclick = () => { toggle.disabled = true;
          vscode.postMessage({ type: "mcpToggle", name: item.name, enabled: item.enabled === false }); };
        const reconnect = el("button", "act", "Reconnect"); reconnect.type = "button";
        reconnect.disabled = item.enabled === false;
        reconnect.onclick = () => { reconnect.disabled = true;
          vscode.postMessage({ type: "mcpReconnect", name: item.name }); };
        button.parentElement.append(toggle, reconnect);
      });
    }
    if (mcpContextSupported) {
      surfaceBody.querySelectorAll("[data-mcp-edit]").forEach((button) => {
        const item = mcpRows[+button.dataset.mcpEdit];
        if (item.state !== "connected") return;
        for (const [kind, label] of [["resources", "Resources"], ["templates", "Resource templates"], ["prompts", "Prompts"]]) {
          const browse = el("button", "act", label); browse.type = "button";
          browse.dataset.mcpBrowse = kind;
          browse.onclick = () => browseMcpContext(item.name, kind);
          button.parentElement.appendChild(browse);
        }
      });
    }
    surfaceBody.querySelectorAll("[data-mcp-edit]").forEach((button) => button.onclick = () => showMcpForm(mcpRows[+button.dataset.mcpEdit]));
    surfaceBody.querySelectorAll("[data-mcp-remove]").forEach((button) => button.onclick = () => vscode.postMessage({ type: "mcpRemove", name: mcpRows[+button.dataset.mcpRemove].name }));
    surfaceButtons("Add server", () => showMcpForm(), "Reload", () => vscode.postMessage({ type: "mcpReload" }));
    filterSurface();
  }
  function browseMcpContext(server, kind) {
    mcpView = "context"; openSurface("mcp");
    mcpContextPending = `mcp-context-${Date.now()}-${++mcpContextSequence}`;
    vscode.postMessage({ type: "mcpContextList", requestId: mcpContextPending, server, kind });
    surfaceButtons("Cancel", () => { vscode.postMessage({ type: "cancel" }); mcpContextPending = ""; renderMcp(); });
  }
  function requestMcpContext(server, kind, identifier, args = {}) {
    mcpContextPending = `mcp-context-${Date.now()}-${++mcpContextSequence}`;
    closeSurface();
    vscode.postMessage({ type: "mcpContextGet", requestId: mcpContextPending, server, kind, identifier, arguments: args });
  }
  function renderMcpContextCatalog(ev) {
    if (ev.request_id !== mcpContextPending) return;
    mcpContextPending = ""; mcpView = "context"; openSurface("mcp");
    const rows = Array.isArray(ev.items) ? ev.items : [];
    surfaceBody.innerHTML = `<button type="button" class="surface-back">← MCP servers</button><h2>${esc(ev.server)} · ${esc(ev.kind)}</h2>`
      + (ev.error ? `<div class="err">${esc(ev.error)}</div>` : rows.length ? rows.map((row, i) =>
        `<button type="button" class="surface-card surface-list-button" data-mcp-context="${i}" data-filter="${esc(`${row.name} ${row.description}`.toLowerCase())}"><strong>${esc(row.title || row.name)}</strong><span>${esc(row.description || row.uri || row.uriTemplate || "Preview prompt")}</span></button>`).join("") : '<p class="muted">This server returned no entries for this category.</p>');
    surfaceBody.querySelector(".surface-back").onclick = renderMcp;
    surfaceBody.querySelectorAll("[data-mcp-context]").forEach((button) => button.onclick = () => {
      const row = rows[+button.dataset.mcpContext];
      if (ev.kind === "resources") requestMcpContext(ev.server, "resources", row.uri);
      else renderMcpContextForm(ev.server, ev.kind, row);
    });
    surfaceButtons("Refresh", () => browseMcpContext(ev.server, ev.kind)); filterSurface();
  }
  function renderMcpContextForm(server, kind, row) {
    const args = Array.isArray(row.arguments) ? row.arguments : [];
    const fields = kind === "templates" ? [{ name: "uri", required: true, description: "Fill in a concrete URI using the server's template." }] : args;
    surfaceBody.innerHTML = `<button type="button" class="surface-back">← ${esc(kind)}</button><h2>${esc(row.title || row.name)}</h2><form id="mcp-context-form" class="surface-form">`
      + fields.map((arg, i) => `<label>${esc(arg.name)}${arg.required ? " *" : ""}<span class="set-hint">${esc(arg.description || "")}</span><input data-context-argument="${i}"${arg.required ? " required" : ""} maxlength="8000" value="${kind === "templates" ? esc(row.uriTemplate) : ""}"></label>`).join("")
      + '<button type="submit" class="act primary">Preview context</button></form>';
    surfaceBody.querySelector(".surface-back").onclick = () => browseMcpContext(server, kind);
    $("mcp-context-form").onsubmit = (event) => {
      event.preventDefault(); if (!event.target.reportValidity()) return;
      const values = Object.create(null);
      fields.forEach((arg, i) => { const value = surfaceBody.querySelector(`[data-context-argument="${i}"]`).value;
        if (value || arg.required) values[arg.name] = value; });
      requestMcpContext(server, kind === "templates" ? "resources" : kind,
        kind === "templates" ? values.uri : row.name, kind === "templates" ? {} : values);
    };
    surfaceButtons();
  }
  function renderMcpContext(ev) {
    if (ev.request_id !== mcpContextPending) return;
    mcpContextPending = ""; mcpView = "context"; openSurface("mcp");
    surfaceBody.innerHTML = `<button type="button" class="surface-back">← MCP servers</button><h2>${esc(ev.server)}</h2><p class="muted">${esc(ev.identifier)}</p>`
      + (ev.error ? `<div class="err">${esc(ev.error)}</div>` : `<div class="surface-markdown">${md(ev.text || "")}</div>`)
      + (Array.isArray(ev.omitted) ? ev.omitted.map((line) => `<p class="muted">${esc(line)}</p>`).join("") : "");
    surfaceBody.querySelector(".surface-back").onclick = renderMcp;
    surfaceButtons(!ev.error && ev.text ? "Attach to draft" : "", () => {
      const resource = { type: "mcp_context", server: ev.server, uri: ev.identifier, text: ev.text };
      const previous = attachments.findIndex((item) => item.resource?.type === "mcp_context" && item.resource.server === ev.server && item.resource.uri === ev.identifier);
      const selected = { label: `${ev.server} · ${ev.identifier}`, resource };
      if (previous >= 0) attachments[previous] = selected;
      else { if (!canAttach()) return; attachments.push(selected); }
      renderAtts(); closeSurface(); input.focus();
    });
  }
  function renderDocs(items) {
    surfaceRows = Array.isArray(items) ? items : []; openSurface("docs");
    surfaceBody.innerHTML = surfaceRows.map((doc, i) => `<button type="button" class="surface-card surface-list-button" data-doc="${i}" data-filter="${esc(`${doc.title} ${doc.description}`.toLowerCase())}"><strong>${esc(doc.title)}</strong><span>${esc(doc.description)}</span></button>`).join("") || '<div class="surface-empty">No documentation is bundled.</div>';
    surfaceBody.querySelectorAll("[data-doc]").forEach((button) => button.onclick = () => vscode.postMessage({ type: "getDoc", id: surfaceRows[+button.dataset.doc].id }));
    surfaceButtons(); filterSurface();
  }
  function renderDoc(ev) {
    openSurface("docs");
    surfaceBody.innerHTML = `<button type="button" class="surface-back">← Documentation</button><div class="surface-markdown">${ev.found ? md(ev.markdown || "") : "Page not found."}</div>`;
    surfaceBody.querySelector(".surface-back").onclick = () => renderDocs(surfaceRows);
    surfaceButtons();
  }
  function renderPermissions(items) {
    surfaceRows = Array.isArray(items) ? items : []; openSurface("permissions");
    // A rule that does not parse is dropped by the engine but kept in the file. Listing it plain
    // let someone read their own `deny` back and believe it was in force; the terminal listings
    // have always said so. Same idiom as the hooks surface below.
    const brokenRules = surfaceRows.filter((rule) => rule && rule.invalid).length;
    surfaceBody.innerHTML = `<form id="permission-form" class="surface-inline-form"><select id="permission-action" aria-label="Rule action"><option>deny</option><option>ask</option><option>allow</option></select><input id="permission-rule" required aria-label="Permission rule" placeholder="Bash(npm test *)"><button class="act primary" type="submit">Add</button></form>` + (brokenRules ? `<div class="err surface-notice">${brokenRules} rule${brokenRules === 1 ? " does" : "s do"} not parse and ${brokenRules === 1 ? "is" : "are"} not in force</div>` : "") + (surfaceRows.map((rule, i) => `<article class="surface-card compact" data-filter="${esc(`${rule.action} ${rule.rule}`.toLowerCase())}"><div class="surface-card-head"><span class="surface-badge ${esc(rule.action)}">${esc(rule.action)}</span><code>${esc(rule.rule)}</code>${rule.invalid ? '<span class="surface-state err">invalid</span>' : ""}<button type="button" class="icon-action" aria-label="Remove rule" data-rule-remove="${i}">×</button></div></article>`).join("") || '<div class="surface-empty">No custom permission rules. Mode defaults still apply.</div>');
    $("permission-form").onsubmit = (event) => { event.preventDefault(); vscode.postMessage({ type: "permissionAdd", action: $("permission-action").value, rule: $("permission-rule").value }); };
    surfaceBody.querySelectorAll("[data-rule-remove]").forEach((button) => button.onclick = () => { const rule = surfaceRows[+button.dataset.ruleRemove]; vscode.postMessage({ type: "permissionRemove", action: rule.action, rule: rule.rule }); });
    surfaceButtons(); filterSurface();
  }
  function renderMemory(ev) {
    openSurface("memory");
    const block = (title, value) => `<section><h2 class="surface-subtitle">${title}</h2><div class="surface-markdown">${value ? md(value) : '<p class="muted">No memory saved.</p>'}</div></section>`;
    surfaceBody.innerHTML = (ev.message ? `<div class="surface-notice">${esc(ev.message)}</div>` : "") + block("Project · DGC.md", ev.project) + block("Personal · ~/.dgc/DGC.md", ev.user);
    const add = (scope) => {
      surfaceBody.innerHTML = `<button type="button" class="surface-back">← Memory</button><form id="memory-form" class="surface-form"><label>Add ${scope} memory<textarea id="memory-text" required rows="6" maxlength="8000" placeholder="A durable fact or preference DGC should remember"></textarea></label><button class="act primary" type="submit">Save memory</button></form>`;
      surfaceBody.querySelector(".surface-back").onclick = () => renderMemory(ev);
      $("memory-form").onsubmit = (event) => { event.preventDefault(); vscode.postMessage({ type: "memoryAdd", scope, text: $("memory-text").value }); };
      surfaceButtons(); $("memory-text").focus();
    };
    surfaceButtons("Add project memory", () => add("project"), "Add personal memory", () => add("user"));
  }
  function renderHooks(ev) {
    openSurface("hooks");
    const items = Array.isArray(ev.items) ? ev.items : [];
    surfaceBody.innerHTML = (Number(ev.invalid || 0) ? `<div class="err surface-notice">${Number(ev.invalid)} invalid or unsupported hook entries</div>` : "") + items.map((hook) => `<article class="surface-card compact" data-filter="${esc(`${hook.event} ${(hook.matchers || []).join(" ")}`.toLowerCase())}"><div class="surface-card-head"><strong>${esc(hook.event)}</strong><span class="surface-state ${hook.valid ? "ok" : "err"}">${hook.valid ? "ready" : "invalid"}</span></div><p>${Number(hook.configured || 0)} configured${hook.matchers?.length ? ` · ${esc(hook.matchers.join(", "))}` : ""}</p></article>`).join("");
    surfaceButtons("Reload", () => vscode.postMessage({ type: "slash", action: "hooks" })); filterSurface();
  }
  surfaceSearch.addEventListener("input", filterSurface);
  $("surface-close").onclick = dismissSurface;
  $("surface").addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); dismissSurface(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...$("surface").querySelectorAll("button, input, select, textarea, [tabindex]")]
      .filter((node) => !node.disabled && !node.hidden && !node.closest("[hidden]")
        && node.getAttribute("aria-hidden") !== "true");
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  function onEvent(ev) {
    if (heldForSnapshot && !replaying) {
      // A new chat, a rewind or a new backend ends the wait: what was held is applied first, in order.
      if (["session", "rewound", "ready"].includes(ev.type)) releaseHeldEvents();
      else if (ev.type !== "history") { if (heldForSnapshot.length < 5000) heldForSnapshot.push(ev); return; }
    }
    if (ev.type === "session" || ev.type === "ready") {
      setChatChanges({ files: [], total: 0 });
      $("changes-review").hidden = true;
    }
    const stick = atBottom();
    switch (ev.type) {
      case "ready": {
        requestEpoch += 1;             // a backend (re)started: its request ids start again
        backendLive = true; backendDown = false; armTodoClearTimer();
        if (Array.isArray(ev.commands) && ev.commands.length
            && ev.commands.every((c) => c && typeof c === "object")) {
          builtinCommands = ev.commands;
        }
        customCommands = Array.isArray(ev.custom_commands) ? ev.custom_commands
          : (Array.isArray(ev.commands) ? ev.commands.filter((c) => typeof c === "string") : []);
        skillRows = (Array.isArray(ev.skills) ? ev.skills : []).map((skill) =>
          typeof skill === "string" ? { name: skill, description: "", source: "" } : skill);
        reasoningControl = ev.provider_capabilities?.reasoning_control || "provider";
        skillManagement = ev.capabilities?.skill_management === true;
        liveSteering = ev.capabilities?.live_steering === true;
        nativeSteering = liveSteering && ev.capabilities?.steering_native !== false;
        agentsLive = ev.capabilities?.agents === true;
        agentControlLive = ev.capabilities?.agent_control === true;
        agentControlForeground = agentControlLive && ev.capabilities?.agent_control_foreground === true;
        backgroundTasksLive = Number(ev.capabilities?.background_tasks?.version) >= 1;
        pipReportsLive = ev.capabilities?.pip_reports === 1;
        pipFixLive = pipReportsLive && ev.capabilities?.pip_fix === 1;
        steerQueuedLive = nativeSteering && ev.capabilities?.steer_queued === true;
        turnFilesLive = ev.capabilities?.turn_files === 1;
        if (turnFilesLive) vscode.postMessage({ type: "turnFilesWatch" });
        // This panel draws Pip reports: ask for this chat's (none is sent, or taken, until it does).
        if (pipReportsLive) vscode.postMessage({ type: "pipReportsWatch" });
        // ...and this chat's fixes, for the cards whose report is not in the history (dismissed) and the chip.
        if (pipFixLive) vscode.postMessage({ type: "listPipFixes" });
        // ...and which of its Pips are running now: the chip above the box (an older CLI says nothing, so no chip).
        pipRunsLive = ev.capabilities?.pip_runs_running === 1;
        setPipRunning([]);
        if (pipRunsLive) vscode.postMessage({ type: "pipRunsWatch" });
        agentMapCapabilities();
        imageSpool = ev.capabilities?.image_spool === true;
        heicImages = imageSpool && ev.capabilities?.heic_images === true;
        pipReferencesSupported = ev.capabilities?.pip_references === 1;
        pipsOffered = ev.capabilities?.pips_supported === true && ev.capabilities?.pips_enabled === true
          && Number(ev.capabilities?.pips_api_version) >= 41;
        clearPipPicker();
        mcpContextSupported = ev.capabilities?.mcp_context === true;
        mcpManagement = ev.capabilities?.mcp_management === true;
        if (ev.capabilities?.headless_skill_catalog) vscode.postMessage({ type: "requestSkills" });
        setThreadTitle(ev.session_name, ev.session_id, !ev.session_name);
        if (!draftScope && ev.session_id) selectDraftSession(ev.session_id);
        imagesOnReady(ev); retryOnReady(ev);
        railOffered = Number(ev.capabilities?.outline) >= 1;      // get_outline: every prompt, for the prompt rail
        serverWindow = null;           // the new backend says its own (server_window), if it offers it
        break;
      }
      case "cache_clock": onCacheClock(ev); break;
      case "server_window": onServerWindow(ev); break;
      case "context": {
        contextState = { ...contextState, ...ev };
        renderContext();
        agentMapChanged();                       // the map's root says how much is in context
        if (!$("ctxmenu").hidden) vscode.postMessage({ type: "contextBreakdown" });     // the parts, as the window changes
        break;
      }
      case "history":
        if (ev.complete === true) prepareCompleteHistory(ev.items || []);
        renderHistory(ev.items || []);
        railSnapshot(ev.items);
        if (Array.isArray(ev.todos)) renderTodos(ev.todos);
        if (!replaying) releaseHeldEvents(ev.complete === true ? ev.seq : -1);
        if (pipAsks.length) flushPipAsks();
        break;
      case "recall": renderHistory._absorbRecall?.(ev); railSeek(); break;
      case "outline": railOutlined(ev); break;
      case "rewound":
        if (ev.ok) {
          discardTurn(); log.innerHTML = ""; queuedCount = 0; renderQueued(); setSending(false);
          sessionResetHooks("rewound");
        }
        break;
      case "session":
        if (["cleared", "new", "resumed"].includes(ev.kind)) {
          discardTurn(); log.innerHTML = ""; queuedCount = 0; queuedPrompts.clear(); renderQueued(); setSending(false);
          sessionResetHooks(ev.kind);
          // The reconnect after a backend exit resumes this chat, and resuming clears the transcript
          // for the replay. The line saying why the backend stopped is not in the saved history, so
          // it would go too and leave the turn reading only "Stopped" or "Failed". Put it back.
          const notice = backendExitNotice;
          backendExitNotice = null;
          if (notice && ev.kind === "resumed" && ev.session_id === notice.session) sysLine(notice.text, true);
          // So are the messages that backend never ran, handed back as not sent.
          if (reconnectPending && ev.kind === "resumed") putBackReturnedPrompts(ev.session_id);
          else returnedPrompts.length = 0;
        }
        // A fresh chat has no checklist. A resumed one gets its list from the `history`
        // snapshot that follows, so the row is left for that event to overwrite. Either way a
        // clear that was waiting belonged to the chat being left.
        // Troupes too: a resumed chat's running ones come back with the `troupes` snapshot the restore asks for.
        if (["cleared", "new", "resumed"].includes(ev.kind)) { settleTodoClear(); renderMonitors({ items: [], reset: true }); resetTroupes(); }
        if (ev.kind === "cleared" || ev.kind === "new") renderTodos([]);
        // A branch keeps the conversation on screen — that is the whole point of it.
        if (ev.kind === "forked") {
          sysLine(`Branched into a new chat${ev.name ? ` — ${ev.name}` : ""}. `
            + "The chat you came from keeps everything up to this point.");
        }
        setThreadTitle(ev.name, ev.session_id, ev.kind === "cleared" || ev.kind === "new");
        if (ev.session_id) selectDraftSession(ev.session_id);
        renderUnconfirmedDrafts();
        break;
      case "session_named": setThreadTitle(ev.name); break;
      case "config":
        reasoningControl = ev.provider_capabilities?.reasoning_control || "provider";
        lastConfig = ev;
        renderContext();                 // the window you chose, beside the one in use ("· this model's max")
        nativeSteering = liveSteering && !ev.subscription_engine;
        renderComposerControls();
        paintMonitorsRow();              // Wake on monitor events decides whether events are "waiting"
        curUltra = ev.ultra_mode === true;
        curWorkers = Math.max(1, Math.min(32, Number(ev.max_parallel_tasks || 4)));
        updateModelControl();
        document.body.classList.toggle("hide-reasoning", ev.show_reasoning === false);
        break;
      case "think_changed": {
        const level = String(ev.think || "off");
        if (lastConfig) {
          if (lastConfig.subscription_engine) {
            lastConfig.subscription_effort = level === "off" ? "" : level;
          } else {
            lastConfig.think = level;
          }
        }
        break;
      }
      case "turn_start":
        if (!replaying) { removeRecoveryCards(); liveTurnHint = null; agentsTurnBegin(); }
        startTurn(ev.prompt, ev.kind, ev.turn_id,
          replaying || ["resume", "continue", "monitor"].includes(ev.kind) ? null : claimQueuedPrompt(ev.request_id),
          typeof ev.request_id === "string" ? ev.request_id : "");
        if (!replaying) customCommandPending = "";
        if (!replaying) returnedPrompts.length = 0;   // given back before this turn: ordinary transcript now
        // The next message moves on from a troupe that has ended; its own wake-up turn (a monitor turn) does not.
        if (!replaying && (ev.kind || "prompt") === "prompt") dropFinishedTroupes();
        if (!replaying) {
          // A monitor turn was never queued by anyone, so it takes nothing off the queued count.
          setSending(true); if (queuedCount > 0 && ev.kind !== "monitor" && ev.kind !== "pip_setup") { queuedCount--; renderQueued(); }
          // A queued prompt leaves the queue when its own turn starts, matched by the request id the
          // backend carries on turn_start. Never by position: a queued custom slash command, a goal
          // cycle or a continuation has no id of the user's, and popping the head for one of those
          // silently discarded a message the user could otherwise restore after a backend exit.
          if (typeof ev.request_id === "string" && ev.request_id) queuedPrompts.delete(ev.request_id);
        }
        break;
      // What the turn is doing, stated by the backend rather than guessed here. A turn that is
      // between model rounds because a gate continued it now says so, instead of a static verb
      // that could not be wrong because it never changed.
      case "turn_activity": {
        if (!turn || (ev.turn_id && turn.id && ev.turn_id !== turn.id)) break;
        const label = String(ev.label || "").slice(0, 80);
        const detail = String(ev.detail || "").slice(0, 120);
        const changed = !turn.activity || turn.activity.state !== ev.state
          || turn.activity.label !== label || turn.activity.detail !== detail;
        turn.activity = { state: String(ev.state || ""), label, detail };
        if (changed) turn.phaseT0 = Date.now();      // the phase clock restarts with the phase
        renderTurnMeta();
        break;
      }
      case "turn_eta": if (turn && typeof ev.label === "string") { turn.eta = ev.label.slice(0, 80); renderTurnMeta(); } break;
      case "turn_files": onTurnFiles(ev); break;
      case "handoff_started":
        startTurn(); setSending(true); speak("DGC is generating a handoff");
        if (turn) { turn.handoff = true; renderTurnMeta(); }
        break;
      case "queued": queuedCount = ev.count; renderQueued(); break;
      case "prompt_accepted": {
        const pending = pendingPrompts.get(ev.request_id);
        if (ev.state === "steered") {
          if (pending) pending.acknowledged = true;
          if (pending?.node) {
            pending.node.querySelector(".role").textContent = "you · steering pending";
            setSteerState(pending.node, "pending");
          }
        } else {
          if (ev.state === "queued" && pending?.node) {
            pending.node.querySelector(".role").textContent = "you · queued";
            setSteerState(pending.node, "queued");
          }
          if (ev.state === "queued" && pending) queuedPrompts.set(ev.request_id, pending);
          pendingPrompts.delete(ev.request_id);
        }
        if (ev.message) sysLine(ev.message);
        persistDraft(); break;
      }
      case "steering_update": {
        const pending = pendingPrompts.get(ev.request_id);
        if (ev.state === "returned") {
          rejectPrompt(ev.request_id);
          if (ev.message) sysLine(ev.message);
        } else {
          if (pending?.node) {
            pending.node.querySelector(".role").textContent = ev.state === "applied" ? "you · steering" : "you · queued";
            // .role is screen-reader-only, so the relabel above is invisible. The agent stops
            // printing its own "steering:" line for a frontend that reports which messages
            // landed (agent.py, _drain_steer), which left a sighted user with no sign at all
            // that the model had picked the message up.
            setSteerState(pending.node, ev.state === "applied" ? "applied" : "queued");
            if (ev.state === "applied" && !pending.node.querySelector(":scope > .msg-time")) {
              stampPrompt(pending.node, pending.sentAt || Date.now());   // a queued message steered in later
            }
            if (ev.state === "applied" && turn) placeSteering(pending.node);
          }
          // Unconsumed steering is spliced back in at the HEAD of the backend's queue.
          if (ev.state === "queued" && pending) {
            const rest = [...queuedPrompts]; queuedPrompts.clear();
            queuedPrompts.set(ev.request_id, pending);
            for (const [key, value] of rest) queuedPrompts.set(key, value);
          }
          pendingPrompts.delete(ev.request_id); persistDraft();
        }
        break;
      }
      case "text_delta": ensureTurn(); finishReasoning(); releaseToolGroup(); turn.chars += ev.text.length; appendText(ev.text); break;
      // A background sub-agent's own work arrives after the turn that started it has ended. It is on
      // the agent's page, never in the chat: it must not open a turn, scroll, or raise "New". (The
      // returns below skip the follow tail at the end of this switch on purpose.)
      case "thinking_delta":
        if (!turn && (ev.agent || agentIdFromCall(ev.call_id))) return;
        ensureTurn(); turn.chars += String(ev.text || "").length;
        reasoningDelta(ev); break;
      case "thinking_end":
        if (!turn && ev.agent) return;
        ensureTurn(); reasoningEnd(ev); break;
      // The block that just closed, named and classified by the backend. `phase` absent means
      // undetermined (a cancelled or errored round genuinely does not know), and then nothing is
      // claimed here: `turn_end` still designates the answer.
      case "stream_end": {
        finishReasoning();
        const closed = turn?.textEl;
        if (closed && ev.message_id) closed.dataset.messageId = String(ev.message_id);
        // Rendered first, then marked: the last render replaces the block's contents, which took the
        // copy button with it when it was added before (it came back only when the turn ended), and
        // whether a message is a detailed one is read off its rendered shape.
        breakText();
        if (closed && ev.phase === "commentary") markCommentary(closed);
        break;
      }
      case "tool_call": {
        pipFixStepFrom(ev);
        const childId = agentIdFromCall(ev.call_id);
        if (childId && !turn) {
          finishReasoning();
          const store = childToolBucket(childId);
          const same = ev.call_id ? store[ev.call_id] : null;
          if (same && same.isConnected && same.dataset.status === "running" && same.dataset.toolName === String(ev.name || "")) {
            same.querySelector(".dot")?.classList.add("run");
            if (!replaying) startToolClock(same);
          } else {
            const card = toolCard(ev);
            store[ev.call_id || ev.name] = card;
            placeChildTool(childId, card);
            agentsOnToolCard(card, ev);
          }
          return;
        }
        // A sub-agent's step lives on its agent's line, not in the chat: it must not end the parent's
        // thought, or one long thought streams as a new "Thought" row after every hidden child step.
        ensureTurn(); if (!childId) finishReasoning();
        turn._tools = turn._tools || Object.create(null);
        // One step, one row. A turn adopted from a reload snapshot can already hold this step, still
        // running, when its live tool_call arrives; a finished row whose id comes back is a new call.
        const same = ev.call_id ? turn._tools[ev.call_id] : null;
        if (same && same.isConnected && same.dataset.status === "running" && same.dataset.toolName === String(ev.name || "")) {
          same.querySelector(".dot")?.classList.add("run");
          if (!replaying) startToolClock(same);
        } else {
          turn._tools[ev.call_id || ev.name] = toolCard(ev);
          // A tool call's arguments are output the model wrote, like its prose and reasoning. A turn
          // made only of tool calls (a model that works without narrating) read "↓ 0 tok" for its
          // whole run; its arguments count once, when the call first appears.
          turn.chars += toolArgChars(ev.args);
        }
        // A background child's step can outlive this turn: file it where its later progress and
        // result look for it, or they land on a second card with no command.
        if (childId && ev.call_id) childToolBucket(childId)[ev.call_id] = turn._tools[ev.call_id];
        // Remember the path an edit tool was called with, so a result that carries no diff
        // (a brand-new file, a binary write) still reaches the end-of-turn summary.
        turn._paths = turn._paths || Object.create(null);
        const target = ev.args && (ev.args.path || ev.args.file_path || ev.args.file);
        if (EDIT_TOOLS.has(String(ev.name || "")) && target) turn._paths[ev.call_id || ev.name] = String(target);
        break;
      }
      case "tool_progress": {
        const childId = agentIdFromCall(ev.call_id);
        if (childId && !turn) {
          // A background child's step that outlived its turn still reports progress.
          const c = ev.call_id ? childToolBucket(childId)[ev.call_id] : null;
          if (c && c.dataset.status === "running") showToolProgress(c, ev);
          return;
        }
        ensureTurn();
        turn._tools = turn._tools || Object.create(null);
        const key = ev.call_id || ev.name;
        showToolProgress(turn._tools[key] || (turn._tools[key] = toolCard({ name: ev.name })), ev);
        break;
      }
      // Images a step produced go inside that step's card (see the 0.40 images section).
      case "tool_images": imagesOnToolImages(ev); break;
      case "image": imagesOnAnswer(ev); break;     // a getImage answer (the host answers for a backend without one)
      case "tool_result": {
        const childId = agentIdFromCall(ev.call_id);
        if (childId && !turn) {
          const store = childToolBucket(childId);
          const key = ev.call_id || ev.name;
          const c = store[key] || (store[key] = toolCard({ name: ev.name, call_id: ev.call_id }));
          if (!c.isConnected) placeChildTool(childId, c);
          const blocked = ev.is_error && String(ev.output || "").startsWith("error: repeated tool call blocked");
          setToolStatus(c, blocked ? "blocked" : (ev.is_error ? "failed" : "completed"));
          if (ev.is_diff && ev.diff) {
            c.classList.add("no-body");
            const rendered = renderDiff(ev.diff); c.after(rendered);
            // The card's own owner: a nested child's edit belongs on that child's page.
            rendered.dataset.agentId = c.dataset.agentId || childId; rendered.classList.add("agent-owned");
          } else setToolOutput(c, String(ev.output || "").slice(0, 4000));
          // A nested delegation's result is that child's integration outcome, on its page.
          if (agentPageId && c.dataset.toolName === "task" && c.dataset.agentId === agentPageId) paintAgentPage(agentPageId);
          return;
        }
        ensureTurn();
        if (!ev.is_error && EDIT_TOOLS.has(String(ev.name || "")) && !ev.is_diff) {
          recordEdit(turn._paths?.[ev.call_id || ev.name], 0, 0, false);
        }
        turn._tools = turn._tools || Object.create(null);
        const key = ev.call_id || ev.name;
        // A step whose result the reload snapshot already showed is not finished a second time
        // (a diff drawn twice, its lines counted twice).
        if (!replaying && ev.call_id && turn._tools[key]?._resultFromSnapshot) break;
        const c = turn._tools[key] || (turn._tools[key] = toolCard({ name: ev.name }));
        if (replaying && ev.call_id) c._resultFromSnapshot = true;
        c.querySelector(".dot").className = "dot " + (ev.is_error ? "err" : "ok");
        if (askedResultShown(c, ev)) { breakText(); break; }   // the answered questions are the body
        // (status is refined just below; a blocked repeat is not an error of the command)
        // A repeat the loop guard refused never ran, so reporting it as a failed command sends
        // the user hunting for a problem in their code. Keep it an error for the model; say what
        // actually happened here. The prefix is agent.LOOP_GUARD_PREFIX; a test pins them together.
        const blocked = ev.is_error
          && String(ev.output || "").startsWith("error: repeated tool call blocked");
        setToolStatus(c, blocked ? "blocked" : (ev.is_error ? "failed" : "completed"));
        if (ev.is_diff && ev.diff) {
          c.classList.add("no-body");           // the diff below is this step's detail
          const rendered = renderDiff(ev.diff); c.after(rendered);
          if (c.dataset.agentId) {
            rendered.dataset.agentId = c.dataset.agentId;
            rendered.classList.add("agent-owned");
          }
          if (!ev.is_error && isEditTool(ev.name || c.dataset.toolName))
            recordEdit(rendered.dataset.path, rendered.dataset.add, rendered.dataset.del,
                       rendered.dataset.add !== undefined || rendered.dataset.del !== undefined);
        }
        else {
          const out = setToolOutput(c, String(ev.output || "").slice(0, 4000));
          c.querySelector(".badge").textContent = out.split("\n").length + " ln";
          setupCards()?.toolResult(c, ev);
          if (c.classList.contains("pip-run-owned")) refreshToolGroup(c.closest(".tool-group"));
        }
        // The open page of the agent this delegation started: its outcome note reads this result,
        // which arrives after the agent's own end.
        if (agentPageId && c.dataset.toolName === "task" && c.dataset.agentId === agentPageId) paintAgentPage(agentPageId);
        breakText(); break;
      }
      case "tool_denied": {
        ensureTurn();
        turn._tools = turn._tools || Object.create(null);
        const key = ev.call_id || ev.name;
        const c = turn._tools[key] || (turn._tools[key] = toolCard({ ...ev,
          summary: ev.args?.path || ev.args?.command || ev.reason }));
        c.querySelector(".dot").className = "dot deny";
        setToolStatus(c, "denied");
        setToolOutput(c, String(ev.reason || "Permission denied"));
        break;
      }
      case "permission_decision": {
        ensureTurn();
        const detail = ev.args?.command ? `<pre>$ ${esc(ev.args.command)}</pre>`
          : Object.keys(ev.args || {}).length ? `<pre>${esc(JSON.stringify(ev.args))}</pre>` : "";
        const c = decisionCard(`<div class="q">${icon("shield")}<span>Permission for <b>${esc(ev.name)}</b></span></div>${detail}`, "Recorded permission decision");
        c.dataset.historyApproval = "true";
        // No request id, response handler or editable controls: replay is display only.
        resolveCard(c, String(ev.message || "Recorded decision"));
        compactPermissionCard(c, ev.name);
        break;
      }
      case "permission_request": {
        if (requestShown(ev.id)) break;     // announced again after a history snapshot
        const fixAsk = pipFixAskHome(ev.call_id);     // a background fix's: asked on its card
        if (!fixAsk) ensureTurn();
        if (!replaying) {
          imageViewerAttention("permission_request");
          speak(`Permission required to run ${ev.name}`);
        }
        // v7: the step's summary and, for an edit, the diff it would apply — approve against
        // what will happen, not raw JSON. A denial can carry a note for the model.
        // The user's own Chrome, signed in as them: say so, and name the site, not the tool's arguments.
        const signedIn = ev.name === "browser" && ev.args && ev.args.signed_in === true;
        const site = signedIn ? (() => { try { return new URL(String(ev.args.url || "")).host; } catch { return ""; } })() : "";
        const detail = signedIn ? `<p>DGC wants to open <b>${esc(site || "a site")}</b> in a window of its own in your Chrome, where you're signed in. It can read and act on that site as you.</p><pre>${esc(String(ev.args.url || ""))}</pre>`
          : ev.command ? `<pre>$ ${esc(ev.command)}</pre>`
          : ev.diff ? "" : (pipPermissionDetail(ev.name, ev.args) || `<pre>${esc(JSON.stringify(ev.args))}</pre>`);
        const restates = ev.summary && detail.includes(esc(String(ev.summary)));
        const summary = ev.summary && !restates ? `<div class="muted">${esc(ev.summary)}</div>` : "";
        // In a fix: installing the project's dependencies in the fix copy, or copying an ignored file into it.
        const fixInstall = fixAsk && ev.name === "bash" && /:install-\d+$/.test(String(ev.call_id || ""));
        const fixFile = fixAsk && ev.name === "request_project_file";
        const fixQuestion = fixInstall ? "Install the project's dependencies in the fix copy?"
          : fixFile ? `Copy <b>${esc(String(ev.args?.path || "a file"))}</b> from your project into the fix copy?` : "";
        const fixDetail = fixFile ? `<p>${esc(String(ev.args?.why || "A test needs it."))}</p><p class="muted">It is copied, never linked, and later fixes of this project get it too.</p>` : "";
        const title = fixQuestion || (ev.name === "pips_setup" ? "Set up a Pip" : ev.name === "pips_propose" ? "Change a Pip" : ev.name === "pips_settings" ? "Change the Pips default model" : ev.name === "troupe" ? (ev.args && ev.args.routine ? "Schedule a troupe?" : "Start a troupe?") : signedIn ? `Use your signed-in Chrome on <b>${esc(site || "this site")}</b>?` : `Run <b>${esc(ev.name)}</b>`);
        const buttons = fixFile
          ? `<button type="button" class="act primary" data-d="once">Copy it</button><button type="button" class="act" data-d="deny">Not now</button>`
          : `<button type="button" class="act primary" data-d="once">Allow once</button><button type="button" class="act" data-d="always">${signedIn ? `Always allow ${esc(site || "this site")}` : "Always allow"}</button><button type="button" class="act" data-d="deny">Deny</button>`;
        const inner = `<div class="q">${icon("shield")}<span>${title}</span></div>${signedIn || fixFile ? "" : summary}${fixFile ? fixDetail : detail}${fixFile ? "" : `<textarea class="feedback deny-note" rows="1" placeholder="If you deny: a note for the model (optional)"></textarea>`}<div class="btns">${buttons}</div>`;
        // On the fix's card it is built there: drawn into a running turn first, it would break that turn's prose.
        const c = requestCard(fixAsk ? fixAskCard(fixAsk, inner) : decisionCard(inner, "Tool permission request"), ev.id);
        if (ev.diff) { c.querySelector(".feedback").before(renderDiff(String(ev.diff))); }
        c.querySelectorAll("button").forEach((b) => b.onclick = () => {
          const note = (c.querySelector(".feedback")?.value || "").trim().slice(0, 2000);
          if (!resolveCard(c, permissionDecision(b.dataset.d, ev.suggested_rule, note))) return;
          compactPermissionCard(c, ev.name);
          vscode.postMessage({ type: "permission_response", id: ev.id, decision: b.dataset.d,
            rule: b.dataset.d === "always" ? ev.suggested_rule : undefined,
            reason: b.dataset.d === "deny" && note ? note : undefined });
        });
        break;
      }
      case "plan_proposal": {
        if (requestShown(ev.id)) break;
        ensureTurn();
        imageViewerAttention("plan_proposal");
        speak("Plan ready for review");
        const c = requestCard(decisionCard(`<div class="q">${icon("clipboard-list")} Plan ready</div><pre>${esc(ev.plan)}</pre><textarea class="feedback" rows="2" aria-label="Plan feedback" placeholder="Optional feedback (required changes, constraints, priorities)…"></textarea><div class="btns"><button type="button" class="act primary" data-d="acceptEdits">Approve → acceptEdits</button><button type="button" class="act" data-d="auto">auto</button><button type="button" class="act" data-d="default">default</button><button type="button" class="act" data-d="reject">Keep planning</button></div>`, "Plan approval"), ev.id);
        c.querySelectorAll("button").forEach((b) => b.onclick = () => {
          const feedback = c.querySelector(".feedback").value.trim();
          if (!resolveCard(c, planDecision(b.dataset.d, feedback))) return;
          vscode.postMessage({ type: "plan_response", id: ev.id, decision: b.dataset.d, feedback });
        });
        break;
      }
      case "options_request": {
        if (ask && !ask.retired && String(ask.ev.id) === String(ev.id)) break;   // already docked
        ensureTurn();
        imageViewerAttention("options_request");
        showAskCard(ev);
        break;
      }
      case "ask_request": {
        ensureTurn();
        renderOpenAsk(ev);
        break;
      }
      case "ask_resolved": {
        settleOpenAsk(ev);
        break;
      }
      case "options_resolved": {
        ensureTurn();
        renderAsked(ev);
        break;
      }
      case "mcp_input_request": {
        closeSurface();
        ensureTurn();
        imageViewerAttention("mcp_input_request");
        const p = ev.payload || {};
        const title = `MCP server ${ev.server} requests input`;
        speak(title);
        if (ev.kind === "sampling_request" || ev.kind === "sampling_response") {
          const question = ev.kind === "sampling_request"
            ? "Allow this server to ask your model?"
            : "Share this generated response with the server?";
          const c = decisionCard(`<div class="q">${icon("shield")} ${esc(question)}</div><div class="muted">Requested by ${esc(ev.server)}</div><pre>${esc(JSON.stringify(p, null, 2).slice(0, 12000))}</pre><div class="btns"><button type="button" class="act primary" data-a="accept">Approve once</button><button type="button" class="act" data-a="decline">Decline</button><button type="button" class="act" data-a="cancel">Cancel</button></div>`, title);
          requestCard(c, ev.id);
          c.querySelectorAll("button").forEach((b) => b.onclick = () => {
            if (!resolveCard(c, MCP_DECISIONS[b.dataset.a])) return;
            vscode.postMessage({ type: "mcp_input_response", id: ev.id, action: b.dataset.a });
          });
          break;
        }
        if (ev.kind !== "elicitation") break;
        if (p.mode === "url") {
          const warning = p.suspicious_host
            ? `<div class="err">Punycode host — inspect carefully for lookalike characters.</div>` : "";
          const c = decisionCard(`<div class="q">${icon("external-link")} Open a URL outside DGC?</div><div class="muted">Requested by ${esc(ev.server)}</div><p>${esc(p.message || "")}</p><div><b>Host:</b> ${esc(p.host || "")}</div><pre>${esc(p.url || "")}</pre>${warning}<div class="btns"><button type="button" class="act primary" data-a="accept">Open in secure browser</button><button type="button" class="act" data-a="decline">Decline</button><button type="button" class="act" data-a="cancel">Cancel</button></div>`, title);
          requestCard(c, ev.id);
          c.querySelectorAll("button").forEach((b) => b.onclick = () => {
            if (!resolveCard(c, MCP_DECISIONS[b.dataset.a])) return;
            vscode.postMessage({ type: "mcp_input_response", id: ev.id, action: b.dataset.a });
          });
          break;
        }
        const schema = p.requestedSchema || {}, fields = Object.entries(schema.properties || {});
        const required = new Set(schema.required || []);
        const optionsFor = (f) => f.oneOf?.map((o) => ({ value: o.const, title: o.title }))
          || f.enum?.map((v, i) => ({ value: v, title: f.enumNames?.[i] || v }))
          || f.items?.anyOf?.map((o) => ({ value: o.const, title: o.title }))
          || f.items?.enum?.map((v) => ({ value: v, title: v })) || [];
        const controls = fields.map(([key, f], i) => {
          const id = `mcp-field-${ev.id}-${i}`, label = f.title || key;
          const req = required.has(key) ? " required" : "";
          const desc = f.description ? `<div class="muted">${esc(f.description)}</div>` : "";
          const opts = optionsFor(f);
          let control;
          if (f.type === "array") {
            control = `<select id="${esc(id)}" data-mcp-field="${i}" multiple${req}>${opts.map((o) => `<option value="${esc(o.value)}"${(f.default || []).includes(o.value) ? " selected" : ""}>${esc(o.title)}</option>`).join("")}</select>`;
          } else if (opts.length) {
            control = `<select id="${esc(id)}" data-mcp-field="${i}"${req}>${required.has(key) ? "" : '<option value="">Skip</option>'}${opts.map((o) => `<option value="${esc(o.value)}"${f.default === o.value ? " selected" : ""}>${esc(o.title)}</option>`).join("")}</select>`;
          } else if (f.type === "boolean") {
            const skip = required.has(key) ? "" : '<option value="">Skip</option>';
            const yes = `<option value="true"${f.default === true ? " selected" : ""}>Yes</option>`;
            const no = `<option value="false"${f.default === false ? " selected" : ""}>No</option>`;
            control = `<select id="${esc(id)}" data-mcp-field="${i}"${req}>${skip}${yes}${no}</select>`;
          } else {
            const inputType = f.type === "integer" || f.type === "number" ? "number"
              : ({ email: "email", uri: "url", date: "date", "date-time": "datetime-local" }[f.format] || "text");
            const step = f.type === "integer" ? ' step="1"' : f.type === "number" ? ' step="any"' : "";
            const min = f.minimum !== undefined ? ` min="${Number(f.minimum)}"` : "";
            const max = f.maximum !== undefined ? ` max="${Number(f.maximum)}"` : "";
            const minLen = f.minLength !== undefined ? ` minlength="${Number(f.minLength)}"` : "";
            const maxLen = f.maxLength !== undefined ? ` maxlength="${Number(f.maxLength)}"` : "";
            control = `<input id="${esc(id)}" data-mcp-field="${i}" type="${inputType}" value="${esc(f.default ?? "")}"${step}${min}${max}${minLen}${maxLen}${req}>`;
          }
          return `<div class="mcp-field"><label for="${esc(id)}">${esc(label)}${required.has(key) ? " *" : ""}</label>${desc}${control}</div>`;
        }).join("");
        const c = decisionCard(`<div class="q">${icon("square-pen")} Information requested by ${esc(ev.server)}</div><p>${esc(p.message || "")}</p><form class="mcp-form">${controls}<div class="muted">Review and edit every value before submitting. Never enter passwords, API keys, access tokens, or payment credentials here.</div><div class="btns"><button type="submit" class="act primary">Submit</button><button type="button" class="act" data-a="decline">Decline</button><button type="button" class="act" data-a="cancel">Cancel</button></div></form>`, title);
        requestCard(c, ev.id);
        const form = c.querySelector("form");
        form.onsubmit = (e) => {
          e.preventDefault();
          fields.forEach(([, f], i) => {
            if (f.type !== "array") return;
            const control = form.querySelector(`[data-mcp-field="${i}"]`);
            const count = control.selectedOptions.length;
            const min = Number.isInteger(f.minItems) ? f.minItems : 0;
            const max = Number.isInteger(f.maxItems) ? f.maxItems : optionsFor(f).length;
            control.setCustomValidity(count < min || count > max
              ? `Choose between ${min} and ${max} values.` : "");
          });
          if (!form.reportValidity()) return;
          const content = Object.create(null);
          fields.forEach(([key, f], i) => {
            const control = form.querySelector(`[data-mcp-field="${i}"]`);
            if (f.type === "array") {
              const selected = [...control.selectedOptions].map((o) => o.value);
              if (selected.length || required.has(key)) content[key] = selected;
            }
            else if (f.type === "boolean") {
              if (control.value !== "" || required.has(key)) content[key] = control.value === "true";
            }
            else if (control.value !== "" || required.has(key)) content[key] =
              f.type === "integer" ? Number.parseInt(control.value, 10)
              : f.type === "number" ? Number(control.value) : control.value;
          });
          if (!resolveCard(c, "Submitted")) return;
          vscode.postMessage({ type: "mcp_input_response", id: ev.id, action: "accept", content });
        };
        c.querySelectorAll("button[data-a]").forEach((b) => b.onclick = () => {
          if (!resolveCard(c, MCP_DECISIONS[b.dataset.a])) return;
          vscode.postMessage({ type: "mcp_input_response", id: ev.id, action: b.dataset.a });
        });
        break;
      }
      case "todos":
        renderTodos(ev.todos);
        return;   // the transcript did not change: no follow scroll, no "New" on the pill
      case "pip_fix":
        applyPipFix(ev.fix);
        return;
      case "pip_fixes":
        for (const fix of (Array.isArray(ev.items) ? ev.items : []).slice().reverse()) applyPipFix(fix, { quiet: true });
        syncComposerRail();
        return;
      case "pip_runs_running":
        // Which of this chat's Pips are running now: the chip above the box. Never in the transcript.
        if (pipRunsLive) setPipRunning(ev.items);
        return;
      case "pip_report":
        // A Pip that reports to this chat finished: a card in the transcript, never a turn. A turn
        // running now carries on in its own block above it.
        renderPipReport(ev.report);
        break;
      case "agent_report":
        // A finished background agent's report: its line, folded (ready.capabilities.agent_reports).
        paintAgentReport(ev);
        break;
      case "monitor_event": {
        amNoteMonitorLines(ev);
        ensureTurn();
        appendTurnContent(monitorEventCard(ev)); breakText();
        if (ev.delivery === "wake" && turn.wake) paintWakeNote(turn.wake, ev);
        break;
      }
      case "monitor_started":
        knownMonitorIds.add(String(ev.id || ""));
        // A monitor the reopened chat brought back already has its line (monitor_restart, just before).
        if (restartedMonitorIds.delete(String(ev.id || ""))) break;
        sysLine(`Monitor ${ev.id} started · ${String(ev.description || "")}`);
        break;
      case "monitor_restart":
        monitorRestartLine(ev, true);
        break;
      case "task_interrupted":
        taskInterruptedLine(ev, true);
        break;
      case "monitor_ended":
        if (!knownMonitorIds.has(String(ev.id || ""))) break;   // a monitor of a chat that was left
        sysLine(`Monitor ${ev.id} · ${String(ev.message || ev.reason || "ended")}`, ev.reason === "flood" || ev.reason === "error");
        break;
      case "monitors":
        renderMonitors(ev);
        renderAgents();                          // its running monitors are background tasks on the pill and the map
        break;
      // The agent map's background shells and the output of the task whose card is open. Neither
      // changes the transcript.
      case "background_shells":
        amShells(ev);
        return;
      case "background_output":
        amOutputAnswer(ev);
        return;
      // An agent's line changes in place: a reader following the end stays pinned to it, and one
      // who scrolled back is neither moved nor told there is something "New". Only a top-level
      // agent starting in the live turn is new content at the bottom, with the usual tail.
      case "agent_started":
        applyAgentEvent(ev);
        if (turn && !ev.parent_id) break;
        if (stick || following) scroll();
        return;
      case "agent_updated": case "agent_ended":
        applyAgentEvent(ev);
        if (stick || following) scroll();
        return;
      case "agents":
        renderAgentsSnapshot(ev);
        for (const fix of pipFixes.values()) if (fix.agent_id) pipFixAgentChanged(fix.agent_id);
        if (stick || following) scroll();
        return;
      case "files_ready": {
        // A file the model made, as a chip under the step that made it. Codex's model exactly:
        // the event carries a PATH, and clicking asks the editor to open it -- no bytes cross the
        // protocol, so a 300 MB recording chips just as cheaply as a one-line report.
        const items = Array.isArray(ev.items) ? ev.items.filter((f) => f && f.rel) : [];
        if (!items.length) break;
        ensureTurn();
        const row = el("ul", "made-files");
        row.setAttribute("role", "list");
        row.setAttribute("aria-label", "Files produced");
        for (const item of items.slice(0, 8)) {
          const li = el("li");
          li.appendChild(producedFileChip(item));
          row.appendChild(li);
        }
        appendTurnContent(row); breakText();
        break;
      }
      case "agent_step": {
        // A parallel child's own page, live. The parent transcript still waits for the atomic
        // replay — interleaving several children there is what buffering exists to prevent — but
        // this page shows one agent, so it can have the step now. Without it the page sat empty
        // behind a running timer for as long as the child worked.
        // It never touches the chat, so it returns past the follow tail: a step of a background
        // agent whose turn has ended raised "New" for nothing a reader could see.
        const who = String(ev.agent_id || "");
        const step = ev.step && typeof ev.step === "object" ? ev.step : null;
        if (!who || !step) return;
        const record = agentRecords.get(who);
        if (!record) return;
        if (!Array.isArray(record.log)) record.log = [];
        if (record.log.length >= 400) return;                 // a page, not an archive
        record.log.push(step);
        // Repainting on every step is QUADRATIC: paintAgentPage clears and rebuilds the whole log,
        // so a child that makes hundreds of calls rebuilds a growing list hundreds of times. The
        // first cut of this ran the panel out of memory at 600 steps. Coalesce instead: one repaint
        // per frame, however many steps landed in it.
        if (agentPageId === who && !agentStepRepaint) {
          agentStepRepaint = setTimeout(() => {
            agentStepRepaint = 0;
            if (agentPageId === who) paintAgentPage(who);
          }, 60);
        }
        return;
      }
      case "troupe_started":
      case "troupe_progress":
      case "troupe_finished": {
        troupeEvent(ev, ev.type === "troupe_started");
        break;
      }
      case "troupes": {
        // Newest first on the wire; the row keeps them oldest first, the order live ones arrive in.
        (Array.isArray(ev.runs) ? ev.runs : []).slice(0, 20).reverse()
          .forEach((run) => { if (run && typeof run === "object") troupeEvent(run, run.state === "running"); });
        break;
      }
      case "artifact_ready": {
        amPreviewReady(ev);
        ensureTurn();
        const c = el("div", "artifact"); c.dataset.artifactId = String(ev.id || "");
        c.innerHTML = `<div class="ahead"><span class="aico" aria-hidden="true">${icon("app-window")}</span><span class="anm">Artifact ready</span><span class="alabel">${esc(ev.name)}</span></div><button type="button" class="aurl">${esc(ev.url)}</button>`;
        const row = el("div", "abtns");
        const open = el("button", "abtn primary", "Open in browser"); open.type = "button";
        open.onclick = () => vscode.postMessage({ type: "openExternal", url: ev.url });
        const stop = el("button", "abtn", "Stop"); stop.type = "button"; stop.dataset.artifactStop = "1";
        stop.onclick = () => requestArtifactStop(ev.id, c, stop);
        row.appendChild(open); row.appendChild(stop); c.appendChild(row);
        c.querySelector(".aurl").onclick = () => vscode.postMessage({ type: "openExternal", url: ev.url });
        appendTurnContent(c); breakText();
        break;
      }
      case "artifacts": {
        amPreviewList(ev);
        const items = ev.items || [];
        if (!items.length) {
          if (!String(ev.request_id || "").startsWith("artifact-stop-")) {
            sysLine("No artifact previews are running.");
          }
          break;
        }
        const c = decisionCard(`<div class="q">${icon("app-window")} Artifacts</div><div class="artifact-list"></div>`);
        const list = c.querySelector(".artifact-list");
        items.forEach((a) => {
          const row = el("div", "abtns artifact-list-row"); row.dataset.artifactId = String(a.id || "");
          const open = el("button", "abtn primary", `${a.name} · open`); open.type = "button";
          open.onclick = () => vscode.postMessage({ type: "openExternal", url: a.url });
          const stop = el("button", "abtn", "Stop"); stop.type = "button"; stop.dataset.artifactStop = "1";
          stop.onclick = () => requestArtifactStop(a.id, row, stop);
          row.appendChild(open); row.appendChild(stop); list.appendChild(row);
        });
        break;
      }
      case "saved_plan":
        if (ev.exists) decisionCard(`<div class="q">${icon("clipboard-list")} Saved plan</div><pre>${esc(ev.plan)}</pre>`);
        else sysLine("No saved plan yet — switch to plan mode and ask DGC to propose one.");
        break;
      case "plugin_catalog": cachePluginLogos(ev.items); break;
      case "skill_catalog": {
        skillRows = Array.isArray(ev.items) ? ev.items : [];
        if (surfaceKind === "skills") renderSkills(ev.items);
        if (popMode === "/" || popMode === "$") onInput();
        break;
      }
      case "skill_detail": if (surfaceKind === "skills") renderSkillDetail(ev); break;
      case "docs_catalog": if (surfaceKind === "docs") renderDocs(ev.items); break;
      case "doc": if (surfaceKind === "docs") renderDoc(ev); break;
      case "mcp_servers":
        mcpRows = Array.isArray(ev.items) ? ev.items : [];
        if (surfaceKind === "mcp" && mcpView === "servers") renderMcp();
        if (ev.error && surfaceKind === "mcp") {
          const warning = el("div", "err surface-notice", esc(ev.error));
          surfaceBody.insertBefore(warning, surfaceBody.firstChild);
        }
        break;
      case "mcp_tools":
        mcpTools = Array.isArray(ev.tools) ? ev.tools : [];
        if (surfaceKind === "mcp" && mcpView === "servers") renderMcp();
        break;
      case "mcp_context_catalog": renderMcpContextCatalog(ev); break;
      case "mcp_context": renderMcpContext(ev); break;
      case "mcp_command_result": {
        if (ev.request_id !== mcpContextPending) break;
        if (ev.context) renderMcpContext({ ...ev.context, request_id: ev.request_id });
        else if (ev.catalog) renderMcpContextCatalog({ ...ev.catalog, request_id: ev.request_id });
        else {
          mcpContextPending = ""; renderMcp();
          if (ev.error || ev.output) {
            const result = el("pre", ev.error ? "err" : "surface-meta");
            result.textContent = ev.error || ev.output;
            surfaceBody.prepend(result);
          }
        }
        break;
      }
      case "permissions": if (surfaceKind === "permissions") renderPermissions(ev.items); break;
      case "memory": if (surfaceKind === "memory") renderMemory(ev); break;
      case "hook_catalog": {
        if (surfaceKind === "hooks") renderHooks(ev);
        break;
      }
      case "hook_activity":
        if (ev.status !== "started") {
          sysLine(`Hook ${ev.event} ${ev.status} · ${ev.configured} configured · ${ev.duration_ms}ms${ev.message ? ` · ${ev.message}` : ""}`,
            ev.status !== "completed");
        }
        break;
      case "handoff": {
        ensureTurn();
        const markdown = String(ev.markdown || "");
        turn.chars += markdown.length;
        textBlock()._markdown = markdown; textBlock().innerHTML = md(markdown);
        enrichMarkdown(textBlock());
        if (ev.path) sysLine(`Handoff saved to ${ev.path}`);
        if (ev.status !== "completed") sysLine(String(ev.error || `Handoff ${ev.status}`), true);
        speak(ev.status === "completed" ? "Handoff ready" : `Handoff ${ev.status}`);
        endTurn(ev.status === "completed" ? "completed" : "error"); setSending(false);
        break;
      }
      case "memory_learned": memoryLearnedLine(ev); break;
      case "skill_draft": learnDraft(ev); break;
      case "skill_saved": learnSaved(ev); break;
      case "goal_changed": {
        const text = String(ev.goal || "");
        setGoalState({ ...ev.details, text, status: ev.status, elapsed_seconds: ev.elapsed_seconds });
        break;
      }
      case "status":
        sysLine(`${ev.model} · ${ev.mode} · thinking ${ev.think} · context ${ev.context_used}/${ev.context_size}`
          + (ev.ultra_mode ? " · Ultra" : "")
          + (ev.goal && ev.goal.text ? ` · goal ${ev.goal.status}` : ""));
        break;
      case "rule_added": sysLine("rule: " + ev.rule, false, "shield-plus"); break;
      case "info":
        // A sub-agent's spawn notices ("⟳ sub-task: …", "↳ isolated checkout: …", "↯ running N
        // isolated sub-tasks in parallel") are what its line in the transcript now says, and the
        // agent's page names an isolated checkout. They were never replayed either, so a reload
        // always drew the chat without them. A backend without agent frames still prints them.
        if (agentsLive && AGENT_SPAWN_NOTICE.test(String(ev.message || ""))) return;
        if (String(ev.message || "").startsWith("Switched to ")) {
          const line = el("div", "sys model-switch", esc(ev.message));
          appendConversationContent(line);
          break;
        }
        sysLine(ev.message); break;
      case "mode_changed": if (ev.message) sysLine(ev.message); break;
      case "permission_resolved":
        document.querySelectorAll(".card[data-request-id]").forEach((card) => {
          if (card.dataset.requestId === String(ev.id)) resolveCard(card, ev.message || (ev.decision === "once" ? "Allowed once" : "Denied"));
        });
        if (!replaying) sysLine(ev.message, ev.decision === "no"); break;
      case "prompt_pips": receivePromptPips(ev); break;
      case "command_rejected":
        // The agent map asked, and the map says what became of it (the output not available, a Stop
        // that did not take): a refusal of its polling must not fill the chat with lines.
        if (["get_background_output", "list_background_shells", "stop_background_shell"].includes(ev.command)
            || (ev.command === "agent_control" && String(ev.request_id || "").startsWith("agent-stop-"))) break;
        if (ev.command === "steer_queued") { steerQueuedRefused(); sysLine(ev.message || "That message stays queued for the next turn."); break; }
        if (ev.command === "start_pip_fix" || ev.command === "undo_pip_fix") { pipFixRefused(ev); break; }
        if (ev.command === "list_prompt_pips") {
          if (pipPicker.active && ev.request_id === pipPicker.id) { pipPicker.loading=false; pipPicker.error=String(ev.message || "Pip references are unavailable."); renderPipPicker(); }
          break;
        }
        // A refused Clear says why beside the checklist, not in the transcript.
        if (ev.command === "clear_todos") { settleTodoClear(ev.message || "DGC could not clear the checklist."); break; }
        // A refused answer re-enables its docked question with the reason, instead of a stuck "Sending…".
        if (ev.command === "options_response" && askRejected(ev)) break;
        if (ev.command === "prompt" || ev.command === "start_goal") rejectPrompt(ev.request_id);
        // An answer the backend would not take leaves its question OPEN on the agent's side, and
        // the card was disabled the moment Send was pressed with nothing to re-enable it: the
        // body keeps `pointer-events: none` and the folded button stays hidden, so the question
        // could never be answered again.
        if (ev.command === "prompt" && String(ev.request_id || "").startsWith("ask-")) {
          reopenOpenAsk(String(ev.request_id).slice(4), ev.message);
        }
        // A custom slash command that was refused (busy, queue full) never started a turn.
        if (ev.command === "slash_command") settleCustomCommand();
        sysLine(ev.message || "Command unavailable while a turn is running", true); break;
      case "request_expired":
        document.querySelectorAll(".card[data-request-id]").forEach((card) => {
          if (card.dataset.requestId === String(ev.id)) resolveCard(card, "Closed without a decision");
        });
        askExpired(ev);
        sysLine("Input request closed. No unanswered choice was selected."); break;
      case "compacted": {
        compacting = false; lastCompaction = ev;
        contextState = { ...contextState, used: ev.after_tokens, size: ev.context_size };
        renderContext();
        const before = fmtTokens(ev.before_tokens), after = fmtTokens(ev.after_tokens);
        const lead = ev.status === "unchanged" ? "Context unchanged"
          : ev.strategy === "tool_prune" ? "Context pruned"
            : ev.strategy === "provider_native" ? "Context compacted natively"
              : ev.strategy === "mechanical" ? "Context compacted safely on-device"
                : "Context compacted";
        sysLine(`${lead} · ${before} → ${after} estimated tokens`, false, "history");
        break;
      }
      case "error":
        if (!modelErrorRow(ev)) { speak(`DGC error: ${ev.message}`); sysLine(ev.message, true); }
        if (ev.fatal) { endTurn("error"); setSending(false); }
        // "unknown command: /foo" / "custom command /foo is empty": no turn is coming for it.
        else if (answersCustomCommand(ev.message)) settleCustomCommand();
        break;
      case "model_retry": onModelRetry(ev); break;
      case "turn_end":
        speak(ev.reason === "paused" ? "DGC goal paused" : ev.reason === "cancelled" ? "DGC generation stopped" : ev.reason === "error" ? "DGC response ended with an error" : "DGC response complete");
        endTurn(ev.reason, ev.final_message_id);
        if (!replaying) { setSending(false); liveTurnHint = null; agentsTurnEnd(); }
        break;
    }
    // A replayed page anchors its own scroll position and is not news: no jump to the bottom, and
    // no "New" pill for a turn that finished before the window was reopened.
    if (replaying) return;
    if (stick || following) scroll(); else noteNewContent();
  }

  // ---- composer ----
  function hasComposerInput() { return Boolean(composerText().trim() || attachments.length); }
  function renderComposerControls() {
    // A question docked in the composer replaces the text box, so nothing typed is a draft: Send is
    // Stop, and Queue and the follow-up hint have nothing to act on. The footer itself stays.
    const docked = askCardDocked();
    const hasDraft = hasComposerInput() && !docked, stop = streaming && !hasDraft;
    const label = composerLocked ? composerLockWords
      : stop ? "Stop generation" : streaming ? (nativeSteering ? "Steer current run" : "Queue next turn") : "Send message";
    // This runs on every keystroke. Replacing a node's children while typing closes Chromium's open
    // typing step, which made each Ctrl+Z take back one character, so write only what changed.
    const icon = stop ? "debug-stop" : "arrow-up";
    if (send._icon !== icon) {
      send.innerHTML = `<span class="codicon codicon-${icon}" aria-hidden="true"></span>`;
      send._icon = icon;
    }
    if (send.getAttribute("aria-label") !== label) { send.title = label; send.setAttribute("aria-label", label); }
    // Filled (DGC purple) only when the button will actually do something: text to send, or a
    // run to stop. Empty composer leaves it a quiet surface, so the accent stays meaningful.
    send.classList.toggle("ready", !composerLocked && (hasDraft || streaming));
    send.disabled = composerLocked;
    $("queue-send").hidden = composerLocked || !streaming || !nativeSteering || docked;
    $("queue-send").disabled = composerLocked || !hasDraft;
    // An agent page is read-only, but it must not trap a running turn: keep the dedicated Stop
    // control available even when the preserved draft is empty and the regular Send/Stop is locked.
    $("stop-run").hidden = !streaming || (!composerLocked && !hasDraft);
    $("followup-hint").hidden = composerLocked || !streaming || docked;
    const hint = nativeSteering ? "Enter to steer · Alt+Enter to queue" : "Follow-ups queue for the next turn";
    if ($("followup-hint").textContent !== hint) $("followup-hint").textContent = hint;
  }
  function settleCustomCommand() {
    if (!customCommandPending) return;
    customCommandPending = "";
    if (!turn) setSending(false);
  }
  // Only the backend's answer to the pending command settles it. `slash_command` errors carry no
  // request id, so match their two fixed texts for that command's name; any other error (a tool,
  // an MCP server, a setting) says nothing about whether the command's turn is on its way.
  function answersCustomCommand(message) {
    const name = customCommandPending;
    if (!name) return false;
    const text = String(message || "").toLowerCase();
    return text === `custom command /${name} is empty`
      || text === `unknown command: /${name}` || text.startsWith(`unknown command: /${name} `);
  }
  function setSending(on) {
    streaming = on; renderComposerControls(); viewerStreaming?.();
    document.querySelectorAll("[data-skill-mutation]").forEach(button => {
      button.disabled = on; button.title = on ? "Available after this turn finishes" : "";
    });
  }
  // The messages queued behind the run stay in the restore set: the backend answers a cancel by
  // handing each one back ("returned"), and that is what marks them not sent and restorable.
  function doStop() { queuedCount = 0; renderQueued(); vscode.postMessage({ type: "cancel" }); }
  $("goal-toggle").onclick = () => vscode.postMessage({
    type: goalState.status === "active" ? "pauseGoal" : "resumeGoal",
  });
  $("goal-clear").onclick = () => vscode.postMessage({ type: "clearGoal" });
  // Clear is never disabled: the backend empties the list even while a turn runs.
  $("tasks-clear").onclick = requestTodoClear;
  $("tasks-main").onclick = toggleTasks;
  $("tasks-toggle").onclick = toggleTasks;
  /** Remove Goal from this draft without changing an already-running standing goal. */
  function clearGoalDraft() {
    recordComposerEdit(() => setGoalDraftArmed(false));
    persistDraft();
    input.focus();
  }

  /** Goal is a one-message choice pinned in the composer footer while the draft owns it. */
  function renderGoalControl() {
    const button = $("btn-goal"), label = $("goal-control-label");
    if (!button) return;
    button.hidden = !goalDraftArmed;
    button.dataset.state = goalDraftArmed ? "draft" : "none";
    label.textContent = "Goal";
    button.title = goalDraftArmed ? "Goal applies to this prompt · Click to remove" : "";
    button.setAttribute("aria-label", goalDraftArmed ? "Goal applies to this prompt; remove Goal" : "");
  }

  function setGoalDraftArmed(armed) {
    goalDraftArmed = armed === true;
    renderGoalControl();
    renderComposerControls();
  }

  $("btn-goal").onclick = clearGoalDraft;
  // Clicking the bar expands it; the pencil edits. This keeps progress and lifecycle controls in
  // the standing-goal rail, separate from the one-message Goal choice in the composer.
  $("goal-main").onclick = toggleGoalDetail;
  $("goal-edit").onclick = openGoalEditor;
  $("goal-review-button").onclick = openGoalReview;
  $("goal-review-close").onclick = () => closeGoalReview();
  $("goal-review").addEventListener("click", event => { if (event.target === $("goal-review")) closeGoalReview(); });
  $("goal-review").addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); closeGoalReview(); } });
  for (const dialog of [$("goal-editor"), $("goal-review")]) {
    dialog.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      const nodes = [...dialog.querySelectorAll('button, input, textarea, summary, [tabindex="0"]')]
        .filter(node => !node.disabled && !node.closest("[hidden]"));
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
  }
  $("goal-editor-close").onclick = () => closeGoalEditor();
  $("goal-editor-cancel").onclick = () => closeGoalEditor();
  $("goal-editor-save").onclick = saveGoalEditor;
  $("goal-editor-text").addEventListener("input", () => {
    $("goal-editor-save").disabled = !$("goal-editor-text").value.trim();
  });
  $("goal-editor").addEventListener("click", (event) => {
    if (event.target === $("goal-editor")) closeGoalEditor();
  });
  $("workspace-changes").onclick = () => openChangesReview("workspace");
  $("changes-main").onclick = () => openChangesReview("chat");
  $("changes-review-button").onclick = () => openChangesReview("chat");
  $("changes-review-close").onclick = closeChangesReview;
  $("goal-editor").addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeGoalEditor(); }
    else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault(); saveGoalEditor();
    }
  });
  $("changes-review").addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeChangesReview(); }
  });
  function appendGoalPrompt(objective, attachments = []) {
    const m = el("div", "msg user goal-prompt");
    m.appendChild(el("div", "role", "goal"));
    const bubble = el("div", "bubble");
    fillUserBubble(bubble, objective.replace(/^--tokens\s+\d{1,13}\s+/, ""), attachments);
    m.appendChild(bubble);
    // Settled like every other prompt: pinned, skippable off screen, and its fold decided and
    // re-decided with the width. It was the one user bubble that never was.
    log.appendChild(m); settleBlock(m); setSending(true);
    return m;
  }
  function submitGoal(objective, restoreText = composerText()) {
    if (attachments.some(a => a.pipReference)) { sysLine("Pip references are supported in chat messages. Remove the reference before starting a standing goal.", true); persistDraft(); return; }
    if (!sessionReady || pendingImageFiles || pendingPrompts.size >= 17) {
      sysLine("Wait for DGC and pending attachments before starting the goal."); persistDraft(); return;
    }
    // A snapshot, not the live objects: `fromPill` means "a pill in the CURRENT composer governs
    // this selection", and the composer is about to be emptied. submit() used to hand pendingPrompts
    // the same objects, so restoring a rejected prompt pushed them back still flagged with no pill
    // standing for them, and reconcilePills withdrew every skill, template and @file from the very
    // message being given back.
    const selected = attachments.map(({ fromPill, ...rest }) => rest);
    const node = appendGoalPrompt(objective, selected);
    const requestId = `${promptPrefix}-${++promptSequence}`;
    node.dataset.promptId = requestId;     // which request this row is (echoPrompt finds it by this)
    pendingPrompts.set(requestId, { text: restoreText, attachments: selected, goal: true,
      node, session: draftSession });
    const values = key => selected.filter(item => item[key]).map(item => item[key]);
    vscode.postMessage({ type: "startGoal", text: objective, requestId,
      skills: values("skill"), templates: values("template"), context: values("resource"),
      images: selected.filter(item => item.img).map(item => item.data) });
    recordComposerEdit(() => { setGoalDraftArmed(false); clearComposer(); attachments.length = 0; });
    renderAtts(); persistDraft(); scroll();
  }
  function isSlashCommandText(text) {
    if (!text.startsWith("/")) return false;
    const name = text.slice(1).split(/\s+/, 1)[0] || "";
    return !name.includes("/");
  }

  // card-number:start -- the same check as src/pipCards.js (a test keeps them alike). Whatever is sent here goes to
  // the model, so a card number is warned about once; Enter again sends it as it is (a developer's test card).
  function cardNumberIn(text) {
    const luhn = (d) => { let t = 0, dbl = false; for (let i = d.length - 1; i >= 0; i--) { const n = Number(d[i]) * (dbl ? 2 : 1); t += n > 9 ? n - 9 : n; dbl = !dbl; } return t % 10 === 0; };
    const network = (d) => {
      const n = d.length, two = Number(d.slice(0, 2)), three = Number(d.slice(0, 3)), four = Number(d.slice(0, 4));
      return (d[0] === "4" && [13, 16, 19].includes(n)) || ((two >= 51 && two <= 55 || four >= 2221 && four <= 2720) && n === 16)
        || ([34, 37].includes(two) && n === 15) || (([36, 38, 39].includes(two) || three >= 300 && three <= 305) && n >= 14 && n <= 19)
        || ((four === 6011 || two === 65 || three >= 644 && three <= 649) && n >= 16 && n <= 19)
        || (([60, 81, 82].includes(two) || [353, 356, 508].includes(three)) && n === 16)
        || (four >= 3528 && four <= 3589 && n >= 16 && n <= 19) || ((two >= 56 && two <= 58 || [62, 63, 67].includes(two)) && n >= 16 && n <= 19);
    };
    for (const match of String(text || "").slice(0, 100000).matchAll(/\d+(?:[ -]\d+)*/g)) {
      const parts = match[0].split(/([ -])/), groups = parts.filter((_, i) => i % 2 === 0), seps = parts.filter((_, i) => i % 2 === 1);
      for (let start = 0; start < Math.min(groups.length, 64); start++) {
        let digits = ""; const used = new Set();
        for (let end = start; end < groups.length; end++) {
          if (end > start) used.add(seps[end - 1]);
          digits += groups[end];
          if (digits.length > 19 || used.size > 1) break;
          if (digits.length >= 13 && network(digits) && luhn(digits)) return digits;
        }
      }
    }
    return null;
  }
  // card-number:end
  let cardWarnedFor = null;

  function submit(delivery = nativeSteering ? "steer" : "queue") {
    if (composerLocked) return;
    // /agents opens the agent map, here in the panel: it needs no backend, so not even a reconnect waits.
    if (/^\/agents\s*$/i.test(composerText().trim()) && !attachments.length) {
      clearComposer(); persistDraft(); openAgentMap({ command: true }); return;
    }
    if (!sessionReady) { sysLine("DGC is reconnecting to this chat. Your draft is saved."); persistDraft(); return; }
    if (pendingImageFiles) { sysLine("Wait for the pasted images to finish loading before sending."); return; }
    // A folded paste is part of the message, not a side-channel: append it in chip order so the
    // model receives exactly what was pasted.
    const pastes = attachments.filter((a) => a.pasted);
    const typed = composerText().trim();
    const text = pastes.length
      ? [typed, ...pastes.map((a) => a.pasted)].filter(Boolean).join("\n\n")
      : typed;
    if (!text && !attachments.length) return;
    if (cardNumberIn(text) && cardWarnedFor !== text) {
      cardWarnedFor = text;
      sysLine("That looks like a payment card number. Whatever you send here goes to the model, so card numbers stay out of the chat. Remove it, or press Enter again to send it as it is.", true);
      persistDraft(); return;
    }
    cardWarnedFor = null;
    const references = attachments.filter(a => a.pipReference);
    if (references.length && (!pipReferencesSupported || !text || references.some(a => !validPipReference(a.pipReference)))) {
      sysLine(!pipReferencesSupported ? "Update or reconnect DGC to send Pip references. Your draft is saved." : !text ? "Write a message to send with the Pip reference." : "Remove and select the invalid Pip reference again.", true); persistDraft(); return;
    }
    if (pendingPrompts.size >= 17) { sysLine("Wait for the pending messages to be acknowledged before sending another.", true); return; }
    const imgs = attachments.filter((a) => a.img).map((a) => a.data);
    const resources = attachments.filter((a) => a.resource).map((a) => a.resource);
    const skills = attachments.filter((a) => a.skill).map((a) => a.skill);
    const templates = attachments.filter((a) => a.template).map((a) => a.template);
    if(references.length && (goalDraftArmed || /^\/goal(?:\s|$)/i.test(text)||/\s\/goal$/i.test(text))) {sysLine("Pip references are supported in chat messages. Remove the reference before using a goal command.",true);persistDraft();return;}
    const goalStateCommand = ["clear", "off", "none", "remove", "complete", "completed",
      "done", "blocked", "block", "pause", "paused", "resume", "active", "reactivate", "review", "status", "delete"];
    const goalManagement = value => goalStateCommand.includes(value.toLowerCase()) || /^budget(?:\s|$)/i.test(value);
    if (goalDraftArmed) {
      // Restoring a cancelled goal re-arms the composer. A freshly typed /goal
      // prefix is still command syntax, not part of its objective.
      const goalText = text.replace(/^\/goal(?:\s+|$)/i, "").trim();
      if (!goalText) {
        sysLine("Type an objective for this Goal.");
        return;
      }
      if (goalManagement(goalText)) {
        vscode.postMessage({ type: "slashText", text: `/goal ${goalText}` });
        setGoalDraftArmed(false); clearComposer(); persistDraft(); return;
      }
      submitGoal(goalText, text); return;
    }
    const goalPrefix = /^\/goal\s+([\s\S]+)$/i.exec(text)?.[1].trim();
    if (goalPrefix && !goalManagement(goalPrefix)) {
      submitGoal(goalPrefix, goalPrefix); return;
    }
    if (goalPrefix || text.toLowerCase() === "/goal") {
      vscode.postMessage({ type: "slashText", text });
      clearComposer(); persistDraft(); return;
    }
    const trailingGoal = /^([\s\S]*\S)\s+\/goal$/i.exec(text)?.[1].trim();
    if (trailingGoal) { submitGoal(trailingGoal, trailingGoal); return; }
    const workflowPrompt = (/^\/(plan|review|init)(?:\s|$)/i.test(text)
      || /\s+\/(plan|review|init)$/i.test(text)) && !(text.toLowerCase() === "/plan" && !attachments.length);
    if (isSlashCommandText(text) && !attachments.length && !workflowPrompt) {
      const name = (text.slice(1).split(/\s+/, 1)[0] || "").toLowerCase();
      // The terminals' `/todo clear` does what the Tasks row's Clear does, pending state and all.
      if (/^\/todo\s+clear$/i.test(text)) {
        requestTodoClear();
        clearComposer(); persistDraft(); return;
      }
      const custom = customCommands.includes(name);
      if (custom) {
          const m = el("div", "msg user"); m.appendChild(el("div", "role", "you"));
          m.appendChild(el("div", "bubble", esc(text)));
          log.appendChild(m); settleBlock(m);
          // Idle, this shows Stop until the command's turn starts. If the backend answers with an
          // error or a refusal instead, no turn is coming and the composer must come back.
          if (!streaming) customCommandPending = name;
          setSending(true);
      }
      vscode.postMessage({ type: "slashText", text });
      clearComposer(); persistDraft(); scroll(); return;
    }
    const m = el("div", "msg user"); m.appendChild(el("div", "role", "you"));
    const bubble = el("div", "bubble");
    fillUserBubble(bubble, typed, attachments);
    m.appendChild(bubble); log.appendChild(m); settleBlock(m);
    const requestId = `${promptPrefix}-${++promptSequence}`;
    m.dataset.promptId = requestId;        // which request this row is: its turn_start finds it by this
    // What a restore puts back: the typed words and the chips. The pastes are already chips, so
    // restoring `text` (which has them appended) as well would put every paste back twice.
    const sentAt = Date.now();
    pendingPrompts.set(requestId, { text: pastes.length ? typed : text,
      attachments: attachments.map(({ fromPill, ...rest }) => rest), node: m, session: draftSession, sentAt });
    // A message sent while a turn runs is folded into that turn, so no turn start ever stamps it: it gets its time
    // now, as every prompt does (the founder, 25 Oct: steered prompts had none).
    if (streaming && delivery === "steer") stampPrompt(m, sentAt);
    // The restore draft rides along for the extension, which keeps it while the message is queued (a
    // reload loses this webview's copy); an image's bytes are already in `images`, so they are left out.
    const restore = { text: pastes.length ? typed : text,
      attachments: attachments.map((a) => a.img ? { label: a.label, img: true, bytes: a.bytes } : a) };
    vscode.postMessage({ type: "prompt", text, requestId, images: imgs.length ? imgs : undefined, restore,
      delivery,
      ...(references.length ? {pip_references: references.map(a => ({pip_id:a.pipReference.pip_id,expected_version:a.pipReference.job_version,expected_lifecycle_revision:a.pipReference.lifecycle_revision}))} : {}),
      skills: skills.length ? skills : undefined, templates: templates.length ? templates : undefined,
      context: resources.length ? resources : undefined });
    // One step with the text, so undo right after sending brings back the whole prompt -- the
    // pills and the chips with the words.
    recordComposerEdit(() => { clearComposer(); attachments.length = 0; });
    renderAtts(); persistDraft(); setSending(true); scroll();
  }
  // An image's own file name, or "" when all it has is a placeholder: "Image" (an older draft's
  // label), or the "image.png" a browser gives a screenshot copied straight to the clipboard, which
  // would read the same on every chip. Those keep their type and size ("PNG · 1920×1080").
  function imageFileName(label) {
    const text = String(label || "").replace(/^📷\s*/, "").trim();
    return /^(image|iphone photo|image\.(png|jpe?g|gif|webp|bmp|heic|heif))$/i.test(text) ? "" : text;
  }
  // An attached image is shown, not named: the same tile the sent prompt carries, so you can see
  // what you are about to send (and that it is the right screenshot) before you send it.
  function imageAttachmentChip(a, remove) {
    const chip = el("span", "chip image-att-chip");
    const tile = el("span", "image-tile");
    const caption = el("span", "image-caption");
    const kind = (String(a.data || "").match(/^data:image\/([a-z]+)/i) || [])[1];
    const name = kind ? kind.toUpperCase() : "Image";
    const file = imageFileName(a.label);
    const size = imageSize(a.bytes);
    caption.textContent = file || name;
    chip.title = [file, a.heic ? "iPhone photo, sent as a JPEG" : name, size].filter(Boolean).join(" · ");
    if (a.data && !a.heic) {
      const img = el("img"); img.alt = ""; img.decoding = "async"; img.src = a.data;
      img.addEventListener("load", () => {
        // The caption is the file's name, cut to fit; type, size and dimensions are the hover label.
        const dims = img.naturalWidth ? `${img.naturalWidth}×${img.naturalHeight}` : "";
        caption.textContent = file || [name, dims].filter(Boolean).join(" · ");
        chip.title = [file, name, dims, size].filter(Boolean).join(" · ");
      });
      tile.appendChild(img);
    } else {
      // A restored draft keeps the attachment but not its bytes: name it instead of showing it.
      tile.appendChild(el("span", "codicon codicon-file-media"));
      tile.lastChild.setAttribute("aria-hidden", "true");
    }
    chip.append(tile, caption, remove);
    return chip;
  }
  // A selection that is ALREADY visible as a pill in the composer does not need a second chip
  // underneath. The condition is the pill's existence, not the kind: a skill restored from a draft,
  // or added from the + menu, has no pill, and hiding its chip would leave the user with a
  // selection they can neither see nor remove -- worse than showing it twice.
  function pillShowing(a) {
    for (const pill of input.querySelectorAll(".composer-pill")) {
      const kind = pill.dataset.kind, name = pill.textContent;
      if (kind === "skill" && a.skill === name) return true;
      if (kind === "template" && a.template === name) return true;
      if (kind === "file" && a.resource && a.label === name) return true;
    }
    return false;
  }
  function renderAtts() {
    atts.innerHTML = "";
    attachments.forEach((a, i) => {
      if (pillShowing(a)) return;
      if (a.img) {
        const drop = el("button", "x", "\u00d7");
        drop.type = "button"; drop.title = "Remove this image";
        drop.setAttribute("aria-label", "Remove attached image");
        drop.onclick = () => { dismissAttachment(attachments[i]); attachments.splice(i, 1); renderAtts(); };
        atts.appendChild(imageAttachmentChip(a, drop));
        return;
      }
      const chip = el("span", `chip${a.pipReference ? " pip-reference-chip" : ""}${a.skill || a.template ? " invocation-chip" : ""}${a.pasted ? " pasted-chip" : ""}`);
      const label = el("span", "chip-label"), remove = el("button", "x", "\u00d7");
      label.textContent = a.pasted ? `Pasted text · ${a.chars.toLocaleString()} chars` : a.label;
      label.title = a.pipReference ? `${a.pipReference.pip_id} · ${a.pipReference.status} · lifecycle ${a.pipReference.lifecycle_revision} · Reference only; no work starts` : label.textContent; remove.type = "button"; remove.title = "Remove this attachment";
      remove.setAttribute("aria-label", `Remove attachment ${label.textContent}`);
      // (No pill to take with it: pillShowing() suppresses a chip for as long as a pill stands for
      // the same selection, so a chip and its pill are never both on screen. Measured in Chromium
      // -- two skills picked, #attachments is empty.)
      remove.onclick = () => { dismissAttachment(attachments[i]); attachments.splice(i, 1); renderAtts(); };
      chip.appendChild(label);
      if (a.pasted) {
        // The paste is not hidden, only folded away. One click puts it back where it was typed.
        const show = el("button", "chip-action", "Show in text field");
        show.type = "button";
        show.title = "Put this text back into the composer";
        show.onclick = () => {
          const at = composerSelection()[0] ?? composerText().length;
          // The text going in and the chip going out are one step, so Ctrl+Z folds the text back
          // into its chip instead of deleting the paste.
          recordComposerEdit(() => {
            editComposer(at, at, a.pasted);
            setComposerRange(at + a.pasted.length);
            attachments.splice(attachments.indexOf(a), 1);
          });
          renderAtts();
          input.focus();
          autosizeComposer();
        };
        chip.appendChild(show);
      }
      chip.appendChild(remove); atts.appendChild(chip);
    });
    scheduleDraftSave();
    renderComposerControls();
  }

  // ---- @file / slash popover ----
  let popAwaitingFiles = false;   // an "@" opened before the workspace file list had arrived
  function hidePop() { clearPipPicker(); pop.style.display = "none"; popMode = null; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); }
  function showPop(items) {
    popItems = items; popIdx = 0;
    if (!items.length) return hidePop();
    // Codex's rows: an icon for WHAT this is, then the bare name. The sigil is redundant once an
    // icon says the same thing, and "/goal" beside "$code-review" made the list read as two
    // alphabets. `label` keeps its sigil -- the matcher and the inserter both read it -- so this
    // is a rendering change only.
    const rowIcon = (it) => (it.skill ? "codicon-package"
      : it.template ? "codicon-symbol-snippet" : "codicon-terminal");
    pop.innerHTML = items.map((it, i) => `<div id="pop-option-${i}" role="option" aria-disabled="${it.disabled===true}" aria-selected="${i === 0}" class="pi${i === 0 ? " sel" : ""}" data-i="${i}"><span class="pi-label"><span class="pi-icon codicon ${rowIcon(it)}" aria-hidden="true"></span>${esc(String(it.label || "").replace(/^[/$@]/, ""))}</span>${it.kind ? `<span class="pi-kind">${esc(it.kind)}</span>` : ""}${it.detail ? `<span class="pd">${esc(it.detail)}</span>` : ""}</div>`).join("");
    pop.querySelectorAll(".pi").forEach((e) => e.onclick = () => choosePop(Number(e.dataset.i)));
    pop.style.display = "block"; input.setAttribute("aria-expanded", "true"); input.setAttribute("aria-activedescendant", "pop-option-0");
  }
  function renderPipPicker() {
    if (!pipPicker.active) return;
    const items=pipPicker.rows.map(p => ({label:p.name.replace(/\s+/g," "),kind:`${p.pip_type} Pip`,detail:`${p.status} · v${p.job_version} · ${p.pip_id.slice(-8)}`,pipReference:p}));
    if (pipPicker.loading) items.push({label:"Loading Pips…",disabled:true});
    else if (pipPicker.error) items.push({label:pipPicker.error,disabled:true},{label:"Retry Pip list",pipRetry:true});
    else if (pipPicker.cursor && pipPicker.rows.length < 100) items.push({label:"Load more Pips",pipMore:true});
    else if (!items.length) items.push({label:pipPicker.emptyLabel||"No matching Pips in this chat’s workspace",disabled:true});
    if(pipPicker.rows.length>=100)items.push({label:"Showing 100 Pips. Refine your search.",disabled:true});
    popMode="pip";showPop(items);
  }
  function requestPromptPips(query, more=false) {
    clearTimeout(pipPicker.timer);clearTimeout(pipPicker.timeout);
    if (!pipReferencesSupported || !sessionReady) { pipPicker.id="";pipPicker.loading=false;pipPicker.error="Reconnect to use Pip references."; renderPipPicker(); return; }
    if (new TextEncoder().encode(query).length>128) { pipPicker.id="";pipPicker.error="Use a shorter Pip search (128 bytes).";pipPicker.loading=false;renderPipPicker();return; }
    const after=more?pipPicker.cursor:null;
    if(!more)Object.assign(pipPicker,{rows:[],cursor:null,workspace:"",emptyLabel:""});
    Object.assign(pipPicker,{query,loading:true,error:"",id:`pip-ref-${promptPrefix}-${++promptSequence}`});renderPipPicker();
    const id=pipPicker.id;
    pipPicker.timer=setTimeout(()=>{if(pipPicker.active&&pipPicker.id===id){vscode.postMessage({type:"list_prompt_pips",query,limit:20,...(after?{after}:{}),request_id:id});pipPicker.timeout=setTimeout(()=>{if(pipPicker.active&&pipPicker.id===id&&pipPicker.loading){pipPicker.id="";pipPicker.loading=false;pipPicker.error="The computer did not answer. Retry when connected.";renderPipPicker();}},10000);}},120);
  }
  function receivePromptPips(ev) {
    if(!pipPicker.active || ev.request_id!==pipPicker.id) return;
    clearTimeout(pipPicker.timeout);pipPicker.loading=false;
    if(ev.workspace_id===""&&Array.isArray(ev.pips)&&!ev.pips.length&&ev.next_cursor===null&&!pipPicker.workspace){pipPicker.rows=[];pipPicker.cursor=null;pipPicker.emptyLabel="No Pips are registered for this chat’s workspace.";renderPipPicker();return;}
    const rows=Array.isArray(ev.pips)?ev.pips.map(p=>({...p,workspace_id:ev.workspace_id})):null;
    if(!rows||rows.length>20||!rows.every(validPipReference)||new Set(rows.map(p=>p.pip_id)).size!==rows.length
      ||typeof ev.workspace_id!=="string"||!/^ws_[a-f0-9]{32}$/.test(ev.workspace_id)||ev.workspace_id.length!==35
      ||(pipPicker.workspace&&pipPicker.workspace!==ev.workspace_id)
      ||!(ev.next_cursor===null||typeof ev.next_cursor==="string"&&ev.next_cursor.length>0&&ev.next_cursor.length<=256&&!/[\u0000-\u001f\u007f]/.test(ev.next_cursor))) {
      pipPicker.error="The computer returned invalid Pip references. Refresh the list.";renderPipPicker();return;
    }
    pipPicker.workspace=ev.workspace_id;pipPicker.cursor=ev.next_cursor;
    for(const p of rows)if(!pipPicker.rows.some(old=>old.pip_id===p.pip_id))pipPicker.rows.push(p);
    renderPipPicker();
  }
  function movePop(d) {
    if (!popMode) return;
    popIdx = (popIdx + d + popItems.length) % popItems.length;
    [...pop.children].forEach((c, i) => { const selected = i === popIdx; c.className = "pi" + (selected ? " sel" : ""); c.setAttribute("aria-selected", String(selected)); });
    input.setAttribute("aria-activedescendant", `pop-option-${popIdx}`);
    pop.children[popIdx]?.scrollIntoView?.({ block: "nearest" });
  }
  function replacePopToken(value = "") {
    editComposer(popStart, popEnd, value);
    setComposerRange(popStart + value.length);
    autosizeComposer();
    scheduleDraftSave();
  }
  // A pick is one step of the box's history, whatever it touches: the typed token out, the pill
  // in, the skill or file attached. Undone, the token is back as it was typed.
  function choosePop(i) { recordComposerEdit(() => pickPop(i)); }
  function pickPop(i) {
    const it = popItems[i]; if (!it || it.disabled) return;
    if(it.pipPicker){clearPipPicker();pipPicker.active=true;replacePopToken("@");requestPromptPips("");return;}
    if(it.pipMore||it.pipRetry){requestPromptPips(pipPicker.query,!!it.pipMore);return;}
    if(it.pipReference){
      if(!validPipReference(it.pipReference)||!pipReferencesSupported)return;
      if(attachments.some(a=>a.pipReference?.pip_id===it.pipReference.pip_id)){sysLine("This Pip is already referenced.");return;}
      if(attachments.filter(a=>a.pipReference).length>=8){sysLine("Reference at most eight Pips in one message.",true);return;}
      if(!canAttach())return;
      attachments.push({label:pipReferenceLabel(it.pipReference),pipReference:{...it.pipReference}});renderAtts();replacePopToken();hidePop();input.focus();return;
    }
    if (it.skill || it.template) {
      const kind = it.skill ? "skill" : "template";
      if (!attachInvocation(kind, it.skill || it.template)) return;
      // The token becomes a pill in place rather than disappearing. It serialises to "" -- the
      // skill travels in `skills`, exactly as before -- so what reaches the model is unchanged
      // and the reader can finally see which skill they picked, where they picked it.
      insertComposerPill(popStart, popEnd, kind, it.skill || it.template);
      hidePop(); input.focus(); return;
    }
    if (popMode === "@") {
      if (!canAttach()) return;
      attachments.push({ label: it.label, resource: {
        type: "file_mention", uri: it.uri, path: it.path,
        relative_path: it.relative_path, workspace: it.workspace,
      } });
      renderAtts();
      insertComposerPill(popStart, popEnd, "file", it.label);
    } else if (popMode === "/") {
      if (it.action === "agentMap") {
        // The map is the panel's own: the token goes, the rest of the draft stays.
        replacePopToken(); hidePop();
        openAgentMap({ command: true });
        return;
      }
      if (it.action?.startsWith("workflow:")) {
        // One edit, so one Ctrl+Z returns to what was typed: removing the token and adding the
        // prefix as two edits left a blank box between them in the undo history.
        prepareWorkflowDraft(it.action.slice("workflow:".length), popStart, popEnd);
        hidePop(); input.focus(); return;
      }
      if (it.action === "goal") {
        // Goal is a one-message composer choice. Remove the highlighted slash token immediately,
        // pin the existing target control in the footer, and leave the caret in this same draft.
        // The control disappears on send; the standing-goal rail owns later progress and controls.
        armGoalDraft(popStart, popEnd);
        hidePop(); input.focus(); return;
      }
      if (composerText().slice(0, popStart).trim() || composerText().slice(popEnd).trim()) {
        // Management actions operate independently of the draft. Opening a model, skills,
        // MCP, or settings picker must not submit or replace the user's unfinished request.
        replacePopToken(); hidePop(); input.focus();
        vscode.postMessage({ type: "slash", action: it.action });
        return;
      }
      if (it.acceptsArgs || (it.action && it.action.indexOf("custom:") === 0)) {
        insertCommandPill(it.label, popStart, popEnd);
        hidePop(); input.focus(); return;
      }
      replacePopToken();
      vscode.postMessage({ type: "slash", action: it.action });
    }
    hidePop(); input.focus();
  }
  /** Put a picked draft command in the composer as one atomic pill.
   *
   *  One command per prompt. Picking a second replaces the first rather than stacking. */
  function insertCommandPill(label, tokenStart, tokenEnd) {
    recordComposerEdit(() => placeCommandPill(label, tokenStart, tokenEnd));
  }
  function placeCommandPill(label, tokenStart, tokenEnd) {
    const existing = [...input.querySelectorAll('[data-kind="command"]')];
    if (existing.length) {
      // Remove the old one first, and do it before measuring, so the offsets below are the ones
      // that will actually apply.
      for (const pill of existing) {
        // `offsetOf` is the same walk the wire text and the caret use, so this is the pill's
        // position in the string submit() will parse, not a guess at the DOM.
        const before = composerText();
        const at = offsetOf(pill.parentNode, [...pill.parentNode.childNodes].indexOf(pill));
        const wire = String(pill.dataset.pill || "");
        editComposer(at, at + wire.length, "");
        const shrank = before.length - composerText().length;
        if (tokenStart >= at) { tokenStart = Math.max(at, tokenStart - shrank); }
        if (tokenEnd >= at) { tokenEnd = Math.max(tokenStart, tokenEnd - shrank); }
      }
    }
    // The "/" is the pill's sigil, drawn by CSS like "$" on a skill and "@" on a file, so the
    // label must not carry one too or the pill reads "//goal".
    insertComposerPill(tokenStart, tokenEnd, "command", label.replace(/^\//, ""), label + " ");
    autosizeComposer();
    persistDraft();
  }

  function armGoalDraft(tokenStart, tokenEnd) {
    // The token leaving and the Goal choice arriving are one step: undone, "/goal" is back as
    // typed and the choice is gone with it.
    recordComposerEdit(() => {
      editComposer(tokenStart, tokenEnd, "");
      setComposerRange(tokenStart);
      setGoalDraftArmed(true);
    });
    autosizeComposer();
    persistDraft();
  }

  // `tokenStart`/`tokenEnd`: the slash-menu token this replaces, removed in the same edit.
  function prepareWorkflowDraft(name, tokenStart = 0, tokenEnd = tokenStart) {
    if (!["plan", "review", "init"].includes(name)) return;
    const prefix = `/${name} `;
    const value = composerText();
    const token = tokenEnd > tokenStart;
    const without = token ? value.slice(0, tokenStart) + value.slice(tokenEnd) : value;
    const current = /^\/(plan|review|init)(?:\s+|$)/i.exec(without);
    const removed = current ? current[0].length : 0;
    const caret = Math.max(0, (token ? tokenStart : composerSelection()[0]) - removed) + prefix.length;
    const next = prefix + without.slice(removed);
    // The smallest single replacement that turns the box into `next`.
    let head = 0;
    while (head < value.length && head < next.length && value[head] === next[head]) head++;
    let tail = 0;
    while (tail < value.length - head && tail < next.length - head
      && value[value.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
    editComposer(head, value.length - tail, next.slice(head, next.length - tail));
    setComposerRange(caret);
    autosizeComposer();
    persistDraft(); input.focus();
  }
  // ---- composer height ----
  // The box grows with its text up to 160px. That needs a real layout: measured while the panel is
  // hidden (another view in front, the editor collapsing it to zero width), the text wraps one
  // character per line and the box came back 160px tall; measured under display:none it came back
  // 0px. A turn that stops while you are elsewhere restarts the backend and restores the draft, so
  // this happened exactly when DGC was not on screen. Measure only when laid out, and measure again
  // whenever the box's width really changes or the panel becomes visible.
  var composerSizedWidth = -1;   // var: callers above this line run before it at startup
  function autosizeComposer() {
    const width = input.clientWidth;
    if (!input.isConnected || width < 40 || document.hidden) { composerSizedWidth = -1; return; }
    composerSizedWidth = width;
    // An editing host already sizes to its content, so the measure-and-set dance a <textarea>
    // needed is gone: `max-height: 160px` with `overflow-y: auto` in main.css is the whole
    // behaviour. What is kept is the width bookkeeping the ResizeObserver reads, and clearing any
    // inline height a previous build may have left on the element.
    if (input.style.height) input.style.height = "";
    if (input.style.overflowY) input.style.overflowY = "";
  }
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => { if (input.clientWidth !== composerSizedWidth) autosizeComposer(); })
      .observe(input.parentElement || input);
  }
  document.body.classList.toggle("motion-paused", document.hidden);
  document.addEventListener("visibilitychange", () => {
    document.body.classList.toggle("motion-paused", document.hidden);
    if (!document.hidden) autosizeComposer();
  });
  window.addEventListener("focus", autosizeComposer);

  // ---- composer edits ----
  // Each one is a step in the composer's own history (recordComposerEdit, with the box's
  // primitives): undo after sending brings the prompt back, and a completion or an inserted command
  // is one Cmd+Z. Through the browser's editing command where it exists, because that is what keeps
  // the caret, the scroll and IME state where Chromium expects them; set directly where it does
  // not (a test DOM) or where it did not produce exactly this edit. Either way the step is the same.
  let composerEditing = false;
  function editComposer(start, end, text) {
    return recordComposerEdit(() => applyComposerEdit(start, end, text));
  }
  function applyComposerEdit(start, end, text) {
    start = Math.max(0, Math.min(start, composerText().length));
    end = Math.max(start, Math.min(end, composerText().length));
    if (start === end && !text) return;
    const expected = composerText().slice(0, start) + text + composerText().slice(end);
    if (typeof document.execCommand === "function") {
      composerEditing = true;
      try {
        input.focus({ preventScroll: true });
        setComposerRange(start, end);
        let done = text ? document.execCommand("insertText", false, text)
          : document.execCommand("delete", false);
        // Refused when this runs inside another editing command (a paste or drop VS Code started):
        // the same edit by hand, rather than the rebuild below that drops every pill.
        if (!done) done = spliceComposer(text);
        // onInput is suppressed while composerEditing is set, so nothing else re-reads the empty
        // state on this path: after a send the box sat empty with no placeholder on it.
        if (done && composerText() === expected) { markComposerEmpty(); return; }
      } catch { /* fall through to a plain assignment */ }
      finally { composerEditing = false; }
    }
    // No editing command, or it did not produce exactly this edit: set the result directly.
    setComposerValue(expected);
    setComposerRange(start + text.length);
  }
  function setComposerText(text) { editComposer(0, composerText().length, String(text ?? "")); }
  function clearComposer() { recordComposerEdit(emptyComposer); }
  function emptyComposer() {
    // A composer holding nothing but pills serializes to the empty string -- a skill pill's wire
    // text IS "" -- so the text-range edit below is a 0-to-0 no-op and the pills survive the send,
    // still sitting in the box under the message they were part of. Delete by DOM range instead of
    // by text offsets.
    const cleared = () => composerText() === "" && !input.querySelector("[data-pill]");
    if (input.firstChild && typeof document.execCommand === "function") {
      composerEditing = true;
      try {
        input.focus({ preventScroll: true });
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(input);
          sel.removeAllRanges();
          sel.addRange(range);
          if (document.execCommand("delete", false) && cleared()) {
            markComposerEmpty(); autosizeComposer(); return;
          }
        }
      } catch { /* fall through to the text edit */ }
      finally { composerEditing = false; }
    }
    setComposerText("");
    if (!cleared()) setComposerValue("");
    autosizeComposer();
  }

  // A paste that folds into a chip -- an image, or text past PASTED_TEXT_LIMIT -- changes no text
  // at all, so it was invisible to the browser's undo and needed a stack of its own, spliced into
  // that one by comparing what the box read. It is an ordinary step of the composer's history now:
  // the chip is in the snapshot beside the text, so typing after a paste is undone first, a run at
  // a time, and the next press takes the chip.
  function onInput() {
    if (composerEditing) return;   // our own edit: its caller already does the follow-up work
    markComposerEmpty();
    reconcilePills();
    renderPasteNotice();
    // An IME composition builds a word by repeatedly rewriting text nodes. A textarea absorbed
    // that internally; an editing host does not, and ANY programmatic edit or selection move
    // during a composition cancels the session and drops what was being typed. So the picker,
    // autosize and draft save all wait for compositionend.
    if (composing) return;
    scheduleDraftSave();
    renderComposerControls();
    autosizeComposer();
    const v = composerText(), caret = composerSelection()[0];
    const upto = v.slice(0, caret);
    const token = /(^|\s)([/$@][^\s]*)$/.exec(upto);
    if (!token || composerSelection()[0] !== composerSelection()[1] || input.matches(":disabled")) return hidePop();
    const nextStart = caret - token[2].length;
    if(pipPicker.active && (token[2][0]!=="@"||nextStart!==popStart))clearPipPicker();
    popStart = nextStart;
    popEnd = caret + (v.slice(caret).match(/^[^\s]*/)?.[0].length || 0);
    popMode = token[2][0];
    const query = token[2].slice(1).toLowerCase();
    if(pipPicker.active){if(query!==pipPicker.query)requestPromptPips(query);else renderPipPicker();return;}
    // Codex turns the complete `/goal` token into a pinned composer choice immediately. Requiring
    // a second Enter or Tab leaves it as highlighted inline text and gives no visible draft state.
    // A pasted `/goal pause` still remains a management command because its final token is `pause`.
    if (popMode === "/" && query === "goal" && token[2].toLowerCase() === "/goal") {
      armGoalDraft(popStart, popEnd);
      hidePop(); input.focus(); return;
    }
    if (popMode === "/" || popMode === "$") {
      const skillItems = skillRows.filter((s) => s && s.enabled !== false).map((s) => ({
        label: "$" + s.name, detail: s.description || "Reusable agent instructions",
        skill: s.name, kind: s.source ? `${s.source} skill` : "skill", aliases: [],
      }));
      const all = popMode === "$" ? skillItems : agentMapCommands(builtinCommands).map((c) => ({ label: "/" + c.name, detail: c.description,
        action: c.action, acceptsArgs: c.accepts_args === true,
        kind: "command",
        aliases: Array.isArray(c.aliases) ? c.aliases : [] }))
        .concat(customCommands.map((c) => ({ label: "/" + c, detail: "Apply this prompt template to your request", template: c, kind: "prompt" })), skillItems);
      const matches = all.filter((c) => c.label.slice(1).toLowerCase().includes(query)
        || (c.detail || "").toLowerCase().includes(query)
        || (c.aliases || []).some((alias) => alias.toLowerCase().includes(query)));
      if (query) matches.sort((a, b) => Number(!a.label.slice(1).toLowerCase().startsWith(query))
        - Number(!b.label.slice(1).toLowerCase().startsWith(query)));
      showPop(matches);
    }
    else if (popMode === "@") {
      // The list is fetched lazily, so the FIRST "@" in a fresh panel has nothing to show. Note
      // that a picker is waiting before showPop runs: with no items showPop calls hidePop, which
      // clears popMode, and the retry in the "files" handler was guarded on popMode === "@" --
      // so the list arrived and nothing reopened. You typed "@", saw nothing, and only got the
      // picker by typing another character.
      if (files.length === 0) { popAwaitingFiles = true; vscode.postMessage({ type: "reqFiles" }); }
      const candidates=files.filter((f) => f.label.toLowerCase().includes(query)).slice(0,30);
      if(pipReferencesSupported && (!query||"pips".includes(query)))candidates.unshift({label:"Reference a Pip…",kind:"Pips",detail:"This chat’s workspace · no work starts",pipPicker:true});
      showPop(candidates);
    } else hidePop();
  }
  input.addEventListener("input", onInput);
  input.addEventListener("click", onInput);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape" && mcpContextPending) {
      e.preventDefault(); doStop(); mcpContextPending = ""; return;
    }
    if (popMode) {
      if (e.key === "ArrowDown") { e.preventDefault(); movePop(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); movePop(-1); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choosePop(popIdx); return; }
      if (e.key === "Escape") { e.preventDefault(); hidePop(); return; }
    }
    if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); cycleMode(); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(e.altKey ? "queue" : undefined); }
    // Shift+Enter used to be the textarea's own business. An editing host answers it by wrapping
    // the rest of the line in a <div>, which the serializer would have to unpick -- so insert the
    // break explicitly and keep the host a flat run of text and <br>.
    // It is typing, so it joins the run it interrupts rather than being a step of its own.
    else if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); recordComposerEdit(() => insertComposerText("\n"), "insert"); }
    else if (e.key === "Escape" && (micState === "recording" || micState === "starting")) { e.preventDefault(); micCancel(); }
    else if (e.key === "Escape" && streaming) doStop();
  });

  // ---- dictation: the microphone beside Send records on the computer you're at (DGC Voice). While it records, the
  // box's footer is the voice bar (media/voicebar.js): Cancel, the live waveform and time, Stop (what you said goes
  // in the box) and Send. The first press with no model opens Settings -> Voice. In the side bar, the Pips box on
  // the same page dictates too: every mic message says which box ("chat" here).
  const micButton = $("btn-mic"), voiceRow = $("cvoice"), cbox = $("cbox");
  const voice = window.DgcVoiceBar ? window.DgcVoiceBar.create("chat") : null;
  if (voice) voiceRow.innerHTML = voice.markup(); else micButton.hidden = true;
  let micState = "idle";
  function micShow(next, action = "") {
    micState = ["starting", "recording", "writing"].includes(next) ? next : "idle";
    voice?.state(micState, action);
    cbox.classList.toggle("dictating", micState !== "idle");
  }
  function micCancel() {
    micShow("idle");
    vscode.postMessage({ type: "micCancel", from: "chat" });
    input.focus();
  }
  micButton.addEventListener("click", () => {
    if (micState !== "idle" || composerLocked) return;
    micShow("starting");
    vscode.postMessage({ type: "micStart", from: "chat" });
  });
  voiceRow.addEventListener("click", (e) => {
    const action = e.target.closest?.("[data-voice-action]")?.dataset.voiceAction;
    if (action === "cancel") micCancel();
    else if ((action === "stop" || action === "send") && micState === "recording") {
      micShow("writing", action);
      vscode.postMessage({ type: "micStop", mode: action === "send" ? "send" : "insert", from: "chat" });
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (micState === "recording" || micState === "starting") && e.target !== input && cbox.contains(e.target)) { e.preventDefault(); micCancel(); }
  });
  /** What the host says about this box's dictation. */
  function onMic(msg) {
    if (msg.type === "micLevels") { voice?.push(msg.levels); return; }
    micShow(msg.state, msg.mode === "send" ? "send" : "stop");
    if (msg.error) sysLine(String(msg.error), msg.kind !== "info");
    if (typeof msg.text !== "string") return;
    if (!msg.text) { sysLine("Nothing was heard. Try again, a little closer to the microphone."); return; }
    // What was said, at the caret, spaced from its neighbours.
    const [start, end] = composerSelection();
    const whole = composerText();
    const before = whole.slice(0, start), after = whole.slice(end);
    insertComposerText((before && !/\s$/.test(before) ? " " : "") + msg.text + (after && !/^\s/.test(after) ? " " : ""));
    onInput();
    persistDraft();
    if (msg.mode === "send") submit();
  }

  // Files dragged from the explorer (or a tab) attach as @-mentions, like the popup does.
  for (const zone of [input, log]) {
    zone.addEventListener("dragover", (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("text/uri-list")) {
        e.preventDefault(); e.dataTransfer.dropEffect = "copy";
      }
    });
    zone.addEventListener("drop", (e) => {
      // Take every drop. An editing host is a native drop target, so returning early handed the
      // browser its own default: the dragged content inserted verbatim, styled markup and remote
      // <img> and all, straight past the paste handling below. Dropped text still arrives, as
      // text, through the same edit path as everything else typed here.
      e.preventDefault();
      const list = e.dataTransfer ? e.dataTransfer.getData("text/uri-list") : "";
      const uris = list.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#")).slice(0, 16);
      if (!uris.length) {
        const text = e.dataTransfer ? e.dataTransfer.getData("text/plain") : "";
        if (text && zone === input) { const at = composerSelection()[0]; editComposer(at, at, text); }
        return;
      }
      vscode.postMessage({ type: "drop_uris", uris });
    });
  }
  input.addEventListener("paste", (e) => {                 // paste an image → attach for vision models
    const items = (e.clipboardData && e.clipboardData.items) || [];
    let sawImage = false;
    for (const it of items) {
      const pastedFile = it.kind === "file" && !(it.type && it.type.indexOf("image/") === 0) ? it.getAsFile() : null;
      if ((it.type && it.type.indexOf("image/") === 0) || (pastedFile && heicFile(pastedFile))) {
        const file = pastedFile || it.getAsFile(); if (!file) continue;
        if (!canAttach()) continue;
        const heic = heicFile(file);
        if (heic && !heicImages) {
          sysLine("Update DGC to send iPhone photos (HEIC), or send the photo as a JPEG.", true); continue;
        }
        if (!heic && !SUPPORTED_IMAGE_TYPES.has(String(file.type || "").toLowerCase())) {
          sysLine(`Unsupported pasted image type: ${file.type || "unknown"}.`, true); continue;
        }
        const current = attachments.filter((a) => a.img);
        if (current.length + pendingImageFiles >= imageFileCeiling()) {
          sysLine(`At most ${MAX_IMAGE_FILES} images can be attached to one prompt.`, true); continue;
        }
        const retainedBytes = current.reduce((total, image) => total + (image.bytes || 0), 0);
        const budget = imageByteCeiling();
        if (file.size > budget || retainedBytes + pendingImageBytes + file.size > budget) {
          sysLine(`Pasted images exceed the ${Math.round(budget / (1024 * 1024))} MiB prompt limit.`,
                  true); continue;
        }
        pendingImageFiles += 1; pendingImageBytes += file.size;
        const owner = { session: draftSession }; pendingImages.add(owner);
        const r = new FileReader();
        let settled = false;
        const release = () => {
          if (settled) return; settled = true;
          pendingImages.delete(owner);
          pendingImageFiles -= 1; pendingImageBytes -= file.size;
        };
        r.onload = () => {
          release();
          if (typeof r.result !== "string" || !r.result.startsWith(heic ? "data:" : "data:image/")) {
            sysLine("The pasted image could not be encoded safely.", true); return;
          }
          // An iPhone photo is labelled for what it is; DGC turns it into a JPEG for the model.
          // The chip shows the file's own name, as Claude Code's does ("Screenshot 2026-10-22 at
          // 17.11.png"); see imageFileName for a screenshot copied straight to the clipboard.
          const fileName = String(file.name || "").trim();
          const image = heic
            ? { label: fileName || "iPhone photo", img: true, heic: true, bytes: file.size,
                data: r.result.replace(/^data:[^;,]*(;[^,]*)?;base64,/, `data:${String(file.type || "").toLowerCase() === "image/heif" ? "image/heif" : "image/heic"};base64,`) }
            : { label: fileName || "Image", img: true, data: r.result, bytes: file.size };
          if (owner.session === draftSession) {
            recordComposerEdit(() => attachments.push(image)); renderAtts();
          } else {
            const draft = draftEntries.get(owner.session)
              || { text: "", attachments: [], start: 0, end: 0, updated: Date.now() };
            draft.attachments.push(image); draft.updated = Date.now();
            draftEntries.set(owner.session, draft); persistDraft();
            sysLine("The pasted image was added to its original chat's draft.");
          }
        };
        r.onerror = () => { release(); sysLine("The pasted image could not be read.", true); };
        r.onabort = release;
        try { r.readAsDataURL(file); }
        catch { release(); sysLine("The pasted image could not be read.", true); }
        e.preventDefault();
        sawImage = true;        // keep looping: a multi-image paste must see every item
      }
    }
    if (sawImage) return;
    // A wall of pasted text buries the composer and hides the controls under it. Past this many
    // characters it becomes an attachment instead, recoverable with one click. The threshold
    // matches Codex's.
    const pasted = clipboardText(e.clipboardData);
    // A copy or cut out of this box that held pills is pills again here (copyComposerSelection).
    if (composerCopy && pasted === composerCopy.text) {
      e.preventDefault();
      pasteComposerCopy(composerCopy.parts);
      return;
    }
    // No hook here. Every branch that puts text INTO the composer fires an input event, and
    // onInput already re-counts -- proved by removing this line and watching the tests stay green.
    // The one branch it would have covered, a paste large enough to fold into an attachment,
    // changes no composer text, so there is nothing for it to count. That path is a known gap:
    // the folded text still travels to the model in `a.pasted`, and nothing inspects it. Fixing
    // it means classifying the attachment, not the draft, and giving the chip its own notice.
    if (pasted.length >= PASTED_TEXT_LIMIT && canAttach()) {
      e.preventDefault();
      const chip = { label: "Pasted text", pasted, chars: pasted.length };
      recordComposerEdit(() => attachments.push(chip));
      renderAtts();
      sysLine(`Attached ${pasted.length.toLocaleString()} characters of pasted text.`);
      return;
    }
    // A pasted link becomes a pill carrying its favicon, which is what Codex does and what was
    // asked for. Only when the clipboard is EXACTLY one URL: pasting a paragraph that happens to
    // contain a link is pasting prose, and rewriting the middle of it would be presumptuous.
    //
    // Unlike a skill pill, this one's wire text is the URL ITSELF, so the model receives precisely
    // the characters that were pasted. The pill is a way of SHOWING the link, not of replacing it.
    const single = pasted.trim();
    if (single && !/\s/.test(single) && /^https?:\/\/\S+$/i.test(single) && single === pasted.trim()) {
      e.preventDefault();
      const [selStart, selEnd] = composerSelection();
      insertComposerPill(selStart, selEnd, "link", single, single);
      return;
    }
    // EVERY other paste is prevented too, and the plain text re-inserted by hand.
    //
    // This inverts a guarantee rather than adding one. A <textarea> physically cannot hold markup,
    // so letting the default action run WAS the safe choice and nothing here ever looked at
    // `text/html`. An editing host takes the clipboard's HTML instead, and the panel's CSP stops
    // <script> and on* handlers but not `<img src="https://tracker/...">` -- a beacon that fires
    // the instant you paste -- nor `style="position:fixed"` laid over the Send button.
    //
    // The refusal paths above still work because they `return` before reaching here only when
    // they handled the paste themselves; where they fall through, this inserts the text, so a
    // clipboard is never silently dropped.
    e.preventDefault();
    if (pasted) insertComposerText(pasted);
  });
  send.onclick = () => { if (streaming && (!hasComposerInput() || askCardDocked())) doStop(); else submit(); };
  $("stop-run").onclick = doStop;
  $("queue-send").onclick = () => submit("queue");
  $("btn-ctx").onclick = (e) => { e.stopPropagation(); toggleContextMenu(); };
  $("ctx-compact").onclick = () => {
    if (compacting) return;
    compacting = true; renderContext();
    vscode.postMessage({ type: "compact" });
  };
  $("ctx-size").onchange = () => {
    const select = $("ctx-size"), custom = $("ctx-size-custom");
    if (select.value === "custom") { custom.hidden = false; custom.focus(); return; }
    custom.hidden = true;
    vscode.postMessage({ type: "setContextSize", size: Number(select.value) });
    select.blur();
  };
  $("ctx-size-custom").addEventListener("change", () => {
    const size = Math.floor(Number($("ctx-size-custom").value));
    if (Number.isFinite(size) && size >= 2048) vscode.postMessage({ type: "setContextSize", size });
  });
  $("ctx-size-custom").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("ctx-size-custom").blur(); }
  });
  $("ctxmenu").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); hideContextMenu(); $("btn-ctx").focus(); }
  });
  $("btn-mode").onclick = (e) => { e.stopPropagation(); toggleModeMenu(); };
  // "+" is a menu, not a keystroke. It used to insert a literal "@", which meant the one control
  // most likely to be clicked first did the least discoverable thing in the panel. The shape is
  // Codex's -- a leading Add section -- but every item is a capability DGC already has, including
  // two that were previously reachable only from a settings page.
  function insertTrigger(ch) {
    input.focus();
    const at = composerSelection()[0] ?? composerText().length;
    const before = composerText().slice(0, at);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    editComposer(at, at, prefix + ch);
    setComposerRange(at + prefix.length + 1);
    onInput();
  }
  function hideAddMenu() {
    $("addmenu").hidden = true; $("btn-add").setAttribute("aria-expanded", "false");
  }
  function addMenuItems() {
    const items = [
      { id: "files", icon: "file-directory", label: "Files and folders",
        hint: "@", run: () => insertTrigger("@") },
      { id: "skill", icon: "lightbulb", label: "Skills",
        hint: "$", run: () => insertTrigger("$") },
      { id: "command", icon: "terminal", label: "Commands",
        hint: "/", run: () => insertTrigger("/") },
    ];
    if (mcpContextSupported) {
      items.push({ id: "mcp", icon: "plug", label: "MCP context",
                   hint: "resources, prompts",
                   run: () => vscode.postMessage({ type: "slash", action: "mcp" }) });
    }
    items.push({ id: "goal", icon: "target", label: "Goal",
                 hint: "keep pursuing", run: () => vscode.postMessage({ type: "slash", action: "goal" }) });
    items.push({ id: "plan", icon: "checklist", label: "Plan mode",
                 hint: curMode === "plan" ? "turn off" : "turn on",
                 run: () => setMode(curMode === "plan" ? "default" : "plan") });
    items.push({ id: "pips", icon: "beaker", label: "Pips",
                 hint: "your Pips and conversations", run: () => vscode.postMessage({ type: "openPips" }) });
    items.push({ id: "memory", icon: "bookmark", label: "Memory",
                 hint: "what DGC remembers",
                 run: () => vscode.postMessage({ type: "slash", action: "memory" }) });
    return items;
  }
  function toggleAddMenu() {
    const am = $("addmenu");
    if (!am.hidden) { hideAddMenu(); return; }
    hideModeMenu(); hideModelMenu(); hideContextMenu(); hideAgentsMenu();
    const items = addMenuItems();
    am.innerHTML = '<div role="group" aria-label="Add">'
      + '<div class="mhead" role="presentation"><span>Add</span></div>'
      + items.map((it) => `<button type="button" role="menuitem" class="mrow" data-add="${it.id}">`
          + `<span class="codicon codicon-${it.icon}" aria-hidden="true"></span>`
          + `<span class="mrow-label">${esc(it.label)}</span>`
          + `<span class="mrow-hint">${esc(it.hint)}</span></button>`).join("")
      + "</div>";
    am.querySelectorAll("[data-add]").forEach((row) => row.onclick = () => {
      hideAddMenu();
      items.find((it) => it.id === row.dataset.add)?.run();
    });
    am.hidden = false; $("btn-add").setAttribute("aria-expanded", "true");
    am.querySelector("button")?.focus();
  }
  $("btn-add").onclick = toggleAddMenu;
  function openCommandMenu() {
    const caret = composerSelection()[1];
    const prefix = caret && !/\s/.test(composerText()[caret - 1]) ? " /" : "/";
    editComposer(caret, caret, prefix);
    // Focus FIRST, then place the caret. Focusing an editing host moves the selection to its
    // start, so the old order -- harmless when the element was a textarea, whose focus does not
    // touch selectionStart -- silently threw the caret away and the picker then read an empty
    // prefix and never opened.
    input.focus(); setComposerRange(caret + prefix.length); onInput();
  }
  $("btn-cmd").onclick = openCommandMenu;
  $("btn-model").onclick = (e) => {
    e.stopPropagation();
    const mm = $("modelmenu");
    if (!mm.hidden) { hideModelMenu(); return; }
    mm.innerHTML = `<div class="mhead"><span>Loading…</span></div>`;
    mm.hidden = false; $("btn-model").setAttribute("aria-expanded", "true"); hideModeMenu(); hideContextMenu(); hideAgentsMenu();
    vscode.postMessage({ type: "listModels" });
  };
  // ---- running chats ---------------------------------------------------------------------------
  // Each chat has its own backend, so the chat you are not looking at keeps working. The rail says
  // which chats exist and what the other one is doing; the host owns the truth and re-sends the
  // whole list on every change, so this only ever paints what it was handed.
  let chatSlots = { items: [], max: 2, activeId: "" };

  // What a tab's dot says. Shape, motion and words carry it too, never colour alone:
  // waiting (green, pulsing ring) > working (purple, pulsing) > finished, unread (purple) > idle (grey).
  function chatState(item) {
    return item.needsYou ? ["waiting", "Needs your answer"] : item.busy ? ["busy", "Working"]
      : item.done ? ["done", "Finished · not read yet"] : ["idle", "Idle"];
  }
  let chatDrag = "";            // the chat whose tab is being dragged
  let chatShownActive = "";     // scroll the active tab into view only when it changes

  function renderChatBar(state) {
    chatSlots = state || chatSlots;
    const bar = $("chatbar"), add = $("chat-add");
    if (!bar) return;
    const items = Array.isArray(chatSlots.items) ? chatSlots.items : [];
    if (add) {
      // max === 0 means no ceiling: the host only sends a positive number when the user set one.
      const ceiling = Number(chatSlots.max) > 0 ? Number(chatSlots.max) : Infinity;
      const full = items.length >= ceiling;
      add.disabled = full;
      add.title = full ? `DGC is at your limit of ${ceiling} chats (dgc.maxLiveChats)`
        : items.length > 1 ? "Open another chat" : "Open a second chat";
      add.setAttribute("aria-label", add.title);
      // Another folder is another chat: the same ceiling, and nothing to pick a folder for.
      const folder = $("chat-add-folder");
      if (folder) {
        folder.disabled = full;
        folder.title = full ? add.title : "Open a chat in another folder";
        folder.setAttribute("aria-label", folder.title);
      }
    }
    // One chat needs no rail: the header already names it.
    if (items.length < 2) { bar.hidden = true; bar.replaceChildren(); chatShownActive = ""; return; }
    // The host re-sends the whole rail on every change, a background stream about once a frame.
    // The scroller is kept, so its scroll position survives, and so does keyboard focus.
    let strip = bar.querySelector(":scope > .chat-tabs"), more = bar.querySelector(":scope > .chat-more");
    if (!strip) {
      strip = el("div", "chat-tabs");
      more = el("button", "chat-more", '<span class="codicon codicon-chevron-down" aria-hidden="true"></span>');
      more.type = "button";
      more.onclick = () => vscode.postMessage({ type: "pickChat" });
      bar.replaceChildren(strip, more);
      wireChatStrip(strip);
    }
    const focusedSlot = document.activeElement?.closest?.("#chatbar .chat-tabwrap")?.dataset.slot || "";
    const focusedClose = !!document.activeElement?.classList?.contains("chat-close");
    strip.replaceChildren(...items.map((item, index) => chatTab(item, index, items.length)));
    more.title = `All chats (${items.length})`;
    more.setAttribute("aria-label", `All ${items.length} chats`);
    bar.hidden = false;
    if (focusedSlot) {
      const wrap = strip.querySelector(`.chat-tabwrap[data-slot="${CSS.escape(focusedSlot)}"]`);
      wrap?.querySelector(focusedClose ? ".chat-close" : ".chat-tab")?.focus({ preventScroll: true });
    }
    // The chevron first: it narrows the strip, so scrolling before it shows left the tab you are on
    // half under it. Then the fades, which follow the scroll.
    fitChatStrip(strip);
    const active = items.find((item) => item.active)?.id || "";
    if (active && active !== chatShownActive) {
      chatShownActive = active;
      strip.querySelector(".chat-tabwrap.is-active")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      fitChatStrip(strip);
    }
  }

  function chatTab(item, index, count) {
    const id = String(item.id || ""), [state, words] = chatState(item);
    const wrap = el("div", `chat-tabwrap state-${state}${item.active ? " is-active" : ""}`);
    wrap.dataset.slot = id;
    wrap.dataset.index = String(index);
    wrap.draggable = true;
    const tab = el("button", "chat-tab");
    tab.type = "button";
    const dot = el("span", "chat-dot");
    dot.setAttribute("aria-hidden", "true");
    const name = el("span", "chat-name");
    name.textContent = String(item.label || "New chat");
    tab.append(dot, name);
    const inFolder = item.folder ? ` in ${String(item.folder)}` : "";
    if (item.folder) {
      // A chat in another folder says which: two chats named "New chat" in two repos look alike.
      const where = el("span", "chat-folder");
      where.textContent = String(item.folder);
      tab.append(where);
    }
    tab.title = `${name.textContent}${inFolder}\n${item.active ? "Showing" : words}`;
    tab.setAttribute("aria-label", `Chat ${name.textContent}${inFolder}, ${words.toLowerCase()}${item.active ? ", showing" : ""}, ${index + 1} of ${count}`);
    if (item.active) tab.setAttribute("aria-current", "true");
    tab.onclick = () => { if (!item.active) vscode.postMessage({ type: "switchChat", slotId: id }); };
    tab.onkeydown = (e) => chatTabKey(e, id, index, count);
    const close = el("button", "chat-close", '<span class="codicon codicon-close" aria-hidden="true"></span>');
    close.type = "button";
    close.title = `Close ${name.textContent}`;
    close.setAttribute("aria-label", `Close chat ${name.textContent}`);
    close.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: "closeChat", slotId: id }); };
    wrap.append(tab, close);
    return wrap;
  }

  // Left/Right walk the tabs, Home/End jump; Alt+Shift+Left/Right moves the focused chat.
  function chatTabKey(e, id, index, count) {
    const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (step && e.altKey && e.shiftKey) {
      e.preventDefault();
      const to = index + step;
      if (to >= 0 && to < count) vscode.postMessage({ type: "moveChat", slotId: id, toIndex: to });
      return;
    }
    const tabs = [...document.querySelectorAll("#chatbar .chat-tab")];
    const next = step && !e.altKey && !e.ctrlKey && !e.metaKey ? tabs[index + step]
      : e.key === "Home" ? tabs[0] : e.key === "End" ? tabs[tabs.length - 1] : null;
    if (next) { e.preventDefault(); next.focus(); next.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }
  }

  // Overflow: the strip scrolls (a mouse wheel scrolls it sideways), its edges fade where tabs are
  // hidden, and the chevron lists every chat. Nothing is ever cut off without a way to reach it.
  function fitChatStrip(strip) {
    const over = strip.scrollWidth > strip.clientWidth + 1;
    const bar = strip.parentElement;
    bar.classList.toggle("is-overflowing", over);
    bar.classList.toggle("fade-start", over && strip.scrollLeft > 1);
    bar.classList.toggle("fade-end", over && strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
  }

  function wireChatStrip(strip) {
    strip.addEventListener("scroll", () => fitChatStrip(strip), { passive: true });
    strip.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || strip.scrollWidth <= strip.clientWidth) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    }, { passive: false });
    if (typeof ResizeObserver === "function") new ResizeObserver(() => fitChatStrip(strip)).observe(strip);
    const marks = () => strip.querySelectorAll(".drop-before, .drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));
    // Where a drop would land: before or after the tab under the pointer, by its midpoint.
    const target = (e) => {
      const wrap = e.target.closest?.(".chat-tabwrap");
      if (!wrap || wrap.dataset.slot === chatDrag) return null;
      const box = wrap.getBoundingClientRect();
      return { wrap, after: e.clientX > box.left + box.width / 2 };
    };
    strip.addEventListener("dragstart", (e) => {
      const wrap = e.target.closest?.(".chat-tabwrap");
      if (!wrap || !e.dataTransfer) return;
      chatDrag = wrap.dataset.slot;
      // A private type only: no text, so a drop on the composer or the transcript inserts nothing.
      e.dataTransfer.setData("application/x-dgc-chat", chatDrag);
      e.dataTransfer.effectAllowed = "move";
      wrap.classList.add("is-dragging");
      hoverTip.hide();
    });
    strip.addEventListener("dragover", (e) => {
      if (!chatDrag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      marks();
      const at = target(e);
      if (at) at.wrap.classList.add(at.after ? "drop-after" : "drop-before");
      // Near an edge, the strip scrolls so a tab can be dragged to a place out of view.
      const box = strip.getBoundingClientRect();
      if (e.clientX < box.left + 24) strip.scrollLeft -= 12;
      else if (e.clientX > box.right - 24) strip.scrollLeft += 12;
    });
    strip.addEventListener("dragleave", (e) => { if (!strip.contains(e.relatedTarget)) marks(); });
    strip.addEventListener("drop", (e) => {
      if (!chatDrag) return;
      e.preventDefault();
      const at = target(e), moving = strip.querySelector(`.chat-tabwrap[data-slot="${CSS.escape(chatDrag)}"]`);
      marks();
      if (!at || !moving) return;
      const from = Number(moving.dataset.index);
      let to = Number(at.wrap.dataset.index) + (at.after ? 1 : 0);
      if (from < to) to -= 1;
      if (to === from) return;
      at.wrap[at.after ? "after" : "before"](moving);      // at once; the host's rail follows
      vscode.postMessage({ type: "moveChat", slotId: chatDrag, toIndex: to });
    });
    strip.addEventListener("dragend", () => {
      strip.querySelector(".is-dragging")?.classList.remove("is-dragging");
      marks();
      chatDrag = "";
    });
  }

  /** Switching chats: everything on screen belongs to the chat being left. The incoming chat's
   *  backend sends its own history snapshot right behind this, so nothing is reconstructed here. */
  function clearForChatSwitch() {
    pipReferencesSupported=false;hidePop();
    discardTurn();
    log.innerHTML = "";
    queuedCount = 0; queuedPrompts.clear(); renderQueued();
    setSending(false);
    sessionResetHooks("switched");
    settleTodoClear();
    renderTodos([]);
    renderMonitors({ items: [], reset: true });
    resetTroupes();
    returnedPrompts.length = 0;
    backendExitNotice = null;
  }

  const chatAdd = $("chat-add");
  if (chatAdd) chatAdd.onclick = () => vscode.postMessage({ type: "newChat" });
  const chatAddFolder = $("chat-add-folder");
  if (chatAddFolder) chatAddFolder.onclick = () => vscode.postMessage({ type: "newChatInFolder" });

  const pmodel = $("pmodel"); if (pmodel) pmodel.onclick = () => vscode.postMessage({ type: "pickModel" });
  $("thread-title").onclick = () => {
    if (agentPageId) return;
    vscode.postMessage({ type: "slashText", text: "/name" });
  };
  document.addEventListener("click", (e) => {          // dismiss the picker menus on outside click
    if (!$("modemenu").hidden && !$("btn-mode").contains(e.target) && !$("modemenu").contains(e.target)) hideModeMenu();
    if (!$("modelmenu").hidden && !$("btn-model").contains(e.target) && !$("modelmenu").contains(e.target)) hideModelMenu();
    if (!$("ctxmenu").hidden && !$("btn-ctx").contains(e.target) && !$("ctxmenu").contains(e.target)) hideContextMenu();
    hideAgentsMenu(e);
  });

  $("btn-pips").onclick = () => vscode.postMessage({ type: "openPips" });
  // The Core Pip (the main chat's own character) sits in the Pips button, idle: a slow breathe
  // and a blink, paused while the panel is hidden or motion is reduced. Decorative only: the
  // button is still named "Open Pips". Without the renderer the button is the word alone.
  (() => {
    const face = document.querySelector("#btn-pips .pips-nav-core"), plush = window.PipConcepts?.plush;
    if (!face || !plush) return;
    try {
      if (!document.getElementById("plush-styles")) {
        const style = document.createElement("style"); style.id = "plush-styles"; style.textContent = plush.styles; document.head.append(style);
      }
      face.innerHTML = plush.markup({ index: 0, name: "Core" }, "idle", "pips-nav-core", { includeStyles: false });
      plush.mount(face);
      plush.mount(log);   // the Pips' faces in the chat (report cards) breathe, blink and look at the pointer too
    } catch { face.replaceChildren(); }
  })();
  $("btn-pips-back").onclick = () => closePips();
  if (chatPlace === "home") {
    // The side bar is the Sessions home: it opens on the list, and Pips' back button returns to it.
    const back = $("btn-pips-back");
    back.lastChild.textContent = "Sessions";
    back.title = "Back to Sessions"; back.setAttribute("aria-label", "Back to Sessions");
    $("sessions-new").onclick = () => vscode.postMessage({ type: "newSessionInEditor" });
    // Your Pips, above your sessions: the ones that need you, or a quiet row of faces.
    if (window.DgcPips?.mountHomePips && document.documentElement.dataset.pipsDocumentId) {
      homePips = window.DgcPips.mountHomePips({
        document, root: $("sessions-pips"),
        postMessage: (message) => vscode.postMessage({ ...message, documentId: document.documentElement.dataset.pipsDocumentId }),
        onOpen: (navigation) => { showPips(); if (navigation) pipsApp?.navigate?.(navigation); },
      });
    }
    showSessions();
    // Sessions also start from the terminal: coming back to the side bar looks again.
    const refresh = () => { if (sessionsOpen && !document.hidden) { vscode.postMessage({ type: "sessionsList" }); homePips?.refresh(); } };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
  }
  if (chatPlace === "tab") rememberTab(document.documentElement.dataset.tabSession || "");
  $("btn-settings").onclick = () => vscode.postMessage({ type: "openSettings" });

  // ---- replay ----
  // Everything a saved turn is made of. Anything else in a history payload is not dispatched:
  // `onEvent` carries cases with real side effects (posting to the extension host, registering
  // approval cards, flipping the composer), and a reload must not fire any of them.
  const REPLAYABLE = new Set(["turn_start", "permission_decision", "text_delta", "thinking_delta", "thinking_end", "stream_end",
                              "tool_call", "tool_result", "tool_denied", "tool_images", "options_resolved",
                              "model_retry", "monitor_event", "agent_report", "turn_activity", "turn_eta", "turn_files", "turn_end"]);
  function prepareCompleteHistory(items) {
    // The host may have forwarded the end of A and start of queued B while this webview was
    // loading. Those provisional blocks must be replaced together, not adopted as one turn.
    // Starts covered by the snapshot must also retire their delivery bookkeeping. A queued start
    // can be among the held events; discarding only its rendering left a second queued bubble.
    for (const item of items) {
      if (item?.type !== "turn_start" || !item.request_id) continue;
      const id = item.request_id;
      const entry = queuedPrompts.get(id) || pendingPrompts.get(id);
      entry?.node?.remove();
      if (queuedPrompts.has(id)) queuedCount = Math.max(0, queuedCount - 1);
      queuedPrompts.delete(id); pendingPrompts.delete(id);
    }
    renderQueued();
    const pending = new Set([...queuedPrompts.values(), ...pendingPrompts.values()].map((e) => e?.node));
    if (turn) dropTurnBlock();
    // The live turns' boxes first, so the loop below sees the plain rows it always has: the snapshot
    // replaces their prompts and turns, and keeps the lines and the messages still in doubt.
    for (const box of [...log.querySelectorAll(":scope > .turn")]) unwrapTurn(box);
    for (const node of [...log.children]) {
      if (node.matches(".msg, .resume-note, .compaction, .pip-report") && !pending.has(node)
          && !node.matches(".rejected, .unconfirmed")) node.remove();
    }
    let open = null;
    for (const item of items) {
      if (item?.type === "turn_start") open = item;
      else if (item?.type === "turn_end") open = null;
    }
    const previous = liveTurnHint;
    liveTurnHint = open ? {
      id: String(open.turn_id || ""), prompt: String(open.prompt || ""), kind: open.kind || "prompt",
      startedAt: previous?.id === open.turn_id ? previous.startedAt : Date.now(), handoff: false,
    } : null;
    setSending(!!open);
  }
  // One whole turn, or one standalone marker. Paging cuts between units, never inside one.
  function historyUnits(items) {
    const units = [];
    let open = null;
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const type = typeof it.type === "string" ? it.type : "";
      if (type === "turn_start") { open = [it]; units.push(open); continue; }
      if (!type) {                           // a marker: part of the turn it fell inside, if any
        if (open) open.push(it); else units.push([it]);
        continue;
      }
      if (!REPLAYABLE.has(type)) continue;
      if (open) { open.push(it); if (type === "turn_end") open = null; }
      else units.push([it]);                 // a fragment with no turn above it still renders
    }
    return units;
  }
  // Drive the live reducer with saved events, into a detached fragment. The live turn is set
  // aside first: a history page can arrive while a turn is streaming, and the replay must not
  // adopt, finish or otherwise touch it.
  function replayInto(list, frag, newest = false) {
    const live = turn, wasFollowing = following;
    let running = null;
    turn = null; replaying = true; appendTarget = frag;
    try {
      for (const it of list) {
        if (it && typeof it.type === "string") { if (REPLAYABLE.has(it.type)) onEvent(it); }
        else legacyItem(it);
      }
      // The newest page may end inside the turn that is still running (see noteLiveTurn); any
      // other page that ends mid-turn still settles its block.
      if (turn && newest && liveTurnHint && !live && turn.id === liveTurnHint.id) { running = turn; turn = null; }
      else if (turn) endTurn("completed");
    } finally {
      replaying = false; appendTarget = log; turn = live; following = wasFollowing;
    }
    if (running) adoptLiveTurn(running);
  }
  // Items the backend still sends in their own shape because they are not turn events, plus the
  // flat projection an older backend sends — translated into events rather than given a second
  // renderer of their own.
  // A message the user sent while the turn ran, placed where the model read it: what streamed before
  // it becomes commentary and the turn carries on below it. The live acknowledgement and a restored
  // chat's steering rows both come here, so a reload draws the turn the live one drew.
  function placeSteering(node) {
    flushText(); finishReasoning();
    if (turn.textEl) markCommentary(turn.textEl);
    turn.textEl = null; turn._buf = ""; releaseToolGroup();
    // Part of the turn from here on: measured, pinned and skipped as the turn's block -- how a replayed
    // steering message has always been drawn. A settled block nested in another is laid out by neither
    // when the outer one is skipped, so its fold could never be measured again.
    node.classList.remove("settled"); blockSizes?.unobserve(node); node.style.removeProperty("contain-intrinsic-size");
    appendTurnContent(node);
    if (!replaying) fitPromptFolds(node);   // the turn's column, not the log's: decide again
  }
  // ---- Pip reports in the chat ----
  // A finished Pip run that reports to this chat arrives as a card in the transcript where it came
  // (after the turn that was running), live as a `pip_report` event and on reopen as a
  // {role: "pip_report"} marker -- one renderer for both, so a reload draws what was drawn live.
  // Ask DGC to fix sends one message naming the run (see askDgcToFix); nothing else here starts a turn.
  const PIP_REPORT_TYPES = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"];
  // live_clear and live_attention (Pips API 60): a live-data Pip's run, its summary grounded in its commands' output.
  const PIP_REPORT_OUTCOMES = ["findings", "clear", "failed", "checks_failed", "checks_passed", "live_clear", "live_attention"];
  const PIP_REPORT_KINDS = ["audit", "checks", "live"];
  const PIP_REPORT_SEVERITIES = ["critical", "high", "medium", "low"];
  const pipReportPlural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  function validPipReport(r) {
    return !!r && typeof r === "object" && /^run_[0-9a-f]{32}$/.test(String(r.run_id || ""))
      && /^pip_[0-9a-f]{32}$/.test(String(r.pip_id || "")) && PIP_REPORT_TYPES.includes(r.pip_type)
      && PIP_REPORT_OUTCOMES.includes(r.outcome) && typeof r.name === "string" && !!r.name.trim();
  }
  // "finished · 5 findings (2 high, 3 medium)", "failed: the project is too big…", in the user's words.
  function pipReportState(r) {
    const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
    if (r.outcome === "failed") {
      const reason = String(r.reason || "It stopped with an error.").slice(0, 300);
      return `failed: ${reason.replace(/^(The|Its|It|A|This)\b/, (w) => w.toLowerCase())}`;
    }
    if (r.outcome === "clear") return "finished · nothing found";
    if (r.outcome === "checks_passed") {
      const total = n(r.checks?.total);
      return total === 1 ? "finished · the check passed" : `finished · all ${total} checks passed`;
    }
    if (r.outcome === "checks_failed") return `finished · ${n(r.checks?.failed)} of ${pipReportPlural(n(r.checks?.total), "check")} failed`;
    if (r.outcome === "live_clear") return "finished · all clear";
    if (r.outcome === "live_attention") {
      const failed = n(r.commands?.failed);
      return failed ? `needs you · ${failed} of ${pipReportPlural(n(r.commands?.total), "command")} didn’t run` : "needs you";
    }
    const counts = PIP_REPORT_SEVERITIES.filter((s) => n(r.counts?.[s])).map((s) => `${n(r.counts[s])} ${s}`);
    return `finished · ${pipReportPlural(n(r.total), "finding")}${counts.length ? ` (${counts.join(", ")})` : ""}`;
  }
  // What "Ask DGC to fix" sends. It names the run so the model reads the whole report
  // itself, and keeps live systems the user's call.
  function pipReportPrompt(r) {
    const name = `Pip “${r.name}”`;
    const read = r.kind === "checks" ? "execution" : "report";   // a live-data run reads as a report too
    const how = `Read it with pips_context (action "${read}", run_id "${r.run_id}")`;
    if (r.outcome === "failed") {
      return `${name} failed (run ${r.run_id}): ${String(r.reason || "it stopped with an error.")}\n`
        + `${how}, find out what stopped it and help me fix that, so its next run works. `
        + `Ask me before you change any live data or services.`;
    }
    if (r.outcome === "live_attention") {
      return `${name} read live data and reported (run ${r.run_id}): ${String(r.summary || "").slice(0, 600)}\n`
        + `${how}, find the cause in the project's code or configuration and fix it there. `
        + `Don't change live data, a database or a service to make the numbers look right; ask me first.`;
    }
    if (r.outcome === "checks_failed") {
      const which = Array.isArray(r.failed_checks) && r.failed_checks.length ? ` (${r.failed_checks.join("; ")})` : "";
      return `${name} ran its checks and ${pipReportState(r).replace(/^finished · /, "")}${which} in run ${r.run_id}.\n`
        + `${how}, find out why and fix it. Ask me before you change any live data or services.`;
    }
    return `${name} reported ${pipReportState(r).replace(/^finished · /, "")} in run ${r.run_id}.\n`
      + `${how}, check each finding against the code, and fix the real ones here in the project. `
      + `Ask me before you change any live data or services.`;
  }
  // Ask DGC to fix sends the prompt at once (the founder, 19 Oct: filling the box let a second click paste it again).
  // The click is the user's ask; the prompt still says to ask before touching live data or services. It goes as
  // its own message, queued behind a turn that is running, and never touches a draft in the box. A report that
  // has been asked about says so, also after a reload: the chat already holds the prompt naming its run.
  function pipReportAsked(runId) {
    return [...log.querySelectorAll(".msg.user .bubble")].some((b) => b.textContent.includes(`run ${runId}`));
  }
  // A prompt naming a run marks that run's card as asked, wherever the card is drawn: a reopened chat replays the
  // card before the prompt that asked about it, into a page fragment that isn't in the log yet.
  function markPipReportsNamedIn(text) {
    for (const [runId] of String(text || "").matchAll(/\brun_[0-9a-f]{32}\b/g)) {
      for (const root of new Set([log, appendTarget])) {
        for (const card of root.querySelectorAll(`.pip-report[data-run="${runId}"]`)) markPipReportAsked(card);
      }
    }
  }
  function markPipReportAsked(card) {
    for (const fix of card?.querySelectorAll(".pip-report-fix, .pip-report-fix-slim") || []) {
      fix.disabled = true; fix.textContent = "Asked DGC"; fix.classList.add("asked");
      fix.title = "This report's prompt was sent in this chat.";
    }
  }
  function askDgcToFix(r, card) {
    if (pipFixLive) { startPipFix(r, card); return; }   // a background fix in this chat, never a turn
    if (pipReportAsked(r.run_id)) { markPipReportAsked(card); return; }
    if (!sessionReady) { sysLine("DGC is reconnecting to this chat. Ask again in a moment."); return; }
    if (pendingPrompts.size >= 17) { sysLine("Wait for the pending messages to be acknowledged before sending another.", true); return; }
    const text = pipReportPrompt(r);
    const m = el("div", "msg user"); m.appendChild(el("div", "role", "you"));
    const bubble = el("div", "bubble");
    fillUserBubble(bubble, text, []);
    m.appendChild(bubble); log.appendChild(m); settleBlock(m);
    const requestId = `${promptPrefix}-${++promptSequence}`;
    m.dataset.promptId = requestId;
    pendingPrompts.set(requestId, { text, attachments: [], node: m, session: draftSession });
    vscode.postMessage({ type: "prompt", text, requestId, restore: { text, attachments: [] }, delivery: "queue" });
    markPipReportAsked(card);
    setSending(true); scroll();
    speak(`Asked DGC to fix what ${r.name} reported.`);
  }
  // From a Pip's own chat. A page with a chat sends it here, as the card would. The side bar's Sessions home has no
  // chat: the host opens the chat the Pip reports to (or a new one) in its tab, and that chat sends it (pipAskDgc).
  function askDgcFromPips(r, session) {
    if (!validPipReport(r) || !PIP_REPORT_KINDS.includes(r.kind)) return "This run can't be sent to the Work chat.";
    if (chatPlace === "home") {
      vscode.postMessage({ type: "pipAskDgc", report: r, session: /^[A-Za-z0-9_-]{1,128}$/.test(String(session || "")) ? session : "" });
      return true;
    }
    closePips();
    askDgcToFix(r, null);
    return true;
  }
  // A run's post on the Pips page says what its fix did (Pips API 65); a click on that goes to the fix's card in the chat
  // it ran in, where Review, Undo, Watch and Stop are. This chat: close Pips and show it. Another: the host opens that
  // chat's tab (from the side bar's Sessions home or a session's tab), which shows it once its card is drawn.
  function openPipFixFromPips(session, runId) {
    if (!/^run_[0-9a-f]{32}$/.test(String(runId || ""))) return "This fix can't be shown.";
    const id = /^[A-Za-z0-9_-]{1,128}$/.test(String(session || "")) ? String(session) : "";
    if (!id) return "DGC can't tell which chat this fix ran in.";
    if (chatPlace !== "home" && id === draftSession) { closePips(); showPipFix(runId); return true; }
    if (chatPlace === "chat") return "This fix ran in another chat. Open that chat from your sessions to review or undo it.";
    vscode.postMessage({ type: "pipOpenFix", session: id, run_id: runId });
    return true;
  }
  let pipFixShow = null;                  // {run, until}: the card to show once it is drawn (a chat just opened replays first)
  function showPipFix(runId) {
    const card = replaying ? null : pipFixCards(runId).filter((c) => c.isConnected).at(-1);
    if (!card) {
      if (pipFixShow?.run !== runId) pipFixShow = { run: runId, until: Date.now() + 20000 };
      if (Date.now() < pipFixShow.until) setTimeout(() => { if (pipFixShow?.run === runId) showPipFix(runId); }, 400);
      else pipFixShow = null;
      return;
    }
    pipFixShow = null;
    card.scrollIntoView?.({ block: "center" });
    card.classList.remove("prompt-flash"); void card.offsetWidth; card.classList.add("prompt-flash");
    setTimeout(() => card.classList.remove("prompt-flash"), 1600);
  }
  // A chat a Pip's Ask DGC to fix opened: it sends once this chat is ready and its transcript is in, so a run already
  // asked about here is not asked again.
  const pipAsks = [];
  function queuePipAsk(r) {
    if (!validPipReport(r) || !PIP_REPORT_KINDS.includes(r.kind) || pipAsks.length >= 8) return;
    pipAsks.push(r);
    flushPipAsks();
  }
  function flushPipAsks() {
    if (!sessionReady || replaying) return;
    while (pipAsks.length) {
      const r = pipAsks.shift();
      if (pipFixLive ? !pipFixActive(pipFixes.get(r.run_id)) : !pipReportAsked(r.run_id)) askDgcToFix(r, null);
    }
  }
  function pipReportCard(r) {
    const quiet = r.outcome === "clear" || r.outcome === "checks_passed" || r.outcome === "live_clear";
    const card = el("div", `pip-report${quiet ? " quiet" : ""}`);
    card.dataset.run = r.run_id; card.dataset.outcome = r.outcome;
    card._report = r;
    const state = pipReportState(r);
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", `Pip report from ${r.name}: ${state}`);
    const face = el("span", "pip-report-face");
    face.setAttribute("aria-hidden", "true");
    const pose = r.outcome === "failed" || r.outcome === "checks_failed" ? "failure"
      : r.outcome === "findings" || r.outcome === "live_attention" ? "waiting_approval" : "success";
    try {
      if (window.PipConcepts?.plush) face.innerHTML = window.PipConcepts.plush.markup(
        { index: PIP_REPORT_TYPES.indexOf(r.pip_type), name: r.name }, pose, `pip-report-${r.run_id.slice(4, 16)}`,
        { includeStyles: !document.getElementById("plush-styles") && !document.getElementById("pips-plush-styles") });   // alive like the Pips button's Core (the founder, 19 Oct)
    } catch { face.replaceChildren(); }
    const main = el("div", "pip-report-main");
    const head = el("div", "pip-report-head");
    head.append(el("span", "pip-report-name"), el("span", "pip-report-state"));
    head.firstChild.textContent = r.name.slice(0, 120);
    head.lastChild.textContent = state;
    const time = window.DgcTime?.node(Date.parse(String(r.finished_at || "")), "pip-report-when");
    if (time) head.append(time);
    main.append(head);
    if (r.outcome === "failed" && r.detail) {
      const detail = el("p", "pip-report-detail"); detail.textContent = String(r.detail).slice(0, 600); main.append(detail);
    }
    if ((r.outcome === "live_clear" || r.outcome === "live_attention") && r.summary) {
      const summary = el("p", "pip-report-detail pip-report-summary"); summary.textContent = String(r.summary).slice(0, 600); main.append(summary);
    }
    const rows = r.outcome === "findings" ? (Array.isArray(r.findings) ? r.findings : []).slice(0, 3)
      : r.outcome === "checks_failed" ? (Array.isArray(r.failed_checks) ? r.failed_checks : []).slice(0, 3).map((title) => ({ title, severity: "failed" }))
      : r.outcome === "live_attention" ? (Array.isArray(r.failed_commands) ? r.failed_commands : []).slice(0, 3).map((title) => ({ title, severity: "failed" })) : [];
    if (rows.length) {
      const list = el("ul", "pip-report-findings");
      list.setAttribute("aria-label", r.outcome === "findings" ? "Top findings" : "Failed checks");
      for (const f of rows) {
        const li = el("li"), sev = el("span", "pip-report-sev"), title = el("span", "pip-report-title");
        sev.dataset.severity = PIP_REPORT_SEVERITIES.includes(f.severity) ? f.severity : "failed";
        sev.textContent = sev.dataset.severity;
        title.textContent = String(f.title || "").slice(0, 200);
        li.append(sev, title);
        if (typeof f.path === "string" && f.path) {
          const where = el("span", "pip-report-where");
          where.textContent = f.path.slice(0, 300) + (Number.isSafeInteger(f.line) && f.line > 0 ? `:${f.line}` : "");
          li.append(where);
        }
        list.append(li);
      }
      main.append(list);
    }
    const more = [];
    const total = Number.isSafeInteger(r.total) ? r.total : 0;
    if (r.outcome === "findings" && total > rows.length) more.push(`${total - rows.length} more in the report`);
    if (Number.isSafeInteger(r.earlier) && r.earlier > 0) more.push(`${pipReportPlural(r.earlier, "earlier run")} not shown`);
    if (more.length) { const p = el("p", "pip-report-more"); p.textContent = more.join(" · "); main.append(p); }
    const actions = el("div", "pip-report-actions");
    const button = (label, cls, title, fn, into = actions) => {
      const b = el("button", cls); b.type = "button"; b.textContent = label; b.title = title;
      b.onclick = (event) => { event.stopPropagation(); fn(); }; into.append(b); return b;
    };
    const fixTitle = pipFixLive
      ? "DGC fixes it in the background, in a copy of the project, while you keep working. It never changes live data or services; Undo puts your files back."
      : "Send DGC a message asking it to read this report and fix what it found. It asks you before changing live data or services.";
    const openReport = () => { showPips(); pipsApp?.navigate?.({ pip: r.pip_id, section: "runs", run: r.run_id }); };
    const dismiss = () => {
      const group = card.parentElement?.closest(".pip-report-group");
      const next = card.nextElementSibling || group?.nextElementSibling;
      card.remove();
      if (group) paintPipReportGroup(group);
      if (pipReportsLive) vscode.postMessage({ type: "pipReportDismiss", run_id: r.run_id });
      (next?.querySelector?.("button, [tabindex='0']") || input).focus({ preventScroll: true });
    };
    if (!quiet) button("Ask DGC to fix", "act primary pip-report-fix", fixTitle, () => askDgcToFix(r, card));
    button("Open report", "act pip-report-open", `Open this run of ${r.name} in Pips`, openReport);
    button("Dismiss", "act pip-report-dismiss", "Remove this card from the chat. The report stays in Pips.", dismiss);
    main.append(actions);
    // Two lines until opened (the founder, 19 Oct: the cards took too much room). Line one: the Pip, what it found,
    // when, and a chevron; line two: the worst finding or why it failed, with Fix, Open and Dismiss. A clean run is
    // the first line alone. Opening shows the whole card below them (today's), so nothing is drawn twice.
    card.classList.add("slim"); card.dataset.shown = "closed";
    card.dataset.total = String(Number.isSafeInteger(r.total) ? r.total : 0);
    const short = pipReportShort(r);
    const line1 = el("div", "pip-report-line1");
    line1.tabIndex = 0; line1.setAttribute("role", "button"); line1.setAttribute("aria-expanded", "false");
    line1.setAttribute("aria-label", `${r.name}: ${state}. Show details`);
    const name1 = el("span", "pip-report-line-name"); name1.textContent = r.name.slice(0, 120);
    const state1 = el("span", "pip-report-line-state"); state1.textContent = short.text;
    if (short.bad) state1.dataset.bad = "";
    line1.append(name1, state1, el("span", "pip-report-fill"));
    const time1 = window.DgcTime?.node(Date.parse(String(r.finished_at || "")), "pip-report-line-when");
    if (time1) line1.append(time1);
    const slimActs = el("span", "pip-report-slim-actions");
    if (!quiet) button("Fix", "pip-report-fix-slim", fixTitle, () => askDgcToFix(r, card), slimActs);
    button("Open", "pip-report-open-slim", `Open this run of ${r.name} in Pips`, openReport, slimActs);
    const x = button("", "pip-report-dismiss-slim", "Dismiss: remove this card from the chat. The report stays in Pips.", dismiss, slimActs);
    x.setAttribute("aria-label", "Dismiss"); x.innerHTML = '<span class="codicon codicon-close" aria-hidden="true"></span>';
    const chevron = el("span", "pip-report-chevron codicon codicon-chevron-right"); chevron.setAttribute("aria-hidden", "true");
    const fold = (open = card.dataset.shown !== "open") => {
      card.dataset.shown = open ? "open" : "closed"; line1.setAttribute("aria-expanded", String(open));
    };
    line1.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); fold(); } });
    card.addEventListener("click", (event) => { if (!event.target.closest("button, a, .pip-report-findings, .pip-report-detail, .pip-fix")) fold(); });
    if (quiet) { line1.append(slimActs, chevron); main.prepend(line1); }
    else {
      line1.append(chevron);
      const line2 = el("div", "pip-report-line2");
      const sev = el("span", "pip-report-sev"), what = el("span", "pip-report-line-what");
      sev.dataset.severity = short.sev; sev.textContent = short.sev === "failed" ? "why" : short.sev;
      what.textContent = short.what;
      line2.append(sev, what);
      if (short.where) { const where = el("span", "pip-report-where"); where.textContent = short.where; line2.append(where); }
      line2.append(el("span", "pip-report-fill"), slimActs);
      main.prepend(line1, line2);
    }
    card.append(face, main);
    if (!quiet && !pipFixLive && pipReportAsked(r.run_id)) markPipReportAsked(card);
    return card;
  }
  // The card's first two lines, from the report: "5 findings · 2 high" and the worst finding; "failed" and why.
  function pipReportShort(r) {
    const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
    const top = Array.isArray(r.findings) ? r.findings[0] : null;
    if (r.outcome === "failed") return { text: "failed", bad: true, sev: "failed", what: String(r.reason || "It stopped with an error.").slice(0, 300) };
    if (r.outcome === "clear") return { text: "nothing found" };
    if (r.outcome === "checks_passed" || r.outcome === "live_clear") return { text: pipReportState(r).replace(/^finished · /, "") };
    if (r.outcome === "live_attention") {
      // The summary says why in its own words: no "why" label before it.
      return { text: pipReportState(r), bad: true, sev: "", what: String(r.summary || "It needs you.").slice(0, 300) };
    }
    if (r.outcome === "checks_failed") {
      return { text: pipReportState(r).replace(/^finished · /, ""), bad: true, sev: "failed",
               what: String((Array.isArray(r.failed_checks) && r.failed_checks[0]) || "A check failed.").slice(0, 300) };
    }
    const high = n(r.counts?.critical) + n(r.counts?.high);
    return { text: `${pipReportPlural(n(r.total), "finding")}${high ? ` · ${high} high` : ""}`, bad: high > 0,
             sev: PIP_REPORT_SEVERITIES.includes(top?.severity) ? top.severity : "", what: String(top?.title || "").slice(0, 200),
             where: typeof top?.path === "string" && top.path ? top.path.slice(0, 300) + (Number.isSafeInteger(top.line) && top.line > 0 ? `:${top.line}` : "") : "" };
  }
  // Two or more reports with nothing between them are one line until opened: "3 Pip reports · 1 failed · 5 findings"
  // (from two since the founder, 24 Oct: two still stacked as two cards).
  function groupPipReports(card) {
    if (!card?.parentNode) return;
    // A card with a fix is the fix's status: it stays a card of its own, and breaks a run of reports.
    const groupable = (node) => node?.matches(".pip-report:not([data-fix]), .pip-report-group");
    if (!groupable(card)) return;
    let start = card;
    while (groupable(start.previousElementSibling)) start = start.previousElementSibling;
    const run = [];
    for (let node = start; node && groupable(node); node = node.nextElementSibling) run.push(node);
    const cards = run.flatMap((node) => (node.matches(".pip-report-group") ? [...node.querySelectorAll(":scope > .pip-report")] : [node]));
    if (cards.length < 2) return;
    let group = run.find((node) => node.matches(".pip-report-group"));
    if (!group) {
      group = el("div", "pip-report-group"); group.dataset.shown = "closed";
      const head = el("button", "pip-report-group-head"); head.type = "button"; head.setAttribute("aria-expanded", "false");
      head.addEventListener("click", () => {
        const open = group.dataset.shown !== "open";
        group.dataset.shown = open ? "open" : "closed"; head.setAttribute("aria-expanded", String(open));
      });
      group.append(head);
      start.before(group);
    }
    for (const c of cards) if (c.parentNode !== group) group.append(c);
    for (const other of run) if (other !== group && other.matches(".pip-report-group")) other.remove();
    paintPipReportGroup(group);
  }
  function paintPipReportGroup(group) {
    const cards = [...group.querySelectorAll(":scope > .pip-report")];
    if (cards.length < 2) { for (const c of cards) group.before(c); group.remove(); return; }
    const failed = cards.filter((c) => c.dataset.outcome === "failed" || c.dataset.outcome === "checks_failed").length;
    const findings = cards.reduce((sum, c) => sum + (c.dataset.outcome === "findings" ? Number(c.dataset.total) || 0 : 0), 0);
    const clear = cards.filter((c) => ["clear", "checks_passed", "live_clear"].includes(c.dataset.outcome)).length;
    const attention = cards.filter((c) => c.dataset.outcome === "live_attention").length;
    const parts = [failed && `${failed} failed`, findings && pipReportPlural(findings, "finding"),
                   attention && `${attention} need${attention === 1 ? "s" : ""} you`, clear && `${clear} clear`].filter(Boolean);
    const head = group.querySelector(":scope > .pip-report-group-head");
    const faces = el("span", "pip-report-group-faces"); faces.setAttribute("aria-hidden", "true");
    for (const c of cards.slice(-3)) { const f = el("span"); f.innerHTML = c.querySelector(".pip-report-face")?.innerHTML || ""; faces.append(f); }
    const title = el("span", "pip-report-group-title");
    const lead = el("b"); lead.textContent = `${cards.length} Pip reports`;
    title.append(lead, document.createTextNode(parts.length ? ` · ${parts.join(" · ")}` : ""));
    const when = cards.at(-1).querySelector(".pip-report-line-when")?.cloneNode(true);
    const chevron = el("span", "pip-report-chevron codicon codicon-chevron-right"); chevron.setAttribute("aria-hidden", "true");
    head.replaceChildren(faces, title, ...(when ? [when] : []), chevron);
    head.setAttribute("aria-label", `${cards.length} Pip reports${parts.length ? `: ${parts.join(", ")}` : ""}. Show them`);
  }
  function renderPipReport(r) {
    if (!validPipReport(r)) return;
    // One card per run: a replay replaces the live card it repeats.
    for (const old of [...log.querySelectorAll(".pip-report")]) {
      if (old.dataset.run !== r.run_id) continue;
      const group = old.parentElement?.closest(".pip-report-group");
      old.remove();
      if (group) paintPipReportGroup(group);
    }
    const card = pipReportCard(r);
    if (r.fix) applyPipFix(r.fix, { quiet: true });          // a replayed card carries its latest fix
    const fix = pipFixes.get(r.run_id);
    if (replaying) {
      card.classList.add("hist"); appendTarget.appendChild(card);
      if (fix) paintPipFixCard(card, fix); else groupPipReports(card);
      return;
    }
    const stick = atBottom();
    log.appendChild(card);
    if (fix) paintPipFixCard(card, fix); else groupPipReports(card);
    speak(`Pip ${r.name} ${pipReportState(r)}`);
    if (stick || following) scroll(); else noteNewContent();
  }
  // ---- Ask DGC to fix, in the background (ready.capabilities.pip_fix) ----
  // The founder (19 Oct): the fix is a background sub-agent of this chat, never a turn, so the chat stays free. Its
  // report's card IS its status: what it is doing, Watch (the agent's page) and Stop; a permission it needs is asked
  // on the card; when it ends, what changed, whether tests ran in the fix copy, Review and Undo. Every state comes
  // from the backend as `pip_fix`; a replayed card carries its latest fix as `report.fix`, so a reload draws the same.
  let pipFixTick = null;
  function pipFixActive(fix) { return PIP_FIX_ACTIVE.includes(fix?.state); }
  const validPipFix = (fix) => !!fix && typeof fix === "object" && /^fix_[0-9a-f]{32}$/.test(String(fix.fix_id || ""))
    && /^run_[0-9a-f]{32}$/.test(String(fix.run_id || "")) && typeof fix.state === "string";
  function pipFixByAgent(agentId) {
    for (const fix of pipFixes.values()) if (fix.agent_id && fix.agent_id === agentId) return fix;
    return null;
  }
  function pipFixCards(runId) {
    return [...new Set([log, appendTarget])].flatMap((root) => [...root.querySelectorAll(`.pip-report[data-run="${runId}"]`)]);
  }
  // A record arrived: keep it (an older one of the same report never replaces a newer one) and paint its card.
  function applyPipFix(fix, { quiet = false } = {}) {
    if (!validPipFix(fix)) return;
    const had = pipFixes.get(fix.run_id);
    if (had && had.fix_id !== fix.fix_id && Number(had.created_at || 0) > Number(fix.created_at || 0)) return;
    const was = had?.fix_id === fix.fix_id ? had.state : "";
    const next = { ...fix, _seen: quiet || (had?.fix_id === fix.fix_id && had._seen && !(pipFixActive(had) && !pipFixActive(fix))) };
    pipFixes.set(fix.run_id, next);
    if (next.agent_id && agentLineOf(next.agent_id)?.provisional) pruneProvisionalLines();   // the card is its line
    for (const card of pipFixCards(fix.run_id)) paintPipFixCard(card, next);
    if (!quiet && was !== next.state && !pipFixActive(next) && was) speak(`${next.name || "The Pip"}'s fix ${pipFixHeadline(next).toLowerCase()}`);
    syncPipFixTick();
    syncComposerRail();
    if (railOpen?.kind === "pipfixes") paintPipFixesPanel();
  }
  function pipFixPlural(n, word) { return `${n} ${word}${n === 1 ? "" : "s"}`; }
  function pipFixCounts(fix) {
    const files = Array.isArray(fix.files) ? fix.files : [];
    const counted = files.filter((f) => f.counted !== false);
    return { files, add: counted.reduce((n, f) => n + (Number(f.additions) || 0), 0),
             del: counted.reduce((n, f) => n + (Number(f.deletions) || 0), 0), counted: counted.length > 0 };
  }
  // The card's one status line, in words: "Fixing · Running npm test", "Fixed · 2 files", "Stopped".
  function pipFixHeadline(fix) {
    const agent = fix.agent_id ? agentRecords.get(fix.agent_id) : null;
    const { files } = pipFixCounts(fix);
    const held = Array.isArray(fix.held) ? fix.held.length : 0;
    switch (fix.state) {
      case "queued": return fix.queued_behind ? `Waiting · starts after the fix for ${fix.queued_behind}`
        : String(fix.step || "Waiting to start");
      case "preparing": return agent?.state === "waiting" ? "Needs you" : String(fix.step || "Getting the fix copy ready");
      case "running": {
        if (agent?.state === "waiting") return "Needs you";
        const step = pipFixSteps.get(fix.agent_id);
        return step ? `Fixing · ${step}` : "Fixing";
      }
      case "applying": return "Applying the fix";
      case "applied": return files.length ? `Fixed · ${pipFixPlural(files.length, "file")} changed` : "Fixed";
      case "partial": return `Fixed ${pipFixPlural(files.length, "file")} · ${held} held back`;
      case "unchanged": return "Nothing to change";
      case "not_applied": return "Not applied";
      case "failed": return "The fix didn't finish";
      case "stopped": return "Stopped";
      case "interrupted": return "Interrupted";
      case "undone": return "Undone";
      default: return "Fix";
    }
  }
  function pipFixTests(fix) {
    const t = fix.tests && typeof fix.tests === "object" ? fix.tests : null;
    if (!t) return null;
    const command = t.command ? ` · ${String(t.command).slice(0, 160)}` : "";
    const note = t.note ? `: ${String(t.note).slice(0, 200)}` : "";
    if (t.state === "passed") return { text: `Tests passed in the fix copy${command}`, tone: "ok" };
    if (t.state === "failed") return { text: `Tests failed in the fix copy${command}${note}`, tone: "bad" };
    return { text: `Tests didn't run in the fix copy${note}`, tone: "muted" };
  }
  function pipFixElapsed(fix) {
    const from = Number(fix.started_at || fix.created_at || 0) * 1000;
    if (!from) return "";
    const to = pipFixActive(fix) ? Date.now() : Number(fix.ended_at || 0) * 1000;
    return to > from ? agentElapsed(to - from) : "";
  }
  function syncPipFixTick() {
    const live = [...pipFixes.values()].some(pipFixActive);
    if (live && !pipFixTick) {
      pipFixTick = setInterval(() => {
        for (const fix of pipFixes.values()) {
          if (!pipFixActive(fix)) continue;
          for (const card of pipFixCards(fix.run_id)) {
            const time = card.querySelector(".pip-fix-time");
            if (time) time.textContent = pipFixElapsed(fix);
          }
        }
      }, 1000);
      if (typeof pipFixTick?.unref === "function") pipFixTick.unref();
    }
    if (!live && pipFixTick) { clearInterval(pipFixTick); pipFixTick = null; }
  }
  // Paint one card from its fix. The fix area is its own line under the card's two, shown open or closed, and the card
  // leaves a folded group of reports: a running fix is never out of sight behind "3 Pip reports".
  // A finished fix is one line (founder, 24 Oct): what it did, the totals, its time, Review / Undo / Watch. What it changed,
  // its tests and summary open under that line with a click on it, and stay as the user left them while the card repaints.
  const pipFixOpen = new Set();
  function paintPipFixCard(card, fix) {
    if (!card || !fix) return;
    const group = card.parentElement?.closest(".pip-report-group");
    if (group) { group.after(card); paintPipReportGroup(group); }
    card.dataset.fix = fix.state;
    // The fix's own line replaces Fix (and puts back what a click on it said while it started).
    for (const button of card.querySelectorAll(".pip-report-fix, .pip-report-fix-slim")) {
      button.hidden = true; button.disabled = false;
      button.textContent = button.classList.contains("pip-report-fix") ? "Ask DGC to fix" : "Fix";
    }
    const main = card.querySelector(".pip-report-main");
    let area = card.querySelector(".pip-fix");
    if (!area) {
      area = el("div", "pip-fix");
      area.setAttribute("role", "group");
      const ask = el("div", "pip-fix-ask");
      area._ask = ask;
      const line2 = main?.querySelector(":scope > .pip-report-line2") || main?.querySelector(":scope > .pip-report-line1");
      if (line2) line2.after(area); else main?.append(area);
    }
    const ask = area.querySelector(":scope > .pip-fix-ask") || area._ask;
    area.dataset.state = fix.state;
    const agent = fix.agent_id ? agentRecords.get(fix.agent_id) : null;
    const waiting = agent?.state === "waiting" && pipFixActive(fix);
    area.toggleAttribute("data-waiting", waiting);
    area.setAttribute("aria-label", `Fix: ${pipFixHeadline(fix)}`);
    const line = el("div", "pip-fix-line");
    const mark = el("span", `pip-fix-mark codicon codicon-${pipFixActive(fix) ? (waiting ? "bell-dot" : "loading codicon-modifier-spin") : fix.state === "applied" || fix.state === "partial" ? "check" : fix.state === "undone" ? "discard" : fix.state === "unchanged" ? "pass" : "circle-slash"}`);
    mark.setAttribute("aria-hidden", "true");
    const text = el("span", "pip-fix-text"); text.textContent = pipFixHeadline(fix);
    line.append(mark, text);
    const { files, add, del, counted } = pipFixCounts(fix);
    if ((fix.state === "applied" || fix.state === "partial") && counted) {
      const totals = el("span", "pip-fix-totals");
      totals.innerHTML = `<span class="change-add">+${add}</span><span class="change-del">−${del}</span>`;
      line.append(totals);
    }
    const time = el("span", "pip-fix-time"); time.textContent = pipFixElapsed(fix);
    line.append(el("span", "pip-report-fill"), time);
    const acts = el("span", "pip-fix-actions");
    const act = (label, cls, title, run) => {
      const b = el("button", `pip-fix-act ${cls}`); b.type = "button"; b.textContent = label; b.title = title;
      b.onclick = (event) => { event.stopPropagation(); fix._seen = true; run(b); };
      acts.append(b); return b;
    };
    const canWatch = !!(fix.agent_id && agentRecords.has(fix.agent_id));
    if (pipFixActive(fix)) {
      if (canWatch && fix.state !== "queued") act("Watch", "pip-fix-watch", "See what the fix is doing, step by step", (b) => openAgentPage(fix.agent_id, { from: b }));
      act("Stop", "pip-fix-stop", "Stop this fix. Nothing in your project changes.", (b) => {
        b.disabled = true; b.textContent = "Stopping…";
        vscode.postMessage({ type: "stopAgent", id: fix.agent_id });
      });
    } else {
      const undoable = (fix.undo?.state === "available") && files.length > 0;
      const reviewable = files.length > 0 || (Array.isArray(fix.held) && fix.held.length > 0);
      if (reviewable && fix.state !== "undone") act("Review", "pip-fix-review", "Open the diff of what the fix changed", () => reviewPipFix(fix));
      if (undoable) act("Undo", "pip-fix-undo", "Put these files back as they were before the fix", (b) => {
        vscode.postMessage({ type: "undoPipFix", fix_id: fix.fix_id, files: files.length });
      });
      if (["failed", "stopped", "interrupted", "not_applied", "undone"].includes(fix.state) && validPipReport(card._report)) {
        act("Try again", "pip-fix-again", "Start a new fix of this report", () => startPipFix(card._report, card));
      }
      if (canWatch && fix.state !== "undone") act("Watch", "pip-fix-watch", "See what the fix did, step by step", (b) => openAgentPage(fix.agent_id, { from: b }));
    }
    line.append(acts);
    const body = [line];
    // Files: three, then how many more; each opens its diff.
    if ((fix.state === "applied" || fix.state === "partial") && files.length) {
      const list = el("ul", "pip-fix-files");
      list.setAttribute("aria-label", "Files the fix changed");
      for (const f of files.slice(0, 3)) {
        const li = el("li");
        const open = el("button", "pip-fix-file"); open.type = "button";
        open.title = `Review ${f.path}`;
        open.onclick = (event) => { event.stopPropagation(); fix._seen = true; reviewPipFix(fix, [f.path]); };
        open.textContent = String(f.path || "").slice(0, 300);
        li.append(open);
        if (f.kind === "added") li.append(el("span", "pip-fix-kind", "new"));
        else if (f.kind === "deleted") li.append(el("span", "pip-fix-kind", "deleted"));
        if (f.counted !== false) {
          const n = el("span", "pip-fix-counts");
          n.innerHTML = `<span class="change-add">+${Number(f.additions) || 0}</span><span class="change-del">−${Number(f.deletions) || 0}</span>`;
          li.append(n);
        }
        list.append(li);
      }
      if (files.length > 3) list.append(el("li", "pip-fix-more", `${files.length - 3} more`));
      body.push(list);
    }
    for (const h of (Array.isArray(fix.held) ? fix.held : []).slice(0, 3)) {
      const p = el("p", "pip-fix-held");
      const what = el("button", "pip-fix-file"); what.type = "button"; what.textContent = String(h.path || "");
      what.title = `Review what the fix would change in ${h.path}`;
      what.onclick = (event) => { event.stopPropagation(); fix._seen = true; reviewPipFix(fix, [h.path]); };
      p.append(document.createTextNode("Held back: "), what, document.createTextNode(` · ${String(h.why || "you changed it while it worked")}`));
      body.push(p);
    }
    if (Array.isArray(fix.merged) && fix.merged.length && fix.state !== "undone") {
      body.push(el("p", "pip-fix-note", `Merged with your changes: ${fix.merged.slice(0, 3).join(", ")}`));
    }
    const tests = pipFixActive(fix) || fix.state === "undone" ? null : pipFixTests(fix);
    if (tests) { const p = el("p", `pip-fix-tests tone-${tests.tone}`); p.textContent = tests.text; body.push(p); }
    if (fix.message && !pipFixActive(fix)) body.push(el("p", "pip-fix-note", String(fix.message).slice(0, 400)));
    if (fix.undo && (fix.undo.state === "done" || fix.undo.state === "partial")) {
      const restored = Array.isArray(fix.undo.restored) ? fix.undo.restored.length : 0;
      const kept = Array.isArray(fix.undo.kept) ? fix.undo.kept : [];
      body.push(el("p", "pip-fix-note", `Put back ${pipFixPlural(restored, "file")}.`
        + (kept.length ? ` Kept ${kept.map((k) => `${k.path} (${k.why})`).slice(0, 3).join(", ")}.` : "")));
    }
    if (fix.summary && !pipFixActive(fix) && fix.state !== "undone") {      // undone, "Put back 2 files." says it all
      const p = el("p", "pip-fix-summary"); p.textContent = String(fix.summary).slice(0, 400); p.title = p.textContent; body.push(p);
    }
    const details = body.slice(1);
    if (!pipFixActive(fix) && details.length) {
      const open = pipFixOpen.has(fix.fix_id);
      const toggle = el("button", "pip-fix-toggle"); toggle.type = "button";
      const box = el("div", "pip-fix-details");
      box.id = `pip-fix-details-${String(fix.fix_id).replace(/[^\w-]/g, "")}`;
      box.hidden = !open;
      box.append(...details);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-controls", box.id);
      toggle.title = open ? "Hide what the fix changed" : "Show what the fix changed, its tests and its summary";
      toggle.append(mark, text, el("span", `pip-fix-chevron codicon codicon-chevron-${open ? "down" : "right"}`));
      toggle.onclick = (event) => {
        event.stopPropagation(); fix._seen = true;
        if (pipFixOpen.has(fix.fix_id)) pipFixOpen.delete(fix.fix_id); else pipFixOpen.add(fix.fix_id);
        paintPipFixCard(card, pipFixes.get(fix.run_id) || fix);
      };
      line.prepend(toggle);
      body.length = 1;
      body.push(box);
    }
    const keepFocus = area.contains(document.activeElement) && !ask.contains(document.activeElement)
      ? document.activeElement.className : "";
    // An answered request leaves the card (the line says what happens next); one still open when the fix ends goes too.
    for (const request of ask.querySelectorAll(".card")) {
      if (request.classList.contains("resolved") || !pipFixActive(fix)) request.remove();
    }
    area.replaceChildren(...body, ask);
    if (keepFocus) area.querySelector(`.${String(keepFocus).split(" ").filter(Boolean).join(".")}`)?.focus({ preventScroll: true });
  }
  function startPipFix(r, card) {
    if (!validPipReport(r)) return;
    const had = pipFixes.get(r.run_id);
    if (pipFixActive(had)) return;
    if (!sessionReady) { sysLine("DGC is reconnecting to this chat. Ask again in a moment."); return; }
    vscode.postMessage({ type: "startPipFix", run_id: r.run_id });
    for (const c of card ? [card] : pipFixCards(r.run_id)) {
      for (const button of c.querySelectorAll(".pip-report-fix, .pip-report-fix-slim, .pip-fix-again")) {
        button.disabled = true; button.textContent = "Starting…";
      }
    }
    speak(`DGC is fixing what ${r.name} reported, in the background.`);
  }
  // Review: one file opens its diff; several are offered to pick from (the host does both).
  function reviewPipFix(fix, paths) {
    const all = [...(Array.isArray(fix.files) ? fix.files : []), ...(Array.isArray(fix.held) ? fix.held : [])]
      .map((f) => String(f.path || "")).filter(Boolean);
    vscode.postMessage({ type: "reviewPipFix", fix_id: fix.fix_id, paths: (paths || all).slice(0, 50) });
  }
  // A refused start or undo: the card says why, and its button comes back.
  function pipFixRefused(ev) {
    const card = [...log.querySelectorAll(".pip-report")].find((c) => c.querySelector(".pip-report-fix[disabled], .pip-report-fix-slim[disabled], .pip-fix-again[disabled]"));
    for (const c of card ? [card] : []) {
      for (const button of c.querySelectorAll(".pip-report-fix, .pip-report-fix-slim, .pip-fix-again")) {
        button.disabled = false;
        button.textContent = button.classList.contains("pip-report-fix") ? "Ask DGC to fix"
          : button.classList.contains("pip-fix-again") ? "Try again" : "Fix";
      }
    }
    sysLine(ev.message || "DGC couldn't do that.", true);
  }
  // A permission the fix needs is asked on its card (and the agents pill says an agent needs you).
  function pipFixAskHome(callId) {
    const id = agentIdFromCall(callId);
    const fix = id ? pipFixByAgent(id) : null;
    if (!fix) return null;
    const card = pipFixCards(fix.run_id).find((c) => c.isConnected) || null;
    const area = card?.querySelector(".pip-fix");
    return area ? (area.querySelector(":scope > .pip-fix-ask") || area._ask) : null;
  }
  function fixAskCard(home, inner) {
    const c = el("div", "card pip-fix-request");
    c.setAttribute("role", "group"); c.setAttribute("aria-label", "The fix asks for your permission");
    c.innerHTML = inner;
    home.append(c);
    return c;
  }
  // What the fixer does now, from its own steps: the card's "Fixing · Running npm test".
  function pipFixStepFrom(ev) {
    const id = agentIdFromCall(ev.call_id);
    const fix = id ? pipFixByAgent(id) : null;
    if (!fix || !pipFixActive(fix)) return;
    const copy = toolCopy(ev.name);
    const what = String(ev.summary || "").replace(/\s+/g, " ").trim().slice(0, 80);
    pipFixSteps.set(id, `${copy.present}${what ? ` ${what}` : ""}`);
    for (const card of pipFixCards(fix.run_id)) {
      const text = card.querySelector(".pip-fix-text");
      if (text) text.textContent = pipFixHeadline(fix);
    }
  }
  function pipFixAgentChanged(id) {
    const fix = pipFixByAgent(id);
    if (!fix) return;
    for (const card of pipFixCards(fix.run_id)) paintPipFixCard(card, fix);
    syncComposerRail();
    if (railOpen?.kind === "pipfixes") paintPipFixesPanel();
  }
  function pipFixesReset(kind) {
    if (kind === "rewound") return;               // the same chat: its history brings each card's fix back
    pipFixes.clear(); pipFixSteps.clear();
    syncPipFixTick();
    if (pipFixLive && kind === "resumed") vscode.postMessage({ type: "listPipFixes" });
  }
  // The "Pip fixes" chip on the chip line (never a row of its own): this chat's fixes that are working, or ended and
  // not looked at yet. General background work stays in the agents pill.
  function pipFixesForChip() {
    return [...pipFixes.values()].filter((fix) => pipFixActive(fix) || !fix._seen)
      .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
  }
  // ---- Pips running now (ready.capabilities.pip_runs_running) ----
  // The founder (24 Oct): a Pip that reports to this chat runs in the Pips runner, and the chat said nothing until its
  // card arrived. Now a chip says so while it runs ("Billing audit running · 0:42", "2 Pips running"); a click opens
  // that Pip's chat on the Pips page, at the run's live post (with two or more, a list to pick from). It goes when the
  // run ends, and the card arrives as before. Pips that report to other chats show nothing here.
  const PIP_STARTED = { schedule: "On schedule", event: "From an event", you: "Started by you", chat: "Asked by DGC",
    handoff: "From another Pip", setup: "First run" };
  let pipRunningTick = null;
  function pipRunningList() {
    return [...pipRunning.values()].sort((a, b) => a.at - b.at || (a.run_id < b.run_id ? -1 : 1));
  }
  function pipRunningSeconds(run) { return Math.max(0, (Date.now() - run.at) / 1000); }
  function pipStartedWords(run) { return PIP_STARTED[run.trigger] || "Started by you"; }
  function setPipRunning(items) {
    pipRunning.clear();
    for (const item of (Array.isArray(items) ? items : []).slice(0, 16)) {
      if (!item || typeof item !== "object" || !/^run_[0-9a-f]{32}$/.test(String(item.run_id || ""))
        || !/^pip_[0-9a-f]{32}$/.test(String(item.pip_id || ""))) continue;
      const at = Date.parse(String(item.started_at || ""));
      pipRunning.set(item.run_id, { run_id: item.run_id, pip_id: item.pip_id, name: String(item.name || "A Pip").slice(0, 120),
        pip_type: String(item.pip_type || ""), trigger: String(item.trigger || ""), at: Number.isFinite(at) ? at : Date.now() });
    }
    if (pipRunning.size && !pipRunningTick) {
      // The chip's clock: once a second, only its face (a shape change refits the line).
      pipRunningTick = setInterval(() => {
        paintRailChip("piprunning");
        if (railOpen?.kind === "piprunning") paintPipRunningPanel();
      }, 1000);
      if (typeof pipRunningTick?.unref === "function") pipRunningTick.unref();
    }
    if (!pipRunning.size && pipRunningTick) { clearInterval(pipRunningTick); pipRunningTick = null; }
    if (railOpen?.kind === "piprunning" && pipRunning.size < 2) closeRailPop({ restore: false });
    syncComposerRail();
    if (railOpen?.kind === "piprunning") paintPipRunningPanel();
  }
  function openRunningPip(run) {
    if (railOpen) closeRailPop({ restore: false });
    showPips();
    pipsApp?.navigate?.({ pip: run.pip_id, section: "chat", run: run.run_id });
  }
  let pipRunningPanel = null;
  function paintPipRunningPanel() {
    if (!pipRunningPanel) { pipRunningPanel = el("section", "pip-running-panel"); pipRunningPanel.setAttribute("aria-label", "Pips running"); }
    const list = el("ul", "pip-fixes-list");
    for (const run of pipRunningList()) {
      const li = el("li");
      const go = el("button", "rail-main pip-fixes-row"); go.type = "button";
      go.dataset.run = run.run_id;
      go.title = `Open ${run.name}'s chat in Pips`;
      const name = el("span", "pip-fixes-name"); name.textContent = run.name;
      const state = el("span", "pip-fixes-state");
      state.textContent = `Running ${formatDuration(pipRunningSeconds(run))} · ${pipStartedWords(run)}`;
      go.append(name, state);
      go.onclick = () => openRunningPip(run);
      li.append(go);
      list.append(li);
    }
    const focused = pipRunningPanel.contains(document.activeElement) ? document.activeElement.dataset.run : "";
    pipRunningPanel.replaceChildren(list);
    if (focused) pipRunningPanel.querySelector(`[data-run="${focused}"]`)?.focus({ preventScroll: true });
    return pipRunningPanel;
  }
  let pipFixesPanel = null;
  function paintPipFixesPanel() {
    if (!pipFixesPanel) { pipFixesPanel = el("section", "pip-fixes-panel"); pipFixesPanel.setAttribute("aria-label", "Pip fixes"); }
    const list = el("ul", "pip-fixes-list");
    for (const fix of [...pipFixes.values()].sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0)).slice(0, 12)) {
      const li = el("li");
      const go = el("button", "rail-main pip-fixes-row"); go.type = "button";
      go.title = `Show ${fix.name || "this Pip"}'s report in the chat`;
      const name = el("span", "pip-fixes-name"); name.textContent = String(fix.name || "Pip").slice(0, 120);
      const state = el("span", "pip-fixes-state"); state.textContent = pipFixHeadline(fix);
      go.append(name, state);
      go.onclick = () => {
        fix._seen = true;
        const card = pipFixCards(fix.run_id).find((c) => c.isConnected);
        closeRailPop({ restore: false });
        syncComposerRail();
        if (card) { card.scrollIntoView?.({ block: "center" }); focusQuietly(card.querySelector(".pip-fix-act") || card.querySelector(".pip-report-line1"), { preventScroll: true }); }
      };
      li.append(go);
      list.append(li);
    }
    pipFixesPanel.replaceChildren(list);
    return pipFixesPanel;
  }
  // A saved steering message's send time (a {role: "time", of: "steering"} item just before it).
  let steeringAt = null;
  function legacyItem(it) {
    if (!it || typeof it !== "object") return;
    if (it.role === "time") {
      // When a saved turn's prompt was sent and its reply written (seconds since 1970, from the session file).
      const at = Number(it.at) * 1000;
      if (!turn || !Number.isFinite(at) || at <= 0) return;
      if (it.of === "prompt") { turn.promptAt = at; stampPrompt(turn.head, at); } else if (it.of === "reply") turn.replyAt = at;
      else if (it.of === "steering") steeringAt = at;      // the next steering item's time
      return;
    }
    if (it.role === "goal_edit") { sysLine(String(it.text || "")); return; }
    if (it.role === "pip_report") { renderPipReport(it.report); return; }
    if (it.role === "steering") {
      ensureTurn();
      const node = el("div", "msg user"); node.appendChild(el("div", "role", "you · steering"));
      setSteerState(node, "applied");        // it is in the transcript, so the model did read it
      const parsed = splitPromptMarks(String(it.text || "").slice(0, 50000));
      const bubble = el("div", "bubble");
      fillUserBubble(bubble, parsed.text, parsed.attachments);
      node.appendChild(bubble);
      if (steeringAt !== null) { stampPrompt(node, steeringAt); steeringAt = null; }
      placeSteering(node);
      return;
    }
    if (it.role === "compaction") {
      // Earlier turns were summarised so the run could keep going. Say so plainly; the summary
      // is the model's own context, available on request rather than pasted into the chat.
      const note = el("details", "compaction hist");
      note.innerHTML = `<summary>${icon("history")}`
        + "<span>Earlier conversation summarised to keep it in context</span></summary>";
      const body = el("pre", "compaction-body");
      body.textContent = String(it.text || "").slice(0, 20000);
      note.appendChild(body);
      appendTarget.appendChild(note);
      return;
    }
    if (it.role === "notice") { appendTarget.appendChild(el("div", "sys hist", esc(it.text))); return; }
    if (it.role === "monitor_restart") { monitorRestartLine(it, false); return; }
    if (it.role === "task_interrupted") { taskInterruptedLine(it, false); return; }
    if (it.role === "resume") { onEvent({ type: "turn_start", prompt: String(it.text || ""), kind: "resume" }); return; }
    if (it.role === "user") { onEvent({ type: "turn_start", prompt: String(it.text || ""), kind: "prompt" }); return; }
    if (it.role === "assistant" && it.text) {
      onEvent({ type: "text_delta", text: String(it.text) });
      onEvent({ type: "stream_end", phase: it.tools?.length ? "commentary" : "answer" });
    }
  }

  function renderHistory(items) {
    // Non-destructive: replace only the history block, and place it ABOVE any live
    // content. A resumed session's `history` event can arrive AFTER the user has
    // already sent a prompt (slow session load) — clearing the whole log here used
    // to wipe that just-sent prompt while the turn kept streaming.
    log.querySelectorAll(".hist").forEach((e) => e.remove());
    const history = el("div", "hist history-pages");
    const older = el("button", "act history-older", "Show earlier messages");
    older.title = "Load the previous page of this chat\u2019s history";
    history.appendChild(older);
    // Saved history IS the live event vocabulary, so a page of it renders by driving the same
    // reducer that renders a live turn: same classes, same answer promotion, same tool cards,
    // same diffs. What used to be here was a second projection with its own idea of what an
    // answer was, which is why a reloaded session read as one long wall of text.
    const units = historyUnits(items);
    let cursor = units.length;
    function page() {
      const frag = document.createDocumentFragment();
      // Take whole turns until the page is about fifty events deep, and never fewer than one.
      let start = cursor, count = 0;
      while (start > 0 && count < 50) { start--; count += units[start].length; }
      replayInto(units.slice(start, cursor).flat(), frag, cursor === units.length);
      const oldHeight = log.scrollHeight, oldTop = log.scrollTop;
      const landed = [...frag.children];
      older.after(frag); cursor = start;
      // Past the live messages there is still the archive of everything compaction folded away.
      // DGC keeps it on disk beside the session, so "Show earlier messages" keeps working rather
      // than stopping at the summary with the rest of the conversation sitting unread.
      if (cursor === 0 && recallCursor === 0) older.hidden = true;
      landHistory(landed);
      // After the button is gone too: it is above the reader as well, and leaving it out of the
      // measurement moved the page by its height and the gap beneath it.
      log.scrollTop = oldTop + log.scrollHeight - oldHeight;
      if (cursor === 0 && recallCursor !== 0) askForRecall();
    }

    let recallCursor = null;         // null = not asked yet; 0 = the archive is exhausted
    let recallPending = false;
    function askForRecall() {
      if (recallPending) return;
      recallPending = true;
      older.textContent = "Loading earlier messages\u2026";
      older.disabled = true;
      vscode.postMessage({ type: "getRecall",
                           before: recallCursor === null ? undefined : recallCursor });
    }
    renderHistory._absorbRecall = (ev) => {
      recallPending = false;
      older.disabled = false;
      older.textContent = "Show earlier messages";
      recallCursor = Number(ev.before) || 0;
      const rows = Array.isArray(ev.items) ? ev.items : [];
      const frag = document.createDocumentFragment();
      // Each archived prompt opens a box and pins over the answers that follow it (0.47 pinned prompt),
      // as wrapTurn boxes a replayed one.
      let box = null;
      for (const it of rows) {
        if (it.role === "user") {
          const m = el("div", "msg user hist archived turn-head");
          m.appendChild(el("div", "role", "you"));
          const parsed = splitPromptMarks(it.text);
          const bubble = el("div", "bubble");
          fillUserBubble(bubble, parsed.text, parsed.attachments);
          m.appendChild(bubble);
          box = el("div", "turn");
          box.appendChild(m);
          frag.appendChild(box);
          pinFit?.observe(m);
        } else {
          const m = el("div", "msg dgc hist archived");
          m.appendChild(el("div", "role dgc", "DGC"));
          const text = el("div", "text", md(String(it.text || "")));
          text._markdown = it.text;
          m.appendChild(text);
          (box || frag).appendChild(m);
        }
      }
      // The rows and the button's going both happen above what is being read, so both are inside
      // the one measurement that keeps the page still.
      const oldHeight = log.scrollHeight, oldTop = log.scrollTop;
      const landed = [...frag.children];
      older.after(frag);
      older.hidden = !ev.more;
      landHistory(landed);
      log.scrollTop = oldTop + log.scrollHeight - oldHeight;
    };
    // Rows that just landed above the reader. A newer page that begins with a turn nobody typed
    // continues this page's last prompt and joins its box (joinAcrossPage); then every row is settled
    // -- the boxes' rows, not the boxes, so each block is still measured, pinned and skipped off screen
    // on its own, and each long prompt folded -- before the caller's one measurement keeps the page still.
    function landHistory(landed) {
      joinAcrossPage(landed.at(-1));
      for (const node of landed) {
        if (node.classList.contains("turn")) [...node.children].forEach(settleBlock);
        else settleBlock(node);
      }
    }
    older.type = "button";
    older.onclick = () => { if (cursor > 0) page(); else askForRecall(); };
    log.insertBefore(history, log.firstChild);   // history above any live user prompt / streaming turn
    page();
    startHintedTurn();                // a running turn the snapshot does not hold yet
    scroll();
  }
  // User clicks are the only route out of model-generated content. Never navigate a webview.
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.(".md-link");
    if (link) {
      event.preventDefault();
      const target = DgcMarkdown.linkTarget(link.dataset.target + (link.dataset.line ? `:${link.dataset.line}` : ""));
      if (target?.kind === "external") vscode.postMessage({ type: "openExternal", url: target.target });
      else if (target?.kind === "file") vscode.postMessage({ type: "openFile", path: target.target, line: target.line });
      return;
    }
    const copy = event.target.closest?.(".copy");
    if (copy) {
      vscode.postMessage({ type: "copy", text: decodeURIComponent(copy.dataset.c) });
      const glyph = copy.querySelector(".codicon");
      copy.classList.add("done");
      if (glyph) { glyph.classList.remove("codicon-copy"); glyph.classList.add("codicon-check"); }
      setTimeout(() => {
        if (!copy.isConnected) return;
        copy.classList.remove("done");
        if (glyph) { glyph.classList.remove("codicon-check"); glyph.classList.add("codicon-copy"); }
      }, 1600);
    }
  });

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (["mic", "micLevels", "speak", "speakAudio", "voiceReady"].includes(msg.type)) {
      // This page's own box, or the Pips box beside it (in the side bar's Pips view). (voiceReady answers voice mode,
      // which only the Pips box has here.)
      if (msg.from === "chat") { if (msg.type.startsWith("speak")) reader?.receive(msg); else if (msg.type !== "voiceReady") onMic(msg); }
      else if (msg.from === "pips") for (const listener of pipsListeners) listener(msg);
      return;
    }
    if (msg.type === "pipsOpen") { showPips(); return; }
    if (msg.type === "pipAskDgc") { queuePipAsk(msg.report); return; }
    if (msg.type === "pipShowFix") { if (/^run_[0-9a-f]{32}$/.test(String(msg.run_id || ""))) showPipFix(String(msg.run_id)); return; }
    if (msg.type === "sessions_list") { if (chatPlace === "home") renderSessions(msg); return; }
    if (msg.type === "chatdgc_list") { if (chatPlace === "home") renderChats(msg); return; }
    if (msg.type === "chatdgc_projects") {
      if (chatPlace !== "home") return;
      projects = Array.isArray(msg.projects) ? msg.projects : [];
      projectChats.clear();                       // counts changed: what's open is asked for again
      renderProjects();
      return;
    }
    if (msg.type === "chatdgc_project_chats") {
      if (chatPlace !== "home") return;
      projectChats.set(String(msg.project || ""), Array.isArray(msg.items) ? msg.items : []);
      renderProjects();
      return;
    }
    if (msg.type === "sessions_show") { showSessions(); return; }
    if (msg.type === "chat_tab") { rememberTab(msg.session); return; }
    if (msg.type === "pipsPluginLogos") { for (const listener of pipsListeners) listener(msg); return; }
    if (["pipsConnection","pipsReply","pipsVisibility"].includes(msg.type)) {
      pipSetupCards?.receive(msg);
      pipDigestBar?.receive(msg);
      homePips?.receive(msg);
      if (msg.type === "pipsVisibility") {
        pipsViewVisible = msg.visible === true;
        pipsApp?.setVisible?.(pipsOpen && pipsViewVisible && !document.hidden);
      } else for (const listener of pipsListeners) listener(msg);
      return;
    }
    if (msg.type === "event") onEvent(msg.event);
    else if (msg.type === "chat_slots") { promptChat = String(msg.activeId || promptChat); renderChatBar(msg); }
    else if (msg.type === "chat_switched") {
      // First: every event of the incoming chat follows this one, and its prompts are remembered
      // under its tab (prompts_queued arrives before chat_slots does). The memory outlives the wipe.
      promptChat = String(msg.slotId || "");
      clearForChatSwitch();
      // The incoming backend's own `ready` lands right behind this with the real name; until then
      // the chip's label is the best thing to show, and an unnamed chat is a new one.
      setThreadTitle(msg.label || "", "", true);
    }
    else if (msg.type === "session_ready") {
      hostSessionSeen = true;
      backendExitNotice = null;          // the reconnect has finished; the line is in the transcript
      reconnectPending = false; returnedPrompts.length = 0;
      selectDraftSession(msg.sessionId, msg.adoptDraftFrom || ""); sessionReady = true;
      backendLive = true; backendDown = false; armTodoClearTimer();
      if (pipAsks.length) setTimeout(flushPipAsks, 800);    // a new chat has no transcript to wait for
      renderUnconfirmedDrafts();
    }
    else if (msg.type === "state") {
      curModel = msg.state.model || ""; curThink = msg.state.think || "off";
      curSubscription = msg.state.subscriptionEngine || "";
      curUltra = msg.state.ultra === true;
      updateModelControl();
      agentMapChanged();                         // the map's root names the model
      if (pmodel) { pmodel.textContent = curModel || "dgc"; pmodel.title = "Model: " + (curModel || "dgc") + " — click to change"; pmodel.setAttribute("aria-label", "Change model. Current model: " + (curModel || "dgc")); }
      applyMode(msg.state.mode || "default");
      setGoalState(msg.state.goal || { text: "", status: "none", elapsed_seconds: 0 });
    }
    else if (msg.type === "models" && !$("modelmenu").hidden) { renderModelMenu(msg.ids || [], msg.current, msg.err, msg.subscription, msg.label, msg.supportsEffort); }
    else if (msg.type === "chat_changes") {
      if (!msg.sessionId || msg.sessionId === draftSession) setChatChanges(msg);
    }
    else if (msg.type === "workspace_changes") { setWorkspaceChanges(msg); }
    else if (msg.type === "mcp_command_started") {
      mcpContextPending = msg.requestId;
      openSurface("mcp");
      if (msg.view === "servers") {
        // Working ON a server: keep the list you are working in. Blanking it meant enable,
        // disable and reconnect emptied the panel for as long as the attempt took.
        mcpView = "servers";
        renderMcp();
        const busy = el("div", "surface-notice", "Working with MCP…");
        surfaceBody.insertBefore(busy, surfaceBody.firstChild);
      } else {
        mcpView = "context";
        surfaceBody.innerHTML = '<div class="surface-empty">Working with MCP…</div>';
      }
      // This is the turn's Stop, not a narrower cancel — there is no way to abandon one MCP call
      // and leave the turn running, so the button says what it does.
      surfaceButtons("Stop the turn", () => { vscode.postMessage({ type: "cancel" }); mcpContextPending = ""; renderMcp(); });
    }
    else if (msg.type === "surface_open") {
      if (msg.surface === "mcp") mcpView = "servers";
      openSurface(msg.surface);
    }
    else if (msg.type === "command_menu") {
      openCommandMenu();
    }
    else if (msg.type === "composer_text") {
      setComposerText(String(msg.text || "")); setComposerRange(composerText().length);
      input.focus(); onInput();
    }
    else if (msg.type === "composer_skill") {
      // The skill and its text arrive as one step, and one Cmd+Z takes both away.
      const added = recordComposerEdit(() => {
        if (!attachInvocation("skill", String(msg.name || ""))) return false;
        if (msg.text) {
          // `composerText() += x` is an assignment to a CALL, which parses fine and throws
          // ReferenceError at runtime -- node --check passes it, V8 does not. It arrived
          // mechanically when stage 2 renamed `input.value` to the reader everywhere, including on
          // the left of an assignment. Appending has to go through the writer, and through the
          // editing path so it cannot destroy a pill already in the box.
          const at = composerText().length;
          const gap = composerText() && !/\s$/.test(composerText()) ? " " : "";
          editComposer(at, at, gap + String(msg.text));
        }
        return true;
      });
      if (!added) return;
      input.focus(); onInput();
    }
    else if (msg.type === "turn_active") noteLiveTurn(msg);
    else if (msg.type === "cleared") {
      pipReferencesSupported=false;hidePop();
      // DGC: Restart Backend. The backend holding the queued messages is going away and the new one
      // replays the chat: they are given back as not sent, as Stop gives them back.
      discardTurn(); log.innerHTML = ""; setSending(false);
      reconnectPending = true;
      for (const [id, entry] of [...pendingPrompts]) {
        if (entry.acknowledged) { log.appendChild(entry.node); rejectPrompt(id, true); }   // unapplied steering
        else rejectPrompt(id, false);
      }
      for (const [id, entry] of [...queuedPrompts]) { log.appendChild(entry.node); rejectPrompt(id, true); }
      queuedCount = 0; renderQueued();
      renderUnconfirmedDrafts();
    }
    else if (msg.type === "prompts_queued") adoptQueuedPrompts(msg.items);
    else if (msg.type === "prompts_unsent") adoptUnsentPrompts(msg.items);
    else if (msg.type === "prompt_rejected") { rejectPrompt(msg.requestId); if (!turn) setSending(false); }
    else if (msg.type === "goal_start_state") {
      if (msg.state === "cancelled") { setSending(!!turn); }
      if (msg.state === "error") {
        setSending(!!turn);
        sysLine(String(msg.error || "DGC could not start the goal."), true);
      }
    }
    else if (msg.type === "goal_edit_state") {
      if (msg.state === "pending") setGoalEditPending(true);
      else if (msg.state === "saved") { setGoalEditPending(false); closeGoalEditor(); }
      else if (msg.state === "error") {
        setGoalEditPending(false);
        sysLine(String(msg.error || "DGC could not update the goal."), true);
      }
    }
    else if (msg.type === "goal_control_state" && msg.state === "error") {
      sysLine(String(msg.error || "DGC could not change the goal state."), true);
    }
    else if (msg.type === "contextBreakdown") {
      contextBreakdown = msg.breakdown && typeof msg.breakdown === "object" ? msg.breakdown : null;
      if (!$("ctxmenu").hidden) renderContextMenu();
    }
    else if (msg.type === "compact_state") {
      compacting = msg.state === "working";
      renderContext();
      if (msg.error) sysLine(String(msg.error), true);
    }
    else if (msg.type === "artifact_stop_state") { settleArtifactStop(msg); amPreviewStopState(msg); }
    // The agent map's own answers from the host: a Stop that did not take, an output it could not get.
    else if (msg.type === "agent_stop_state") {
      if (msg.state === "error" && agentStopping.has(String(msg.id || ""))) { agentStopping.set(String(msg.id), "failed"); agentMapChanged(); }
    }
    else if (msg.type === "background_stop_state") {
      if (msg.state === "error") { taskStopping.set(`${msg.kind === "shell" ? "shell" : "monitor"}:${String(msg.id || "")}`, "failed"); agentMapChanged(); }
    }
    else if (msg.type === "background_output_failed") amOutputFailed(msg.id);
    else if (msg.type === "attach" && msg.resource && typeof msg.resource === "object") {
      if (canAttach()) { attachments.push({ label: msg.label, resource: msg.resource }); renderAtts(); }
    }
    else if (msg.type === "files") {
      files = Array.isArray(msg.files) ? msg.files.filter((file) => file
        && typeof file.label === "string" && typeof file.path === "string"
        && typeof file.uri === "string" && typeof file.relative_path === "string"
        && typeof file.workspace === "string").slice(0, 600) : [];
      // Reopen if an "@" was waiting on this list. onInput re-reads the caret, so if the caret has
      // since moved off the token it simply closes again -- it cannot pop open under you.
      if (popMode === "@" || popAwaitingFiles) { popAwaitingFiles = false; onInput(); }
    }
    else if (msg.type === "continue_offer") {
      if (msg.sessionId && msg.sessionId !== draftSession) return;
      imageViewerAttention("continue_offer");
      const cause = String(msg.cause || "").slice(0, 300);
      recoveryCard("continue-offer",
        (msg.windowless
          ? `Your last turn was stopped while no window was open${cause ? ` (${cause})` : ""}. `
          : `DGC's backend stopped during your last turn${cause ? ` (${cause})` : ""}. `)
          + "Work up to the last completed step is saved.",
        "Continue", () => vscode.postMessage({ type: "resumeTurn" }));
    }
    else if (msg.type === "session_elsewhere") showSessionElsewhere(msg);
    else if (msg.type === "goal_resume_held") {
      imageViewerAttention("goal_resume_held");
      const cause = String(msg.cause || "").slice(0, 300);
      const exits = Math.max(0, Number(msg.exits) || 0);
      recoveryCard("goal-resume-held",
        `DGC's backend stopped ${exits} times in 30 minutes, so the goal was not resumed automatically.`
          + (cause ? ` Last cause: ${cause}.` : "")
          + (msg.logPath ? ` Details: ${String(msg.logPath).slice(0, 600)}` : " Details: the DGC Backend output channel."),
        "Resume goal", () => vscode.postMessage({ type: "resumeGoal" }));
    }
    else if (msg.type === "open_goal_review") openGoalReview();
    else if (msg.type === "workflow_draft") prepareWorkflowDraft(msg.name);
    else if (msg.type === "learn_started") learnPending(msg);
    else if (msg.type === "backend_exit") {
      releaseHeldEvents();
      requestEpoch += 1;
      backendExitHooks(msg);
      sessionReady = !draftScope;
      // A Clear sent to a recovering backend is held for the next one, so it is not unanswered
      // yet; with no recovery coming, the row says so at once instead of spinning.
      backendLive = false; backendDown = !msg.recovering; pauseTodoClearTimer(Boolean(msg.recovering));
      reconnectPending = Boolean(msg.recovering);
      // The extension is restarting the backend and will pick the work back up, so the turn has
      // not failed. Ending it here relabelled an already-answered turn "Failed for 41s" and took
      // its answer chrome away. Say what is happening instead — and bound it: if nothing arrives
      // within thirty seconds, it really did fail.
      if (msg.recovering && turn) {
        const stale = turn;
        turn.activity = { state: "waiting", label: "Restarting the DGC backend", detail: "" };
        turn.phaseT0 = Date.now();
        renderTurnMeta();
        clearTimeout(turn.recoverTimer);
        turn.recoverTimer = setTimeout(() => {
          if (turn === stale) { endTurn("error"); setSending(false); }
        }, 30000);
      } else endTurn("error");
      expireOpenRequests();
      // Steering the backend acknowledged but never applied is as unsent as a queued message.
      for (const [id, entry] of [...pendingPrompts]) rejectPrompt(id, entry.acknowledged === true);
      // Accepted as queued but never started: the backend that held them is gone, so they are
      // the user's to send again (a backend that got to say so first already returned them).
      for (const id of [...queuedPrompts.keys()]) rejectPrompt(id, true);
      queuedCount = 0; renderQueued();
      renderUnconfirmedDrafts();
      // The goal clock is driven from this side: it keeps adding elapsed time for as long as the
      // goal reads active-and-running. With the backend gone nothing will ever say otherwise, so
      // it counted time against a dead process. Freeze it where it stopped.
      if (goalState.text) setGoalState({ ...goalState, running: false });
      // `msg.code ?` hid the two cases that matter: 0 is falsy, so a clean stop and a process
      // killed by a signal (code null) printed the same bare line, and neither could be told from
      // the other when diagnosing a crash loop.
      const why = msg.signal ? " (killed by " + msg.signal + ")"
        : typeof msg.code === "number" ? " (code " + msg.code + ")"
        : " (killed)";
      // Say only what will actually happen: a goal resumes by itself, an ordinary turn is offered
      // a Continue once the backend is back, and anything else simply reconnects.
      const next = msg.resumes === "offer" ? "reconnecting; you can continue the interrupted turn when it is back"
        : msg.resumes === "held" ? "reconnecting; the goal will not resume by itself after repeated backend exits"
        : msg.resumes === "none" ? "reconnecting"
        : "reconnecting and picking the work back up";
      const cause = typeof msg.cause === "string" ? msg.cause.slice(0, 300) : "";
      // When the backend said nothing, the extension's cause is the exit status itself ("killed by
      // SIGKILL", "exited with code 1"): say it once instead of "(killed by SIGKILL): killed by SIGKILL".
      const status = why.slice(2, -1);
      const restated = [status, `exited with ${status}`, "killed by an unreported signal"].includes(cause);
      const detail = !cause ? why : restated ? ` (${cause})` : why + ": " + cause;
      const exitLine = cause.startsWith("protocol:")
        ? "DGC connection needs attention. Follow the update or connection instructions above."
        : msg.recovering
        ? "dgc backend stopped" + detail + "\u2009\u2014\u2009" + next
        : "dgc backend exited" + detail;
      sysLine(exitLine, true, "triangle-alert");
      backendExitNotice = msg.recovering ? { text: exitLine, session: draftSession } : null;
      if (!turn) setSending(false);      // a turn still being recovered keeps its Stop button
    }
  });
  // ---- 0.40 shared --------------------------------------------------------------------------------
  // Hook dispatchers the handlers above call. Each 0.40 lane fills in only its own section below;
  // the dispatchers keep the order agents, images, reconnecting, options.
  function sessionResetHooks(kind) {
    pipSetupCards?.reset();
    cacheClockOnSessionReset(kind);   // the incoming chat's backend says its own
    agentsOnSessionReset(kind); imagesOnSessionReset(kind); retryOnSessionReset(kind); askOnSessionReset(kind);
    pipFixesReset(kind);
    if (kind !== "rewound") {                   // the incoming chat's own running Pips, asked for again
      setPipRunning([]);
      if (pipRunsLive) vscode.postMessage({ type: "pipRunsWatch" });
    }
    railReset();                       // the prompt rail: the incoming chat's snapshot and outline say its own
  }
  function backendExitHooks(msg) {
    setPipRunning([]);                 // nobody is watching the runner for this chat until it is back
    agentsOnBackendExit(msg); imagesOnBackendExit(msg); retryOnBackendExit(msg); askOnBackendExit(msg);
  }
  // Anything drawn at turn level between tool rounds (text, a model-retry line, an inline thought
  // note, an image row with no step, and a sub-agent's thinking) ends the open tool group, so the next
  // tool card starts a new group below it rather than joining one above. The main model's own
  // collapsed thinking and withheld-thinking rows no longer do (see pendingThoughts).
  // Retiring changes ownership, never the user's expansion choice. Groups
  // start collapsed, and remain in the state the reader selected.
  function retireToolGroup(group) { /* No automatic expansion or folding. */ }

  function releaseToolGroup() {
    if (!turn) return;
    retireToolGroup(turn.toolGroup);
    turn.toolGroup = null;
    // The groups a delegation split off earlier in the step (see appendTool) fold now too: every
    // release point comes after the step's results, live and replayed alike.
    for (const group of turn.leftGroups?.splice(0) || []) retireToolGroup(group);
    syncLiveStep();                          // the stretch is over: its live row goes, its line stays
  }
  function endToolGroup() { releaseToolGroup(); }
  // ---- end 0.40 shared ----------------------------------------------------------------------------


  // ---- 0.40 agents --------------------------------------------------------------------------------
  // `kind`: "new" | "cleared" | "resumed" | "rewound".
  function agentsOnSessionReset(kind) {}
  function agentsOnBackendExit(msg) {}
  // Called for every tool card once it is in its group; `card.dataset.callId` is the wire call id.
  function agentsOnToolCard(card, ev) {}
  // With a click event: hide only when the click fell outside the pill and its menu.
  function hideAgentsMenu(event) {}

  // The "● 2 agents" pill lists every sub-agent in the current turn — running, finished, failed or
  // stopped — so you can see the whole batch while work is happening. When the turn ends the pill
  // clears. History stays in the transcript. A backend that exits marks the active ones stopped
  // until the turn ends or the new backend's snapshot says otherwise.
  const AGENT_ACTIVE = new Set(["queued", "running", "waiting"]);
  const AGENT_ENDED_WORD = { finished: "Finished", failed: "Failed", stopped: "Stopped" };
  const agentRecords = new Map();          // id -> record (the frame's fields + receivedAt, order)
  let agentPageId = "";
  let agentPageParentTitle = "";
  let agentPageScroll = 0;
  let agentPageTick = null;
  // Pages opened from a nested agent's name, so Back steps back to the parent page; and the control
  // that opened the first page, which gets focus back when the chat returns.
  let agentPageStack = [], agentPageReturnFocus = null;
  let agentPageImageRecords = [];
  // The agent lines: one per batch of top-level agents started together in #log, and the lines of
  // the open page's nested agents (rebuilt with the page).
  const agentLines = new Set();
  let agentPageLines = [];
  // Pack B identity marks in media/agents/. Same file on light and dark (they hold on #141414).
  // Always the still frame: the -animated swirl reads as a colour smear at 16px. The face is
  // drawn bare, with no ring around it, live or finished (`.is-live` is state only). Which face an
  // agent wears is the CLI's face slot when it sends one (first free, so two at work never match);
  // otherwise the id's own face.
  const AGENT_MARK_NAMES = ["seafoam", "lagoon", "coral", "violet", "amber", "slate", "lime", "rose"];
  // The order the CLI's face slots are handed out in: slot 0 is the first face a working agent
  // gets. Five colour families first; the look-alikes (slate~violet, rose~coral, lagoon~seafoam)
  // last, so a batch of up to five never puts two of them side by side.
  const AGENT_FACE_ORDER = [0, 2, 3, 4, 6, 5, 7, 1];
  function cssEscape(value) {
    return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(String(value)) : String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  }
  // A child's call ids are prefixed with its agent's id at every level (sub-parent:sub-child:call_3,
  // dgc/agent.py). This is the outermost, the top-level agent whose line hosts the work.
  function agentIdFromCall(callId) {
    const match = String(callId || "").match(/^(sub-[0-9a-f]{12})(?::|$)/i);
    return match ? match[1] : "";
  }
  // ...and this the innermost: the agent that made the call, whose page it belongs on (the same id a
  // child's reasoning carries in `agent`).
  function innermostAgentId(callId) {
    const chain = String(callId || "").match(/^(?:sub-[0-9a-f]{12}(?::|$))+/i)?.[0] || "";
    return chain.split(":").filter(Boolean).at(-1) || "";
  }
  // The id's own face. Math.imul(h, 33) ≡ h (mod 8), so this is the sum of the id's character
  // codes mod 8: ids made of the same characters always collide (sid(1) and sid(9) both seafoam).
  function agentMarkIndex(id) {
    let hash = 0;
    for (let i = 0; i < String(id).length; i++) hash = (Math.imul(hash, 33) + String(id).charCodeAt(i)) >>> 0;
    return hash % 8;
  }
  function agentFaceIndex(id) {
    const slot = agentRecords.get(String(id))?.face_slot;
    if (Number.isSafeInteger(slot) && slot >= 0) return AGENT_FACE_ORDER[slot % AGENT_FACE_ORDER.length];
    return agentMarkIndex(id);   // no slot: a chat saved before slots, or a CLI that sends none
  }
  function agentMarkMotionOk() {
    return !(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  // A working agent's face swirls (its -animated artwork) everywhere it is drawn, chips included: the founder
  // chose it back on 2026-10-18 after 0.26.3 had kept the still frame at chip size. `live` is false once the
  // agent ends, and under reduced motion (paintAgentMark), so those get the still frame.
  function agentMarkSrc(index, live) {
    const base = (document.body.dataset.agentMarks || "").replace(/\/$/, "");
    if (!base) return "";
    const name = AGENT_MARK_NAMES[index];
    const file = `agent-${String(index + 1).padStart(2, "0")}-${name}${live ? "-animated" : ""}.svg`;
    return `${base}/${file}`;
  }
  function paintAgentMark(node, id, live) {
    if (!node) return;
    const index = agentFaceIndex(id);
    node.dataset.mark = String(index);
    node.dataset.face = AGENT_MARK_NAMES[index];
    // `is-live` is STATE, not motion. It used to be set only when animation was also allowed, so
    // with reduced motion a working agent was drawn exactly like a finished one -- the preference
    // asks for less movement, not for less information. The stylesheet stops the pulse and keeps
    // the glow.
    node.classList.toggle("is-live", live === true);
    const src = agentMarkSrc(index, live === true && agentMarkMotionOk());
    let img = node.querySelector("img");
    if (!src) { if (img) img.remove(); return; }
    if (!img) {
      img = document.createElement("img");
      img.alt = "";
      img.draggable = false;
      // If the mark cannot be fetched, drop the <img> so the CSS fallback shape applies. The
      // fallback is selected with :not(:has(img)), which is true of PRESENCE, not of a successful
      // load -- so a broken mark used to show the browser's placeholder glyph on a blanked
      // background, with the coloured shape suppressed.
      img.addEventListener("error", () => {
        if (img && img.parentNode === node) node.removeChild(img);
        node.dataset.markFallback = "1";
      });
      img.addEventListener("load", () => { delete node.dataset.markFallback; });
      node.appendChild(img);
    }
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);
  }
  // ---- the lines in the transcript ----
  // Codex's inline sub-agent line: compact, stable lines of at most four from each batch of
  // top-level agents started together, where each used to get a full-width row of its own. Faces first, then a sentence in
  // which only the names are controls, each opening that agent's page: "Durable rules review, Remote
  // web and Paper pip concept started working". The names keep their call order and never move --
  // the founder reported agents "switching their place" when every one had its own row, and Codex
  // keeps an agent where it started. Only the words between the names change: one word per agent,
  // and neighbours that share a word share it, "A and B finished · C running".
  const AGENT_START_MS = 2000, AGENT_NAMES_SHOWN = 3, AGENT_LINE_CAP = 4;
  // What splits a batch: only what the model itself wrote -- a visible tool group, prose, its
  // reasoning -- and the user's steering. Everything else that can sit between two spawns exists in
  // one stream and not the other: an approval card live and its recorded decision only on replay,
  // notices and retry lines, file chips, artifacts and monitor cards, a child's hidden work. Leaving
  // all of it out is what makes a reload draw the lines the live turn drew.
  const AGENT_LINE_SPLIT = ".tool-group:not(.agent-owned), .text, .answer, .disclosure:not(.agent-owned), "
    + ".reasoning:not(.agent-owned), .thought-note, .thought-static:not(.agent-owned), .msg.user";
  // The order a collapsed line counts its words in: agentSummary's.
  const AGENT_WORD_ORDER = ["started working", "running", "waiting for your permission", "waiting for your answer",
    "queued", "finished", "failed", "stopped"];
  const AGENT_WORD_STATE = { "started working": "started", running: "running", "waiting for your permission": "waiting",
    "waiting for your answer": "waiting", queued: "queued", finished: "finished", failed: "failed", stopped: "stopped" };
  // The backend's own notices for a spawn (dgc/agent.py; a test pins the wording to them).
  const AGENT_SPAWN_NOTICE = /^(?:⟳ sub-task: |↳ isolated checkout: |↯ running \d+ isolated sub-tasks in parallel\b)/;
  // A clause separator: " · " for the eye, a comma for a screen reader (reasonAgentPrefix's pause).
  const AGENT_SEP = { sep: true };
  // First members of the lines whose "N more" was used: an expanded line stays expanded for the
  // session, through a repaint of the page it is on.
  const agentLinesExpanded = new Set();
  function agentDisplayName(record) {
    return String(record?.description || "").replace(/\s+/g, " ").trim() || "Agent";
  }
  // agentTree's order: by start, a restored record (no start time) first, then first seen.
  function agentByStart(a, b) {
    const at = (r) => (r.started_at === undefined || r.started_at === null ? -Infinity : Number(r.started_at));
    return (at(a) - at(b)) || a.order - b.order;
  }
  // What a line says for one agent. "started working" is said only live, for two seconds from the
  // moment the agent really starts: a parallel child waiting for a worker reads "queued" until one
  // takes it. A reload, a resume or a chat switch draws the word the agent has now.
  function agentLineWord(record, now) {
    const state = record.state;
    if (state === "finished" || state === "failed" || state === "stopped") return { word: state, state };
    if (state === "waiting") {
      return { word: record.waiting_for === "answer" ? "waiting for your answer" : "waiting for your permission", state: "waiting" };
    }
    if (state === "queued") return { word: "queued", state: "queued" };
    if (record.startedLiveAt != null && now - record.startedLiveAt < AGENT_START_MS) return { word: "started working", state: "started" };
    return { word: "running", state: "running" };
  }
  const childToolStores = new Map();
  function childToolBucket(id) {
    if (!childToolStores.has(id)) childToolStores.set(id, Object.create(null));
    return childToolStores.get(id);
  }
  function agentLineOf(id) {
    for (const line of agentLines) if (line.ids.includes(id)) return line;
    return null;
  }
  // A background child's step that arrives after its turn ended: hidden, on its own agent, in the
  // block that holds its top-level agent's line. Found in the live DOM: a reload replaces the blocks.
  function placeChildTool(id, card) {
    card.dataset.agentId = innermostAgentId(card.dataset.callId) || id;
    card.classList.add("agent-owned");
    const line = log.querySelector(`.agent-line[data-agent-ids~="${cssEscape(id)}"]`);
    (line?.closest(".msg") || log).appendChild(card);
  }
  // `open`: what a name does when clicked, for lines drawn somewhere other than the chat or its page
  // (the agent map's transcript); without it, a name opens that agent's page.
  function newAgentLine({ provisional = false, page = false, open = null } = {}) {
    const node = el("div", "agent-line");
    node.setAttribute("role", "group");
    node.setAttribute("aria-label", "Sub-agent");
    const faces = el("span", "agent-line-faces");
    faces.setAttribute("aria-hidden", "true");
    const text = el("span", "agent-line-text");
    const tail = el("span", "agent-line-tail");
    text.appendChild(tail);
    node.append(faces, text);
    const line = { node, faces, text, tail, ids: [], names: new Map(), marks: new Map(), glues: new Map(),
      more: null, moreGlue: null, expanded: false, timer: 0, provisional, page, open, sig: "" };
    if (!page) agentLines.add(line);
    return line;
  }
  function dropAgentLine(line) {
    clearTimeout(line.timer); line.timer = 0;
    repinBlockOf(line.node);
    line.node.remove();
    agentLines.delete(line);
  }

  // ---- which spawns share a line ----
  function spawnGroupOf(card) { return card.closest(".tool-group") || card; }
  function splitsAgentBatch(node) {
    if (!node.matches(AGENT_LINE_SPLIT)) return false;
    // Blank prose is never replayed (dgc/headless.py draws a message's text only when it has some).
    if (node.matches(".text, .answer")) return !!node.textContent.trim();
    // A plan update on its own is bookkeeping the backend runs beside a batch, not a step.
    if (node.matches(".tool-group")) {
      return [...node.querySelectorAll(":scope > .tool:not(.agent-owned)")]
        .some((card) => canonicalTool(card.dataset.toolName) !== "todo");
    }
    return true;
  }
  function spawnsAdjacent(a, b) {
    const ga = spawnGroupOf(a), gb = spawnGroupOf(b);
    if (ga === gb) return true;
    if (!ga.parentElement || ga.parentElement !== gb.parentElement) return false;
    for (let node = ga.nextElementSibling; node; node = node.nextElementSibling) {
      if (node === gb) return true;
      if (splitsAgentBatch(node)) return false;
    }
    return false;
  }
  // The claimed spawn cards of top-level agents, in document order.
  function agentLineCards() {
    return [...log.querySelectorAll('.msg .tool[data-tool-name="task"][data-agent-id]')].filter((card) => {
      const record = agentRecords.get(card.dataset.agentId);
      return !!record && !record.parent_id && !agentIdFromCall(card.dataset.callId) && agentAnchor(record.id) === card;
    });
  }
  // Lines are derived from the DOM, never from the order things arrived in: the claimed spawn cards,
  // and whether anything between their groups splits them. Live claims, claims made out of order and
  // the snapshot after a history therefore all converge on the same lines. A line sits after the
  // group of its first spawn, and moves only if an earlier spawn joins its batch.
  function layoutAgentLines() {
    holdReadingPlace(() => {
      const runs = [];
      for (const card of agentLineCards()) {
        const run = runs.at(-1);
        if (run && spawnsAdjacent(run.at(-1), card)) run.push(card); else runs.push([card]);
      }
      const used = new Set();
      for (const run of runs) {
        let anchor = spawnGroupOf(run[0]);
        for (let offset = 0; offset < run.length; offset += AGENT_LINE_CAP) {
          const cards = run.slice(offset, offset + AGENT_LINE_CAP);
          const ids = cards.map((card) => card.dataset.agentId);
          const line = ids.map(agentLineOf).find((l) => l && !l.provisional && !used.has(l)) || newAgentLine();
          used.add(line);
          line.ids = ids;
          if (anchor.nextElementSibling !== line.node) { anchor.after(line.node); repinBlockOf(line.node); }
          anchor = line.node;
        }
      }
      for (const line of [...agentLines]) if (!line.provisional && !used.has(line)) dropAgentLine(line);
      pruneProvisionalLines();
      for (const line of used) paintAgentLine(line);
    });
  }
  // A provisional line holds live agents whose spawn card is not on screen yet (an agent can start
  // before its tool_call arrives). A member leaves it once its card is claimed -- the line then forms
  // under the card -- or when it ends without one, as the row it replaced did: a reload draws no line
  // for an agent with no card either.
  function pruneProvisionalLines() {
    for (const line of [...agentLines]) {
      if (!line.provisional) continue;
      line.ids = line.ids.filter((id) => {
        const record = agentRecords.get(id);
        return !!record && !record.parent_id && AGENT_ACTIVE.has(record.state) && !agentAnchor(id) && !pipFixByAgent(id);
      });
      if (!line.ids.length || !line.node.isConnected) dropAgentLine(line);
      else paintAgentLine(line);
    }
  }
  function provisionalAgentLine(record) {
    // A Pip fix's helper has its report's card for a line (Watch, Stop): never a second line in the chat.
    if (agentsHoldClaims || record.parent_id || !AGENT_ACTIVE.has(record.state)
        || agentAnchor(record.id) || agentLineOf(record.id) || pipFixByAgent(record.id)) return;
    const last = turn ? turn.act.previousElementSibling : log.lastElementChild;
    let line = [...agentLines].find((l) => l.provisional && l.node === last && l.ids.length < AGENT_LINE_CAP);
    if (!line) {
      line = newAgentLine({ provisional: true });
      if (turn) appendTurnContent(line.node); else log.appendChild(line.node);
    }
    line.ids = [...line.ids, record.id].sort((a, b) => agentByStart(agentRecords.get(a), agentRecords.get(b)));
    paintAgentLine(line);
  }
  function repaintAgentLines() {
    pruneProvisionalLines();
    for (const line of [...agentLines]) if (!line.provisional) paintAgentLine(line);
    for (const line of agentPageLines) paintAgentLine(line);
  }

  // ---- painting a line ----
  function agentLineFace(line, record) {
    let mark = line.marks.get(record.id);
    if (!mark) {
      mark = el("span", "agent-mark");
      mark.dataset.agentId = record.id;
      line.marks.set(record.id, mark);
    }
    paintAgentMark(mark, record.id, AGENT_ACTIVE.has(record.state));
    return mark;
  }
  // One button per agent, kept for the line's life and never moved, so a focused name keeps focus
  // through every repaint. Its label is the whole name, however it is clipped on screen.
  function agentLineName(line, record) {
    let button = line.names.get(record.id);
    if (!button) {
      button = el("button", "agent-name");
      button.type = "button";
      button.dataset.agentId = record.id;
      const id = record.id, opener = button;
      button.addEventListener("click", () => (line.open ? line.open(id, opener) : openAgentPage(id, { from: opener, nested: line.page })));
      line.names.set(record.id, button);
    }
    const name = agentDisplayName(record);
    agentsSetText(button, name);
    const why = (record.state === "failed" || record.state === "stopped") && record.message ? agentFirstLine(record.message) : "";
    hoverTip.retitle(button, `Open ${name}${why ? `\n${why}` : ""}`);
    return button;
  }
  // The words between the names: strings, {state, text} for an agent's word, AGENT_SEP between
  // clauses. A span rebuilds its children only when its own parts change.
  function setAgentLineParts(span, parts) {
    const sig = JSON.stringify(parts);
    if (span._sig === sig) return;
    span._sig = sig;
    span.replaceChildren(...parts.flatMap((part) => {
      if (part === AGENT_SEP) {
        const dot = el("span"); dot.setAttribute("aria-hidden", "true"); dot.textContent = " · ";
        const pause = el("span", "sr-only"); pause.textContent = ",";
        return [dot, pause];
      }
      if (typeof part === "string") return [document.createTextNode(part)];
      const word = el("span", "agent-state");
      word.dataset.state = part.state;
      word.textContent = part.text;
      return [word];
    }));
  }
  // The one painter for the chat's lines and an agent page's lines.
  function paintAgentLine(line) {
    const now = agentNow();
    const members = line.ids.map((id) => agentRecords.get(id)).filter(Boolean);
    if (!members.length) { if (!line.page) dropAgentLine(line); return; }
    if (agentLinesExpanded.has(line.ids[0])) line.expanded = true;
    agentsPlace(line.faces, members.map((record) => agentLineFace(line, record)));
    const words = members.map((record) => agentLineWord(record, now));
    const uniform = words.every((w) => w.word === words[0].word);
    const collapsed = members.length > AGENT_NAMES_SHOWN && !line.expanded;
    const shown = collapsed ? members.slice(0, 2) : members;
    const said = (w) => ({ state: w.state, text: w.word });
    // Between two names: the join when they share a word ("A, B and C"), else the first one's word
    // and a clause separator. Names never move; only these change.
    const glues = shown.slice(0, -1).map((record, i) => {
      if (collapsed) return [", "];
      if (words[i].word !== words[i + 1].word) return [" ", said(words[i]), AGENT_SEP];
      const lastOfRun = i + 2 >= shown.length || words[i + 2].word !== words[i + 1].word;
      return [lastOfRun ? " and " : ", "];
    });
    const hidden = collapsed ? members.length - shown.length : 0;
    let tail = [" ", said(words.at(-1))];
    if (collapsed && !uniform) {
      // "A, B and 14 more · 4 running · 10 queued · 2 finished": the batch's counts, in the pill's order.
      tail = [];
      for (const word of AGENT_WORD_ORDER) {
        const count = words.filter((w) => w.word === word).length;
        // A no-break space: a row never ends on the bare number ("· 3" above "running").
        if (count) tail.push(AGENT_SEP, { state: AGENT_WORD_STATE[word], text: `${count}\u00a0${word}` });
      }
    }
    const names = shown.map((record) => agentLineName(line, record));
    const sig = JSON.stringify([shown.map((record) => [record.id, agentDisplayName(record)]), glues, hidden, tail]);
    if (sig !== line.sig) {
      const apply = () => {
        const nodes = [];
        names.forEach((button, i) => {
          nodes.push(button);
          if (i >= glues.length) return;
          const id = shown[i].id;
          let glue = line.glues.get(id);
          if (!glue) { glue = el("span", "agent-line-glue"); line.glues.set(id, glue); }
          setAgentLineParts(glue, glues[i]);
          nodes.push(glue);
        });
        if (hidden) {
          if (!line.more) {
            line.moreGlue = el("span", "agent-line-glue");
            const more = line.more = el("button", "agent-line-more");
            more.type = "button";
            // One way: it reveals every name in place and is gone, so it has no expanded state to
            // report. Focus moves to the first name it revealed rather than being lost with it.
            more.addEventListener("click", () => {
              line.expanded = true;
              if (line.ids[0]) agentLinesExpanded.add(line.ids[0]);
              paintAgentLine(line);
              focusQuietly(line.names.get(line.ids[2]), { preventScroll: true });
            });
          }
          setAgentLineParts(line.moreGlue, [" and "]);
          agentsSetText(line.more, `${hidden} more`);
          line.more.setAttribute("aria-label", `Show ${hidden} more agents`);
          nodes.push(line.moreGlue, line.more);
        }
        setAgentLineParts(line.tail, tail);
        nodes.push(line.tail);
        agentsPlace(line.text, nodes);
      };
      // The sentence wraps, so a word can change a line's height -- in a settled block too, off
      // screen. Keep the reader where they are, and have that block measured again.
      if (line.page) apply(); else holdReadingPlace(apply);
      line.sig = sig;
      repinBlockOf(line.node);
    }
    line.node.dataset.agentIds = line.ids.join(" ");
    line.node.setAttribute("aria-label", members.length === 1 ? "Sub-agent" : "Sub-agents");
    // A line drawn into a turn that has already folded its work (after a reload the agents snapshot draws
    // them once the history has): the fold decides it now, as it would have when the turn ended.
    const host = line.node.parentElement;
    if (host?.classList.contains("has-work-fold")) paintWorkFold(host, true);
    // "started working" turns to "running" on its own: one timer for the line, at the latest window's
    // end, so agents started a few milliseconds apart change together.
    clearTimeout(line.timer); line.timer = 0;
    const until = Math.max(0, ...members.filter((r) => r.state === "running" && r.startedLiveAt != null)
      .map((r) => r.startedLiveAt + AGENT_START_MS));
    if (until > now) line.timer = setTimeout(() => { line.timer = 0; if (line.node.isConnected) paintAgentLine(line); }, until - now);
  }
  // An agent's record changed: its line (or the provisional one it waits in), and the open page.
  // `pagePainted`: the claim this change made already repainted the page.
  function agentLineChanged(record, kind, pagePainted = false) {
    if (!record.parent_id) {
      const line = agentLineOf(record.id);
      if (line?.provisional && !AGENT_ACTIVE.has(record.state)) pruneProvisionalLines();
      else if (line) paintAgentLine(line);
      else provisionalAgentLine(record);
    }
    if (!agentPageId) return;
    if (agentPageId === record.id || (kind === "agent_started" && record.parent_id === agentPageId)) {
      if (!pagePainted) paintAgentPage(agentPageId);
    } else if (record.parent_id === agentPageId) {
      // A nested agent's frequent updates repaint its line on the page in place, not the page.
      for (const line of agentPageLines) if (line.ids.includes(record.id)) paintAgentLine(line);
    }
  }
  function agentAnswerText(record) {
    return String(record.message || "").split("\n").filter((line) => !/^\s*FILES:/i.test(line)).join("\n").trim();
  }
  // `images` collects the image records the clone's chips hold, so whoever drew it can let them go.
  function rebindAgentClone(node, source, images = agentPageImageRecords) {
    if (node.classList.contains("tool")) {
      // cloneNode copies the painted chips but none of the image records or listeners behind them.
      // Give this page its own lightweight records so opening a cloned image cannot steal the live
      // chat card's `record.chip`, and rebuild the row with the same viewer binding as the chat.
      if (source?._images?.length || source?._imagesOmitted) {
        node.querySelector(":scope > .body > .tool-images")?.remove();
        node._images = (source._images || []).map((record) => {
          const copy = { ...record, owner: node, chip: null };
          if (copy.state === "loading") copy.state = "pending";
          if (copy.ref) trackImageRef(copy);
          images.push(copy);
          return copy;
        });
        node._imagesOmitted = source._imagesOmitted || 0;
        if (node.classList.contains("open")) renderImageRow(node);
      }
      const toggle = node.querySelector(".tool-toggle");
      if (toggle) {
        toggle.onclick = () => {
          if (node.classList.contains("no-body")) return;
          const open = node.classList.toggle("open");
          toggle.setAttribute("aria-expanded", String(open));
          if (open) imagesOnCardOpen(node);
        };
      }
    }
    if (node.classList.contains("disclosure")) {
      node.onclick = () => {
        const body = node.nextElementSibling;
        if (!body || !body.classList.contains("reasoning")) return;
        const open = body.classList.toggle("show");
        const chev = node.querySelector(".thought-chev");
        if (chev) chev.textContent = open ? "▾" : "▸";
        node.setAttribute("aria-expanded", String(open));
      };
    }
    node.querySelectorAll?.(".open-file[data-path]").forEach((btn) => {
      btn.onclick = (event) => {
        event.stopPropagation();
        vscode.postMessage({ type: "openFile", path: btn.dataset.path, line: btn.dataset.line ? Number(btn.dataset.line) : undefined });
      };
    });
  }
  // An agent's steps, into `into`: its own cards from the chat, else its step log. `lines` collects the
  // nested agents' lines drawn here and `images` the image records of the cloned cards; `open` is what
  // a nested agent's name does. `told`: the agent's report is drawn beside these (above them on its
  // page, after them in the map's transcript, `below`).
  // A step's one-line summary when it came without one: a parallel sub-agent's live steps (agent_step) carry
  // the call's name and arguments only, so its page and the map's transcript drew a bare "Read" where Claude Code
  // shows "Read README.md" (real VS Code, 2026-10-18). The same rule as dgc/ui.py arg_summary's general case.
  const STEP_SUMMARY_KEYS = ["path", "command", "pattern", "url", "name", "memory", "symbol", "operation"];
  function stepSummary(name, args) {
    if (!args || typeof args !== "object") return "";
    const one = (value) => { const text = String(value ?? "").replace(/\n/g, " "); return text.length > 120 ? `${text.slice(0, 120)}…` : text; };
    if (name === "message_task" || name === "close_task") return one(args.agent || args.id || "");
    const key = STEP_SUMMARY_KEYS.find((k) => k in args);
    return key ? one(args[key]) : "";
  }
  function paintAgentTranscript(id, into, { lines = agentPageLines, images = agentPageImageRecords, open = null,
    told = null, below = false } = {}) {
    let cloned = 0;
    const placed = new Set();
    // A nested agent's spawn is drawn on its parent's page as the chat draws its own: a line, its
    // name opening the child's page. Spawns with nothing of the parent's between them share one.
    const pageLine = (childId) => {
      let line = lines.find((l) => l.node === into.lastElementChild && l.ids.length < AGENT_LINE_CAP);
      if (!line) {
        line = newAgentLine({ page: true, open });
        into.appendChild(line.node);
        lines.push(line);
      }
      if (!line.ids.includes(childId)) line.ids.push(childId);
      placed.add(childId);
    };
    for (const node of log.querySelectorAll(".tool.agent-owned, .diff.agent-owned, button.disclosure.agent-owned, .reasoning.agent-owned, .thought-static.agent-owned, .thought-note.agent-owned")) {
      if (node.classList.contains("tool") && node.dataset.toolName === "task") {
        const child = agentRecords.get(node.dataset.agentId);
        if (child && child.parent_id === id && agentAnchor(child.id) === node) { pageLine(child.id); cloned += 1; continue; }
      }
      if ((node.dataset.agentId || node.dataset.agent) !== id) continue;
      // The spawn that started this agent is its parent's step, not this agent's work.
      if (node.classList.contains("tool") && node.dataset.toolName === "task"
          && innermostAgentId(node.dataset.callId) !== id) continue;
      const clone = node.cloneNode(true);
      rebindAgentClone(clone, node, images);
      into.appendChild(clone);
      cloned += 1;
    }
    const record = agentRecords.get(id);
    if (!cloned) {
      // No steps of its own in the chat: the agent's saved (or live) step log. Its cards are drawn
      // detached -- building them must not touch the live turn.
      const events = Array.isArray(record?.log) ? record.log : [];
      const store = Object.create(null);
      const nested = (ev) => (ev.name === "task" && ev.call_id
        ? [...agentRecords.values()].find((r) => r.parent_id === id && r.call_id === ev.call_id) : null);
      for (const ev of events) {
        if (!ev || typeof ev !== "object") continue;
        if (ev.type === "tool_call") {
          const child = nested(ev);
          if (child) { pageLine(child.id); continue; }
          const card = toolCard({ name: ev.name, call_id: ev.call_id, args: ev.args || {},
                                  summary: ev.summary || stepSummary(ev.name, ev.args) }, { detached: true });
          card.classList.add("agent-owned");
          card.dataset.agentId = id;
          store[ev.call_id || ev.name] = card;
          into.appendChild(card);
        } else if (ev.type === "tool_result") {
          if (nested(ev)) continue;
          const key = ev.call_id || ev.name;
          const card = store[key] || (store[key] = toolCard({ name: ev.name, call_id: ev.call_id }, { detached: true }));
          if (!card.isConnected) {
            card.classList.add("agent-owned");
            card.dataset.agentId = id;
            into.appendChild(card);
          }
          setToolStatus(card, ev.is_error ? "failed" : "completed");
          setToolOutput(card, String(ev.output || "").slice(0, 4000));
        }
      }
      if (record?.restored && !(told ?? [...into.children].some((node) => !node.classList.contains("agent-page-outcome")))) {
        const note = el("div", "sys hist");
        note.textContent = `This agent's tool steps were not kept in the parent chat. The summary ${below ? "below" : "above"} is what it reported.`;
        into.appendChild(note);
      }
    }
    // Children whose spawn is not drawn here -- a parallel parent's trace has not replayed yet, or
    // was not kept -- still get a line, at the end, in the order they started.
    for (const child of [...agentRecords.values()].filter((r) => r.parent_id === id && !placed.has(r.id)).sort(agentByStart)) {
      pageLine(child.id);
    }
    for (const line of lines) paintAgentLine(line);
  }
  // The prompt an agent was given, drawn as the chat draws a prompt: its bubble, with the time the
  // agent started under it. A restored agent may not have kept it.
  function agentPromptMessage(record) {
    const prompt = agentPromptOf(record);
    if (!prompt) {
      const note = el("div", "sys hist");
      note.textContent = "This agent's prompt was not kept in the chat.";
      return note;
    }
    const m = el("div", "msg user agent-prompt");
    const role = m.appendChild(el("div", "role"));
    role.textContent = record.parent_id ? "its parent agent" : "the main agent";
    const bubble = m.appendChild(el("div", "bubble"));
    fillUserBubble(bubble, prompt, []);
    stampPrompt(m, Number(record.started_at) * 1000);
    return m;
  }
  // One builder for an agent's work, wherever it is drawn: its page, and the agent map's transcript.
  // `into` is emptied and filled. The page leads with what the agent reported, then its steps; a
  // transcript (`conversation`) reads in the order it happened: the prompt it was given, its steps,
  // then its report.
  function buildAgentWork(id, into, { lines = agentPageLines, images = agentPageImageRecords, open = null, conversation = false } = {}) {
    into.replaceChildren();
    const record = agentRecords.get(id);
    if (!record) return;
    const report = [];
    const outcome = agentOutcomeNote(id);
    if (outcome) report.push(outcome);
    const answer = agentAnswerText(record);
    if (answer) {
      const block = el("div", "text agent-answer");
      block.innerHTML = md(answer);
      report.push(block);
    }
    const files = document.createDocumentFragment();
    paintAgentFiles(files, record);
    report.push(...files.childNodes);
    const told = report.some((node) => !node.classList.contains("agent-page-outcome"));
    if (conversation) into.appendChild(agentPromptMessage(record));
    else into.append(...report);
    paintAgentTranscript(id, into, { lines, images, open, told, below: conversation });
    if (conversation) into.append(...report);
  }
  function paintAgentFiles(into, record) {
    const items = agentHandoffFiles(record.message);
    if (!items.length) return;
    const card = el("div", "agent-change-card");
    // The handoff names files the agent wrote or files worth opening: it does not say which.
    const title = el("div", "agent-change-title", icon("file-text"));
    title.appendChild(document.createTextNode("Files to open"));
    const list = el("ul", "agent-files");
    for (const { path, note, folder } of items) {
      const row = el("li", "agent-file-row");
      if (folder) {
        row.appendChild(el("span", "agent-folder")).textContent = path;
      } else {
        const link = document.createElement("button");
        link.type = "button";
        link.className = "agent-file";
        link.textContent = path;
        link.addEventListener("click", () => vscode.postMessage({ type: "openFile", path }));
        row.appendChild(link);
      }
      if (note) row.appendChild(el("span", "agent-file-note")).textContent = note;
      list.appendChild(row);
    }
    card.append(title, list);
    into.appendChild(card);
  }
  function syncAgentPageTick() {
    const record = agentPageId ? agentRecords.get(agentPageId) : null;
    const live = !!(record && AGENT_ACTIVE.has(record.state));
    if (live && !agentPageTick) {
      agentPageTick = setInterval(() => { if (agentPageId) paintAgentPageMeta(agentPageId); }, 1000);
    }
    if (!live && agentPageTick) { clearInterval(agentPageTick); agentPageTick = null; }
  }
  function paintAgentPageMeta(id) {
    const record = agentRecords.get(id);
    const meta = $("agent-page-meta");
    if (!record || !meta) return;
    const working = AGENT_ACTIVE.has(record.state);
    const ms = working ? agentLiveMs(record) : Number(record.duration_ms || 0);
    // Where the agent worked, which the chat's "↳ isolated checkout" notice used to say.
    meta.textContent = `${working ? "Working" : "Worked"} for ${agentElapsed(ms)}${record.isolated ? " · isolated checkout" : ""}`;
  }
  // The spawn's own result says whether the agent's changes reached your checkout; its line only says
  // it finished. The page says what was integrated, above the agent's report -- and says it plainly
  // when the changes were held back, with where the worktree is kept (dgc/agent.py; a test pins the
  // sentences). The result is replayed, so a reload draws the same note. A background spawn's result
  // ("is running in the background") is not an outcome and draws none.
  const AGENT_OUTCOME = /^Sub-task '[\s\S]*?' (?:completed and integrated|partly integrated|completed but its changes were NOT integrated)/;
  const AGENT_OUTCOME_HELD = /^Sub-task '[\s\S]*?' (?:partly integrated|completed but its changes were NOT integrated)/;
  function agentOutcomeNote(id) {
    const out = agentAnchor(id)?.querySelector(".body pre")?.textContent || "";
    if (!AGENT_OUTCOME.test(out)) return null;
    const note = el("p", "agent-page-outcome");
    note.textContent = out.split("\nSummary:")[0].trim().slice(0, 600);
    if (AGENT_OUTCOME_HELD.test(out)) note.dataset.held = "1";
    return note;
  }
  function paintAgentPage(id) {
    const record = agentRecords.get(id);
    const page = $("agent-page"), agentLog = $("agent-log"), mark = $("agent-mark"), title = $("thread-title");
    if (!record || !page || !agentLog) return;
    for (const line of agentPageLines) clearTimeout(line.timer);
    agentPageLines = [];
    const name = agentDisplayName(record);
    const keepBottom = page.scrollHeight - page.scrollTop - page.clientHeight < 24;
    const keep = page.scrollTop;
    // The page is rebuilt; a nested agent's name that had focus gets it back.
    const active = document.activeElement;
    const focused = active && agentLog.contains(active) ? active.closest(".agent-name")?.dataset.agentId || "" : "";
    if (mark) { mark.hidden = false; paintAgentMark(mark, id, AGENT_ACTIVE.has(record.state)); }
    if (title) {
      title.textContent = name;
      title.title = name;
      title.setAttribute("aria-label", name);
    }
    paintAgentPageMeta(id);
    clearAgentPageImages();
    buildAgentWork(id, agentLog, { lines: agentPageLines, images: agentPageImageRecords });
    syncAgentPageTick();
    page.scrollTop = keepBottom ? page.scrollHeight : keep;
    if (focused) focusQuietly(agentLog.querySelector(`.agent-name[data-agent-id="${cssEscape(focused)}"]`), { preventScroll: true });
  }
  // Back says where it goes: to the parent agent's page when this one was opened from it, else to the
  // chat. Through retitle: hoverTip.hide() puts back the title it lifted, undoing a direct write.
  function paintAgentBack() {
    const back = $("agent-back");
    if (!back) return;
    const parent = agentPageStack.length ? agentRecords.get(agentPageStack.at(-1)) : null;
    const label = parent ? `Back to ${agentDisplayName(parent)}` : "Back to chat";
    hoverTip.retitle(back, label);
    back.setAttribute("aria-label", label);
  }
  // Image records a drawing of an agent's work held, let go of when that drawing is replaced.
  function clearImageRecords(list) {
    for (const record of list) {
      if (!record.ref) continue;
      const records = imageRefs.get(record.ref);
      records?.delete(record);
      if (records?.size === 0) imageRefs.delete(record.ref);
    }
  }
  function clearAgentPageImages() {
    clearImageRecords(agentPageImageRecords);
    agentPageImageRecords = [];
  }
  // Two things lock the box: an agent's page (read-only until you go back to the chat), and this session
  // being open in another window (read-only until Open here).
  let agentPageLock = false, elsewhereLock = false;
  function lockAgentComposer(locked) { agentPageLock = locked; applyComposerLock(); }
  function applyComposerLock() {
    const locked = agentPageLock || elsewhereLock;
    composerLocked = locked;
    const box = $("cbox");
    box?.classList.toggle("agent-page-locked", locked);
    box?.setAttribute("aria-disabled", String(locked));
    input.setAttribute("contenteditable", String(!locked));
    input.setAttribute("aria-disabled", String(locked));
    input.setAttribute("aria-label", agentPageLock ? "Message DGC unavailable while viewing an agent"
      : elsewhereLock ? "Message DGC unavailable: this session is open in another window" : "Message DGC");
    input.dataset.placeholder = agentPageLock ? "Return to the chat to send a message"
      : elsewhereLock ? "Open here to carry on in this window" : composerPlaceholder;
    // The locked box shows these words in place of the box (main.css); a session open elsewhere says Open here.
    composerLockWords = agentPageLock ? "Return to the chat to send a message" : "Open here to carry on in this window";
    box?.querySelector(".cinput")?.setAttribute("data-locked", composerLockWords);
    $("btn-add").disabled = locked;
    $("btn-cmd").disabled = locked;
    if (locked) hidePop();
    renderComposerControls();
  }
  // Where it is open and what runs there, when the DGC holding it said so (the host's holderWords.ts): "Open in Cursor ·
  // ~/toni-erp · idle 6 min." in bold, then what runs and waits there. Otherwise the plain sentence. Text only.
  function elsewhereWords(node, note, plain) {
    if (!node) return;
    const head = typeof note?.head === "string" ? note.head.slice(0, 300) : "";
    if (!head) { node.textContent = plain; return; }
    const where = document.createElement("strong");
    where.className = "elsewhere-where";
    where.textContent = head;
    const detail = typeof note.detail === "string" ? note.detail.slice(0, 600) : "";
    node.replaceChildren(where, ...(detail ? [document.createTextNode(` ${detail}`)] : []));
  }
  // This session is shown in another window ("Open here" there), or this window stopped answering and its
  // backend kept the session running without it. Nothing stopped: the turn goes on where the session is.
  function showSessionElsewhere(msg) {
    const bar = $("elsewhere-bar"), state = String(msg?.state || "none");
    if (!bar) return;
    const button = $("elsewhere-open");
    if (state !== "moved" && state !== "elsewhere") {
      bar.hidden = true; elsewhereLock = false; if (button) button.disabled = false;
      holdWork(false);                     // each as it was, then the box works out its own again
      applyComposerLock();
      return;
    }
    const plain = state === "moved" && msg.reason === "no_window"
      ? "This window stopped answering, so DGC kept the session running without it."
      : state === "moved" ? "This session is open in another window now."
      : "This session is open in another window.";
    elsewhereWords($("elsewhere-text"), msg.note, plain);
    bar.hidden = false;
    if (button) button.disabled = false;
    if (state === "moved" && turn) { releaseHeldEvents(); endTurn("moved"); setSending(false); }
    elsewhereLock = true;
    applyComposerLock();
    holdWork(true);
  }
  // Read-only while this session is open in another window: every control that would change it is off (disabled,
  // aria-disabled, out of the tab order, the muted look), in the transcript and the box alike. Copy, read aloud,
  // links, files and what only shows more stay usable. What the transcript draws meanwhile is held as it comes.
  const WORK_HOLDS = [
    ...["up", "down", "branch", "pip", "retry", "edit"].map((act) => `.response-actions [data-act="${act}"]`),  // a reply's own
    ...["button", "textarea", "input", "select"].map((tag) => `.card[data-request-id] ${tag}`),      // a tool, a plan, a server's input
    "section.ask button", "section.ask input", "section.ask textarea",                              // a question in the box
    ".recovery-card .act.primary", ".task-interrupted button", ".ts-undo", ".learn-actions button",  // Continue, run again, Undo, Save
    ".steer-now", ".steer-all", ".pip-report-fix", ".pip-report-fix-slim", "#tasks-clear",
    "#btn-add", "#btn-cmd", "#btn-mode", "#btn-model", "#btn-goal", "#btn-mic", "#ctx-compact", "#ctx-size",
    "#ctx-size-custom", "#queue-send", "#send",
  ].join(", ");
  let workHeldWatch = null;
  function holdWork(locked) {
    for (const node of document.querySelectorAll(locked ? WORK_HOLDS : '[data-held="1"]')) {
      const text = node.tagName === "TEXTAREA" || (node.tagName === "INPUT" && !["radio", "checkbox"].includes(node.type));
      if (locked) {
        if (node.dataset.held !== "1") { node.dataset.held = "1"; node.dataset.heldWas = (text ? node.readOnly : node.disabled) ? "1" : ""; }
        if (text) node.readOnly = true; else node.disabled = true;
        node.setAttribute("aria-disabled", "true");
      } else {
        if (text) node.readOnly = node.dataset.heldWas === "1"; else node.disabled = node.dataset.heldWas === "1";
        node.removeAttribute("aria-disabled");
        delete node.dataset.held; delete node.dataset.heldWas;
      }
    }
    if (locked && !workHeldWatch) {
      let due = false;
      workHeldWatch = new MutationObserver(() => {
        if (due) return;
        due = true;
        setTimeout(() => { due = false; if (elsewhereLock) holdWork(true); }, 0);
      });
      workHeldWatch.observe(document.body, { childList: true, subtree: true });
    } else if (!locked && workHeldWatch) { workHeldWatch.disconnect(); workHeldWatch = null; }
  }
  $("elsewhere-open")?.addEventListener("click", (e) => {
    e.currentTarget.disabled = true;
    vscode.postMessage({ type: "openSessionHere" });
  });
  // `from`: the control that opened the page, which gets focus back when the chat does. `nested`:
  // opened from a nested agent's name on its parent's page, so Back returns to that page. Any other
  // way in (the chat, the agents list) starts over, and Back goes to the chat.
  function openAgentPage(id, { from = null, nested = false } = {}) {
    const record = agentRecords.get(id);
    if (!record) return;
    if (!agentPageId) {
      agentPageParentTitle = $("thread-title")?.textContent || "";
      agentPageScroll = log.scrollTop;
      agentPageReturnFocus = from;
      agentPageStack = [];
    } else if (nested) {
      if (agentPageId !== id) {
        const at = agentPageStack.indexOf(id);
        if (at >= 0) agentPageStack.length = at;
        agentPageStack.push(agentPageId);
      }
    } else {
      agentPageStack = [];
      if (from) agentPageReturnFocus = from;
    }
    agentPageId = id;
    document.body.dataset.agentPage = id;
    lockAgentComposer(true);
    const back = $("agent-back");
    if (back) back.hidden = false;
    const page = $("agent-page");
    if (page) page.hidden = false;
    log.setAttribute("aria-hidden", "true");
    paintAgentBack();
    paintAgentPage(id);
    back?.focus();
  }
  // One level at a time: from a nested agent's page back to its parent's (focus on the name that
  // was used), and from there to the chat. `all` closes every level at once (a chat reset).
  function closeAgentPage({ all = false } = {}) {
    if (!agentPageId) return;
    const left = agentPageId;
    if (!all) {
      while (agentPageStack.length) {
        const parent = agentPageStack.pop();
        if (!agentRecords.has(parent)) continue;
        agentPageId = parent;
        document.body.dataset.agentPage = parent;
        paintAgentBack();
        paintAgentPage(parent);
        focusQuietly($("agent-log")?.querySelector(`.agent-name[data-agent-id="${cssEscape(left)}"]`) || $("agent-back"),
          { preventScroll: true });
        return;
      }
    }
    const restoreTitle = agentPageParentTitle;
    const restoreScroll = agentPageScroll;
    const returnFocus = agentPageReturnFocus;
    agentPageId = "";
    agentPageParentTitle = "";
    agentPageScroll = 0;
    agentPageStack = [];
    agentPageReturnFocus = null;
    delete document.body.dataset.agentPage;
    lockAgentComposer(false);
    const back = $("agent-back"), mark = $("agent-mark"), page = $("agent-page"), agentLog = $("agent-log"), title = $("thread-title");
    if (back) back.hidden = true;
    paintAgentBack();
    if (mark) { mark.hidden = true; mark.removeAttribute("data-mark"); mark.removeAttribute("data-face"); }
    if (page) page.hidden = true;
    clearAgentPageImages();
    for (const line of agentPageLines) clearTimeout(line.timer);
    agentPageLines = [];
    if (agentLog) agentLog.replaceChildren();
    log.removeAttribute("aria-hidden");
    if (title) {
      const name = restoreTitle || "Untitled chat";
      title.textContent = name;
      title.title = `${name} — click to rename`;
      title.setAttribute("aria-label", `Current chat: ${name}. Click to rename`);
      document.title = `${name} — DGC`;
    }
    if (agentPageTick) { clearInterval(agentPageTick); agentPageTick = null; }
    log.scrollTop = restoreScroll;
    // Back where the reader left: the name (or the agents pill) that opened the page. A chat reset
    // closing every level leaves focus where the reset put it.
    if (all) return;
    const target = returnFocus?.isConnected && !returnFocus.closest("[hidden]") ? returnFocus
      : log.querySelector(`.agent-name[data-agent-id="${cssEscape(left)}"]`);
    if (target) focusQuietly(target, { preventScroll: true });
  }
  const agentAnchors = new Map();          // id -> the task card this record claimed
  let agentTotalExtra = 0, agentActiveExtra = 0;   // a snapshot's records it did not itemise
  let agentOrder = 0;
  let agentsAnnounceTimer = null, agentsSpokenActive = false;
  const agentsBatch = new Set();           // ids active since the last "working" announcement
  let agentStepRepaint = 0;                // coalesces live-step repaints into one per frame
  // Set by a rewind until its snapshot arrives: the replayed cards must not be claimed by records
  // the rewind is about to prune (call_0 repeats in every turn of a provider that sends no ids).
  let agentsHoldClaims = false;

  // A turn starting or ending changes no agent, but it is what the map's root shows: the main agent
  // working or idle. The pill and the map belong to the whole chat, so neither clears here.
  function agentsTurnBegin() { renderAgents(); }
  function agentsTurnEnd() { renderAgents(); }

  function agentNow() { return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now(); }
  function agentPlural(n, word) { return `${n} ${word}${n === 1 ? "" : "s"}`; }
  function agentElapsed(ms) {
    const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  function agentLiveMs(record) {
    return Number(record.elapsed_ms || 0) + Math.max(0, agentNow() - Number(record.receivedAt || agentNow()));
  }
  // Every agent in the chat, in any state: what the pill and the map count. `total` and `active`
  // include the ones a bounded snapshot did not itemise.
  function agentCounts() {
    const c = { queued: 0, running: 0, waiting: 0, waitingPermission: 0, waitingAnswer: 0,
      finished: 0, failed: 0, stopped: 0 };
    for (const record of agentRecords.values()) {
      if (record.state in c) c[record.state] += 1;
      if (record.state === "waiting") {
        if (record.waiting_for === "answer") c.waitingAnswer += 1; else c.waitingPermission += 1;
      }
    }
    c.active = c.queued + c.running + c.waiting + agentActiveExtra;
    c.total = agentRecords.size + agentTotalExtra;
    return c;
  }

  function agentRecordFrom(fields, receivedAt) {
    const record = { ...fields, receivedAt, order: agentOrder++ };
    delete record.type; delete record.seq; delete record.request_id;
    record.description = String(record.description || "");
    record.tool_calls = Number(record.tool_calls || 0);
    if (record.state !== "waiting") delete record.waiting_for;
    if (!(Number.isSafeInteger(record.face_slot) && record.face_slot >= 0)) delete record.face_slot;
    return record;
  }

  function applyAgentEvent(ev) {
    const id = String(ev.id || "");
    if (!id) return;
    const record = agentRecords.get(id);
    const now = agentNow();
    let pagePainted = false;
    if (ev.type === "agent_started") {
      if (record) return;
      agentsHoldClaims = false;
      // The start of its "started working" window -- unless it is queued behind a worker, when the
      // window opens as one takes it (below).
      agentRecords.set(id, agentRecordFrom({ ...ev, elapsed_ms: 0,
        startedLiveAt: ev.state === "queued" ? undefined : now }, now));
      agentsBatch.add(id);
      pagePainted = claimAgentAnchors();
    } else if (ev.type === "agent_updated") {
      if (!record || !AGENT_ACTIVE.has(record.state)) return;
      if (record.state === "queued" && ev.state !== "queued") {
        record.receivedAt = now; record.elapsed_ms = 0; record.startedLiveAt = now;
      }
      record.state = String(ev.state || record.state);
      if (ev.state === "waiting" && ev.waiting_for) record.waiting_for = ev.waiting_for; else delete record.waiting_for;
      for (const key of ["activity", "model", "tool_calls", "tokens"]) if (key in ev) record[key] = ev[key];
    } else if (ev.type === "agent_ended") {
      if (!record) { if (agentActiveExtra > 0) agentActiveExtra -= 1; renderAgents(); return; }
      if (!AGENT_ACTIVE.has(record.state)) return;
      record.state = String(ev.state || "finished");
      record.endedAt = now;
      record.endedWall = Date.now();
      for (const key of ["duration_ms", "tool_calls", "tokens", "message"]) if (key in ev) record[key] = ev[key];
      delete record.waiting_for; delete record.activity;
      agentStopping.delete(id);
    }
    const current = agentRecords.get(id);
    if (current) agentLineChanged(current, ev.type, pagePainted);
    renderAgents();
    agentAnnounce();
    pipFixAgentChanged(id);
  }

  function renderAgentsSnapshot(ev) {
    const items = Array.isArray(ev.items) ? ev.items : [];
    const now = agentNow();
    const previous = new Map(agentRecords);
    agentRecords.clear();
    for (const item of items) {
      if (item && typeof item === "object" && item.id && !agentRecords.has(String(item.id))) {
        const record = agentRecordFrom(item, now);
        const prior = previous.get(String(item.id));
        // A face never leaves an agent mid-life: a snapshot without its slot keeps the one it had.
        if (record.face_slot === undefined && Number.isSafeInteger(prior?.face_slot)) record.face_slot = prior.face_slot;
        // Keep the position it already had. Without this every snapshot renumbered every agent in
        // whatever order the backend happened to list them, and the rows moved around mid-turn.
        if (prior && typeof prior.order === "number") record.order = prior.order;
        record.endedAt = prior?.endedAt;
        record.endedWall = prior?.endedWall;
        // A snapshot carries a live start window over and never opens one: a reload, a resume or a
        // chat switch never says "started working".
        record.startedLiveAt = prior?.startedLiveAt;
        // The step log an agent's page collected live is not in the snapshot of a running agent.
        if (!Array.isArray(record.log) && Array.isArray(prior?.log)) record.log = prior.log;
        agentRecords.set(String(item.id), record);
      }
    }
    const listedActive = [...agentRecords.values()].filter((r) => AGENT_ACTIVE.has(r.state)).length;
    agentTotalExtra = Math.max(0, Number(ev.total || 0) - agentRecords.size);
    agentActiveExtra = Math.max(0, Number(ev.active || 0) - listedActive);
    let pagePainted = false;
    holdReadingPlace(() => {
      // A record the snapshot no longer lists (it holds 64 at most: the active, then the newest
      // ended) gives its card back. Its spawn then reads "Delegated <what it was asked to do>", which
      // is what a reload draws for it, since a card no record claims stays the plain step it is.
      for (const [id, card] of [...agentAnchors]) {
        if (!agentRecords.has(id)) {
          if (card.isConnected && card.dataset.agentId === id) unclaimAgentCard(card);
          agentAnchors.delete(id);
        } else if (!card.isConnected) agentAnchors.delete(id);
      }
      agentsHoldClaims = false;
      pagePainted = claimAgentAnchors();
      layoutAgentLines();          // a card given back can split a batch, even when nothing was claimed
      for (const record of agentRecords.values()) provisionalAgentLine(record);
      repaintAgentLines();
    });
    if (agentPageId && agentRecords.has(agentPageId) && !pagePainted) paintAgentPage(agentPageId);
    // A snapshot never speaks. It drops from the batch only the agents it no longer lists, so an
    // agent that ended before a mid-batch snapshot (list_agents while busy, a reload, a resync)
    // is still in the "Agents finished: …" count when the batch ends.
    clearTimeout(agentsAnnounceTimer); agentsAnnounceTimer = null;
    for (const id of [...agentsBatch]) if (!agentRecords.has(id)) agentsBatch.delete(id);
    for (const record of agentRecords.values()) if (AGENT_ACTIVE.has(record.state)) agentsBatch.add(record.id);
    agentsSpokenActive = agentCounts().active > 0;
    renderAgents();
  }

  // ---- anchors: which task card is this agent's ----
  // call_ids repeat across turns (call_0, call_1…), so a record claims one card and keeps it: among
  // the task cards carrying its call_id that no other record holds, records and cards pair up from
  // the newest backwards (so the latest turn's record takes the latest turn's card).
  function agentAnchor(id) {
    const card = agentAnchors.get(id);
    if (card && card.isConnected && card.dataset.agentId === id) return card;
    if (card) agentAnchors.delete(id);
    return null;
  }
  // A claimed spawn card back to what it was before the claim: a top-level step of the chat, shown,
  // or a nested agent's spawn, which stays its parent's hidden work.
  function unclaimAgentCard(card) {
    const owner = innermostAgentId(card.dataset.callId);
    if (owner) card.dataset.agentId = owner;
    else { delete card.dataset.agentId; card.classList.remove("agent-owned"); }
    refreshToolGroup(card.closest(".tool-group"));
  }
  // Pairs records with their cards and, when it claims any, lays the lines out: every caller (an
  // agent starting, a task card arriving, the agents list, a snapshot) gets the same layout. True
  // when it repainted the open agent page.
  function claimAgentAnchors() {
    if (agentsHoldClaims) return false;
    const waiting = new Map();
    for (const record of [...agentRecords.values()].sort((a, b) => a.order - b.order)) {
      if (!record.call_id || agentAnchor(record.id)) continue;
      const key = String(record.call_id);
      if (!waiting.has(key)) waiting.set(key, []);
      waiting.get(key).push(record);
    }
    if (!waiting.size) return false;
    // The chat's own cards only. An open agent page holds clones of them, later in the document, and
    // the newest-first pairing would hand a clone to the newest record.
    const cards = [...log.querySelectorAll('.tool[data-tool-name="task"]')];
    const pairs = [];
    for (const [callId, records] of waiting) {
      const free = cards.filter((card) => card.dataset.callId === callId
        && !(card.dataset.agentId && agentAnchor(card.dataset.agentId) === card));
      for (let i = records.length - 1, j = free.length - 1; i >= 0 && j >= 0; i -= 1, j -= 1) pairs.push([records[i], free[j]]);
    }
    if (!pairs.length) return false;
    // A claim hides the spawn's group, so the block it is in gets shorter -- often a block above the
    // reader, when a snapshot claims a whole history. The reader stays where they are.
    holdReadingPlace(() => {
      for (const [record, card] of pairs) {
        card.dataset.agentId = record.id;
        card.classList.add("agent-owned");
        refreshToolGroup(card.closest(".tool-group"));
        agentAnchors.set(record.id, card);
      }
      layoutAgentLines();
    });
    const claimed = pairs.map(([record]) => record);
    if (agentPageId && claimed.some((r) => r.id === agentPageId || r.parent_id === agentPageId)) {
      paintAgentPage(agentPageId);
      return true;
    }
    return false;
  }
  function agentsToolCard(card, ev) {
    const fromCall = agentIdFromCall(card.dataset.callId || ev.call_id);
    if (fromCall) {
      // A child's step belongs to the agent that made it -- the innermost id, as its reasoning's
      // `agent` is -- so a nested child's work is on its own page, not its parent's.
      card.dataset.agentId = innermostAgentId(card.dataset.callId || ev.call_id) || fromCall;
      card.classList.add("agent-owned");
      refreshToolGroup(card.closest(".tool-group"));
    }
    if (card.dataset.toolName !== "task" || !agentRecords.size) return;
    // A replayed page is built detached and inserted when it is complete; claim once it is.
    const claim = () => { claimAgentAnchors(); agentMapChanged(); };
    if (replaying || !card.isConnected) queueMicrotask(claim);
    else claim();
  }

  // ---- the pill ----
  function renderAgents() {
    renderAgentsPill();
    agentMapChanged();
  }
  // The pill says what runs NOW: the agents working (Claude Code's counting rule) and the background
  // tasks the map lists, counted from the map's own list so the two never disagree -- "2 agents",
  // "2 tasks", "1 agent · 2 tasks". Once the chat has had an agent the pill stays for the rest of it
  // -- "0 agents" when nothing runs -- so the map is always one click away; a chat that never had one
  // shows it only while a task runs (/agents still opens the map). With no task running it reads as
  // it always did. A narrow footer keeps only the total running (`.agents-short`) beside the dot.
  function renderAgentsPill() {
    const picker = $("agents-picker"), pill = $("agents-pill");
    if (!picker || !pill) return;
    const c = agentCounts(), tasks = amRunningTasks().length;
    if (c.total <= 0 && tasks <= 0) {
      hoverTip.hide();
      picker.hidden = true;
      return;
    }
    picker.hidden = false;
    const n = c.active;
    const state = c.waiting > 0 ? "waiting" : n > 0 || tasks > 0 ? "running" : "idle";
    const label = n > 0 && tasks > 0 ? `${agentPlural(n, "agent")} · ${agentPlural(tasks, "task")}`
      : tasks > 0 ? agentPlural(tasks, "task") : agentPlural(n, "agent");
    const inBackground = tasks > 0 ? `${agentPlural(tasks, "background task")} running` : "";
    const said = state === "waiting"
      ? [c.waitingPermission > 0 ? "An agent is waiting for your permission" : "An agent is waiting for your answer", inBackground]
      : state === "idle" ? ["No agents working"]
      : [n > 0 ? (tasks > 0 ? `${agentPlural(n, "agent")} working and ${inBackground}` : "Agents are working") : inBackground];
    const title = [...said.filter(Boolean), "Click to open the agent map"].join(" · ");
    pill.dataset.state = state;
    agentsSetText(pill.querySelector(".agents-text"), label);
    agentsSetText(pill.querySelector(".agents-short"), String(n + tasks));
    pill.querySelector(".agents-need").hidden = state !== "waiting";
    hoverTip.retitle(pill, title);
    pill.setAttribute("aria-label", `${label} · ${title}`);
  }

  function agentSummary(c) {
    const parts = [agentPlural(c.total, "agent")];
    for (const [count, label] of [[c.running, "working"], [c.waitingPermission, "waiting for your permission"],
      [c.waitingAnswer, "waiting for your answer"], [c.queued, "queued"], [c.finished, "finished"],
      [c.failed, "failed"], [c.stopped, "stopped"]]) {
      if (count > 0) parts.push(`${count} ${label}`);
    }
    return parts.join(" · ");
  }
  // A failure message can be many lines of provider JSON: a row shows one bounded line and the
  // row's label carries the whole (already redacted and URL-scrubbed) text.
  function agentFirstLine(text, limit = 120) {
    const line = (String(text || "").split("\n").find((part) => part.trim()) || "")
      .replace(/^\s*#{1,6}\s+/, "").replace(/\s+/g, " ").trim();
    if (line.length <= limit) return line;
    let cut = limit - 1;
    const marker = line.lastIndexOf("[REDACTED]", cut);
    if (marker >= 0 && marker < cut && cut < marker + 10) cut = marker;   // never half a marker
    return `${line.slice(0, cut).trimEnd()}…`;
  }
  // Rows are kept per record and updated in place: the 1 s tick and every frame change only the
  // text, dot and label that changed, so a focused row keeps its focus (a screen reader does not
  // re-read it), its hover label stays put and a click that spans a tick still lands.
  function agentsSetText(node, text) { if (node.textContent !== text) node.textContent = text; }
  // The FILES line of an agent's handoff: files it wrote or files worth opening. A model may
  // annotate an entry ("frontend/test-results/ (40 × error-context.md)"): the note is kept apart
  // from the path, and a folder is named but not offered as a file to open.
  function agentHandoffFiles(message) {
    const line = String(message || "").split("\n").find((part) => /^\s*FILES:/i.test(part));
    if (!line) return [];
    return line.split(":").slice(1).join(":").split(",").map((part) => {
      const entry = part.trim().replace(/^`|`$/g, "");
      const annotated = entry.match(/^(.*?\S)\s+(\(.*\))$/);
      const path = (annotated ? annotated[1] : entry).replace(/^`|`$/g, "");
      return { path, note: annotated ? annotated[2] : "", folder: /[\\/]$/.test(path) };
    }).filter((item) => item.path).slice(0, 8);
  }
  // Put `nodes` in `list` in order, moving only the ones out of place (a moved node loses focus).
  function agentsPlace(list, nodes) {
    const wanted = new Set(nodes);
    for (const child of [...list.children]) if (!wanted.has(child)) child.remove();
    let cursor = list.firstElementChild;
    for (const node of nodes) {
      if (node === cursor) { cursor = cursor.nextElementSibling; continue; }
      list.insertBefore(node, cursor);
    }
  }

  // ---- the agent map ----
  // Claude Code's map, drawn DGC's way. A dialog over the chat: the main agent, its sub-agents in a
  // column beside it and theirs a column further on, as deep as the nesting goes; below that, what
  // runs in the background. Every agent the chat has had is on it, in any state, until the chat
  // resets. A dialog too narrow for the columns (a side bar) stands the tree on end instead: the
  // root on top and each level indented under a spine. Which of the two is decided by measuring the
  // dialog, never the window, so an editor tab and a side bar each draw the one that fits them.
  const AM_ROOT_MIN = 220, AM_ROOT_MAX = 300;   // the root's width, beside its columns
  const AM_ROW_MIN = 200, AM_ROW_MAX = 300;     // an agent's, in a column
  const AM_GUTTER = 32;                         // from a row to its column: a stub, the spine, an elbow
  const AM_STACK_MIN = 180;                     // the narrowest a row gets when the tree stands on end
  const amRows = new Map();                     // agent id -> its row and nested list, kept across renders
  const amTaskRows = new Map();                 // task key -> its row
  const agentStopping = new Map();              // agent id -> "stopping" | "failed", until it ends
  const taskStopping = new Map();               // task key -> "stopping" | "failed", while it runs
  const taskEndedWall = new Map();              // task key -> when this page first saw it ended
  let amOpen = false, amOpener = null, amByCommand = false, amCard = null, amTx = null, amWidth = 0;
  let amTick = 0, amObserver = null, amRoot = null, amPainting = false;
  // The open shell's or monitor's output: asked for each second while its card is open, the task
  // runs and the panel is on screen, and once more when it ends.
  let amOutput = null;
  // What runs in the background, from the snapshots the panel already receives. Background shells
  // come only from a CLI with `background_tasks`; their list is the backend's, ended ones included.
  let shellItems = [];
  const monitorLines = new Map();               // monitor id -> the lines its events brought, newest last
  const previews = new Map();                   // artifact id -> what this chat knows of that preview

  function agentMapOpen() { return amOpen; }
  function agentMapChanged() { if (amOpen && !amPainting) renderAgentMap(); }
  function agentMapCapabilities() {
    if (!backgroundTasksLive) shellItems = [];
    renderAgents();
  }
  // Tokens the way the map writes them: "950", "142.6k", "1.2M".
  function amTokens(n) {
    const value = Math.max(0, Math.floor(Number(n) || 0));
    if (value < 1000) return String(value);
    if (value < 1e6) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    return `${(value / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  }
  function amBytes(n) {
    const value = Math.max(0, Number(n) || 0);
    if (value < 1024) return `${value} bytes`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${(value / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
  }
  // Under a second is not worth saying, and nor is a count of none.
  function amDuration(ms) { return Number(ms) >= 1000 ? agentElapsed(ms) : ""; }
  function amAgentMs(record) {
    if (record.state === "running" || record.state === "waiting") return agentLiveMs(record);
    return AGENT_ACTIVE.has(record.state) || record.duration_ms == null ? 0 : Number(record.duration_ms);
  }
  const AM_STATE_WORD = { running: "Working", queued: "Queued", finished: "Finished", failed: "Failed", stopped: "Stopped" };
  function amStateWord(record) {
    if (record.state === "waiting") return record.waiting_for === "answer" ? "Waiting for your answer" : "Waiting for your permission";
    return AM_STATE_WORD[record.state] || String(record.state || "");
  }
  // How long and how much, plus the model when it is not the chat's. A restored record that kept no
  // numbers says none.
  function amAgentStats(record) {
    const parts = [];
    if (!(record.restored && record.duration_ms == null && record.tokens == null)) {
      const time = amDuration(amAgentMs(record));
      if (time) parts.push(time);
      if (Number(record.tokens || 0) > 0) parts.push(`${amTokens(record.tokens)} tokens`);
    }
    if (record.model && record.model !== curModel) parts.push(String(record.model));
    return parts;
  }

  // ---- the tree ----
  function amRank(record) { return AGENT_ACTIVE.has(record.state) ? 0 : record.state === "failed" ? 1 : 2; }
  // When an agent ended, on one clock: this page's for one it saw end, else its start plus its run.
  function amEndedWall(record) {
    if (Number.isFinite(record.endedWall)) return record.endedWall;
    const start = Number(record.started_at);
    return Number.isFinite(start) && start > 0 ? start * 1000 + Number(record.duration_ms || 0) : -Infinity;
  }
  // Working agents first, oldest first; then failed ones; then finished and stopped, newest end first.
  function amOrder(a, b) {
    const rank = amRank(a) - amRank(b);
    if (rank) return rank;
    if (amRank(a) === 2) return (amEndedWall(b) - amEndedWall(a)) || agentByStart(a, b);
    return agentByStart(a, b);
  }
  // parent id ("" for the main agent) -> its children, in the map's order. An agent whose parent the
  // map does not hold (a snapshot keeps 64) is drawn under the root, and so is one whose parents loop.
  function amTree() {
    const parentOf = (record) => {
      const parent = record.parent_id && agentRecords.has(String(record.parent_id)) ? String(record.parent_id) : "";
      const seen = new Set([record.id]);
      for (let at = parent; at;) {
        if (seen.has(at)) return "";
        seen.add(at);
        const up = agentRecords.get(at)?.parent_id;
        at = up && agentRecords.has(String(up)) ? String(up) : "";
      }
      return parent;
    };
    const children = new Map();
    for (const record of agentRecords.values()) {
      const parent = parentOf(record);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(record);
    }
    for (const list of children.values()) list.sort(amOrder);
    return children;
  }
  function amDepth(children, id = "") {
    let depth = 0;
    for (const record of children.get(id) || []) depth = Math.max(depth, 1 + amDepth(children, record.id));
    return depth;
  }
  // Side by side when the root and one column per level fit at their narrowest; each then takes an
  // equal share of what is left, up to its widest. Otherwise on end, the indent per level shrinking as
  // the tree deepens so the deepest row keeps a readable width.
  function amLayout(depth) {
    const box = $("agent-map-box"), tree = $("agent-map-tree");
    const need = AM_ROOT_MIN + depth * (AM_GUTTER + AM_ROW_MIN);
    const across = depth > 0 && amWidth >= need;
    if (across) {
      const share = Math.floor((amWidth - need) / (depth + 1));
      tree.style.setProperty("--am-root-w", `${Math.min(AM_ROOT_MAX, AM_ROOT_MIN + share)}px`);
      tree.style.setProperty("--am-row-w", `${Math.min(AM_ROW_MAX, AM_ROW_MIN + share)}px`);
    } else {
      // Even, so the spine at half the indent sits on a whole pixel.
      const indent = depth ? Math.max(8, Math.min(20, Math.floor((amWidth - AM_STACK_MIN) / depth))) : 20;
      tree.style.setProperty("--am-indent", `${indent - (indent % 2)}px`);
    }
    const layout = across ? "horizontal" : "vertical";
    if (box.dataset.layout !== layout) box.dataset.layout = layout;
  }
  // One row: a real button, so Tab, Enter and Space work. The dot is the state; the words say it too.
  function amRowNode(key, cls) {
    const row = el("button", `am-row ${cls}`);
    row.type = "button"; row.tabIndex = -1; row.dataset.amKey = key;
    const dot = el("span", "agent-dot"); dot.setAttribute("aria-hidden", "true");
    const text = el("span", "am-text"), desc = el("span", "am-desc"), meta = el("span", "am-meta");
    text.append(desc, meta);
    row.append(dot, text);
    return { row, dot, desc, meta, tip: "", label: "" };
  }
  function amLabel(entry, label, tip) {
    if (entry.label !== label) { entry.label = label; entry.row.setAttribute("aria-label", label); }
    if (entry.tip !== tip) { entry.tip = tip; hoverTip.retitle(entry.row, tip); }
  }
  function amRootEntry() {
    if (amRoot?.node.isConnected) return amRoot;
    const node = el("div", "am-node am-root-node"), self = el("div", "am-self");
    const parts = amRowNode("root", "am-root");
    parts.row.addEventListener("click", () => amOpenCard({ kind: "root" }, parts.row));
    self.appendChild(parts.row);
    const kids = el("ul", "am-children");
    kids.setAttribute("aria-label", "Started by the main agent");
    node.append(self, kids);
    $("agent-map-tree").replaceChildren(node);
    amRoot = { node, kids, ...parts };
    return amRoot;
  }
  function amChatName() { return chatTitleName || "This chat"; }
  function amRootMeta() {
    const parts = [curModel || "dgc"];
    const used = Math.max(0, Number(contextState.used || 0));
    if (used > 0) parts.push(`${amTokens(used)} tokens in context`);
    return parts;
  }
  function amPaintRoot(root) {
    const state = streaming ? "running" : "idle";
    if (root.dot.dataset.state !== state) root.dot.dataset.state = state;
    const name = amChatName(), meta = amRootMeta();
    agentsSetText(root.desc, name);
    agentsSetText(root.meta, meta.join(" · "));
    amLabel(root, `${name}, the main agent, ${streaming ? "working" : "idle"}, ${meta.join(", ")}`, `${name}\nThe main agent`);
  }
  function amAgentEntry(record) {
    let entry = amRows.get(record.id);
    if (entry) return entry;
    const item = el("li", "am-node"), self = el("div", "am-self");
    const parts = amRowNode(`agent:${record.id}`, "am-agent");
    parts.row.dataset.agentId = record.id;
    const face = el("span", "agent-mark am-face"); face.setAttribute("aria-hidden", "true");
    parts.row.insertBefore(face, parts.row.lastChild);
    const id = record.id;
    parts.row.addEventListener("click", () => amOpenCard({ kind: "agent", id }, parts.row));
    self.appendChild(parts.row);
    item.appendChild(self);
    entry = { item, kids: null, face, ...parts };
    amRows.set(record.id, entry);
    return entry;
  }
  function amPaintAgentRow(entry, record) {
    const { row, dot, desc, meta, face } = entry;
    if (dot.dataset.state !== record.state) dot.dataset.state = record.state;
    if (row.dataset.state !== record.state) row.dataset.state = record.state;
    paintAgentMark(face, record.id, AGENT_ACTIVE.has(record.state));
    // Work held back is why an older agent is still in view: its row says so, where "Finished" was.
    const name = agentDisplayName(record), stats = amAgentStats(record), word = amHeldBack(record) ? "Held back" : amStateWord(record);
    agentsSetText(desc, name);
    // The word leads for every state but working, so no state rests on the dot's colour alone.
    agentsSetText(meta, (record.state === "running" ? stats : [word, ...stats]).join(" · ") || word);
    const why = (record.state === "failed" || record.state === "stopped") && record.message ? agentFirstLine(record.message) : "";
    amLabel(entry, [name, word, ...stats].join(", "), `${name}${why ? `\n${why}` : ""}`);
  }

  // ---- what runs in the background ----
  const MONITOR_ENDS = { exited: "Exited", stopped: "Stopped", timeout: "Timed out", flood: "Stopped: too much output",
    error: "Failed", shutdown: "Stopped" };
  // A task's time: from its start to now while it runs, frozen at the moment it was seen to end.
  function amTaskMs(key, startWall, running, endWall) {
    if (!running && !taskEndedWall.has(key)) taskEndedWall.set(key, Number.isFinite(endWall) && endWall > 0 ? endWall : Date.now());
    if (!(Number.isFinite(startWall) && startWall > 0)) return 0;
    return Math.max(0, (running ? Date.now() : taskEndedWall.get(key)) - startWall);
  }
  function amMonitorTask(item) {
    const id = String(item.id), key = `monitor:${id}`;
    const running = item.state === "running" || item.state === "stopping";
    const ms = amTaskMs(key, Number(item.started_at) * 1000, running);
    const word = item.state === "running" ? "Running" : item.state === "stopping" ? "Stopping" : MONITOR_ENDS[item.end_reason] || "Ended";
    return { key, kind: "monitor", id, running, name: String(item.description || id), word, label: "monitor", ms,
      stoppable: item.state === "running", output: true, item,
      meta: ["monitor", amDuration(ms), eventCount(item.events)].filter(Boolean) };
  }
  function amShellTask(item) {
    const id = String(item.id), key = `shell:${id}`;
    const running = item.state === "running";
    const ms = amTaskMs(key, Number(item.started_at) * 1000, running, Number(item.ended_at) * 1000);
    const restarted = item.state === "stopped";       // a restart stopped it (dgc/stopped_work.py); Run again on its card
    const word = running ? "Running" : restarted ? "Stopped by a restart" : item.state === "killed" ? "Stopped"
      : `Exited${Number.isInteger(item.exit_code) ? ` · code ${item.exit_code}` : ""}`;
    return { key, kind: "shell", id, running, name: String(item.command || id), word, label: "shell", ms,
      stoppable: running, output: !restarted, item, rerun: restarted ? String(item.rerun || "") : "",
      meta: ["shell", restarted ? "stopped by a restart" : amDuration(ms)].filter(Boolean) };
  }
  function amTroupeTask(ev) {
    const id = String(ev.run_id), state = String(ev.state || "running"), running = state === "running";
    return { key: `troupe:${id}`, kind: "troupe", id, running, name: String(ev.title || "Troupe"), word: troupeStateWords(ev),
      label: "troupe", ms: 0, stoppable: running && !troupeStopping.has(id), stopping: troupeStopping.has(id), ev,
      meta: ["troupe", troupeSummary(ev).text] };
  }
  // A Pip run this chat started: live while it works -- what it is doing now (its own activity), its clock and Stop.
  function amPipTask(run) {
    const key = `pip:${run.id}`, running = run.active === true;
    const ms = amTaskMs(key, Number(run.startedAt), running);
    const word = running && run.status === "running" && run.activity ? String(run.activity) : String(run.label || "Working");
    return { key, kind: "pip", id: run.id, running, name: String(run.name || "Pip"), word, label: "Pip run", ms,
      stoppable: running && run.stoppable === true, stopping: run.status === "cancelling", run,
      meta: ["Pip run", word, ms ? amDuration(ms) : ""].filter(Boolean) };
  }
  function amPreviewTask(preview) {
    const key = `preview:${preview.id}`, running = preview.state !== "stopped";
    const up = Number.isFinite(preview.readyWall) ? agentElapsed(Date.now() - preview.readyWall) : String(preview.uptime || "");
    return { key, kind: "preview", id: preview.id, running, name: String(preview.name || preview.id), word: running ? "Running" : "Stopped",
      label: "preview", ms: 0, stoppable: running, preview, meta: ["preview", up ? `up ${up}` : ""].filter(Boolean) };
  }
  function amPipRuns() {
    try { return (pipSetupCards?.runs?.() || []).filter((run) => run && typeof run.id === "string"); } catch { return []; }
  }
  // Every task this chat knows, running or not: monitors, background shells, troupes, the Pip runs it
  // started and its artifact previews, in that order.
  function amAllTasks() {
    return [...monitorItems.map(amMonitorTask), ...shellItems.map(amShellTask),
      ...[...troupeRuns.values()].map(amTroupeTask), ...amPipRuns().map(amPipTask), ...[...previews.values()].map(amPreviewTask)];
  }
  // The ones running now: the map's "N background tasks" list, its root card and the pill all count
  // this, so no two of them can disagree.
  function amRunningTasks() { return amAllTasks().filter((task) => task.running); }
  // The map's list: what runs now, and a command a restart stopped until it is run again (its card has Run again).
  // Only the running ones are counted as running, by the pill, the root card and the list's title alike.
  function amListedTasks() { return amAllTasks().filter((task) => task.running || task.rerun); }
  function amTaskEntry(task) {
    let entry = amTaskRows.get(task.key);
    if (entry) return entry;
    const item = el("li", "am-task-item");
    const parts = amRowNode(task.key, "am-task");
    const key = task.key;
    parts.row.addEventListener("click", () => amOpenCard({ kind: "task", key }, parts.row));
    item.appendChild(parts.row);
    entry = { item, ...parts };
    amTaskRows.set(task.key, entry);
    return entry;
  }
  function amTaskState(task) {
    if (!task.running) return task.word === "Stopped" ? "stopped" : task.word.startsWith("Failed") ? "failed" : "finished";
    return task.word === "Stopping" || task.stopping || taskStopping.get(task.key) === "stopping" ? "stopping" : "running";
  }
  function amPaintTaskRow(entry, task) {
    const state = amTaskState(task);
    if (entry.dot.dataset.state !== state) entry.dot.dataset.state = state;
    agentsSetText(entry.desc, task.name);
    agentsSetText(entry.meta, task.meta.join(" · "));
    amLabel(entry, [task.name, task.word, ...task.meta].join(", "), task.name);
  }

  // ---- the three levels ----
  // The map; an agent's or a task's card over it; an agent's transcript (or a task's output) over that.
  // Each is its own window over a dimmed backdrop. ←, Esc and a click on the backdrop each go back
  // exactly one level -- transcript, card, map, closed -- and focus goes back to whatever opened the
  // level the reader comes back to: the card's Open button, the row, the pill or the prompt box.
  const AM_LAYERS = ["agent-map", "agent-card", "agent-transcript"];
  function amTopLayer() { return !amOpen ? "" : amTx ? "agent-transcript" : amCard ? "agent-card" : "agent-map"; }
  function amSyncLayers() {
    $("agent-map").hidden = !amOpen;
    $("agent-card").hidden = !amOpen || !amCard;
    $("agent-transcript").hidden = !amOpen || !amTx;
    // A covered window is out of reach until it is on top again: no focus, no clicks, nothing read out.
    const top = amTopLayer();
    for (const id of AM_LAYERS) {
      const covered = !$(id).hidden && id !== top;
      if (covered !== $(id).hasAttribute("inert")) $(id).toggleAttribute("inert", covered);
      if (covered) $(id).setAttribute("aria-hidden", "true"); else $(id).removeAttribute("aria-hidden");
    }
  }
  function amGoBack() {
    if (amTx) amCloseTranscript();
    else if (amCard) amCloseCard();
    else closeAgentMap();
  }

  // ---- painting ----
  function renderAgentMap() {
    if (!amOpen) return;
    amPainting = true;
    try {
      for (const [id] of agentStopping) if (!AGENT_ACTIVE.has(agentRecords.get(id)?.state)) agentStopping.delete(id);
      // Every open level stays live: the ones underneath show through the dimmed backdrop.
      paintAmMap();
      if (amCard) paintAmCard();
      if (amTx) paintAmTranscript();
    } finally { amPainting = false; }
    // Durations tick once a second; nothing is painted while the panel is out of sight.
    clearTimeout(amTick);
    amTick = setTimeout(function tick() {
      amTick = 0;
      if (!amOpen) return;
      if (document.hidden) { amTick = setTimeout(tick, 1000); return; }
      renderAgentMap();
    }, 1000);
  }
  // ---- now, and earlier in this chat ----
  // A long chat has had many agents, and a tree of every one of them is a wall of finished work. The
  // map shows what matters now: every agent working (queued, running or waiting); every agent the
  // chat's latest turn that started any started, so a short follow-up that started none leaves the map
  // as it was; and any older one that still needs the person -- its changes held back, with its
  // worktree kept (a question or a permission keeps it working, so it is shown already). A shown
  // agent's parents are shown too, so the tree stays honest. The rest is one row, "Earlier in this
  // chat", that opens to them grouped by the prompt that started them, newest first.
  //
  // Which turn started an agent is read from what the chat already holds, never added to the wire:
  // the turn its spawn card is in (the card the record claimed), else the turn the CLI named on
  // agent_started (`turn_id`, shared by every agent that turn started; a restored record's names an
  // earlier run of the CLI, so it is matched only with its own kind). A nested agent belongs to the
  // turn that started its top-level parent. A chat whose agents carry neither (an older CLI, a
  // snapshot without them) keeps the full tree it always had, and its subtitle.
  const AGENT_HELD_ANY = /^Sub-task '[\s\S]*?' (?:partly integrated|completed but its changes were NOT integrated|completed but was not integrated)/;
  const AM_EARLIER_PROMPT = "An earlier prompt";     // a group whose prompt is not on screen
  // Which chats keep Earlier open: this webview's own convenience, bounded like the checklist's.
  const amEarlierOpen = new Set((() => {
    try {
      const saved = vscode.getState()?.agentMapEarlier;
      return Array.isArray(saved) ? saved.filter((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)).slice(-32) : [];
    } catch { return []; }
  })());
  function amEarlierIsOpen() { return amEarlierOpen.has(draftSession); }
  function amSetEarlierOpen(open) {
    amEarlierOpen.delete(draftSession);
    if (open) amEarlierOpen.add(draftSession);
    while (amEarlierOpen.size > 32) amEarlierOpen.delete(amEarlierOpen.values().next().value);
    try { vscode.setState({ ...(vscode.getState() || {}), agentMapEarlier: [...amEarlierOpen] }); } catch {}
  }
  // Its changes were held back (not integrated, or partly), as its spawn's result says -- or, for a
  // background agent, the report its wake turn drew.
  function amHeldBack(record) {
    if (AGENT_ACTIVE.has(record.state)) return false;
    const out = agentAnchor(record.id)?.querySelector(".body pre")?.textContent || "";
    if (AGENT_HELD_ANY.test(out)) return true;
    if (!record.background) return false;
    const line = log.querySelector(`.handback-line[data-agent-id="${cssEscape(record.id)}"]`);
    return !!line?._handback && AGENT_HELD_ANY.test(splitAgentReport(line._handback.report)[0]);
  }
  // The words of the row that opened a turn, as the chat shows them: its prompt, or the note of a
  // turn nobody typed ("Woke on agent · …"). "" when the turn has no such row.
  function amTurnLabel(block) {
    if (!block?.parentElement?.classList.contains("turn")) return "";
    for (let node = block.previousElementSibling; node; node = node.previousElementSibling) {
      if (node.matches(".msg.user")) return railHeadText(node);
      if (node.matches(".resume-note")) {
        return ((node.querySelector(".handback-label") || node).textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
      }
      if (node.matches(".msg.dgc")) break;
    }
    return "";
  }
  // The map's two parts, or null when the chat cannot tell which turn started its agents (the full
  // tree). `children` is amTree()'s.
  function amPlan(children) {
    const tops = children.get("") || [];
    if (!tops.length) return null;
    const topOf = new Map(), parentOf = new Map();
    const walk = (id, top) => {
      for (const record of children.get(id) || []) {
        topOf.set(record.id, top); parentOf.set(record.id, id);
        walk(record.id, top);
      }
    };
    for (const top of tops) { topOf.set(top.id, top); parentOf.set(top.id, ""); walk(top.id, top); }
    // The turns this panel drew live, by the id the CLI gave them; the newest of an id repeated by a
    // CLI that started again. A replayed turn's id is the replay's own ("h3"), which no record names.
    const live = new Map();
    for (const block of log.querySelectorAll(".msg.dgc")) if (block._turnId) live.set(block._turnId, block);
    const told = (record) => (typeof record.turn_id === "string" && record.turn_id
      ? `${record.restored ? "restored" : "live"}:${record.turn_id}` : "");
    const blockOf = new Map(), toldBlock = new Map();
    for (const top of tops) {
      const card = agentAnchor(top.id);
      const block = card && log.contains(card) ? card.closest(".msg.dgc") : null;
      if (!block) continue;
      blockOf.set(top.id, block);
      // Only within one run of the CLI: two runs both had a "t3".
      if (told(top).startsWith("live:") && !toldBlock.has(told(top))) toldBlock.set(told(top), block);
    }
    const groups = new Map(), loose = [];
    const join = (id, block, top, counts = true) => {
      if (!groups.has(id)) groups.set(id, { id, block, tops: [], at: -Infinity, first: Infinity, order: -Infinity });
      const group = groups.get(id), at = Number(top.started_at);
      group.tops.push(top);
      if (!counts) return;
      if (Number.isFinite(at)) { group.at = Math.max(group.at, at); group.first = Math.min(group.first, at); }
      group.order = Math.max(group.order, Number(top.order) || 0);
    };
    for (const top of tops) {
      const key = told(top);
      let block = blockOf.get(top.id) || toldBlock.get(key) || null;
      if (!block && key.startsWith("live:")) block = live.get(top.turn_id) || null;
      if (!block && !key) { loose.push(top); continue; }
      if (block && !block._amGroup) block._amGroup = `turn-${++amGroupSerial}`;
      join(block ? block._amGroup : key, block, top);
    }
    if (!groups.size) return null;
    // Newest first: by when their agents started (the CLI's clock, the same for every record), then
    // by the order this panel learned of them.
    const newest = (a, b) => (b.at - a.at) || (b.order - a.order);
    // An agent no turn names (a Pip fix's, a CLI that sent no turn) goes with the turn that was the
    // latest when it started; one older than every turn, or with no start time, with the oldest.
    const placedNewest = [...groups.values()].sort(newest);
    for (const top of loose) {
      const at = Number(top.started_at);
      const home = Number.isFinite(at) ? placedNewest.find((group) => group.first <= at) : null;
      if (home) join(home.id, home.block, top, false);
      else join("unknown", null, top);
    }
    const ordered = [...groups.values()].sort(newest);
    if (groups.has("unknown")) { ordered.splice(ordered.indexOf(groups.get("unknown")), 1); ordered.push(groups.get("unknown")); }
    const latest = ordered[0];
    const thisTurn = new Set();
    for (const record of agentRecords.values()) if (latest.tops.includes(topOf.get(record.id))) thisTurn.add(record.id);
    const shown = new Set(thisTurn);
    for (const record of agentRecords.values()) {
      if (!topOf.has(record.id) || !(AGENT_ACTIVE.has(record.state) || amHeldBack(record))) continue;
      for (let id = record.id; id && !shown.has(id); id = parentOf.get(id)) shown.add(id);
    }
    // What each part draws under each row: the shown children of a shown agent; the earlier children
    // of an earlier one. An earlier agent whose parent is shown heads its group's list.
    const nowKids = new Map(), earlierKids = new Map();
    for (const [parent, list] of children) {
      const now = list.filter((record) => shown.has(record.id));
      if (now.length && (parent === "" || shown.has(parent))) nowKids.set(parent, now);
      const before = list.filter((record) => !shown.has(record.id));
      if (before.length && parent !== "" && !shown.has(parent)) earlierKids.set(parent, before);
    }
    const earlier = [];
    let earlierCount = 0;
    for (const group of ordered) {
      const heads = [...agentRecords.values()].filter((record) => !shown.has(record.id)
        && group.tops.includes(topOf.get(record.id)) && (parentOf.get(record.id) === "" || shown.has(parentOf.get(record.id))));
      if (!heads.length) continue;
      heads.sort(amOrder);
      const count = [...agentRecords.values()].filter((record) => !shown.has(record.id) && group.tops.includes(topOf.get(record.id))).length;
      earlierCount += count;
      const label = (group.block && amTurnLabel(group.block)) || AM_EARLIER_PROMPT;
      earlier.push({ id: group.id, label, heads, count });
    }
    return { nowKids, earlierKids, earlier, shown, working: agentCounts().active, thisTurn: thisTurn.size,
      earlierCount: earlierCount + agentTotalExtra };
  }
  let amGroupSerial = 0;
  function amSubtitle(plan) {
    const total = agentCounts().total;
    if (total <= 0) return "No agents in this chat yet";
    if (!plan) return `${agentPlural(total, "agent")} · click an agent for details`;
    return [[plan.working, "working"], [plan.thisTurn, "this turn"], [plan.earlierCount, "earlier"]]
      .filter(([count]) => count > 0).map(([count, word]) => `${count} ${word}`).join(" · ");
  }
  // The folded row: a real button in the tree's own list, the last of the main agent's, so Tab, the
  // arrows, Enter and Space reach it like any row. What it opens sits under it, groups of rows each
  // under a short muted label; closed, they are out of the document, so the arrows never land in them.
  let amEarlier = null;
  function amEarlierEntry() {
    if (amEarlier) return amEarlier;
    const item = el("li", "am-node am-earlier-node"), self = el("div", "am-self");
    const row = el("button", "am-row am-earlier");
    row.type = "button"; row.tabIndex = -1; row.dataset.amKey = "earlier";
    row.setAttribute("aria-expanded", "false");
    row.setAttribute("aria-controls", "agent-map-earlier");
    const chevron = el("span", "codicon codicon-chevron-right am-earlier-chevron"); chevron.setAttribute("aria-hidden", "true");
    const text = el("span", "am-text"), desc = el("span", "am-desc");
    text.appendChild(desc);
    row.append(chevron, text);
    row.addEventListener("click", () => {
      const before = row.getBoundingClientRect().top;
      amSetEarlierOpen(!amEarlierIsOpen());
      renderAgentMap();
      amHoldPlace(row, before);
    });
    self.appendChild(row);
    const groups = el("div", "am-earlier-groups");
    groups.id = "agent-map-earlier";
    groups.hidden = true;
    groups.setAttribute("role", "group");
    groups.setAttribute("aria-label", "Earlier in this chat");
    const more = el("p", "am-note am-earlier-more");
    item.append(self, groups);
    amEarlier = { item, row, desc, groups, more, entries: new Map() };
    return amEarlier;
  }
  // The dialog is centred, so Earlier opening grew it both ways and moved the row out from under the pointer: a
  // second click landed on an agent (real VS Code, 25 Oct). The row stays where it was clicked; the dialog grows
  // downward, as far as the panel has room, and moves up only as much as it must to fit. Until the map closes.
  function amHoldPlace(row, before) {
    const layer = $("agent-map"), box = $("agent-map-box");
    if (!row.isConnected || !layer || !box || !Number.isFinite(before)) return;
    const shift = before - row.getBoundingClientRect().top;
    if (Math.abs(shift) < 1) return;
    const style = getComputedStyle(layer);
    const padTop = parseFloat(style.paddingTop) || 0, padBottom = parseFloat(style.paddingBottom) || 0;
    const space = layer.clientHeight - padTop - padBottom;
    const want = box.getBoundingClientRect().top - layer.getBoundingClientRect().top - padTop + shift;
    const margin = Math.round(Math.max(0, Math.min(want, space - box.offsetHeight)));
    box.style.alignSelf = "start";
    box.style.marginTop = `${margin}px`;
    box.style.maxHeight = `${Math.max(0, Math.floor(space - margin))}px`;
  }
  function amReleasePlace() {
    const box = $("agent-map-box");
    if (box) { box.style.alignSelf = ""; box.style.marginTop = ""; box.style.maxHeight = ""; }
  }
  window.addEventListener("resize", amReleasePlace);
  // One prompt's agents in Earlier: its label, then its rows as the tree draws them.
  function amEarlierGroup(group) {
    let entry = amEarlier.entries.get(group.id);
    if (!entry) {
      const node = el("div", "am-group"), label = el("p", "am-group-label"), list = el("ul", "am-children am-group-list");
      label.id = `am-group-${++amGroupSerial}`;
      node.setAttribute("role", "group");
      node.setAttribute("aria-labelledby", label.id);
      node.append(label, list);
      entry = { node, label, list };
      amEarlier.entries.set(group.id, entry);
    }
    agentsSetText(entry.label, group.label);
    if (entry.label.title !== group.label) entry.label.title = group.label;
    return entry;
  }
  function paintAmMap() {
    const body = $("agent-map-body"), active = document.activeElement;
    const focusedKey = active && body.contains(active) ? active.dataset?.amKey || "" : "";
    for (const id of [...amRows.keys()]) if (!agentRecords.has(id)) amRows.delete(id);
    const children = amTree();
    const plan = amPlan(children);
    agentsSetText($("agent-map-subtitle"), amSubtitle(plan));
    const nowKids = plan ? plan.nowKids : children;
    const fold = plan && plan.earlierCount > 0 ? amEarlierEntry() : null;
    const open = !!fold && amEarlierIsOpen();
    // Deep enough for what is drawn: the folded row is one level down, and what it opens starts there.
    let depth = amDepth(nowKids);
    if (fold) depth = Math.max(depth, 1);
    if (open) for (const group of plan.earlier) for (const head of group.heads) depth = Math.max(depth, 1 + amDepth(plan.earlierKids, head.id));
    amLayout(depth);
    const root = amRootEntry();
    amPaintRoot(root);
    const fill = (records, list, kidsOf, tail = []) => {
      const items = [];
      for (const record of records) {
        const entry = amAgentEntry(record);
        amPaintAgentRow(entry, record);
        const kids = kidsOf.get(record.id);
        if (kids?.length) {
          if (!entry.kids) entry.kids = el("ul", "am-children");
          const label = `Started by ${agentDisplayName(record)}`;
          if (entry.kids.getAttribute("aria-label") !== label) entry.kids.setAttribute("aria-label", label);
          if (entry.kids.parentNode !== entry.item) entry.item.appendChild(entry.kids);
          fill(kids, entry.kids, kidsOf);
        } else if (entry.kids) {
          entry.kids.remove(); entry.kids = null;
        }
        items.push(entry.item);
      }
      agentsPlace(list, [...items, ...tail]);
    };
    fill(nowKids.get("") || [], root.kids, nowKids, fold ? [fold.item] : []);
    root.kids.hidden = !root.kids.childElementCount;
    const more = $("agent-map-more");
    const notListed = agentTotalExtra > 0
      ? `${agentPlural(agentTotalExtra, "more agent")} not listed${agentActiveExtra > 0 ? `, ${agentActiveExtra} of them working` : ""}.` : "";
    if (fold) {
      agentsSetText(fold.desc, `Earlier in this chat · ${agentPlural(plan.earlierCount, "agent")}`);
      if (fold.row.getAttribute("aria-expanded") !== String(open)) fold.row.setAttribute("aria-expanded", String(open));
      fold.groups.hidden = !open;
      const ids = new Set(plan.earlier.map((group) => group.id));
      for (const id of [...fold.entries.keys()]) if (!ids.has(id)) fold.entries.delete(id);
      const nodes = [];
      if (open) {
        plan.earlier.forEach((group) => {
          const entry = amEarlierGroup(group);
          fill(group.heads, entry.list, plan.earlierKids);
          nodes.push(entry.node);
        });
        // The cap on what a snapshot itemises applies in here: the ones it left out are the oldest.
        agentsSetText(fold.more, notListed);
        if (notListed) nodes.push(fold.more);
      }
      agentsPlace(fold.groups, nodes);
      more.hidden = true;
      agentsSetText(more, "");
    } else {
      more.hidden = !notListed;
      agentsSetText(more, notListed);
    }
    // Only what runs now: a task that ends drops out of the list (its card, if open, keeps it). A command a
    // restart stopped stays, with Run again, until it is run again.
    const tasks = amListedTasks();
    const stoppedByRestart = tasks.filter((task) => !task.running).length;
    const keys = new Set(tasks.map((task) => task.key));
    for (const key of [...amTaskRows.keys()]) if (!keys.has(key)) amTaskRows.delete(key);
    for (const key of [...taskStopping.keys()]) if (!keys.has(key)) taskStopping.delete(key);
    agentsPlace($("agent-map-task-list"), tasks.map((task) => {
      const entry = amTaskEntry(task);
      amPaintTaskRow(entry, task);
      return entry.item;
    }));
    $("agent-map-tasks").hidden = !tasks.length;
    const running = tasks.length - stoppedByRestart;
    agentsSetText($("agent-map-tasks-title"), [running ? agentPlural(running, "background task") : "",
      stoppedByRestart ? `${stoppedByRestart} stopped by a restart` : "", "click a task for details"].filter(Boolean).join(" · "));
    // One tab stop in the tree and one in the tasks; the arrow keys move within each.
    amRove($("agent-map-tree"), focusedKey);
    amRove($("agent-map-task-list"), focusedKey);
    // A row that moved (an agent that ended goes down its column) lost focus with the move: give it back.
    if (focusedKey && document.activeElement?.dataset?.amKey !== focusedKey) {
      focusQuietly(amRowByKey(focusedKey) || amFirstRow(), { preventScroll: true });
    }
  }
  // An agent's row, opening Earlier first when that is where the agent is (the agent's report's "Open
  // in agent map", a rail chip): the reader asked for that one.
  function amRevealRow(key) {
    let row = amRowByKey(key);
    if (row || !key.startsWith("agent:") || !amOpen) return row;
    const plan = amPlan(amTree());
    if (plan && !plan.shown.has(key.slice("agent:".length)) && agentRecords.has(key.slice("agent:".length)) && !amEarlierIsOpen()) {
      amSetEarlierOpen(true);
      renderAgentMap();
      row = amRowByKey(key);
    }
    return row;
  }
  function amRowByKey(key) {
    return [...$("agent-map-body").querySelectorAll(".am-row")].find((row) => row.dataset.amKey === key) || null;
  }
  function amFirstRow() {
    return $("agent-map-tree").querySelector(".am-agent") || $("agent-map-tree").querySelector(".am-row") || $("agent-map-close");
  }
  function amRove(list, focusedKey) {
    const rows = [...list.querySelectorAll(".am-row")];
    const keep = rows.find((row) => row.dataset.amKey === focusedKey) || rows.find((row) => row.tabIndex === 0) || rows[0];
    for (const row of rows) { const want = row === keep ? 0 : -1; if (row.tabIndex !== want) row.tabIndex = want; }
  }
  // Focus the map puts somewhere is quiet; a row the reader moves to with the arrows shows its label,
  // which is the whole name of a row that clips it.
  function amFocusRow(row, { quiet = true } = {}) {
    if (!row) return;
    const list = row.closest(".am-tree, .am-task-list");
    if (list) amRove(list, row.dataset.amKey);
    if (quiet) focusQuietly(row, { preventScroll: true }); else row.focus();
  }

  // ---- opening and closing ----
  // `from`: the control that opened it, which gets focus back; `command`: opened by /agents, so focus
  // goes back to the prompt box.
  function openAgentMap({ from = null, command = false } = {}) {
    const layer = $("agent-map");
    if (!layer || pipsOpen) return;
    hideModelMenu(); hideModeMenu(); hideContextMenu(); hideAddMenu(); hidePop(); hoverTip.hide();
    if (!amOpen) { amOpener = from; amByCommand = command; }
    amOpen = true;
    amDropLevels();
    amSyncLayers();
    $("agents-pill").setAttribute("aria-expanded", "true");
    amObserve();
    const measured = Math.round($("agent-map-tree").clientWidth || 0);
    if (measured > 0) amWidth = measured;
    if (backgroundTasksLive) vscode.postMessage({ type: "listBackgroundShells" });
    renderAgentMap();
    amFocusRow(amFirstRow());
  }
  function closeAgentMap({ restoreFocus = true } = {}) {
    if (!amOpen) return;
    amOpen = false;
    amReleasePlace();
    amDropLevels();
    clearTimeout(amTick); amTick = 0;
    hoverTip.hide();
    amSyncLayers();
    $("agents-pill").setAttribute("aria-expanded", "false");
    const opener = amOpener, byCommand = amByCommand;
    amOpener = null; amByCommand = false;
    if (!restoreFocus) return;
    focusQuietly(!byCommand && opener?.isConnected && !opener.closest("[hidden]") ? opener : input);
  }
  // The card and the transcript, gone at once (the map closing, or opening afresh).
  function amDropLevels() {
    amClearTranscript();
    amTx = null; amCard = null;
    amResetOutput();
  }
  // The layout follows the dialog's own width: a side bar dragged wider turns the tree on its side.
  function amObserve() {
    if (amObserver || typeof ResizeObserver !== "function") return;
    amObserver = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      const width = Math.round(Number(entry?.contentRect?.width ?? entry?.target?.clientWidth ?? 0));
      if (width > 0 && width !== amWidth) { amWidth = width; agentMapChanged(); }
    });
    amObserver.observe($("agent-map-tree"));
  }

  // ---- the card ----
  // A smaller window over the dimmed map. `card`: {kind: "root"} | {kind: "agent", id} | {kind: "task", key};
  // `from`: the row that opened it.
  function amOpenCard(card, from) {
    if (!amOpen) return;
    amClearTranscript();
    amTx = null;
    amCard = { ...card, from, nodes: null, last: null };
    amResetOutput();
    hoverTip.hide();
    amSyncLayers();
    renderAgentMap();
    $("agent-card-back").focus();
    if (amCard?.kind === "task") amPollOutput();
  }
  function amCloseCard() {
    if (!amCard) return;
    const from = amCard.from;
    amDropLevels();
    amSyncLayers();
    renderAgentMap();
    // The row that opened it; one a snapshot has since dropped hands the focus to the first row.
    amFocusRow(from?.isConnected && $("agent-map").contains(from) ? from : amFirstRow());
  }
  function amFold(host, title, open) {
    const fold = host.appendChild(el("details", "am-fold"));
    const summary = fold.appendChild(el("summary"));
    summary.textContent = title;
    fold.open = open;
    return { fold, summary };
  }
  function amButton(host, label, onClick, cls = "act") {
    const button = host.appendChild(el("button", cls));
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }
  function amFacts(dl, facts) {
    const sig = JSON.stringify(facts);
    if (dl._sig === sig) return;
    dl._sig = sig;
    dl.replaceChildren(...facts.flatMap(([term, value]) => {
      const dt = el("dt"), dd = el("dd");
      dt.textContent = term; dd.textContent = value;
      return [dt, dd];
    }));
    dl.hidden = !facts.length;
  }
  // A window's head: the dot, the title (whole in its hover label when it is clipped), the meta line.
  function amWindowHead(prefix, { title, state, meta, sub = null }) {
    const dot = $(`${prefix}-dot`);
    if (dot.dataset.state !== state) dot.dataset.state = state;
    const heading = $(`${prefix}-title`);
    agentsSetText(heading, title);
    if (heading.title !== title) heading.title = title;
    agentsSetText($(`${prefix}-meta`), meta);
    if (sub !== null) {
      agentsSetText($(`${prefix}-sub`), sub);
      $(`${prefix}-sub`).hidden = !sub;
    }
  }
  function paintAmCard() {
    const host = $("agent-card-body");
    $("agent-card-box").dataset.kind = amCard.kind;
    if (amCard.kind === "root") paintRootCard(host);
    else if (amCard.kind === "agent") paintAgentCard(host);
    else paintTaskCard(host);
    amKeepFocus();
  }
  // A control that leaves as the card updates (Stop, once the shell has stopped) takes focus with it, to the
  // page behind every layer, where no focusin fires and the window's own Esc never hears a key (real VS Code,
  // 2026-10-18: the stopped shell's card would not close). Focus goes back to the window on top.
  function amKeepFocus() {
    const top = amTopLayer(), active = document.activeElement;
    if (top && (!active || active === document.body || !active.isConnected)) focusQuietly($(`${top}-box`), { preventScroll: true });
  }
  function amFresh(host) {
    if (amCard.nodes) return null;
    host.replaceChildren();
    host.scrollTop = 0;
    amCard.nodes = {};
    return amCard.nodes;
  }
  function paintRootCard(host) {
    const fresh = amFresh(host), n = amCard.nodes;
    if (fresh) {
      n.summary = host.appendChild(el("p", "am-card-line"));
      n.states = host.appendChild(el("ul", "am-states"));
      n.tasks = host.appendChild(el("p", "am-card-line"));
      n.context = host.appendChild(el("p", "am-card-line am-quiet"));
    }
    const c = agentCounts();
    amWindowHead("agent-card", { title: amChatName(), state: streaming ? "running" : "idle",
      meta: [streaming ? "Working" : "Idle", ...amRootMeta()].join(" · ") });
    agentsSetText(n.summary, c.total ? `${agentPlural(c.total, "agent")} in this chat` : "No agents in this chat yet.");
    const lines = [[c.running, "working"], [c.waitingPermission, "waiting for your permission"], [c.waitingAnswer, "waiting for your answer"],
      [c.queued, "queued"], [c.finished, "finished"], [c.failed, "failed"], [c.stopped, "stopped"]]
      .filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
    const sig = lines.join("\n");
    if (n.states._sig !== sig) {
      n.states._sig = sig;
      n.states.replaceChildren(...lines.map((line) => { const li = el("li"); li.textContent = line; return li; }));
    }
    n.states.hidden = !lines.length;
    const running = amRunningTasks().length;
    agentsSetText(n.tasks, running ? `${agentPlural(running, "background task")} running` : "Nothing running in the background");
    const size = Math.max(0, Number(contextState.size || 0)), used = Math.max(0, Number(contextState.used || 0));
    agentsSetText(n.context, size ? `${fmtTokens(used)} of ${fmtTokens(size)} tokens in its context window` : "");
    n.context.hidden = !size;
  }

  // ---- an agent's card ----
  // The prompt it was given: the spawn's own `prompt` argument, kept on its card; a nested agent of a
  // parallel parent has its spawn in the parent's step log instead. A restored agent may have neither.
  function agentPromptOf(record) {
    const card = agentAnchor(record.id);
    if (card?._agentPrompt) return card._agentPrompt;
    const parent = record.parent_id ? agentRecords.get(String(record.parent_id)) : null;
    const step = (Array.isArray(parent?.log) ? parent.log : [])
      .find((ev) => ev?.type === "tool_call" && ev.call_id === record.call_id && typeof ev.args?.prompt === "string");
    return step ? String(step.args.prompt).slice(0, 20000) : "";
  }
  // The calls it made, from the same source its page draws: its own cards in the chat (a child's call
  // id carries its agent's id), else its step log.
  function amToolCalls(record) {
    const cards = [...log.querySelectorAll(".tool[data-call-id]")]
      .filter((card) => innermostAgentId(card.dataset.callId) === record.id);
    if (cards.length) {
      return cards.map((card) => ({ status: card.dataset.status || "",
        text: `${card.querySelector(".verb")?.textContent || ""} ${card.querySelector(".arg")?.textContent || ""}`.trim() }));
    }
    const calls = new Map();
    for (const ev of Array.isArray(record.log) ? record.log : []) {
      if (!ev || typeof ev !== "object") continue;
      const key = ev.call_id || ev.name;
      if (ev.type === "tool_call") {
        const copy = toolCopy(ev.name);
        calls.set(key, { status: "running", text: [copy.past, copy.target,
          String(ev.summary || stepSummary(ev.name, ev.args) || ev.args?.description || "")].filter(Boolean).join(" ") });
      } else if (ev.type === "tool_result" && calls.has(key)) {
        calls.get(key).status = ev.is_error ? "failed" : "completed";
      }
    }
    return [...calls.values()];
  }
  // Stop on a card: one agent, when the CLI can stop just that one; otherwise, for an agent working
  // inside the turn, the turn's own Stop, which ends every agent with it -- and the card says so.
  function amStopMode(record) {
    if (record.background) return agentControlLive ? "agent" : "";
    if (agentControlForeground) return "agent";
    return streaming ? "turn" : "";
  }
  function amStopAgent(id) {
    const record = agentRecords.get(id);
    if (!record || !AGENT_ACTIVE.has(record.state) || agentStopping.get(id) === "stopping") return;
    const mode = amStopMode(record);
    if (!mode) return;
    agentStopping.set(id, "stopping");
    if (mode === "turn") doStop();
    else vscode.postMessage({ type: "stopAgent", id });
    renderAgentMap();
  }
  // "Finished · general-purpose · qwen3.8:27b · background": the card's and the transcript's meta line.
  function amAgentMetaLine(record) {
    return [amStateWord(record), record.agent_type ? String(record.agent_type) : "", String(record.model || curModel || ""),
      record.background ? "background" : "foreground"].filter(Boolean).join(" · ");
  }
  function amAgentNumbers(record) {
    return [amDuration(amAgentMs(record)), Number(record.tokens || 0) > 0 ? `${amTokens(record.tokens)} tokens` : ""].filter(Boolean);
  }
  function amSpawnedBy(record) {
    const parent = record.parent_id ? agentRecords.get(String(record.parent_id)) : null;
    return parent ? `Spawned by ${agentDisplayName(parent)}` : "Spawned by the main agent";
  }
  function paintAgentCard(host) {
    const record = agentRecords.get(amCard.id) || amCard.last;
    if (!record) { amCloseCard(); return; }
    amCard.last = record;
    const id = record.id, working = AGENT_ACTIVE.has(record.state);
    const fresh = amFresh(host), n = amCard.nodes;
    if (fresh) {
      n.spawned = host.appendChild(el("p", "am-card-line am-spawned"));
      n.stats = host.appendChild(el("p", "am-card-line"));
      n.activity = host.appendChild(el("p", "am-card-line am-activity"));
      n.failure = host.appendChild(el("p", "am-card-line am-failure"));
      n.result = host.appendChild(el("div", "am-result"));
      // The prompt is open while the agent works and folded once it has ended; the calls are open.
      ({ fold: n.promptFold } = amFold(host, "Prompt", working));
      n.prompt = n.promptFold.appendChild(el("pre", "am-prompt"));
      ({ fold: n.callsFold, summary: n.callsTitle } = amFold(host, "Tool calls", true));
      n.calls = n.callsFold.appendChild(el("ul", "am-calls"));
      n.callsNote = n.callsFold.appendChild(el("p", "am-note"));
      const actions = host.appendChild(el("div", "am-actions"));
      n.stop = amButton(actions, "Stop agent", () => amStopAgent(id));
      n.stopNote = actions.appendChild(el("p", "am-note"));
      n.open = amButton(actions, "Open transcript", () => amOpenTranscript({ kind: "agent", id }, n.open), "act am-wide");
    }
    amWindowHead("agent-card", { title: agentDisplayName(record), state: record.state, meta: amAgentMetaLine(record) });
    const parent = record.parent_id ? agentRecords.get(String(record.parent_id)) : null;
    const spawnSig = parent ? `${parent.id}\n${agentDisplayName(parent)}` : "main";
    if (n.spawned._sig !== spawnSig) {
      n.spawned._sig = spawnSig;
      n.spawned.replaceChildren(document.createTextNode("Spawned by "));
      if (parent) {
        // The parent's card, in this one's place: Back still goes to the map, to the row first used.
        const link = amButton(n.spawned, agentDisplayName(parent), () => {
          amCard = { kind: "agent", id: parent.id, from: amCard.from, nodes: null, last: null };
          renderAgentMap();
          $("agent-card-back").focus();
        }, "am-link");
        link.title = `Open ${agentDisplayName(parent)}'s details`;
      } else n.spawned.appendChild(document.createTextNode("the main agent"));
    }
    const tools = Number(record.tool_calls || 0);
    const stats = amAgentNumbers(record);
    agentsSetText(n.stats, stats.join(" · "));
    n.stats.hidden = !stats.length;
    const activity = record.state === "waiting"
      ? (record.waiting_for === "answer" ? "Waiting for your answer. Answer it in the chat's question card."
        : "Waiting for your permission. Answer it in the chat's permission card.")
      : record.state === "queued" ? "Queued: it starts when a worker is free."
        : record.state === "running" ? (record.activity ? `Now: ${record.activity}` : "Working.") : "";
    agentsSetText(n.activity, activity);
    n.activity.hidden = !activity;
    const failure = record.state === "failed" || record.state === "stopped" ? String(record.message || "").trim().slice(0, 4000) : "";
    agentsSetText(n.failure, failure);
    n.failure.hidden = !failure;
    // What it reported, with what became of its changes, as its page shows them.
    const resultSig = record.state === "finished" ? `${record.message || ""}\n${agentAnchor(id)?.querySelector(".body pre")?.textContent.length || 0}` : "";
    if (n.result._sig !== resultSig) {
      n.result._sig = resultSig;
      n.result.replaceChildren();
      if (record.state === "finished") {
        const outcome = agentOutcomeNote(id);
        if (outcome) n.result.appendChild(outcome);
        const answer = agentAnswerText(record);
        if (answer) {
          const block = el("div", "text agent-answer");
          block.innerHTML = md(answer);
          n.result.appendChild(block);
        }
        paintAgentFiles(n.result, record);
      }
    }
    n.result.hidden = !n.result.childElementCount;
    const prompt = agentPromptOf(record);
    if (n.prompt._text !== prompt) {
      n.prompt._text = prompt;
      n.prompt.textContent = prompt || "This agent's prompt was not kept in the chat.";
      n.prompt.classList.toggle("am-quiet", !prompt);
    }
    const calls = amToolCalls(record);
    agentsSetText(n.callsTitle, `Tool calls (${Math.max(calls.length, tools)})`);
    const callSig = JSON.stringify(calls);
    if (n.calls._sig !== callSig) {
      n.calls._sig = callSig;
      n.calls.replaceChildren(...calls.slice(-200).map((call) => {
        const li = el("li", "am-call");
        const dot = li.appendChild(el("span", "agent-dot"));
        dot.setAttribute("aria-hidden", "true");
        dot.dataset.state = call.status === "running" ? "running" : call.status === "failed" ? "failed" : "finished";
        const text = li.appendChild(el("span", "am-call-text"));
        text.textContent = call.text || "Tool call";
        if (call.status === "running" || call.status === "failed") li.appendChild(el("span", "sr-only")).textContent = `, ${call.status}`;
        return li;
      }));
    }
    n.calls.hidden = !calls.length;
    agentsSetText(n.callsNote, calls.length ? "" : tools > 0 ? "Its steps were not kept in this chat. Its transcript has its report."
      : working ? "No tool calls yet." : "It made no tool calls.");
    n.callsNote.hidden = !n.callsNote.textContent;
    const mode = working ? amStopMode(record) : "";
    const stopping = agentStopping.get(id) === "stopping";
    n.stop.hidden = !mode;
    n.stop.disabled = stopping;
    agentsSetText(n.stop, stopping ? "Stopping…" : mode === "turn" ? "Stop the turn" : "Stop agent");
    agentsSetText(n.stopNote, agentStopping.get(id) === "failed" ? "The agent could not be stopped. It may have finished already."
      : mode === "turn" ? "Stop ends the whole turn, including every agent."
        : working && !mode && record.background ? "This DGC CLI cannot stop one agent. Update DGC to stop agents one at a time." : "");
    n.stopNote.hidden = !n.stopNote.textContent;
    n.stopNote.classList.toggle("am-failure", agentStopping.get(id) === "failed");
  }

  // ---- a task's card ----
  function amTaskFor(key) {
    const task = amAllTasks().find((t) => t.key === key);
    if (task) return task;
    // Gone from every list (a preview stopped, a troupe dismissed): the card keeps its last snapshot.
    const last = amCard?.kind === "task" && amCard.key === key ? amCard.last : null;
    return last ? { ...last, running: false, stoppable: false, word: last.running ? "Ended" : last.word } : null;
  }
  function amTaskFacts(task) {
    if (task.kind === "monitor") {
      const item = task.item;
      return [["Command", String(item.command || "")], ["Events", String(Math.max(0, Number(item.events) || 0))],
        ...(Number(item.pending_events) > 0 ? [["Waiting for DGC", eventCount(item.pending_events)]] : []),
        ["Ends", item.persistent ? "When it is stopped" : `After ${agentElapsed(Number(item.timeout_ms) || 0)}`], ["Id", task.id]]
        .filter(([, value]) => value);
    }
    if (task.kind === "shell") {
      const owner = task.item.agent_id ? agentRecords.get(String(task.item.agent_id)) : null;
      return [["Command", task.name], ["Started by", owner ? agentDisplayName(owner) : task.item.agent_id ? "A sub-agent" : "The main agent"],
        // A stopped shell's code is the signal's number (-15), which says nothing the header's "Stopped" doesn't.
        ...(Number.isInteger(task.item.exit_code) && task.item.state !== "killed" ? [["Exit code", String(task.item.exit_code)]] : []),
        ["Id", task.id]];
    }
    if (task.kind === "troupe") {
      const ev = task.ev, planned = Number(ev.agents_planned) || 0;
      return [["Agents", planned ? `About ${planned}` : ""], ["Results", String(ev.journal || "")]].filter(([, value]) => value);
    }
    if (task.kind === "pip") return [["Status", task.word], ["Details", String(task.run.detail || "")]].filter(([, value]) => value);
    return [["Address", String(task.preview.url || "")], ["Files", String(task.preview.rel || "")]].filter(([, value]) => value);
  }
  function amStopTask(task) {
    if (!task?.running || !task.stoppable || taskStopping.get(task.key) === "stopping") return;
    if (task.kind === "troupe") stopTroupe(task.id);
    else {
      taskStopping.set(task.key, "stopping");
      if (task.kind === "monitor") vscode.postMessage({ type: "stopMonitor", id: task.id });
      else if (task.kind === "shell") vscode.postMessage({ type: "stopBackgroundShell", id: task.id });
      else if (task.kind === "preview") vscode.postMessage({ type: "stopArtifact", id: task.id });
      else if (task.kind === "pip") {
        const key = task.key;
        Promise.resolve(pipSetupCards?.stopRun?.(task.id)).then((ok) => {
          if (ok !== true && taskStopping.get(key) === "stopping") taskStopping.set(key, "failed");
          renderAgentMap();
        }, () => { taskStopping.set(key, "failed"); renderAgentMap(); });
      }
    }
    renderAgentMap();
  }
  function amOpenTask(task) {
    if (task.kind === "preview" && task.preview.url) vscode.postMessage({ type: "openExternal", url: task.preview.url });
    if (task.kind === "pip") {
      closeAgentMap({ restoreFocus: false });
      pipSetupCards?.openRun?.(task.id);
    }
  }
  function amTaskHead(task) {
    return { title: task.name, state: amTaskState(task), meta: [task.word, task.label, amDuration(task.ms)].filter(Boolean).join(" · ") };
  }
  // An output box: pinned to the end unless the reader scrolls up to read; back at the end, it follows again.
  function amOutputBox(host, n, task, cls = "am-output") {
    n.output = host.appendChild(el("pre", cls));
    n.output.tabIndex = 0;
    n.output.setAttribute("aria-label", `Output of ${task.name}`);
    n.pinned = true;
    n.output.addEventListener("scroll", () => {
      n.pinned = n.output.scrollHeight - n.output.scrollTop - n.output.clientHeight < 8;
    }, { passive: true });
    n.outputNote = host.appendChild(el("p", "am-note"));
  }
  function paintTaskCard(host) {
    const task = amTaskFor(amCard.key);
    if (!task) { amCloseCard(); return; }
    amCard.last = task;
    const fresh = amFresh(host), n = amCard.nodes;
    if (fresh) {
      n.facts = host.appendChild(el("dl", "am-facts"));
      if (task.kind === "troupe") n.stages = host.appendChild(el("ol", "troupe-stages am-stages"));
      if (task.output) {
        const { fold } = amFold(host, "Output", true);
        amOutputBox(fold, n, task);
      }
      const actions = host.appendChild(el("div", "am-actions"));
      if (task.kind === "preview") n.open = amButton(actions, "Open in browser", () => amOpenTask(amTaskFor(amCard.key)));
      if (task.kind === "pip") n.open = amButton(actions, "Open in Pips", () => amOpenTask(amTaskFor(amCard.key)));
      n.stop = amButton(actions, "Stop", () => amStopTask(amTaskFor(amCard.key)));
      if (task.rerun) n.rerun = amButton(actions, "Run again", () => {
        n.rerun.disabled = true;
        vscode.postMessage({ type: "rerunTask", key: task.rerun, how: "again" });
      });
      n.stopNote = actions.appendChild(el("p", "am-note am-failure"));
      // Its output in a large window, as an agent's card opens its transcript.
      if (task.output) n.full = amButton(actions, "Open output", () => amOpenTranscript({ kind: "output", key: task.key }, n.full), "act am-wide");
    }
    if (!task.running) taskStopping.delete(task.key);
    amWindowHead("agent-card", amTaskHead(task));
    amFacts(n.facts, amTaskFacts(task));
    if (n.stages) {
      const html = troupeStageRows(task.ev);
      if (n.stages._html !== html) { n.stages._html = html; n.stages.innerHTML = html; }
    }
    if (n.output) amPaintOutput(n, task);
    if (n.stop) {
      const stopping = taskStopping.get(task.key) === "stopping" || task.stopping || task.word === "Stopping";
      n.stop.hidden = !task.running;
      n.stop.disabled = stopping || !task.stoppable;
      agentsSetText(n.stop, stopping ? "Stopping…" : "Stop");
    }
    agentsSetText(n.stopNote, taskStopping.get(task.key) === "failed" ? "It could not be stopped. It may have finished already." : "");
    n.stopNote.hidden = !n.stopNote.textContent;
    if (n.open) n.open.disabled = task.kind === "preview" ? !task.running : false;
    amLastLook(task);
  }
  // The last look at a task's output once it has ended.
  function amLastLook(task) {
    if (amOutput?.key === task.key && !task.running && !amOutput.final && !amOutput.inflight) amPollOutput();
  }
  function amPaintOutput(n, task) {
    let text = "", note = "";
    if (backgroundTasksLive) {
      const o = amOutput?.key === task.key ? amOutput : null;
      text = o?.text || "";
      if (o?.truncated && text) note = `Showing the last ${amBytes(new TextEncoder().encode(text).length)} of ${amBytes(o.total)} of output.`;
      else if (!text) note = o?.state === "failed" ? "Output is not available." : task.running ? "No output yet." : "No output.";
    } else if (task.kind === "monitor") {
      // A CLI that cannot send the output: the lines the monitor's events brought to the chat.
      text = (monitorLines.get(task.id) || []).join("\n");
      note = text ? "The lines this monitor reported to the chat." : task.running ? "No output yet." : "No output.";
    } else note = "Output is not available.";
    const pre = n.output;
    pre.hidden = !text;                          // shown first: a hidden box has nothing to scroll
    if (pre._text !== text) {
      pre._text = text;
      pre.textContent = text;
      if (n.pinned) pre.scrollTop = pre.scrollHeight;
    }
    agentsSetText(n.outputNote, note);
    n.outputNote.hidden = !note;
  }

  // ---- the transcript ----
  // A large window over the card: the agent's whole conversation, drawn by the builder its page uses
  // (buildAgentWork), in the order it happened, and live while it works. A nested agent's name in it
  // opens that agent's transcript in its place, and Back steps out one at a time. For a task, its output.
  function amOpenTranscript(tx, from) {
    if (!amCard) return;
    amClearTranscript();
    amTx = { ...tx, from, stack: [], built: false, sig: "", lines: [], images: [], last: null, nodes: null };
    hoverTip.hide();
    amSyncLayers();
    renderAgentMap();
    $("agent-transcript-back").focus();
    if (tx.kind === "output") amPollOutput();
  }
  function amClearTranscript() {
    if (!amTx) return;
    for (const line of amTx.lines) clearTimeout(line.timer);
    clearImageRecords(amTx.images);
    amTx.lines = []; amTx.images = [];
    $("agent-transcript-log").replaceChildren();
  }
  function amCloseTranscript() {
    if (!amTx) return;
    if (amTx.stack.length) {
      const left = amTx.id;
      amClearTranscript();
      Object.assign(amTx, { id: amTx.stack.pop(), built: false, sig: "", last: null });
      renderAgentMap();
      const name = $("agent-transcript-log").querySelector(`.agent-name[data-agent-id="${cssEscape(left)}"]`);
      focusQuietly(name || $("agent-transcript-back"), { preventScroll: true });
      return;
    }
    const from = amTx.from;
    amClearTranscript();
    amTx = null;
    amSyncLayers();
    renderAgentMap();
    focusQuietly(from?.isConnected && $("agent-card").contains(from) ? from : $("agent-card-back"), { preventScroll: true });
  }
  function amNestedTranscript(id, opener) {
    if (!amTx || !agentRecords.has(id) || amTx.id === id) return;
    amTx.stack.push(amTx.id);
    amClearTranscript();
    Object.assign(amTx, { id, built: false, sig: "", last: null });
    renderAgentMap();
    $("agent-transcript-back").focus();
    void opener;
  }
  // What the transcript draws, in brief: when it changes the transcript is drawn again. The chat's own
  // cards for this agent change in place (a call finishing, output arriving), so their states and sizes
  // are part of it, and so are its nested agents' states, which its lines say.
  function amTranscriptSig(record) {
    const id = record.id;
    const nodes = [...log.querySelectorAll(".agent-owned")]
      .filter((node) => (node.dataset.agentId || node.dataset.agent) === id || innermostAgentId(node.dataset.callId) === id);
    const kids = [...agentRecords.values()].filter((r) => r.parent_id === id);
    return JSON.stringify([record.state, String(record.message || "").length, Array.isArray(record.log) ? record.log.length : 0,
      nodes.map((node) => `${node.dataset.status || ""}:${node.textContent.length}`).join(","),
      kids.map((r) => `${r.id}:${r.state}:${agentDisplayName(r)}`).join(","),
      agentAnchor(id)?.querySelector(".body pre")?.textContent.length || 0, agentPromptOf(record).length]);
  }
  function paintAmTranscript() {
    const box = $("agent-transcript-box"), body = $("agent-transcript-body");
    box.dataset.kind = amTx.kind;
    // Back says where it goes: out of a nested agent's transcript to its parent's, else to the card.
    const back = $("agent-transcript-back");
    const label = amTx.stack.length ? "Back to the parent agent's transcript" : amTx.kind === "output" ? "Back to the task" : "Back to the agent";
    hoverTip.retitle(back, label);
    if (back.getAttribute("aria-label") !== label) back.setAttribute("aria-label", label);
    if (amTx.kind === "output") return paintOutputWindow(body);
    const record = agentRecords.get(amTx.id) || amTx.last;
    if (!record) { amCloseTranscript(); return; }
    amTx.last = record;
    amWindowHead("agent-transcript", { title: agentDisplayName(record), state: record.state, meta: amAgentMetaLine(record),
      sub: [amSpawnedBy(record), ...amAgentNumbers(record)].join(" · ") });
    const sig = amTranscriptSig(record);
    if (amTx.built && sig === amTx.sig) return;
    const into = $("agent-transcript-log");
    // Drawn again: the reader keeps their place (or the end, when they were at it), the cards they
    // opened stay open, and a nested agent's name that had focus gets it back.
    const keepBottom = !amTx.built || body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    const keep = body.scrollTop;
    const opened = new Set([...into.querySelectorAll(".tool.open")].map((card) => card.dataset.callId));
    const active = document.activeElement;
    const focusedName = active && into.contains(active) ? active.closest(".agent-name")?.dataset.agentId || "" : "";
    for (const line of amTx.lines) clearTimeout(line.timer);
    clearImageRecords(amTx.images);
    amTx.lines = []; amTx.images = [];
    buildAgentWork(record.id, into, { lines: amTx.lines, images: amTx.images, conversation: true,
      open: (id, opener) => amNestedTranscript(id, opener) });
    for (const card of into.querySelectorAll(".tool")) {
      if (opened.has(card.dataset.callId) && !card.classList.contains("open")) card.querySelector(".tool-toggle")?.click();
    }
    amTx.built = true;
    amTx.sig = sig;
    body.scrollTop = keepBottom ? body.scrollHeight : keep;
    if (focusedName) focusQuietly(into.querySelector(`.agent-name[data-agent-id="${cssEscape(focusedName)}"]`), { preventScroll: true });
  }
  function paintOutputWindow(body) {
    const task = amTaskFor(amTx.key);
    if (!task) { amCloseTranscript(); return; }
    amWindowHead("agent-transcript", { ...amTaskHead(task), sub: task.kind === "shell" || task.kind === "monitor" ? String(task.item.command || "") : "" });
    const into = $("agent-transcript-log");
    if (!amTx.nodes) {
      into.replaceChildren();
      amTx.nodes = {};
      amOutputBox(into, amTx.nodes, task, "am-output am-output-full");
    }
    amPaintOutput(amTx.nodes, task);
    void body;
    amLastLook(task);
  }

  // ---- live output ----
  function amResetOutput() {
    if (amOutput) clearTimeout(amOutput.timer);
    amOutput = null;
  }
  // The task whose output is on screen: the output window's, else the open task card's.
  function amOutputKey() {
    if (amTx?.kind === "output") return amTx.key;
    return amCard?.kind === "task" ? amCard.key : "";
  }
  function amPollOutput() {
    const key = amOutputKey();
    if (!amOpen || !key || !backgroundTasksLive) return;
    const task = amTaskFor(key);
    if (!task?.output) return;
    if (!amOutput || amOutput.key !== task.key) {
      amOutput = { key: task.key, id: task.id, text: "", total: 0, truncated: false, state: "loading",
        inflight: false, sentAt: 0, timer: 0, final: false };
    }
    clearTimeout(amOutput.timer); amOutput.timer = 0;
    if (document.hidden) return;                 // the panel coming back into view picks it up again
    const now = agentNow();
    if (amOutput.inflight && now - amOutput.sentAt > 6000) amOutput.inflight = false;   // an answer that never came
    if (!amOutput.inflight && (task.running || !amOutput.final)) {
      amOutput.inflight = true;
      amOutput.sentAt = now;
      if (!task.running) amOutput.final = true;
      vscode.postMessage({ type: "getBackgroundOutput", id: task.id });
    }
    if (task.running) amOutput.timer = setTimeout(amPollOutput, 1000);
  }
  function amOutputAnswer(ev) {
    if (!amOutput || String(ev.id || "") !== amOutput.id) return;
    amOutput.inflight = false;
    amOutput.text = String(ev.output || "");
    amOutput.total = Math.max(0, Number(ev.total_bytes) || 0);
    amOutput.truncated = ev.truncated === true;
    amOutput.state = "ready";
    agentMapChanged();
  }
  function amOutputFailed(id) {
    if (!amOutput || String(id || "") !== amOutput.id) return;
    amOutput.inflight = false;
    amOutput.state = "failed";
    agentMapChanged();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !amOpen) return;
    renderAgentMap();
    amPollOutput();
  });

  // ---- the task sources ----
  // Each snapshot that can start or end a task repaints the pill as well as the map (renderAgents);
  // one that only adds output (a monitor's lines) repaints the map alone.
  function amShells(ev) {
    if (!backgroundTasksLive) return;
    shellItems = (Array.isArray(ev.items) ? ev.items : [])
      .filter((item) => item && typeof item === "object" && typeof item.id === "string" && item.id).slice(0, 64);
    renderAgents();
  }
  function amNoteMonitorLines(ev) {
    const id = String(ev.id || "");
    if (!id || ev.kind === "background_exit") return;
    const lines = monitorLines.get(id) || [];
    lines.push(...(Array.isArray(ev.lines) ? ev.lines : []).map(String));
    monitorLines.set(id, lines.slice(-200));
    agentMapChanged();
  }
  function amPreviewReady(ev) {
    const id = String(ev.id || "");
    if (!id) return;
    previews.set(id, { id, name: String(ev.name || id), url: String(ev.url || ""), rel: String(ev.rel || ""),
      readyWall: Date.now(), state: "running" });
    renderAgents();
  }
  // The answer to /artifacts or to a Stop: the previews running now. One this chat knew that is not
  // listed has stopped.
  function amPreviewList(ev) {
    const listed = new Set();
    for (const item of Array.isArray(ev.items) ? ev.items : []) {
      const id = String(item?.id || "");
      if (!id) continue;
      listed.add(id);
      const known = previews.get(id);
      previews.set(id, { ...known, id, name: String(item.name || id), url: String(item.url || ""), rel: String(item.rel || ""),
        uptime: String(item.uptime || ""), state: "running" });
    }
    for (const [id, preview] of previews) if (!listed.has(id)) preview.state = "stopped";
    renderAgents();
  }
  function amPreviewStopState(msg) {
    const id = String(msg.id || ""), preview = previews.get(id);
    if (!preview) return;
    if (msg.state === "stopped") preview.state = "stopped";
    else if (msg.state === "error") taskStopping.set(`preview:${id}`, "failed");
    renderAgents();
  }
  function amTasksReset() {
    shellItems = []; monitorLines.clear(); previews.clear(); taskStopping.clear(); taskEndedWall.clear();
    amTaskRows.clear();
  }

  $("agents-pill").addEventListener("click", (event) => {
    event.stopPropagation();
    openAgentMap({ from: $("agents-pill") });
  });
  $("agent-map-close").addEventListener("click", () => closeAgentMap());
  $("agent-card-back").addEventListener("click", () => amCloseCard());
  $("agent-transcript-back").addEventListener("click", () => amCloseTranscript());
  $("agent-map-settings").addEventListener("click", () => {
    closeAgentMap({ restoreFocus: false });
    vscode.postMessage({ type: "slash", action: "subagent" });
  });
  for (const id of AM_LAYERS) {
    const layer = $(id);
    // A click on the dimmed space around the window on top goes back one level; one inside it does not.
    layer.addEventListener("click", (event) => { if (event.target === layer && amTopLayer() === id) amGoBack(); });
    layer.addEventListener("keydown", (event) => amLayerKey(event, id));
  }
  // Keys that reach the page with no layer focused (a focused control removed as it updated) still belong to
  // the window on top: Esc goes back a level from there too.
  document.addEventListener("keydown", (event) => {
    const top = amTopLayer();
    if (!top || event.defaultPrevented || AM_LAYERS.some((id) => $(id).contains(event.target))) return;
    amLayerKey(event, top);
  });
  // Focus stays in the window on top: anything that moves it elsewhere (a click on the page behind, a
  // control focusing itself as it updates) hands it back.
  document.addEventListener("focusin", (event) => {
    const top = amTopLayer();
    if (!top || $(top).contains(event.target)) return;
    focusQuietly($(`${top}-box`), { preventScroll: true });
  });
  function amLayerKey(event, id) {
    if (event.key === "Escape") {
      // Esc in the composer is Stop: this one must never reach it. It goes back one level.
      event.preventDefault(); event.stopPropagation();
      amGoBack();
      return;
    }
    if (event.key === "Tab") {
      const nodes = [...$(`${amTopLayer()}-box`).querySelectorAll("button, summary, a[href], [tabindex]")]
        .filter((node) => node.tabIndex >= 0 && !node.disabled && !node.closest("[hidden]"));
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1], at = nodes.indexOf(document.activeElement);
      if (at < 0) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && at === 0) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && at === nodes.length - 1) { event.preventDefault(); first.focus(); }
      return;
    }
    if (id !== "agent-map") return;
    const row = event.target.closest?.(".am-row");
    const list = row?.closest(".am-tree, .am-task-list");
    if (!list) return;
    const rows = [...list.querySelectorAll(".am-row")], at = rows.indexOf(row);
    const next = event.key === "ArrowDown" ? rows[Math.min(rows.length - 1, at + 1)]
      : event.key === "ArrowUp" ? rows[Math.max(0, at - 1)]
        : event.key === "Home" ? rows[0] : event.key === "End" ? rows[rows.length - 1] : null;
    if (!next) return;
    event.preventDefault();
    amFocusRow(next, { quiet: false });
  }

  // ---- announcements (debounced so a batch speaks once) ----
  function agentAnnounce() {
    if (replaying) return;
    clearTimeout(agentsAnnounceTimer);
    agentsAnnounceTimer = setTimeout(() => {
      agentsAnnounceTimer = null;
      const c = agentCounts();
      if (c.active > 0 && !agentsSpokenActive) {
        agentsSpokenActive = true;
        speak(`${agentPlural(c.active, "agent")} working`);
      } else if (c.active === 0 && agentsSpokenActive) {
        agentsSpokenActive = false;
        const ended = { finished: 0, failed: 0, stopped: 0 };
        for (const id of agentsBatch) {
          const record = agentRecords.get(id);
          if (record && record.state in ended) ended[record.state] += 1;
        }
        agentsBatch.clear();
        const parts = Object.entries(ended).filter(([, count]) => count > 0).map(([state, count]) => `${count} ${state}`);
        speak(`Agents finished${parts.length ? `: ${parts.join(", ")}` : ""}`);
      }
      if (c.active === 0) agentsBatch.clear();
    }, 750);
  }

  // ---- chat boundaries and backend exits ----
  function agentsSessionReset(kind) {
    // The map belongs to the chat on screen: any reset closes it, and the prompt box takes the focus.
    const mapWasOpen = agentMapOpen();
    closeAgentMap({ restoreFocus: false });
    agentStopping.clear();
    closeAgentPage({ all: true });
    // Every kind empties the transcript (a rewind and a chat switch too), and with it every line.
    for (const line of agentLines) clearTimeout(line.timer);
    for (const line of agentPageLines) clearTimeout(line.timer);
    agentLines.clear(); agentLinesExpanded.clear();
    agentPageLines = []; agentPageStack = []; agentPageReturnFocus = null;
    if (kind === "rewound") {
      // Records are kept until the snapshot that follows the history, but their anchors are not:
      // the history rebuilds every card, and claiming those cards now would pair them with records
      // the snapshot is about to prune. The backend sends that snapshot whenever the chat had agents.
      agentAnchors.clear();
      for (const card of document.querySelectorAll(".tool[data-agent-id]")) delete card.dataset.agentId;
      agentsHoldClaims = agentRecords.size > 0 || agentTotalExtra > 0;
      renderAgentsPill();               // the Pip runs' lines went with the transcript, and off the count
      if (mapWasOpen) input.focus();
      return;
    }
    agentsHoldClaims = false;
    agentRecords.clear(); agentAnchors.clear(); agentsBatch.clear(); amRows.clear();
    amRoot?.kids.replaceChildren();
    // What ran in the background of the chat that was left is not this chat's.
    amTasksReset();
    agentTotalExtra = 0; agentActiveExtra = 0;
    clearTimeout(agentsAnnounceTimer); agentsAnnounceTimer = null; agentsSpokenActive = false;
    renderAgentsPill();
    if (mapWasOpen) input.focus();
  }
  function agentsBackendExit() {
    // One moment for all of them: they stopped together, so the map keeps them in the order they started. Read per
    // agent, a millisecond between two of them put the later one first on a busy machine.
    const endedAt = agentNow(), endedWall = Date.now();
    for (const record of agentRecords.values()) {
      if (!AGENT_ACTIVE.has(record.state)) continue;
      record.state = "stopped";
      record.endedAt = endedAt;
      record.message = "DGC's backend stopped";
      record.endedWall = endedWall;
      delete record.waiting_for; delete record.activity; delete record.duration_ms;
    }
    agentActiveExtra = 0;
    clearTimeout(agentsAnnounceTimer); agentsAnnounceTimer = null; agentsSpokenActive = false; agentsBatch.clear();
    // The map closes; nothing it could stop is running any more. The background commands went with
    // the process that ran them.
    closeAgentMap();
    agentStopping.clear();
    const gone = Date.now() / 1000;
    shellItems = shellItems.map((item) => (item.state === "running" ? { ...item, state: "killed", ended_at: gone } : item));
    // Their lines say "stopped", with why on each name, until the new backend's snapshot says more.
    repaintAgentLines();
    if (agentPageId) paintAgentPage(agentPageId);
    renderAgents();
  }

  // Installed-host tests (extension-host/index.cjs) ask what the pill shows: its state and its words
  // ("1 agent · 2 tasks", as a footer with room shows them). Only the host's test bridge sends
  // `agentsProbe` (while its token is set), with a fresh nonce it checks on the reply; anything else
  // is ignored.
  globalThis.addEventListener("message", (event) => {
    const probe = event.data?.type === "agentsProbe" ? event.data.probe : "";
    if (typeof probe !== "string" || !/^[0-9a-f]{32}$/.test(probe)) return;
    const pill = $("agents-pill");
    vscode.postMessage({ type: "agentsProbeResult", probe, hidden: $("agents-picker").hidden, state: pill.dataset.state,
      label: pill.querySelector(".agents-text").textContent });
  });

  // The four seams above stay the foundation's no-op stubs (lane-hooks.test.mjs instruments them in
  // place); the agents indicator chains its handlers onto three. `hideAgentsMenu` closed the agents
  // dropdown, which the agent map replaced: the map is modal, so no other menu can open over it.
  function agentsChain(stub, handler) { return function (...args) { stub(...args); return handler(...args); }; }
  agentsOnSessionReset = agentsChain(agentsOnSessionReset, agentsSessionReset);
  agentsOnBackendExit = agentsChain(agentsOnBackendExit, agentsBackendExit);
  agentsOnToolCard = agentsChain(agentsOnToolCard, agentsToolCard);
  $("agent-back")?.addEventListener("click", () => closeAgentPage());
  document.addEventListener("keydown", (event) => {
    if (pipsOpen || event.key !== "Escape" || !agentPageId) return;
    if (agentMapOpen()) return;             // the map over the page takes its own Escape
    event.preventDefault();
    event.stopPropagation();
    closeAgentPage();
  }, true);
  // ---- end 0.40 agents ----------------------------------------------------------------------------


  // ---- 0.40 images --------------------------------------------------------------------------------
  // Model-viewed images live inside the tool card that produced them: a count pill on the head, a
  // chip row as the first thing in the card's body once it is opened, and one click opens a viewer
  // over the panel. A card keeps its images as records (`card._images`); chips render from those, so
  // a collapsed card never decodes pixels. Inline data URIs are pinned on their record; bytes fetched
  // by ref (history, or an image too large for a live frame) sit in a bounded cache and come back
  // through getImage when they are needed again.
  const IMAGE_REF = /^img_[0-9a-f]{32}$/;
  const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);
  const IMAGE_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
  const IMAGE_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  const IMAGE_SOURCES = { browser: "Browser screenshot", view_image: "Workspace image", read_file: "Workspace image", mcp: "MCP image" };
  const IMAGE_FAILURES = {
    // triangle-alert where the file itself is gone or broken; image-off where the image is fine
    // and DGC declined to draw it.
    not_found: ["triangle-alert", "Unavailable", "DGC no longer has this image."],
    changed: ["triangle-alert", "Unavailable", "The stored copy changed after the model viewed it."],
    too_large: ["image-off", "Too large", "Too large to show in the panel. Open the file instead."],
    frame: ["image-off", "Too large", "This screenshot was too large to send to the panel. It is saved in .dgc/screenshots."],
    unreadable: ["triangle-alert", "Unavailable", "The panel could not load this image."],
  };
  const IMAGE_CACHE_CHARS = 48_000_000;
  const IMAGE_RETRY_MS = [500, 1000, 2000];
  const imageCache = new Map();          // ref -> data URI (least recently used first)
  let imageCacheChars = 0;
  const imageRefs = new Map();           // ref -> Set of records waiting on or showing those bytes
  const imageQueue = [];                 // records to fetch, in order
  const imageInFlight = new Map();       // request id -> { record, timer }
  let imageRequestSeq = 0, imageGeneration = 0, imageViewsSupported = false;
  let imageViewer = null;

  const countOf = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  function imageSize(bytes) {
    const n = Number(bytes) || 0;
    if (!n) return "";
    return n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;
  }
  function imageDims(record) { return record.width && record.height ? `${record.width}×${record.height}` : ""; }
  function validImageItem(item) {
    if (!item || typeof item !== "object") return null;
    const { ref, name, mime, width, height, bytes, source, host } = item;
    const int = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
    if (typeof ref !== "string" || !IMAGE_REF.test(ref) || !IMAGE_MIMES.has(mime)) return null;
    if (typeof name !== "string" || !name || name.length > 128 || IMAGE_CONTROL.test(name) || name.includes("://")) return null;
    if (!int(width, 1000000) || !int(height, 1000000) || !int(bytes, 8388608)) return null;
    if (!Object.prototype.hasOwnProperty.call(IMAGE_SOURCES, source)) return null;
    if (typeof host !== "string" || (host && (source !== "browser" || !IMAGE_HOST.test(host)))) return null;
    return { ref, name, mime, width, height, bytes, source, host };
  }
  function imageRecordsFor(ev) {
    const images = Array.isArray(ev.images) ? ev.images : [];
    const items = Array.isArray(ev.items) && ev.items.length === images.length ? ev.items : null;
    const caption = String(ev.caption || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const fallbackName = caption && !caption.includes("://") && !IMAGE_CONTROL.test(caption) ? caption : "Screenshot";
    // An empty `images` on a step (no items, nothing omitted) is a frame the backend had to shrink.
    if (!images.length && !items && !(Number(ev.omitted) > 0)) {
      return [{ src: "", ref: "", name: fallbackName, mime: "", width: 0, height: 0, bytes: 0,
                source: "browser", host: "", state: "failed", reason: "frame" }];
    }
    const out = [];
    images.forEach((src, index) => {
      const item = items ? validImageItem(items[index]) : null;
      if (items && !item) return;                                   // an invalid item takes its slot
      if (typeof src !== "string") return;
      if (src && !IMAGE_DATA.test(src)) return;                     // never inject an unvetted URI
      if (!src && !item) return;
      const record = item ? { ...item } : { ref: "", name: fallbackName, mime: "", width: 0, height: 0,
                                              bytes: 0, source: "browser", host: "" };
      record.src = src; record.pinned = !!src; record.state = src ? "ready" : "pending"; record.reason = "";
      if (!src && imageCache.has(record.ref)) { record.src = imageCacheGet(record.ref); record.state = "ready"; }
      if (record.ref) trackImageRef(record);
      out.push(record);
    });
    return out;
  }
  function trackImageRef(record) {
    if (!imageRefs.has(record.ref)) imageRefs.set(record.ref, new Set());
    imageRefs.get(record.ref).add(record);
  }
  function imageCacheGet(ref) {
    const value = imageCache.get(ref);
    if (value !== undefined) { imageCache.delete(ref); imageCache.set(ref, value); }
    return value;
  }
  function imageCachePut(ref, uri) {
    if (imageCache.has(ref)) { imageCacheChars -= imageCache.get(ref).length; imageCache.delete(ref); }
    imageCache.set(ref, uri); imageCacheChars += uri.length;
    for (const [oldRef, oldUri] of imageCache) {
      if (imageCacheChars <= IMAGE_CACHE_CHARS || oldRef === ref) break;
      imageCache.delete(oldRef); imageCacheChars -= oldUri.length;
      for (const record of imageRefs.get(oldRef) || []) {
        if (record.pinned || record.state !== "ready" || record === imageViewer?.records[imageViewer.index]) continue;
        record.src = ""; record.state = "pending"; refreshImageChip(record);
      }
    }
  }

  function imageOwnerFor(ev) {
    const card = ev.call_id != null && turn._tools ? turn._tools[ev.call_id] : null;
    if (card) return card;
    // A step with no card here (text protocol history, a compacted call, an editor-initiated MCP call)
    // is its own row at this point in the turn. Consecutive ones share the row.
    const last = turn.act?.previousElementSibling;
    if (last && last.classList.contains("image-orphan")) return last;
    const row = el("div", "tool image-orphan");
    const bodyId = `tool-output-${++disclosureId}`;
    row.innerHTML = `<div class="head"><button type="button" class="tool-toggle" aria-expanded="false" aria-controls="${bodyId}"><span class="chev" aria-hidden="true">›</span><span class="glyph" aria-hidden="true">${icon("image")}</span><span class="verb">Viewed an image</span></button></div><div class="body" id="${bodyId}"></div>`;
    const toggle = row.querySelector(".tool-toggle");
    toggle.onclick = () => {
      const open = row.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
      if (open) imagesOnCardOpen(row);
    };
    endToolGroup(); breakText(); appendTurnContent(row);
    return row;
  }
  function imagesOnToolImages(ev) {
    ensureTurn();
    const records = imageRecordsFor(ev);
    const omitted = Number.isSafeInteger(ev.omitted) && ev.omitted > 0 ? Math.min(ev.omitted, 10000) : 0;
    if (!records.length && !omitted) return;
    const stick = atBottom();
    const owner = imageOwnerFor(ev);
    owner._images = [...(owner._images || []), ...records];
    owner._imagesOmitted = (owner._imagesOmitted || 0) + omitted;
    records.forEach((record) => { record.owner = owner; });
    const count = owner._images.length;
    if (owner.classList.contains("image-orphan")) {
      owner.querySelector(".verb").textContent = count === 1 ? "Viewed an image" : `Viewed ${count} images`;
    } else {
      owner.classList.remove("no-body");         // a card with images keeps its body reachable
      owner.classList.add("has-images");
      updateImagePill(owner);
      refreshToolGroup(owner.closest(".tool-group"));
    }
    if (owner.classList.contains("open")) renderImageRow(owner);
    if (records.length) speak(records.length === 1 ? "Viewed 1 image" : `Viewed ${records.length} images`);
    if (imageViewer) refreshViewerSequence();
    if (owner.classList.contains("image-orphan")) { if (stick || following) scroll(); else noteNewContent(); }
  }
  function updateImagePill(card) {
    const count = (card._images || []).length;
    const toggle = card.querySelector(".tool-toggle");
    if (!toggle) return;
    // Every image refused (bad data, over the cap): the pill says how many were not shown, never "0".
    const omitted = count ? 0 : card._imagesOmitted || 0;
    const words = omitted ? `${countOf(omitted, "image")} not shown` : countOf(count, "image");
    let pill = toggle.querySelector(".tool-image-count");
    if (!pill) {
      pill = el("span", "tool-image-count", icon("image", "xs")
        + '<span class="n" aria-hidden="true"></span><span class="sr-only"></span>');
      const arg = toggle.querySelector(".arg");
      if (arg) arg.after(pill); else toggle.appendChild(pill);
    }
    pill.querySelector(".n").textContent = omitted ? `+${omitted}` : String(count);
    pill.querySelector(".sr-only").textContent = words;
    toggle.title = `${card.dataset.toolName || "tool"} · ${words}`;
  }
  // The toggle opened the card: its chips are drawn now, and anything not loaded is fetched.
  function imagesOnCardOpen(card) {
    if (!card._images?.length && !card._imagesOmitted) return;
    renderImageRow(card);
  }
  function renderImageRow(card) {
    const body = card.querySelector(":scope > .body");
    if (!body) return;
    let row = body.querySelector(":scope > .tool-images");
    if (!row) {
      row = el("ul", "tool-images");
      row.setAttribute("role", "list"); row.setAttribute("aria-label", "Images from this step");
      body.prepend(row);
    }
    row.textContent = "";
    const records = card._images || [];
    records.forEach((record, index) => {
      const item = el("li");
      item.appendChild(imageChip(record, index, records.length));
      row.appendChild(item);
    });
    if (card._imagesOmitted) {
      const more = el("li", "image-omitted");
      more.textContent = `+${card._imagesOmitted} not shown`;
      more.title = "DGC keeps up to 8 images per step, and only PNG, JPEG, GIF, WebP or BMP.";
      row.appendChild(more);
    }
    requestImages(records);
  }
  function imageChip(record, index, count) {
    // `compact`: an image the user sent, drawn in their prompt as the chip it was in the composer -- a
    // small tile beside its type and size. The full tile made the prompt too tall to stay pinned.
    const chip = el("button", record.compact ? "image-chip prompt-att chip" : "image-chip");
    chip.type = "button";
    chip.dataset.state = record.state;
    const dims = imageDims(record);
    const failure = record.state === "failed" ? (IMAGE_FAILURES[record.reason] || IMAGE_FAILURES.unreadable) : null;
    chip.setAttribute("aria-label", `Open image ${index + 1} of ${count}: ${record.name}${dims ? `, ${record.width} by ${record.height}` : ""}`);
    chip.title = failure ? failure[2] : [record.name, dims, imageSize(record.bytes)].filter(Boolean).join(" · ");
    const kind = (String(record.src || "").match(/^data:image\/([a-z]+)/i) || [])[1];
    const caption = el("span", "image-caption");
    // A sent image's chip reads as it did in the composer: its file name when it has one.
    const describe = () => { caption.textContent = failure ? failure[1]
      : (record.compact && imageFileName(record.name)) || [kind ? kind.toUpperCase() : "Image", imageDims(record)].filter(Boolean).join(" · "); };
    const tile = el("span", "image-tile");
    if (record.state === "ready") {
      const img = el("img"); img.alt = ""; img.decoding = "async";
      img.addEventListener("load", () => {
        if (!record.width && img.naturalWidth) { record.width = img.naturalWidth; record.height = img.naturalHeight; }
        if (record.compact) describe();
      });
      img.src = record.src; tile.appendChild(img);
    } else if (failure) {
      tile.innerHTML = icon(failure[0], "lg");
    } else {
      tile.classList.add("skeleton"); tile.appendChild(el("span", "sr-only", "Loading image"));
    }
    chip.appendChild(tile);
    // No caption under a picture that arrived: "PNG · 320x200 · 40 KB" repeated under every tile
    // is noise, and all of it is already in the hover label and the viewer. A FAILURE keeps its
    // caption -- without it a broken image is just an unexplained empty square. A compact chip
    // always has one: its tile is too small to recognise the picture by.
    if (failure || record.compact) { describe(); chip.appendChild(caption); }
    chip.onclick = () => openImageViewer(record, chip);
    record.chip = chip;
    return chip;
  }
  function refreshImageChip(record) {
    const old = record.chip;
    if (old && old.isConnected) {
      const records = record.owner?._images || [record];
      const replacement = imageChip(record, Math.max(0, records.indexOf(record)), records.length);
      const hadFocus = document.activeElement === old;
      old.replaceWith(replacement);
      if (hadFocus) replacement.focus();
    }
    if (imageViewer && imageViewer.records[imageViewer.index] === record) renderViewerImage(false);
  }

  // ---- fetching by ref ----
  function requestImages(records) {
    for (const record of records) {
      if (record.state !== "pending" || !record.ref || imageQueue.includes(record)) continue;
      const cached = imageCacheGet(record.ref);
      if (cached) { record.src = cached; record.state = "ready"; refreshImageChip(record); continue; }
      imageQueue.push(record);
    }
    pumpImages();
  }
  function pumpImages() {
    if (!imageViewsSupported) {
      while (imageQueue.length) failImage(imageQueue.shift(), "unreadable");
      return;
    }
    while (imageInFlight.size < 2 && imageQueue.length) {
      const record = imageQueue.shift();
      if (record.state !== "pending") continue;
      const cached = imageCacheGet(record.ref);
      if (cached) { record.src = cached; record.state = "ready"; refreshImageChip(record); continue; }
      const requestId = `img-${imageGeneration}-${++imageRequestSeq}`;
      record.state = "loading"; refreshImageChip(record);
      const timer = setTimeout(() => {
        if (!imageInFlight.has(requestId)) return;
        imageInFlight.delete(requestId); failImage(record, "unreadable"); pumpImages();
      }, 30000);
      imageInFlight.set(requestId, { record, timer });
      vscode.postMessage({ type: "getImage", requestId, ref: record.ref });
    }
  }
  function failImage(record, reason) {
    record.state = "failed"; record.reason = IMAGE_FAILURES[reason] ? reason : "unreadable"; refreshImageChip(record);
  }
  function imagesOnAnswer(ev) {
    const entry = imageInFlight.get(ev.request_id);
    if (!entry) return;                                             // stale: a session ago, or timed out
    clearTimeout(entry.timer); imageInFlight.delete(ev.request_id);
    const record = entry.record;
    if (ev.ref !== record.ref) failImage(record, "unreadable");
    else if (typeof ev.image === "string" && ev.image && IMAGE_DATA.test(ev.image)) {
      imageCachePut(record.ref, ev.image);
      for (const twin of imageRefs.get(record.ref) || [record]) {
        if (twin.state === "ready" && twin.src) continue;
        twin.src = ev.image; twin.state = "ready"; twin.reason = "";
        if (Number.isSafeInteger(ev.width) && ev.width > 0 && !twin.width) { twin.width = ev.width; twin.height = ev.height; }
        refreshImageChip(twin);
      }
    } else if (ev.reason === "busy" && (record.attempts || 0) < IMAGE_RETRY_MS.length) {
      const delay = IMAGE_RETRY_MS[record.attempts || 0];
      record.attempts = (record.attempts || 0) + 1;
      record.state = "pending"; refreshImageChip(record);
      const generation = imageGeneration;
      setTimeout(() => { if (generation === imageGeneration) requestImages([record]); }, delay);
    } else failImage(record, ev.reason === "invalid_ref" || ev.reason === "busy" ? "unreadable" : ev.reason);
    pumpImages();
  }
  function imagesOnSessionReset(kind) {
    imageGeneration++;
    for (const entry of imageInFlight.values()) clearTimeout(entry.timer);
    imageInFlight.clear(); imageQueue.length = 0; imageRefs.clear(); imageCache.clear(); imageCacheChars = 0;
    closeImageViewer(false);
  }
  function imagesOnBackendExit(msg) {
    // Requests the stopped backend will never answer go back in line; the next `ready` asks again.
    for (const entry of imageInFlight.values()) {
      clearTimeout(entry.timer);
      if (entry.record.state === "loading") { entry.record.state = "pending"; refreshImageChip(entry.record); }
    }
    imageInFlight.clear();
    if (imageViewer && !msg?.recovering) imageViewerAttention("backend_exit");
  }
  function imagesOnReady(ev) {
    imageViewsSupported = ev?.capabilities?.image_views === true;
    const wanted = new Set();
    for (const records of imageRefs.values()) {
      for (const record of records) {
        const shown = record.owner?.classList.contains("open") && record.owner.isConnected;
        const viewing = imageViewer && imageViewer.records[imageViewer.index] === record;
        if (record.state === "pending" && (shown || viewing)) wanted.add(record);
      }
    }
    requestImages([...wanted]);
  }

  // ---- the viewer ----
  function imageSequenceFor(record) {
    const group = record.owner?.closest(".tool-group");
    if (!group) return record.owner?._images?.length ? [...record.owner._images] : [record];
    return [...group.querySelectorAll(".tool")].flatMap((card) => card._images || []);
  }
  function viewerButton(icon, label, title, cls) {
    return `<button type="button" class="iv-btn ${cls}" aria-label="${label}" title="${title}"><span class="codicon codicon-${icon}" aria-hidden="true"></span></button>`;
  }
  function openImageViewer(record, opener) {
    if (imageViewer) closeImageViewer(false);
    const viewer = el("div");
    viewer.id = "image-viewer";
    viewer.setAttribute("role", "dialog"); viewer.setAttribute("aria-modal", "true"); viewer.setAttribute("aria-labelledby", "iv-title");
    viewer.innerHTML = `<div class="iv-bar"><div class="iv-heading"><h2 id="iv-title"></h2><span id="iv-meta"></span></div><div class="iv-controls"><span class="iv-pos"></span>${viewerButton("chevron-left", "Previous image", "Previous image (←)", "iv-prev")}${viewerButton("chevron-right", "Next image", "Next image (→)", "iv-next")}<span class="iv-zoomer"><button type="button" class="iv-btn iv-out" aria-label="Zoom out" title="Zoom out (-)"><span class="codicon codicon-zoom-out" aria-hidden="true"></span></button><output class="iv-level" aria-live="off">100%</output><button type="button" class="iv-btn iv-in" aria-label="Zoom in" title="Zoom in (+)"><span class="codicon codicon-zoom-in" aria-hidden="true"></span></button></span>${viewerButton("screen-full", "Fit to panel", "Fit to panel (Z)", "iv-zoom")}${viewerButton("desktop-download", "Save image", "Save image", "iv-save")}${viewerButton("go-to-file", "Open file", "Open file", "iv-open")}${viewerButton("debug-stop", "Stop generation", "Stop generation", "iv-stop")}${viewerButton("close", "Close image preview", "Close (Esc)", "iv-close")}</div></div><div class="iv-notice" hidden><span class="iv-notice-text"></span><button type="button" class="act iv-show">Show</button></div><div class="iv-stage"></div>`;
    const inert = [...document.body.children]
      .filter((node) => node !== viewer && node.id !== "announcer" && !node.classList.contains("tip"))
      .map((node) => ({ node, attr: node.hasAttribute("inert"), prop: node.inert }));
    for (const saved of inert) { saved.node.setAttribute("inert", ""); try { saved.node.inert = true; } catch {} }
    const records = imageSequenceFor(record);
    imageViewer = { el: viewer, records, index: Math.max(0, records.indexOf(record)), opener, inert,
                    actual: false, scale: 1, observer: null };
    const q = (selector) => viewer.querySelector(selector);
    q(".iv-zoom").setAttribute("aria-pressed", "false");
    q(".iv-prev").onclick = () => moveViewer(-1);
    q(".iv-next").onclick = () => moveViewer(1);
    q(".iv-zoom").onclick = () => toggleViewerZoom();
    q(".iv-in").onclick = () => stepViewerZoom(1);
    q(".iv-out").onclick = () => stepViewerZoom(-1);
    // A webview cannot write a file: the bytes go to the extension host, which owns the save
    // dialog and the workspace. Nothing is written without the reader choosing where.
    q(".iv-save").onclick = () => {
      const record = imageViewer?.records[imageViewer.index];
      if (!record || record.state !== "ready" || !record.src) return;
      vscode.postMessage({ type: "saveImage", name: record.name || "image.png", data: record.src });
    };
    q(".iv-close").onclick = () => closeImageViewer(true);
    // The viewer covers the composer, and with it Stop: while a turn runs, Stop is in the viewer too.
    q(".iv-stop").onclick = () => doStop();
    q(".iv-stop").hidden = !streaming;
    q(".iv-open").onclick = () => {
      const current = imageViewer?.records[imageViewer.index];
      if (current?.ref) vscode.postMessage({ type: "openImage", ref: current.ref });
    };
    q(".iv-show").onclick = () => showWaitingRequest();
    viewer.addEventListener("click", (event) => {
      if (event.target === viewer || event.target === q(".iv-stage")) closeImageViewer(true);
    });
    viewer.addEventListener("keydown", onViewerKey);
    document.body.appendChild(viewer);
    if (typeof MutationObserver === "function") {
      imageViewer.observer = new MutationObserver(() => renderViewerNav());
      imageViewer.observer.observe(log, { childList: true, subtree: true });
    }
    renderViewerImage(false);
    q(".iv-close").focus();
    hoverTip.hide();             // focus placed for the reader: no "Close (Esc)" label over the dialog
  }
  function onViewerKey(event) {
    if (!imageViewer) return;
    const key = event.key;
    if (key === "Escape") { event.preventDefault(); event.stopPropagation(); closeImageViewer(true); return; }
    if (key === "Tab") {
      const focusable = [...imageViewer.el.querySelectorAll("button")]
        .filter((node) => !node.disabled && !node.hidden && !node.closest("[hidden]"));
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      const inside = imageViewer.el.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || !inside)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !inside)) { event.preventDefault(); first.focus(); }
      return;
    }
    const stage = imageViewer.el.querySelector(".iv-stage");
    if (event.shiftKey && key.startsWith("Arrow")) {
      if (!imageViewer.actual) return;
      event.preventDefault();
      stage.scrollLeft += key === "ArrowLeft" ? -48 : key === "ArrowRight" ? 48 : 0;
      stage.scrollTop += key === "ArrowUp" ? -48 : key === "ArrowDown" ? 48 : 0;
      return;
    }
    if (key === "ArrowLeft") { event.preventDefault(); moveViewer(-1); }
    else if (key === "ArrowRight") { event.preventDefault(); moveViewer(1); }
    else if (key === "Home") { event.preventDefault(); moveViewer(-Infinity); }
    else if (key === "End") { event.preventDefault(); moveViewer(Infinity); }
    else if ((key === "z" || key === "Z") && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault(); toggleViewerZoom();
    }
    // The buttons advertise these keys in their titles, so they have to exist. "=" is the
    // unshifted key that carries "+" on most layouts, and the numpad sends "Add"/"Subtract".
    else if ((key === "+" || key === "=" || key === "Add") && !event.metaKey && !event.ctrlKey) {
      event.preventDefault(); stepViewerZoom(1);
    }
    else if ((key === "-" || key === "_" || key === "Subtract") && !event.metaKey && !event.ctrlKey) {
      event.preventDefault(); stepViewerZoom(-1);
    }
  }
  // A history snapshot re-rendered under the viewer: the image stays, the sequence it came from does not.
  function viewerLive() {
    return !!imageViewer && imageViewer.records.every((record) => record.owner?.isConnected);
  }
  function moveViewer(step) {
    if (!imageViewer || !viewerLive()) return;
    const last = imageViewer.records.length - 1;
    const next = Math.max(0, Math.min(last, step === Infinity ? last : step === -Infinity ? 0 : imageViewer.index + step));
    if (next === imageViewer.index) return;
    imageViewer.index = next;
    imageViewer.scale = 1;          // a new picture starts at its own size, not the last one's
    applyViewerZoom();
    renderViewerImage(true);
  }
  // Codex shows a percentage with - and + beside it, so a reader can meet an image halfway
  // instead of choosing between "fits the panel" and "every pixel". The steps are coarse on
  // purpose: a slider in a preview is fiddly, and these are the sizes anyone actually wants.
  const ZOOM_STEPS = [0.25, 0.4, 0.55, 0.7, 0.85, 1, 1.25, 1.5, 2, 3, 4];
  function viewerZoomIndex() {
    const wanted = imageViewer?.scale ?? 1;
    let best = 0;
    ZOOM_STEPS.forEach((step, i) => {
      if (Math.abs(step - wanted) < Math.abs(ZOOM_STEPS[best] - wanted)) best = i;
    });
    return best;
  }
  function applyViewerZoom() {
    if (!imageViewer) return;
    const el2 = imageViewer.el;
    const scale = imageViewer.scale ?? 1;
    // Any explicit zoom means the reader chose a size, so the fit/actual toggle steps aside.
    el2.classList.toggle("scaled", scale !== 1);
    el2.style.setProperty("--iv-scale", String(scale));
    const level = el2.querySelector(".iv-level");
    if (level) level.value = `${Math.round(scale * 100)}%`;
    const out = el2.querySelector(".iv-out"), inn = el2.querySelector(".iv-in");
    if (out) out.disabled = scale <= ZOOM_STEPS[0];
    if (inn) inn.disabled = scale >= ZOOM_STEPS[ZOOM_STEPS.length - 1];
  }
  function stepViewerZoom(direction) {
    if (!imageViewer) return;
    const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, viewerZoomIndex() + direction));
    imageViewer.scale = ZOOM_STEPS[next];
    if (imageViewer.actual) toggleViewerZoom();   // an explicit size replaces "actual size"
    applyViewerZoom();
  }
  function toggleViewerZoom() {
    if (!imageViewer) return;
    imageViewer.actual = !imageViewer.actual;
    imageViewer.el.classList.toggle("actual", imageViewer.actual);
    const zoom = imageViewer.el.querySelector(".iv-zoom");
    zoom.setAttribute("aria-pressed", String(imageViewer.actual));
    zoom.setAttribute("aria-label", imageViewer.actual ? "Fit to panel" : "Actual size");
    zoom.title = imageViewer.actual ? "Fit to panel (Z)" : "Actual size (Z)";
    zoom.querySelector(".codicon").className = `codicon codicon-${imageViewer.actual ? "screen-normal" : "screen-full"}`;
  }
  function refreshViewerSequence() {
    if (!imageViewer) return;
    const current = imageViewer.records[imageViewer.index];
    if (!current.owner?.isConnected) { renderViewerNav(); return; }
    imageViewer.records = imageSequenceFor(current);
    imageViewer.index = Math.max(0, imageViewer.records.indexOf(current));
    renderViewerNav();
  }
  function renderViewerNav() {
    if (!imageViewer) return;
    const live = viewerLive();
    const { records, index } = imageViewer;
    const q = (selector) => imageViewer.el.querySelector(selector);
    q(".iv-pos").textContent = `${index + 1} of ${records.length}`;
    const focusLost = document.activeElement === q(".iv-prev") || document.activeElement === q(".iv-next");
    q(".iv-prev").disabled = !live || index === 0;
    q(".iv-next").disabled = !live || index >= records.length - 1;
    if (focusLost && document.activeElement?.disabled) q(".iv-close").focus();
  }
  function renderViewerImage(announce) {
    if (!imageViewer) return;
    const record = imageViewer.records[imageViewer.index];
    const q = (selector) => imageViewer.el.querySelector(selector);
    const label = IMAGE_SOURCES[record.source] || "Image";
    q("#iv-title").textContent = record.name || label;
    q("#iv-meta").textContent = [imageDims(record), imageSize(record.bytes), record.host || label].filter(Boolean).join(" · ");
    q(".iv-open").hidden = !record.ref;
    q(".iv-open").title = `Open ${record.name} in the editor`;
    const stage = q(".iv-stage");
    stage.textContent = "";
    if (record.state === "ready" && record.src) {
      const img = el("img");
      img.alt = `${record.name}, ${label}`;
      img.src = record.src;
      img.addEventListener("click", (event) => { event.stopPropagation(); toggleViewerZoom(); });
      stage.appendChild(img);
    } else {
      const failure = record.state === "failed" ? (IMAGE_FAILURES[record.reason] || IMAGE_FAILURES.unreadable) : null;
      stage.appendChild(el("div", "iv-message", esc(failure ? failure[2] : "Loading image…")));
      if (record.state === "pending") requestImages([record]);
    }
    renderViewerNav();
    if (announce) speak(`Image ${imageViewer.index + 1} of ${imageViewer.records.length}: ${record.name}`);
  }
  function closeImageViewer(restoreFocus) {
    if (!imageViewer) return;
    const { el: viewer, inert, records, index, opener, observer } = imageViewer;
    imageViewer = null;
    observer?.disconnect();
    viewer.remove();
    for (const saved of inert) {
      if (!saved.attr) saved.node.removeAttribute("inert");
      try { saved.node.inert = saved.prop; } catch {}
    }
    if (!restoreFocus) return;
    const shown = records[index];
    const target = shown?.chip?.isConnected && shown.owner?.classList.contains("open") ? shown.chip
      : opener?.isConnected ? opener : input;
    focusQuietly(target);
    target.scrollIntoView?.({ block: "nearest" });
    clearOfPin(target);          // "nearest" can leave it under a pinned prompt (0.47 pinned prompt)
  }
  // Stop shows in the viewer exactly while the composer's Send is a Stop. Focus on a Stop that goes
  // away (the turn ended) moves to Close, inside the dialog.
  viewerStreaming = () => {
    if (!imageViewer) return;
    const stop = imageViewer.el.querySelector(".iv-stop");
    const hadFocus = document.activeElement === stop;
    stop.hidden = !streaming;
    if (hadFocus && stop.hidden) imageViewer.el.querySelector(".iv-close").focus();
  };
  // A request card or recovery offer arrived (or the backend stopped) while the viewer covers the panel.
  function imageViewerAttention(kind) {
    if (!imageViewer) return;
    const text = kind === "backend_exit" ? "DGC's backend stopped." : "DGC is waiting for your answer.";
    const notice = imageViewer.el.querySelector(".iv-notice");
    notice.querySelector(".iv-notice-text").textContent = text;
    notice.hidden = false;
    hoverTip.hide();             // a label left over from the bar must not cover Show
    // The request's own handler announces itself right after this call; speak only when nothing
    // else did in the same tick, so a screen reader hears one line, not two.
    const before = announcer.textContent;
    Promise.resolve().then(() => { if (imageViewer && announcer.textContent === before) speak(text); });
  }
  function showWaitingRequest() {
    closeImageViewer(false);
    const focusFirst = (node) => {
      if (!node) return false;
      const control = [...node.querySelectorAll("button, input, select, textarea, [tabindex]")]
        .find((candidate) => !candidate.disabled && !candidate.closest("[hidden]"));
      (control || node).focus?.();
      node.scrollIntoView?.({ block: "nearest" });
      // After that scroll, not on focus (which came first): a card taller than the view is aligned
      // by its top, under a pinned prompt (0.47 pinned prompt).
      clearOfPin(control || node);
      return true;
    };
    // A docked question takes focus on its highlighted row (the preselected recommendation).
    if (askCardDocked() && (focusAskCard() || focusFirst($("cbox").querySelector(".ask") || $("cbox")))) return;
    const cards = [...log.querySelectorAll(".card[data-request-id]:not(.resolved), .recovery-card")];
    if (focusFirst(cards.at(-1))) return;
    input.focus();
  }
  // ---- end 0.40 images ----------------------------------------------------------------------------


  // ---- 0.40 reconnecting --------------------------------------------------------------------------
  // A model request DGC retries is one muted line inside its turn, found again by `retry_id` (never
  // by adjacency), updated in place and closed in past tense. Frames reach here live and from history
  // replay, where nothing was schema-checked, so every field is coerced before it is used and every
  // string is inserted as text.
  const RETRY_KINDS = new Set(["connect", "dns", "tls", "proxy", "reset", "connect_timeout", "http",
    "rate_limited", "overloaded", "stream_cut", "stall", "loading", "auth", "model_not_found", "engine", "other"]);
  const RETRY_STATES = new Set(["retrying", "recovered", "gave_up", "cancelled"]);
  const retryTurnless = new Map();          // lines drawn for frames outside any turn (`dgc -p`-style)
  const retryTurnlessSpeech = { lost: false, recovered: false };
  let retrySeq = 0;
  // A narrow panel shortens "Sub-agent · " to "Sub · " so the counter stays on the first line.
  const retryNarrow = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 360px)") : null;
  function retryPrefixText(span) { span.textContent = (retryNarrow?.matches ? span.dataset.short : span.dataset.long) || ""; }
  retryNarrow?.addEventListener?.("change", () => document.querySelectorAll(".model-retry-prefix").forEach(retryPrefixText));
  function forgetTurnlessRetries() { retryTurnless.clear(); retryTurnlessSpeech.lost = retryTurnlessSpeech.recovered = false; }
  function retryOnSessionReset(kind) { forgetTurnlessRetries(); }
  function retryOnBackendExit(msg) {
    // The process that owned these runs is gone: a restarted backend's ids must never update them,
    // and no line may keep saying "Reconnecting 1/3" beside "Restarting the DGC backend". A turn's
    // lines settle now, not when the turn's own end arrives (up to 30 s later while recovering).
    for (const line of retryTurnless.values()) if (line.state === "retrying") paintRetryLine(line, "unfinished");
    for (const line of turn?.retryLines?.values() || []) if (line.state === "retrying") paintRetryLine(line, "unfinished");
    forgetTurnlessRetries();
  }
  function retryOnReady(ev) { forgetTurnlessRetries(); }
  // `t` is the turn being ended (never null here); `reason` is endTurn's reason. Only the backend
  // knows whether retries were exhausted, so a line it never closed says it did not finish. A live
  // Stop says so; a replayed turn's reason is only what the session file supports, so replay never
  // claims more than "did not finish".
  function settleRetryLines(t, reason) {
    for (const line of t.retryLines?.values() || []) {
      if (line.state === "retrying") paintRetryLine(line, reason === "cancelled" && !replaying ? "cancelled" : "unfinished");
    }
  }
  function retryText(value, max) {
    if (typeof value === "string") return value.slice(0, max);
    return typeof value === "number" && Number.isFinite(value) ? String(value).slice(0, max) : "";
  }
  function retryInt(value, low, high) {
    const n = typeof value === "number" ? value : (typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : NaN);
    return Number.isInteger(n) && n >= low && n <= high ? n : null;
  }
  function coerceRetry(ev) {
    const id = retryText(ev.retry_id, 128);
    if (!id) return null;
    return {
      id, state: RETRY_STATES.has(ev.state) ? ev.state : "retrying",
      kind: RETRY_KINDS.has(ev.kind) ? ev.kind : "other",
      layer: ev.layer === "continuation" ? "continuation" : "request",
      attempt: retryInt(ev.attempt, 1, 100) || 1, max: retryInt(ev.max_attempts, 1, 100),
      summary: retryText(ev.summary, 200), endpoint: retryText(ev.endpoint, 300),
      model: retryText(ev.model, 200), apiMode: retryText(ev.api_mode, 40),
      detail: retryText(ev.detail, 4000), hint: retryText(ev.hint, 300),
      httpStatus: retryInt(ev.http_status, 100, 599), delayMs: retryInt(ev.delay_ms, 0, 600000),
      origin: ["agent", "subagent", "engine"].includes(ev.origin) ? ev.origin : "agent",
      agent: retryText(ev.agent, 64), engine: retryText(ev.engine, 40), turnId: retryText(ev.turn_id, 128),
    };
  }
  function retryHost(endpoint) {
    const text = String(endpoint || "");
    const match = text.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
    return match ? match[1] : text;
  }
  // The same words as dgc/model_watch.format_seconds: a 0.25 s backoff reads "0.25s".
  function retrySeconds(ms) {
    const s = ms / 1000;
    if (s < 1 && Math.abs(s - Math.round(s)) > 0.05) return `${s.toFixed(2).replace(/0$/, "")}s`;
    return s < 10 && Math.abs(s - Math.round(s)) > 0.05 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
  }
  // Which words a kind's line uses: one table for the label and the screen-reader phrase.
  function retryVerb(kind) {
    if (kind === "rate_limited" || kind === "overloaded") return "busy";
    if (kind === "http") return "http";
    if (kind === "stall" || kind === "loading") return "silent";
    if (kind === "auth" || kind === "model_not_found") return "plain";
    return "reconnect";
  }
  const RETRY_SPEECH = { reconnect: "Connection to the model lost, reconnecting", busy: "The model server is busy, retrying",
    http: "The model server returned an error, retrying", silent: "The model is not responding, retrying",
    plain: "Retrying the model request" };
  // [words, counter] for a line; the counter is drawn in its own span.
  function retryWords(line, state) {
    const verb = retryVerb(line.kind);
    const busy = verb === "busy";
    const reconnect = verb === "reconnect";
    // A run can span two budgets; the counter never reads "4/3".
    const count = line.max ? `${line.attempt}/${Math.max(line.max, line.attempt)}` : `${line.attempt}`;
    const tries = `${line.attempt} ${line.attempt === 1 ? "retry" : "retries"}`;
    if (state === "retrying") {
      if (busy) return ["Server is busy, retrying", count];
      if (line.kind === "http") return ["Server error, retrying", count];
      if (!reconnect) return ["Retrying", count];
      if (!line.max) return [line.origin === "engine" ? "Reconnecting · waiting for network"
        : `Reconnecting · waiting for ${retryHost(line.endpoint) || "the server"}`, ""];
      return ["Reconnecting", count];
    }
    if (state === "recovered") {
      if (line.layer === "continuation") {
        return [(reconnect ? "Reconnected" : "Recovered") + (line.partial ? " · continued from the partial answer" : ""), ""];
      }
      return [`${reconnect ? "Reconnected" : "Recovered"} after ${tries}`, ""];
    }
    if (state === "gave_up") {
      return [line.layer === "continuation" ? `Gave up after ${line.attempt} reconnect${line.attempt === 1 ? "" : "s"}`
        : `Gave up after ${tries}`, ""];
    }
    if (state === "cancelled") return [reconnect ? "Stopped while reconnecting" : "Stopped while retrying", ""];
    return ["Reconnect did not finish", ""];
  }
  function buildRetryLine(frame) {
    const n = ++retrySeq;
    const node = el("div", "model-retry");
    node.innerHTML = `<button type="button" class="model-retry-toggle" aria-expanded="false" aria-controls="model-retry-detail-${n}">`
      + `<span class="model-retry-icon" data-icon="refresh-cw" aria-hidden="true">${icon("refresh-cw")}</span>`
      + '<span class="model-retry-label"><span class="model-retry-prefix"></span>'
      + '<span class="model-retry-words"></span><span class="model-retry-count"></span></span>'
      + '<span class="model-retry-cause"></span>'
      + '<span class="codicon codicon-chevron-down model-retry-chev" aria-hidden="true"></span></button>'
      + `<div class="model-retry-detail" id="model-retry-detail-${n}" hidden>`
      + '<dl class="model-retry-facts"></dl>'
      + `<div class="model-retry-section" id="model-retry-attempts-${n}" hidden>Attempts</div>`
      + `<ol class="model-retry-attempts" aria-labelledby="model-retry-attempts-${n}"></ol>`
      + '<div class="model-retry-section model-retry-raw-label" hidden>Details</div><pre class="model-retry-raw" hidden></pre>'
      + '<div class="model-retry-section model-retry-hint-label" hidden>Hint</div><p class="model-retry-hint" hidden></p>'
      + '<button type="button" class="link model-retry-copy"><span class="codicon codicon-copy" aria-hidden="true"></span> Copy details</button></div>';
    const toggle = node.querySelector(".model-retry-toggle"), detail = node.querySelector(".model-retry-detail");
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(open));
      detail.hidden = !open;
    });
    const line = { node, id: frame.id, state: "retrying", attempts: [], dropped: 0, partial: false, ...frame };
    node.querySelector(".model-retry-copy").addEventListener("click", (event) => {
      vscode.postMessage({ type: "copy", text: retryCopyText(line) });
      flashAction(event.currentTarget, "check");
    });
    return line;
  }
  function retryFacts(dl, rows) {
    dl.textContent = "";
    for (const [name, value] of rows) {
      if (!value) continue;
      dl.appendChild(el("dt", "", "")).textContent = name;
      dl.appendChild(el("dd", "", "")).textContent = value;
    }
  }
  // Which sub-agent a line belongs to, by its task description from the agents list: parallel
  // sub-agents reconnecting at once otherwise draw identical lines.
  function retryAgentDescription(line) {
    if (line.origin !== "subagent" || !line.agent) return "";
    const record = agentRecords.get(line.agent);
    return record ? String(record.description || "").replace(/\s+/g, " ").trim().slice(0, 120) : "";
  }
  function retryFactRows(line) {
    return [["Sub-agent", retryAgentDescription(line)],
      ["Cause", line.summary], ["Model", [line.model, line.apiMode].filter(Boolean).join(" · ")],
      ["Endpoint", line.endpoint], ["Engine", line.origin === "engine" ? line.engine : ""],
      ["HTTP status", line.httpStatus ? String(line.httpStatus) : ""]];
  }
  function paintRetryLine(line, state) {
    line.state = state;
    const node = line.node;
    const [words, count] = retryWords(line, state);
    node.dataset.retryId = line.id;
    node.dataset.state = state;
    node.dataset.kind = line.kind;
    const prefix = line.origin === "subagent" ? "Sub-agent · " : line.origin === "engine" && line.engine ? `${line.engine} · ` : "";
    const prefixEl = node.querySelector(".model-retry-prefix");
    prefixEl.dataset.long = prefix;
    prefixEl.dataset.short = line.origin === "subagent" ? "Sub · " : prefix;
    retryPrefixText(prefixEl);
    node.querySelector(".model-retry-words").textContent = words;
    node.querySelector(".model-retry-count").textContent = count ? ` ${count}` : "";
    const cause = state === "recovered" ? (retryHost(line.endpoint) || line.summary) : line.summary;
    node.querySelector(".model-retry-cause").textContent = cause;
    const who = retryAgentDescription(line);
    const toggle = node.querySelector(".model-retry-toggle");
    const title = who ? `Sub-agent “${who}” · ${words}${count ? ` ${count}` : ""}${cause ? `\n${cause}` : ""}` : "";
    if (title) hoverTip.retitle(toggle, title);
    else if (toggle.hasAttribute("title")) hoverTip.retitle(toggle, "");
    // Four states, one metaphor: in progress, worked, failed, stopped.
    setIcon(node.querySelector(".model-retry-icon"),
      state === "recovered" ? "circle-check"
        : state === "gave_up" ? "circle-alert"
          : state === "cancelled" || state === "unfinished" ? "circle-slash" : "refresh-cw");
    retryFacts(node.querySelector(".model-retry-facts"), retryFactRows(line));
    const list = node.querySelector(".model-retry-attempts");
    list.textContent = "";
    if (line.dropped) list.appendChild(el("li", "model-retry-earlier")).textContent = `… ${line.dropped} earlier attempts`;
    for (const attempt of line.attempts) {
      const li = el("li");
      li.appendChild(el("span", "n")).textContent = String(attempt.n);
      li.appendChild(document.createTextNode(" " + attempt.summary
        + (attempt.delayMs != null ? ` · retried after ${retrySeconds(attempt.delayMs)}` : "")));
      list.appendChild(li);
    }
    list.hidden = !line.attempts.length && !line.dropped;
    list.previousElementSibling.hidden = list.hidden;
    const raw = node.querySelector(".model-retry-raw"), hint = node.querySelector(".model-retry-hint");
    raw.textContent = line.detail; raw.hidden = !line.detail;
    hint.textContent = line.hint; hint.hidden = !line.hint;
    node.querySelector(".model-retry-raw-label").hidden = raw.hidden;
    node.querySelector(".model-retry-hint-label").hidden = hint.hidden;
  }
  function retryCopyText(line) {
    const [words, count] = retryWords(line, line.state);
    const out = [`${words}${count ? " " + count : ""}${line.summary ? " · " + line.summary : ""}`];
    for (const [name, value] of retryFactRows(line)) if (value) out.push(`${name}: ${value}`);
    if (line.dropped) out.push(`… ${line.dropped} earlier attempts`);
    for (const a of line.attempts) {
      out.push(`Attempt ${a.n}: ${a.summary}${a.delayMs != null ? ` · retried after ${retrySeconds(a.delayMs)}` : ""}`);
    }
    if (line.detail) out.push("Details:", line.detail);
    if (line.hint) out.push(`Hint: ${line.hint}`);
    return out.join("\n");
  }
  function onModelRetry(ev) {
    const frame = coerceRetry(ev);
    if (!frame) return;
    let map, speech, owner = null;
    if (frame.turnId) {
      // A frame names its turn: draw it only in that turn. A turn discarded by a new, cleared or
      // resumed chat (or one already ended) is gone, and its late frames must not reach the new chat.
      if (!turn || (turn.id && turn.id !== frame.turnId)) return;
      owner = turn;
      map = turn.retryLines || (turn.retryLines = new Map());
      speech = turn.retrySpeech || (turn.retrySpeech = { lost: false, recovered: false });
    } else {
      map = retryTurnless; speech = retryTurnlessSpeech;
    }
    let line = map.get(frame.id);
    if (!line) {
      line = buildRetryLine(frame);
      map.set(frame.id, line);
      const before = owner ? owner.act : null;
      const previous = before ? before.previousElementSibling : null;
      line.partial = !!(previous && previous.classList.contains("text"));
      if (owner) appendTurnContent(line.node); else appendConversationContent(line.node);
      endToolGroup();
    } else {
      Object.assign(line, { kind: frame.kind, layer: frame.layer, attempt: frame.attempt, max: frame.max ?? line.max,
        origin: frame.origin, engine: frame.engine || line.engine, agent: frame.agent || line.agent });
      for (const key of ["summary", "endpoint", "model", "apiMode", "detail", "hint"]) if (frame[key]) line[key] = frame[key];
      if (frame.httpStatus) line.httpStatus = frame.httpStatus;
    }
    if (frame.state === "retrying") {
      line.attempts.push({ n: frame.attempt, summary: frame.summary, delayMs: frame.delayMs });
      if (line.attempts.length > 20) { line.dropped += line.attempts.length - 20; line.attempts.splice(0, line.attempts.length - 20); }
    }
    paintRetryLine(line, frame.state);
    // One announcement for the first loss in a turn and one for the first recovery after it. Nothing
    // for later attempts, parallel runs, Stop, a give-up (the error row speaks), replay, or a hidden panel.
    if (replaying || document.visibilityState === "hidden") return;
    if (frame.state === "retrying" && frame.attempt === 1 && !speech.lost) {
      speech.lost = true;
      speak(RETRY_SPEECH[retryVerb(frame.kind)]);
    } else if (frame.state === "recovered" && speech.lost && !speech.recovered) {
      speech.recovered = true;
      speak("Reconnected to the model");
    }
  }
  const MODEL_ERROR_HEADLINES = {
    connect: "Could not reach the model", dns: "Could not reach the model", tls: "Could not reach the model",
    proxy: "Could not reach the model", reset: "Could not reach the model", connect_timeout: "Could not reach the model",
    http: "The model server failed", overloaded: "The model server failed", rate_limited: "The model server failed",
    stream_cut: "The model stream kept breaking", stall: "The model stopped responding", loading: "The model stopped responding",
    auth: "The model endpoint rejected the key", engine: "The engine failed", other: "Model request failed",
  };
  // The final model error, when the backend said why. False when there is no usable cause, so the
  // caller keeps today's plain line: a cause that fails coercion never becomes an empty row.
  function modelErrorRow(ev) {
    const cause = ev.cause;
    if (!cause || typeof cause !== "object" || Array.isArray(cause)) return false;
    if (typeof cause.kind !== "string" || typeof cause.summary !== "string" || !cause.summary.trim()) return false;
    for (const key of ["endpoint", "model", "api_mode", "retry_id", "detail", "hint"]) {
      if (cause[key] != null && typeof cause[key] !== "string") return false;
    }
    for (const key of ["http_status", "attempts"]) {
      if (cause[key] != null && !Number.isInteger(cause[key])) return false;
    }
    const kind = RETRY_KINDS.has(cause.kind) ? cause.kind : "other";
    const summary = cause.summary.slice(0, 200), model = retryText(cause.model, 200);
    const message = String(ev.message || "");
    const lead = kind === "model_not_found" ? (model ? `The server has no model named ${model}` : "The server has no such model")
      : MODEL_ERROR_HEADLINES[kind];
    const headline = `${lead} · ${summary}`;
    const split = message.indexOf("\n  → ");
    const hint = split >= 0 ? message.slice(split + 5).trim() : retryText(cause.hint, 300);
    const n = ++retrySeq;
    const row = el("div", "sys err model-error");
    row.setAttribute("role", "alert");
    row.dataset.kind = kind;
    row.innerHTML = `<button type="button" class="model-error-toggle" aria-expanded="false" aria-controls="model-error-detail-${n}">`
      + `<span class="model-error-icon" data-icon="circle-alert" aria-hidden="true">${icon("circle-alert")}</span>`
      + '<span class="model-error-headline"></span>'
      + '<span class="codicon codicon-chevron-down model-retry-chev" aria-hidden="true"></span></button>'
      + '<p class="model-error-hint" hidden></p>'
      + `<div class="model-retry-detail model-error-detail" id="model-error-detail-${n}" hidden>`
      + '<dl class="model-retry-facts"></dl><div class="model-error-label">Message</div><pre class="model-error-message"></pre>'
      + '<button type="button" class="link model-retry-copy"><span class="codicon codicon-copy" aria-hidden="true"></span> Copy details</button></div>';
    row.querySelector(".model-error-headline").textContent = headline;
    const hintEl = row.querySelector(".model-error-hint");
    hintEl.textContent = hint ? `→ ${hint}` : ""; hintEl.hidden = !hint;
    const facts = [["Cause", summary], ["Model", [model, retryText(cause.api_mode, 40)].filter(Boolean).join(" · ")],
      ["Endpoint", retryText(cause.endpoint, 300)],
      ["HTTP status", retryInt(cause.http_status, 100, 599) ? String(cause.http_status) : ""],
      ["Attempts", retryInt(cause.attempts, 1, 1000000) ? String(cause.attempts) : ""],
      // The message below already prints the transport's words: never show them twice.
      ["Details", message.includes(retryText(cause.detail, 4000).replace(/^\w+: /, "")) ? "" : retryText(cause.detail, 4000)]];
    retryFacts(row.querySelector(".model-retry-facts"), facts);
    row.querySelector(".model-error-message").textContent = message;
    const toggle = row.querySelector(".model-error-toggle"), detail = row.querySelector(".model-error-detail");
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(open)); detail.hidden = !open;
    });
    row.querySelector(".model-retry-copy").addEventListener("click", (event) => {
      const text = [headline, ...facts.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`), "Message:", message].join("\n");
      vscode.postMessage({ type: "copy", text });
      flashAction(event.currentTarget, "check");
    });
    speak(`DGC error: ${headline}`);
    appendConversationContent(row);
    endToolGroup();
    const retryId = retryText(cause.retry_id, 128);
    const line = retryId ? (turn?.retryLines?.get(retryId) || retryTurnless.get(retryId)) : null;
    if (line && line.state !== "gave_up") paintRetryLine(line, "gave_up");
    return true;
  }
  // ---- end 0.40 reconnecting ----------------------------------------------------------------------


  // ---- 0.40 options -------------------------------------------------------------------------------
  // A propose_options request docks inside the composer frame (#cbox) in place of the text box and
  // the attachment chips; the footer (Stop, mode, model, context) stays. The recommended option is
  // preselected in a single-choice question: it is checked, holds the highlight and is the focus
  // target, so Enter, a click on it or Next takes it; Skip stays a separate, explicit control, and
  // nothing is sent without a user action. A pick settles its question and moves on. A single
  // question is sent by its pick; a card of several is sent only by Submit, so the last answer stays
  // on screen with the others to check (founder, 2026-10-21: "user should need to press submit button
  // to send all answers, not auto send"). The answered state renders inside the step's tool card,
  // identically live and on replay.
  const ASK_KEY_GUARD_MS = 400, ASK_CHOSEN_MS = 150, ASK_MAX_TEXT = 4096;
  // Moving on to another question has to be seen (founder, 2026-10-21: "so quick, it gets hard for me to
  // realise it has moved to the second question"). The pick holds a little longer, the next question
  // streams in a word at a time and its options pop in one after another, and for a moment after the
  // step a second click or a held key cannot answer the new question by landing where the last one was.
  const ASK_STEP_MS = 400, ASK_STEP_GUARD_MS = 300, ASK_STREAM_MS = 260, ASK_POP_GAP_MS = 45;
  // The fit rule's last resorts: the options list keeps one label line, the question two lines.
  const ASK_LIST_MIN = 44, ASK_QUESTION_MIN = 40;
  let ask = null, askSerial = 0;
  const askedClosed = new Set();          // answered cards the reader collapsed, by turn id + call

  function askValid(ev) {
    const qs = Array.isArray(ev.questions) ? ev.questions : [];
    return qs.length >= 1 && qs.length <= 4 && qs.every((q) => q && typeof q.id === "string"
      && typeof q.question === "string" && Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 6
      && q.options.every((o) => o && typeof o.label === "string"))
      && new Set(qs.map((q) => q.id)).size === qs.length;
  }
  // A model may still write its recommendation into the text: "SQLite (Recommended)", a description
  // ending "(Recommended)", or "Recommended: …". The badge says it instead (mirrors questions._unmark).
  const ASK_MARK = /\(\s*recommended\s*\)/gi, ASK_LEAD_MARK = /^\s*recommended\s*(?:[:\u00b7\u2013\u2014-]\s*|\.\s+)/i;
  const ASK_TRAIL_MARK = /(?:^|[,;:\u00b7\u2013\u2014-]|\.(?=\s))\s*recommended\s*[.!]?\s*$/i;
  // `sentence` (a description): text left after a leading "Recommended:" starts with a capital.
  // A plain lowercase word may start a sentence; "iOS", "eBPF" or "package.json" keep their case (questions._SENTENCE_WORD).
  const ASK_SENTENCE_WORD = /^[a-z]+[,;:.!?]?(?=\s|$)/;
  function askUnmark(text, sentence = false) {
    const raw = String(text || "");
    let stripped = raw.replace(/\(\s*recommended\s*:\s*([^()]*)\)/gi, "($1)").replace(ASK_MARK, " ");
    let found = stripped !== raw, capital = false;
    const lead = stripped.match(ASK_LEAD_MARK);
    if (lead) { stripped = stripped.slice(lead[0].length); found = true; capital = sentence; }
    const trail = stripped.match(ASK_TRAIL_MARK);
    if (trail) { stripped = stripped.slice(0, trail.index); found = true; }
    if (!found) return [raw, false];
    stripped = stripped.replace(/\s+([,;.!?])/g, "$1").replace(/([,;])(?:\s*[,;])+/g, "$1")
      .split(/\s+/).filter(Boolean).join(" ").replace(/^[\s,;:\u00b7\u2013\u2014-]+|[\s,;:\u00b7\u2013\u2014-]+$/g, "");
    if (capital && ASK_SENTENCE_WORD.test(stripped)) stripped = stripped.charAt(0).toUpperCase() + stripped.slice(1);
    return [stripped, true];
  }
  function askLabel(option) { return askUnmark(option.label)[0]; }
  function askDesc(option) { return askUnmark(option.description, true)[0]; }
  function askFlagged(option) {
    return option.recommended === true || askUnmark(option.label)[1] || askUnmark(option.description)[1];
  }
  // What a question has picked as shown: in a single choice, written words replace the pick.
  function askPicked(q, answer) {
    if (q.multi_select) return answer.selected;
    return answer.other.trim() ? [] : answer.selected.slice(0, 1);
  }
  function askCardDocked() { return !!(ask && ask.el.isConnected); }
  function askToolCard(callId) {
    if (!turn || !callId) return null;
    return (turn._tools && turn._tools[callId]) || null;
  }
  function askCountLabel(n) { return `${n} question${n === 1 ? "" : "s"}`; }

  function showAskCard(ev) {
    if (!askValid(ev)) { sysLine("DGC received an invalid question request. Stop the turn and retry.", true); return; }
    if (ask) retireAsk("replaced");
    const questions = ev.questions;
    const hadFocus = document.activeElement === input;
    const busyComposer = hadFocus && !!composerText().trim();
    const n = ++askSerial;
    const flagged = questions.map((q) => (q.multi_select ? -1 : q.options.findIndex(askFlagged)));
    const el = document.createElement("section");
    el.className = "ask";
    el.tabIndex = -1;
    el.dataset.requestId = String(ev.id);
    el.setAttribute("role", "group");
    el.setAttribute("aria-labelledby", `ask-q-${n}`);
    const state = {
      ev, el, n, questions, index: 0, armed: false, sending: false, busy: false, retired: false,
      restoreFocus: hadFocus,
      // Single choice: the recommendation (wherever it sits) is preselected, checked and highlighted;
      // multi-select preselects nothing and highlights row 1.
      answers: questions.map((q, k) => ({ selected: flagged[k] >= 0 ? [flagged[k]] : [], other: "", settled: false })),
      hot: questions.map((q, k) => (flagged[k] >= 0 ? flagged[k] : 0)),
    };
    pipSetupCards?.yieldDock();                    // a question takes the dock; the Pip waits for it
    ask = state;
    const cbox = $("cbox"), textBox = cbox.querySelector(".cinput");
    state.hid = { textBox: textBox ? textBox.hidden : false, atts: atts.hidden };
    cbox.insertBefore(el, cbox.firstChild);
    cbox.classList.add("asking");
    if (textBox) textBox.hidden = true;            // hidden, not rebuilt: the unsent draft stays in it
    atts.hidden = true;
    closeRailPop({ restore: false });              // the chip line steps aside for a docked question in a short panel
    document.body.classList.add("ask-docked");
    setTimeout(() => { state.armed = true; }, ASK_KEY_GUARD_MS);
    renderAskCard(state);
    const card = askToolCard(ev.call_id);
    if (card) {
      const arg = card.querySelector(".arg");
      if (arg) arg.textContent = `${askCountLabel(questions.length)}…`;
    }
    el.addEventListener("keydown", (event) => askKey(state, event));
    el.addEventListener("focusin", (event) => {
      if (event.target === el) return;         // the card holding focus for a busy composer keeps its hint
      const hint = el.querySelector(".ask-hint"); if (hint) hint.hidden = true;
    });
    speak(`DGC asks: ${questions[0].question}`);
    renderTurnMeta();
    renderComposerControls();
    fitAskCard();
    // Arrival never turns typing into a choice: a reader mid-sentence keeps their place (the card
    // itself holds focus while the text box is hidden) and is told how to reach the options.
    if (busyComposer) {
      el.querySelector(".ask-hint").hidden = false;
      el.focus({ preventScroll: true });
    } else {
      focusAskCard();
    }
  }

  function renderAskCard(state, entering = false) {
    const { el, n, questions } = state;
    const i = state.index, q = questions[i], answer = state.answers[i], multi = !!q.multi_select;
    const draft = el.querySelector(".ask-field");
    if (draft) state.answers[state.drawn ?? i].other = draft.value;
    state.drawn = i;
    const hot = state.hot[i];
    const picked = askPicked(q, answer);
    const rows = q.options.map((option, k) => {
      const checked = picked.includes(k);
      const flagged = askFlagged(option);
      const label = askLabel(option);
      const desc = askDesc(option);
      return `<button type="button" class="ask-opt${k === hot ? " hot" : ""}${checked ? " checked" : ""}" role="${multi ? "checkbox" : "radio"}"`
        + ` aria-checked="${checked}" tabindex="${k === hot ? 0 : -1}" data-i="${k}"`
        + ` aria-label="${esc(label + (flagged ? ", recommended" : ""))}"${desc ? ` aria-describedby="ask-d-${n}-${k}"` : ""}>`
        + `<span class="ask-n" aria-hidden="true">${checked && multi ? "✓" : k + 1}</span>`
        + `<span class="ask-body"><span class="ask-label">${esc(label)}</span>${flagged ? '<span class="ask-badge">Recommended</span>' : ""}`
        + (desc ? `<span class="ask-desc" id="ask-d-${n}-${k}">${esc(desc)}</span>` : "") + `</span>`
        + `</button>`;
    }).join("");
    const pager = questions.length > 1
      ? `<div class="ask-foot"><button type="button" class="ask-page" data-step="-1" aria-label="Previous question" title="Previous question (←)"${i === 0 ? " disabled" : ""}><span class="codicon codicon-chevron-left" aria-hidden="true"></span></button>`
        + `<span class="ask-pg">Question ${i + 1} of ${questions.length}</span>`
        + `<button type="button" class="ask-page" data-step="1" aria-label="Next question" title="Next question (→)"${i === questions.length - 1 ? " disabled" : ""}><span class="codicon codicon-chevron-right" aria-hidden="true"></span></button></div>`
      : "";
    el.classList.toggle("ask-multi", multi);
    el.innerHTML = `<div class="ask-head"><div class="ask-q" id="ask-q-${n}">${esc(q.question)}</div>`
      + `<button type="button" class="ask-x" aria-label="Dismiss questions" title="Dismiss (Esc)"><span class="codicon codicon-close" aria-hidden="true"></span></button></div>`
      + `<div class="ask-hint" hidden>Press Tab to answer</div>`
      + `<div class="ask-opts" role="${multi ? "group" : "radiogroup"}" aria-labelledby="ask-q-${n}">${rows}</div>`
      + `<div class="ask-other"><span class="ask-pencil" aria-hidden="true">${icon("pencil", "xs")}</span>`
      + `<textarea class="ask-field" rows="1" maxlength="${ASK_MAX_TEXT}" aria-label="Your own answer" aria-describedby="ask-k-${n}"></textarea><span class="sr-only" id="ask-k-${n}">Enter sends, Shift+Enter adds a line</span>`
      + `<button type="button" class="ask-skip" title="Skip this question" hidden>Skip</button><button type="button" class="ask-act"></button></div>`
      + pager
      + `<div class="ask-error" id="ask-e-${n}" hidden></div>`;
    const field = el.querySelector(".ask-field");
    field.value = answer.other;
    askPlaceholder(field);
    field.addEventListener("input", () => { answer.other = field.value; growAskField(field); paintAskChecks(state); paintAskAction(state); fitAskCard(); });
    growAskField(field);
    el.querySelectorAll(".ask-opt").forEach((row) => {
      row.addEventListener("click", (event) => {
        // A pointer click is never delayed; a synthetic or keyboard click waits out the arrival guard.
        if ((event.detail === 0 && !state.armed) || state.entering) return;
        askChoose(state, Number(row.dataset.i));
      });
    });
    el.querySelector(".ask-x").addEventListener("click", (event) => { if (event.detail !== 0 || state.armed) askDismiss(state); });
    el.querySelector(".ask-act").addEventListener("click", (event) => {
      if ((event.detail === 0 && !state.armed) || state.entering) return;
      askAction(state);
    });
    el.querySelector(".ask-skip").addEventListener("click", (event) => {
      if ((event.detail === 0 && !state.armed) || state.entering) return;
      askSkip(state);
    });
    el.querySelectorAll(".ask-page").forEach((button) => button.addEventListener("click", () => askPage(state, Number(button.dataset.step))));
    paintAskAction(state);
    el.classList.remove("ask-enter");
    if (entering) askEnter(state);
    fitAskCard();
  }

  // The question arrives the way the model's own words do, a word at a time, and its options follow
  // one after another. Only opacity and transform move, so the card's measured fit never changes.
  function askEnter(state) {
    const { el } = state;
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const line = el.querySelector(".ask-q");
    const parts = line.textContent.split(/(\s+)/).filter(Boolean);
    const words = parts.filter((part) => !/^\s+$/.test(part)).length;
    const gap = Math.min(28, Math.floor(ASK_STREAM_MS / Math.max(1, words)));
    line.textContent = "";
    let w = 0;
    for (const part of parts) {
      if (/^\s+$/.test(part)) { line.append(part); continue; }
      const word = document.createElement("span");
      word.className = "ask-w";
      word.textContent = part;
      word.style.animationDelay = `${w++ * gap}ms`;
      line.append(word);
    }
    const start = Math.min(w * gap, 140);
    askRows(state).forEach((row, k) => { row.style.animationDelay = `${start + k * ASK_POP_GAP_MS}ms`; });
    el.classList.add("ask-enter");
  }
  // After a step, the new question's rows and buttons sit where the last ones were.
  function askStepGuard(state) {
    state.entering = true;
    setTimeout(() => { state.entering = false; }, ASK_STEP_GUARD_MS);
  }

  // The pill: Next (primary) once the question has a pick or words while another is still open; Submit
  // (Continue on a single question) when nothing else is open, which sends; Skip while the question has
  // neither, which settles it without sending. With a pick, Skip is its own quieter button beside the
  // pill. A question already settled with nothing in it (skipped, or after a rejection) submits as it is.
  function askPill(state) {
    const i = state.index, q = state.questions[i], answer = state.answers[i];
    const has = !!answer.other.trim() || askPicked(q, answer).length > 0;
    const others = state.answers.every((a, k) => k === i || a.settled);
    return others && (has || answer.settled) ? "submit" : has ? "next" : "skip";
  }
  function paintAskAction(state) {
    if (!state.el.isConnected && state !== ask) return;
    const i = state.index, q = state.questions[i], answer = state.answers[i];
    const button = state.el.querySelector(".ask-act"), skip = state.el.querySelector(".ask-skip");
    if (!button) return;
    const has = !!answer.other.trim() || askPicked(q, answer).length > 0;
    const pill = askPill(state), several = state.questions.length > 1;
    button.textContent = pill === "submit" ? (several ? "Submit" : "Continue") : pill === "next" ? "Next" : "Skip";
    button.classList.toggle("primary", pill !== "skip");
    button.title = pill === "submit" ? "Send your answers" : pill === "next" ? "Go to the next question" : "Skip this question";
    if (skip) skip.hidden = !has;
    const pg = state.el.querySelector(".ask-pg");
    if (pg) pg.textContent = `Question ${i + 1} of ${state.questions.length}`
      + (state.answers.every((a) => a.settled) ? " \u00b7 all answered" : "");
    const field = state.el.querySelector(".ask-field");
    if (field && !field.value) askPlaceholder(field);      // Skip and the button just changed its width
  }
  function paintAskChecks(state) {
    const q = state.questions[state.index], picked = askPicked(q, state.answers[state.index]);
    askRows(state).forEach((row, k) => {
      const on = picked.includes(k);
      row.classList.toggle("checked", on);
      row.setAttribute("aria-checked", String(on));
      row.querySelector(".ask-n").textContent = on && q.multi_select ? "✓" : String(k + 1);
    });
  }
  // The hint fits the field, not the window: beside Skip and Continue in a side bar the long one
  // wrapped onto a second line and pushed the pencil out of line.
  function askPlaceholder(field) {
    const width = field.clientWidth || field.getBoundingClientRect().width;
    field.placeholder = width && width < 300 ? "Something else…" : "Something else? Tell DGC what you want";
  }
  function growAskField(field) {
    field.style.height = "auto";
    const line = parseFloat(getComputedStyle(field).lineHeight) || 18;
    const max = line * 4 + 8;
    // An empty field is one line: Chromium counts a wrapped placeholder in scrollHeight.
    const wanted = field.value ? (field.scrollHeight || line) : line;
    field.style.height = `${Math.min(max, Math.max(line + 4, wanted))}px`;
    field.style.overflowY = wanted > max ? "auto" : "hidden";
  }

  function askRows(state) { return [...state.el.querySelectorAll(".ask-opt")]; }
  function askHotRow(state) { return askRows(state)[state.hot[state.index]] || askRows(state)[0] || null; }
  // The docked card's focus target: its highlighted row (the preselected recommendation on open).
  function focusAskCard() {
    if (!askCardDocked()) return false;
    const row = askHotRow(ask);
    (row || ask.el).focus({ preventScroll: true });
    row?.scrollIntoView?.({ block: "nearest" });
    return true;
  }
  function setAskHot(state, k, focus = true) {
    const rows = askRows(state);
    if (!rows.length) return;
    const next = Math.max(0, Math.min(rows.length - 1, k));
    state.hot[state.index] = next;
    rows.forEach((row, index) => { row.classList.toggle("hot", index === next); row.tabIndex = index === next ? 0 : -1; });
    if (focus) rows[next].focus({ preventScroll: true });
    rows[next].scrollIntoView?.({ block: "nearest" });
  }

  function askKey(state, event) {
    if (state !== ask || state.retired) { event.stopPropagation(); return; }
    const target = event.target;
    const inField = target.classList?.contains("ask-field");
    const onRow = target.classList?.contains("ask-opt");
    const key = event.key;
    if (key === "Escape") {
      // The card owns Escape: it must never reach the composer, where Escape means Stop.
      event.preventDefault(); event.stopPropagation();
      if (!state.armed || state.sending) return;
      if (inField && target.value.trim()) { setAskHot(state, state.hot[state.index]); return; }
      askDismiss(state);
      return;
    }
    if (target === state.el) {
      if (key === "Tab" && !event.shiftKey) { event.preventDefault(); focusAskCard(); }
      return;                                   // keys typed at the card itself are not choices
    }
    if (event.repeat && (key === "Enter" || key === " ") && !(target.classList?.contains("ask-field") && event.shiftKey)) {
      event.preventDefault();
      return;
    }
    if (state.sending || state.busy) {
      if (["Enter", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(key) || /^[1-9]$/.test(key)) event.preventDefault();
      return;
    }
    const q = state.questions[state.index];
    const count = q.options.length;
    if (inField) {
      if (key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!state.armed || state.entering || event.repeat) return;
        // Enter does what the pill says when it is Next or Continue; skipping stays explicit.
        if (target.value.trim() || askPicked(q, state.answers[state.index]).length) askAction(state);
        return;
      }
      if (key === "ArrowUp") {
        const before = target.value.slice(0, target.selectionStart ?? 0);
        if (!before.includes("\n")) { event.preventDefault(); setAskHot(state, count - 1); }
      }
      return;
    }
    if (key === "ArrowDown" && onRow) {
      event.preventDefault();
      const k = state.hot[state.index];
      if (k >= count - 1) state.el.querySelector(".ask-field")?.focus(); else setAskHot(state, k + 1);
    } else if (key === "ArrowUp" && onRow) {
      event.preventDefault(); setAskHot(state, state.hot[state.index] - 1);
    } else if (key === "Home" && onRow) {
      event.preventDefault(); setAskHot(state, 0);
    } else if (key === "End" && onRow) {
      event.preventDefault(); setAskHot(state, count - 1);
    } else if ((key === "ArrowLeft" || key === "ArrowRight") && !event.altKey) {
      event.preventDefault(); askPage(state, key === "ArrowLeft" ? -1 : 1);
    } else if (/^[1-9]$/.test(key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (!state.armed || state.entering || event.repeat) return;
      const k = Number(key) - 1;
      if (k < count) { setAskHot(state, k); askChoose(state, k); }
    } else if ((key === "Enter" || key === " ") && onRow) {
      event.preventDefault();
      if (!state.armed || state.entering || event.repeat) return;
      if (key === "Enter" && (event.ctrlKey || event.metaKey)) {
        if (askPicked(q, state.answers[state.index]).length || state.answers[state.index].other.trim()) askAction(state);
        return;
      }
      askChoose(state, Number(target.dataset.i));
    }
  }

  function askChoose(state, k) {
    if (state !== ask || state.retired || state.sending || state.busy) return;
    const i = state.index, q = state.questions[i], answer = state.answers[i];
    if (!(k >= 0 && k < q.options.length)) return;
    setAskHot(state, k, false);
    if (q.multi_select) {
      answer.selected = answer.selected.includes(k) ? answer.selected.filter((x) => x !== k) : [...answer.selected, k].sort((a, b) => a - b);
      answer.settled = false;
      paintAskChecks(state);
      paintAskAction(state);
      return;
    }
    answer.selected = [k]; answer.other = "";
    const field = state.el.querySelector(".ask-field"); if (field) { field.value = ""; growAskField(field); }
    paintAskChecks(state);
    paintAskAction(state);
    askRows(state).forEach((row, x) => row.classList.toggle("picked", x === k));
    const more = state.answers.some((a, x) => x !== i && !a.settled);
    state.busy = true;
    setTimeout(() => {
      if (state !== ask || state.retired) return;
      state.busy = false;
      askSettle(state);
    }, more ? ASK_STEP_MS : ASK_CHOSEN_MS);
  }

  // The pill settles the question with what it shows: the pick (the preselected recommendation
  // included), the written words, or nothing (a skip) when it reads Skip.
  function askAction(state) {
    if (state !== ask || state.retired || state.sending || state.busy) return;
    const i = state.index, q = state.questions[i], answer = state.answers[i];
    const field = state.el.querySelector(".ask-field");
    answer.other = (field ? field.value : answer.other).slice(0, ASK_MAX_TEXT);
    const submit = askPill(state) === "submit";
    answer.selected = [...askPicked(q, answer)];
    if (!answer.other.trim()) answer.other = "";
    askSettle(state, submit);
  }
  // Skip clears this question's pick and words and settles it as skipped.
  function askSkip(state) {
    if (state !== ask || state.retired || state.sending || state.busy) return;
    const answer = state.answers[state.index];
    answer.selected = []; answer.other = "";
    const field = state.el.querySelector(".ask-field"); if (field) field.value = "";
    askSettle(state);
  }

  // One question is answered or skipped: go to the next unsettled question (after this one, wrapping),
  // never skipping one on the reader's behalf. With nothing left, a single question sends; a card of
  // several stays where it is with Submit focused, and only Submit sends.
  function askSettle(state, submit = false) {
    const i = state.index;
    state.answers[i].settled = true;
    const open = state.answers.map((a, k) => (a.settled ? -1 : k)).filter((k) => k >= 0);
    if (!open.length && (submit || state.questions.length === 1)) { askPost(state, { answers: Object.fromEntries(state.questions.map((q, k) => [q.id, {
      selected: [...askPicked(q, state.answers[k])], other: state.answers[k].other.trim() }])) }); return; }
    if (!open.length) {
      askRows(state).forEach((row) => row.classList.remove("picked"));
      paintAskAction(state);
      askStepGuard(state);
      state.el.querySelector(".ask-act")?.focus({ preventScroll: true });
      speak(`All ${state.questions.length} questions answered. Press Submit to send them.`);
      return;
    }
    state.index = open.find((k) => k > i) ?? open[0];
    renderAskCard(state, true);
    askStepGuard(state);
    speak(`Question ${state.index + 1} of ${state.questions.length}: ${state.questions[state.index].question}`);
    focusAskCard();
  }

  function askPage(state, step) {
    if (state !== ask || state.retired || state.sending) return;
    const next = state.index + step;
    if (next < 0 || next >= state.questions.length) return;
    state.index = next;
    renderAskCard(state, true);
    focusAskCard();
  }

  function askDismiss(state) {
    if (state !== ask || state.retired || state.sending) return;
    askPost(state, { dismissed: true });
  }

  function askPost(state, payload) {
    state.sending = true;
    // Disabling the focused control would drop focus to the page: the card holds it instead, so
    // the composer gets it back when the card closes.
    if (state.el.contains(document.activeElement) && document.activeElement !== state.el) state.el.focus({ preventScroll: true });
    state.el.classList.add("sending");
    state.el.setAttribute("aria-busy", "true");
    state.el.querySelectorAll("button, textarea").forEach((control) => { control.disabled = true; });
    speak(payload.dismissed ? "Closing the question" : "Sending your answers");
    const error = state.el.querySelector(".ask-error");
    if (error) { error.hidden = true; state.el.removeAttribute("aria-describedby"); }
    let sending = state.el.querySelector(".ask-sending");
    if (!sending) { sending = el("div", "ask-sending", "Sending…"); sending.setAttribute("aria-hidden", "true"); state.el.appendChild(sending); }
    vscode.postMessage({ type: "options_response", id: state.ev.id, ...payload });
  }

  function askRejected(ev) {
    if (!ask || String(ev.request_id || "") !== String(ask.ev.id)) return false;
    const state = ask;
    state.sending = false;
    state.el.classList.remove("sending");
    state.el.removeAttribute("aria-busy");
    state.el.querySelector(".ask-sending")?.remove();
    // The answers stay settled, so Submit resends them; any question can still be changed first.
    renderAskCard(state);
    const error = state.el.querySelector(".ask-error");
    const message = ev.message || "DGC could not use that answer. Try again.";
    error.textContent = message;
    error.hidden = false;
    state.el.setAttribute("aria-describedby", error.id);
    speak(message);
    fitAskCard();
    focusAskCard();
    return true;
  }

  function retireAsk(reason) {
    const state = ask;
    if (!state) return;
    state.retired = true;
    state.el.classList.add("expired");
    state.el.querySelectorAll("button, textarea").forEach((control) => { control.disabled = true; });
    const focusWasInside = state.el.contains(document.activeElement) || document.activeElement === state.el;
    state.el.remove();
    ask = null;
    const cbox = $("cbox"), textBox = cbox.querySelector(".cinput");
    cbox.classList.remove("asking");
    if (textBox) textBox.hidden = !!state.hid?.textBox;
    atts.hidden = !!state.hid?.atts;
    document.body.classList.remove("ask-docked");
    const card = askToolCard(state.ev.call_id);
    if (card && !card._asked) {
      const arg = card.querySelector(".arg");
      if (arg) arg.textContent = askCountLabel(state.questions.length);
    }
    renderTurnMeta();
    renderComposerControls();
    if (reason !== "replaced" && (focusWasInside || state.restoreFocus)) input.focus({ preventScroll: true });
    if (reason !== "replaced") pipSetupCards?.dockFree();
  }
  function undockAskCard(reason) { if (ask) retireAsk(reason || "closed"); }
  function askOnSessionReset(kind) { undockAskCard("session"); }
  function askOnBackendExit(msg) { undockAskCard("backend_exit"); }
  function askExpired(ev) { if (ask && String(ev.id) === String(ask.ev.id)) undockAskCard("expired"); }

  // The fit rule: the transcript keeps max(96px, 20vh) above the composer and the composer footer
  // (Stop, mode, model) never leaves the panel, whatever the question and descriptions weigh. The
  // options list gives up height first while a whole option still shows, then the question (CSS
  // already caps it at six lines or 22vh; down to two), then the list down to one label line, and as
  // a last resort the whole card scrolls.
  function fitAskCard() {
    if (!askCardDocked()) return;
    const card = ask.el, list = card.querySelector(".ask-opts"), question = card.querySelector(".ask-q");
    if (!list) return;
    list.style.maxHeight = "";
    if (question) question.style.maxHeight = "";
    card.style.maxHeight = "";
    card.classList.remove("ask-squeezed");
    const footer = $("cfooter");
    const floor = Math.max(96, window.innerHeight * 0.2);
    // Pixels still owed: the footer's overflow below the panel, plus what the transcript lacks.
    const owed = () => Math.max(0, (footer ? footer.getBoundingClientRect().bottom : 0) - window.innerHeight)
      + Math.max(0, floor - log.getBoundingClientRect().height);
    // Shrinking one box does not always hand the transcript every pixel (the page may be overflowing),
    // so measure again until it holds or the box is at its minimum.
    const shrink = (node, minimum) => {
      for (let pass = 0; pass < 4; pass += 1) {
        const want = owed();
        if (want <= 0.5) return true;
        const current = node.getBoundingClientRect().height;
        const next = Math.max(Math.min(current, minimum), Math.floor(current - want));
        if (next >= current) break;
        node.style.maxHeight = `${next}px`;
      }
      return owed() <= 0.5;
    };
    const row = list.querySelector(".ask-opt.hot") || list.querySelector(".ask-opt");
    const oneRow = row ? Math.max(ASK_LIST_MIN, row.getBoundingClientRect().height) : ASK_LIST_MIN;
    if (log.getBoundingClientRect().height && !shrink(list, oneRow) && !(question && shrink(question, ASK_QUESTION_MIN))
        && !shrink(list, ASK_LIST_MIN)) {
      card.classList.add("ask-squeezed");
      shrink(card, 0);
    }
    // A question cut to fit scrolls, so a keyboard can reach its end.
    if (question) {
      if (question.scrollHeight > question.clientHeight + 1) question.tabIndex = 0;
      else question.removeAttribute("tabindex");
    }
  }
  window.addEventListener("resize", () => {
    if (!askCardDocked()) return;
    const field = ask.el.querySelector(".ask-field");
    if (field) { askPlaceholder(field); growAskField(field); }
    fitAskCard();
  });
  // Fonts, rails and wrapped text settle after the card mounts; fit again once they have.
  if (typeof ResizeObserver === "function") {
    let fitting = false;
    new ResizeObserver(() => {
      if (fitting || !askCardDocked()) return;
      fitting = true;
      try { fitAskCard(); } finally { requestAnimationFrame(() => { fitting = false; }); }
    }).observe(log);
  }

  // ---- the answered state, inside the step's tool card ----
  // As Claude Code keeps it (founder, 2026-10-17): "Questions · Answered · 4 questions", open, with every
  // question and every option still there, the ones picked marked (a filled circle for one choice, a ticked
  // box for several) and the rest quieter, so the transcript says what was asked as well as what was chosen.
  function askedSummary(ev) {
    const qs = Array.isArray(ev.questions) ? ev.questions : [];
    const n = askCountLabel(qs.length);
    if (ev.outcome === "dismissed") return `· Dismissed · ${n}`;
    if (ev.outcome !== "answered") return `· Not answered · ${n}`;
    return `· Answered · ${n}`;
  }
  // The card's head says what it holds once it is answered (setToolStatus writes "Asked" over it otherwise).
  function askedHead(card) {
    const verb = card.querySelector(".verb");
    const count = Array.isArray(card._asked?.questions) ? card._asked.questions.length : 0;
    if (verb) verb.textContent = count === 1 ? "Question" : "Questions";
  }
  function askedOption(option, picked, multi, extra = "") {
    const desc = option.words ?? askDesc(option);
    return `<li class="asked-opt${picked ? " picked" : ""}${extra}"><span class="asked-mark ${multi ? "check" : "radio"}" aria-hidden="true"></span>`
      + `<span class="asked-opt-text"><span class="sr-only">${picked ? "Chosen: " : "Not chosen: "}</span>`
      + `<span class="asked-opt-label">${esc(option.words !== undefined ? option.label : askLabel(option))}</span>`
      + `${option.words === undefined && askFlagged(option) ? '<span class="ask-badge">Recommended</span>' : ""}`
      + `${desc ? `<span class="asked-opt-desc">${esc(desc)}</span>` : ""}</span></li>`;
  }
  function askedBody(ev) {
    const qs = Array.isArray(ev.questions) ? ev.questions : [];
    if (ev.outcome === "dismissed") return '<p class="asked-outcome">Dismissed without an answer</p>';
    if (ev.outcome === "unavailable") return '<p class="asked-outcome">Not answered: nobody could answer here</p>';
    if (ev.outcome !== "answered") return '<p class="asked-outcome">Not answered: the turn stopped</p>';
    return `<div class="asked-panel">${qs.map((q) => {
      const a = (ev.answers || {})[q.id] || {};
      const options = Array.isArray(q.options) ? q.options : [];
      const multi = !!q.multi_select;
      const words = String(a.other || "").trim();
      const selected = Array.isArray(a.selected) ? a.selected : [];
      // In a single choice, written words replace the pick (askPicked): only one row is marked.
      const picked = new Set(multi ? selected : words ? [] : selected.slice(0, 1));
      const rows = options.map((o, k) => askedOption(o, picked.has(k), multi)).join("");
      const said = words ? askedOption({ label: "Your words", words: `“${words}”` }, true, multi, " asked-words") : "";
      const skipped = !picked.size && !words ? '<p class="asked-skipped">Skipped</p>' : "";
      return `<section class="asked-question"><div class="asked-q">${esc(q.question)}</div>`
        + `<ul class="asked-options">${rows}${said}</ul>${skipped}</section>`;
    }).join("")}</div>`;
  }
  // ---- an open question ------------------------------------------------------------------------
  // The turn did not stop for this, so the card lives in the transcript rather than docking over
  // the composer the way the picker does. Pending decisions remain visible until the reader
  // answers, skips, or explicitly collapses the question.
  const openAsks = new Map();

  function sendOpenAsk(ask) {
    const text = String(ask.input.value || "").trim();
    if (!text) { ask.input.focus(); return; }
    const requestId = `ask-${ask.id}`;
    // Draw the answer as a message of yours and register it, exactly as the composer does. The
    // card is removed the moment the backend confirms the answer, and nothing used to take its
    // place: the only trace of what you said was the agent's own "steering:" line, which echoes
    // the QUESTION, clipped at 80 characters, and never shows the answer at all. Registering it
    // is what lets steering_update mark it "steered -- the model has read this", and what lets a
    // refused answer (command_rejected -> rejectPrompt) come back instead of sitting there.
    const m = el("div", "msg user"); m.appendChild(el("div", "role", "you"));
    const bubble = el("div", "bubble");
    // The question goes in the bubble because the card that asked it is about to disappear.
    bubble.appendChild(el("p", "answered-q", esc(ask.question)));
    bubble.appendChild(promptText(text));
    m.appendChild(bubble); log.appendChild(m); settleBlock(m);
    m.dataset.promptId = requestId;
    pendingPrompts.set(requestId, { text, attachments: [], node: m, session: draftSession });
    vscode.postMessage({ type: "prompt", text, requestId,
                         answers: [{ ask_id: ask.id, question: ask.question }] });
    ask.row.dataset.state = "sent";
    ask.input.disabled = true;
    scroll();
  }

  // Put a card back in play after the backend refused its answer.
  function reopenOpenAsk(askId, message) {
    const ask = openAsks.get(String(askId || ""));
    if (!ask) return;
    ask.row.dataset.state = "open";
    ask.input.disabled = false;
    ask.input.focus();
    const said = String(message || "").trim();
    let why = ask.row.querySelector(".open-ask-why");
    if (!why) {
      why = el("p", "open-ask-why");
      ask.row.querySelector(".open-ask-body")?.appendChild(why);
    }
    why.textContent = said || "That answer was not accepted. Try again.";
  }

  function skipOpenAsk(ask) {
    vscode.postMessage({ type: "askSkip", askId: ask.id });
    ask.row.dataset.state = "sent";
  }

  function foldAsk(ask) {
    if (ask.row.dataset.state !== "open") return;
    ask.row.dataset.state = "folded";
  }

  function unfoldAsk(ask) {
    ask.row.dataset.state = "open";
    ask.input.focus();
  }

  function renderOpenAsk(ev) {
    const id = String(ev.ask_id || "");
    if (!id || openAsks.has(id)) return;
    ensureTurn();
    const row = el("div", "open-ask");
    row.dataset.state = "open";
    row.dataset.askId = id;

    // Only the reader folds an unanswered question. Keep its choices discoverable
    // when deliberately collapsed; elapsed time must never hide a pending decision.
    const optionCount = Array.isArray(ev.options) ? ev.options.length : 0;
    const foldedLabel = optionCount
      ? `Answer question \u00b7 ${optionCount} option${optionCount === 1 ? "" : "s"}`
      : "Answer question";
    const folded = el("button", "open-ask-folded", `${icon("circle-help")}<span>${esc(foldedLabel)}</span>`);
    folded.type = "button";
    folded.title = String(ev.question || "");

    const body = el("div", "open-ask-body");
    body.appendChild(el("p", "open-ask-q", esc(String(ev.question || ""))));
    if (ev.context) body.appendChild(el("p", "open-ask-context", esc(String(ev.context))));

    const input = el("input", "open-ask-input");
    input.type = "text";
    input.placeholder = "Answer, or skip";
    input.setAttribute("aria-label", String(ev.question || "Answer the question"));

    const ask = { id, question: String(ev.question || ""), row, input };

    const chips = el("div", "open-ask-chips");
    for (const suggestion of (Array.isArray(ev.suggestions) ? ev.suggestions : []).slice(0, 4)) {
      const chip = el("button", "open-ask-chip", esc(String(suggestion)));
      chip.type = "button";
      chip.onclick = () => { input.value = String(suggestion); sendOpenAsk(ask); };
      chips.appendChild(chip);
    }
    if (chips.children.length) body.appendChild(chips);

    // Options, when the model could name them. The rows reuse the blocking picker's markup so the
    // two read alike, but NOT its placement: this card stays in the transcript and must never
    // dock into the composer, because the docking is what makes the picker modal and the whole
    // point here is that the turn did not stop. Picking a row answers the question the same way
    // typing does -- one tagged prompt -- so nothing new crosses the wire.
    const options = Array.isArray(ev.options) ? ev.options.slice(0, 6) : [];
    if (options.length) {
      const list = el("div", "open-ask-options");
      list.setAttribute("role", "group");
      list.setAttribute("aria-label", "Suggested answers");
      options.forEach((option, index) => {
        const label = String(option && option.label || "").trim();
        if (!label) return;
        const row2 = el("button", "oask-opt" + (option.recommended ? " recommended" : ""));
        row2.type = "button";
        row2.dataset.index = String(index);
        // The label and its "Recommended" badge are ONE flex item, so wrapping can never separate
        // them: as separate items the badge was pushed onto a line of its own whenever the label
        // filled the row -- measured at a 320px panel it landed on line two with the description
        // starting beside it. They are inline within the head, so they wrap together as words. The
        // description stays its own item and takes a full line when it cannot sit beside them.
        row2.innerHTML = `<span class="oask-head"><span class="oask-label">${esc(label)}</span>`
          + (option.recommended ? `<span class="oask-mark">Recommended</span>` : "") + "</span>"
          + (option.description ? `<span class="oask-desc">${esc(String(option.description))}</span>` : "");
        row2.onclick = () => { input.value = label; sendOpenAsk(ask); };
        list.appendChild(row2);
      });
      if (list.children.length) body.appendChild(list);
    }
    body.appendChild(input);

    const actions = el("div", "open-ask-actions");
    const send = el("button", "open-ask-send", "Send");
    send.type = "button"; send.onclick = () => sendOpenAsk(ask);
    const skip = el("button", "open-ask-skip", "Skip");
    skip.type = "button"; skip.onclick = () => skipOpenAsk(ask);
    const collapse = el("button", "open-ask-collapse", "Collapse");
    collapse.type = "button"; collapse.setAttribute("aria-label", "Collapse question");
    collapse.onclick = () => { foldAsk(ask); folded.focus(); };
    actions.append(collapse, skip, send);
    body.appendChild(actions);

    input.onkeydown = (event) => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendOpenAsk(ask); }
      if (event.key === "Escape") { event.preventDefault(); foldAsk(ask); }
    };
    folded.onclick = () => unfoldAsk(ask);

    row.append(folded, body);
    openAsks.set(id, ask);
    turn.block.appendChild(row);
    scroll();
  }

  function settleOpenAsk(ev) {
    const ask = openAsks.get(String(ev.ask_id || ""));
    if (!ask) return;
    openAsks.delete(ask.id);
    // An answered question already shows as the user's own bubble, quoted, so the card goes. The
    // other outcomes leave one quiet line: a question that was asked and not answered is part of
    // what happened, and deleting it would lose that.
    if (ev.outcome === "answered") {
      ask.row.remove();
      // Settle the bubble the answer left behind. ask_resolved is the ONLY event the backend
      // sends for an answer -- resolve_open_ask steers it and returns early, so it never enters
      // the steering bookkeeping and no steering_update ever arrives for this id. The event is
      // emitted only after the steer was accepted into the running turn, so by the time it gets
      // here the model has the answer; placing the bubble now puts it where it was actually said,
      // instead of leaving it stranded under the finished reply.
      const pending = pendingPrompts.get(`ask-${ask.id}`);
      if (pending?.node) {
        pending.node.querySelector(".role").textContent = "you · steering";
        setSteerState(pending.node, "applied");
        if (turn) placeSteering(pending.node);
      }
      pendingPrompts.delete(`ask-${ask.id}`);
      return;
    }
    // A half-typed answer is the user's work, and the card is about to be replaced by a one-line
    // "Not answered" -- so whatever is in its box would go with it, along with the question it was
    // answering. Hand it back to the composer instead, on its own line under whatever is already
    // there, ready to send. This is what Codex does (take_question_drafts, recovered on a turn
    // that completes, is interrupted OR fails), and the reason is the same: the question was ours
    // to ask, the typing was theirs.
    //
    // Not on "skipped": that is the user deciding not to answer, and putting their abandoned words
    // back in the box would undo the dismissal they just made.
    const orphaned = ev.outcome === "skipped" ? "" : String(ask.input?.value || "").trim();
    if (orphaned) {
      const at = composerText();
      editComposer(at.length, at.length, (at && !at.endsWith("\n") ? "\n" : "") + orphaned);
      autosizeComposer();
      persistDraft();
    }
    ask.row.dataset.state = "settled";
    ask.row.dataset.outcome = String(ev.outcome || "");
    const said = ev.outcome === "skipped" ? "Skipped" : ev.outcome === "expired" ? "Not answered"
      : "Could not be asked";
    // The question and its options STAY. Emptying the row was what made the choices unrecoverable:
    // a reply that ends "the options are in the picker above" points at one line of text reading
    // "Not answered", and the three descriptions the user was deciding between are gone from the
    // session for good. The row is inert from here (main.css makes a settled body
    // pointer-events: none), but it is still the record of what was offered.
    ask.row.querySelectorAll(".open-ask-folded").forEach((node) => node.remove());
    ask.row.insertBefore(el("span", "open-ask-settled", `${said}: ${esc(ask.question)}`),
                         ask.row.firstChild);
  }

  function renderAsked(ev) {
    let card = askToolCard(ev.call_id);
    if (!card) {
      // A text-protocol step has no tool card of its own (its call id is null on replay).
      card = toolCard({ name: "propose_options", call_id: ev.call_id || "" });
      if (ev.call_id) { turn._tools = turn._tools || Object.create(null); turn._tools[ev.call_id] = card; }
      card.querySelector(".dot").className = "dot ok";
      setToolStatus(card, "completed");
    }
    if (ask && (String(ev.id ?? "") === String(ask.ev.id) || (ev.call_id && ev.call_id === ask.ev.call_id))) undockAskCard("resolved");
    card._asked = ev;
    card.classList.add("asked-card");
    card.dataset.outcome = String(ev.outcome || "");
    const body = card.querySelector(".body");
    body.innerHTML = askedBody(ev);
    card.classList.add("has-output");
    const badge = card.querySelector(".badge"); if (badge) badge.textContent = "";
    const arg = card.querySelector(".arg"); if (arg) arg.textContent = askedSummary(ev);
    askedHead(card);
    // Remembered per turn and call: call ids repeat across turns (call_0 style), and a text-protocol
    // step has none, so those count within their turn. Replayed turn ids are stable across reloads.
    if (!card._askedKey) {
      const where = turn ? turn.id : "";
      const which = ev.call_id || `#${turn ? (turn._askedN = (turn._askedN || 0) + 1) : 0}`;
      card._askedKey = `${where}|${which}`;
    }
    const key = card._askedKey;
    const toggle = card.querySelector(".tool-toggle");
    const open = !askedClosed.has(key);       // open, as Claude Code shows it, unless the reader closed it
    card.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
    if (!card._askedToggle) {
      card._askedToggle = true;
      toggle.addEventListener("click", () => { if (card.classList.contains("open")) askedClosed.delete(key); else askedClosed.add(key); });
    }
  }
  // A tool_result for a step whose questions are already rendered keeps the structured body.
  function askedResultShown(card, ev) {
    if (!card._asked || ev.is_error) return false;
    setToolStatus(card, "completed");
    askedHead(card);
    return true;
  }
  // ---- end 0.40 options ---------------------------------------------------------------------------


  // ---- 0.40 thinking ------------------------------------------------------------------------------
  // Every reasoning block names where it came from: raw | summarized | narration | withheld | unknown.
  // State is a Map from the backend's block id to its entry -- never a selector or HTML built from an
  // id. A contiguous run with the same (source, provider, agent) is one collapsed group; a short
  // provider summary the backend placed inline becomes a muted .thought-note; a withheld block is a
  // static row. Live and replay drive the same code, so a reload draws what the live turn drew.
  function reasonProviderName(provider) {
    return provider === "anthropic" ? "Anthropic" : provider === "openai" ? "OpenAI" : "";
  }
  function reasonIdentity(ev) {
    const sources = ["raw", "summarized", "narration", "withheld", "unknown"];
    const source = sources.includes(ev?.source) ? ev.source : "unknown";
    const name = reasonProviderName(ev?.provider);
    const provider = name && ["summarized", "narration", "withheld"].includes(source) ? ev.provider : "";
    return { source: ["summarized", "narration", "withheld"].includes(source) && !provider ? "unknown" : source,
             provider, agent: typeof ev?.agent === "string" ? ev.agent.slice(0, 128) : "" };
  }
  function reasonInlineAllowed() { return lastConfig?.thinking_inline !== false; }
  // `agent` set: the block came from a sub-agent, whose model and host can differ from this chat's.
  function reasonTitle(source, provider, agent) {
    const name = reasonProviderName(provider) || "The provider";
    const model = agent ? "a sub-agent’s model" : "the model";
    if (source === "raw") return `Raw reasoning from ${model}, as it streamed.`;
    if (source === "summarized") return `${name} returned a summary of ${agent ? "a sub-agent’s" : "the model’s"} reasoning; the full reasoning is not available.`;
    if (source === "narration") return `A progress note from ${name} about what ${model} is doing.`;
    if (source === "withheld") return `${name} kept ${agent ? "a sub-agent’s" : "the model’s"} reasoning hidden; no readable text was sent.`;
    return `DGC can’t tell whether this is ${agent ? "a sub-agent’s" : "the model’s"} own reasoning or a provider’s summary.`;
  }
  // "Sub-agent · " before the label of a block a sub-agent produced. The dot is decorative; screen
  // readers hear "Sub-agent, Thought for 2s, raw".
  function reasonAgentPrefix(agent) {
    if (!agent) return null;
    const prefix = el("span", "thought-agent");
    const dot = el("span"); dot.setAttribute("aria-hidden", "true"); dot.textContent = " ·";
    const pause = el("span", "sr-only"); pause.textContent = ",";
    prefix.append(document.createTextNode(" Sub-agent"), dot, pause);
    return prefix;
  }
  // Under half a second rounds to nothing worth a number: "Thought", never "Thought for 0s".
  function reasonDuration(seconds) {
    return Number.isFinite(seconds) && seconds >= 0.5 ? `Thought for ${Math.round(seconds)}s` : "Thought";
  }
  // The muted suffix: " · raw", " · summarized by Anthropic", " · hidden by OpenAI"; nothing for
  // unknown. The middle dot is decorative; an sr-only comma gives screen readers the pause.
  function reasonProvenance(source, provider) {
    const word = source === "raw" ? "raw" : source === "withheld" ? "hidden"
      : source === "summarized" || source === "narration" ? "summarized" : "";
    if (!word) return null;
    const prov = el("span", "thought-prov");
    const dot = el("span"); dot.setAttribute("aria-hidden", "true"); dot.textContent = " · ";
    const pause = el("span", "sr-only"); pause.textContent = ", ";
    prov.append(dot, pause, document.createTextNode(word));
    const name = reasonProviderName(provider);
    if (name && word !== "raw") { const by = el("span", "thought-by"); by.textContent = ` by ${name}`; prov.appendChild(by); }
    return prov;
  }
  // "Thinking…" while it streams, "Thought for Ns" from the backend's seconds once every block in
  // the group ended, "Thought" when a replayed block kept no timing, and the panel's own clock only
  // for the moment between a group closing and its (pending) end arriving.
  function reasonLabel(group) {
    if (group.open && (!group.parts.length || !group.parts.every((part) => part.ended))) return "Thinking…";
    if (group.parts.length && group.parts.every((part) => part.ended)) {
      if (!group.parts.every((part) => Number.isFinite(part.seconds))) return "Thought";
      return reasonDuration(group.parts.reduce((sum, part) => sum + part.seconds, 0));
    }
    if (group.startedAt == null) return "Thought";
    return reasonDuration((Date.now() - group.startedAt) / 1000);
  }
  function paintReasonGroup(group) {
    if (!group?.button) return;
    const label = group.button.querySelector(".thought-label");
    const words = reasonLabel(group);
    if (group.button.classList.contains("thought-mark")) paintMarkLabel(label, markWords(words));
    else if (label) label.textContent = ` ${words}`;
    // The seconds a finished block stated, for its stretch's line ("· thought 13s"); "" for none kept.
    const ended = group.parts.length && group.parts.every((part) => part.ended);
    if (!ended) delete group.button.dataset.seconds;
    else group.button.dataset.seconds = group.parts.every((part) => Number.isFinite(part.seconds))
      ? String(group.parts.reduce((sum, part) => sum + part.seconds, 0)) : "";
    const host = group.button.closest(".tool-group");
    if (host) refreshToolGroup(host);
  }
  function makeReasonGroup(identity) {
    const button = el("button", "disclosure"), body = el("div", "reasoning");
    const id = `reasoning-${++disclosureId}`;
    button.type = "button"; button.setAttribute("aria-expanded", "false"); button.setAttribute("aria-controls", id);
    body.id = id;
    button.dataset.source = identity.source; body.dataset.source = identity.source;
    if (identity.agent) {
      button.dataset.agent = identity.agent; body.dataset.agent = identity.agent;
      button.dataset.agentId = identity.agent; body.dataset.agentId = identity.agent;
      button.classList.add("agent-owned"); body.classList.add("agent-owned");
    }
    button.title = reasonTitle(identity.source, identity.provider, identity.agent);
    const chev = el("span", "thought-chev"); chev.setAttribute("aria-hidden", "true"); chev.textContent = "▸";
    const label = el("span", "thought-label");
    button.appendChild(chev);
    const agentPrefix = reasonAgentPrefix(identity.agent);
    if (agentPrefix) button.appendChild(agentPrefix);
    button.appendChild(label);
    const prov = reasonProvenance(identity.source, identity.provider);
    if (prov) button.appendChild(prov);
    button.onclick = () => {
      const open = body.classList.toggle("show");
      chev.textContent = open ? "▾" : "▸";
      button.setAttribute("aria-expanded", String(open));
    };
    const group = { button, body, parts: [], open: true, ...identity,
                    startedAt: replaying ? null : Date.now() };
    button._reason = group;
    return group;
  }
  // The main model's collapsed thinking belongs to the stretch of work it is in: inside the open group
  // while the stretch works (its live row says "Thinking…"), at turn level before the stretch's first
  // step. The next step of its own wears it as a mark (pendingThoughts); prose after it leaves it as the
  // group's last row, counted on the line. Decision D7 -- every thought ended the tool group, so a
  // tool card after it opened a new group below -- now holds only for a sub-agent's thinking.
  function openReasonGroup(identity) {
    finishReasoning();
    if (identity.agent) endToolGroup();
    const stretch = identity.agent ? null : turn.toolGroup;
    const group = makeReasonGroup(identity);
    if (stretch) stretch.append(group.button, group.body);
    else { appendTurnContent(group.button); appendTurnContent(group.body); }
    turn.reasonGroup = group;
    paintReasonGroup(group);
    return group;
  }
  function addReasonPart(group, entry, text) {
    const part = el("span", "thought-part");
    entry.sep = group.parts.length ? document.createTextNode("\n\n") : null;
    if (entry.sep) part.appendChild(entry.sep);
    entry.text = document.createTextNode(String(text || ""));
    part.appendChild(entry.text);
    entry.part = part; entry.group = group; entry.kind = "group";
    group.body.appendChild(part);
    group.parts.push(entry);
  }
  function reasoningDelta(ev) {
    const blocks = turn.reasonBlocks || (turn.reasonBlocks = new Map());
    const id = String(ev.block || "");
    const identity = reasonIdentity(ev);
    const text = String(ev.text || "");
    let entry = id ? blocks.get(id) : null;
    if (entry && !entry.ended) {
      if (entry.kind === "note") { entry.text.appendData(text); return; }
      // A block still streaming stays in its own row, whatever arrived in between (a sub-agent's
      // thought or step): it is one thought, never a new row per chunk.
      if (entry.kind === "group" && entry.group?.body?.isConnected) {
        entry.text.appendData(text);
        if (!turn.reasonGroup && !entry.agent) { turn.reasonGroup = entry.group; entry.group.open = true; paintReasonGroup(entry.group); }
        return;
      }
    }
    if (identity.source === "withheld") return;             // a withheld block never streams text
    const open0 = turn.reasonGroup;
    if (!id && open0?.parts.length && open0.source === identity.source && open0.provider === identity.provider
        && open0.agent === identity.agent) {
      open0.parts.at(-1).text.appendData(text);             // a frame from a backend with no block ids
      return;
    }
    entry = { id, ended: false, seconds: undefined, ...identity };
    if (id) blocks.set(id, entry);
    if (identity.source === "narration" && !identity.agent && reasonInlineAllowed()) {
      // A progress note is shown the moment it starts, as plain text until it ends.
      finishReasoning();
      endToolGroup();
      const note = el("div", "thought-note"); note.dataset.source = identity.source;
      entry.text = document.createTextNode(text);
      note.appendChild(entry.text);
      entry.note = note; entry.kind = "note";
      appendTurnContent(note);
      turn.reasonNote = note;
      return;
    }
    const open = turn.reasonGroup;
    const group = open && open.source === identity.source && open.provider === identity.provider
      && open.agent === identity.agent ? open : openReasonGroup(identity);
    addReasonPart(group, entry, text);
  }
  function reasonNoteFrom(entry, text) {
    const note = el("div", "thought-note"); note.dataset.source = entry.source;
    note.innerHTML = md(String(text || "").trim());
    const name = reasonProviderName(entry.provider);
    const hint = el("span", "thought-hint");
    hint.dataset.tip = entry.source === "narration" ? `Progress note from ${name}` : `Summary from ${name}`;
    hint.appendChild(document.createTextNode(" · summarized"));
    if (name) { const by = el("span", "sr-only"); by.textContent = ` by ${name}`; hint.appendChild(by); }
    note.appendChild(hint);
    return note;
  }
  function removeReasonGroup(group) {
    group.button.remove(); group.body.remove();
    if (turn.reasonGroup === group) turn.reasonGroup = null;
  }
  // Move one block out of its group into an inline note at the block's own position: parts before it
  // stay in the group, parts after it move to a new group after the note.
  function reasonGroupToNote(entry) {
    const group = entry.group;
    const hadFocus = document.activeElement === group.button;   // before any move, which drops focus
    // A note is prose the reader sees, so it never folds into a stretch's line: a block drawn inside
    // the open group leaves it at turn level first (a mark, after the group it was in).
    const host = group.button.closest(".tool-group");
    if (host) {
      if (host === turn.toolGroup && !group.button.closest(".tool")) { appendTurnContent(group.button); appendTurnContent(group.body); }
      else (host.nextElementSibling?.classList.contains("tg-live") ? host.nextElementSibling : host).after(group.button, group.body);
      group.button.classList.remove("thought-mark");
      paintReasonGroup(group);
      refreshToolGroup(host);
    }
    const index = group.parts.indexOf(entry);
    const before = group.parts.slice(0, index), after = group.parts.slice(index + 1);
    const note = reasonNoteFrom(entry, entry.text.data);
    entry.part.remove();
    if (!before.length) {
      group.button.before(note);
      group.parts = after;
      if (!after.length) removeReasonGroup(group);
      else { const first = after[0]; if (first.sep) { first.sep.remove(); first.sep = null; } paintReasonGroup(group); }
    } else {
      group.body.after(note);
      group.parts = before;
      paintReasonGroup(group);
      if (after.length) {
        const rest = makeReasonGroup({ source: group.source, provider: group.provider, agent: group.agent });
        rest.open = group.open; rest.startedAt = group.startedAt;
        note.after(rest.button); rest.button.after(rest.body);
        for (const moved of after) {
          if (moved.sep && !rest.parts.length) { moved.sep.remove(); moved.sep = null; }
          rest.body.appendChild(moved.part); moved.group = rest; rest.parts.push(moved);
        }
        if (turn.reasonGroup === group) { turn.reasonGroup = rest; group.open = false; }
        paintReasonGroup(group); paintReasonGroup(rest);
      }
    }
    entry.kind = "note"; entry.note = note; entry.group = null;
    endToolGroup();
    if (hadFocus && !replaying) { note.tabIndex = -1; note.focus(); }
  }
  // A progress note that cannot stay inline (over its cap, or inline turned off) becomes a group.
  function reasonNoteToGroup(entry) {
    const identity = { source: entry.source, provider: entry.provider, agent: entry.agent };
    const group = makeReasonGroup(identity);
    group.open = false;
    const text = entry.text.data;
    entry.note.replaceWith(group.button);
    group.button.after(group.body);
    if (turn.reasonNote === entry.note) turn.reasonNote = null;
    addReasonPart(group, entry, text);
    entry.note = null;
    return group;
  }
  function withheldRow(ev, identity) {
    finishReasoning();
    const seconds = Number.isFinite(ev.seconds) ? Math.max(0, ev.seconds) : null;
    // Like a collapsed group (openReasonGroup): the main model's row stays in the open stretch, and
    // only a sub-agent's ends the tool group.
    const stretch = identity.agent ? null : turn.toolGroup;
    const previous = stretch ? stretch.lastElementChild : turn.act?.previousElementSibling;
    if (previous?.classList.contains("thought-static") && previous.dataset.provider === identity.provider
        && (previous.dataset.agent || "") === identity.agent) {
      // Consecutive withheld blocks read as one row.
      const known = previous.dataset.seconds !== "" && seconds != null;
      previous.dataset.seconds = known ? String(Number(previous.dataset.seconds) + seconds) : "";
      previous.querySelector(".thought-label").textContent =
        ` ${known ? reasonDuration(Number(previous.dataset.seconds)) : "Thought"}`;
      if (stretch) refreshToolGroup(stretch);
      if (identity.agent) endToolGroup();
      return;
    }
    const row = el("div", "thought-static"); row.dataset.source = "withheld";
    row.dataset.provider = identity.provider; row.dataset.seconds = seconds == null ? "" : String(seconds);
    if (identity.agent) {
      row.dataset.agent = identity.agent;
      row.dataset.agentId = identity.agent;
      row.classList.add("agent-owned");
    }
    row.title = reasonTitle("withheld", identity.provider, identity.agent);
    // An empty chevron slot, so the label lines up with the disclosure labels around it.
    const slot = el("span", "thought-chev"); slot.setAttribute("aria-hidden", "true");
    row.appendChild(slot);
    const agentPrefix = reasonAgentPrefix(identity.agent);
    if (agentPrefix) row.appendChild(agentPrefix);
    const label = el("span", "thought-label");
    label.textContent = ` ${seconds == null ? "Thought" : reasonDuration(seconds)}`;
    row.appendChild(label);
    const prov = reasonProvenance("withheld", identity.provider);
    if (prov) row.appendChild(prov);
    if (stretch) { stretch.appendChild(row); refreshToolGroup(stretch); }
    else appendTurnContent(row);
    if (identity.agent) endToolGroup();
  }
  function reasoningEnd(ev) {
    const blocks = turn.reasonBlocks || (turn.reasonBlocks = new Map());
    const id = String(ev.block || "");
    const identity = reasonIdentity(ev);
    let entry = id ? blocks.get(id) : null;
    if (!entry && identity.source === "withheld") { withheldRow(ev, identity); return; }
    if (!entry) {
      // A block with no text here: a replayed block whose text the history budget dropped, or a live
      // block whose deltas went to an earlier view. Its header still says what it was.
      entry = { id, ended: false, seconds: undefined, ...identity };
      if (id) blocks.set(id, entry);
      const open = turn.reasonGroup;
      const group = open && open.source === identity.source && open.provider === identity.provider
        && open.agent === identity.agent ? open : openReasonGroup(identity);
      addReasonPart(group, entry, "");
    }
    if (entry.ended) return;
    entry.ended = true;
    entry.seconds = Number.isFinite(ev.seconds) ? Math.max(0, ev.seconds) : null;
    const hasText = !!entry.text?.data.trim();
    // A note is only ever made from text: an end with nothing to show keeps its collapsed header.
    const inline = ev.placement === "inline" && !entry.agent && hasText && ev.truncated !== true
      && (entry.source === "summarized" || entry.source === "narration");
    if (entry.kind === "note") {
      if (inline) {
        const note = reasonNoteFrom(entry, entry.text.data);
        entry.note.replaceWith(note);
        if (turn.reasonNote === entry.note) turn.reasonNote = null;
        entry.note = note;
        return;
      }
      reasonNoteToGroup(entry);
    }
    if (inline && entry.group) { reasonGroupToNote(entry); return; }
    if (!hasText || ev.truncated === true) reasonMarkMissing(entry, hasText, ev.truncated === true);
    paintReasonGroup(entry.group);
  }
  // Say so when a block's text is not all here, instead of expanding to an empty or silently cut body.
  function reasonMarkMissing(entry, hasText, truncated) {
    if (!entry.part || entry.part.querySelector(".thought-cut")) return;
    const cut = el("span", hasText ? "thought-cut" : "thought-cut alone");
    cut.textContent = hasText ? "… the rest of this reasoning was not kept."
      : truncated ? "The text of this reasoning was not kept." : "The text of this reasoning is not in this view.";
    entry.part.appendChild(cut);
  }
  // Muted must stay muted. Light Modern (and any theme whose descriptionForeground is its foreground)
  // would draw an inline summary exactly like the answer beside it, so for such a theme the note and
  // its hint take a tone derived from the text and the panel background, as far toward the
  // background as still reads at 4.5:1 on every surface a note sits on. A theme with its own muted
  // colour keeps it; high-contrast themes and forced colours are never softened.
  function thoughtToneRgb(css) {
    const m = String(css || "").match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [r, g, b].every(Number.isFinite) && a > 0.99 ? [r, g, b] : null;
  }
  function thoughtToneContrast(one, two) {
    const lum = (rgb) => rgb.map((c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const [hi, lo] = [lum(one), lum(two)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }
  function syncThoughtTone() {
    const high = document.body.classList.contains("vscode-high-contrast")
      || document.body.classList.contains("vscode-high-contrast-light")
      || (typeof window.matchMedia === "function" && window.matchMedia("(forced-colors: active)").matches);
    const probe = (token) => {
      const node = document.createElement("span");
      node.style.cssText = `position:absolute;visibility:hidden;color:var(${token});background-color:var(${token})`;
      document.body.appendChild(node);
      const style = getComputedStyle(node);
      const value = { color: thoughtToneRgb(style.color), fill: thoughtToneRgb(style.backgroundColor) };
      node.remove();
      return value;
    };
    const text = probe("--text").color, muted = probe("--muted").color;
    const grounds = [probe("--bg").fill, probe("--surface").fill].filter(Boolean);
    let tone = "";
    if (!high && text && muted && grounds.length
        && text.reduce((sum, c, i) => sum + Math.abs(c - muted[i]), 0) <= 6) {
      const ground = grounds[0];
      for (let p = 0.6; p >= 0.1; p -= 0.02) {
        const mix = text.map((c, i) => Math.round(c * (1 - p) + ground[i] * p));
        if (grounds.every((g) => thoughtToneContrast(mix, g) >= 4.6)) { tone = `rgb(${mix.join(", ")})`; break; }
      }
    }
    if (tone) log.style.setProperty("--thought-muted", tone); else log.style.removeProperty("--thought-muted");
  }
  let thoughtToneQueued = false, thoughtToneKey = "";
  // What a theme change rewrites: the host's colour variables and the body's vscode-* theme class
  // (the panel's own body classes, such as ask-docked, are not a reason to measure again).
  const thoughtToneTheme = () => [...document.body.classList].filter((c) => c.startsWith("vscode")).join(" ")
    + "|" + (document.documentElement.getAttribute("style") || "") + "|" + (document.body.getAttribute("style") || "");
  function queueThoughtTone(force) {
    const key = thoughtToneTheme();
    if ((force !== true && key === thoughtToneKey) || thoughtToneQueued) return;
    thoughtToneKey = key;
    thoughtToneQueued = true;
    const run = () => { thoughtToneQueued = false; syncThoughtTone(); };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run); else setTimeout(run, 0);
  }
  thoughtToneKey = thoughtToneTheme();
  syncThoughtTone();
  if (typeof MutationObserver === "function") {
    const toneWatch = new MutationObserver(() => queueThoughtTone());
    toneWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    toneWatch.observe(document.body, { attributes: true, attributeFilter: ["style", "class"] });
  }
  if (typeof window.matchMedia === "function") {
    window.matchMedia("(forced-colors: active)").addEventListener?.("change", () => queueThoughtTone(true));
  }
  // ---- end 0.40 thinking --------------------------------------------------------------------------


  loadDraftState();
  window.addEventListener("pagehide", persistDraft);
  input.addEventListener("select", scheduleDraftSave);
  // Liveness comes from HERE, not from the extension host. A window that goes away can leave its
  // host running -- that is the 25-hour stranded session -- and the host cannot tell that it has.
  // This renderer simply stops existing, which is evidence the backend can trust. Say so on a
  // timer, and again the moment the window is looked at, because a backgrounded page's timers can
  // be throttled to once a minute. Kept in step with dgc/headless.py EDITOR_HEARTBEAT_S.
  const EDITOR_ALIVE_EVERY_MS = 20_000;
  const sayAlive = () => vscode.postMessage({ type: "editorAlive" });
  setInterval(sayAlive, EDITOR_ALIVE_EVERY_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sayAlive(); });
  window.addEventListener("focus", sayAlive);
  sayAlive();
  vscode.postMessage({ type: "webviewReady" });
  digestBar();
})();
