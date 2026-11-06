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
from dgc.mods.runtime import ModProcess, sandboxed_argv, _interpreter, _hidden_siblings

class ModRuntimeAuditTests(unittest.TestCase):
    def test_hidden_siblings_never_hide_an_allowed_ancestor(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            allowed = root / 'project' / 'venv'
            allowed.mkdir(parents=True)
            (root / 'project' / 'secret').mkdir()
            (root / 'other').mkdir()
            hidden = _hidden_siblings([allowed], root)
            self.assertIn(root / 'project' / 'secret', hidden)
            self.assertIn(root / 'other', hidden)
            self.assertTrue(all(not (path == allowed or path in allowed.parents) for path in hidden))

    def test_macos_profile_lets_the_sandbox_follow_every_link_to_the_interpreter(self):
        # A Python DGC's installer set up on a Mac: venv/bin/python -> python3.13 -> ~/.local/bin/python3.13 (uv's link)
        # -> uv's version alias folder -> the real interpreter. macOS refused to exec it ("Operation not permitted")
        # because ~/.local/bin was hidden, so no mod could start on such a Mac. Simulated here: the profile must let
        # each link be read, and keep the folder's other files hidden.
        from unittest import mock
        from dgc import sandbox
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as scratch:
            home = Path(tmp).resolve() / 'Users' / 'me'
            real = home / '.local' / 'share' / 'uv' / 'python' / 'cpython-3.13.14' / 'bin'
            real.mkdir(parents=True)
            (real / 'python3.13').write_text('')
            alias = home / '.local' / 'share' / 'uv' / 'python' / 'cpython-3.13'
            alias.symlink_to(real.parent)
            local_bin = home / '.local' / 'bin'
            local_bin.mkdir(parents=True)
            (local_bin / 'python3.13').symlink_to(alias / 'bin' / 'python3.13')
            (local_bin / 'private-tool').write_text('not for mods')
            venv_bin = home / '.local' / 'share' / 'dgc' / 'versions' / '9.9.9' / '.venv' / 'bin'
            venv_bin.mkdir(parents=True)
            (venv_bin / 'python3.13').symlink_to(local_bin / 'python3.13')
            (venv_bin / 'python').symlink_to('python3.13')
            folder = home / 'mod'
            folder.mkdir()
            (folder / 'main.py').write_text('')
            m = parse({'name': 'audit', 'version': '1.0.0', 'entry': 'main.py'}, folder)
            from dgc.mods import runtime
            real_hidden = runtime._hidden_siblings
            # The fake account lives under /tmp: list hidden siblings within it only, not all of /tmp.
            only_home = lambda readable, root: real_hidden([p for p in readable if p == home or home in p.parents], home)
            with mock.patch.object(sandbox, '_backend', return_value=('sandbox-exec', '/usr/bin/sandbox-exec')), \
                 mock.patch.object(sandbox, '_account_home', return_value=home), \
                 mock.patch.object(runtime, '_hidden_siblings', side_effect=only_home):
                argv = sandboxed_argv(m, [str(venv_bin / 'python'), '-c', 'pass'], Path(scratch))
            allowed = {line for line in argv[2].replace(')(', ')\n(').splitlines() if line.startswith('(allow file-read*')}
            for link in (venv_bin / 'python', venv_bin / 'python3.13', local_bin / 'python3.13', alias):
                self.assertIn(f'(allow file-read* (subpath "{link}"))', allowed, link)
            self.assertNotIn(f'(allow file-read* (subpath "{local_bin}"))', allowed, 'only the link, not the folder')
            self.assertIn(f'(deny file-read* (subpath "{local_bin / "private-tool"}"))', argv[2])

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
            # The child may exit between the check and the read: gone counts as ended, like a zombie does.
            try: state=path.read_text().rsplit(')',1)[1].split()[0]
            except (FileNotFoundError, ProcessLookupError): state='gone'
            self.assertIn(state, ('Z', 'gone'), 'the stopped mod left a child running')

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

    def test_sandbox_cannot_read_an_unrelated_home_file(self):
        with tempfile.TemporaryDirectory(prefix='dgc-mod-private-', dir=Path.home()) as private, \
             tempfile.TemporaryDirectory(prefix='dgc-mod-audit-') as folder, \
             tempfile.TemporaryDirectory() as scratch:
            marker = Path(private) / 'marker'
            marker.write_text('synthetic private marker')
            root = Path(folder)
            (root / 'main.py').write_text('from pathlib import Path\ntry:\n print(Path('+repr(str(marker))+').read_text())\nexcept OSError:\n print("blocked")\n')
            m = parse({'name':'audit','version':'1.0.0','entry':'main.py'}, root)
            argv = sandboxed_argv(m, _interpreter(m), Path(scratch))
            if argv is None:
                self.skipTest('No OS sandbox available')
            result = subprocess.run(argv, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'blocked')

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
