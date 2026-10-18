const esbuild = require("esbuild");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const selfHosted = process.env.DGC_SELF_HOSTED === "true";

// DGC Voice (editors/vscode-voice) isn't on the Marketplace or Open VSX yet, so DGC carries it: this file, which
// .vscodeignore lets into DGC's own VSIX, is what "Install DGC Voice" installs (src/voiceInstall.ts).
const VOICE_DIR = resolve(__dirname, "../vscode-voice");
const VOICE_VSIX = resolve(__dirname, "dist/dgc-voice.vsix");
/** One date for every file in it (2000-01-01 12:00 UTC), unless the build sets its own. */
const VOICE_EPOCH = "946728000";

/** Packs DGC Voice into `out` and returns its version. The same source gives the same bytes: one file date, sorted
 *  files and UTC, so the registry and self-hosted packages, built one after the other, carry the same file. A
 *  failure stops the build: a DGC without it would offer an install that can't happen. */
function packVoice(out = VOICE_VSIX, source = VOICE_DIR) {
  mkdirSync(dirname(out), { recursive: true });
  rmSync(out, { force: true });
  let version = "";
  try {
    version = JSON.parse(readFileSync(resolve(source, "package.json"), "utf8")).version;
    const vsce = resolve(dirname(require.resolve("@vscode/vsce/package.json")), "vsce");
    execFileSync(process.execPath, [vsce, "package", "--no-dependencies", "--out", out], {
      cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH || VOICE_EPOCH, TZ: "UTC" },
    });
  } catch (error) {
    rmSync(out, { force: true });
    const said = String(error.stderr || error.stdout || error.message || error).trim();
    throw new Error(`DGC Voice (editors/vscode-voice) couldn't be packed into dist/dgc-voice.vsix:\n${said}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(version)) || !existsSync(out)) {
    rmSync(out, { force: true });
    throw new Error("DGC Voice (editors/vscode-voice) didn't pack into dist/dgc-voice.vsix");
  }
  return version;
}

function sourceCommit() {
  const requested = (process.env.DGC_SOURCE_COMMIT || "").trim();
  let head = "";
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: resolve(__dirname, "../.."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // An explicit commit still permits a reproducible build from an exported source tree.
  }
  if (requested && head && requested !== head) {
    throw new Error("DGC_SOURCE_COMMIT does not match the checked-out HEAD");
  }
  const commit = requested || head;
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("a full 40-character DGC_SOURCE_COMMIT is required for extension builds");
  }
  return commit;
}

async function main() {
  const coreVersion = readFileSync(resolve(__dirname, "../../dgc/__init__.py"), "utf8")
    .match(/__version__\s*=\s*"([^"]+)"/)?.[1];
  const minimumCli = require("./package.json").dgcCliVersion;
  const parts = (value) => String(value).split(".").map((n) => Number(n));
  const coreParts = parts(coreVersion);
  const minimumParts = parts(minimumCli);
  const coreMeetsMinimum = coreParts.length === 3 && minimumParts.length === 3
    && coreParts.every((n) => Number.isInteger(n) && n >= 0)
    && minimumParts.every((n) => Number.isInteger(n) && n >= 0)
    && (coreParts[0] > minimumParts[0]
      || (coreParts[0] === minimumParts[0] && coreParts[1] > minimumParts[1])
      || (coreParts[0] === minimumParts[0] && coreParts[1] === minimumParts[1]
        && coreParts[2] >= minimumParts[2]));
  if (!coreMeetsMinimum) {
    throw new Error("package.json dgcCliVersion is newer than the reviewed CLI source version");
  }
  const voiceVersion = packVoice();
  await esbuild.build({
    entryPoints: ["src/markdown.ts"], bundle: true, format: "iife",
    globalName: "DgcMarkdown", platform: "browser", target: "chrome108",
    outfile: "dist/markdown.js", minify: production, sourcemap: false,
    legalComments: "inline",
  });
  // Mermaid is ~5MB bundled, so it is a separate file the webview loads only when a diagram
  // actually appears. Keeping it out of main.js means a panel that never renders one never
  // parses it. dist/ is generated, so the blob is built here rather than committed.
  await esbuild.build({
    entryPoints: ["src/mermaid-entry.mts"], bundle: true, format: "iife",
    platform: "browser", target: "chrome108",
    outfile: "dist/mermaid.js", minify: true, sourcemap: false,
    legalComments: "inline",
  });
  // KaTeX (maths in ChatDGC's replies) is ~270KB, loaded only when a reply has a formula, as mermaid is. Its
  // stylesheet keeps only the WOFF2 fonts: every webview reads them, so the WOFF and TTF copies would be dead weight.
  await esbuild.build({
    entryPoints: ["src/katex-entry.mts"], bundle: true, format: "iife",
    platform: "browser", target: "chrome108",
    outfile: "dist/katex/katex.js", minify: true, sourcemap: false,
    legalComments: "inline",
  });
  await esbuild.build({
    entryPoints: [require.resolve("katex/dist/katex.min.css")], bundle: true,
    outfile: "dist/katex/katex.css", minify: true, sourcemap: false,
    loader: { ".woff2": "file" }, assetNames: "fonts/[name]",
    plugins: [{
      name: "katex-woff2-only",
      setup(build) {
        build.onLoad({ filter: /katex\.min\.css$/ }, (args) => ({
          contents: readFileSync(args.path, "utf8")
            .replace(/,\s*url\([^)]*\.woff\)\s*format\(["']woff["']\)/g, "")
            .replace(/,\s*url\([^)]*\.ttf\)\s*format\(["']truetype["']\)/g, ""),
          loader: "css", resolveDir: resolve(args.path, ".."),
        }));
      },
    }],
  });
  await esbuild.build({
    entryPoints: ["src/settingsClient.js"], bundle: true, format: "iife",
    loader: { ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" },
    platform: "browser", target: "chrome108", outfile: "dist/settings.js",
    minify: production, sourcemap: false,
  });
  await esbuild.build({
    entryPoints: ["src/pipsClient.js"], bundle: true, format: "iife",
    platform: "browser", target: "chrome108", outfile: "dist/pips.js",
    minify: production, sourcemap: false,
  });
  await esbuild.build({
    // ChatDGC's formatted canvas: ProseMirror over the canvas's Markdown (src/canvasDoc.ts hosts it).
    entryPoints: ["src/canvasEditor.ts"], bundle: true, format: "iife",
    platform: "browser", target: "chrome108", outfile: "dist/canvas.js",
    minify: production, sourcemap: false,
  });
  await esbuild.build({
    // An ES module: noVNC (the computer's screen) uses top-level await.
    entryPoints: ["src/pipComputerClient.js"], bundle: true, format: "esm",
    platform: "browser", target: "chrome108", outfile: "dist/pipComputer.js",
    loader: { ".jpg": "dataurl" },                  // the desktop's wallpaper, inside its stylesheet
    minify: production, sourcemap: false,
  });
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    external: ["vscode"],
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: "info",
    // Keep the distribution marker for builds; update checks now cover every channel.
    define: {
      "process.env.DGC_SELF_HOSTED": JSON.stringify(selfHosted ? "true" : "false"),
      // The DGC Voice in dist/dgc-voice.vsix: the gallery's is used instead only when it isn't older.
      "process.env.DGC_VOICE_VERSION": JSON.stringify(voiceVersion),
    },
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
  const pkg = require("./package.json");
  writeFileSync("dist/build.json", `${JSON.stringify({
    flavor: selfHosted ? "selfhost" : "registry",
    schema_version: 1,
    source_commit: sourceCommit(),
    version: pkg.version,
  })}\n`, "utf8");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { packVoice, VOICE_DIR };
