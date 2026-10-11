// The formatted canvas's Markdown (src/canvasMarkdown.ts): read into the editor and written back block by block. An
// untouched block comes back byte for byte, so the model's exact find-and-replace still finds its text and a version
// shows only what really changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const code = (await build({ entryPoints: [new URL("../src/canvasMarkdown.ts", import.meta.url).pathname], bundle: true,
  write: false, platform: "node", format: "cjs" })).outputFiles[0].text;
const mod = { exports: {} };
new Function("module", "exports", "require", code)(mod, mod.exports, require);
const { read, write, changedBlocks, schema } = mod.exports;

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

test("tables and display maths are kept as their Markdown; the rest is the editor's own (HTML is text, as in a reply)", () => {
  const got = read(DOC);
  const kinds = [];
  got.doc.forEach((node) => kinds.push(node.type.name));
  assert.deepEqual(kinds, ["heading", "paragraph", "heading", "bullet_list", "ordered_list", "blockquote", "horizontal_rule",
    "raw_block", "paragraph", "raw_block", "code_block", "paragraph", "paragraph"]);
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

function schemaSlice(text) {
  const { Slice, Fragment } = require("prosemirror-model");
  return new Slice(Fragment.from(schema.text(text)), 0, 0);
}
