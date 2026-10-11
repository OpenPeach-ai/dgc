// ChatDGC's formatted canvas (Canvas option B): ChatGPT's canvas look over the same Markdown file option A opens.
// ProseMirror edits the document; canvasMarkdown.ts reads the file in and writes it back block by block. The
// extension host (canvasDoc.ts) owns the TextDocument: it saves, keeps versions and applies the model's changes; this
// page sends what you typed and shows what changed. Text only: nothing here turns the file's words into markup.
import { EditorState, Plugin, PluginKey, TextSelection, NodeSelection, type Command, type Transaction } from "prosemirror-state";
import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
import { tableEditing, goToNextCell, addRowAfter, addRowBefore, addColumnAfter, addColumnBefore, deleteRow, deleteColumn,
         deleteTable, isInTable, selectedRect, TableMap } from "prosemirror-tables";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark, setBlockType, wrapIn, lift, chainCommands, exitCode } from "prosemirror-commands";
import { wrapInList, splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { inputRules, wrappingInputRule, textblockTypeInputRule, InputRule, undoInputRule } from "prosemirror-inputrules";
import MarkdownIt from "markdown-it";
import { schema, read, write, changedBlocks, type Read } from "./canvasMarkdown";
import { addMath } from "./markdownMath";

declare const acquireVsCodeApi: () => { postMessage(message: unknown): void };
const host = acquireVsCodeApi();
const nodes = schema.nodes, marks = schema.marks;
const MAX_TEXT = 2_000_000;

// A kept block (a table, display maths) drawn as a reply draws it: no HTML, links inert, no images fetched.
const shown = new MarkdownIt("default", { html: false, linkify: false, typographer: false });
addMath(shown);
const esc = shown.utils.escapeHtml;
shown.renderer.rules.link_open = (tokens, i) => {
  const href = String(tokens[i].attrGet("href") || "");
  return `<a class="cv-link" data-href="${esc(href)}" title="${esc(href)}">`;
};
shown.renderer.rules.image = (tokens, i) => `<span class="cv-img">[${esc(tokens[i].content || "image")}]</span>`;
shown.renderer.rules.math_inline = (tokens, i) =>
  `<span class="md-math${tokens[i].meta?.display ? " md-math-display" : ""}" data-tex="${esc(tokens[i].content)}">${esc(tokens[i].markup + tokens[i].content + tokens[i].info)}</span>`;
shown.renderer.rules.math_block = (tokens, i) =>
  `<div class="md-math md-math-display" data-tex="${esc(tokens[i].content)}">${esc(tokens[i].markup + tokens[i].content + tokens[i].info)}</div>`;

// KaTeX, fetched the first time there's maths to draw (as ChatDGC's chat does).
let katexAsked = false;
function drawMath(root: ParentNode): void {
  const katex = (window as any).katex;
  const pending = root.querySelectorAll<HTMLElement>(".md-math:not([data-drawn])");
  if (!pending.length) return;
  if (!katex) { loadKatex(); return; }
  pending.forEach((node) => {
    try {
      katex.render(node.dataset.tex || "", node, { displayMode: node.classList.contains("md-math-display"), throwOnError: false,
                                                   strict: "ignore", trust: false, maxSize: 20, maxExpand: 200 });
      node.dataset.drawn = "1";
    } catch { /* it stays as the TeX it was written in */ }
  });
}
function loadKatex(): void {
  if (katexAsked) return;
  katexAsked = true;
  const js = document.body.dataset.katex, css = document.body.dataset.katexCss;
  if (!js) return;
  if (css) { const link = document.createElement("link"); link.rel = "stylesheet"; link.href = css; document.head.append(link); }
  const script = document.createElement("script");
  script.src = js;
  script.onload = () => drawMath(document);
  document.head.append(script);
}

// ---- maths: drawn with KaTeX; clicked (or Enter on it), its TeX in a box under it, drawn again as you type.

let texOpen: { close(commit: boolean): void } | null = null;

/** The TeX of a formula in a box under `anchor`, with the drawn result as you type. `done` gets the TeX to keep, or
 *  null when you pressed Esc. A block takes several lines (Ctrl+Enter to finish); inline, Enter finishes. */
function openTex(anchor: HTMLElement, tex: string, block: boolean, done: (tex: string | null) => void): void {
  texOpen?.close(true);
  loadKatex();
  const box = document.createElement("div");
  box.className = "cv-tex";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", block ? "Edit the equation" : "Edit the formula");
  const field = document.createElement(block ? "textarea" : "input") as HTMLInputElement | HTMLTextAreaElement;
  field.className = "cv-tex-field";
  field.value = tex;
  field.spellcheck = false;
  field.setAttribute("aria-label", "TeX");
  field.placeholder = block ? "\\sum_{i=1}^{n} x_i" : "x^2 + y^2";
  if (block) (field as HTMLTextAreaElement).rows = Math.min(8, Math.max(2, tex.split("\n").length + 1));
  const preview = document.createElement("div");
  const hint = document.createElement("div");
  hint.className = "cv-tex-hint";
  hint.textContent = block ? "Ctrl+Enter to finish · Esc to cancel" : "Enter to finish · Esc to cancel";
  box.append(field, preview, hint);
  document.body.append(box);
  const draw = () => {
    preview.className = "cv-tex-preview md-math" + (block ? " md-math-display" : "");
    delete preview.dataset.drawn;
    preview.dataset.tex = field.value;
    preview.textContent = field.value || " ";
    drawMath(box);
  };
  const place = () => {
    const at = anchor.getBoundingClientRect();
    box.style.left = `${Math.max(8, Math.min(at.left, innerWidth - box.offsetWidth - 8))}px`;
    box.style.top = `${Math.min(at.bottom + 6, innerHeight - box.offsetHeight - 8)}px`;
  };
  let closed = false;
  const close = (commit: boolean) => {
    if (closed) return;
    closed = true;
    box.remove();
    texOpen = null;
    done(commit ? field.value.trim() : null);
  };
  field.addEventListener("input", () => { draw(); place(); });
  field.addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    if (k.key === "Escape") { k.preventDefault(); close(false); }
    else if (k.key === "Enter" && (!block || k.ctrlKey || k.metaKey)) { k.preventDefault(); close(true); }
  });
  field.addEventListener("blur", () => setTimeout(() => close(true), 0));
  texOpen = { close };
  draw(); place();
  field.focus();
  field.select();
}

/** A formula's node edited in place: the TeX kept (changed or not), or the node gone when it's emptied (or was new
 *  and you pressed Esc). The cursor goes after it. */
function finishTex(v: EditorView, getPos: () => number | undefined, type: any, tex: string | null): void {
  const pos = getPos();
  const node = pos == null ? null : v.state.doc.nodeAt(pos);
  if (pos == null || !node || node.type !== type) return;
  let tr = v.state.tr;
  if (tex === null && node.attrs.tex) { v.focus(); return; }
  if (!tex) tr = tr.delete(pos, pos + node.nodeSize);
  else if (tex !== node.attrs.tex) tr = tr.setNodeMarkup(pos, null, { ...node.attrs, tex });
  const after = tr.mapping.map(pos + (tex ? node.nodeSize : 0));
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(after, tr.doc.content.size))));
  v.dispatch(tr.scrollIntoView());
  v.focus();
}

class MathView {
  dom: HTMLElement;
  constructor(private node: any, private v: EditorView, private getPos: () => number | undefined, private block: boolean) {
    this.dom = document.createElement(block ? "div" : "span");
    this.dom.className = block ? "cv-math cv-math-block" : "cv-math";
    this.dom.contentEditable = "false";
    this.dom.title = block ? "An equation. Click to edit it." : "A formula. Click to edit it.";
    (this.dom as any).cvEdit = () => this.edit();
    this.dom.addEventListener("mousedown", (e) => { e.preventDefault(); this.edit(); });
    this.render();
  }
  private render(): void {
    const out = document.createElement(this.block ? "div" : "span");
    const { tex, open, close, display } = this.node.attrs;
    out.className = "md-math" + (this.block || display ? " md-math-display" : "") + (tex ? "" : " cv-math-empty");
    out.dataset.tex = tex;
    out.textContent = tex ? (open || "$$") + tex + (close || "$$") : (this.block ? "Equation" : "formula");
    if (!tex) out.dataset.drawn = "1";
    this.dom.replaceChildren(out);
    queueMicrotask(() => drawMath(this.dom));
  }
  edit(): void {
    openTex(this.dom, this.node.attrs.tex, this.block,
            (tex) => finishTex(this.v, this.getPos, this.block ? nodes.math_block : nodes.math_inline, tex));
  }
  update(node: any): boolean {
    if (node.type !== this.node.type) return false;
    if (node.attrs !== this.node.attrs) { this.node = node; this.render(); }
    return true;
  }
  selectNode() { this.dom.classList.add("ProseMirror-selectednode"); }
  deselectNode() { this.dom.classList.remove("ProseMirror-selectednode"); }
  stopEvent(event: Event) { return event.type === "mousedown"; }
  ignoreMutation() { return true; }
}

// ---- checklists: an item with a box you tick; the box isn't part of its text.

class ListItemView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private box?: HTMLInputElement;
  constructor(private node: any, v: EditorView, getPos: () => number | undefined) {
    this.dom = document.createElement("li");
    if (node.attrs.checked == null) { this.contentDOM = this.dom; return; }
    this.dom.className = "cv-task";
    this.dom.dataset.checked = String(node.attrs.checked);
    const wrap = document.createElement("span");
    wrap.className = "cv-task-box";
    wrap.contentEditable = "false";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.tabIndex = -1;
    box.checked = !!node.attrs.checked;
    box.setAttribute("aria-label", "Done");
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      const pos = getPos(), now = pos == null ? null : v.state.doc.nodeAt(pos);
      if (pos == null || !now) return;
      v.dispatch(v.state.tr.setNodeMarkup(pos, null, { ...now.attrs, checked: !now.attrs.checked }));
    });
    wrap.append(box);
    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "cv-task-text";
    this.dom.append(wrap, this.contentDOM);
    this.box = box;
  }
  update(node: any): boolean {
    if (node.type !== this.node.type || (node.attrs.checked == null) !== (this.node.attrs.checked == null)) return false;
    this.node = node;
    if (this.box) { this.box.checked = !!node.attrs.checked; this.dom.dataset.checked = String(node.attrs.checked); }
    return true;
  }
  stopEvent(event: Event) { return !!this.box && event.target === this.box; }
  ignoreMutation(m: MutationRecord | { type: "selection" }) {
    if (!this.box || m.type === "selection") return false;
    const target = (m as MutationRecord).target;
    return target === this.box || target === this.box.parentNode || (m.type === "attributes" && target === this.dom);
  }
}

class RawView {
  dom: HTMLElement;
  constructor(node: any) {
    this.dom = document.createElement("div");
    this.dom.className = "cv-raw";
    this.dom.contentEditable = "false";
    const body = document.createElement("div");
    body.className = "cv-raw-body";
    body.innerHTML = shown.render(String(node.attrs.src || ""));     // html: false; links inert; no images
    const edit = document.createElement("button");
    edit.type = "button"; edit.className = "cv-raw-edit";
    edit.textContent = "Edit in Markdown";
    edit.addEventListener("click", (e) => { e.preventDefault(); flush(); host.postMessage({ type: "markdown" }); });
    this.dom.append(body, edit);
    queueMicrotask(() => drawMath(this.dom));
  }
  stopEvent(event: Event) { return (event.target as HTMLElement)?.closest?.(".cv-raw-edit") != null; }
  ignoreMutation() { return true; }
}

// Markdown typed as you'd type it: "# ", "> ", "- ", "1. ", "```", "---".
const rules = inputRules({ rules: [
  textblockTypeInputRule(/^(#{1,3})\s$/, nodes.heading, (m) => ({ level: m[1].length })),
  wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
  wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list, (m) => ({ bullet: m[1] === "+" ? "-" : m[1] })),
  wrappingInputRule(/^(\d+)\.\s$/, nodes.ordered_list, (m) => ({ order: +m[1] }),
                    (m, node) => node.childCount + node.attrs.order === +m[1]),
  textblockTypeInputRule(/^```$/, nodes.code_block),
  new InputRule(/^---$/, (state, _match, start, end) => {
    const $start = state.doc.resolve(start);
    if (!$start.parent.type.isTextblock || $start.parent.type !== nodes.paragraph) return null;
    return state.tr.replaceRangeWith($start.before(), $start.after(), nodes.horizontal_rule.create())
      .scrollIntoView();
  }),
  // "[ ] " or "[x] " at the start of a list item: a checklist item.
  new InputRule(/^\[([ xX]?)\]\s$/, (state, match, start, end) => {
    const $start = state.doc.resolve(start), d = $start.depth - 1;
    const item = d > 0 ? $start.node(d) : null;
    if (item?.type !== nodes.list_item || $start.index(d) !== 0) return null;
    return state.tr.delete(start, end).setNodeMarkup($start.before(d), null, { ...item.attrs, checked: /x/i.test(match[1]) });
  }),
  // $x^2$ as you type it (not "$5 and $10": a formula has a letter or a TeX sign in it).
  new InputRule(/(?<![\\$])\$([^$\s](?:[^$]*[^$\s])?)\$$/, (state, match, start, end) => {
    if (!/[A-Za-z\\^_{}=+]/.test(match[1]) || state.selection.$from.marks().some((m) => m.type === marks.code)) return null;
    return state.tr.replaceWith(start, end, nodes.math_inline.create({ tex: match[1] }));
  }),
  // "$$ " on an empty line: an equation, opened to write.
  new InputRule(/^\$\$\s$/, (state, _match, start) => {
    const $start = state.doc.resolve(start);
    if ($start.parent.type !== nodes.paragraph || $start.depth !== 1) return null;
    setTimeout(() => (view.nodeDOM($start.before(1)) as any)?.cvEdit?.(), 0);
    return state.tr.replaceRangeWith($start.before(1), $start.after(1), nodes.math_block.create());
  }),
] });

const hardBreak = chainCommands(exitCode, (state, dispatch) => {
  dispatch?.(state.tr.replaceSelectionWith(nodes.hard_break.create()).scrollIntoView());
  return true;
});

// ---- tables: Tab to the next cell (a new row after the last), Enter to the cell below, tools while you're in one.

/** Tab: the next cell; from the last, a new row and its first cell. */
const nextCell: Command = (state, dispatch, v) => {
  if (!isInTable(state)) return false;
  if (goToNextCell(1)(state, dispatch)) return true;
  if (dispatch && v) { addRowAfter(state, dispatch); goToNextCell(1)(v.state, dispatch); }
  return true;
};

/** Enter in a table: the cell below (a table cell holds one line); from the last row, a new row. */
const cellBelow: Command = (state, dispatch, v) => {
  if (!isInTable(state)) return false;
  if (!dispatch || !v) return true;
  if (selectedRect(state).bottom >= selectedRect(state).map.height) addRowAfter(state, dispatch);
  const rect = selectedRect(v.state);
  const cell = rect.tableStart + rect.map.map[Math.min(rect.bottom, rect.map.height - 1) * rect.map.width + rect.left];
  dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(cell + 1))).scrollIntoView());
  return true;
};

/** A row or column deleted, the cursor stays in the table, in the nearest cell left (so its tools stay too). */
function keepInTable(command: Command): Command {
  return (state, dispatch, v) => {
    if (!isInTable(state)) return false;
    const before = selectedRect(state);
    if (!command(state, dispatch, v)) return false;
    if (!dispatch || !v || isInTable(v.state)) return true;
    const table = v.state.doc.nodeAt(before.tableStart - 1);
    if (!table || table.type !== nodes.table) return true;
    const map = TableMap.get(table);
    const cell = before.tableStart + map.map[Math.min(before.top, map.height - 1) * map.width + Math.min(before.left, map.width - 1)];
    dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(cell + 1))));
    return true;
  };
}

/** Enter in a list: a new item; one split from a checklist item is a new, unticked one. */
const splitItem: Command = (state, dispatch) => splitListItem(nodes.list_item)(state, dispatch && ((tr: Transaction) => {
  const $at = tr.selection.$from;
  for (let d = $at.depth; d > 0; d--) {
    const node = $at.node(d);
    if (node.type !== nodes.list_item) continue;
    if (node.attrs.checked) tr.setNodeMarkup($at.before(d), null, { ...node.attrs, checked: false });
    break;
  }
  dispatch(tr);
}));

/** The checklist items the selection is in (their own lines, not a list around them). */
function itemsAt(state: EditorState): { pos: number; node: any }[] {
  const { from, to } = state.selection, out: { pos: number; node: any }[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type !== nodes.list_item || !node.firstChild) return;
    const start = pos + 1, end = start + node.firstChild.nodeSize;
    if (start <= to && end >= from) out.push({ pos, node });
  });
  return out;
}

/** Ctrl+Enter in a checklist item ticks it (or unticks it). */
const tickItem: Command = (state, dispatch) => {
  const [item] = itemsAt(state).slice(-1);
  if (!item || item.node.attrs.checked == null) return false;
  dispatch?.(state.tr.setNodeMarkup(item.pos, null, { ...item.node.attrs, checked: !item.node.attrs.checked }));
  return true;
};

/** The toolbar's checklist: items become checklist items (a paragraph, a checklist), or back to plain bullets. */
const checklist: Command = (state, dispatch) => {
  let tr = state.tr;
  if (!itemsAt(state).length) {
    let wrapped: Transaction | undefined;
    if (!wrapInList(nodes.bullet_list, { tight: true, bullet: "-" })(state, (t) => { wrapped = t; }) || !wrapped) return false;
    tr = wrapped;
  }
  const items = itemsAt(state.apply(tr));
  const plain = items.every((i) => i.node.attrs.checked != null);
  for (const i of items) tr.setNodeMarkup(i.pos, null, { ...i.node.attrs, checked: plain ? null : (i.node.attrs.checked ?? false) });
  dispatch?.(tr.scrollIntoView());
  return true;
};

const keys = keymap({
  "Mod-z": undo, "Shift-Mod-z": redo, "Mod-y": redo, Backspace: undoInputRule,
  "Mod-b": toggleMark(marks.strong), "Mod-i": toggleMark(marks.em), "Mod-e": toggleMark(marks.code),
  "Mod-Shift-x": toggleMark(marks.strike), "Mod-k": () => { askLink(); return true; },
  Enter: chainCommands(cellBelow, (state) => {
    // On a formula or equation, Enter opens it to edit.
    const sel = state.selection;
    if (!(sel instanceof NodeSelection) || !(sel.node.type === nodes.math_inline || sel.node.type === nodes.math_block)) return false;
    (view.nodeDOM(sel.from) as any)?.cvEdit?.();
    return true;
  }, splitItem),
  "Shift-Enter": chainCommands(cellBelow, hardBreak), "Mod-Enter": chainCommands(tickItem, hardBreak),
  Tab: chainCommands(nextCell, sinkListItem(nodes.list_item)),
  "Shift-Tab": chainCommands(goToNextCell(-1), liftListItem(nodes.list_item)),
  "Mod-Shift-9": checklist,
  "Mod-Alt-1": setBlockType(nodes.heading, { level: 1 }), "Mod-Alt-2": setBlockType(nodes.heading, { level: 2 }),
  "Mod-Alt-3": setBlockType(nodes.heading, { level: 3 }), "Mod-Alt-0": setBlockType(nodes.paragraph),
});

let source: Read = read("");
let lastText = "";            // what the file holds as far as this page knows: sent by it, or sent to it
let timer: ReturnType<typeof setTimeout> | undefined;
let view: EditorView;

/** Send what you typed, now (before an Ask, or when you switch to Markdown). */
function flush(): void {
  if (timer) { clearTimeout(timer); timer = undefined; }
  const { text } = write(view.state.doc, source);
  if (text === lastText || text.length > MAX_TEXT) return;
  lastText = text;
  host.postMessage({ type: "edit", text });
}

const sync = new Plugin({
  view: () => ({
    update(v, prev) {
      if (!v.state.doc.eq(prev.doc)) { if (timer) clearTimeout(timer); timer = setTimeout(flush, 250); }
      paintBar();
    },
  }),
});

// What the model changed, lit as it lands: a decoration (ProseMirror redraws a node whose DOM is changed under it).
const flashKey = new PluginKey<DecorationSet>("flash");
const flashing = new Plugin<DecorationSet>({
  key: flashKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const meta = tr.getMeta(flashKey);
      if (meta === "clear") return DecorationSet.empty;
      if (Array.isArray(meta)) return DecorationSet.create(tr.doc, meta.map(([from, to]: [number, number]) => Decoration.node(from, to, { class: "cv-flash" })));
      return set.map(tr.mapping, tr.doc);
    },
  },
  props: { decorations: (s) => flashKey.getState(s) },
});
let unflash: ReturnType<typeof setTimeout> | undefined;

// The browser moves the caret for End, Ctrl+End, arrows and clicks, and ProseMirror learns of it a moment later
// (selectionchange is async): a key pressed right after (End, then Enter) acted where the caret had been, and split a
// paragraph mid-word in the live run. Before a key is handled, the browser's selection, if it differs, is taken.
const caret = new Plugin({
  props: {
    handleKeyDown(view) {
      const dom = view.dom.ownerDocument.getSelection();
      if (!dom?.anchorNode || !dom.focusNode || !view.dom.contains(dom.anchorNode) || !view.dom.contains(dom.focusNode)) return false;
      if (view.state.selection instanceof NodeSelection) return false;
      try {
        const anchor = view.posAtDOM(dom.anchorNode, dom.anchorOffset), head = view.posAtDOM(dom.focusNode, dom.focusOffset);
        const now = view.state.selection;
        if (anchor !== now.anchor || head !== now.head) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
      } catch { /* a caret inside a kept block or maths: leave it */ }
      return false;
    },
  },
});

function state(doc: any): EditorState {
  return EditorState.create({ doc, plugins: [caret, rules, keys, keymap(baseKeymap), tableEditing(), history(), sync, flashing] });
}

/** The file as the host has it: the first time, or after the model (or another editor) changed it. */
function load(text: string, flash: boolean): void {
  if (text === lastText && view) return;
  if (timer) { clearTimeout(timer); timer = undefined; }
  const before = source;
  source = read(text);
  lastText = text;
  view.updateState(state(source.doc));
  if (flash) {
    const ranges: [number, number][] = [];
    const changed = new Set(changedBlocks(before, source));
    source.doc.forEach((node, offset, index) => { if (changed.has(index)) ranges.push([offset, offset + node.nodeSize]); });
    if (ranges.length) {
      view.dispatch(view.state.tr.setMeta(flashKey, ranges).setMeta("addToHistory", false));
      if (unflash) clearTimeout(unflash);
      unflash = setTimeout(() => view.dispatch(view.state.tr.setMeta(flashKey, "clear").setMeta("addToHistory", false)), 1800);
    }
  }
  drawMath(view.dom);
  paintBar();
}

// ---- the toolbar: ChatGPT's, as a row of plain buttons

const bar = document.getElementById("cv-bar") as HTMLElement;
const style = document.getElementById("cv-style") as HTMLSelectElement;

function markActive(type: any): boolean {
  const { from, $from, to, empty } = view.state.selection;
  return empty ? !!type.isInSet(view.state.storedMarks || $from.marks()) : view.state.doc.rangeHasMark(from, to, type);
}

function blockStyle(): string {
  const parent = view.state.selection.$from.parent;
  if (parent.type === nodes.heading) return "h" + parent.attrs.level;
  if (parent.type === nodes.code_block) return "code";
  return "p";
}

const tableBar = document.getElementById("cv-table-bar") as HTMLElement;
const align = document.getElementById("cv-align") as HTMLSelectElement;
const insertMenu = document.getElementById("cv-insert") as HTMLSelectElement;
const deleteMenu = document.getElementById("cv-delete") as HTMLSelectElement;

function paintBar(): void {
  if (!view) return;
  for (const button of Array.from(bar.querySelectorAll<HTMLButtonElement>("[data-mark]"))) {
    const on = markActive((marks as any)[button.dataset.mark!]);
    button.setAttribute("aria-pressed", String(on));
  }
  const items = itemsAt(view.state);
  bar.querySelector('[data-do="checklist"]')?.setAttribute("aria-pressed", String(!!items.length && items.every((i) => i.node.attrs.checked != null)));
  const inTable = isInTable(view.state);
  tableBar.hidden = !inTable;
  if (inTable) {
    // The cell is the cursor's own text block (a cell holds a line of text).
    const cell = view.state.selection.$from.parent;
    align.value = cell.attrs.align || "";
  }
  style.value = blockStyle();
  const ask = document.getElementById("cv-ask") as HTMLButtonElement;
  ask.title = view.state.selection.empty ? "Ask ChatDGC about this paragraph" : "Ask ChatDGC about the selection";
}

function run(command: (state: EditorState, dispatch?: any, view?: EditorView) => boolean): void {
  command(view.state, view.dispatch, view);
  view.focus();
}

/** A new table (a header row and two rows, three columns) after the block you're in, or in place of an empty line. */
function insertTable(): void {
  run((s, d) => {
    const cell = (header: boolean) => (header ? nodes.table_header : nodes.table_cell).createAndFill()!;
    const row = (header: boolean) => nodes.table_row.create(null, [cell(header), cell(header), cell(header)]);
    const table = nodes.table.create(null, [row(true), row(false), row(false)]);
    const $from = s.selection.$from;
    const empty = $from.depth === 1 && $from.parent.type === nodes.paragraph && !$from.parent.content.size;
    const at = $from.depth ? (empty ? $from.before(1) : $from.after(1)) : s.doc.content.size;
    const tr = empty ? s.tr.replaceWith(at, $from.after(1), table) : s.tr.insert(at, table);
    tr.setSelection(TextSelection.near(tr.doc.resolve(at + 3)));
    d?.(tr.scrollIntoView());
    return true;
  });
}

/** A column's alignment, on every cell in it (Markdown aligns a whole column). */
function alignColumn(value: string): void {
  run((s, d) => {
    if (!isInTable(s)) return false;
    const rect = selectedRect(s), tr = s.tr, seen = new Set<number>();
    for (let row = 0; row < rect.map.height; row++) {
      for (let col = rect.left; col < rect.right; col++) {
        const pos = rect.tableStart + rect.map.map[row * rect.map.width + col];
        if (seen.has(pos)) continue;
        seen.add(pos);
        const cell = tr.doc.nodeAt(pos);
        if (cell) tr.setNodeMarkup(pos, null, { ...cell.attrs, align: value || null });
      }
    }
    d?.(tr);
    return true;
  });
}

/** An equation: on an empty line, a block of its own; anywhere else, a formula in the line. Opened to write. */
function insertEquation(): void {
  const s = view.state, $from = s.selection.$from;
  const line = $from.depth === 1 && $from.parent.type === nodes.paragraph && !$from.parent.content.size;
  let tr: Transaction, pos: number;
  if (line) { pos = $from.before(1); tr = s.tr.replaceWith(pos, $from.after(1), nodes.math_block.create()); }
  else { tr = s.tr.replaceSelectionWith(nodes.math_inline.create()); pos = tr.selection.from - 1; }
  view.dispatch(tr.scrollIntoView());
  (view.nodeDOM(pos) as any)?.cvEdit?.();
}

function askLink(): void {
  const { from, to, empty } = view.state.selection;
  if (markActive(marks.link)) { run((s, d) => { d?.(s.tr.removeMark(from, to, marks.link)); return true; }); return; }
  const href = (window.prompt("Link address (https://…)", "https://") || "").trim();
  if (!/^https?:\/\/\S+$/i.test(href)) { view.focus(); return; }
  run((s, d) => {
    const tr = empty ? s.tr.insertText(href, from).addMark(from, from + href.length, marks.link.create({ href }))
                     : s.tr.addMark(from, to, marks.link.create({ href }));
    d?.(tr);
    return true;
  });
}

/** Ask ChatDGC about the selection (or the block the cursor is in): its lines in the file, as option A sends them. */
function ask(): void {
  flush();
  const { from, to, empty, $from, $to } = view.state.selection;
  const first = $from.index(0);
  let last = $to.index(0);
  if (!empty && last > first && $to.parentOffset === 0 && $to.depth > 0) last -= 1;     // ends at the start of a block
  const { lines } = write(view.state.doc, source);
  const spans = lines.slice(first, last + 1).filter(Boolean) as [number, number][];
  if (!spans.length) return;
  const text = empty ? view.state.doc.child(first).textContent : view.state.doc.textBetween(from, to, "\n\n");
  if (!text.trim()) return;
  host.postMessage({ type: "ask", text: text.slice(0, 20_000), start_line: spans[0][0] + 1, end_line: spans[spans.length - 1][1] + 1 });
}

const actions: Record<string, () => void> = {
  strong: () => run(toggleMark(marks.strong)), em: () => run(toggleMark(marks.em)),
  strike: () => run(toggleMark(marks.strike)), code: () => run(toggleMark(marks.code)),
  link: askLink,
  bullet: () => run(chainCommands(liftListItem(nodes.list_item), wrapInList(nodes.bullet_list))),
  ordered: () => run(chainCommands(liftListItem(nodes.list_item), wrapInList(nodes.ordered_list))),
  quote: () => run(chainCommands(lift, wrapIn(nodes.blockquote))),
  rule: () => run((s, d) => { d?.(s.tr.replaceSelectionWith(nodes.horizontal_rule.create()).scrollIntoView()); return true; }),
  checklist: () => run(checklist),
  table: insertTable,
  equation: insertEquation,
  rowAbove: () => run(addRowBefore), rowBelow: () => run(addRowAfter),
  colLeft: () => run(addColumnBefore), colRight: () => run(addColumnAfter),
  delRow: () => run(keepInTable(deleteRow)), delCol: () => run(keepInTable(deleteColumn)), delTable: () => run(deleteTable),
  ask, shortcuts: () => { flush(); host.postMessage({ type: "shortcuts" }); },
  markdown: () => { flush(); host.postMessage({ type: "markdown" }); },
};

for (const row of [bar, tableBar]) {
  row.addEventListener("mousedown", (e) => { if ((e.target as HTMLElement).closest("button")) e.preventDefault(); });   // keep the selection
  row.addEventListener("click", (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-do]");
    if (button) actions[button.dataset.do!]?.();
  });
}
align.addEventListener("change", () => alignColumn(align.value));
// Insert… and Delete… are menus: the choice is done, and the menu shows its name again.
for (const menu of [insertMenu, deleteMenu]) {
  menu.addEventListener("change", () => { const does = menu.value; menu.value = ""; if (does) actions[does]?.(); });
}
style.addEventListener("change", () => {
  const v = style.value;
  run(v === "p" ? setBlockType(nodes.paragraph) : v === "code" ? setBlockType(nodes.code_block)
      : setBlockType(nodes.heading, { level: +v.slice(1) }));
});

view = new EditorView(document.getElementById("cv-editor") as HTMLElement, {
  state: state(source.doc),
  nodeViews: {
    math_inline: (node, v, getPos) => new MathView(node, v, getPos, false),
    math_block: (node, v, getPos) => new MathView(node, v, getPos, true),
    list_item: (node, v, getPos) => new ListItemView(node, v, getPos),
    raw_block: (node) => new RawView(node),
  },
  attributes: { "aria-label": "Canvas", spellcheck: "true", class: "cv-doc" },
  handleDOMEvents: {
    // A link opens only on Ctrl/Cmd+click, through the host, which checks it; a plain click puts the cursor there.
    click: (_v, event) => {
      const a = (event.target as HTMLElement)?.closest?.("a[href], a.cv-link") as HTMLAnchorElement | null;
      if (!a) return false;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) host.postMessage({ type: "openLink", href: a.dataset.href || a.getAttribute("href") || "" });
      return !!a.classList.contains("cv-link");
    },
  },
});

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "doc" && typeof msg.text === "string") load(msg.text, msg.external === true);
  else if (msg.type === "askSelection") ask();
  else if (msg.type === "flush") flush();
});
window.addEventListener("blur", () => flush());
host.postMessage({ type: "ready" });
