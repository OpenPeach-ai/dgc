// Maths in Markdown, as ChatDGC draws it (ChatGPT does): TeX between $…$, \(…\), $$…$$ or \[…\] becomes a placeholder
// holding the TeX, which the page draws with KaTeX. Only a page that asks gets it (main DGC's chat doesn't), never in
// code, and money stays money: as pandoc reads it, "$5 and $10" has no maths in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const bundled = buildSync({ entryPoints: [here + "../src/markdown.ts"], bundle: true, format: "cjs", write: false, platform: "node" }).outputFiles[0].text;
const markdown = (() => {
  const module = { exports: {} };
  new Function("module", "exports", "require", bundled)(module, module.exports, createRequire(import.meta.url));
  return module.exports;
})();
const math = (html) => [...html.matchAll(/<(span|div) class="md-math( md-math-display)?" data-tex="([^"]*)">/g)].map((m) => [m[3], m[2] ? "display" : "inline"]);

test("off unless the page asks: main DGC's chat keeps its dollars", () => {
  assert.deepEqual(math(markdown.render("Area: $\\pi r^2$ and $$x$$")), []);
});

test("inline and display maths, in each way a model writes it", () => {
  markdown.setMath(true);
  try {
    assert.deepEqual(math(markdown.render("Area is $\\pi r^2$, or \\(2\\pi r\\) round.")), [["\\pi r^2", "inline"], ["2\\pi r", "inline"]]);
    assert.deepEqual(math(markdown.render("So $$E = mc^2$$ and \\[a^2 + b^2\\] in a line.")), [["E = mc^2", "display"], ["a^2 + b^2", "display"]]);
    assert.deepEqual(math(markdown.render("$$\nA = P\\left(1 + \\frac{r}{n}\\right)^{nt}\n$$\n\nwhere $P$ is what you start with.")),
                     [["\nA = P\\left(1 + \\frac{r}{n}\\right)^{nt}\n", "display"], ["P", "inline"]]);
    assert.deepEqual(math(markdown.render("\\[\nx = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\n\\]")), [["\nx = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\n", "display"]]);
    assert.deepEqual(math(markdown.render("- one: $a_1$\n- two: $a_2$")), [["a_1", "inline"], ["a_2", "inline"]], "in a list");
    assert.match(markdown.render("Area is $\\pi r^2$."), /<span class="md-math" data-tex="\\pi r\^2">\$\\pi r\^2\$<\/span>/,
                 "until it's drawn, the TeX as written");
  } finally { markdown.setMath(false); }
});

test("money, code, an escaped dollar and a lone one stay as they are", () => {
  markdown.setMath(true);
  try {
    for (const text of ["It costs $5 and $10.", "Between $5-$10 a day.", "US$5 and US$6", "Price: $5.", "a $ b", "$ x $",
                        "`$x$` is code", "```\n$$x$$\n```", "Pay \\$5 or \\$6", "    $$x$$ indented is code"]) {
      assert.deepEqual(math(markdown.render(text)), [], text);
    }
    assert.match(markdown.render("Pay \\$5, then $x$"), /Pay \$5, then <span class="md-math"/);
    assert.deepEqual(math(markdown.render(`$${"x".repeat(4001)}$`)), [], "too long to be one");
  } finally { markdown.setMath(false); }
});

test("what a formula holds is text: no markup gets out of it", () => {
  markdown.setMath(true);
  try {
    const html = markdown.render('$x" onmouseover="alert(1)$ and $$<img src=x onerror=alert(1)>$$');
    assert.doesNotMatch(html, /<img|onmouseover="/);
    assert.deepEqual(math(html), [["x&quot; onmouseover=&quot;alert(1)", "inline"], ["&lt;img src=x onerror=alert(1)&gt;", "display"]]);
  } finally { markdown.setMath(false); }
});
