"""The line the chat shows when DGC skips a step the model repeated with the same inputs is in plain words: it named
the guard and the tool ("↻ loop guard: blocked a repeated edit_artifact call", seen in the 24 Nov RC check, outside the
turn's fold, over the answer). What the MODEL is told (LOOP_GUARD_PREFIX) is unchanged."""
import ast
import unittest
from pathlib import Path

AGENT = Path(__file__).resolve().parents[1] / "dgc" / "agent.py"


class PlainLoopNoticeTests(unittest.TestCase):
    def test_the_notice_names_neither_the_guard_nor_the_tool(self):
        tree = ast.parse(AGENT.read_text(encoding="utf-8"))
        said = []
        for node in ast.walk(tree):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "info"
                    and "repeated" in ast.unparse(node)):
                said.append(ast.unparse(node))
        self.assertTrue(said, "the notice is still there")
        for line in said:
            self.assertNotIn("loop guard", line)
            self.assertNotIn("call.name", line, "no tool's internal name in the chat")
            self.assertIn("Skipped a step repeated with the same inputs", line)


if __name__ == "__main__":
    unittest.main()
