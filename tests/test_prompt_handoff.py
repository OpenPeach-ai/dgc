"""`dgc -p "<prompt>"` keeps its prompt off its own command line (dgc/launch.py).

Found running DGC on Terminal-Bench (2026-10): the task's words were on DGC's command line, the model ran
`pkill -f <one of them>`, and DGC stopped itself mid-task. Here a real `python -m dgc -p` meets a model that does
exactly that, and must finish; its process table entry must not hold the prompt; and the command it runs must not
inherit the prompt's handover (neither the variable nor the descriptor).
"""
from __future__ import annotations

import os
import secrets
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from dgc import launch
from test_monitors import MockModel, isolated_env, sse_call, sse_text


class WhereThePromptIsTests(unittest.TestCase):
    def test_every_way_argparse_takes_a_prompt(self):
        self.assertEqual(launch._prompt_at(["-p", "fix it"]), (1, ""))
        self.assertEqual(launch._prompt_at(["--mode", "auto", "--prompt", "fix it"]), (3, ""))
        self.assertEqual(launch._prompt_at(["-pfix it"]), (0, "-p"))
        self.assertEqual(launch._prompt_at(["--trust", "--prompt=fix it"]), (1, "--prompt="))

    def test_none_where_there_is_no_prompt_to_hide(self):
        for args in ([], ["serve"], ["pips", "-p", "x"], ["--help"], ["-p"], ["--", "-p", "x"]):
            self.assertIsNone(launch._prompt_at(args), args)

    def test_a_stray_variable_changes_nothing(self):
        argv = ["dgc", "-p", "fix it"]
        with mock.patch.object(sys, "argv", list(argv)), mock.patch.dict(os.environ, {launch.HANDOFF: "7:abc"}):
            self.assertFalse(launch._take_back())
            self.assertEqual(sys.argv, argv)
            self.assertNotIn(launch.HANDOFF, os.environ)

    def test_a_placeholder_that_cannot_be_filled_stops_dgc_instead_of_becoming_the_task(self):
        with mock.patch.object(sys, "argv", ["dgc", "-p", "<dgc-prompt:abc>"]), \
                mock.patch.dict(os.environ, {launch.HANDOFF: "999:abc"}):
            with self.assertRaises(SystemExit) as stopped:
                launch._take_back()
        self.assertIn("couldn't read the prompt back", str(stopped.exception))


@unittest.skipUnless(sys.platform.startswith("linux"), "reads /proc")
class OneShotRunTests(unittest.TestCase):
    def test_pkill_on_a_word_of_the_prompt_leaves_dgc_running(self):
        word = "zq" + secrets.token_hex(6)                   # in nothing else on this machine
        prompt = f"Stop the {word} server, then say done."
        seen: dict = {}

        def script(body):
            if not any(m.get("role") == "tool" for m in body.get("messages") or []):
                pid = seen["pid"]
                for name in ("cmdline", "environ", "comm"):
                    seen[name] = Path(f"/proc/{pid}/{name}").read_bytes()
                seen["asked"] = str(body["messages"][-1].get("content"))
                # [z]q… matches DGC's command line if the word is on it, but not this shell's own.
                return sse_call("bash", {"command": f"env | grep -c {launch.HANDOFF}; "
                                                    "ls -l /proc/self/fd | grep -c deleted; "
                                                    f"pkill -f '[{word[0]}]{word[1:]}'; echo pkill=$?"})
            seen["result"] = next(str(m.get("content")) for m in body["messages"] if m.get("role") == "tool")
            return sse_text("done")

        with MockModel(script) as model:
            home = Path(tempfile.mkdtemp(prefix="dgc-handoff-home-"))
            work = Path(tempfile.mkdtemp(prefix="dgc-handoff-work-"))
            proc = subprocess.Popen([sys.executable, "-m", "dgc", "-p", prompt, "--trust", "--mode", "auto",
                                     "--base-url", model.url, "--model", "mock-model"],
                                    cwd=str(work), env=isolated_env(home), stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            seen["pid"] = proc.pid
            try:
                out, err = proc.communicate(timeout=120)
            finally:
                if proc.poll() is None:
                    proc.kill()
        self.assertEqual(proc.returncode, 0, f"dgc stopped ({proc.returncode}): {err[-1500:]}")
        self.assertIn("done", out)
        self.assertIn(prompt, seen["asked"], "the model got the prompt itself, not its placeholder")
        self.assertNotIn(word.encode(), seen["cmdline"], "the prompt is off the command line")
        self.assertIn(b"<dgc-prompt:", seen["cmdline"])
        self.assertNotIn(word.encode(), seen["environ"], "and not in the environment either")
        self.assertEqual(seen["comm"].strip(), b"dgc")
        counts = [line.strip() for line in seen["result"].splitlines()
                  if line.strip() and not line.startswith("exit code:")]   # the bash tool's own first line
        self.assertEqual(counts[:2], ["0", "0"], f"a command inherits neither the variable nor the file: {seen['result']}")
        self.assertIn("pkill=1", seen["result"], "nothing matched: DGC wasn't on the command line by that word")


if __name__ == "__main__":
    unittest.main()
