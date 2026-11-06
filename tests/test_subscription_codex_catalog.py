"""Codex subscription model selection reflects the logged-in CLI, not a DGC guess."""

import json
import os
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from dgc import subscriptions as subs


class CodexCatalogueTests(unittest.TestCase):
    def test_codex_default_and_account_models_are_separate(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            (home / ".codex").mkdir()
            (home / ".codex" / "auth.json").write_text("{}")
            (home / ".codex" / "config.toml").write_text(
                'model = "gpt-5.6-sol"\n[profiles.other]\nmodel = "ignored"\n')
            binary = home / "codex"
            binary.write_text(
                "#!/usr/bin/env python3\n"
                "import json, sys, time\n"
                "for _ in range(3): sys.stdin.readline()\n"
                "print(json.dumps({'id':2,'result':{'data':[{'id':'gpt-5.6-terra'},"
                "{'id':'gpt-5.6-luna'}]}}), flush=True)\n"
                "time.sleep(2)\n")
            binary.chmod(0o755)
            engine = replace(subs.ENGINES["codex"], binary=str(binary))
            with patch.dict(os.environ, {"HOME": str(home)}), \
                 patch.object(subs, "ENGINES", {"codex": engine}):
                subs._codex_catalog_cache = None
                row = subs.status()[0]
            self.assertEqual(row["cli_default_model"], "gpt-5.6-sol")
            self.assertEqual(row["model_hints"], ["gpt-5.6-terra", "gpt-5.6-luna"])
            self.assertFalse(row["cli_default_listed"])

    def test_a_service_tier_the_account_refuses_points_at_the_setting(self):
        event = {"type": "turn.failed", "error": {"message": "400 Unsupported service_tier: flex"}}
        parsed = subs.parse_stream_events("codex", json.dumps(event))
        self.assertIn("service_tier in your Codex config.toml", parsed[0]["text"])

    def test_nested_codex_http_error_is_actionable_plain_text(self):
        detail = "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."
        event = {"type": "turn.failed", "error": {"message": json.dumps({
            "type": "error", "error": {"code": "model_not_found", "message": detail}})}}
        parsed = subs.parse_stream_events("codex", json.dumps(event))
        self.assertEqual(len(parsed), 1)
        self.assertIn(detail, parsed[0]["text"])
        self.assertIn("DGC's model menu", parsed[0]["text"])
        self.assertNotIn('"type": "error"', parsed[0]["text"])


if __name__ == "__main__":
    unittest.main()
