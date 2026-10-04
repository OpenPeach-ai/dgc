"""A Personal task sees its own previous result, so it says what changed instead of repeating itself."""
import json
import subprocess
import sys
import unittest
from unittest.mock import patch

from dgc import pips
from tests import test_pips_local as fixtures

WORKER = r'''
import json
from unittest.mock import patch
from dgc.llm import LLMClient, ChatResult
from dgc.pips import _worker_main
EXPECT = %r
def chat(self, messages, tools=None, **kwargs):
    seen = json.dumps(messages)
    if EXPECT:
        assert "Your previous result for this same job" in seen, "no previous result in the prompt"
        assert EXPECT in seen, "the previous text is missing"
        assert "for comparison only" in seen
    else:
        assert "Your previous result for this same job" not in seen, "a first run has nothing to compare"
    return ChatResult(content=%r)
with patch.object(LLMClient, "chat", chat):
    raise SystemExit(_worker_main())
'''


class PreviousResultTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def run_worker(self, pip_id, key, expect, reply):
        queued = self.store.enqueue(pip_id, key, "local-console", self.cfg)
        row = self.store.claim_next()
        popen = subprocess.Popen

        def process(argv, *a, **kw):
            if argv[1:] == ["-m", "dgc.pips", "--worker"]:
                argv = [sys.executable, "-c", WORKER % (expect, reply)]
            return popen(argv, *a, **kw)
        with patch.object(pips.subprocess, "Popen", side_effect=process):
            result = pips._execute_run(self.registry, row, self.cfg)
        return queued, self.store.finish(queued["id"], result=result)

    def test_the_second_run_compares_with_the_first(self):
        pip = self.store.create(self.registry.personal()["id"], "Page watch", "Tell me what changed", "local-console")
        first, done = self.run_worker(pip["id"], "one", "", "Prices: PRO plan 20 dollars. FIRST_RESULT_SENTINEL")
        self.assertEqual(done["status"], "succeeded", done.get("error"))
        self.assertNotIn("previous_result", first["manifest"])
        second, done = self.run_worker(pip["id"], "two", "FIRST_RESULT_SENTINEL", "Nothing changed since yesterday.")
        self.assertEqual(done["status"], "succeeded", done.get("error"))
        self.assertEqual(second["manifest"]["previous_result"]["run_id"], first["id"])
        third, _ = self.run_worker(pip["id"], "three", "Nothing changed since yesterday.", "Still nothing.")
        self.assertEqual(third["manifest"]["previous_result"]["run_id"], second["id"], "always the latest")

    def test_the_previous_text_is_redacted_and_bounded(self):
        # A secret configured after the result was saved is still kept out of the next prompt.
        pip = self.store.create(self.registry.personal()["id"], "Watch", "Watch", "local-console")
        self.run_worker(pip["id"], "one", "", "token later-secret-123 " + "x" * 9000)
        with patch("dgc.redaction.secret_values", return_value=["later-secret-123"]):
            queued = self.store.enqueue(pip["id"], "two", "local-console", self.cfg)
        text = queued["manifest"]["previous_result"]["text"]
        self.assertNotIn("later-secret-123", text)
        self.assertLessEqual(len(text), pips.PREVIOUS_RESULT_CHARS)


if __name__ == "__main__":
    unittest.main()
