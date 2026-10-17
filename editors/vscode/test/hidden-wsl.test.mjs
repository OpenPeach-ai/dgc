// Hidden WSL (src/wslHost.ts, src/wslPaths.ts): on native Windows, `dgc serve` runs in a distro DGC owns, started
// through wsl.exe with no shell, and every path that crosses is translated both ways.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dgc-hidden-wsl-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const load = async (name) => {
  const outfile = join(scratch, `${name}.cjs`);
  await build({ entryPoints: [join(here, `../src/${name}.ts`)], bundle: true, outfile, platform: "node", format: "cjs", logLevel: "silent" });
  return createRequire(import.meta.url)(outfile);
};
// All three before any test is defined: a build awaited between tests let the earlier ones finish and the
// cleanup below delete the scratch folder first ("Cannot find module …/wslBridge.cjs", ~/dgc-release 2026-10-17).
const paths = await load("wslPaths");
const host = await load("wslHost");
const wire = await load("wslBridge");

test("a Windows path is the distro's /mnt path, and back", () => {
  const map = paths.pathMap("DGC");
  const pairs = [
    ["C:\\Users\\Me\\My Project", "/mnt/c/Users/Me/My Project"],
    ["D:\\", "/mnt/d"],
    ["c:/work/app/x.py", "/mnt/c/work/app/x.py"],
    ["\\\\?\\C:\\very\\long", "/mnt/c/very/long"],
    ["\\\\wsl.localhost\\DGC\\home\\dgc\\.dgc\\troupes", "/home/dgc/.dgc/troupes"],
    ["\\\\wsl$\\dgc\\tmp", "/tmp"],
  ];
  for (const [windows, linux] of pairs) { assert.equal(map.toLinux(windows), linux, windows); }
  assert.equal(map.toWindows("/mnt/c/Users/Me/My Project"), "C:\\Users\\Me\\My Project");
  assert.equal(map.toWindows("/mnt/d"), "D:\\");
  assert.equal(map.toWindows("/home/dgc/.dgc/troupes/tr-0123456789"), "\\\\wsl.localhost\\DGC\\home\\dgc\\.dgc\\troupes\\tr-0123456789");
  for (const left of ["src/app.py", "\\\\server\\share\\x", "\\\\wsl.localhost\\Ubuntu\\home\\me", "", "https://x.example/a"]) {
    assert.equal(map.toLinux(left), left, `left alone: ${left}`);
  }
  assert.equal(map.toWindows("relative/x"), "relative/x");
  assert.equal(paths.pathMap("DGC", "/win").toLinux("C:\\a"), "/win/c/a", "wsl.conf's automount root");
  assert.equal(paths.pathMap("DGC", "/win/").toWindows("/win/e/x"), "E:\\x");
  assert.equal(paths.pathMap("DGC").toWindows("/mnt/cdrom/x"), "\\\\wsl.localhost\\DGC\\mnt\\cdrom\\x", "not a drive letter");
});

test("DGC starts in the distro through wsl.exe, in the Windows folder, with no shell", () => {
  const env = { SystemRoot: "C:\\Windows", WSLENV: "MYVAR/p", DGC_SKIP_EXTENSION: "1", PATH: "C:\\x" };
  const spec = host.launch("DGC", "C:\\Users\\Me\\proj; rm -rf /", ["serve"], env);
  assert.equal(spec.command, "C:\\Windows\\System32\\wsl.exe");
  assert.deepEqual(spec.args, ["-d", "DGC", "--cd", "C:\\Users\\Me\\proj; rm -rf /", "--exec", "/home/dgc/.local/bin/dgc", "serve"]);
  assert.equal(spec.env.WSL_UTF8, "1");
  assert.equal(spec.env.WSLENV, "MYVAR/p:DGC_SKIP_EXTENSION/u", "the user's own WSLENV is kept");
  assert.equal(host.launch("DGC", undefined, ["serve"], { SystemRoot: "C:\\Windows" }).env.WSLENV, "");
  assert.equal(host.distroName("My Distro; x"), "DGC", "an unsafe name falls back");
  assert.equal(host.distroName("DGC-test.2"), "DGC-test.2");
});

test("wsl.exe's UTF-16 output and its UTF-8 output read the same", () => {
  const utf16 = Buffer.from("\uFEFFUbuntu\r\nDGC\r\n", "utf16le");
  assert.equal(host.wslText(utf16), "Ubuntu\nDGC\n");
  assert.equal(host.wslText(Buffer.from("Ubuntu\nDGC\n", "utf8")), "Ubuntu\nDGC\n");
});

test("where this computer is: no WSL, no distro, no DGC, ready", async () => {
  const runner = (answers) => async (args) => answers(args);
  assert.equal(await host.state(runner(() => ({ code: null, out: "", err: "", missing: true })), "DGC"), "no-wsl");
  assert.equal(await host.state(runner(() => ({ code: 1, out: "", err: "The Windows Subsystem for Linux is not installed." })), "DGC"), "no-wsl");
  assert.equal(await host.state(runner(() => ({ code: -1, out: "Windows Subsystem for Linux has no installed distributions.", err: "" })), "DGC"), "no-distro");
  assert.equal(await host.state(runner(() => ({ code: 0, out: "Ubuntu\n", err: "" })), "DGC"), "no-distro");
  const seen = [];
  const listed = (probe) => runner((args) => { seen.push(args); return args[0] === "--list" ? { code: 0, out: "Ubuntu\ndgc\n", err: "" } : { code: probe, out: "", err: "" }; });
  assert.equal(await host.state(listed(1), "DGC"), "no-dgc");
  assert.deepEqual(seen.at(-1), ["-d", "DGC", "--exec", "/bin/test", "-x", "/home/dgc/.local/bin/dgc"]);
  assert.equal(await host.state(listed(0), "DGC"), "ready");
});

test("setting it up: the distro, then prepared as root from fixed text, then DGC as its own user", () => {
  const all = host.setupSteps("no-distro", "DGC");
  assert.deepEqual(all.map((s) => s.title), ["Getting Ubuntu for DGC", "Preparing it", "Restarting it", "Installing DGC"]);
  assert.deepEqual(all[0].args, ["--install", "Ubuntu-24.04", "--name", "DGC", "--no-launch", "--web-download"]);
  assert.deepEqual(all[1].args, ["-d", "DGC", "-u", "root", "--exec", "/bin/sh", "-s"]);
  assert.match(all[1].input, /useradd -m -s \/bin\/bash dgc/);
  assert.match(all[1].input, /python3-venv bubblewrap/);
  assert.match(all[1].input, /^touch \/etc\/dgc-distro$/m, "marked as DGC's own (dgc/wsl.py OWN_DISTRO_MARK)");
  assert.deepEqual(all[3].args, ["-d", "DGC", "-u", "dgc", "--exec", "/bin/sh", "-s"]);
  assert.match(all[3].input, /DGC_SKIP_EXTENSION=1 bash/);
  assert.deepEqual(host.setupSteps("no-dgc", "DGC").map((s) => s.title), ["Preparing it", "Restarting it", "Installing DGC"]);
  assert.deepEqual(host.setupSteps("ready", "DGC"), []);
  assert.deepEqual(host.setupSteps("no-wsl", "DGC"), [], "turning WSL on needs an administrator: never a silent step");
});

test("commands: the Windows paths the backend reads or compares become the distro's, nothing else", () => {
  const b = wire.bridge(paths.pathMap("DGC"));
  assert.deepEqual(b.toBackend({ type: "open_chat", request_id: "r", cwd: "C:\\proj" }), { type: "open_chat", request_id: "r", cwd: "/mnt/c/proj" });
  assert.deepEqual(b.toBackend({ type: "set_workspace_roots", roots: ["C:\\a", "D:\\b"] }).roots, ["/mnt/c/a", "/mnt/d/b"]);
  assert.deepEqual(b.toBackend({ type: "get_chat_change", root: "C:\\proj", path: "src\\x.py", session_id: "s", request_id: "r" }),
    { type: "get_chat_change", root: "/mnt/c/proj", path: "src\\x.py", session_id: "s", request_id: "r" }, "the relative path stays");
  const prompt = b.toBackend({ type: "prompt", text: "look at C:\\proj\\a.py", context: [
    { type: "active_file", path: "C:\\proj\\a.py", relative_path: "a.py", uri: "file:///c%3A/proj/a.py" },
    { type: "file_mention", path: "D:\\other\\b.py", relative_path: "D:\\other\\b.py" },
    { type: "mcp_context", uri: "file:///server-name/x" }] });
  assert.equal(prompt.text, "look at C:\\proj\\a.py", "what the user typed is theirs");
  assert.deepEqual(prompt.context[0], { type: "active_file", path: "/mnt/c/proj/a.py", relative_path: "a.py", uri: "file:///mnt/c/proj/a.py" });
  assert.equal(prompt.context[1].relative_path, "/mnt/d/other/b.py", "outside the workspace: absolute");
  assert.equal(prompt.context[2].uri, "file:///server-name/x", "an MCP server's own name");
  const send = b.toBackend({ type: "chatdgc_send", attachments: [{ kind: "file", path: "C:\\x.pdf" }, { kind: "library", id: "lib_1" }] });
  assert.deepEqual(send.attachments, [{ kind: "file", path: "/mnt/c/x.pdf" }, { kind: "library", id: "lib_1" }]);
  assert.equal(b.toBackend({ type: "add_plugin_marketplace", source: "owner/repo" }).source, "owner/repo");
  assert.equal(b.toBackend({ type: "add_plugin_marketplace", source: "C:\\plugins" }).source, "/mnt/c/plugins");
  assert.equal(b.toBackend({ type: "resume_session", path: "abc.json" }).path, "abc.json", "a session file name is DGC's own");
  assert.deepEqual(b.toBackend({ type: "permission_response", id: "p", decision: "always", rule: "Edit(C:\\x)" }).rule, "Edit(C:\\x)");
  const pips = { type: "pips_control", request: { type: "read_pip_computer_file", path: "/home/pip/notes.txt" } };
  assert.deepEqual(b.toBackend(structuredClone(pips)), pips, "a path in a Pip's computer is its own");
});

test("events: the distro's paths the editor opens or shows become Windows paths, and come back exactly", () => {
  const b = wire.bridge(paths.pathMap("DGC"));
  const ready = b.toEditor({ type: "ready", project_root: "/mnt/c/proj", capabilities: { image_spool_dir: "/home/dgc/.dgc/spool/images" } });
  assert.equal(ready.project_root, "C:\\proj");
  assert.equal(ready.capabilities.image_spool_dir, "\\\\wsl.localhost\\DGC\\home\\dgc\\.dgc\\spool\\images");
  assert.equal(b.toBackend({ type: "set_workspace_roots", roots: [ready.project_root] }).roots[0], "/mnt/c/proj", "round trip");
  const canvas = b.toEditor({ type: "chatdgc_canvas", canvas: { path: "/home/dgc/.dgc/chat/canvas/c/v/doc.md", versions: [{ path: "/home/dgc/.dgc/chat/canvas/c/v/.versions/1.md" }] } });
  assert.equal(canvas.canvas.path, "\\\\wsl.localhost\\DGC\\home\\dgc\\.dgc\\chat\\canvas\\c\\v\\doc.md");
  assert.equal(canvas.canvas.versions[0].path, "\\\\wsl.localhost\\DGC\\home\\dgc\\.dgc\\chat\\canvas\\c\\v\\.versions\\1.md");
  const saved = b.toEditor({ type: "chatdgc_library_file", request_id: "r", op: "save", path: "/mnt/c/Users/Me/AppData/Local/Temp/dgc/x.pdf" });
  assert.equal(saved.path, "C:\\Users\\Me\\AppData\\Local\\Temp\\dgc\\x.pdf");
  assert.equal(b.toBackend({ type: "chatdgc_library_file", op: "save", path: saved.path }).path, "/mnt/c/Users/Me/AppData/Local/Temp/dgc/x.pdf");
  const changes = b.toEditor({ type: "chat_changes", roots: [{ root: "/mnt/c/proj", files: [{ path: "src/a.py" }] }] });
  assert.deepEqual(changes.roots[0], { root: "C:\\proj", files: [{ path: "src/a.py" }] });
  const history = b.toEditor({ type: "history", items: [{ type: "image", path: "/home/dgc/.dgc/sessions/s.images/1.png" },
                                                       { type: "text_delta", text: "/mnt/c/proj/a.py" }] });
  assert.equal(history.items[0].path, "\\\\wsl.localhost\\DGC\\home\\dgc\\.dgc\\sessions\\s.images\\1.png", "replayed events too");
  assert.equal(history.items[1].text, "/mnt/c/proj/a.py", "free text is never rewritten");
  assert.equal(b.toEditor({ type: "troupe_finished", journal: "/home/dgc/.dgc/troupes/tr-1" }).journal, "\\\\wsl.localhost\\DGC\\home\\dgc\\.dgc\\troupes\\tr-1");
  const tool = { type: "tool_call", name: "read_file", args: { path: "/mnt/c/proj/a.py" }, summary: "a.py" };
  assert.deepEqual(b.toEditor(structuredClone(tool)), tool, "tool arguments are the model's: shown as it wrote them");
});

test("what a real Windows 11 (26300, WSL 3.0.3) said, read and recognised", () => {
  const fixture = (name) => readFileSync(join(here, "fixtures", "wsl", name));
  const noWsl = host.wslText(fixture("list-no-wsl.utf16.bin"));
  assert.match(noWsl, /^The Windows Subsystem for Linux is not installed\./, "the inbox wsl.exe, UTF-16 even with WSL_UTF8=1");
  assert.equal(host.notSetUp(noWsl), true);
  for (const name of ["no-distro.stdout.utf8.bin", "no-distro.stdout.utf16.bin"]) {
    const said = host.wslText(fixture(name));
    assert.match(said, /^There is no distribution with the supplied name\.\nError code: Wsl\/Service\/WSL_E_DISTRO_NOT_FOUND/, name);
    assert.equal(host.notSetUp(said), true, name);
    assert.equal(host.notSetUp(fixture(name).toString("utf8")), true, `${name}, read as UTF-8 by a stream`);
  }
  assert.equal(host.notSetUp("Traceback (most recent call last):\n  KeyError: 'x'"), false);
  assert.equal(host.notSetUp("chdir(/mnt/z/gone) failed 2"), false, "a folder problem is not 'not set up'");
});
