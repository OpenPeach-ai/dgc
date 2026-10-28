// Installing DGC Voice (src/voiceInstall.ts). It isn't on the Marketplace or Open VSX yet, so DGC carries it as
// dist/dgc-voice.vsix: Install uses the editor's gallery only when the gallery has DGC Voice and it isn't older than
// that file, and otherwise installs the file. A failure says what happened and where the file is, with Install from
// VSIX…; it never ends in an empty Extensions search (what a user saw: "@id:vibedgc.dgc-voice", and nothing).
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "dgc-voice-install-"));
const originalFetch = globalThis.fetch;
/** The editor, as far as installing goes: what it was asked to run and show, and what it answers. */
const editor = { executed: [], shown: [], answers: {}, failInstall: null, statusAfter: 0, picked: null, dialogs: [] };
globalThis.__DGC_VOICE_INSTALL_TEST = {
  env: { appName: "Visual Studio Code", appRoot: join(scratch, "app") },
  ProgressLocation: { Notification: 15 },
  Uri: { file: (path) => ({ scheme: "file", fsPath: path, path }) },
  window: {
    withProgress: (options, work) => { editor.shown.push({ kind: "progress", message: options.title }); return Promise.resolve(work()); },
    showInformationMessage: async (message, ...actions) => { editor.shown.push({ kind: "info", message, actions }); return editor.answers.info?.(message, actions); },
    showErrorMessage: async (message, ...actions) => { editor.shown.push({ kind: "error", message, actions }); return editor.answers.error?.(message, actions); },
    showOpenDialog: async (options) => { editor.dialogs.push(options); return editor.picked ? [{ fsPath: editor.picked }] : undefined; },
  },
  commands: { executeCommand: async (name, ...args) => {
    editor.executed.push({ name, args });
    if (name === "workbench.extensions.installExtension") {
      if (editor.failInstall) throw new Error(editor.failInstall);
      editor.installedAt = editor.executed.length;
      return undefined;
    }
    if (name === "dgcVoice.status") {
      if (editor.installedAt && editor.executed.filter((c) => c.name === "dgcVoice.status").length > editor.statusAfter) return { ok: true, recorder: "arecord" };
      throw new Error("command 'dgcVoice.status' not found");
    }
    return undefined;
  } },
};
const bundle = join(scratch, "voiceInstall.cjs");
await build({
  stdin: { contents: 'export * from "./src/voiceInstall";', resolveDir: root, loader: "ts" },
  bundle: true, format: "cjs", platform: "node", target: "node18", outfile: bundle, logLevel: "silent",
  define: { "process.env.DGC_VOICE_VERSION": JSON.stringify("0.2.0") },
  plugins: [{ name: "test-vscode", setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "test" }));
    builder.onLoad({ filter: /^vscode$/, namespace: "test" }, () => ({ contents: "module.exports = globalThis.__DGC_VOICE_INSTALL_TEST;", loader: "js" }));
  } }],
});
const { voiceSource, galleryVoiceVersion, installVoice, voiceAnswers, offerVoiceInstall, INSTALL_VOICE } = createRequire(import.meta.url)(bundle);
after(() => { globalThis.fetch = originalFetch; delete globalThis.__DGC_VOICE_INSTALL_TEST; rmSync(scratch, { recursive: true, force: true }); });

const BUNDLED = { path: "/ext/dgc/dist/dgc-voice.vsix", version: "0.2.0" };

/** An editor for installVoice: `gallery` is its gallery's DGC Voice (null: none), `fails` the installs that throw. */
function io({ gallery = null, bundled = BUNDLED, fails = {}, answers = true, choose = {}, picked } = {}) {
  const w = { installs: [], said: [], progress: 0, reloaded: 0, picks: [] };
  w.io = {
    bundled: () => bundled,
    galleryVersion: async () => gallery,
    install: async (what) => {
      w.installs.push(what);
      const why = "id" in what ? fails.id : fails[what.file] ?? fails.file;
      if (why) throw new Error(why);
    },
    answers: async () => answers,
    progress: async (_title, work) => { w.progress++; return work(); },
    info: async (message, ...actions) => { w.said.push({ kind: "info", message, actions }); return choose.info; },
    error: async (message, ...actions) => { w.said.push({ kind: "error", message, actions }); return choose.error; },
    pickVsix: async (near) => { w.picks.push(near); return picked; },
    reload: () => { w.reloaded++; },
    app: "Cursor",
  };
  return w;
}

test("the gallery is used only when it has DGC Voice and it isn't older than the copy DGC carries", () => {
  assert.equal(voiceSource(null, BUNDLED), "bundled", "not on the gallery: DGC's own");
  assert.equal(voiceSource("0.1.9", BUNDLED), "bundled", "older on the gallery: DGC's own");
  assert.equal(voiceSource("0.2.0", BUNDLED), "gallery", "the same version: the gallery's, which updates itself");
  assert.equal(voiceSource("0.3.0", BUNDLED), "gallery", "newer on the gallery");
  assert.equal(voiceSource("0.3.0", null), "gallery", "a DGC without its copy can still use the gallery");
  assert.equal(voiceSource(null, null), "none");
  assert.equal(voiceSource("not-a-version", BUNDLED), "bundled");
  assert.equal(voiceSource("0.1.0", { path: "x", version: "" }), "gallery", "an unknown bundled version defers to the gallery");
});

test("the gallery is asked the way VS Code asks it, and a pre-release, a miss or no answer reads as not there", async () => {
  const asked = [];
  const answer = (body, status = 200) => async (url, options) => { asked.push({ url, options }); return new Response(JSON.stringify(body), { status }); };
  const found = (versions) => ({ results: [{ extensions: [{ extensionName: "dgc-voice", publisher: { publisherName: "vibedgc" }, versions }] }] });
  const gallery = "https://marketplace.visualstudio.com/_apis/public/gallery/";

  assert.equal(await galleryVoiceVersion(gallery, answer(found([{ version: "0.4.0", properties: [] }]))), "0.4.0");
  assert.equal(asked[0].url, "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery");
  assert.equal(asked[0].options.method, "POST");
  assert.equal(asked[0].options.redirect, "error");
  const query = JSON.parse(asked[0].options.body);
  assert.deepEqual(query.filters[0].criteria[0], { filterType: 7, value: "vibedgc.dgc-voice" });

  const pre = [{ version: "0.5.0", properties: [{ key: "Microsoft.VisualStudio.Code.PreRelease", value: "true" }] }, { version: "0.4.1", properties: [] }];
  assert.equal(await galleryVoiceVersion(gallery, answer(found(pre))), "0.4.1", "a pre-release isn't what Install gets");
  // What the Marketplace and Open VSX answer today for vibedgc.dgc-voice: no extension.
  assert.equal(await galleryVoiceVersion(gallery, answer({ results: [{ extensions: [], resultMetadata: [] }] })), null);
  assert.equal(await galleryVoiceVersion(gallery, answer({ results: [{ extensions: [{ extensionName: "other", publisher: { publisherName: "vibedgc" }, versions: [{ version: "9.9.9" }] }] }] })), null);
  assert.equal(await galleryVoiceVersion(gallery, answer({}, 500)), null);
  assert.equal(await galleryVoiceVersion(gallery, async () => { throw new TypeError("fetch failed"); }), null, "offline: not there");
  const before = asked.length;
  assert.equal(await galleryVoiceVersion("", answer({})), null);
  assert.equal(await galleryVoiceVersion("http://insecure.invalid/gallery", answer({})), null);
  assert.equal(asked.length, before, "no gallery, or not https: nothing is fetched");
});

test("not on the gallery (today): Install installs the file DGC carries, and DGC Voice answers", async () => {
  const w = io({ gallery: null });
  assert.equal(await installVoice(w.io), "ready");
  assert.deepEqual(w.installs, [{ file: BUNDLED.path }]);
  assert.equal(w.said.length, 0, "nothing more to say: the box says it's ready");
  assert.equal(w.progress, 1, "the install shows its progress");
});

test("on the gallery and not older: Install installs it from there; older there: DGC's own", async () => {
  const newer = io({ gallery: "0.3.0" });
  assert.equal(await installVoice(newer.io), "ready");
  assert.deepEqual(newer.installs, [{ id: "vibedgc.dgc-voice" }]);
  const older = io({ gallery: "0.1.0" });
  assert.equal(await installVoice(older.io), "ready");
  assert.deepEqual(older.installs, [{ file: BUNDLED.path }]);
});

test("the gallery's install fails: DGC's own file is installed instead", async () => {
  const w = io({ gallery: "0.3.0", fails: { id: "The extension 'vibedgc.dgc-voice' cannot be installed because it was not found." } });
  assert.equal(await installVoice(w.io), "ready");
  assert.deepEqual(w.installs, [{ id: "vibedgc.dgc-voice" }, { file: BUNDLED.path }]);
});

test("the file won't install: it says why and where the file is, and Install from VSIX… opens that file", async () => {
  const w = io({ fails: { [BUNDLED.path]: "Can't install 'dgc-voice' extension because it is not compatible." },
                 choose: { error: "Install from VSIX…" }, picked: "/home/me/Downloads/dgc-voice-0.2.0.vsix" });
  assert.equal(await installVoice(w.io), "ready");
  const [failed] = w.said;
  assert.equal(failed.kind, "error");
  assert.match(failed.message, /^DGC Voice couldn't be installed: Can't install 'dgc-voice' extension because it is not compatible\./);
  assert.ok(failed.message.includes(BUNDLED.path), "says where the file is");
  assert.deepEqual(failed.actions, ["Install from VSIX…"]);
  assert.deepEqual(w.picks, [BUNDLED.path], "the picker starts at the file DGC carries");
  assert.deepEqual(w.installs, [{ file: BUNDLED.path }, { file: "/home/me/Downloads/dgc-voice-0.2.0.vsix" }]);

  const dismissed = io({ fails: { file: "Disk full." } });
  assert.equal(await installVoice(dismissed.io), "failed");
  assert.equal(dismissed.picks.length, 0, "dismissed: nothing more happens");
  const again = io({ fails: { file: "Disk full." }, choose: { error: "Install from VSIX…" }, picked: "/tmp/x.vsix" });
  assert.equal(await installVoice(again.io), "failed");
  assert.match(again.said.at(-1).message, /^DGC Voice couldn't be installed from \/tmp\/x\.vsix: Disk full\.$/);
});

test("no copy in this DGC and none on the gallery: it says so plainly", async () => {
  const w = io({ bundled: null, gallery: null });
  assert.equal(await installVoice(w.io), "failed");
  assert.deepEqual(w.installs, [], "nothing to install");
  assert.match(w.said[0].message, /this copy of DGC doesn't carry it \(dist\/dgc-voice\.vsix is missing\), and Cursor's extension gallery doesn't have it\./);
  assert.deepEqual(w.said[0].actions, ["Install from VSIX…"]);
});

test("installed but not started (the editor wants a reload): it offers Reload Window", async () => {
  const w = io({ answers: false, choose: { info: "Reload Window" } });
  assert.equal(await installVoice(w.io), "reload");
  assert.match(w.said[0].message, /DGC Voice is installed, but Cursor hasn't started it yet\. Reload the window, then press the microphone\./);
  assert.deepEqual(w.said[0].actions, ["Reload Window"]);
  assert.equal(w.reloaded, 1);
});

test("one install at a time, and a message left unanswered never holds up the next install", async () => {
  let release;
  const slow = io();
  slow.io.install = (what) => { slow.installs.push(what); return new Promise((resolve) => { release = resolve; }); };
  const first = installVoice(slow.io), second = installVoice(io().io);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(slow.installs.length, 1, "the second ask waits for the install already running");
  release();
  assert.deepEqual(await Promise.all([first, second]), ["ready", "ready"]);

  const ignored = io({ fails: { file: "Disk full." } });
  ignored.io.error = () => new Promise(() => {});  // the failure notification sits unanswered in the corner
  void installVoice(ignored.io);
  await new Promise((r) => setTimeout(r, 10));
  const next = io();
  assert.equal(await installVoice(next.io), "ready");
  assert.deepEqual(next.installs, [{ file: BUNDLED.path }], "the next Install installs");
});

test("waiting for DGC Voice to answer: a few tries while the editor starts it, then a plain no", async () => {
  let calls = 0;
  assert.equal(await voiceAnswers(async () => { if (++calls < 3) throw new Error("command 'dgcVoice.status' not found"); return { ok: true }; }, 2000, 5), true);
  assert.equal(calls, 3);
  assert.equal(await voiceAnswers(async () => { throw new Error("not found"); }, 40, 5), false);
  assert.equal(await voiceAnswers(() => new Promise(() => {}), 40, 5), false, "a call that never returns doesn't hang it");
});

// ---- through the editor (editorVoiceInstaller): the commands VS Code is asked to run ----------------------------

const ext = join(scratch, "ext");
beforeEach(() => {
  Object.assign(editor, { executed: [], shown: [], answers: {}, failInstall: null, statusAfter: 0, picked: null, dialogs: [], installedAt: 0 });
  mkdirSync(join(scratch, "app"), { recursive: true });
  writeFileSync(join(scratch, "app", "product.json"), JSON.stringify({ extensionsGallery: { serviceUrl: "https://gallery.invalid/_apis/public/gallery" } }));
  mkdirSync(join(ext, "dist"), { recursive: true });
  writeFileSync(join(ext, "dist", "dgc-voice.vsix"), "PK");
  globalThis.fetch = async () => new Response(JSON.stringify({ results: [{ extensions: [] }] }));
});

test("the press's notification: Install DGC Voice installs dist/dgc-voice.vsix from DGC's own folder, then DGC Voice answers", async () => {
  editor.answers.info = (_message, actions) => actions[0];
  editor.statusAfter = 1;                         // the editor takes a moment to start it
  const ready = await offerVoiceInstall("Dictation needs DGC Voice…", ext);
  assert.equal(ready, true);
  assert.deepEqual(editor.shown[0], { kind: "info", message: "Dictation needs DGC Voice…", actions: [INSTALL_VOICE] });
  const installs = editor.executed.filter((c) => c.name === "workbench.extensions.installExtension");
  assert.equal(installs.length, 1);
  assert.equal(installs[0].args[0].scheme, "file", "a file URI: in a Remote window VS Code carries it to this computer");
  assert.equal(installs[0].args[0].fsPath, join(ext, "dist", "dgc-voice.vsix"));
  assert.ok(editor.executed.some((c) => c.name === "dgcVoice.status"), "it waited for DGC Voice to answer");
  assert.ok(!editor.executed.some((c) => c.name === "workbench.extensions.search"), "never an Extensions search");
  assert.ok(editor.shown.some((s) => s.kind === "progress" && s.message === "Installing DGC Voice…"));
});

test("the press's notification, dismissed: nothing is installed", async () => {
  editor.answers.info = () => undefined;
  assert.equal(await offerVoiceInstall("Dictation needs DGC Voice…", ext), false);
  assert.deepEqual(editor.executed, []);
});

test("through the editor, a failed install says so and Install from VSIX… opens the picker at DGC's file", async () => {
  editor.answers.info = (_message, actions) => actions[0];
  editor.failInstall = "Unable to install extension 'vibedgc.dgc-voice' as it is not compatible with VS Code '1.80.0'.";
  editor.answers.error = (_message, actions) => actions[0];
  assert.equal(await offerVoiceInstall("Dictation needs DGC Voice…", ext), false);
  const error = editor.shown.find((s) => s.kind === "error");
  assert.match(error.message, /not compatible with VS Code '1\.80\.0'/);
  assert.ok(error.message.includes(join(ext, "dist", "dgc-voice.vsix")));
  assert.equal(editor.dialogs[0].defaultUri.fsPath, join(ext, "dist", "dgc-voice.vsix"));
  assert.deepEqual(editor.dialogs[0].filters, { VSIX: ["vsix"] });
  assert.ok(!editor.executed.some((c) => c.name === "workbench.extensions.search"), "never an Extensions search");
});

test("a DGC built without the file, and no gallery copy: it says so and installs nothing", async () => {
  rmSync(join(ext, "dist", "dgc-voice.vsix"));
  editor.answers.info = (_message, actions) => actions[0];
  assert.equal(await offerVoiceInstall("Dictation needs DGC Voice…", ext), false);
  assert.equal(editor.executed.filter((c) => c.name === "workbench.extensions.installExtension").length, 0);
  assert.match(editor.shown.find((s) => s.kind === "error").message, /dist\/dgc-voice\.vsix is missing\), and Visual Studio Code's extension gallery doesn't have it/);
});
