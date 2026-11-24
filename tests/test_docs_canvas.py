""""Show me here in the Canvas" (24 Nov, the owner, in a project): the model asked DGC's docs about the Canvas, got the
Configuration page (the docs never called a design's page the canvas, and every word counted alike), and built files and
a dev server instead of a design. The docs now say what the canvas is, the search weighs a rare word over a common one,
and make_artifact says the Canvas is a design's page."""
import unittest

from dgc.artifact_tools import MAKE_ARTIFACT
from dgc.settings_tool import docs


def first_section(answer: str) -> str:
    return next((line for line in answer.splitlines() if line.startswith("## ")), "")


class DocsCanvasTests(unittest.TestCase):
    def test_the_canvas_is_found(self):
        for question in ("Canvas", "How do I show a local HTML or React web page in the Canvas preview for the user?",
                         "design a landing page, desktop and phone"):
            self.assertEqual(first_section(docs(question)), "## Designs: the canvas", question)

    def test_other_questions_still_find_theirs(self):
        self.assertIn("Dev Mode", first_section(docs("how do I turn on dev mode")))
        self.assertTrue(docs("slash commands list").startswith("# Slash commands"))

    def test_make_artifact_says_the_canvas_is_a_design(self):
        words = MAKE_ARTIFACT["function"]["description"]
        self.assertIn("what the user calls the Canvas", words)
        self.assertIn('"show it in the Canvas"', words)


if __name__ == "__main__":
    unittest.main()
