"""Claude Code's models in the one model picker (0.52): its nicknames (fable, opus, sonnet, haiku), the real version
each one ran as (Claude Code says it when a session starts: its stream's ``system``/``init`` event carries ``model``),
and the fixed versions a user can pin. The CLI has no command that lists its models, so DGC keeps what it has seen."""

import json
import os
import stat
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from dgc import subscriptions as subs


def init(model, **more):
    return json.dumps({"type": "system", "subtype": "init", "session_id": "s-1", "model": model, **more})


class ClaudeCodeModelsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        env = patch.dict(os.environ, {"HOME": str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("DGC_HOME", None)

    def test_fable_is_one_of_its_nicknames_and_comes_first(self):
        self.assertEqual(subs.ENGINES["claude"].model_hints, ("fable", "opus", "sonnet", "haiku"))

    def test_the_fixed_versions_are_one_list(self):
        self.assertEqual(subs.CLAUDE_FIXED_MODELS,
                         ("claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"))

    def test_a_session_start_records_what_the_nickname_ran_as(self):
        events = subs.parse_stream_events("claude", init("claude-opus-5-5"), {"asked_model": "opus"})
        self.assertEqual(events, [{"kind": "session", "id": "s-1"}], "the reader sees the same events as before")
        self.assertEqual(subs.claude_models(), {"versions": {"opus": "claude-opus-5-5"}, "seen": ["claude-opus-5-5"]})
        kept = self.home / ".dgc" / "subscription-models.json"
        self.assertTrue(kept.is_file(), "kept in DGC's own folder")
        self.assertEqual(stat.S_IMODE(kept.stat().st_mode), 0o600)

    def test_a_newer_version_replaces_the_nicknames_and_both_stay_seen(self):
        subs.parse_stream_events("claude", init("claude-opus-5-5"), {"asked_model": "opus"})
        subs.parse_stream_events("claude", init("claude-opus-6-0"), {"asked_model": "opus"})
        self.assertEqual(subs.claude_models(), {"versions": {"opus": "claude-opus-6-0"},
                                                "seen": ["claude-opus-6-0", "claude-opus-5-5"]})

    def test_the_cli_default_and_a_fixed_version_are_recorded_as_what_they_are(self):
        subs.parse_stream_events("claude", init("claude-sonnet-5-5"), {"asked_model": ""})
        subs.parse_stream_events("claude", init("claude-haiku-5-1"), {"asked_model": "claude-haiku-5-1"})
        kept = subs.claude_models()
        self.assertEqual(kept["versions"], {"": "claude-sonnet-5-5"}, "a fixed version is no nickname")
        self.assertEqual(kept["seen"], ["claude-haiku-5-1", "claude-sonnet-5-5"])

    def test_nothing_is_recorded_without_the_model_that_was_asked_for(self):
        # Qwen Code's stream mirrors Claude Code's, and a reader with no turn of its own passes no state.
        subs.parse_stream_events("claude", init("claude-opus-5-5"))
        subs.parse_stream_events("claude", init("claude-opus-5-5"), {})
        subs.parse_stream_events("qwen", init("qwen3-coder"), {"asked_model": "opus"})
        self.assertEqual(subs.claude_models(), {"versions": {}, "seen": []})

    def test_a_name_that_is_no_model_name_is_never_kept(self):
        for bad in ("", "x" * 200, "claude opus", "claude\nopus", "<synthetic>", 7, None, {"id": "claude-opus-5-5"}):
            subs.parse_stream_events("claude", init(bad), {"asked_model": "opus"})
        self.assertEqual(subs.claude_models(), {"versions": {}, "seen": []})

    def test_only_a_session_start_says_it(self):
        subs.parse_stream_events("claude", json.dumps({"type": "system", "subtype": "api_retry", "model": "claude-opus-5-5"}),
                                 {"asked_model": "opus"})
        subs.parse_stream_events("claude", json.dumps({"type": "assistant", "model": "claude-opus-5-5", "message": {"content": []}}),
                                 {"asked_model": "opus"})
        self.assertEqual(subs.claude_models(), {"versions": {}, "seen": []})

    def test_what_is_seen_is_bounded_and_a_broken_file_reads_as_nothing(self):
        for n in range(40):
            subs.parse_stream_events("claude", init(f"claude-opus-9-{n}"), {"asked_model": "opus"})
        kept = subs.claude_models()
        self.assertEqual(len(kept["seen"]), 16)
        self.assertEqual(kept["seen"][0], "claude-opus-9-39", "the newest first")
        (self.home / ".dgc" / "subscription-models.json").write_text("{not json")
        self.assertEqual(subs.claude_models(), {"versions": {}, "seen": []})
        (self.home / ".dgc" / "subscription-models.json").write_text(json.dumps(
            {"claude": {"versions": {"opus": 4, "x" * 99: "claude-opus-5-5", "sonnet": "claude-sonnet-5-5"}, "seen": ["ok-1", 3, "no good"]}}))
        self.assertEqual(subs.claude_models(), {"versions": {"sonnet": "claude-sonnet-5-5"}, "seen": ["ok-1"]})

    def test_a_folder_that_cannot_be_written_never_breaks_the_turn(self):
        (self.home / ".dgc").write_text("a file where the folder should be")
        events = subs.parse_stream_events("claude", init("claude-opus-5-5"), {"asked_model": "opus"})
        self.assertEqual(events, [{"kind": "session", "id": "s-1"}])
        self.assertEqual(subs.claude_models(), {"versions": {}, "seen": []})

    def test_the_engine_list_carries_the_versions_and_the_fixed_models_for_claude_code_only(self):
        subs.parse_stream_events("claude", init("claude-opus-5-5"), {"asked_model": "opus"})
        subs.parse_stream_events("claude", init("claude-sonnet-4-9"), {"asked_model": "claude-sonnet-4-9"})
        rows = {row["key"]: row for row in subs.status()}
        claude = rows["claude"]
        self.assertEqual(claude["model_hints"], ["fable", "opus", "sonnet", "haiku"])
        self.assertEqual(claude["model_versions"], {"opus": "claude-opus-5-5"})
        self.assertEqual(claude["fixed_models"], ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5",
                                                  "claude-haiku-5-5", "claude-sonnet-4-9"],
                         "the built-in list first, then what Claude Code has reported besides, each once")
        for key in ("codex", "qwen", "kimi", "copilot"):
            self.assertNotIn("model_versions", rows[key])
            self.assertNotIn("fixed_models", rows[key])

    def test_a_delegated_turn_records_the_model_it_asked_for(self):
        # The real path: run_turn starts the CLI with --model and reads its stream.
        cli = self.home / "claude"
        cli.write_text("#!/usr/bin/env python3\nimport json, sys\n"
                       "asked = sys.argv[sys.argv.index('--model') + 1] if '--model' in sys.argv else ''\n"
                       "real = {'fable': 'claude-fable-5-2', '': 'claude-sonnet-5-5'}.get(asked, asked)\n"
                       "print(json.dumps({'type': 'system', 'subtype': 'init', 'session_id': 'abc', 'model': real}), flush=True)\n"
                       "print(json.dumps({'type': 'result', 'result': 'done', 'session_id': 'abc'}), flush=True)\n")
        cli.chmod(0o755)
        (self.home / ".claude").mkdir()
        (self.home / ".claude" / ".credentials.json").write_text("{}")
        engine = replace(subs.ENGINES["claude"], binary=str(cli))
        with patch.object(subs, "claude_takes", return_value=False):
            for model in ("fable", "", "claude-opus-5-5"):
                done = subs.run_turn(engine, "hello", self.home, model=model)
                self.assertTrue(done["ok"], done)
        self.assertEqual(subs.claude_models(), {"versions": {"fable": "claude-fable-5-2", "": "claude-sonnet-5-5"},
                                                "seen": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2"]})

    def test_a_pips_run_and_a_chatdgc_reply_say_which_model_they_asked_for(self):
        # Both read the same stream with a state of their own; each names the model it started the CLI with.
        import inspect
        from dgc import pip_brain
        from dgc.chatdgc import subscription_client
        self.assertIn('self.pieces["asked_model"] = self.brain["model"]', inspect.getsource(pip_brain))
        self.assertIn('pieces["asked_model"] = self.selected_model', inspect.getsource(subscription_client))

    def test_a_pip_is_offered_the_same_versions_and_fixed_models(self):
        from dgc import pip_brain
        subs.parse_stream_events("claude", init("claude-opus-5-5"), {"asked_model": "opus"})
        with patch("dgc.pip_brain.available", return_value=""):
            offered = {row["engine"]: row for row in pip_brain.offered()}
        self.assertEqual(offered["claude"]["models"], ["fable", "opus", "sonnet", "haiku"])
        self.assertEqual(offered["claude"]["versions"], {"opus": "claude-opus-5-5"})
        self.assertEqual(offered["claude"]["fixed"], list(subs.CLAUDE_FIXED_MODELS))
        self.assertNotIn("versions", offered["codex"])


if __name__ == "__main__":
    unittest.main()
