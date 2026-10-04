"""Redirected state must not silently make the account home a project root."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from dgc import config
from tests.test_pip_cli import CLI_BOOTSTRAP


class ProjectRootIsolationTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory(prefix='dgc-root-isolation-')
        self.addCleanup(temporary.cleanup)
        self.base=Path(temporary.name)
        self.home=self.base/'account';self.home.mkdir()
        self.state=self.home/'lab'/'state'/'isolated-home';self.state.mkdir(parents=True)
        self.root=self.home/'lab'/'non-git';self.root.mkdir()
        (self.home/'.dgc').mkdir(mode=0o700)
        (self.state/'.dgc').mkdir(mode=0o700)
        env=patch.dict(os.environ,{'HOME':str(self.home),'DGC_HOME':str(self.state),'DGC_PROJECT_ROOT':'','DGC_SDK_ISOLATED':''})
        env.start();self.addCleanup(env.stop)
        constants=patch.object(config,'USER_HOME',self.state/'.dgc')
        constants.start();self.addCleanup(constants.stop)

    def test_unmarked_directory_does_not_inherit_original_or_redirected_home(self):
        self.assertEqual(config.find_project_root(self.root),self.root)
        inside=self.state/'work';inside.mkdir()
        self.assertEqual(config.find_project_root(inside),inside)

    def test_genuine_project_markers_and_explicit_pins_keep_their_precedence(self):
        project=self.root/'project';project.mkdir()
        child=project/'child';child.mkdir()
        for marker in ('.git','DGC.md','.dgc'):
            path=project/marker
            if marker=='DGC.md':path.write_text('Project instructions')
            else:path.mkdir()
            with self.subTest(marker=marker):self.assertEqual(config.find_project_root(child),project)
            if path.is_dir():path.rmdir()
            else:path.unlink()
        with patch.dict(os.environ,{'DGC_PROJECT_ROOT':str(project)}):
            self.assertEqual(config.find_project_root(child),project)
        (project/'.git').mkdir()
        with patch.dict(os.environ,{'DGC_SDK_ISOLATED':'1'}):
            self.assertEqual(config.find_project_root(child),child)

    def test_home_can_still_be_an_explicit_git_project(self):
        (self.home/'.git').mkdir()
        self.assertEqual(config.find_project_root(self.root),self.home)

    def test_alias_of_global_state_does_not_become_project_marker(self):
        project=self.root/'project';project.mkdir()
        (project/'.dgc').symlink_to(self.home/'.dgc',target_is_directory=True)
        child=project/'child';child.mkdir()
        self.assertEqual(config.find_project_root(child),child)

    def test_real_cli_under_account_home_registers_only_actual_non_git_directory(self):
        sentinel=self.home/'.dgc'/'config.json';sentinel.write_text('{"local_fixture":"untouched"}')
        before=sentinel.read_bytes()
        env={**os.environ,'PYTHONPATH':str(Path(__file__).resolve().parents[1]),'PYTHONDONTWRITEBYTECODE':'1','DGC_SKIP_EXTENSION':'1'}
        def invoke(*args):
            result=subprocess.run([sys.executable,'-c',CLI_BOOTSTRAP,'pips',*args,'--json'],
                cwd=self.root,env=env,stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=15)
            self.assertEqual(result.returncode,0,result.stderr)
            return json.loads(result.stdout)
        invoke('enable')
        job=invoke('create','Folder reviewer','--goal','Inspect this folder')['pip']
        shown=invoke('workspace','show')
        self.assertEqual(shown['binding']['canonical_root'],str(self.root))
        self.assertEqual(shown['workspace']['id'],job['workspace_id'])
        self.assertNotEqual(shown['binding']['canonical_root'],str(self.home))
        self.assertEqual(sentinel.read_bytes(),before)
        self.assertFalse((self.root/'.dgc').exists())


if __name__=='__main__':unittest.main()
