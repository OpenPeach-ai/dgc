// A ChatDGC canvas's Markdown, read into ProseMirror and written back block by block (CHATDGC_PLAN.md, Canvas option
// B). The canvas file is shared: the model changes it with exact find-and-replace, versions are compared line by
// line, and option A opens the same file as Markdown. So a top-level block you didn't touch is written back byte for
// byte, with whatever followed it (blank lines, link definitions); only a block you changed, added or moved is
// written fresh. Anything the editor's schema lacks (tables, HTML, display maths, a block holding one of them) is
// kept as its own Markdown and shown rendered, never rewritten.
import MarkdownIt from "markdown-it";
import { Node, Schema } from "prosemirror-model";
import { MarkdownParser, MarkdownSerializer, defaultMarkdownSerializer, schema as base } from "prosemirror-markdown";
import { addMath } from "./markdownMath";

const baseNodes: any = base.spec.nodes, baseMarks: any = base.spec.marks;

export const schema = new Schema({
  nodes: baseNodes
    .update("heading", { ...baseNodes.get("heading"), content: "inline*" })
    .update("bullet_list", { ...baseNodes.get("bullet_list"),
      attrs: { tight: { default: false }, bullet: { default: "-" } } })
    .update("horizontal_rule", { ...baseNodes.get("horizontal_rule"), attrs: { markup: { default: "---" } } })
    .addToEnd("raw_block", {
      group: "block", atom: true, selectable: true, draggable: false, attrs: { src: { default: "" } },
      toDOM: (node: Node) => ["div", { class: "cv-raw", "data-src": node.attrs.src }],
      parseDOM: [{ tag: "div.cv-raw", getAttrs: (dom: any) => ({ src: dom.getAttribute("data-src") || "" }) }],
    })
    .addToEnd("math_inline", {
      group: "inline", inline: true, atom: true,
      attrs: { tex: { default: "" }, display: { default: false }, open: { default: "$" }, close: { default: "$" } },
      toDOM: (node: Node) => ["span", { class: "md-math" + (node.attrs.display ? " md-math-display" : ""), "data-tex": node.attrs.tex },
                              node.attrs.open + node.attrs.tex + node.attrs.close],
      parseDOM: [{ tag: "span.md-math", getAttrs: (dom: any) => ({ tex: dom.getAttribute("data-tex") || "" }) }],
    }),
  marks: baseMarks.addToEnd("strike", {
    parseDOM: [{ tag: "s" }, { tag: "del" }, { style: "text-decoration=line-through" }],
    toDOM: () => ["s"],
  }),
});

// markdown-it as ChatDGC's replies read it: GitHub's tables and strikethrough, maths, no HTML.
const md = new MarkdownIt("default", { html: false, linkify: false, typographer: false });
addMath(md);

const BLOCK_TOKENS = new Set(["paragraph_open", "paragraph_close", "heading_open", "heading_close", "blockquote_open",
  "blockquote_close", "bullet_list_open", "bullet_list_close", "ordered_list_open", "ordered_list_close",
  "list_item_open", "list_item_close", "code_block", "fence", "hr", "inline"]);
const INLINE_TOKENS = new Set(["text", "softbreak", "hardbreak", "em_open", "em_close", "strong_open", "strong_close",
  "s_open", "s_close", "link_open", "link_close", "code_inline", "image", "math_inline"]);

/** Whether the editor can hold this block's tokens as its own nodes. */
function editable(tokens: any[]): boolean {
  return tokens.every((t) => BLOCK_TOKENS.has(t.type)
    && (t.type !== "inline" || (t.children || []).every((c: any) => INLINE_TOKENS.has(c.type))));
}

function listIsTight(tokens: any[], i: number): boolean {
  while (++i < tokens.length) if (tokens[i].type !== "list_item_open") return tokens[i].hidden;
  return false;
}

// One block's tokens, or one `raw` token holding its Markdown when the editor can't hold it.
const tokenizer = {
  parse(text: string, env: any) {
    const tokens = md.parse(text, env);
    return editable(tokens) ? tokens : [{ type: "raw", content: text, nesting: 0, level: 0, children: null, attrGet: () => null }];
  },
};

const parser: any = new MarkdownParser(schema, tokenizer as any, {
  blockquote: { block: "blockquote" },
  paragraph: { block: "paragraph" },
  list_item: { block: "list_item" },
  bullet_list: { block: "bullet_list", getAttrs: (tok: any, tokens: any[], i: number) => ({ tight: listIsTight(tokens, i), bullet: tok.markup || "-" }) },
  ordered_list: { block: "ordered_list", getAttrs: (tok: any, tokens: any[], i: number) => ({
    order: +tok.attrGet("start") || 1, tight: listIsTight(tokens, i) }) },
  heading: { block: "heading", getAttrs: (tok: any) => ({ level: +tok.tag.slice(1) }) },
  code_block: { block: "code_block", noCloseToken: true },
  fence: { block: "code_block", getAttrs: (tok: any) => ({ params: tok.info || "" }), noCloseToken: true },
  hr: { node: "horizontal_rule", getAttrs: (tok: any) => ({ markup: tok.markup || "---" }) },
  image: { node: "image", getAttrs: (tok: any) => ({ src: tok.attrGet("src"), title: tok.attrGet("title") || null,
    alt: (tok.children && tok.children[0] && tok.children[0].content) || null }) },
  hardbreak: { node: "hard_break" },
  em: { mark: "em" },
  strong: { mark: "strong" },
  s: { mark: "strike" },
  link: { mark: "link", getAttrs: (tok: any) => ({ href: tok.attrGet("href"), title: tok.attrGet("title") || null }) },
  code_inline: { mark: "code", noCloseToken: true },
  math_inline: { node: "math_inline", getAttrs: (tok: any) => ({ tex: tok.content, display: !!tok.meta?.display,
    open: tok.markup || "$", close: tok.info || tok.markup || "$" }) },
  raw: { node: "raw_block", getAttrs: (tok: any) => ({ src: tok.content }) },
});
// A line break inside a paragraph stays a line break (the default makes it a space, so an edited paragraph would
// lose the lines it was written in).
parser.tokenHandlers.softbreak = (state: any) => state.addText("\n");

const serializer = new MarkdownSerializer({
  ...defaultMarkdownSerializer.nodes,
  raw_block(state: any, node: Node) { state.write(String(node.attrs.src).replace(/\n+$/, "")); state.closeBlock(node); },
  math_inline(state: any, node: Node) { state.write(node.attrs.open + node.attrs.tex + node.attrs.close); },
}, {
  ...defaultMarkdownSerializer.marks,
  strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
});

/** A top-level block as read: its own lines, and what followed it up to the next block. */
export interface Piece { index: number; own: string; gap: string }

/** A canvas read for the editor: the document, and where each block it hasn't changed came from. */
export interface Read { doc: Node; sources: WeakMap<Node, Piece>; prefix: string; count: number; newline: boolean }

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  starts.push(text.length);
  return starts;
}

/** One block's node: the Markdown parsed alone, with the whole file's link definitions. */
function blockNode(own: string, references: any): Node {
  let doc: Node | undefined;
  try { doc = parser.parse(own, { references: { ...references } }); } catch { doc = undefined; }
  if (doc && doc.childCount === 1) return doc.firstChild as Node;
  return schema.nodes.raw_block.create({ src: own });
}

export function read(text: string): Read {
  const env: any = {};
  const tokens = md.parse(text, env);
  const starts = lineStarts(text);
  const at = (line: number) => starts[Math.min(line, starts.length - 1)];
  const tops = tokens.filter((t: any) => t.level === 0 && t.nesting !== -1 && t.map);
  const sources = new WeakMap<Node, Piece>();
  const nodes: Node[] = [];
  tops.forEach((t: any, index: number) => {
    const from = at(t.map[0]), to = at(t.map[1]), next = index + 1 < tops.length ? at((tops[index + 1] as any).map[0]) : text.length;
    const piece = { index, own: text.slice(from, to), gap: text.slice(to, next) };
    const node = blockNode(piece.own, env.references || {});
    sources.set(node, piece);
    nodes.push(node);
  });
  if (!nodes.length) nodes.push(schema.nodes.paragraph.create());
  return { doc: schema.topNodeType.create(null, nodes), sources, prefix: tops.length ? text.slice(0, at((tops[0] as any).map[0])) : "",
           count: tops.length, newline: !text || text.endsWith("\n") };
}

/** A block the editor made or changed, as Markdown (no trailing newline). */
export function blockMarkdown(node: Node): string {
  return serializer.serialize(schema.topNodeType.create(null, [node])).replace(/\s+$/, "");
}

function newlines(text: string): number {
  let n = 0;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** The document as Markdown: a block it read and didn't change exactly as it was, anything else written fresh with a
 *  blank line around it. `lines`: where each top-level block is in the text (0-based, inclusive), or null for an
 *  empty paragraph, which has no Markdown. */
export function write(doc: Node, from: Read): { text: string; lines: ([number, number] | null)[] } {
  let out = from.prefix, row = newlines(out), prev = -1, fresh = false;
  const lines: ([number, number] | null)[] = [];
  const blank = () => {
    if (!out || out.endsWith("\n\n")) return;
    const add = out.endsWith("\n") ? "\n" : "\n\n";
    out += add; row += add.length;
  };
  doc.forEach((node) => {
    const piece = from.sources.get(node);
    if (piece) {
      if (piece.index !== prev + 1 || fresh) blank();
      const own = piece.own.replace(/\n$/, "");
      lines.push([row, row + newlines(own)]);
      out += piece.own + piece.gap; row += newlines(piece.own + piece.gap);
      prev = piece.index; fresh = false;
      return;
    }
    const text = blockMarkdown(node);
    if (!text) { lines.push(null); return; }
    blank();
    lines.push([row, row + newlines(text)]);
    out += text + "\n\n"; row += newlines(text) + 2;
    prev = -2; fresh = true;
  });
  // Unless the end is the end it read, it ends as the file did: on one newline, or none.
  if (fresh || prev !== from.count - 1) out = out.replace(/\n+$/, "") + (from.newline && out.trim() ? "\n" : "");
  return { text: out, lines };
}

/** The blocks of `after` that `before` didn't have (by their Markdown), for the change to flash as it lands. */
export function changedBlocks(before: Read, after: Read): number[] {
  const had = new Map<string, number>();
  before.doc.forEach((node) => { const p = before.sources.get(node); if (p) had.set(p.own, (had.get(p.own) || 0) + 1); });
  const changed: number[] = [];
  after.doc.forEach((node, _offset, index) => {
    const p = after.sources.get(node), n = p ? had.get(p.own) || 0 : 0;
    if (p && n > 0) had.set(p.own, n - 1);
    else changed.push(index);
  });
  return changed;
}
