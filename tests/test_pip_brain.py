"""A Personal Pip on the user's own Claude Code or Codex (Pips API 55, pip_brain).

The founder (2026-10-20, "Let's do it"): a Pip on "Same as DGC" couldn't run when DGC's default was a subscription,
and a Pip couldn't be given one. Now its turns run on that CLI with the CLI's own tools off and the Pip's tools
served by DGC over MCP, so every Pip rule still holds. These tests drive a stand-in CLI that speaks each engine's
real output and talks MCP to DGC's relay (tests/fake_subscription_cli.py); the lock-down flags themselves were
verified against Claude Code 2.1.266 and Codex 0.153.4 (docs/PIPS.md).
"""
import base64
import json
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_chat, pip_computer, pips
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures
from tests.test_pip_eyes import JPEG, catalog_setup

FAKE = Path(__file__).with_name("fake_subscription_cli.py")


def install_clis(test, *, signed_in=("claude", "codex")):
    """A temporary PATH with the stand-in claude and codex, and a temporary HOME where each is signed in (the
    marker file only: DGC never opens it)."""
    bin_dir = test.base / "bin"
    bin_dir.mkdir()
    for name in ("claude", "codex"):
        path = bin_dir / name
        path.write_text(f"#!{sys.executable}\n" + FAKE.read_text())
        path.chmod(0o755)
    home = Path(os.environ["HOME"])
    for name, marker in (("claude", ".claude/.credentials.json"), ("codex", ".codex/auth.json")):
        if name in signed_in:
            (home / marker).parent.mkdir(parents=True, exist_ok=True)
            (home / marker).write_text("{}")
    path = patch.dict(os.environ, {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"})
    path.start()
    test.addCleanup(path.stop)
    for moved in ("CODEX_HOME", "CLAUDE_CONFIG_DIR"):       # never the real CLIs' logins
        if moved in os.environ:
            saved = os.environ.pop(moved)
            test.addCleanup(os.environ.__setitem__, moved, saved)
    return bin_dir


class Choices(unittest.TestCase):
    """What a Pip may be given, and where it is refused with one plain line."""

    def setUp(self):
        catalog_setup(self)
        install_clis(self)

    def test_a_personal_pip_takes_claude_code_or_codex_and_nothing_else(self):
        from dgc.pip_models import validate_model_choice
        for engine in ("claude", "codex"):
            self.assertEqual(validate_model_choice({"mode": "subscription", "engine": engine}),
                             {"mode": "subscription", "engine": engine})
        with self.assertRaises(RegistryError) as kimi:
            validate_model_choice({"mode": "subscription", "engine": "kimi"})
        self.assertEqual(str(kimi.exception), "Kimi Code always starts your own MCP servers, so it can't be held to DGC's "
                                              "tools alone. Pips don't use it.")
        for bad in ({"mode": "subscription"}, {"mode": "subscription", "engine": "codex", "model": "x"}):
            with self.assertRaises(RegistryError):
                validate_model_choice(bad)
        pip = self.store.create(self.registry.personal()["id"], "Tees", None, "editor-user", pip_type="lens",
                                model_choice={"mode": "subscription", "engine": "codex"})
        self.assertEqual(pip["model_choice"], {"mode": "subscription", "engine": "codex"})

    def test_a_project_pip_keeps_its_local_or_api_model_and_says_why_in_one_line(self):
        with self.assertRaises(RegistryError) as refused:
            self.store.create(self.workspace["id"], "Auditor", "Inspect correctness.", "device_1",
                              model_choice={"mode": "subscription", "engine": "codex"})
        self.assertEqual(refused.exception.code, "unsupported_model")
        self.assertEqual(str(refused.exception), "Project Pips need a local or API model: their source checks run only in "
                         "DGC's own loop. Personal Pips can use your subscription.")
        cfg = fixtures.config(self.root, subscription_engine="codex")
        with self.assertRaises(RegistryError) as following:
            pips._model_settings(cfg, {"mode": "default"})
        self.assertIn("Project Pips need a local or API model", str(following.exception))

    def test_same_as_dgc_follows_a_subscription_default_with_its_model_and_effort(self):
        cfg = fixtures.config(self.root, subscription_engine="codex", subscription_model="gpt-5.5", subscription_effort="max")
        settings = pips._model_settings(cfg, {"mode": "default"}, personal=True)
        self.assertEqual(settings["brain"], {"engine": "codex", "model": "gpt-5.5", "effort": "xhigh"})
        self.assertEqual(settings["model"], "codex:gpt-5.5")
        self.assertNotIn("base_url", settings, "a subscription run pins no endpoint of DGC's")
        chosen = pips._model_settings(cfg, {"mode": "subscription", "engine": "claude"}, personal=True)
        self.assertEqual(chosen["brain"], {"engine": "claude", "model": "", "effort": ""}, "a Pip's own pick uses the CLI's default")

    def test_a_cli_that_is_missing_or_signed_out_is_not_used(self):
        os.remove(Path(os.environ["HOME"]) / ".codex/auth.json")
        cfg = fixtures.config(self.root, subscription_engine="codex")
        with self.assertRaises(RegistryError) as signed_out:
            pips._model_settings(cfg, {"mode": "default"}, personal=True)
        self.assertEqual(str(signed_out.exception), "Codex isn't signed in on this computer. Run `codex login` once.")
        from dgc.pip_models import list_pip_models
        listed = list_pip_models(cfg)
        self.assertEqual(listed["subscriptions"], [{"engine": "claude", "name": "Claude Code"}])
        self.assertEqual(listed["default_engine"], {"engine": "codex", "name": "Codex", "available": False,
                                                    "reason": "Codex isn't signed in on this computer. Run `codex login` once."})
        self.assertEqual(listed["default_model"], "", "Same as DGC is the subscription, not the native model")
        self.assertTrue(listed["models"], "the user's own models stay choosable")

    def test_a_login_moved_with_the_clis_own_variable_is_found_by_existence_only(self):
        from dgc.pip_brain import available
        moved = self.base / "codex-login"
        moved.mkdir()
        with patch.dict(os.environ, {"CODEX_HOME": str(moved)}):
            self.assertEqual(available("codex"), "Codex isn't signed in on this computer. Run `codex login` once.")
            (moved / "auth.json").write_text("{}")
            with patch("builtins.open", side_effect=AssertionError("DGC never opens the CLI's login")):
                self.assertEqual(available("codex"), "")

    def test_the_picker_lists_the_signed_in_subscriptions(self):
        from dgc.pip_models import list_pip_models
        listed = list_pip_models(self.cfg)
        self.assertEqual(listed["subscriptions"], [{"engine": "claude", "name": "Claude Code"}, {"engine": "codex", "name": "Codex"}])
        self.assertNotIn("default_engine", listed)
        self.assertEqual(listed["default_model"], "fixture")


class Lockdown(unittest.TestCase):
    """The CLI's own tools are off and only DGC's MCP server is given, with exactly the flags verified by trying."""

    def test_claude_code_runs_with_no_tool_of_its_own(self):
        from dgc.pip_brain import claude_argv
        argv = claude_argv("/bin/claude", mcp_config=Path("/r/mcp.json"), system_file=Path("/r/i.md"), model="opus", effort="high")
        self.assertEqual(argv[:2], ["/bin/claude", "-p"])
        for flags in (["--tools", ""], ["--restricted"], ["--setting-sources", "project"], ["--strict-mcp-config"],
                      ["--mcp-config", "/r/mcp.json"], ["--allowedTools", "mcp__dgc"], ["--permission-mode", "dontAsk"],
                      ["--disable-slash-commands"], ["--no-session-persistence"], ["--system-prompt-file", "/r/i.md"],
                      ["--model", "opus"], ["--effort", "high"]):
            at = argv.index(flags[0])
            self.assertEqual(argv[at:at + len(flags)], flags)
        self.assertNotIn("--dangerously-skip-permissions", argv)
        self.assertNotIn("bypassPermissions", argv)

    def test_codex_runs_with_no_shell_patch_web_or_config_of_its_own(self):
        from dgc.pip_brain import CODEX_OFF, codex_argv
        argv = codex_argv("/bin/codex", relay=["/py", "-I", "/r.py"], env_names=["DGC_PIP_MCP_SOCKET", "DGC_PIP_MCP_TOKEN"],
                          system_file=Path("/r/i.md"), folder=Path("/r"), catalog=Path("/r/models.json"))
        self.assertEqual(argv[:2], ["/bin/codex", "exec"])
        self.assertEqual(argv[-1], "-", "the prompt comes on stdin, never in argv")
        for flag in ("--ignore-user-config", "--ignore-rules", "--ephemeral", "--json"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--sandbox") + 1], "read-only")
        settings = [argv[i + 1] for i, a in enumerate(argv) if a == "-c"]
        for setting in ('approval_policy="never"', 'web_search="disabled"', "skills.include_instructions=false",
                        "project_doc_max_bytes=0", 'model_catalog_json="/r/models.json"', 'model_instructions_file="/r/i.md"',
                        'mcp_servers.dgc.default_tools_approval_mode="approve"'):
            self.assertIn(setting, settings)
        for feature in ("shell_tool", "unified_exec", "view_image", "apps", "plugins", "multi_agent", "image_generation",
                        "browser_use", "computer_use", "hooks"):
            self.assertIn(feature, CODEX_OFF)
            self.assertIn(f"features.{feature}=false", settings)
        self.assertFalse(any("DGC_PIP_MCP_TOKEN=" in a or "env=" in a.split("=")[0] for a in settings),
                         "the run's token reaches the relay by name only, never in argv")

    def test_codex_reads_a_catalog_without_patch_shell_search_sub_agents_or_code_mode(self):
        from dgc.pip_brain import CATALOG_OFF
        self.assertEqual(CATALOG_OFF["apply_patch_tool_type"], None)
        self.assertEqual(CATALOG_OFF["shell_type"], "disabled")
        self.assertIs(CATALOG_OFF["supports_search_tool"], False)
        self.assertEqual(CATALOG_OFF["tool_mode"], "direct_only")
        self.assertIsNone(CATALOG_OFF["multi_agent_version"])

    def test_the_cli_gets_no_dgc_secret_and_its_own_login_home(self):
        from dgc.pip_brain import child_env, launch_pin
        with patch("dgc.pip_brain.available", return_value=""), \
                patch("dgc.subscriptions.SubEngine.resolve", return_value="/bin/codex"):
            import tempfile
            folder = Path(tempfile.mkdtemp()) / "brain"
            environ = {"PATH": "/usr/bin", "LANG": "C.UTF-8", "OPENAI_API_KEY": "sk-1", "ANTHROPIC_API_KEY": "sk-2",
                       "DGC_API_KEY": "d", "GITHUB_TOKEN": "g", "CODEX_HOME": "/h/.codex", "CLAUDE_CONFIG_DIR": "/h/.claude",
                       "HTTPS_PROXY": "http://proxy:1"}
            launch = launch_pin({"engine": "codex", "model": "", "effort": ""}, folder, environ)
        self.assertEqual(launch["env"], {"PATH": "/usr/bin", "LANG": "C.UTF-8", "CODEX_HOME": "/h/.codex",
                                         "HTTPS_PROXY": "http://proxy:1"})
        self.assertEqual(oct(folder.stat().st_mode & 0o777), "0o700")
        env = child_env(launch, {"DGC_PIP_MCP_TOKEN": "t"})
        self.assertEqual(env["HOME"], str(Path.home()))
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("CLAUDE_CONFIG_DIR", env, "only the engine's own config location")


class ConsoleTests(unittest.TestCase):
    """`dgc pips create|propose --subscription`, and `dgc pips models` naming what a Personal Pip may run on."""

    def test_the_cli_asks_for_a_subscription_and_lists_them(self):
        from dgc import pip_cli
        request = pip_cli._request(pip_cli.parser().parse_args(
            ["create", "Tees", "--goal", "Help", "--workspace", "ws_a", "--subscription", "codex"]))
        self.assertEqual(request["model_choice"], {"mode": "subscription", "engine": "codex"})
        request = pip_cli._request(pip_cli.parser().parse_args(
            ["propose", "pip_a", "--expected-version", "2", "--subscription", "claude", "--reason", "Mine."]))
        self.assertEqual(request["changes"]["model_choice"], {"mode": "subscription", "engine": "claude"})
        said = pip_cli._format({"default_model": "", "models": [{"id": "qwen3.6:27b", "name": "qwen3.6:27b"}],
                                "subscriptions": [{"engine": "codex", "name": "Codex"}],
                                "default_engine": {"engine": "codex", "name": "Codex", "available": True}})
        self.assertEqual(said.splitlines()[0], "DGC default: Codex (your subscription)")
        self.assertIn("Your subscriptions, for Personal Pips: Codex (--subscription codex)", said)


class ToolServerTests(unittest.TestCase):
    def test_only_this_runs_token_opens_its_tools_and_screens_come_back_as_images(self):
        import socket as _socket
        from dgc.pip_brain import ToolServer
        calls = []
        server = ToolServer([{"type": "function", "function": {"name": "computer", "description": "Its computer.",
                                                               "parameters": {"type": "object", "properties": {}}}}],
                            lambda name, args: calls.append((name, args)) or {"text": "the screen", "images": [("image/jpeg", JPEG)]})
        self.addCleanup(server.close)
        self.assertEqual(oct(server.path.stat().st_mode & 0o777), "0o600")

        def talk(token, *messages):
            with _socket.socket(_socket.AF_UNIX) as link:
                link.connect(str(server.path))
                link.sendall(json.dumps({"token": token}).encode() + b"\n")
                reader = link.makefile("rb")
                replies = []
                for message in messages:
                    try:
                        link.sendall(json.dumps(message).encode() + b"\n")
                        line = reader.readline()
                    except (BrokenPipeError, ConnectionResetError):
                        line = b""     # the server already hung up on a wrong token
                    replies.append(json.loads(line) if line else None)
                return replies

        self.assertEqual(talk("wrong", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}), [None])
        self.assertEqual(server.refused, 1)
        listed, called, unknown = talk(server.token, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                                       {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "computer", "arguments": {"op": "look"}}},
                                       {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "Bash", "arguments": {}}})
        self.assertEqual(listed["result"]["tools"], [{"name": "computer", "description": "Its computer.",
                                                      "inputSchema": {"type": "object", "properties": {}}}])
        content = called["result"]["content"]
        self.assertEqual(content[0], {"type": "image", "data": base64.b64encode(JPEG).decode(), "mimeType": "image/jpeg"})
        self.assertEqual(content[1], {"type": "text", "text": "the screen"})
        self.assertTrue(unknown["result"]["isError"])
        self.assertEqual(calls, [("computer", {"op": "look"})], "a tool DGC didn't offer is never run")


class Turns(unittest.TestCase):
    """Whole Pip turns on the stand-in CLI, through execute_native: the Pip's own handlers answer every call."""

    def setUp(self):
        catalog_setup(self)
        self.bin = install_clis(self)
        self.ops = []

    def act(self, op, args):
        self.ops.append((op, args))
        if op in ("look", "desktop_look", "click_at"):
            return {"text": "The shop's page.", "image": base64.b64encode(JPEG).decode(), "width": 4, "height": 3}
        return {"text": "Teeforge: Design your tee. Upload a design."}

    def turn(self, engine, script, *, text="design me my birthday shirts", computer=True, choice=None, events=None):
        (self.bin / "script.json").write_text(json.dumps(script))
        pip = self.store.create(self.registry.personal()["id"], "Tees", None, "editor-user", pip_type="lens",
                                model_choice=choice or {"mode": "subscription", "engine": engine},
                                computer_plan={"schema_version": 1} if computer else None)
        run = pip_chat.send(self.store, pip["id"], text, "k-" + os.urandom(3).hex(), "editor-user", self.cfg)["run"]
        manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
        self.assertEqual(manifest["model_settings"]["brain"]["engine"], engine)
        if computer:
            socket = pip_computer.RunSocket(types.SimpleNamespace(act=self.act), "run_" + os.urandom(16).hex())
            self.addCleanup(socket.close)
            manifest = {**manifest, "computer_socket": socket.pin(),
                        "computer_eyes": {"choice": "ask", "vision_model": None, "convention": "pixels"}}
        from dgc import pip_brain
        from dgc.llm import LLMClient
        launch = pip_brain.launch_pin(manifest["model_settings"]["brain"], self.base / ("brain-" + os.urandom(3).hex()))
        events = [] if events is None else events
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True)),
                                     "DGC_PIP_BRAIN": json.dumps(launch)}), \
                patch.object(LLMClient, "chat", side_effect=AssertionError("a subscription run sends DGC no request")), \
                patch("dgc.vision.has_vision", side_effect=AssertionError("its CLI sees; nothing is probed")), \
                patch("dgc.agent.discover_skills", return_value={}), \
                patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
            result = pips.execute_native(self.cfg, self.root, manifest, events.append)
        seen = json.loads((self.bin / "seen.json").read_text())
        return result, seen, launch

    def test_a_codex_turn_sees_its_screen_and_ends_at_its_choices(self):
        result, seen, launch = self.turn("codex", [
            {"say": "I'll open the shop on my computer."}, {"call": "computer", "args": {"op": "look"}},
            {"say": "The shop is open."}, {"call": "offer_choices", "args": {"choices": ["Large", "Medium"]}},
            {"say": "This text comes after the choices and is never shown."}])
        self.assertIn("computer", seen["tools"])
        self.assertIn("offer_choices", seen["tools"])
        self.assertNotIn("bash", seen["tools"])
        self.assertEqual(seen["answers"][0]["types"], ["image", "text"], "Codex sees the screenshot")
        self.assertEqual(self.ops[0][0], "look", "the Pip's own computer took the step")
        self.assertEqual(result["text"], "I'll open the shop on my computer.\n\nThe shop is open.")
        self.assertEqual(result["choices"], ["Large", "Medium"])
        self.assertEqual(seen["cwd"], launch["folder"], "it runs in the run's own folder")
        self.assertEqual(seen["home"], str(Path.home()), "its own login's home")
        for name in ("OPENAI_API_KEY", "DGC_SESSION_POLICY", "DGC_PIP_BRAIN", "PYTHONPATH"):
            self.assertNotIn(name, seen["env"])
        self.assertIn("You are a personal DGC Pip.", seen["system"])
        self.assertIn("mcp__dgc__NAME", seen["system"])
        self.assertIn("design me my birthday shirts", seen["prompt"])
        for model in seen["catalog"]["models"]:
            self.assertIsNone(model["apply_patch_tool_type"])
            self.assertEqual(model["tool_mode"], "direct_only")
        self.assertEqual(result["usage"]["input_tokens"], 120)

    def test_choices_offered_before_any_words_wait_for_the_words(self):
        # Take 2 of the shirts ask (2026-10-20): Codex offered its choices first, and the chat got an empty reply.
        result, seen, _ = self.turn("codex", [
            {"call": "offer_choices", "args": {"choices": ["Bold", "Playful"]}},
            {"say": "Which look do you want for the shirts?"},
            {"call": "offer_choices", "args": {"choices": ["Bold", "Playful"]}}], computer=False)
        self.assertTrue(seen["answers"][0]["error"])
        self.assertIn("Write your message first", seen["answers"][0]["text"])
        self.assertEqual(result["text"], "Which look do you want for the shirts?")
        self.assertEqual(result["choices"], ["Bold", "Playful"])

    def test_a_claude_code_turn_keeps_the_pip_rules_an_address_it_guessed_is_refused(self):
        draft = {"recipient_email": "guess@nowhere.example", "subject": "Your shirts", "body": "Hi, here are the shirts."}
        result, seen, _ = self.turn("claude", [{"call": "draft_email", "args": draft},
                                               {"say": "I need the exact address for that email."}],
                                    text="email the shirt design to my friend", computer=False)
        self.assertEqual(seen["servers"], ["dgc"], "only DGC's MCP server")
        self.assertIn("draft_email", seen["tools"])
        self.assertIn("Not drafted", seen["answers"][0]["text"], "the Pip's own handler refused the guessed address")
        self.assertNotIn("message_draft", result)
        self.assertEqual(result["text"], "I need the exact address for that email.")

    def test_a_cli_that_reaches_for_its_own_shell_is_stopped(self):
        with self.assertRaises(RegistryError) as stopped:
            self.turn("claude", [{"say": "Let me look."}, {"own": "Bash"}], text="run ls ~ in your shell")
        self.assertEqual(str(stopped.exception), "Claude Code tried to use its own Bash, which a Pip can't. The turn was stopped.")

    def test_a_cli_failure_reads_plainly(self):
        with self.assertRaises(RegistryError) as failed:
            self.turn("codex", [{"fail": "You've hit your usage limit."}], computer=False)
        self.assertEqual(failed.exception.code, "model_failed")
        self.assertEqual(str(failed.exception), "Codex didn't finish this turn: You've hit your usage limit.")

    def test_same_as_dgc_runs_on_dgcs_subscription_default(self):
        self.cfg.data["subscription_engine"] = "codex"
        result, seen, _ = self.turn("codex", [{"say": "Hello! What shall we make?"}], choice={"mode": "default"},
                                    computer=False, text="hi")
        self.assertEqual(result["text"], "Hello! What shall we make?")
        self.assertEqual(seen["engine"], "codex")


if __name__ == "__main__":
    unittest.main()
