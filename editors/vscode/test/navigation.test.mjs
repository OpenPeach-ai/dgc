import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import * as fsp from "node:fs/promises";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
async function moduleAt(path, overrides = {}) {
  const built = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true,
    platform: "node", format: "cjs", write: false });
  const module = { exports: {} };
  new Function("require", "module", "exports", built.outputFiles[0].text)((name) => overrides[name] || require(name), module, module.exports);
  return module.exports;
}
const { workspaceFile, workspaceImage, THUMB_MAX_BYTES } = await moduleAt("../src/navigation.ts");
const { linkTarget, render } = await moduleAt("../src/markdown.ts");

test("a preview refuses a file replaced by an external symlink after workspace validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "dgc-thumb-race-"));
  try {
    const project = join(root, "project"), target = join(project, "shot.png"), outside = join(root, "private.png");
    await mkdir(project);
    await writeFile(target, "allowed image");
    await writeFile(outside, "private image");
    let swapped = false;
    const reader = await moduleAt("../src/navigation.ts", {"fs/promises": {...fsp, stat: async (path, ...args) => {
      const info = await fsp.stat(path, ...args);
      if (path === target && !swapped) {
        swapped = true;
        await rm(target); await symlink(outside, target);
      }
      return info;
    }}});
    assert.equal(await reader.workspaceImage("shot.png", [project]), "", "never return the outside file's bytes");
    assert.equal(swapped, true, "the replacement happened after the original file was checked");
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("file navigation follows only canonical paths within currently open roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "dgc-navigation-"));
  try {
    const project = join(root, "project"), secondary = join(root, "secondary");
    await mkdir(project); await mkdir(secondary);
    await writeFile(join(project, "app.ts"), "export {};\n");
    await writeFile(join(secondary, "test.ts"), "export {};\n");
    await writeFile(join(root, "private.txt"), "private fixture\n");
    await symlink(root, join(project, "escape"), "dir");
    assert.equal(await workspaceFile("app.ts", [project]), join(project, "app.ts"));
    assert.equal(await workspaceFile("test.ts", [project, secondary]), join(secondary, "test.ts"));
    for (const value of ["../private.txt", "escape/private.txt", join(root, "private.txt"),
      "missing.ts", "app.ts\0", 42, project]) {
      assert.equal(await workspaceFile(value, [project]), undefined);
    }
    assert.equal(await workspaceFile(join(secondary, "test.ts"), [project]), undefined,
      "a removed root loses its file navigation grant");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a shown image's tile picture is read only inside the workspace, only for raster images, only up to 8 MB", async () => {
  const root = await mkdtemp(join(tmpdir(), "dgc-thumb-"));
  try {
    const project = join(root, "project");
    await mkdir(project);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    await writeFile(join(project, "shot.png"), png);
    await writeFile(join(project, "photo.JPG"), png);
    await writeFile(join(project, "logo.svg"), "<svg onload=alert(1)/>");
    await writeFile(join(project, "notes.txt"), "text");
    await writeFile(join(root, "private.png"), png);
    await symlink(join(root, "private.png"), join(project, "link.png"));
    await writeFile(join(project, "huge.png"), Buffer.alloc(THUMB_MAX_BYTES + 1));
    await writeFile(join(project, "edge.png"), Buffer.alloc(THUMB_MAX_BYTES));
    assert.equal(await workspaceImage("shot.png", [project]), `data:image/png;base64,${png.toString("base64")}`);
    assert.match(await workspaceImage("photo.JPG", [project]), /^data:image\/jpeg;base64,/);
    assert.match(await workspaceImage("edge.png", [project]), /^data:image\/png;base64,/, "8 MB exactly is allowed");
    for (const value of ["logo.svg", "notes.txt", "huge.png", "link.png", "../private.png", join(root, "private.png"),
      "missing.png", "shot.png\0", 42, undefined]) {
      assert.equal(await workspaceImage(value, [project]), "", `refused: ${String(value)}`);
    }
    assert.equal(await workspaceImage("shot.png", []), "", "no open folder, no picture");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Markdown URLs reject executable schemes and ambiguous network paths", () => {
  for (const value of ["javascript:alert(1)", "command:workbench.action.terminal.new",
    "data:text/html,hello", "file:///etc/passwd", "//example.com/x", "\\\\server\\share",
    "https://user:password@example.com", "java%73cript:alert(1)", "https://exa\nmple.com",
    "a%00.txt", "broken%ZZ", "#heading", "javascript:1", "command:1", "data:12", "vscode:1", "file:2",
    "java%73cript:1", "mailto:a@b.c", "#L12"]) assert.equal(linkTarget(value), undefined, value);
  // A bare file name with its line (no folder): "README.md:" looked like a scheme, so the link stayed raw text.
  assert.deepEqual(linkTarget("README.md:1"), { kind: "file", target: "README.md", line: 1 });
  assert.deepEqual(linkTarget("Makefile:3:7"), { kind: "file", target: "Makefile", line: 3 });
  assert.deepEqual(linkTarget("setup.py#L40"), { kind: "file", target: "setup.py", line: 40 });
  assert.match(render("[README.md](README.md:1) has one heading."), /<button type="button" class="md-link" data-link-kind="file" data-target="README.md"/);
  assert.ok(!render("[README.md](README.md:1)").includes("](README.md:1)"), "never left as raw Markdown");
  assert.deepEqual(linkTarget("/project/My%20File.ts:17"),
    { kind: "file", target: "/project/My File.ts", line: 17 });
  assert.deepEqual(linkTarget("src/file.ts#L42C3"), { kind: "file", target: "src/file.ts", line: 42 });
  assert.deepEqual(linkTarget("C:\\repo\\file.ts:5"), { kind: "file", target: "C:\\repo\\file.ts", line: 5 });
  assert.doesNotThrow(() => render("```text\n\ud800"));
});

test("highlighted code preserves source and escapes executable markup", () => {
  const source = 'const value = "<script>alert(1)</script>";\n';
  const html = render('```javascript\n' + source + '```');
  assert.match(html, /hljs-keyword/);
  assert.ok(html.includes(encodeURIComponent(source)));
  assert.ok(!html.includes('<script>'));
  assert.ok(!render('```unknown\n' + source + '```').includes('hljs-'));
  assert.ok(!render('```javascript\n' + 'const x = 1;\n'.repeat(2000) + '```').includes('hljs-'));
});
