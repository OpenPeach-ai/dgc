"""`dgc -p` into a pipe or a file writes the answer and nothing else (reported 2026-10-18).

The run's thinking, tool steps and notices used to be printed to stdout with the answer, so
`answer=$(dgc -p …)` held the model's reasoning too. As `codex exec` does, they go to stderr now, where a
terminal still shows them; a terminal sees the run exactly as before, and --output-format json is unchanged.
"""
from __future__ import annotations

import json
import os
import pty
import select
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from test_monitors import MockModel, isolated_env, sse, sse_call   # HOME is already redirected there

ANSWER = "The answer is forty-two."


def reasoned_then_answered(body):
    """Round 1: reasoning, then a bash call. Round 2 (after the tool result): reasoning, then the answer."""
    after_tool = any(m.get("role") == "tool" for m in body.get("messages") or [])
    if not after_tool:
        return sse({"reasoning_content": "Let me check the folder first."}) + sse_call("bash", {"command": "echo tool-ran"})
    return (sse({"reasoning_content": "The tool said tool-ran, so I can answer."}) + sse({"content": ANSWER})
            + sse({}, "stop") + "data: [DONE]\n\n")


class AnswerOnlyTests(unittest.TestCase):
    def run_dgc(self, model, *extra, terminal=False):
        home = Path(tempfile.mkdtemp(prefix="dgc-answer-only-home-"))
        work = Path(tempfile.mkdtemp(prefix="dgc-answer-only-work-"))
        argv = [sys.executable, "-m", "dgc", "-p", "What is the answer?", "--trust", "--mode", "auto",
                "--base-url", model.url, "--model", "mock-model", *extra]
        if not terminal:
            done = subprocess.run(argv, cwd=work, env=isolated_env(home), stdin=subprocess.DEVNULL,
                                  capture_output=True, text=True, timeout=120)
            return done.returncode, done.stdout, done.stderr
        # A real terminal on stdout (and stderr): what a person at the prompt sees.
        main, sub = pty.openpty()
        proc = subprocess.Popen(argv, cwd=work, env=isolated_env(home), stdin=subprocess.DEVNULL,
                                stdout=sub, stderr=sub, close_fds=True)
        os.close(sub)
        seen, end = b"", time.monotonic() + 120
        while time.monotonic() < end:
            ready, _, _ = select.select([main], [], [], 0.2)
            if ready:
                try:
                    chunk = os.read(main, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                seen += chunk
            elif proc.poll() is not None:
                break
        proc.wait(timeout=30)
        os.close(main)
        return proc.returncode, seen.decode("utf-8", "replace"), ""

    def test_a_pipe_gets_the_answer_and_nothing_else(self):
        with MockModel(reasoned_then_answered) as model:
            code, out, err = self.run_dgc(model)
        self.assertEqual(code, 0, err[-2000:])
        self.assertEqual(out, ANSWER + "\n", f"stdout must be the answer alone; stderr was:\n{err[-1500:]}")
        self.assertIn("Let me check the folder first.", err, "the thinking is still shown, on stderr")
        self.assertIn("bash", err, "and the tool step")
        self.assertIn("tool-ran", err)

    def test_a_terminal_sees_the_run_as_before(self):
        with MockModel(reasoned_then_answered) as model:
            code, seen, _ = self.run_dgc(model, terminal=True)
        self.assertEqual(code, 0, seen[-2000:])
        for part in ("Let me check the folder first.", "bash", ANSWER):
            self.assertIn(part, seen)
        self.assertEqual(seen.count(ANSWER), 1, "the answer once, as it streamed, not again at the end")

    def test_json_mode_is_unchanged(self):
        with MockModel(reasoned_then_answered) as model:
            code, out, err = self.run_dgc(model, "--output-format", "json")
        self.assertEqual(code, 0, err[-2000:])
        events = [json.loads(line) for line in out.splitlines() if line.strip()]
        result = [e for e in events if e.get("type") == "result"]
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["text"], ANSWER)
        self.assertTrue(any(e.get("type") == "tool_call" for e in events), "the events still carry every step")

    def test_output_file_and_stdout_hold_the_same_answer(self):
        target = Path(tempfile.mkdtemp(prefix="dgc-answer-only-out-")) / "answer.txt"
        with MockModel(reasoned_then_answered) as model:
            code, out, err = self.run_dgc(model, "--output", str(target))
        self.assertEqual(code, 0, err[-2000:])
        self.assertEqual(out, target.read_text(encoding="utf-8"))

    def test_a_plan_mode_run_gives_the_plan(self):
        plan = "1. Add the setting\n2. Test both directions"

        def planned(body):
            if not any(m.get("role") == "tool" for m in body.get("messages") or []):
                return sse_call("present_plan", {"plan": plan})
            return sse({"content": "Plan executed."}) + sse({}, "stop") + "data: [DONE]\n\n"
        target = Path(tempfile.mkdtemp(prefix="dgc-answer-only-plan-")) / "plan.md"
        with MockModel(planned) as model:
            home = Path(tempfile.mkdtemp(prefix="dgc-answer-only-home-"))
            work = Path(tempfile.mkdtemp(prefix="dgc-answer-only-work-"))
            done = subprocess.run([sys.executable, "-m", "dgc", "-p", "Plan the settings change", "--trust", "--mode", "plan",
                                   "--base-url", model.url, "--model", "mock-model", "--output", str(target)],
                                  cwd=work, env=isolated_env(home), stdin=subprocess.DEVNULL, capture_output=True,
                                  text=True, timeout=120)
        self.assertEqual(done.returncode, 0, done.stderr[-2000:])
        self.assertEqual(done.stdout, plan + "\n", "the plan it reported, not the sentence it ended on")
        self.assertEqual(target.read_text(encoding="utf-8"), plan + "\n")
        self.assertIn("plan reported, not executed", done.stderr)


if __name__ == "__main__":
    unittest.main()
