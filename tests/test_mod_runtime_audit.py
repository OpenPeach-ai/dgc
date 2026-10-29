"""Actual sandbox boundaries and malformed mod output must fail closed."""
import os
import subprocess
import tempfile
import time
import threading
import signal
import unittest
from pathlib import Path

from dgc.mods.manifest import parse
from dgc.mods.runtime import ModProcess, sandboxed_argv, _interpreter

class ModRuntimeAuditTests(unittest.TestCase):
    def process(self, code, on_request=None):
        folder=tempfile.TemporaryDirectory(prefix='dgc-mod-audit-')
        self.addCleanup(folder.cleanup)
        root=Path(folder.name); (root/'main.py').write_text(code)
        m=parse({'name':'audit','version':'1.0.0','entry':'main.py'},root)
        proc=ModProcess(m,on_request=on_request or (lambda *a:{}),sandboxed=False)
        proc.start(); self.addCleanup(proc.stop)
        return proc

    def test_a_mod_that_never_reads_cannot_block_the_host_write(self):
        proc=self.process('import time\ntime.sleep(30)\n')
        handle=proc._proc
        def send():
            try: proc.request('large',{'text':'x'*300_000},timeout=.3)
            except Exception: pass
        worker=threading.Thread(target=send,daemon=True); worker.start(); worker.join(3)
        finished=not worker.is_alive()
        if not finished:
            handle.kill(); worker.join(3)
        self.assertTrue(finished, 'writing to the mod exceeded its request deadline')

    @unittest.skipUnless(os.name=='posix', 'POSIX process groups')
    def test_stop_ends_children_that_keep_the_pipes_open(self):
        seen=threading.Event(); children=[]
        def record(method,params):
            children.append(params['pid']); seen.set(); return {}
        proc=self.process('import subprocess,json,sys\np=subprocess.Popen([sys.executable,"-c","import time; time.sleep(30)"])\nprint(json.dumps({"jsonrpc":"2.0","method":"child","params":{"pid":p.pid}}),flush=True)\nfor line in sys.stdin:\n if json.loads(line).get("method")=="shutdown": break\n',record)
        self.assertTrue(seen.wait(3)); handle=proc._proc
        worker=threading.Thread(target=lambda:proc.stop(timeout=.3),daemon=True); worker.start(); worker.join(3)
        finished=not worker.is_alive()
        if not finished:
            try: os.killpg(handle.pid,signal.SIGKILL)
            except ProcessLookupError: pass
            worker.join(3)
        self.assertTrue(finished, 'a child kept the stopped mod pipes open')
        if Path('/proc').is_dir():
            path=Path(f'/proc/{children[0]}/stat')
            self.assertTrue(not path.exists() or path.read_text().rsplit(')',1)[1].split()[0]=='Z')

    def test_a_request_flood_is_bounded_and_stops_the_mod(self):
        release=threading.Event(); self.addCleanup(release.set)
        def blocked(*args): release.wait(5); return {}
        proc=self.process('import json,time\nfor i in range(100): print(json.dumps({"jsonrpc":"2.0","id":i,"method":"wait"}),flush=True)\ntime.sleep(30)\n',blocked)
        deadline=time.monotonic()+3
        while proc.state in ('starting','running') and time.monotonic()<deadline: time.sleep(.02)
        release.set()
        self.assertEqual(proc.state,'crashed')
        self.assertIn('too many',proc.error.lower())

    def test_sandbox_cannot_read_a_file_outside_home_and_tmp(self):
        parent = '/var/tmp' if Path('/var/tmp').is_dir() else tempfile.gettempdir()
        with tempfile.TemporaryDirectory(prefix='dgc-mod-audit-') as folder, tempfile.TemporaryDirectory() as scratch, tempfile.TemporaryDirectory(dir=parent) as elsewhere:
            root=Path(folder); marker=Path(elsewhere)/'marker'; marker.write_text('synthetic audit marker')
            (root/'main.py').write_text('from pathlib import Path\ntry:\n print(Path('+repr(str(marker))+').read_text())\nexcept OSError:\n print("blocked")\n')
            m=parse({'name':'audit','version':'1.0.0','entry':'main.py'}, root)
            argv=sandboxed_argv(m,_interpreter(m),Path(scratch))
            if argv is None:
                self.skipTest('No OS sandbox available')
            result=subprocess.run(argv,capture_output=True,text=True,timeout=15)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout.strip(),'blocked')

    def test_invalid_response_id_stops_the_mod_without_stranding_its_reader(self):
        with tempfile.TemporaryDirectory(prefix='dgc-mod-audit-') as folder:
            root=Path(folder)
            (root/'main.py').write_text('import json,time\nprint(json.dumps({"jsonrpc":"2.0","id":[],"result":{}}),flush=True)\ntime.sleep(30)\n')
            m=parse({'name':'audit','version':'1.0.0','entry':'main.py'},root)
            proc=ModProcess(m,on_request=lambda *a:{},sandboxed=False)
            self.addCleanup(proc.stop)
            proc.start()
            deadline=time.monotonic()+3
            while proc.state in ('starting','running') and time.monotonic()<deadline:
                time.sleep(.02)
            self.assertEqual(proc.state,'crashed')
            self.assertIn('id',proc.error.lower())

if __name__=='__main__':
    unittest.main()
