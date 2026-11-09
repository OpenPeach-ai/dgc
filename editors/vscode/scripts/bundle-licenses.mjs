// The third-party license files for what DGC bundles into its pages (mermaid, KaTeX, the canvas editor), made from what
// esbuild actually puts in each bundle and the versions installed, never by hand: a hand-kept list went stale (it named
// mermaid 12.0.0 and KaTeX 0.16.47 while 12.2.0 and 0.18.2 shipped).
//
//   node scripts/bundle-licenses.mjs           rewrite licenses/*.txt from node_modules
//   node scripts/bundle-licenses.mjs --check   exit 1, naming what differs, when a file is not what it would write
//
// Run it after any dependency update (docs/RELEASING.md); test/bundle-licenses.test.mjs runs --check.
import { build } from "esbuild";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULE = "-".repeat(60);
const LOADERS = { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".ttf": "dataurl", ".woff2": "dataurl", ".woff": "dataurl" };

export const FILES = [
  {
    file: "licenses/MERMAID-LICENSES.txt", entry: "src/mermaid-entry.mts",
    header: "DGC bundled diagram renderer (dist/mermaid.js) — third-party licenses\n\n"
      + "dist/mermaid.js is built from mermaid and the packages listed below. Each package's\n"
      + "license is reproduced in full. Where a package declares a license in its manifest but\n"
      + "ships no license file, that is stated instead of guessed.\n\n",
  },
  {
    file: "licenses/PROSEMIRROR-LICENSES.txt", entry: "src/canvasEditor.ts",
    header: "DGC bundled formatted-canvas editor (ChatDGC canvas) — third-party licenses\n\n"
      + "dist/canvas.js is built from ProseMirror and the packages listed below. Each package's\n"
      + "license is reproduced in full. markdown-it and its parts, also in dist/canvas.js, are in\n"
      + "licenses/MARKDOWN-LICENSES.txt.\n\n",
    coveredBy: "licenses/MARKDOWN-LICENSES.txt",
  },
  {
    file: "licenses/KATEX-LICENSE.txt", entry: "src/katex-entry.mts", only: "katex",
    header: "DGC bundled maths renderer — third-party license\n\n",
    title: (p) => `${p.name} ${p.version} (the library, its stylesheet and its fonts)`,
  },
];

function packageOf(file) {
  let dir = dirname(file);
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const p = JSON.parse(readFileSync(manifest, "utf8"));
      if (p.name && p.version) return { dir, name: p.name, version: p.version, license: typeof p.license === "string" ? p.license : p.license?.type || "" };
    }
    const up = dirname(dir);
    if (up === dir) throw new Error(`no package.json above ${file}`);
    dir = up;
  }
}

function licenseText(p) {
  const names = readdirSync(p.dir).filter((n) => /^(licen[cs]e|copying)([.-][a-z0-9]+)?(\.(md|txt))?$/i.test(n)).sort();
  const pick = names.find((n) => /^licen[cs]e$/i.test(n)) || names[0];
  return pick ? readFileSync(join(p.dir, pick), "utf8").trim() : "";
}

export async function bundled(entry) {
  const result = await build({ absWorkingDir: ROOT, entryPoints: [entry], bundle: true, write: false, metafile: true, format: "iife",
    platform: "browser", outdir: "out-licenses", minify: true, loader: LOADERS, logLevel: "silent" });
  const found = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.includes("node_modules/")) continue;
    const p = packageOf(join(ROOT, input.replace(/^[a-z-]+:/, "")));
    found.set(`${p.name}@${p.version}`, p);
  }
  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1));
}

function covered(file) {
  if (!file) return new Set();
  const text = readFileSync(join(ROOT, file), "utf8");
  return new Set([...text.matchAll(/^(@?[a-z0-9][\w.-]*(?:\/[\w.-]+)?) \d+\.\d+\.\d+\S*(?: —|$)/gm)].map((m) => m[1]));
}

export async function render(spec) {
  const skip = covered(spec.coveredBy);
  const packages = (await bundled(spec.entry)).filter((p) => (spec.only ? p.name === spec.only : !skip.has(p.name)));
  if (!packages.length) throw new Error(`${spec.entry}: nothing bundled from node_modules`);
  let out = spec.header;
  for (const p of packages) {
    const text = licenseText(p);
    out += `${spec.title ? spec.title(p) : `${p.name} ${p.version} — ${p.license || (text ? "see text" : "no license declared")}`}\n${RULE}\n`;
    out += text || `${p.name} declares ${p.license || "no license"} in its package.json and ships no license file.`;
    out += "\n\n";
  }
  return out.trimEnd() + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const spec of FILES) {
    const want = await render(spec), path = join(ROOT, spec.file);
    const have = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (want === have) continue;
    if (check) {
      stale++;
      const names = (s) => new Set(s.split("\n").filter((l) => / \d+\.\d+\.\d+/.test(l) && !l.startsWith(" ")).map((l) => l.trim()));
      const a = names(have), b = names(want);
      console.error(`${relative(ROOT, path)} is stale: run node scripts/bundle-licenses.mjs`);
      for (const line of b) if (!a.has(line)) console.error(`  + ${line}`);
      for (const line of a) if (!b.has(line)) console.error(`  - ${line}`);
    } else {
      writeFileSync(path, want);
      console.log(`wrote ${relative(ROOT, path)}`);
    }
  }
  process.exit(stale ? 1 : 0);
}
