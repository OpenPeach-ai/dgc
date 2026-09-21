// A file named in an answer wears its kind, not its extension spelled out mid-sentence.
//
// Codex shows a python mark beside documents.py and a doc mark beside a set of notes, and keeps
// the full path in the hover label. DGC already marked where an EXTERNAL link pointed (github,
// npm, the marketplace) but gave every workspace file the same treatment: none.
//
// The path must stay in the title, because that is the only place it is still readable once the
// sentence stops spelling it out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { mainCss } from "./support/webview-dom.mjs";

// The suite's established way to reach markdown.ts: bundle it, no build artefacts left behind.
const here = fileURLToPath(new URL(".", import.meta.url));
const bundled = buildSync({ entryPoints: [here + "../src/markdown.ts"], bundle: true,
  format: "cjs", write: false, platform: "node" }).outputFiles[0].text;
const markdown = (() => {
  const module = { exports: {} };
  new Function("module", "exports", "require", bundled)(module, module.exports, createRequire(import.meta.url));
  return module.exports;
})();
const { fileKind, linkTarget } = markdown;

test("a file is classified by what it is", () => {
  const cases = [
    ["dgc/agent.py", "python"], ["a.pyi", "python"],
    ["src/main.ts", "ts"], ["x.mts", "ts"],
    ["media/main.js", "js"], ["m.cjs", "js"],
    ["package.json", "json"], ["tsconfig.jsonc", "json"],
    ["NOTES.md", "doc"], ["readme.markdown", "doc"], ["notes.txt", "doc"],
    ["config.yaml", "config"], ["pyproject.toml", "config"], [".env", "config"],
    ["main.css", "css"], ["page.html", "markup"], ["logo.svg", "markup"],
    ["run.sh", "shell"], ["build.ps1", "shell"],
    ["shot.png", "image"], ["photo.jpeg", "image"],
    ["main.rs", "code"], ["App.java", "code"], ["lib.cpp", "code"],
    ["data.sqlite3", "database"], ["dump.sql", "database"],
    ["dgc.tar.gz", "archive"], ["ext.vsix", "archive"],
    ["package-lock.json", "json"],
    ["requirements.lock", "lock"],
    ["Makefile", "file"], ["LICENSE", "file"],
  ];
  for (const [path, expected] of cases) {
    assert.equal(fileKind(path), expected, `${path} should read as ${expected}`);
  }
});

test("an unknown extension still gets a file mark rather than nothing", () => {
  assert.equal(fileKind("model.safetensors"), "file");
  assert.equal(fileKind("a.thing"), "file");
  assert.equal(fileKind(""), "file");
});

test("every kind the classifier can return has a mark drawn for it", () => {
  const css = mainCss;
  const kinds = new Set(["python", "ts", "js", "json", "doc", "config", "css", "markup",
                         "shell", "image", "code", "database", "archive", "lock", "folder"]);
  for (const kind of kinds) {
    assert.match(css, new RegExp(`\\[data-file-kind="${kind}"\\]`),
                 `${kind} has no mark, so it would silently fall back to the generic file glyph`);
  }
  // And the generic one, so a classifier miss is never a bare link.
  assert.match(css, /\.md-link\[data-file-kind\]::before/, "a default mark exists");
});

test("the full path stays in the hover label", () => {
  // The sentence stops spelling the extension out, so the title is the only place the path is
  // still readable. linkTarget keeps it; the renderer puts it in title=.
  const target = linkTarget("dgc/editor_protocol.py:14");
  assert.equal(target.kind, "file");
  assert.equal(target.target, "dgc/editor_protocol.py");
  assert.equal(target.line, 14);
});
