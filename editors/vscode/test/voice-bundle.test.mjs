// DGC carries DGC Voice inside its own VSIX, as dist/dgc-voice.vsix, until DGC Voice is on the Marketplace and Open
// VSX: esbuild.js packs editors/vscode-voice (packVoice), .vscodeignore lets the file in, and src/voiceInstall.ts
// installs it. This packs the real thing -- DGC Voice with the build's own packVoice, then DGC's VSIX with vsce, as a
// release does (only the bundling is skipped: it doesn't change which files are packed) -- and reads what came out.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { packVoice, VOICE_DIR } = require("../esbuild.js");
const scratch = mkdtempSync(join(tmpdir(), "dgc-voice-bundle-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const voicePackage = JSON.parse(readFileSync(join(VOICE_DIR, "package.json"), "utf8"));

/** A ZIP's files by name (VSIX is a ZIP), read from its central directory. */
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "a ZIP");
  const files = new Map();
  for (let i = 0, at = buffer.readUInt32LE(end + 16); i < buffer.readUInt16LE(end + 10); i++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50, "a central directory entry");
    const method = buffer.readUInt16LE(at + 10), size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28), extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42), name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

test("DGC's VSIX carries DGC Voice as dist/dgc-voice.vsix, at editors/vscode-voice's version, as a ui extension", () => {
  // DGC's extension folder as a release packs it, with stand-ins for the bundles esbuild.js writes.
  const ext = join(scratch, "ext");
  cpSync(root, ext, { recursive: true, filter: (from) => !["node_modules", "dist", "test", "src", "out"].includes(basename(from)) || dirname(from) !== root });
  mkdirSync(join(ext, "dist"), { recursive: true });
  for (const bundle of ["extension.js", "build.json"]) writeFileSync(join(ext, "dist", bundle), "{}\n");
  const version = packVoice(join(ext, "dist", "dgc-voice.vsix"));
  assert.equal(version, voicePackage.version);

  const out = join(scratch, "dgc.vsix");
  const vscePackage = require.resolve("@vscode/vsce/out/package.js");
  execFileSync(process.execPath, ["-e", `require(${JSON.stringify(vscePackage)}).pack(${JSON.stringify({ cwd: ext, packagePath: out, dependencies: false })})
    .catch((e) => { console.error(e); process.exit(1); })`], { cwd: ext, stdio: ["ignore", "pipe", "pipe"] });
  const dgc = unzip(readFileSync(out));
  assert.ok(dgc.has("extension/dist/dgc-voice.vsix"), `dist/dgc-voice.vsix is in DGC's VSIX (${[...dgc.keys()].filter((n) => n.includes("dist/")).join(", ")})`);
  assert.deepEqual(dgc.get("extension/dist/dgc-voice.vsix"), readFileSync(join(ext, "dist", "dgc-voice.vsix")), "byte for byte the file the build packed");

  const voice = unzip(dgc.get("extension/dist/dgc-voice.vsix"));
  const manifest = JSON.parse(voice.get("extension/package.json").toString("utf8"));
  assert.equal(manifest.name, "dgc-voice");
  assert.equal(manifest.publisher, "vibedgc");
  assert.equal(manifest.version, voicePackage.version, "the version editors/vscode-voice says");
  assert.deepEqual(manifest.extensionKind, ["ui"], "it runs on the computer you're at, in a Remote window too");
  const vsixmanifest = voice.get("extension.vsixmanifest").toString("utf8");
  assert.match(vsixmanifest, new RegExp(`<Identity Language="en-US" Id="dgc-voice" Version="${voicePackage.version.replace(/\./g, "\\.")}" Publisher="vibedgc" />`));
  assert.match(vsixmanifest, /Id="Microsoft\.VisualStudio\.Code\.ExtensionKind" Value="ui"/);
  for (const [member, source] of [["extension/extension.js", "extension.js"], ["extension/recording.js", "recording.js"],
                                  ["extension/recorders/record-mac.js", "recorders/record-mac.js"], ["extension/recorders/record-win.ps1", "recorders/record-win.ps1"],
                                  ["extension/package.json", "package.json"]]) {
    assert.deepEqual(voice.get(member), readFileSync(join(VOICE_DIR, source)), `${member} is editors/vscode-voice's ${source}`);
  }
  assert.ok(![...voice.keys()].some((name) => name.includes("/test/")), "its tests stay out");
});

test("the same source packs to the same bytes, whatever the time zone (the registry and self-hosted VSIX must match)", () => {
  const a = join(scratch, "a.vsix"), b = join(scratch, "b.vsix");
  packVoice(a);
  const zone = process.env.TZ;
  process.env.TZ = "Asia/Kolkata";
  try { packVoice(b); } finally { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; }
  assert.deepEqual(readFileSync(a), readFileSync(b));
});

test("a DGC Voice that won't pack stops the build, and leaves no file behind", () => {
  const broken = join(scratch, "broken-voice");
  cpSync(VOICE_DIR, broken, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(broken, "package.json"), "utf8"));
  delete manifest.engines;                        // vsce refuses an extension that names no VS Code
  writeFileSync(join(broken, "package.json"), JSON.stringify(manifest));
  const out = join(scratch, "broken.vsix");
  writeFileSync(out, "an older build's file");
  assert.throws(() => packVoice(out, broken), /DGC Voice \(editors\/vscode-voice\) couldn't be packed into dist\/dgc-voice\.vsix/);
  assert.equal(existsSync(out), false, "no stale file to ship by mistake");
  rmSync(join(broken, "package.json"));
  assert.throws(() => packVoice(out, broken), /couldn't be packed/);
  assert.equal(existsSync(out), false);
});

test("the build packs it every time, before the bundles, and tells the extension which version it packed", () => {
  const build = readFileSync(join(root, "esbuild.js"), "utf8");
  const main = build.slice(build.indexOf("async function main()"));
  assert.match(main, /const voiceVersion = packVoice\(\);/);
  assert.ok(main.indexOf("packVoice()") < main.indexOf("esbuild.build("), "packed before anything else is built");
  assert.match(build, /"process\.env\.DGC_VOICE_VERSION": JSON\.stringify\(voiceVersion\)/);
  assert.match(readFileSync(join(root, ".vscodeignore"), "utf8"), /^!dist\/dgc-voice\.vsix$/m);
});
