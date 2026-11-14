// A note open wide in an editor tab (src/notesTab.ts opens it; asked 14 Nov: "Open a note wide in an editor tab: the
// same editor, the full width"). The notes app of media/shared/notes.js, showing the one note this tab is for, on the
// same store as Home's card: what is typed here is in the card, and what is typed there is here.
(function () {
  "use strict";
  const vscode = acquireVsCodeApi(), id = document.body.dataset.note || "", section = document.querySelector(".hc-note"), live = document.querySelector(".hc-live");
  let pending = 0;
  window.DgcTip?.install();   // a control's `title` as DGC's own label, inside the tab (media/shared/tip.js)
  const draw = () => { if (pending) return; pending = requestAnimationFrame(() => { pending = 0; app.fill(section, "tab"); }); };
  const app = window.DgcNotes.create({ post: (message) => vscode.postMessage(message), say: (text) => { live.textContent = text; }, width: () => window.innerWidth, redraw: draw, isOpen: () => true, tab: id });
  window.addEventListener("message", (event) => app.heard(event.data));
  // Escape with the keyboard nowhere in the note: a menu or a question closes.
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !event.defaultPrevented && app.back()) event.preventDefault(); });
  window.addEventListener("pagehide", () => app.flush());
  window.setInterval(draw, 20000);
  try { vscode.setState({ note: id }); } catch { /* the tab is not brought back after a reload */ }
  vscode.postMessage({ type: "homeNotesDo", op: "get" });
  app.fill(section, "tab");
})();
