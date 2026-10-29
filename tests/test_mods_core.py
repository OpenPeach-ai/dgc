"""Mods (dgc/mods): the manifest and its plain words, the one-time Allow, the UI tree, and real mod processes in the
real sandbox: what they hear, how their answers merge (never an allow), a mod that hangs or crashes, no network and
no home folder inside the sandbox, fetches only to declared hosts, project files only, and the built-in Guard."""
from __future__ import annotations

import http.server
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import sandbox
from dgc.mods import catalog, consent, manifest, ui
from dgc.mods.host import ModHost
from dgc.mods.manifest import ManifestError

BOXED = sandbox._backend() is not None


def write_mod(root: Path, name: str, code: str, caps: dict, **extra) -> Path:
    folder = root / name
    folder.mkdir(parents=True)
    (folder / "main.py").write_text(textwrap.dedent(code))
    (folder / "dgc-mod.json").write_text(json.dumps({"name": name, "version": "1.0.0", "entry": "main.py",
                                                     "capabilities": caps, **extra}))
    return folder


class Home(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-mods-")))
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(self.tmp / "home")
        self.src = self.tmp / "src"
        self.project = self.tmp / "project"
        self.project.mkdir()
        self.hosts = []

    def tearDown(self):
        for h in self.hosts:
            h.stop()
        if self._env is None:
            os.environ.pop("DGC_HOME", None)
        else:
            os.environ["DGC_HOME"] = self._env

    def host(self, *folders, allow=True, **kw):
        h = ModHost(project_root=self.project, session_id="s1", extra=tuple(str(f) for f in folders), **kw)
        self.hosts.append(h)
        if allow:
            for m in catalog.available(h.extra):
                if not m.builtin:
                    consent.allow(m, unsandboxed=not BOXED)
        h.start()
        return h


class ManifestTests(Home):
    def test_the_builtins_load_and_say_what_they_can_do(self):
        names = {m.name for m in catalog.builtins()}
        self.assertEqual(names, {"context", "guard", "tally"})
        guard = next(m for m in catalog.builtins() if m.name == "guard")
        said = manifest.describe(guard)
        self.assertIn("It can never approve anything for you.", said)
        self.assertIn("It can't reach the internet.", said)

    def test_a_manifest_is_checked(self):
        folder = write_mod(self.src, "ok", "pass", {"events": ["tool.call"]})
        for bad, why in [({"name": "Bad Name"}, "name"), ({"version": "1"}, "version"),
                         ({"entry": "../x.py"}, "entry"), ({"entry": "main.rb"}, "entry"),
                         ({"capabilities": {"events": ["tool.allow"]}}, "tool.allow"),
                         ({"capabilities": {"rewrites_prompt": True}}, "prompt.submit"),
                         ({"capabilities": {"network": ["http://x.com"]}}, "network"),
                         ({"capabilities": {"bogus": True}}, "bogus")]:
            data = {"name": "ok", "version": "1.0.0", "entry": "main.py", "capabilities": {}, **bad}
            with self.assertRaises(ManifestError, msg=why) as caught:
                manifest.parse(data, folder)
            self.assertIn(why.split(".")[0], str(caught.exception).lower() + json.dumps(bad).lower())

    def test_an_update_that_asks_for_more_asks_again(self):
        folder = write_mod(self.src, "watcher", "pass", {"events": ["turn.complete"]})
        m = catalog.install_folder(folder)
        self.assertFalse(consent.allowed(m))
        consent.allow(m)
        self.assertTrue(consent.allowed(m))
        (folder / "dgc-mod.json").write_text(json.dumps({"name": "watcher", "version": "1.1.0", "entry": "main.py",
                                                         "capabilities": {"events": ["turn.complete"],
                                                                          "network": ["api.example.com"]}}))
        newer = catalog.install_folder(folder)
        self.assertEqual(consent.missing(newer), {"net:api.example.com"})
        self.assertFalse(consent.allowed(newer))
        consent.set_enabled("watcher", False)
        consent.allow(newer)
        self.assertTrue(consent.allowed(newer))
        consent.set_enabled("watcher", False)
        self.assertFalse(consent.allowed(newer), "off is off")


class UITests(unittest.TestCase):
    def test_a_tree_is_checked_and_cut(self):
        with self.assertRaises(ui.UIError):
            ui.clean({"type": "Script", "src": "x"})
        with self.assertRaises(ui.UIError):
            ui.clean({"type": "Button", "id": "has space", "label": "x"})
        deep = {"type": "Text", "text": "x"}
        for _ in range(10):
            deep = {"type": "Box", "children": [deep]}
        with self.assertRaises(ui.UIError):
            ui.clean(deep)
        got = ui.clean({"type": "Text", "text": "a\x1b[31mred" + "x" * 5000})
        self.assertNotIn("\x1b", got["text"])
        self.assertEqual(len(got["text"]), ui.MAX_TEXT)

    def test_the_terminal_draws_a_bar_a_table_and_a_sparkline(self):
        tree = ui.clean({"type": "Column", "children": [
            {"type": "Bar", "segments": [{"label": "Tools", "value": 30, "tone": "accent"},
                                         {"label": "Messages", "value": 20}], "total": 100},
            {"type": "Table", "columns": ["Tool", "Steps"], "rows": [["bash", 3], ["read_file", 12]]},
            {"type": "Sparkline", "values": [1, 3, 2, 8], "label": "tokens"}]})
        lines = ["".join(s.text for s in line) for line in ui.lines(tree, 40)]
        self.assertEqual(len(lines[0]), 40, "the bar fills the width")
        self.assertIn("Tools 30", lines[1])
        self.assertTrue(lines[2].startswith("Tool"))
        self.assertIn("read_file", lines[4])
        self.assertTrue(lines[-1].startswith("tokens ▁"))


RECORDER = """
import dgc_mod as dm
mod = dm.Mod()
@mod.on("tool.call")
def call(e):
    tool = e.get("tool")
    if tool == "hang":
        import time; time.sleep(5)
    if tool == "net":
        import socket
        try:
            socket.create_connection(("1.1.1.1", 443), timeout=2); return dm.deny("net: open")
        except OSError:
            return dm.deny("net: blocked")
    if tool == "home":
        import os
        return dm.deny("home: " + ("visible" if os.path.exists(e["args"]["path"]) else "hidden"))
    if tool == "fetch":
        try:
            got = mod.fetch(e["args"]["url"]); return dm.deny(f"fetched {got['status']} {got['text']}")
        except dm.ModError as err:
            return dm.deny(f"refused: {err}")
    if tool == "read":
        try:
            return dm.deny("read: " + mod.read_file(e["args"]["path"]).strip())
        except dm.ModError as err:
            return dm.deny(f"refused: {err}")
    if tool == "draw":
        try:
            mod.set_ui(e["args"]["slot"], dm.Text("hi")); return dm.deny("drew")
        except dm.ModError as err:
            return dm.deny(f"refused: {err}")
    if tool == "keep":
        mod.store_set("n", (mod.store_get("n", 0) or 0) + 1); return dm.deny(f"kept {mod.store_get('n')}")
    if tool == "allow-me":
        return {"decision": "allow", "reason": "please"}
    if tool == "ask-me":
        return dm.ask("careful")
    return None
@mod.command("echo")
def echo(args):
    return dm.Text("echo " + args)
mod.run()
"""
CAPS = {"events": ["tool.call"], "draws": ["status"], "commands": [{"name": "echo"}], "reads": ["project"],
        "network": ["localhost"]}


class _Server(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"ok"
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class RuntimeTests(Home):
    def setUp(self):
        super().setUp()
        self.rec = write_mod(self.src, "recorder", RECORDER, CAPS)

    def test_answers_merge_to_the_most_careful_and_never_to_an_allow(self):
        denier = write_mod(self.src, "denier", """
            import dgc_mod as dm
            mod = dm.Mod()
            @mod.on("tool.call")
            def c(e):
                return dm.deny("no deletes") if e.get("tool") == "ask-me" else None
            mod.run()
        """, {"events": ["tool.call"]})
        h = self.host(self.rec, denier)
        self.assertEqual({e["name"]: e["state"] for e in h.mods() if not e["builtin"]},
                         {"recorder": "running", "denier": "running"})
        self.assertEqual(h.tool_call("ask-me", {})["decision"], "deny", "deny wins over ask")
        self.assertEqual(h.tool_call("allow-me", {})["decision"], "observe", "a mod can't allow")
        self.assertEqual(h.tool_call("ls", {})["decision"], "observe")

    def test_mods_started_from_a_thread_that_ends_keep_running(self):
        # The terminal starts its mods on a thread of their own that ends; a mod must outlive it.
        h = ModHost(project_root=self.project, session_id="s1", extra=(str(self.rec),))
        self.hosts.append(h)
        consent.allow(catalog.find("recorder", h.extra), unsandboxed=not BOXED)
        starter = threading.Thread(target=h.start)
        starter.start()
        starter.join()
        time.sleep(0.5)
        self.assertEqual(h.tool_call("ask-me", {})["decision"], "ask")
        self.assertEqual(next(e for e in h.mods() if e["name"] == "recorder")["state"], "running")

    def test_a_mod_ends_when_dgc_does_its_input_closed(self):
        from dgc.mods.runtime import ModProcess
        proc = ModProcess(catalog.find("recorder", (str(self.rec),)), on_request=lambda *a: {},
                          sandboxed=BOXED)
        proc.start()
        child = proc._proc
        child.stdin.close()                       # DGC gone: its end of the pipe closes
        self.assertEqual(child.wait(timeout=10), 0)

    def test_a_mod_that_hangs_only_watched_and_a_mod_that_crashes_is_said_to_have(self):
        crasher = write_mod(self.src, "crasher", "raise SystemExit('boom: missing key')", {"events": ["tool.call"]})
        h = self.host(self.rec, crasher)
        started = time.monotonic()
        self.assertEqual(h.tool_call("hang", {})["decision"], "observe")
        self.assertLess(time.monotonic() - started, 3.0)
        crashed = next(e for e in h.mods() if e["name"] == "crasher")
        self.assertIn(crashed["state"], ("crashed", "stopped"))
        self.assertIn("boom", crashed["error"] or "boom: (stderr)")

    @unittest.skipUnless(BOXED, "no OS sandbox on this computer")
    def test_inside_the_sandbox_there_is_no_network_and_no_home_folder(self):
        import pwd
        home = Path(pwd.getpwuid(os.getuid()).pw_dir)
        known = next((home / n for n in (".bashrc", ".profile", ".gitconfig") if (home / n).is_file()), None)
        if known is None:
            self.skipTest("no file in the account's home to look for")
        h = self.host(self.rec)
        self.assertEqual(h.tool_call("net", {})["reason"], "net: blocked")
        self.assertEqual(h.tool_call("home", {"path": str(known)})["reason"], "home: hidden",
                         f"{known} is on this computer, and the mod must not see it")
        # The same mod, outside a sandbox, sees it: the check above is real.
        from dgc.mods.runtime import ModProcess
        bare = ModProcess(catalog.find("recorder", h.extra), on_request=lambda *a: {}, sandboxed=False)
        bare.start()
        self.addCleanup(bare.stop)
        bare.request("initialize", {}, timeout=10)
        got = bare.request("event", {"name": "tool.call", "data": {"tool": "home", "args": {"path": str(known)}}},
                           timeout=5)
        self.assertEqual(got["reason"], "home: visible")

    def test_fetch_reaches_only_declared_hosts(self):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        port = server.server_address[1]
        h = self.host(self.rec)
        self.assertEqual(h.tool_call("fetch", {"url": f"http://localhost:{port}/"})["reason"], "fetched 200 ok")
        self.assertIn("isn't one of the hosts", h.tool_call("fetch", {"url": f"http://127.0.0.1:{port}/"})["reason"])
        self.assertIn("isn't one of the hosts", h.tool_call("fetch", {"url": "https://example.com/"})["reason"])

    def test_project_files_only_and_never_a_private_one(self):
        (self.project / "notes.txt").write_text("hello\n")
        (self.project / ".env").write_text("KEY=secret\n")
        (self.tmp / "outside.txt").write_text("nope\n")
        h = self.host(self.rec)
        self.assertEqual(h.tool_call("read", {"path": "notes.txt"})["reason"], "read: hello")
        for path in (".env", "../outside.txt", "/etc/passwd"):
            reason = h.tool_call("read", {"path": path})["reason"]
            self.assertTrue(reason.startswith("refused"), (path, reason))
            self.assertNotIn("secret", reason)

    def test_it_draws_only_where_it_declared_and_keeps_its_own_store(self):
        seen = []
        h = self.host(self.rec, on_ui=lambda kind, payload: seen.append((kind, payload)))
        self.assertEqual(h.tool_call("draw", {"slot": "status"})["reason"], "drew")
        self.assertEqual(h.ui_state["recorder"]["status"], {"type": "Text", "text": "hi"})
        self.assertIn("didn't declare", h.tool_call("draw", {"slot": "pane"})["reason"])
        self.assertTrue(any(k == "set" and p["slot"] == "status" for k, p in seen))
        self.assertEqual(h.tool_call("keep", {})["reason"], "kept 1")
        self.assertEqual(h.tool_call("keep", {})["reason"], "kept 2")
        self.assertEqual(h.run_command("echo", "hi there")["tree"], {"type": "Text", "text": "echo hi there"})
        self.assertIsNone(h.run_command("nobody-has-this"))

    def test_nothing_runs_without_an_allow_or_in_safe_mode(self):
        h = self.host(self.rec, allow=False)
        entry = next(e for e in h.mods() if e["name"] == "recorder")
        self.assertEqual(entry["state"], "needs_allow")
        self.assertIn("It can never approve anything for you.", entry["asks"])
        self.assertEqual(h.tool_call("ask-me", {})["decision"], "observe")
        os.environ["DGC_SAFE_MODE"] = "1"
        self.addCleanup(os.environ.pop, "DGC_SAFE_MODE", None)
        consent.allow(catalog.find("recorder", h.extra), unsandboxed=not BOXED)
        safe = self.host(self.rec)
        self.assertEqual(safe.running, {})


class GuardTests(Home):
    def test_guard_asks_before_what_cant_be_undone_and_says_what_it_would_change(self):
        subprocess.run(["git", "init", "-q", str(self.project)], check=True)
        (self.project / "a.py").write_text("x = 1\n")
        subprocess.run(["git", "-C", str(self.project), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.project), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm",
                        "one"], check=True)
        (self.project / "a.py").write_text("x = 2\n")
        consent.allow(next(m for m in catalog.builtins() if m.name == "guard"))
        h = self.host()
        said = h.tool_call("bash", {"command": "rm -rf build/"})
        self.assertEqual((said["decision"], said["mod"]), ("ask", "Guard"))
        self.assertIn("deletes build/", said["reason"])
        said = h.tool_call("bash", {"command": "git reset --hard HEAD"})
        self.assertIn("throws away every uncommitted change (1 file: a.py)", said["reason"])
        self.assertEqual(h.tool_call("bash", {"command": "ls -la"})["decision"], "observe")
        self.assertEqual(h.tool_call("read_file", {"path": "x"})["decision"], "observe")


if __name__ == "__main__":
    unittest.main()


class TypeScriptMods(Home):
    """A mod in TypeScript with @vibedgc/sdk/mods, run by DGC in the same sandbox."""

    def test_a_typescript_mod_answers_and_draws(self):
        import shutil
        if shutil.which("node") is None:
            self.skipTest("Node is not installed")
        folder = self.src / "ts-guard"
        (folder / "lib").mkdir(parents=True)
        shutil.copy(Path(__file__).resolve().parent.parent / "sdk/typescript/src/mods.ts", folder / "lib/mods.ts")
        (folder / "main.ts").write_text(textwrap.dedent("""
            import { Mod, ask, Text, Table } from "./lib/mods.ts";
            const mod = new Mod();
            mod.on("tool.call", async (e) => {
              if (String(e.args?.command ?? "").includes("--force")) {
                await mod.setUi("status", Text("held one"));
                return ask("force-push rewrites history");
              }
            });
            mod.command("held", () => Table(["What"], [["force-push"]]));
            mod.run();
        """))
        (folder / "dgc-mod.json").write_text(json.dumps({"name": "ts-guard", "version": "1.0.0", "entry": "main.ts",
                                                         "capabilities": {"events": ["tool.call"], "draws": ["status"],
                                                                          "commands": [{"name": "held"}]}}))
        h = self.host(folder)
        said = h.tool_call("bash", {"command": "git push --force"})
        self.assertEqual((said["decision"], said["reason"]), ("ask", "force-push rewrites history"))
        self.assertEqual(h.ui_state["ts-guard"]["status"], {"type": "Text", "text": "held one"})
        self.assertEqual(h.run_command("held")["tree"]["rows"], [["force-push"]])
        self.assertEqual(h.tool_call("bash", {"command": "ls"})["decision"], "observe")


class AuthoringLibraries(unittest.TestCase):
    def test_the_sdks_python_library_is_the_one_mods_import(self):
        root = Path(__file__).resolve().parent.parent
        self.assertEqual((root / "sdk/python/dgc_sdk/mods.py").read_bytes(),
                         (root / "dgc/mods/py/dgc_mod.py").read_bytes(),
                         "dgc_sdk.mods is a copy of dgc/mods/py/dgc_mod.py: change both")
