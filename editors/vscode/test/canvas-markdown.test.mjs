// The formatted canvas's Markdown (src/canvasMarkdown.ts): read into the editor and written back block by block. An
// untouched block comes back byte for byte, so the model's exact find-and-replace still finds its text and a version
// shows only what really changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// The module and prosemirror-model from ONE bundle: the editor ships one copy, and a node made with another copy is
// refused ("multiple versions of prosemirror-model").
const code = (await build({ stdin: { contents: 'export * from "./src/canvasMarkdown.ts"; export { Fragment, Slice } from "prosemirror-model";',
  resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" }, bundle: true, write: false, platform: "node", format: "cjs" })).outputFiles[0].text;
const mod = { exports: {} };
new Function("module", "exports", "require", code)(mod, mod.exports, require);
const { read, write, changedBlocks, schema, Fragment, Slice } = mod.exports;

// What a model writes in a canvas: every construct, its own spacing habits included.
const DOC = `# Trip to Goa: 4 days

A slow week by the sea, with *one* busy day and **two** quiet ones.
Second line of the same paragraph.

## Day 1 · Arrive

* Land at 11:40, taxi to Candolim (about ₹1,500).
* Lunch at Fisherman's Wharf.
  1. Ask for the **catch of the day**
  2. Pay by UPI

1. Check in
2. Walk to the beach

> Tip: carry cash for the shacks.

---

| Day | Plan | Cost |
| --- | --- | ---: |
| 1 | Arrive | ₹1,500 |
| 2 | Old Goa | ₹800 |

The budget is $B = n \\times r$ for $n$ nights, and $5 and $10 are just money.

$$
\\text{total} = \\sum_i c_i
$$

\`\`\`python
print("hello")
\`\`\`

See [the map][map] and ~~the old plan~~ <https://example.com>.

[map]: https://maps.example.com/goa "Goa"

<div align="center">kept as written</div>
`;

test("a canvas read and written back untouched is the same file, byte for byte", () => {
  for (const text of [DOC, "", "One line, no newline", "# Heading\nParagraph right under it\n", "\n\n# Leading blank lines\n\n\n", DOC.replace(/\n/g, "\n\n")]) {
    const got = read(text);
    assert.equal(write(got.doc, got).text, text, JSON.stringify(text.slice(0, 40)));
  }
});

test("every block is the editor's own, tables and display maths too (HTML is text, as in a reply)", () => {
  const got = read(DOC);
  const kinds = [];
  got.doc.forEach((node) => kinds.push(node.type.name));
  assert.deepEqual(kinds, ["heading", "paragraph", "heading", "bullet_list", "ordered_list", "blockquote", "horizontal_rule",
    "table", "paragraph", "math_block", "code_block", "paragraph", "paragraph"]);
  const maths = [];
  got.doc.descendants((n) => { if (n.type.name === "math_inline") maths.push(n.attrs.tex); });
  assert.deepEqual(maths, ["B = n \\times r", "n"], "money stays text");
  let link = "";
  got.doc.descendants((n) => { for (const m of n.marks || []) if (m.type.name === "link" && !link) link = m.attrs.href; });
  assert.equal(link, "https://maps.example.com/goa", "a reference link resolves from the definitions the file keeps");
});

test("typing in one block rewrites that block only, and the model's exact text elsewhere is still found", () => {
  const got = read(DOC);
  let pos = 0, target = null;
  got.doc.forEach((node, offset) => { if (!target && node.type.name === "blockquote") { target = node; pos = offset; } });
  const tr = { doc: got.doc };
  // Replace "cash" with "cash and a card" inside the quote.
  const text = target.textContent, at = text.indexOf("cash");
  const inner = pos + 2 + at + "cash".length;                    // blockquote > paragraph > text
  const doc = got.doc.replace(inner, inner, schemaSlice(" and a card"));
  const out = write(doc, got).text;
  assert.equal(out, DOC.replace("carry cash for", "carry cash and a card for"));
  assert.ok(out.includes("| 2 | Old Goa | ₹800 |"), "the table, untouched, is as it was");
});

test("a block added, a block deleted and blocks moved keep the rest exact and a blank line between blocks", () => {
  const got = read("# Title\n\nFirst.\n\nSecond.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
  const [title, first, second, table] = [0, 1, 2, 3].map((i) => got.doc.child(i));
  const added = schema.nodes.paragraph.create(null, schema.text("Added by hand"));
  const moved = schema.topNodeType.create(null, [title, second, added, first, table]);
  assert.equal(write(moved, got).text, "# Title\n\nSecond.\n\nAdded by hand\n\nFirst.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
  const deleted = schema.topNodeType.create(null, [title, first, second]);
  assert.equal(write(deleted, got).text, "# Title\n\nFirst.\n\nSecond.\n", "the end is still one newline");
  const empty = schema.topNodeType.create(null, [title, schema.nodes.paragraph.create(), first, second, table]);
  const { text, lines } = write(empty, got);
  assert.equal(text, "# Title\n\nFirst.\n\nSecond.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n", "an empty paragraph has no Markdown");
  assert.deepEqual(lines, [[0, 0], null, [2, 2], [4, 4], [6, 8]], "each block's lines, for Ask on a selection");
});

test("what the editor writes fresh is Markdown a model writes: bullets, emphasis, maths, strikethrough, links", () => {
  const fresh = read("- a\n- **b** ~~c~~ $x^2$ [d](https://d.example)\n");
  const copy = schema.nodeFromJSON(fresh.doc.toJSON());          // the same content, never read: written fresh
  assert.equal(write(copy, { ...fresh, sources: new WeakMap() }).text, "- a\n- **b** ~~c~~ $x^2$ [d](https://d.example)\n");
});

test("a change the model made flashes only the blocks that are new", () => {
  const before = read("# Plan\n\nDay one.\n\nDay two.\n");
  const after = read("# Plan\n\nDay one, by the sea.\n\nDay two.\n\nDay three.\n");
  assert.deepEqual(changedBlocks(before, after), [1, 3]);
});

// What these tests change, as the editor's commands would: a node's content or attributes, by position.
const at = (doc, name, n = 0) => { const found = []; doc.descendants((node, pos) => { if (node.type.name === name) found.push({ node, pos }); }); return found[n]; };

test("a table: its cells, header and column alignment read; a cell edited writes the table again, nothing else", () => {
  const text = "# Budget\n\n| Day | Plan | Cost |\n|:--|:-:|--:|\n| 1 | Arrive | ₹1,500 |\n| 2 | Old Goa | ₹800 |\n\nThat's it.\n";
  const got = read(text);
  const table = at(got.doc, "table");
  assert.equal(table.node.childCount, 3);
  assert.deepEqual(rowsOf(table.node), [["Day", "Plan", "Cost"], ["1", "Arrive", "₹1,500"], ["2", "Old Goa", "₹800"]]);
  assert.equal(table.node.child(0).child(0).type.name, "table_header");
  assert.deepEqual([0, 1, 2].map((c) => table.node.child(1).child(c).attrs.align), ["left", "center", "right"]);
  // "Old Goa" → "Old Goa | Panjim": a pipe in a cell is escaped, the alignment row kept, the rest of the file exact.
  const cell = at(got.doc, "table_cell", 4);
  const doc = got.doc.replace(cell.pos + 1, cell.pos + 1 + cell.node.content.size,
                              new Slice(Fragment.from(schema.text("Old Goa | Panjim")), 0, 0));
  assert.equal(write(doc, got).text, "# Budget\n\n| Day | Plan | Cost |\n| :--- | :---: | ---: |\n| 1 | Arrive | ₹1,500 |\n"
    + "| 2 | Old Goa \\| Panjim | ₹800 |\n\nThat's it.\n");
  assert.deepEqual(rowsOf(at(read(write(doc, got).text).doc, "table").node)[2], ["2", "Old Goa | Panjim", "₹800"], "and it reads back the same");
});

test("a table inside a list stays as its Markdown (its lines carry the list's indent)", () => {
  const got = read("- Costs:\n\n  | a | b |\n  | - | - |\n  | 1 | 2 |\n");
  assert.equal(got.doc.child(0).type.name, "raw_block");
});

test("display maths is a block of its own: edited, it's written as $$ lines; untouched, as it was", () => {
  const text = "Total:\n\n$$\n\\sum_i c_i\n$$\n\nAnd \\[x\\] too.\n\n\\[\na + b\n\\]\n";
  const got = read(text);
  assert.equal(write(got.doc, got).text, text);
  const block = at(got.doc, "math_block");
  assert.equal(block.node.attrs.tex, "\\sum_i c_i");
  const doc = got.doc.replace(block.pos, block.pos + 1, new Slice(Fragment.from(
    schema.nodes.math_block.create({ ...block.node.attrs, tex: "\\sum_{i=1}^{n} c_i" })), 0, 0));
  assert.equal(write(doc, got).text, text.replace("\\sum_i c_i", "\\sum_{i=1}^{n} c_i"));
  const second = at(got.doc, "math_block", 1);
  assert.deepEqual([second.node.attrs.open, second.node.attrs.close, second.node.attrs.tex], ["\\[", "\\]", "a + b"]);
});

test("a checklist: each item ticked or not, the box not part of its text; ticking one rewrites only that list", () => {
  const text = "Packing:\n\n- [ ] Passport\n- [x] Tickets\n- Sunscreen\n\n1. [X] Book the taxi\n";
  const got = read(text);
  assert.equal(write(got.doc, got).text, text, "untouched, exact");
  const items = [0, 1, 2, 3].map((n) => at(got.doc, "list_item", n).node);
  assert.deepEqual(items.map((i) => [i.attrs.checked, i.textContent]),
    [[false, "Passport"], [true, "Tickets"], [null, "Sunscreen"], [true, "Book the taxi"]]);
  const first = at(got.doc, "list_item");
  const doc = got.doc.replace(first.pos, first.pos + first.node.nodeSize, new Slice(Fragment.from(
    schema.nodes.list_item.create({ checked: true }, first.node.content)), 0, 0));
  assert.equal(write(doc, got).text, text.replace("- [ ] Passport", "- [x] Passport"));
  // Written fresh, a checklist is GitHub's: "- [ ] " and "- [x] ".
  const fresh = schema.nodes.bullet_list.create({ tight: true }, [
    schema.nodes.list_item.create({ checked: false }, schema.nodes.paragraph.create(null, schema.text("Charger"))),
    schema.nodes.list_item.create({ checked: true }, schema.nodes.paragraph.create(null, schema.text("Hat")))]);
  assert.equal(write(schema.topNodeType.create(null, [fresh]), { ...read(""), sources: new WeakMap() }).text, "- [ ] Charger\n- [x] Hat\n");
  assert.equal(read("- [ ]x not a box\n- [] nor this\n").doc.child(0).child(0).attrs.checked, null);
});

function rowsOf(table) {
  const rows = [];
  table.forEach((row) => { const cells = []; row.forEach((cell) => cells.push(cell.textContent)); rows.push(cells); });
  return rows;
}

function schemaSlice(text) {
  return new Slice(Fragment.from(schema.text(text)), 0, 0);
}
