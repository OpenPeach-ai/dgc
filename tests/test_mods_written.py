"""The mods DGC writes (dgc/mods/host.py, dgc/mods/bridge.py, dgc/headless.py): the first time in a session the model
writes a mod's folder in the project, the editor is asked once, "Turn on the mods DGC writes in this session?".
Allow runs the folder for this session; a later mod asking for nothing more starts without asking, one asking for more
asks again; Not now runs nothing and asks nothing more, and the mods list shows each as written this session. A Pip's
run, safe mode and mods_enabled off never ask. Every frame is one the protocol accepts (the harness's emitter checks
each as it is sent)."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import editor_protocol as ep
from dgc import sandbox
from dgc.llm import ToolCall
from dgc.mods import bridge, consent
from dgc.mods.host import ModHost
from dgc.mods.runtime import ModError
from test_subagents import HarnessCase
from test_undo_fixes import steps

BOXED = sandbox._backend() is not None
CODE = """import dgc_mod as dm
mod = dm.Mod()
@mod.render("status")
def status():
    return dm.Text("{title} here")
mod.run()
"""


def manifest(name: str, **caps) -> str:
    return json.dumps({"name": name, "version": "1.0.0", "entry": "main.py", "title": name.title(),
                       "capabilities": {"draws": ["status"], **caps}})


def writes(name: str, **caps) -> list:
    """The model's two steps that write a mod: its manifest, then its code."""
    return [ToolCall(f"m-{name}", "write_file", {"path": f"mods/{name}/dgc-mod.json", "content": manifest(name, **caps)}),
            ToolCall(f"c-{name}", "write_file", {"path": f"mods/{name}/main.py",
                                                 "content": CODE.replace("{title}", name.title())})]


class WrittenMods(HarnessCase):
    def setUp(self):
        home = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-mods-written-")))
        saved = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(home)
        self.addCleanup(lambda: os.environ.__setitem__("DGC_HOME", saved) if saved is not None
                        else os.environ.pop("DGC_HOME", None))
        os.environ.pop("DGC_SAFE_MODE", None)

    def chat(self, watch=True):
        h = self.make(mode="auto")
        host = h.backend._start_mods()
        self.addCleanup(bridge.stop, h.agent)
        if watch:
            h.backend._mods_command({"type": "watch_mod_offers"})
        return h, host

    def turn(self, h, prompt, *calls):
        """One scripted model turn; a chat's later turns are routed by their own prompt (the script keys on the
        chat's first)."""
        turns = h.__dict__.setdefault("turns", {})
        turns[prompt] = calls
        first = h.__dict__.setdefault("first", prompt)

        def route(messages, results, cancel):
            users = [i for i, m in enumerate(messages) if m.get("role") == "user"]
            text = str(messages[users[-1]].get("content", ""))
            done = [m for m in messages[users[-1]:] if m.get("role") == "tool"]
            needle = next(n for n in turns if n in text)
            return steps(*turns[needle])(messages, done, cancel)
        self.assertTrue(h.run(prompt, [(first, route)]))

    def wait(self, h, predicate, seconds=15):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            found = [f for f in h.stream.frames() if predicate(f)]
            if found:
                return found[-1]
            time.sleep(0.05)
        raise AssertionError(f"nothing matched: {h.stream.frames()[-4:]}")

    def answer(self, h, offer, allow, request="a1"):
        h.backend._mods_command({"type": "mod_offer_answer", "request_id": request, "id": offer["id"],
                                 "allow": allow})
        return self.wait(h, lambda f: f["type"] == "mods" and f.get("request_id") == request)

    @staticmethod
    def entry(listed, name):
        return next(m for m in listed["mods"] if m["name"] == name)

    def test_allow_runs_it_the_next_one_starts_without_asking_and_one_asking_for_more_asks_again(self):
        h, host = self.chat()
        self.turn(h, "write a counter mod", *writes("counter"))
        [offer] = h.of("mod_offer")
        self.assertEqual((offer["name"], offer["mod"], offer["version"], offer["folder"], offer["more"],
                          offer["surface"]), ("counter", "Counter", "1.0.0", "mods/counter", False, "work"))
        self.assertIn("It can show a line in the status bar.", offer["asks"])
        self.assertIn("It can never approve anything for you.", offer["asks"])
        self.assertNotIn("counter", host.running, "nothing runs before the answer")
        listed = self.answer(h, offer, True)
        counter = self.entry(listed, "counter")
        self.assertTrue(counter["written"])
        if BOXED:
            self.assertEqual(counter["state"], "running")
            drawn = self.wait(h, lambda f: f["type"] == "mod_ui" and f["name"] == "counter")
            self.assertEqual(drawn["tree"], {"type": "Text", "text": "Counter here"})
        self.assertIsNone(consent.record("counter"), "for this session only: nothing is remembered")

        self.turn(h, "write a ticker mod", *writes("ticker"))
        self.assertEqual(len(h.of("mod_offer")), 1, "the second mod asks for nothing more, so it isn't asked about")
        self.assertIn("ticker", host.running)

        self.turn(h, "write a watcher mod", *writes("watcher", events=["tool.call"]))
        more = h.of("mod_offer")[-1]
        self.assertEqual((more["name"], more["more"]), ("watcher", True))
        self.assertIn("It can see each step DGC is about to take, and stop it or ask you first.", more["asks"])
        self.assertNotIn("watcher", host.running)
        listed = self.answer(h, more, False, "a2")
        self.assertEqual(self.entry(listed, "watcher")["state"], "needs_allow")
        self.assertNotIn("watcher", host.running)

    def test_a_written_mod_that_cant_start_is_said_to_the_model_and_in_the_list(self):
        """A mod DGC wrote that was started and couldn't run: the model hears why in the step's result, and the mods
        list says it, never an empty answer (seen 11-02 as every Mods call coming back with reason '')."""
        h, host = self.chat()
        self.turn(h, "write a counter mod", *writes("counter"))
        [offer] = h.of("mod_offer")
        self.answer(h, offer, True)
        broken = [ToolCall("m-broken", "write_file", {"path": "mods/broken/dgc-mod.json", "content": manifest("broken")}),
                  ToolCall("c-broken", "write_file", {"path": "mods/broken/main.py",
                                                      "content": "raise SystemExit('boom: no config')\n"})]
        self.turn(h, "write a broken mod", *broken)
        said = [str(m.get("content")) for m in h.agent.messages if m.get("role") == "tool"
                and m.get("tool_call_id") == "c-broken"]
        self.assertEqual(len(said), 1)
        self.assertIn("The mod Broken couldn't start:", said[0])
        if BOXED:
            self.assertIn("boom: no config", said[0])
        entry = self.entry({"mods": host.mods()}, "broken")
        self.assertEqual(entry["state"], "crashed")
        self.assertTrue(entry["error"].strip())
        others = [str(m.get("content")) for m in h.agent.messages if m.get("role") == "tool"
                  and m.get("tool_call_id") in ("m-counter", "c-counter")]
        self.assertFalse(any("couldn't start" in text for text in others), "a mod that runs adds nothing")

    def test_not_now_runs_nothing_asks_nothing_more_and_the_list_offers_an_allow(self):
        h, host = self.chat()
        self.turn(h, "write a counter mod", *writes("counter"))
        [offer] = h.of("mod_offer")
        listed = self.answer(h, offer, False)
        counter = self.entry(listed, "counter")
        self.assertEqual((counter["state"], counter.get("written")), ("needs_allow", True))
        self.assertNotIn("counter", host.running)
        self.turn(h, "write a ticker mod", *writes("ticker"))
        self.assertEqual(len(h.of("mod_offer")), 1, "Not now: DGC doesn't ask again this session")
        self.assertNotIn("ticker", host.running)
        self.assertTrue(self.entry({"mods": host.mods()}, "ticker")["written"])
        # The list's Allow (mod_set allow) turns one on, for this session only.
        review = self.entry({"mods": host.mods()}, "ticker")["review"]
        h.backend._mods_command({"type": "mod_set", "request_id": "s1", "name": "ticker", "op": "allow", "review": review})
        listed = self.wait(h, lambda f: f["type"] == "mods" and f.get("request_id") == "s1")
        if BOXED:
            self.assertEqual(self.entry(listed, "ticker")["state"], "running")
        self.assertIsNone(consent.record("ticker"))

    def test_an_answer_to_a_question_already_answered_is_refused(self):
        h, _host = self.chat()
        self.turn(h, "write a counter mod", *writes("counter"))
        [offer] = h.of("mod_offer")
        self.answer(h, offer, False)
        h.backend._mods_command({"type": "mod_offer_answer", "request_id": "again", "id": offer["id"], "allow": True})
        refused = self.wait(h, lambda f: f["type"] == "command_rejected" and f.get("request_id") == "again")
        self.assertEqual(refused["message"], "That question was already answered.")

    def test_old_question_cannot_allow_new_capabilities(self):
        root = Path(tempfile.mkdtemp(prefix="dgc-mods-offer-change-"))
        folder = root / "mods" / "counter"
        folder.mkdir(parents=True)
        (folder / "main.py").write_text(CODE)
        (folder / "dgc-mod.json").write_text(manifest("counter"))
        host = ModHost(project_root=root)
        offer = host.wrote(folder)
        self.assertIsNotNone(offer)
        (folder / "dgc-mod.json").write_text(manifest("counter", events=["tool.call"]))
        with self.assertRaisesRegex(ModError, "changed since"):
            host.answer_offer(offer["id"], True)
        self.assertEqual(host.written_answer, None)
        self.assertEqual(host.written_grants, set())
        self.assertNotIn("counter", host.running)
        self.assertNotEqual(host.offer["id"], offer["id"])
        self.assertIn("event:tool.call", host.offer["grants"])

    def test_an_editor_that_never_said_it_shows_the_card_is_never_sent_one_and_the_list_says_written(self):
        h, host = self.chat(watch=False)
        self.turn(h, "write a counter mod", *writes("counter"))
        self.assertEqual(h.of("mod_offer"), [])
        self.assertEqual(self.entry({"mods": host.mods()}, "counter")["state"], "needs_allow")
        h.backend._mods_command({"type": "watch_mod_offers"})      # a webview that comes back shows it then
        [offer] = h.of("mod_offer")
        self.assertEqual(offer["name"], "counter")

    def test_a_mod_written_with_a_shell_command_is_asked_about_at_the_turns_end(self):
        h = self.make(git=True, mode="auto")
        h.backend._start_mods()
        self.addCleanup(bridge.stop, h.agent)
        h.backend._mods_command({"type": "watch_mod_offers"})
        (h.root / "mods").mkdir()
        (h.root / "mods" / "ok.txt").write_text("x")
        command = ("mkdir -p mods/shell && printf '%s' " + repr(manifest("shell")) + " > mods/shell/dgc-mod.json"
                   " && printf 'import dgc_mod as dm\\nmod = dm.Mod()\\nmod.run()\\n' > mods/shell/main.py")
        self.turn(h, "write a shell mod", ToolCall("b1", "bash", {"command": command}))
        self.assertEqual([f["name"] for f in h.of("mod_offer")], ["shell"])

    def test_a_name_another_mod_has_is_never_run_and_is_said_once(self):
        h, host = self.chat()
        self.turn(h, "write a tally mod", *writes("tally"))          # DGC's own Tally
        self.assertEqual(h.of("mod_offer"), [])
        toasts = [f for f in h.of("mod_toast") if f["mod"] == "DGC"]
        self.assertEqual(len(toasts), 1)
        self.assertIn("the name of one you already have", toasts[0]["text"])
        self.assertFalse(any(e.get("written") for e in host.mods()))

    def test_never_where_nobody_is_watching_or_while_mods_are_off(self):
        folder = Path(tempfile.mkdtemp(prefix="dgc-mods-written-src-")) / "counter"
        folder.mkdir()
        (folder / "dgc-mod.json").write_text(manifest("counter"))
        (folder / "main.py").write_text(CODE)
        said = []
        pip = ModHost(project_root=folder.parent, surface="pip", on_ui=lambda kind, p: said.append(kind))
        self.assertIsNone(pip.wrote(str(folder)))
        self.assertNotIn("offer", said)
        self.assertFalse(any(e.get("written") for e in pip.mods()))
        with patch.dict(os.environ, {"DGC_SAFE_MODE": "1"}):
            safe = ModHost(project_root=folder.parent, on_ui=lambda kind, p: said.append(kind))
            self.assertIsNone(safe.wrote(str(folder)))
        off = ModHost(project_root=folder.parent, on_ui=lambda kind, p: said.append(kind),
                      config={"mods_enabled": False})
        self.assertIsNone(off.wrote(str(folder)))
        self.assertNotIn("offer", said)

    def test_the_folder_a_written_file_belongs_to(self):
        root = Path(tempfile.mkdtemp(prefix="dgc-mods-written-root-"))
        (root / "mods" / "deep" / "src").mkdir(parents=True)
        (root / "mods" / "deep" / "dgc-mod.json").write_text("{}")
        self.assertEqual(bridge.mod_folder(root, "mods/deep/src/main.ts"), str((root / "mods" / "deep").resolve()))
        self.assertEqual(bridge.mod_folder(root, "mods/deep/dgc-mod.json"), str((root / "mods" / "deep").resolve()))
        self.assertIsNone(bridge.mod_folder(root, "README.md"))
        self.assertIsNone(bridge.mod_folder(root, "/etc/hosts"), "outside the project, never")
        (root / "node_modules" / "x").mkdir(parents=True)
        (root / "node_modules" / "x" / "dgc-mod.json").write_text("{}")
        self.assertIsNone(bridge.mod_folder(root, "node_modules/x/dgc-mod.json"))


def write_mod(folder: Path, name: str, who: str, **caps) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "dgc-mod.json").write_text(manifest(name, **caps))
    (folder / "main.py").write_text(CODE.replace("{title} here", who))
    return folder


class AnAllowIsForOneMod(unittest.TestCase):
    """An Allow holds for the mod it was given to, never for another folder that takes its name: a folder DGC wrote
    that renames itself to an installed mod's name is asked about again and gets none of that mod's grants."""

    def setUp(self):
        from dgc.mods import catalog
        home = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-mods-allow-")))
        env = patch.dict(os.environ, {"DGC_HOME": str(home)})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("DGC_SAFE_MODE", None)
        self.project = home / "project"
        self.project.mkdir()
        self.installed = catalog.install_folder(write_mod(home / "src-notes", "notes", "the installed notes",
                                                          reads=["project", "transcript"],
                                                          network=["api.notes.example"]))
        consent.allow(self.installed, unsandboxed=True)

    def host(self):
        host = ModHost(project_root=self.project, session_id="s1", surface="work")
        self.addCleanup(host.stop)
        return host

    def test_a_written_folder_renamed_to_an_allowed_mods_name_gets_nothing_of_it(self):
        from dgc.mods import catalog
        from dgc.mods.manifest import load
        host, toasts = self.host(), []
        host.on_ui = lambda kind, data: toasts.append(data) if kind == "toast" else None
        written = write_mod(self.project / "mods" / "x", "x", "model code")
        offer = host.wrote(str(written))
        self.assertIsNotNone(offer)
        host.answer_offer(offer["id"], False)                     # Not now: nothing runs
        write_mod(written, "notes", "model code", reads=["project", "transcript"], network=["api.notes.example"])
        self.assertIsNone(host.wrote(str(written)))
        self.assertEqual([t["name"] for t in toasts], ["notes"], "said: it can't run here under that name")
        self.assertNotIn(str(written.resolve()), [str(Path(e).resolve()) for e in host.extra])
        notes = next(m for m in host.mods() if m["name"] == "notes")
        self.assertFalse(notes["dev"])
        self.assertEqual(str(catalog.find("notes", host.extra).folder), str(self.installed.folder))
        renamed = load(written)
        self.assertFalse(consent.allowed(renamed))
        self.assertIsNone(consent.record_for(renamed), "not its grants, nor its unsandboxed")
        self.assertFalse(host._may_run(renamed))
        if BOXED:
            host.reload("notes")
            end = time.monotonic() + 10
            while time.monotonic() < end and not host.ui_state.get("notes"):
                time.sleep(0.05)
            self.assertEqual(str(host.running["notes"].manifest.folder), str(self.installed.folder))
            self.assertIn("the installed notes", json.dumps(host.ui_state.get("notes")))

    def test_a_written_folder_allowed_then_renamed_stops_and_asks_again(self):
        from dgc.mods.manifest import load
        host = self.host()
        written = write_mod(self.project / "mods" / "x", "x", "model code")
        offer = host.wrote(str(written))
        host.answer_offer(offer["id"], True)
        self.assertTrue(host._may_run(load(written)))
        write_mod(written, "notes", "model code", reads=["project"])
        self.assertIsNone(host.wrote(str(written)))
        self.assertNotIn("x", host.running)
        self.assertNotIn("x", host.written)
        self.assertNotIn("notes", host.written)
        write_mod(written, "jotter", "model code", reads=["project"])
        again = host.wrote(str(written))                          # its own name again: asked, as it asks for more
        self.assertIsNotNone(again)
        self.assertEqual(again["name"], "jotter")
        self.assertEqual(host.written, {"jotter": str(written.resolve())})

    def test_the_users_own_dev_folder_of_that_name_asks_for_its_own_allow(self):
        from dgc.mods.manifest import load
        dev = load(write_mod(self.project / "dev-notes", "notes", "my dev copy", reads=["project", "transcript"],
                             network=["api.notes.example"]))
        self.assertTrue(consent.allowed(self.installed))
        self.assertFalse(consent.allowed(dev))
        self.assertEqual(consent.missing(dev), dev.grants())
        host = ModHost(project_root=self.project, session_id="s1", surface="work", extra=(str(dev.folder),))
        self.addCleanup(host.stop)
        self.assertIsNone(host.wrote(str(dev.folder)), "the user's own dev folder is never asked about")
        self.assertFalse(host._may_run(dev))
        host.grant_session(dev)                                   # dgc mods dev: the user's own Allow, this session
        self.assertTrue(host._may_run(dev))
        consent.allow(dev)
        self.assertTrue(consent.allowed(dev))
        self.assertFalse(consent.allowed(self.installed), "one record per name: it now holds for the dev folder")

    def test_an_allow_kept_before_folders_were_recorded_holds_for_the_installed_copy_and_dgcs_own_only(self):
        from dgc.mods import catalog
        from dgc.mods.manifest import load
        with consent.write_lock():
            data = consent._read()
            data["notes"].pop("folder")
            consent._write(data)
        self.assertTrue(consent.allowed(self.installed))
        other = load(write_mod(self.project / "other", "notes", "another", reads=["project", "transcript"],
                               network=["api.notes.example"]))
        self.assertFalse(consent.allowed(other))
        builtin = catalog.builtins()[0]
        consent.allow(builtin)
        self.assertEqual(consent.record(builtin.name)["folder"], "builtin", "DGC's own: wherever DGC is installed")
        self.assertTrue(consent.allowed(builtin))


class TheProtocol(unittest.TestCase):
    def test_the_question_and_its_answer_are_declared_and_vendored(self):
        offer = {"type": "mod_offer", "seq": 1, "id": "mo_1", "name": "counter", "mod": "Counter", "version": "1.0.0",
                 "folder": "mods/counter", "asks": ["It can't reach the internet."], "more": False}
        self.assertIsNone(ep.event_error(offer))
        self.assertIsNotNone(ep.event_error({**offer, "plugin": "x"}), "an undeclared field is refused")
        self.assertIsNone(ep.command_error({"type": "watch_mod_offers"}))
        self.assertIsNone(ep.command_error({"type": "mod_offer_answer", "request_id": "r", "id": "mo_1",
                                            "allow": True, "surface": "chat"}))
        self.assertIsNotNone(ep.command_error({"type": "mod_offer_answer", "request_id": "r", "id": "mo_1"}))
        project = Path(__file__).resolve().parents[1]
        self.assertEqual((project / "sdk/python/dgc_sdk/wire/editor_protocol.py").read_text(),
                         (project / "dgc/editor_protocol.py").read_text())
        known = (project / "sdk/typescript/src/transport.ts").read_text()
        self.assertIn('"mod_offer"', known.split("KNOWN_EVENTS", 1)[1].split("]);", 1)[0])
        self.assertIn('"mod_offer"', (project / "editors/vscode/src/protocol.generated.ts").read_text())


if __name__ == "__main__":
    unittest.main()
