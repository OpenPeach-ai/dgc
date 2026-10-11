// ChatDGC's formatted canvas (Canvas option B): ChatGPT's canvas look over the same Markdown file option A opens.
// ProseMirror edits the document; canvasMarkdown.ts reads the file in and writes it back block by block. The
// extension host (canvasDoc.ts) owns the TextDocument: it saves, keeps versions and applies the model's changes; this
// page sends what you typed and shows what changed. Text only: nothing here turns the file's words into markup.
import { EditorState, Plugin, PluginKey, TextSelection, NodeSelection } from "prosemirror-state";
import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
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

class MathView {
  dom: HTMLElement;
  constructor(node: any) {
    this.dom = document.createElement("span");
    this.dom.className = "md-math" + (node.attrs.display ? " md-math-display" : "");
    this.dom.dataset.tex = node.attrs.tex;
    this.dom.textContent = node.attrs.open + node.attrs.tex + node.attrs.close;
    this.dom.title = "Maths. Edit it in Markdown.";
    queueMicrotask(() => drawMath(this.dom.parentNode || document));
  }
  ignoreMutation() { return true; }
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
] });

const hardBreak = chainCommands(exitCode, (state, dispatch) => {
  dispatch?.(state.tr.replaceSelectionWith(nodes.hard_break.create()).scrollIntoView());
  return true;
});

const keys = keymap({
  "Mod-z": undo, "Shift-Mod-z": redo, "Mod-y": redo, Backspace: undoInputRule,
  "Mod-b": toggleMark(marks.strong), "Mod-i": toggleMark(marks.em), "Mod-e": toggleMark(marks.code),
  "Mod-Shift-x": toggleMark(marks.strike), "Mod-k": () => { askLink(); return true; },
  Enter: splitListItem(nodes.list_item), "Shift-Enter": hardBreak, "Mod-Enter": hardBreak,
  Tab: sinkListItem(nodes.list_item), "Shift-Tab": liftListItem(nodes.list_item),
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
  return EditorState.create({ doc, plugins: [caret, rules, keys, keymap(baseKeymap), history(), sync, flashing] });
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

function paintBar(): void {
  if (!view) return;
  for (const button of Array.from(bar.querySelectorAll<HTMLButtonElement>("[data-mark]"))) {
    const on = markActive((marks as any)[button.dataset.mark!]);
    button.setAttribute("aria-pressed", String(on));
  }
  style.value = blockStyle();
  const ask = document.getElementById("cv-ask") as HTMLButtonElement;
  ask.title = view.state.selection.empty ? "Ask ChatDGC about this paragraph" : "Ask ChatDGC about the selection";
}

function run(command: (state: EditorState, dispatch?: any, view?: EditorView) => boolean): void {
  command(view.state, view.dispatch, view);
  view.focus();
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
  ask, shortcuts: () => { flush(); host.postMessage({ type: "shortcuts" }); },
  markdown: () => { flush(); host.postMessage({ type: "markdown" }); },
};

bar.addEventListener("mousedown", (e) => { if ((e.target as HTMLElement).closest("button")) e.preventDefault(); });   // keep the selection
bar.addEventListener("click", (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-do]");
  if (button) actions[button.dataset.do!]?.();
});
style.addEventListener("change", () => {
  const v = style.value;
  run(v === "p" ? setBlockType(nodes.paragraph) : v === "code" ? setBlockType(nodes.code_block)
      : setBlockType(nodes.heading, { level: +v.slice(1) }));
});

view = new EditorView(document.getElementById("cv-editor") as HTMLElement, {
  state: state(source.doc),
  nodeViews: { math_inline: (node) => new MathView(node), raw_block: (node) => new RawView(node) },
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
