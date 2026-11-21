"""A message sent mid-turn is replayed as the person's own words whatever version of DGC's wrapper it was saved with
(his 21 Nov session: the wrapper gained a sentence on 20 Nov, and every message saved before showed as
"<user-interjection> The user sent this WHILE you were working…" in its bubble)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc.headless import _history_steering_texts  # noqa: E402
from dgc.workflows import STEERING_PREFIX, STEERING_SUFFIX, display_prompt, steering_body  # noqa: E402

OLD = ("<user-interjection>\nThe user sent this WHILE you were working. Before your next tool call, say in one short "
       "sentence how you are handling it -- changing course now, doing it after the current step, or why it does not "
       "apply -- then carry on:\n")


class EveryVersion(unittest.TestCase):
    def test_the_older_wrapper_is_read_as_the_persons_words(self):
        saved = OLD + "give me the codex build checklist as an artifact on web browser" + STEERING_SUFFIX
        self.assertEqual(_history_steering_texts({"role": "user", "content": saved}),
                         ["give me the codex build checklist as an artifact on web browser"])
        self.assertEqual(display_prompt(saved), "give me the codex build checklist as an artifact on web browser")
        recorded = {"role": "user", "content": saved, "_dgc_steering": ["first ask", "second ask"]}
        self.assertEqual(_history_steering_texts(recorded), ["first ask", "second ask"])

    def test_todays_wrapper_still_reads_and_a_plain_message_is_not_one(self):
        self.assertEqual(steering_body(STEERING_PREFIX + "do it" + STEERING_SUFFIX), "do it")
        self.assertIsNone(steering_body("<user-interjection> I typed this myself"))
        self.assertIsNone(_history_steering_texts({"role": "user", "content": "just a prompt"}))


if __name__ == "__main__":
    unittest.main()
