"""Several backends share ~/.dgc/config.json, and none of them may revert another.

This is not a future problem. Two VS Code windows are already two `dgc serve` processes against
one config file, and `save()` wrote this process's whole in-memory copy -- so the last writer won
and everything the other had changed since IT loaded was silently reverted.

The worst case is not a lost setting. `Config.save()` also writes `permissions`, so a `deny` rule
added in one chat was erased by an unrelated settings change in another. That fails OPEN.
"""
from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


class ConcurrentConfigTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        (self.home / ".dgc").mkdir(parents=True, exist_ok=True)
        self.path = self.home / ".dgc" / "config.json"
        self.path.write_text(json.dumps({"model": "start", "thinking": "off"}))
        self._home = os.environ.get("HOME")
        os.environ["HOME"] = str(self.home)
        from dgc import config as C
        self.C = importlib.reload(C)

    def tearDown(self):
        if self._home is not None:
            os.environ["HOME"] = self._home
        from dgc import config as C
        importlib.reload(C)

    def disk(self) -> dict:
        return json.loads(self.path.read_text())

    # ---- settings ---------------------------------------------------------------------------

    def test_two_backends_changing_different_settings_keep_both(self):
        a, b = self.C.Config(), self.C.Config()      # both open, as two chats would be
        a.set("model", "qwen-A")
        b.set("thinking", "high")
        self.assertEqual(self.disk().get("model"), "qwen-A", "A's change was reverted")
        self.assertEqual(self.disk().get("thinking"), "high")

    def test_the_later_writer_adopts_what_it_did_not_change(self):
        a, b = self.C.Config(), self.C.Config()
        a.set("model", "qwen-A")
        b.set("thinking", "high")
        self.assertEqual(b.data.get("model"), "qwen-A",
                         "B should end up holding what A wrote, not its own stale value")

    def test_a_key_this_process_removes_is_removed(self):
        a = self.C.Config()
        a.data.pop("thinking", None)
        a.save()
        self.assertNotIn("thinking", self.disk())

    # ---- permissions ------------------------------------------------------------------------

    def test_a_deny_rule_is_not_erased_by_another_backend(self):
        # The fail-open case: a rule that narrows what may run must never be dropped by a save
        # that had nothing to do with it.
        a, b = self.C.Config(), self.C.Config()
        a.permissions.setdefault("deny", []).append("Bash(rm -rf /)")
        a.save()
        b.set("model", "qwen-B")
        self.assertEqual(self.disk()["permissions"]["deny"], ["Bash(rm -rf /)"])

    def test_two_backends_granting_different_rules_keep_both(self):
        a, b = self.C.Config(), self.C.Config()
        a.permissions.setdefault("allow", []).append("Bash(npm test)")
        a.save()
        b.permissions.setdefault("allow", []).append("Bash(git status)")
        b.save()
        self.assertEqual(sorted(self.disk()["permissions"]["allow"]),
                         ["Bash(git status)", "Bash(npm test)"])

    def test_a_rule_this_process_revokes_is_revoked(self):
        # Merging must not mean "additions only": a revoke has to survive the round trip.
        first = self.C.Config()
        first.permissions.setdefault("deny", []).append("Bash(curl evil)")
        first.save()
        second = self.C.Config()
        second.permissions["deny"].remove("Bash(curl evil)")
        second.save()
        self.assertEqual(self.disk()["permissions"]["deny"], [])

    def test_project_rules_are_still_never_persisted(self):
        # apply_project_permissions merges workspace rules into the live set. They must not read
        # as rules this process added, or the next save writes a cloned repo's rules into the
        # user's own config.
        project = self.home / "proj"
        (project / ".dgc").mkdir(parents=True)
        (project / ".dgc" / "permissions.json").write_text(json.dumps({"allow": ["Bash(make)"]}))
        cfg = self.C.Config(project_root=project)
        cfg._project_permissions_applied = False
        if cfg.apply_project_permissions():
            self.assertIn("Bash(make)", cfg.permissions["allow"], "the rule is live")
        cfg.set("model", "qwen-C")
        self.assertNotIn("Bash(make)", self.disk()["permissions"]["allow"],
                         "a workspace rule was written into the user's config")

    # ---- project rules: live for THEIR project, never persisted, never inherited ---------------
    #
    # Both halves of this were broken in shipped 0.46.4, in opposite directions, and the test above
    # missed both: its fixture always pre-creates config.json (so only the second save() branch ran),
    # and it checked that the rule was not PERSISTED -- a symptom -- never that it was still IN EFFECT
    # after the save. Reproduced before fixing:
    #   first save on a machine : a trusted project's allow AND deny were written into the global
    #                             config, so ANOTHER, untrusted project then inherited the allow
    #   every later save        : the project's deny silently left the live engine (fails open)

    def _project_with_rules(self):
        project = self.home / "proj"
        (project / ".dgc").mkdir(parents=True, exist_ok=True)
        (project / ".dgc" / "permissions.json").write_text(
            json.dumps({"deny": ["Bash(rm -rf *)"], "allow": ["Bash(curl *)"]}))
        cfg = self.C.Config(project_root=project)
        cfg._project_permissions_applied = False
        self.assertTrue(cfg.apply_project_permissions(), "premise: the project rules were applied")
        return cfg

    def _decide(self, cfg, command, mode="default"):
        from dgc.permissions import PermissionEngine
        rules = {a: list(cfg.permissions.get(a, [])) for a in ("allow", "ask", "deny")}
        return PermissionEngine(mode, rules, cfg.project_root).decide("bash", {"command": command})[0]

    def _check_invariant(self, cfg):
        cfg.set("model", "an-unrelated-change")        # any save, of anything
        self.assertEqual(self._decide(cfg, "rm -rf build", mode="auto"), "deny",
                         "the project's deny stopped applying after an unrelated save (fails OPEN)")
        self.assertEqual(self._decide(cfg, "curl https://x"), "allow",
                         "the project's allow stopped applying after an unrelated save")
        on_disk = self.disk().get("permissions", {})
        self.assertNotIn("Bash(rm -rf *)", on_disk.get("deny", []), "project deny leaked into the user's config")
        self.assertNotIn("Bash(curl *)", on_disk.get("allow", []), "project allow leaked into the user's config")
        other = self.home / "unrelated"
        other.mkdir(exist_ok=True)
        stranger = self.C.Config(project_root=other)
        self.assertEqual(self._decide(stranger, "curl https://x"), "ask",
                         "a DIFFERENT project inherited another project's allow")
        # and it survives a second save too
        cfg.set("thinking", "high")
        self.assertEqual(self._decide(cfg, "rm -rf build", mode="auto"), "deny")
        self.assertNotIn("Bash(rm -rf *)", self.disk().get("permissions", {}).get("deny", []))

    def test_project_rules_hold_on_an_existing_install(self):
        self._check_invariant(self._project_with_rules())

    def test_project_rules_hold_on_the_first_save_of_a_new_install(self):
        self.path.unlink()                              # every new install starts here
        self._check_invariant(self._project_with_rules())

    def test_a_user_rule_that_matches_a_project_rule_is_still_saved(self):
        """Subtracting the project's rules must not take the user's own identical rule with it."""
        cfg = self._project_with_rules()
        cfg.permissions["deny"].append("Bash(rm -rf *)")   # the user ALSO denies it, globally
        cfg.set("model", "x")
        self.assertIn("Bash(rm -rf *)", self.disk()["permissions"]["deny"],
                      "the user's own rule was dropped because a project shares it")

    def test_the_editor_saves_a_user_rule_that_a_project_also_has(self):
        """The add command deduped against the LIVE list, where the project's copy already sat, so
        a deny the user added for every project applied only inside this one."""
        from types import SimpleNamespace
        from dgc.headless import Backend
        cfg = self._project_with_rules()
        events = []
        backend = object.__new__(Backend)
        backend.config = cfg
        backend.em = SimpleNamespace(emit=lambda kind, **kw: events.append({"type": kind, **kw}))
        backend._busy = lambda: False
        backend._dispatch({"type": "add_permission_rule", "request_id": "r1",
                           "action": "deny", "rule": "Bash(rm -rf *)"})
        elsewhere = self.home / "elsewhere"
        elsewhere.mkdir()
        self.assertEqual(self._decide(self.C.Config(project_root=elsewhere), "rm -rf build", mode="auto"),
                         "deny", "the user's deny was never saved, so other projects run it")
        listing = [item for item in events[-1]["items"] if item["rule"] == "Bash(rm -rf *)"]
        self.assertEqual(listing, [{"action": "deny", "rule": "Bash(rm -rf *)"}],
                         "one rule to the reader, though it is live twice")

    def test_a_project_rule_the_user_removes_stays_removed(self):
        """The editor lists project rules beside the user's; its remove drops every live copy."""
        cfg = self._project_with_rules()
        cfg.permissions["allow"] = [r for r in cfg.permissions["allow"] if r != "Bash(curl *)"]
        cfg.save()
        self.assertEqual(self._decide(cfg, "curl https://x"), "ask",
                         "save() put back a project allow the user had just removed")
        cfg.set("model", "again")
        self.assertEqual(self._decide(cfg, "curl https://x"), "ask", "...or at the next save")
        self.assertEqual(self._decide(cfg, "rm -rf build", mode="auto"), "deny",
                         "the project's other rules still apply")
        fresh = self.C.Config(project_root=cfg.project_root)
        fresh._project_permissions_applied = False
        fresh.apply_project_permissions()
        self.assertEqual(self._decide(fresh, "curl https://x"), "allow",
                         "the removal was this session's; the project's file still says allow")

    def test_removing_a_rule_that_both_hold_removes_it(self):
        cfg = self._project_with_rules()
        cfg.permissions["deny"].append("Bash(rm -rf *)")       # the user's own copy as well
        cfg.save()
        cfg.permissions["deny"] = [r for r in cfg.permissions["deny"] if r != "Bash(rm -rf *)"]
        cfg.save()
        self.assertNotIn("Bash(rm -rf *)", self.disk()["permissions"]["deny"])
        self.assertEqual(self._decide(cfg, "rm -rf build"), "ask")

    def test_the_sdk_policy_keeps_stored_allow_rules_out_after_a_save(self):
        """An SDK RuntimePolicy with project_allow=False strips the user's stored allow rules at
        load: only its callback's own "always" answers may pre-approve. That answer is itself a
        save, and the rebuild from disk re-armed every stored allow."""
        self.path.write_text(json.dumps({"model": "start", "permissions":
                                         {"allow": ["Bash(curl *)"], "ask": [], "deny": []}}))
        os.environ["DGC_SESSION_POLICY"] = json.dumps({"version": 1, "project_allow": False})
        self.addCleanup(os.environ.pop, "DGC_SESSION_POLICY", None)
        work = self.home / "work"
        work.mkdir()
        cfg = self.C.Config(project_root=work)
        self.assertEqual(self._decide(cfg, "curl https://x"), "ask", "premise: stripped at load")
        cfg.permissions["allow"].append("Bash(ls)")          # the callback answered "always"
        cfg.save()
        self.assertEqual(self._decide(cfg, "curl https://x"), "ask",
                         "a save re-armed an allow rule the session policy had stripped (fails OPEN)")
        self.assertEqual(self._decide(cfg, "ls"), "allow", "the callback's own answer still holds")
        self.assertIn("Bash(curl *)", self.disk()["permissions"]["allow"],
                      "the user's stored rule is left alone on disk")

    def test_a_deny_added_after_a_save_reaches_a_running_subagent(self):
        """clone_for_root() shares the parent's rules dict with every sub-agent; save() replaced it."""
        work = self.home / "w"
        work.mkdir()
        parent = self.C.Config(project_root=work)
        child = parent.clone_for_root(self.home / "worktree")
        parent.set("model", "anything")                       # any save at all, first
        parent.permissions["deny"].append("Bash(rm -rf *)")   # then the user denies, mid-run
        parent.save()
        self.assertEqual(self._decide(child, "rm -rf build", mode="auto"), "deny",
                         "a sub-agent running in auto never saw the deny the user just added")

    # ---- trust and mode: an untrusted folder, a revoked one -----------------------------------

    def test_an_untrusted_folder_never_rewrites_the_stored_mode(self):
        self.path.write_text(json.dumps({"model": "start", "mode": "auto"}))
        untrusted = self.home / "cloned-repo"
        untrusted.mkdir()
        cfg = self.C.Config(project_root=untrusted)
        self.assertTrue(cfg.hold_untrusted_mode(), "premise: auto needs trust")
        cfg.set("thinking", "high")                   # any save at all
        self.assertEqual(self.disk()["mode"], "auto",
                         "opening one untrusted folder reset the user's mode everywhere")
        self.assertEqual(cfg.mode, "default", "and the save did not adopt auto back over the hold")

    def test_the_editor_backend_never_rewrites_the_stored_mode(self):
        from dgc.headless import Backend
        self.path.write_text(json.dumps({"model": "start", "mode": "auto"}))
        untrusted = self.home / "cloned-repo"
        untrusted.mkdir()
        backend = Backend(self.C.Config(project_root=untrusted))
        self.addCleanup(backend.agent.mcp.stop_all)
        self.assertEqual(backend.agent.mode, "default", "premise: auto needs trust")
        backend.config.set("thinking", "high")
        self.assertEqual(self.disk()["mode"], "auto",
                         "opening an untrusted folder in the editor reset the user's mode everywhere")

    def test_an_acp_session_never_rewrites_the_stored_mode(self):
        from dgc import acp
        self.path.write_text(json.dumps({"model": "start", "mode": "auto"}))
        untrusted = self.home / "cloned-repo"
        untrusted.mkdir()
        server, replies = acp.ACPServer(), []
        server.respond = lambda rid, result=None, error=None: replies.append(result or error)
        server.notify = lambda method, params: None
        server._dispatch({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1}})
        server._dispatch({"jsonrpc": "2.0", "id": 2, "method": "session/new",
                          "params": {"cwd": str(untrusted), "mcpServers": []}})
        state = server._sessions[replies[-1]["sessionId"]]
        self.addCleanup(state.agent.mcp.stop_all)
        self.assertEqual(state.config.mode, "default", "premise: auto needs trust")
        state.config.set("thinking", "high")
        self.assertEqual(self.disk()["mode"], "auto", "an ACP session in an untrusted folder reset it")

    def test_a_trusted_folder_keeps_its_mode(self):
        self.path.write_text(json.dumps({"model": "start", "mode": "auto"}))
        mine = self.home / "mine"
        mine.mkdir()
        cfg = self.C.Config(project_root=mine)
        from dgc.trust import mark_trusted
        mark_trusted(cfg, mine)
        self.assertFalse(cfg.hold_untrusted_mode())
        self.assertEqual(cfg.mode, "auto")

    def test_a_stale_config_cannot_bring_back_a_revoked_folder(self):
        from dgc.trust import mark_trusted, revoke_trust
        x, y = self.home / "x", self.home / "y"
        x.mkdir()
        y.mkdir()
        mark_trusted(self.C.Config(), x)
        a, b = self.C.Config(), self.C.Config()        # both loaded while x was trusted
        self.assertTrue(revoke_trust(a, x))
        mark_trusted(b, y)                             # b still holds x in memory
        stored = [os.path.realpath(t) for t in self.disk()["trusted_dirs"]]
        self.assertEqual(stored, [os.path.realpath(y)], "the revoke was undone by a stale writer")
        self.assertNotIn(os.path.realpath(x), [os.path.realpath(t) for t in b.data["trusted_dirs"]],
                         "and b itself no longer believes x is trusted")

    def test_trust_granted_elsewhere_brings_the_project_rules_with_it(self):
        """Two sessions in one folder (ACP today, every chat soon): A trusts it and loads the
        project's deny; B adopts the trust at its next save and must load the same rules."""
        from dgc.trust import is_trusted, mark_trusted
        project = self.home / "p"
        (project / ".dgc").mkdir(parents=True)
        (project / ".dgc" / "permissions.json").write_text(json.dumps({"deny": ["Bash(rm -rf *)"]}))
        a, b = self.C.Config(project_root=project), self.C.Config(project_root=project)
        mark_trusted(a, project)
        self.assertEqual(self._decide(a, "rm -rf build", mode="auto"), "deny", "premise")
        b.set("thinking", "high")                   # any save: B adopts trusted_dirs from disk
        self.assertTrue(is_trusted(b, project), "premise: B now treats the folder as trusted")
        self.assertEqual(self._decide(b, "rm -rf build", mode="auto"), "deny",
                         "B is trusted here but never loaded the project's deny (fails OPEN)")
        self.assertNotIn("Bash(rm -rf *)", self.disk()["permissions"]["deny"], "and still never persisted")

    def test_no_config_shares_a_default_container(self):
        a = self.C.Config()
        a.data["disabled_skills"].append("leaked")
        self.assertNotIn("leaked", self.C.DEFAULTS["disabled_skills"])
        self.assertNotIn("leaked", self.C.Config().data.get("disabled_skills", []))

    # ---- the file itself ----------------------------------------------------------------------

    def test_a_missing_config_is_written_whole(self):
        self.path.unlink()
        cfg = self.C.Config()
        cfg.set("model", "fresh")
        self.assertEqual(self.disk().get("model"), "fresh")

    def test_an_unreadable_config_does_not_lose_this_process_state(self):
        # Merging into {} would silently drop every key another backend had written; a corrupt
        # file means "write mine whole" instead.
        cfg = self.C.Config()
        cfg.set("model", "mine")
        self.path.write_text("{ this is not json")
        cfg.set("thinking", "high")
        self.assertEqual(self.disk().get("model"), "mine")
        self.assertEqual(self.disk().get("thinking"), "high")

    def test_secrets_never_reach_the_config_file(self):
        cfg = self.C.Config()
        for key in self.C.SECRET_KEYS:
            cfg.data[key] = "s3cret"
        cfg.set("model", "qwen")
        for key in self.C.SECRET_KEYS:
            self.assertNotIn(key, self.disk(), f"{key} was written to config.json")

    def test_writes_are_serialised_across_processes(self):
        import inspect
        source = inspect.getsource(self.C.Config.save)
        self.assertIn("_config_write_lock", source,
                      "concurrent saves must not interleave read and replace")


if __name__ == "__main__":
    unittest.main()
