// window.DgcTextHistory: undo and redo for a plain-text box -- ChatDGC's and a Pip's -- the way the Work chat's prompt
// box has them (main.js, "undo and redo"), and the way Codex's composer has them: Mod-z, Mod-Shift-z and Mod-y, a
// typing run broken by a pause, and every edit the page makes itself a step of its own.
//
// A <textarea> keeps a history of its own, and for typing it is fine. What it cannot hold is everything else these
// boxes do: assigning .value (sending, a queued message given back, a draft restored) drops it, setRangeText (dictation)
// is not in it and leaves it pointing at text that has gone, a long paste folded into a chip changes no text at all,
// and a Pip's box is redrawn as the page redraws -- a new element each time, with an empty history. So the box's
// history lives here, outside the element, and answers every way an undo arrives: the keys; execCommand("undo"/"redo"),
// which is what VS Code's Edit menu sends a webview; and beforeinput historyUndo/historyRedo.
(function () {
  if (window.DgcTextHistory) return;
  const DEPTH = 100, GROUP_MS = 500;
  const MAC = /Mac|iP(hone|[oa]d)/.test(navigator.platform || "");
  const boxes = new Set();

  // Cmd+Z, Cmd+Shift+Z, Cmd+Y on a Mac; Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y elsewhere. The physical key stands in when the
  // layout's letter is not Latin.
  function key(event) {
    if (event.altKey || event.isComposing || event.keyCode === 229) return "";
    if (MAC ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return "";
    const letter = /^[a-z]$/i.test(event.key || "") ? event.key.toLowerCase()
      : String(event.code || "").replace(/^Key/, "").toLowerCase();
    if (letter === "z") return event.shiftKey ? "redo" : "undo";
    return letter === "y" && !event.shiftKey ? "redo" : "";
  }
  // Where focus really is, through shadow roots: a Pip's box sits in one inside the Work chat's page.
  function focused(doc) {
    let el = doc.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }
  // VS Code's Undo and Redo reach a focused webview as execCommand on its document. Chained, so the Work chat's own
  // composer (main.js) and these boxes each answer for themselves and anything else gets the browser's.
  function hookExecCommand(doc) {
    if (doc.__dgcTextHistory || typeof doc.execCommand !== "function") return;
    doc.__dgcTextHistory = true;
    const previous = doc.execCommand;
    doc.execCommand = function (command, ...rest) {
      const name = String(command || "").toLowerCase();
      if (name === "undo" || name === "redo") {
        const el = focused(doc);
        for (const history of boxes) if (history.owns(el)) return name === "undo" ? history.undo() : history.redo();
      }
      return previous.call(this, command, ...rest);
    };
  }

  /**
   * box(): the textarea as it is now (a redrawn page makes a new one; the history outlives it).
   * list: optional { get(), set(items) } -- the chips beside the text. Ones an edit added or removed are the
   *   history's to put back; one closed by hand (dismiss) never comes back.
   * changed(): after an undo or redo, so the page can save its draft and redraw.
   */
  function create({ box, list = null, changed = () => {} }) {
    const done = [], undone = [];
    const managed = new WeakSet(), dismissed = new WeakSet();
    let open = null, pending = null, depth = 0, before = null, restoring = false, composing = false;
    const capture = () => {
      const el = box();
      return { value: el ? el.value : "", start: el ? el.selectionStart : 0, end: el ? el.selectionEnd : 0,
        items: list ? list.get().slice() : [] };
    };
    const same = (a, b) => a.value === b.value && a.items.length === b.items.length && a.items.every((item, i) => item === b.items[i]);
    const push = (state) => { done.push(state); if (done.length > DEPTH) done.shift(); undone.length = 0; };
    function continues(kind) {
      const el = box();
      if (!kind || !open || open.kind !== kind || !el) return false;
      if (composing) return true;
      return el.selectionStart === el.selectionEnd && el.selectionStart === open.end && Date.now() - open.time < GROUP_MS;
    }
    function settle(kind) {
      const el = box();
      open = kind && el ? { kind, end: el.selectionEnd, time: Date.now() } : null;
    }
    // Every change the page makes to the box goes through here; nested calls are one step.
    function record(edit, kind = "") {
      if (restoring) return edit();
      const outer = depth === 0;
      if (outer) { before = continues(kind) ? null : capture(); open = null; pending = null; }
      depth += 1;
      try { return edit(); }
      finally {
        depth -= 1;
        if (outer) {
          const was = before;
          before = null;
          if (was) {
            const now = list ? list.get() : [];
            for (const item of now) if (!was.items.includes(item)) managed.add(item);
            for (const item of was.items) if (!now.includes(item)) managed.add(item);
            if (!same(was, capture())) push(was);
          }
          settle(kind);
        }
      }
    }
    function restore(state) {
      const el = box();
      if (el) {
        el.value = state.value;
        el.focus({ preventScroll: true });
        el.setSelectionRange(state.start, state.end);
      }
      if (!list) return;
      const now = list.get(), next = [];
      // What the step had, unless closed by hand since; and whatever the history does not own, where it stands now.
      state.items.forEach((item) => { if (!dismissed.has(item) && (now.includes(item) || managed.has(item))) next.push(item); });
      for (const item of now) if (!next.includes(item) && !managed.has(item)) next.push(item);
      list.set(next);
    }
    function move(from, to) {
      if (composing || depth || !from.length) return false;
      open = null; pending = null;
      to.push(capture());
      restoring = true;
      try { restore(from.pop()); } finally { restoring = false; }
      changed();
      return true;
    }
    const history = {
      record,
      undo: () => move(done, undone),
      redo: () => move(undone, done),
      reset() { done.length = 0; undone.length = 0; open = null; pending = null; },
      dismiss(item) { if (item && typeof item === "object") dismissed.add(item); },
      owns: (el) => !!el && el === box(),
      // Wire these to the box (or to a root it is redrawn into, filtered to it).
      keydown(event) {
        const op = key(event);
        if (!op) return false;
        // Taken even with nothing to undo: let through, VS Code runs the browser's own undo on the page.
        event.preventDefault();
        event.stopPropagation();
        if (op === "undo") history.undo(); else history.redo();
        return true;
      },
      beforeinput(event) {
        const type = event.inputType || "";
        if (type === "historyUndo" || type === "historyRedo") {
          event.preventDefault();
          if (type === "historyUndo") history.undo(); else history.redo();
          return;
        }
        if (depth || restoring) return;
        const kind = /^insert(Text|CompositionText)$/.test(type) ? "insert"
          : /^delete(Content|Word|SoftLine|HardLine)(Backward|Forward)$/.test(type) ? "delete" : "";
        // Kept only if an input event follows: a Backspace in an empty box is not a step.
        pending = continues(kind) ? { kind } : { kind, state: capture() };
      },
      input() {
        const was = pending;
        pending = null;
        if (depth || restoring || !was) return;
        if (was.state) push(was.state);
        settle(was.kind);
      },
      compositionstart() { composing = true; },
      compositionend() { composing = false; },
    };
    boxes.add(history);
    hookExecCommand(document);
    return history;
  }
  window.DgcTextHistory = { create, key };
})();
