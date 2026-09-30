"""The seam where a cut-off reply meets its continuation.

Reported from a real session, three times, always the last two words before the seam:

    "... install it in the backendimage."      <- "backend image"
    "... before touchingthem."                 <- "touching them"
    "... here on the ERPbox."                  <- "ERP box"

and in the same message "backend image/requirements" kept its space, because there was no seam
there. A response cut off at the length limit is continued by a FRESH generation, and a fresh
generation does not begin with a leading space; `_stitch_continuation` appends it literally, so a
cut that fell between two words lost the space between them.

Fixed in the continuation PROMPT, not in the join: the join cannot tell a cut between words from a
cut inside one, and a heuristic that repairs "backendimage" would turn a cut inside "backend" into
"back end" -- DGC inventing text the model never wrote.
"""
from __future__ import annotations

import inspect
import re
import sys
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import agent as agent_mod                                     # noqa: E402


def _continuation_prompt() -> str:
    """The literal DGC sends when a reply is cut off at the length limit."""
    src = inspect.getsource(agent_mod)
    match = re.search(r'"Your previous response was cut off at the length limit\.(?:[^"]*"\s*"?)*',
                      src)
    assert match, "the continuation prompt moved"
    return "".join(re.findall(r'"([^"]*)"', match.group(0)))


class TheContinuationPromptClosesTheSeamTest(unittest.TestCase):
    def test_it_says_the_reply_is_appended_with_nothing_between(self) -> None:
        """Without this the model has no way to know a space is its responsibility."""
        prompt = _continuation_prompt()
        self.assertIn("appended directly", prompt)
        self.assertIn("nothing inserted between", prompt)

    def test_it_asks_for_the_space_when_the_cut_fell_between_words(self) -> None:
        prompt = _continuation_prompt()
        self.assertIn("begin with a space", prompt)
        self.assertIn("between two words", prompt)

    def test_it_still_says_not_to_repeat(self) -> None:
        """The original instruction has to survive the fix: a continuation that repeats the tail
        duplicates text, which is worse than a missing space."""
        prompt = _continuation_prompt()
        self.assertIn("do not repeat what you already wrote", prompt)


class TheJoinStaysLiteralTest(unittest.TestCase):
    """If someone later 'fixes' this by inserting a space at the join, these fail and say why."""

    def test_the_two_halves_are_concatenated_with_nothing_between(self) -> None:
        source = inspect.getsource(agent_mod.Agent._stitch_continuation)
        self.assertIn('merged["content"] = partial["content"] + assistant["content"]', source,
                      "the join must stay literal; the space is the prompt's job")

    def test_the_reason_is_recorded_where_the_join_is(self) -> None:
        """A bare `+` with no explanation invites exactly the heuristic that breaks mid-word cuts."""
        doc = agent_mod.Agent._stitch_continuation.__doc__ or ""
        self.assertIn("fresh generation", doc)
        self.assertIn("back end", doc, "the rejected alternative and its failure are named")


if __name__ == "__main__":
    unittest.main()
