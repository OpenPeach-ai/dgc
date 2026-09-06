import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
async function moduleAt(path) {
  const built = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true,
    platform: "node", format: "cjs", write: false });
  const module = { exports: {} };
  new Function("require", "module", "exports", built.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
const { workspaceFile } = await moduleAt("../src/navigation.ts");
const { linkTarget, render } = await moduleAt("../src/markdown.ts");

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

test("Markdown URLs reject executable schemes and ambiguous network paths", () => {
  for (const value of ["javascript:alert(1)", "command:workbench.action.terminal.new",
    "data:text/html,hello", "file:///etc/passwd", "//example.com/x", "\\\\server\\share",
    "https://user:password@example.com", "java%73cript:alert(1)", "https://exa\nmple.com",
    "a%00.txt", "broken%ZZ", "#heading"]) assert.equal(linkTarget(value), undefined, value);
  assert.deepEqual(linkTarget("/project/My%20File.ts:17"),
    { kind: "file", target: "/project/My File.ts", line: 17 });
  assert.deepEqual(linkTarget("src/file.ts#L42C3"), { kind: "file", target: "src/file.ts", line: 42 });
  assert.deepEqual(linkTarget("C:\\repo\\file.ts:5"), { kind: "file", target: "C:\\repo\\file.ts", line: 5 });
  assert.doesNotThrow(() => render("```text\n\ud800"));
});
