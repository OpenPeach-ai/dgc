"""Vendor CLIs must neither wait on nor consume the frontend's still-open control pipe."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class SubscriptionInputTests(unittest.TestCase):
    def test_vendor_gets_eof_while_parent_control_pipe_stays_open_and_unconsumed(self):
        root = Path(__file__).resolve().parents[1]
        vendor = '''import json,sys
content=sys.stdin.read()
print(json.dumps({"type":"item.completed","item":{"id":"answer","type":"agent_message","text":"EOF" if not content else "WRONG INPUT"}}),flush=True)
'''
        parent = '''import json,sys,types
from pathlib import Path
from unittest.mock import patch
from dgc import subscriptions
vendor=sys.argv[1]
engine=types.SimpleNamespace(stream="codex",short_label="fixture",build_argv=lambda *a,**k:[sys.executable,"-c",vendor])
with patch.object(subscriptions,"preflight",return_value=sys.executable):
 result=subscriptions.run_turn(engine,"Supplied prompt",Path.cwd(),timeout=2)
control=sys.stdin.readline()
print(json.dumps({"ok":result["ok"],"text":result["text"],"timeout":result["timeout"],"control":control}),flush=True)
'''
        with tempfile.TemporaryDirectory(prefix="dgc-sub-input-") as directory:
            proc = subprocess.Popen([sys.executable, "-c", parent, vendor], cwd=directory,
                                    env={**os.environ, "PYTHONPATH": str(root)},
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True)
            try:
                proc.stdin.write('{"type":"cancel","id":"private-control"}\n')
                proc.stdin.flush()
                # Keep stdin open. communicate() would close it and mask the production defect.
                proc.wait(timeout=8)
                self.assertEqual(proc.returncode, 0, proc.stderr.read())
                result = json.loads(proc.stdout.read())
                self.assertEqual(result, {"ok": True, "text": "EOF", "timeout": False,
                    "control": '{"type":"cancel","id":"private-control"}\n'})
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=5)
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    stream.close()


if __name__ == "__main__":
    unittest.main()
