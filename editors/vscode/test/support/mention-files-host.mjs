// The real src/mentionsHost.ts, bundled against a stand-in `vscode` whose workspace is a real folder on disk. Its
// findFiles walks that folder and behaves as VS Code's does where it matters to the @ list: an exclude glob that is
// given is the ONLY exclude (the user's files.exclude setting is then not applied by VS Code: the caller must), and the
// list is cut at the most asked for, in the order the walk finds them. Not a *.test.mjs file.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const { minimatch } = require("minimatch");
const here = dirname(fileURLToPath(import.meta.url));

/** A project folder with these files (paths with "/"), each one line long. */
export function project(paths) {
  const root = mkdtempSync(join(tmpdir(), "dgc-mention-files-"));
  for (const path of paths) { const file = join(root, ...path.split("/")); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "x\n"); }
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}
const walk = (dir, out = []) => { for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const at = join(dir, e.name); if (e.isDirectory()) walk(at, out); else out.push(at); } return out; };

/** src/mentionsHost.ts (DGC_PIPS_SRC: another tree's src folder, to see the list as it was) over `root`. `settings`: the window's files.exclude. Returns the module, and what findFiles was asked. */
export async function mentionsHost(root, settings = {}, src = process.env.DGC_PIPS_SRC) {
  const asked = [];
  const uri = (fsPath) => ({ fsPath, toString: () => "file://" + fsPath });
  const rel = (fsPath) => relative(root, fsPath).split(sep).join("/");
  globalThis.__DGC_MENTIONS_VSCODE = {
    workspace: {
      workspaceFolders: [{ uri: uri(root), name: "project", index: 0 }],
      getWorkspaceFolder: (u) => (u.fsPath.startsWith(root + sep) ? { uri: uri(root), name: "project", index: 0 } : undefined),
      asRelativePath: (u) => rel(u.fsPath),
      getConfiguration: (section) => ({ get: (key) => (section === "files" && key === "exclude" ? settings : undefined) }),
      async findFiles(include, exclude, most) {
        asked.push({ include, exclude, most });
        const all = walk(root).filter((f) => minimatch(rel(f), include, { dot: true }));
        // As VS Code: undefined applies the setting; a glob that is given replaces it.
        const kept = exclude === undefined ? all.filter((f) => !Object.entries(settings).some(([p, on]) => on === true && (minimatch(rel(f), p, { dot: true }) || minimatch(rel(f), p + "/**", { dot: true }))))
          : exclude === null ? all : all.filter((f) => !minimatch(rel(f), exclude, { dot: true }));
        return kept.slice(0, most ?? kept.length).map(uri);
      },
    },
  };
  const out = await build({ entryPoints: [src ? join(src, "mentionsHost.ts") : join(here, "..", "..", "src", "mentionsHost.ts")], bundle: true, write: false, format: "esm", platform: "node",
    plugins: [{ name: "vscode", setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "stub" })); b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = globalThis.__DGC_MENTIONS_VSCODE;", loader: "js" })); } }] });
  const module = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64") + "#" + Math.random());
  return { module, asked };
}
