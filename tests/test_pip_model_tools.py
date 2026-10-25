"""The main chat sees and sets Pips' models (Pips API 66; the founder, 24 Oct 2026).

His Work chat told him: "The Pips all run on the default model deepseek-v4.1-flash:cloud. That is per-Pip and can only
be changed in the Pips editor UI (per-Pip model picker), not through my tools." Half wrong then, and now wholly: the
chat reads which models Pips can use with each one's context window (pips_context models), changes one Pip's model
and its own context window (pips_propose model_choice, context_window; a Personal Pip may run on the user's Claude
Code or Codex), changes the Pips default (pips_settings), and gives a new Pip a model and window that fit its job
(pips_setup). Every change is a tool call that asks the user first, and none of them touches a permission.
"""
from __future__ import annotations

import io
import json
import re
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from dgc import config as config_module
from dgc import pip_chat_options, pip_context_tool, pip_models, pip_proposal_tool, pip_setup, pip_setup_tool, pips
from dgc import sessions, tools, workspace_sessions
from dgc.llm import ToolCall
from dgc.permissions import ALLOW, ASK, DENY, DISPLAY, PermissionEngine
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pip_proposal_tool as proposal_fixtures
from tests import test_pips_local as local_fixtures

CATALOG = ["deepseek-v4.1-flash:cloud", "glm-5.3:cloud", "house-model"]
REPO = Path(__file__).resolve().parents[1]


def catalog(models=CATALOG):
    """DGC's configured connection lists these models; nothing reaches a network."""
    factory = patch.object(pip_models, "LLMClient")
    client = factory.start().return_value
    client.list_models.return_value = list(models)
    return factory


def description(name):
    return next(t["function"] for t in tools.TOOL_SCHEMAS if t["function"]["name"] == name)


class Fixture(unittest.TestCase):
    """A project with one Pip, a main chat in it, and DGC's connection offering CATALOG."""
    create = proposal_fixtures.PipProposalToolTests.create
    context = proposal_fixtures.PipProposalToolTests.context
    agent = proposal_fixtures.PipProposalToolTests.agent
    git = local_fixtures.LocalPipsTests.git
    commit = local_fixtures.LocalPipsTests.commit

    def setUp(self):
        proposal_fixtures.PipProposalToolTests.setUp(self)
        self.cfg.data.update(model="deepseek-v4.1-flash:cloud", context_size=32768)
        factory = catalog()
        self.addCleanup(factory.stop)
        for target in (pip_proposal_tool, pip_setup_tool, workspace_sessions):
            reopened = patch.object(target, "WorkspaceRegistry", self.reopen)
            reopened.start()
            self.addCleanup(reopened.stop)
        offline = patch("requests.sessions.Session.request", side_effect=AssertionError("No network"))
        offline.start()
        self.addCleanup(offline.stop)

    def reopen(self):
        return WorkspaceRegistry(self.registry.directory, clock=self.registry.clock)

    def propose(self, args, ctx=None):
        return json.loads(pip_proposal_tool.propose(args, ctx or self.context()))

    def change(self, pip, changes, *, key="change-1", version=1, **extra):
        return {"pip_id": pip["id"], "expected_version": version, "changes": changes,
                "reason": "The user asked for it in the chat.", "request_key": key, **extra}

    def asked(self, name, args, verdict):
        """The main chat calls `name` in default mode; the user answers `verdict` on its approval card."""
        agent, approvals = self.agent()
        self.cfg.data["mode"] = "default"
        agent.ui.verdict = verdict
        return agent._handle_call(ToolCall("call-" + verdict, name, args)), approvals

    def window(self, pip):
        return pip_chat_options.saved(self.registry.db, pip["id"])


class TheChatSeesWhichModelsPipsCanUse(Fixture):
    def read(self):
        return json.loads(pip_context_tool.read({"action": "models"}, self.context()))

    def test_each_model_comes_with_the_window_dgc_knows_for_it(self):
        self.cfg.data["model_context_sizes"] = {"glm-5.3:cloud": 65536}
        with patch("dgc.pip_brain.offered", return_value=[]):
            listed = self.read()
        self.assertEqual([{k: v for k, v in row.items() if k != "runs"} for row in listed["models"]], [
            {"id": "deepseek-v4.1-flash:cloud", "context_window": 65536},   # DGC's recommendation for deepseek
            {"id": "glm-5.3:cloud", "context_window": 65536},               # the window the user chose for it
            {"id": "house-model"}], "a model DGC knows no window for says none, never a guess")
        self.assertEqual(listed["context_window_range"], {"min": 2048, "max": 1048576, "dgc_window": 32768})
        self.assertEqual(listed["pips_default"], {"model": "", "follows_dgc": True,
                                                  "runs_on": "deepseek-v4.1-flash:cloud"})
        self.assertIn("Use only these ids", listed["notice"])

    # The founder, 25 Oct (after an 81 GB local model load took the machine down): when the chat picks a model itself it
    # prefers the Pips default or a cloud model, and a local one only when asked for or already loaded. So the list says
    # where each model runs and, for a local Ollama, which are loaded now.
    def test_each_model_says_where_it_runs_and_a_local_one_whether_it_is_loaded_now(self):
        self.cfg.data["base_url"] = "http://127.0.0.1:11434/v1"
        ps = MagicMock(status_code=200)
        ps.json.return_value = {"models": [{"name": "house-model", "model": "house-model"}]}
        with patch("dgc.pip_brain.offered", return_value=[]), patch("requests.get", return_value=ps) as get:
            listed = self.read()
        self.assertEqual({row["id"]: (row["runs"], row.get("loaded")) for row in listed["models"]},
                         {"deepseek-v4.1-flash:cloud": ("cloud", None), "glm-5.3:cloud": ("cloud", None),
                          "house-model": ("local", True)})
        self.assertEqual(get.call_args.args[0], "http://127.0.0.1:11434/api/ps")
        ps.json.return_value = {"models": []}
        with patch("dgc.pip_brain.offered", return_value=[]), patch("requests.get", return_value=ps):
            listed = self.read()
        self.assertIs(next(r for r in listed["models"] if r["id"] == "house-model")["loaded"], False)
        self.assertIn("choose a local model only when the user asked for one or it is loaded now", listed["notice"])

    def test_a_remote_connection_lists_every_model_as_cloud_and_asks_nothing_more(self):
        self.cfg.data["base_url"] = "https://api.example.com/v1"
        with patch("dgc.pip_brain.offered", return_value=[]), patch("requests.get") as get:
            listed = self.read()
        self.assertEqual({row["runs"] for row in listed["models"]}, {"cloud"})
        self.assertFalse(any("loaded" in row for row in listed["models"]))
        get.assert_not_called()

    def test_a_local_server_that_cannot_say_leaves_loaded_out(self):
        self.cfg.data["base_url"] = "http://127.0.0.1:11434/v1"
        with patch("dgc.pip_brain.offered", return_value=[]), patch("requests.get", side_effect=OSError("refused")):
            listed = self.read()
        local = next(r for r in listed["models"] if r["id"] == "house-model")
        self.assertEqual(local["runs"], "local")
        self.assertNotIn("loaded", local)

    def test_it_says_the_pips_default_and_the_subscriptions_a_personal_pip_can_use(self):
        self.cfg.data["pips_model"] = "glm-5.3:cloud"
        with patch("dgc.pip_brain.offered", return_value=[{"engine": "claude", "name": "Claude Code"}]):
            listed = self.read()
        self.assertEqual(listed["pips_default"], {"model": "glm-5.3:cloud", "follows_dgc": False,
                                                  "runs_on": "glm-5.3:cloud"})
        self.assertEqual(listed["subscriptions"], [{"engine": "claude", "name": "Claude Code"}])

    def test_the_pips_page_list_carries_the_same_windows(self):
        # Pips API 66: list_pip_models, the Pips page's list, carries them too, with the Pips default as set.
        self.cfg.data["pips_model"] = "glm-5.3:cloud"
        listed = pip_models.list_pip_models(self.cfg)
        self.assertEqual(listed["pips_model"], "glm-5.3:cloud")
        self.assertEqual([row.get("context_window") for row in listed["models"]], [65536, 131072, None])

    def test_a_list_that_cannot_load_says_why_and_still_reads(self):
        pip_models.LLMClient.return_value.list_models.side_effect = OSError("refused")
        listed = self.read()
        self.assertEqual(listed["models"], [])
        self.assertEqual(listed["error"]["code"], "model_catalog_unavailable")

    def test_a_pips_model_and_window_show_in_its_definition_and_the_list(self):
        pip = self.store.create(self.workspace["id"], "Billing audit", "Review billing code.", "user",
                                model_choice={"mode": "model", "model": "glm-5.3:cloud"})
        pip_chat_options.save(self.registry, pip["id"], {"context_size": 65536, "thinking": "off"})
        with patch.object(pip_context_tool, "WorkspaceRegistry", self.reopen):
            shown = json.loads(pip_context_tool.read({"action": "definition", "pip_id": pip["id"]}, self.context()))
            listed = json.loads(pip_context_tool.read({"action": "list"}, self.context()))
        self.assertEqual(shown["pip"]["model_choice"], {"mode": "model", "model": "glm-5.3:cloud"})
        self.assertEqual((shown["pip"]["context_window"], shown["pip"]["context_window_source"]), (65536, "own"))
        self.assertEqual(next(p for p in listed["pips"] if p["id"] == pip["id"])["model_choice"],
                         {"mode": "model", "model": "glm-5.3:cloud"})


class TheChatChangesAPipsModelAndWindow(Fixture):
    def test_a_model_changes_only_after_the_user_allows_it(self):
        pip = self.create()
        args = self.change(pip, {"model_choice": {"mode": "model", "model": "glm-5.3:cloud"}})
        refused, approvals = self.asked("pips_propose", args, "no")
        self.assertIn("DENIED", refused)
        self.assertEqual(approvals, ["pips_propose"], "it asked")
        self.assertEqual(self.store.get(pip["id"])["model_choice"], {"mode": "default"}, "nothing changed")
        allowed, approvals = self.asked("pips_propose", args, "once")
        self.assertEqual(approvals, ["pips_propose"])
        receipt = json.loads(allowed)
        self.assertTrue(receipt["job_changed_by_this_call"])
        self.assertEqual(receipt["model_choice"], {"mode": "model", "model": "glm-5.3:cloud"})
        self.assertFalse(receipt["execution_started"])
        saved = self.store.get(pip["id"])
        self.assertEqual((saved["model_choice"], saved["current_version"]),
                         ({"mode": "model", "model": "glm-5.3:cloud"}, 2))
        self.assertEqual(saved["policy"], pip["policy"], "a model is not a permission")
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_runs").fetchone()[0], 0)

    def test_a_window_changes_only_after_the_user_allows_it_and_keeps_its_thinking(self):
        pip = self.create()
        pip_chat_options.save(self.registry, pip["id"], {"context_size": 32768, "thinking": "high"})
        args = self.change(pip, {"context_window": 65536})
        refused, _ = self.asked("pips_propose", args, "no")
        self.assertIn("DENIED", refused)
        self.assertEqual(self.window(pip), {"context_size": 32768, "thinking": "high"})
        receipt = json.loads(self.asked("pips_propose", args, "once")[0])
        self.assertEqual(receipt["context_window"], 65536)
        self.assertIn("64K (65,536 tokens)", receipt["message"])
        self.assertEqual(self.window(pip), {"context_size": 65536, "thinking": "high"})
        self.assertEqual(self.store.get(pip["id"])["current_version"], 1, "its job is unchanged")
        controls = pip_chat_options.controls(self.store, pip["id"], self.cfg)
        self.assertEqual(controls["options"]["context_size"], 65536, "its prompt box shows it")

    def test_a_model_and_a_window_in_one_ask(self):
        # "Switch my Billing audit Pip to glm-5.3:cloud with a 64k window."
        pip = self.store.create(self.workspace["id"], "Billing audit", "Review billing code.", "user")
        receipt = self.propose(self.change(pip, {"model_choice": {"mode": "model", "model": "glm-5.3:cloud"},
                                                 "context_window": 65536}))
        self.assertEqual(receipt["status"], "accepted")
        self.assertEqual(self.store.get(pip["id"])["model_choice"]["model"], "glm-5.3:cloud")
        self.assertEqual(self.window(pip)["context_size"], 65536)
        self.assertRegex(receipt["message"], r"^Applied\. Its context window is now 64K .* Tell the user what changed\.$")

    def test_the_approval_card_names_the_pip_and_says_what_changes(self):
        from dgc import ui, workspace_registry
        pip = self.store.create(self.workspace["id"], "Billing audit", "Review billing code.", "user")
        args = self.change(pip, {"model_choice": {"mode": "model", "model": "glm-5.3:cloud"}, "context_window": 65536})
        with patch.object(workspace_registry, "state_directory", lambda: self.registry.directory):
            line = ui.arg_summary("pips_propose", args)
        self.assertEqual(line, "Change Pip “Billing audit”: model → glm-5.3:cloud; context window → 64K tokens")
        self.assertEqual(ui.arg_summary("pips_settings", {"default_model": "glm-5.3:cloud", "reason": "x"}),
                         "Pips default model → glm-5.3:cloud")

    def test_a_model_not_in_the_list_is_refused_before_anything_is_written(self):
        pip = self.create()
        with self.assertRaisesRegex(RegistryError, "isn't one of the models Pips can use") as caught:
            self.propose(self.change(pip, {"model_choice": {"mode": "model", "model": "gpt-imaginary"}}))
        self.assertEqual(caught.exception.code, "model_not_available")
        self.assertIn("pips_context models", str(caught.exception))
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_proposals").fetchone()[0], 0)

    def test_a_window_out_of_range_is_refused_before_the_registry_opens(self):
        pip = self.create()
        for window in (1024, 2_000_000, True, "64k", 65536.0):
            with self.subTest(window=window), \
                    patch.object(pip_proposal_tool, "WorkspaceRegistry", side_effect=AssertionError("must not open")), \
                    self.assertRaises(RegistryError) as caught:
                self.propose(self.change(pip, {"context_window": window}))
            self.assertIn(caught.exception.code, ("invalid_context_window",))
        self.assertIsNone(self.window(pip))

    def test_a_project_pip_never_runs_on_a_subscription(self):
        pip = self.create()
        with patch("dgc.pip_brain.available", return_value=""), \
                patch.object(pip_proposal_tool, "WorkspaceRegistry", side_effect=AssertionError("must not open")), \
                self.assertRaisesRegex(RegistryError, "Project Pips need a local or API model") as caught:
            self.propose(self.change(pip, {"model_choice": {"mode": "subscription", "engine": "claude"}}))
        self.assertEqual(caught.exception.code, "unsupported_model")

    def test_permissions_schedules_and_commands_still_cannot_change(self):
        pip = self.create()
        for key, value in (("schedule", None), ("policy", "read_write"), ("verification_plan", {}),
                           ("app_plan", {}), ("pip_type", "patch"), ("thinking", "high")):
            with self.subTest(key=key), self.assertRaises(RegistryError):
                self.propose(self.change(pip, {key: value}))
        self.assertEqual(self.store.get(pip["id"])["current_version"], 1)

    def test_an_archived_pip_keeps_its_window(self):
        pip = self.create()
        with patch("dgc.pip_archive.require_live", side_effect=RegistryError("archived", "This Pip is archived.")):
            with self.assertRaisesRegex(RegistryError, "archived"):
                self.propose(self.change(pip, {"context_window": 65536}))
        self.assertIsNone(self.window(pip))


class APersonalPipsSubscription(Fixture):
    def setUp(self):
        super().setUp()
        self.personal = self.registry.personal()
        self.pip = self.store.create(self.personal["id"], "Inbox helper", "Sort my mail.", "local-console")
        signed_in = patch("dgc.pip_brain.available", return_value="")
        signed_in.start()
        self.addCleanup(signed_in.stop)

    def test_it_runs_on_claude_code_after_the_user_allows_it(self):
        args = self.change(self.pip, {"model_choice": {"mode": "subscription", "engine": "claude"},
                                      "context_window": 131072}, scope="personal")
        refused, approvals = self.asked("pips_propose", args, "no")
        self.assertIn("DENIED", refused)
        self.assertEqual(self.store.get(self.pip["id"])["model_choice"], {"mode": "default"})
        receipt = json.loads(self.asked("pips_propose", args, "once")[0])
        self.assertEqual(receipt["status"], "accepted", receipt)
        self.assertEqual(self.store.get(self.pip["id"])["model_choice"], {"mode": "subscription", "engine": "claude"})
        self.assertEqual(self.window(self.pip)["context_size"], 131072)

    def test_a_personal_pip_needs_scope_personal(self):
        with self.assertRaisesRegex(RegistryError, "A Personal Pip needs scope personal"):
            self.propose(self.change(self.pip, {"context_window": 65536}))
        with self.assertRaisesRegex(RegistryError, "For a Personal Pip, send scope personal"):
            self.propose(self.change(self.pip, {"model_choice": {"mode": "subscription", "engine": "claude"}},
                                     scope="project"))
        self.assertIsNone(self.window(self.pip))
        with self.assertRaisesRegex(RegistryError, "no project source"):
            self.propose(self.change(self.pip, {"source_ref": "main"}, scope="personal"))

    def test_scope_personal_never_reaches_a_project_pip(self):
        project = self.create()
        with self.assertRaisesRegex(RegistryError, "Personal Pips"):
            self.propose(self.change(project, {"context_window": 65536}, scope="personal"))
        self.assertIsNone(self.window(project))

    def test_a_subscription_that_is_not_signed_in_is_refused(self):
        with patch("dgc.pip_brain.available", return_value="Codex isn't signed in on this computer."), \
                self.assertRaisesRegex(RegistryError, "isn't signed in"):
            self.propose(self.change(self.pip, {"model_choice": {"mode": "subscription", "engine": "codex"}},
                                     scope="personal"))
        self.assertEqual(self.store.get(self.pip["id"])["current_version"], 1)


class TheChatChangesThePipsDefault(Fixture):
    def apply(self, args):
        from dgc import pip_settings_tool
        return json.loads(pip_settings_tool.apply(args, self.context()))

    def test_it_changes_only_after_the_user_allows_it(self):
        args = {"default_model": "glm-5.3:cloud", "reason": "The user wants Pips on GLM."}
        refused, approvals = self.asked("pips_settings", args, "no")
        self.assertIn("DENIED", refused)
        self.assertEqual(approvals, ["pips_settings"])
        self.assertEqual(self.cfg.get("pips_model"), "", "nothing changed")
        receipt = json.loads(self.asked("pips_settings", args, "once")[0])
        self.assertEqual((receipt["pips_model"], receipt["previous"], receipt["changed"]), ("glm-5.3:cloud", "", True))
        self.assertEqual(self.cfg.get("pips_model"), "glm-5.3:cloud")
        self.assertEqual(pip_models.resolve_model_choice(self.cfg, {"mode": "default"}), "glm-5.3:cloud",
                         "every Pip on Default now runs it")

    def test_blank_goes_back_to_following_dgc(self):
        self.cfg.data["pips_model"] = "glm-5.3:cloud"
        receipt = self.apply({"default_model": "", "reason": "Follow DGC again."})
        self.assertEqual((receipt["pips_model"], receipt["changed"]), ("", True))
        self.assertIn("deepseek-v4.1-flash:cloud", receipt["message"])
        self.assertEqual(self.cfg.get("pips_model"), "")

    def test_a_model_not_in_the_list_is_refused(self):
        for bad, code in (("gpt-imaginary", "model_not_available"), ("http://evil/v1", "invalid_model"),
                          ("two words", "invalid_model")):
            with self.subTest(bad=bad), self.assertRaises(RegistryError) as caught:
                self.apply({"default_model": bad, "reason": "Try it."})
            self.assertEqual(caught.exception.code, code)
        self.assertEqual(self.cfg.get("pips_model"), "")

    def test_it_asks_like_pips_propose_and_only_the_main_chat_has_it(self):
        self.assertEqual(DISPLAY["pips_settings"], "PipsSettings")
        for mode, expected in (("default", ASK), ("acceptEdits", ASK), ("plan", DENY), ("auto", ALLOW)):
            with self.subTest(mode=mode):
                self.assertEqual(PermissionEngine(mode, {}, self.root).decide("pips_settings", {})[0], expected)
                self.assertEqual(PermissionEngine(mode, {"deny": ["PipsSettings"]}, self.root)
                                 .decide("pips_settings", {})[0], DENY)
        agent, _ = self.agent()
        self.assertIn("pips_settings", {s["function"]["name"] for s in agent._tool_schemas()})
        agent.depth = 1
        self.assertNotIn("pips_settings", {s["function"]["name"] for s in agent._tool_schemas()})
        self.assertIn("main user chat", agent._handle_call(ToolCall("child", "pips_settings",
                                                                    {"default_model": "", "reason": "x"})))
        self.assertEqual(self.cfg.get("pips_model"), "")


class ANewPipGetsAModelAndWindowThatFitItsJob(Fixture):
    def setUp(self):
        super().setUp()
        self.commit()

    def setup(self, **changes):
        request = dict(target_root=str(self.root), name="Deep code review", goal="Review the payment module in depth.",
                       pip_type="rook", work_kind="source_review", schedule=None, run_now=False,
                       reason="The user asked for a deep review Pip.", request_key="setup-1", **changes)
        return json.loads(pip_setup_tool.propose(request, self.context()))

    def test_the_card_carries_the_pick_and_creating_it_applies_both(self):
        made = self.setup(model_choice={"mode": "model", "model": "glm-5.3:cloud"}, context_window=131072)
        card = made["setup"]
        self.assertEqual(card["status"], "pending", "outside auto mode it is a card")
        self.assertEqual(card["model_choice"], {"mode": "model", "model": "glm-5.3:cloud"})
        self.assertIn("context window of 128K tokens", card["runner_notice"])
        self.assertEqual(made["context_window"], 131072)
        accepted = pip_setup.review(self.registry, card["id"], card["workspace_id"], card["digest"], "editor-user",
                                    self.cfg, True)
        pip = self.store.get(accepted["receipt"]["pip_id"])
        self.assertEqual(pip["model_choice"], {"mode": "model", "model": "glm-5.3:cloud"})
        self.assertEqual(pip_chat_options.saved(self.registry.db, pip["id"]), {"context_size": 131072, "thinking": "off"})

    def test_changing_the_model_on_the_card_keeps_the_window(self):
        card = self.setup(model_choice={"mode": "model", "model": "glm-5.3:cloud"}, context_window=131072)["setup"]
        revised = pip_setup.revise(self.registry, card["id"], card["workspace_id"], card["digest"],
                                   {"mode": "model", "model": "deepseek-v4.1-flash:cloud"}, "editor-user", self.cfg)
        self.assertIn("128K tokens", revised["runner_notice"])
        accepted = pip_setup.review(self.registry, revised["id"], revised["workspace_id"], revised["digest"],
                                    "editor-user", self.cfg, True)
        self.assertEqual(pip_chat_options.saved(self.registry.db, accepted["receipt"]["pip_id"])["context_size"], 131072)

    def test_a_card_never_offers_a_model_that_is_not_in_the_list(self):
        with self.assertRaisesRegex(RegistryError, "isn't one of the models Pips can use"):
            self.setup(model_choice={"mode": "model", "model": "gpt-imaginary"})
        for window in (512, 4_000_000, "128k"):
            with self.subTest(window=window), self.assertRaises(RegistryError):
                self.setup(context_window=window)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_setup_proposals").fetchone()[0], 0)

    def test_without_a_pick_a_new_pip_starts_as_before(self):
        card = self.setup()["setup"]
        self.assertEqual(card["model_choice"], {"mode": "default"})
        self.assertNotIn("context window", card["runner_notice"])
        accepted = pip_setup.review(self.registry, card["id"], card["workspace_id"], card["digest"], "editor-user",
                                    self.cfg, True)
        self.assertIsNone(pip_chat_options.saved(self.registry.db, accepted["receipt"]["pip_id"]))

    def test_the_pips_prompt_says_how_to_pick_and_change_models(self):
        agent, _ = self.agent()
        self.cfg.data["mode"] = "default"
        prompt = agent.system_prompt()
        self.assertIn("pips_context models lists the models Pips can use", prompt)
        self.assertIn("say in one line what you picked and why", prompt)
        self.assertIn("To change the model every Pip on Default uses, use pips_settings", prompt)
        self.assertNotIn("For goal, schedule or model changes use a complete pips_setup card", prompt)

    def test_the_rule_is_in_the_setup_tool_and_the_prompt(self):
        setup = description("pips_setup")["description"]
        self.assertIn("Prefer the Pips default (leave model_choice out) or a model that runs in the cloud", setup)
        self.assertIn("only when the user asked for a local model or it is loaded now", setup)
        agent, _ = self.agent()
        self.cfg.data["mode"] = "default"
        prompt = agent.system_prompt()
        self.assertIn("Prefer the Pips default or a cloud model", prompt)
        self.assertIn("pick a model that runs locally only when the user asked for one or it is loaded now", prompt)

    def test_the_approval_line_says_the_pick(self):
        from dgc import ui
        line = ui.arg_summary("pips_setup", {"name": "Deep code review", "pip_type": "rook", "schedule": None,
                                             "model_choice": {"mode": "model", "model": "glm-5.3:cloud"},
                                             "context_window": 131072})
        self.assertIn("glm-5.3:cloud · 128K tokens window", line)


class TheToolsSayWhatTheyCanChange(unittest.TestCase):
    """The model learns its abilities from these words alone: they must say plainly what changes and how."""
    BANNED = re.compile(r"\bAI\b")

    def test_pips_context_lists_models(self):
        tool = description("pips_context")
        self.assertIn("models", tool["parameters"]["properties"]["action"]["enum"])
        self.assertIn("models: action only. The models Pips can use, each with its context window", tool["description"])

    def test_pips_propose_changes_a_model_and_a_window_and_says_so_first(self):
        tool = description("pips_propose")
        first = tool["description"].split(". ")[0]
        self.assertIn("model or context window", first)
        changes = tool["parameters"]["properties"]["changes"]["properties"]
        self.assertEqual(changes["model_choice"]["properties"]["mode"]["enum"], ["default", "model", "subscription"])
        self.assertEqual(changes["model_choice"]["properties"]["engine"]["enum"], ["claude", "codex"])
        self.assertEqual((changes["context_window"]["minimum"], changes["context_window"]["maximum"]), (2048, 1048576))
        self.assertIn("scope", tool["parameters"]["properties"])
        self.assertNotIn("use pips_setup with its pip_id, expected_version", tool["description"],
                         "no more sending a model change to a whole setup card")

    def test_pips_settings_changes_the_pips_default(self):
        tool = description("pips_settings")
        self.assertTrue(tool["description"].startswith("Change the Pips default model"))
        self.assertEqual(tool["parameters"]["required"], ["default_model", "reason"])

    def test_pips_setup_recommends_from_the_real_list_and_says_its_pick(self):
        text = description("pips_setup")["description"]
        self.assertIn("read pips_context models first", text)
        self.assertIn("Say in one line which model and window you picked and why", text)
        self.assertIn("context_window", description("pips_setup")["parameters"]["properties"])

    def test_use_pips_mentions_models_so_a_question_about_them_loads_the_tools(self):
        self.assertIn("see which models Pips can use", description("use_pips")["description"])

    def test_no_tool_names_a_model_as_the_only_choice_or_says_ai(self):
        for name in ("use_pips", "pips_context", "pips_propose", "pips_settings", "pips_setup", "pips_adapt"):
            text = json.dumps(description(name))
            with self.subTest(name=name):
                self.assertIsNone(re.search(r"glm|deepseek|qwen|gpt-|claude-|llama", text, re.I))
                self.assertIsNone(self.BANNED.search(text))



class TheApiSaysIt(unittest.TestCase):
    def test_api_66_is_advertised_and_documented(self):
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 66)
        doc = (REPO / "sdk" / "PIPS.md").read_text(encoding="utf-8")
        row = next(line for line in doc.splitlines() if line.startswith("| 66 |"))
        self.assertIn("context_window", row)
        self.assertIn("pips_model", row)

    def test_no_new_command_so_older_sdks_and_editors_keep_working(self):
        # The new fields are additive in an existing read's result; list_pip_models is refused below no new version.
        from dgc_sdk import pips as sdk_pips
        self.assertNotIn("pips_settings", sdk_pips.READ_COMMANDS | sdk_pips.MUTATION_COMMANDS)
        self.assertIn("list_pip_models", sdk_pips.READ_COMMANDS)

    def test_the_sdk_policies_name_the_new_tool(self):
        from dgc_sdk.policy import _DISPLAY
        self.assertEqual(_DISPLAY["pips_settings"], "PipsSettings")
        ts = (REPO / "sdk" / "typescript" / "src" / "policy.ts").read_text(encoding="utf-8")
        self.assertIn('pips_settings: "PipsSettings"', ts)


class AnOpenSettingsPageShowsIt(unittest.TestCase):
    """The chat's change reaches Settings > Agents > Pips at once, through the events Settings already reads."""

    def setUp(self):
        from dgc import editor_protocol as ep, headless
        from dgc.config import Config
        self.ep, self.headless = ep, headless
        tmp = Path(tempfile.mkdtemp(prefix="dgc-pip-model-tools-")).resolve()
        self.user = tmp / "user-dgc"
        self.user.mkdir()
        for name, value in (("USER_HOME", self.user), ("USER_CONFIG", self.user / "config.json"),
                            ("USER_SECRETS", self.user / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.root = tmp / "project"
        (self.root / ".git").mkdir(parents=True)
        (self.user / "config.json").write_text(json.dumps({
            "suggest": False, "artifact_autostart": False, "mcp_servers": {}, "model": "dgc-main",
            "base_url": "http://127.0.0.1:9/v1", "pips_enabled": True}))
        self.wire = io.StringIO()
        sessions_dir = patch.object(sessions, "SESSIONS_DIR", self.user / "sessions")
        sessions_dir.start()
        self.addCleanup(sessions_dir.stop)
        self.host = headless.Host(Config(project_root=self.root))
        self.host.core.fp = self.wire
        self.addCleanup(lambda: [chat.agent.mcp.stop_all() for chat in list(self.host.chats.values())])
        factory = catalog(["dgc-main", "glm-5.3:cloud"])
        self.addCleanup(factory.stop)

    def frames(self, kind):
        frames = [json.loads(line) for line in self.wire.getvalue().splitlines()]
        for frame in frames:
            self.assertIsNone(self.ep.event_error(frame), frame)
        return [f for f in frames if f["type"] == kind]

    def test_the_tool_result_brings_pips_settings_and_config(self):
        chat = self.host.default
        self.host.dispatch({"type": "get_config", "request_id": "c1", "fields": ["pips_settings"]})
        before = len(self.frames("config"))
        out = tools.EXECUTORS["pips_settings"]({"default_model": "glm-5.3:cloud", "reason": "Asked in the chat."},
                                               chat.agent.ctx)
        chat.ui.tool_result("pips_settings", out, "call-1")
        self.assertEqual(self.frames("pips_settings")[-1]["model"], "glm-5.3:cloud")
        self.assertEqual(len(self.frames("config")), before + 1, "the config Settings re-reads, after it")
        self.assertEqual(json.loads((self.user / "config.json").read_text())["pips_model"], "glm-5.3:cloud",
                         "saved for the runner and every other DGC")
        told = len(self.frames("pips_settings"))
        chat.ui.tool_result("pips_settings", "ERROR: model_not_available", "call-2")
        self.assertEqual(len(self.frames("pips_settings")), told, "a refused change says nothing new")


if __name__ == "__main__":
    unittest.main()
