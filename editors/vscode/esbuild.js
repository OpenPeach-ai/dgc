const esbuild = require("esbuild");
const { execFileSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const selfHosted = process.env.DGC_SELF_HOSTED === "true";

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
    // Only the self-hosted .vsix build enables the update-check nudge; registry
    // builds auto-update, so DGC_SELF_HOSTED=false keeps them from nagging.
    define: {
      "process.env.DGC_SELF_HOSTED": JSON.stringify(selfHosted ? "true" : "false"),
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
