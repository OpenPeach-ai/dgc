"""Mods preserve explicit grants across installs, reloads, and concurrent windows."""
import json
import multiprocessing
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from dgc.mods import catalog, consent, manifest
from dgc.mods.host import ModHost
from dgc.mods.runtime import ModError


def grant_worker(root, name, start):
    os.environ['DGC_HOME'] = root
    original = consent._read
    def slowed():
        value = original()
        time.sleep(.1)
        return value
    consent._read = slowed
    start.wait(10)
    m = manifest.Manifest(name, '1.0.0', 'main.py', 'python', name, '', Path(root))
    consent.allow(m)


class ModSecurityAuditTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='dgc-mod-security-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        env = patch.dict(os.environ, {'DGC_HOME': str(self.root/'home')})
        env.start(); self.addCleanup(env.stop)
        self.folder = self.root/'mod'; self.folder.mkdir()
        (self.folder/'main.py').write_text('pass\n')
        (self.folder/'dgc-mod.json').write_text(json.dumps({'name':'audit','version':'1.0.0','entry':'main.py'}))

    def test_git_subdirectory_cannot_select_a_local_absolute_folder(self):
        with patch.object(catalog.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as clone:
            with self.assertRaises(manifest.ManifestError):
                catalog.install_git('https://example.invalid/mod.git', str(self.folder))
            clone.assert_not_called()

    def test_failed_git_clone_does_not_repeat_credentials_from_stderr(self):
        secret = 'synthetic-secret-token'
        with patch.object(catalog.subprocess, 'run',
                          return_value=SimpleNamespace(returncode=128, stderr=f'failed https://user:{secret}@host')):
            with self.assertRaises(manifest.ManifestError) as failure:
                catalog.install_git('https://example.invalid/mod.git')
        self.assertNotIn(secret, str(failure.exception))

    def test_install_never_copies_a_symlinked_directory(self):
        outside=self.root/'outside'; outside.mkdir(); (outside/'private.txt').write_text('synthetic marker')
        (self.folder/'linked').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(manifest.ManifestError):
            catalog.install_folder(self.folder)
        self.assertEqual(catalog.installed(), [])

    def test_manifest_entry_cannot_follow_a_link_outside_the_mod(self):
        outside=self.root/'outside.py'; outside.write_text('pass')
        (self.folder/'main.py').unlink(); (self.folder/'main.py').symlink_to(outside)
        with self.assertRaises(manifest.ManifestError):
            manifest.load(self.folder)

    def test_remove_refuses_a_path_instead_of_an_installed_name(self):
        with self.assertRaises(manifest.ManifestError):
            catalog.remove(str(self.folder))
        self.assertTrue((self.folder/'main.py').exists())

    def test_failed_update_keeps_the_previously_installed_mod(self):
        installed = catalog.install_folder(self.folder)
        (self.folder/'main.py').write_text('print("new version")\n')
        rename = Path.rename

        def fail_new_copy(path, target):
            if path.name == 'mod' and path.parent.name.startswith('.audit-'):
                raise OSError('simulated failed promotion')
            return rename(path, target)

        with patch.object(Path, 'rename', fail_new_copy), self.assertRaises(OSError):
            catalog.install_folder(self.folder)
        self.assertEqual((installed.folder/'main.py').read_text(), 'pass\n')
        self.assertEqual([m.name for m in catalog.installed()], ['audit'])

    @unittest.skipUnless(hasattr(os,'fork'), 'requires multiprocessing fork')
    def test_concurrent_windows_keep_all_consent_updates(self):
        context=multiprocessing.get_context('fork'); start=context.Event()
        jobs=[context.Process(target=grant_worker,args=(str(self.root/'home'), f'mod-{i}',start)) for i in range(8)]
        for job in jobs: job.start()
        start.set()
        for job in jobs:
            job.join(15)
            if job.is_alive(): job.terminate(); job.join()
            self.assertEqual(job.exitcode,0)
        self.assertEqual(set(consent._read()), {f'mod-{i}' for i in range(8)})

    def test_old_process_cannot_borrow_a_replacement_mods_grants(self):
        m=manifest.load(self.folder)
        class Process:
            def __init__(self,m,*,on_request,**kw): self.state='running'; self.on_request=on_request
            def start(self): pass
            def request(self,*a,**kw): return {'hooks':[]}
        host=ModHost(project_root=self.root)
        with patch('dgc.mods.host.ModProcess',Process):
            old=host._start(m)
            host._start(m)
        with self.assertRaises(ModError):
            old.proc.on_request('store.set',{'key':'stale','value':True})

    def test_session_consent_cannot_expand_or_move_to_a_different_folder(self):
        host = ModHost(project_root=self.root, extra=(str(self.folder),))
        with patch.object(host, '_start'), patch.object(host, 'stop'):
            host.allow('audit', session_only=True)
        original = manifest.load(self.folder)
        self.assertTrue(host._may_run(original))
        expanded = manifest.parse({'name':'audit', 'version':'1.1.0', 'entry':'main.py',
                                   'capabilities':{'reads':['project']}}, self.folder)
        self.assertFalse(host._may_run(expanded))
        elsewhere = self.root/'elsewhere'; elsewhere.mkdir(); (elsewhere/'main.py').write_text('pass')
        moved = manifest.parse({'name':'audit', 'version':'1.0.0', 'entry':'main.py'}, elsewhere)
        self.assertFalse(host._may_run(moved))

    def test_an_old_permission_card_cannot_allow_a_changed_manifest(self):
        host = ModHost(project_root=self.root, extra=(str(self.folder),))
        reviewed = next(m for m in host.mods() if m['name'] == 'audit')['review']
        (self.folder/'dgc-mod.json').write_text(json.dumps({'name':'audit', 'version':'1.1.0',
            'entry':'main.py', 'capabilities':{'reads':['project']}}))
        with patch.object(host, '_start') as start, patch.object(host, 'stop'):
            for stale in (reviewed, ''):
                with self.subTest(review=stale), self.assertRaises(ModError):
                    host.allow('audit', review=stale)
            start.assert_not_called()
            self.assertIsNone(consent.record('audit'))
            current = next(m for m in host.mods() if m['name'] == 'audit')['review']
            host.allow('audit', review=current)
            self.assertTrue(consent.allowed(manifest.load(self.folder)))

    def test_ending_a_session_releases_its_mod_executor_threads(self):
        host = ModHost(project_root=self.root)
        host._pool.submit(lambda: None).result(timeout=2)
        threads = list(host._pool._threads)
        self.addCleanup(lambda: host._pool.shutdown(wait=False, cancel_futures=True))
        old_pool = host._pool
        self.addCleanup(lambda: old_pool.shutdown(wait=False, cancel_futures=True))
        host.stop()
        for thread in threads:
            thread.join(timeout=2)
        self.assertFalse(any(thread.is_alive() for thread in threads))

    def test_project_file_swapped_after_validation_is_not_read(self):
        from dgc import artifacts
        m=manifest.parse({'name':'audit','version':'1.0.0','entry':'main.py','capabilities':{'reads':['project']}},self.folder)
        project=self.root/'project'; project.mkdir()
        target=project/'notes.txt'; target.write_text('project text')
        outside=self.root/'outside.txt'; outside.write_text('synthetic private marker')
        host=ModHost(project_root=project)
        original=artifacts._private_rel; calls=0
        def swapped(rel):
            nonlocal calls
            calls += 1
            if calls == 2:
                target.unlink(); target.symlink_to(outside)
            return original(rel)
        with patch.object(artifacts,'_private_rel',side_effect=swapped), self.assertRaises(ModError):
            host._read_file(m,{'path':'notes.txt'})

    def test_git_read_does_not_execute_repository_fsmonitor(self):
        project=self.root/'project'; project.mkdir()
        subprocess.run(['git','init','-q',str(project)],check=True)
        (project/'one.txt').write_text('one')
        subprocess.run(['git','-C',str(project),'add','one.txt'],check=True)
        marker=self.root/'executed'; hook=self.root/'fsmonitor'
        hook.write_text('#!/bin/sh\ntouch '+str(marker)+'\nprintf "token\\0"\n'); hook.chmod(0o700)
        subprocess.run(['git','-C',str(project),'config','core.fsmonitor',str(hook)],check=True)
        m=manifest.parse({'name':'audit','version':'1.0.0','entry':'main.py','capabilities':{'reads':['git']}},self.folder)
        host=ModHost(project_root=project)
        self.assertIn('one.txt',host._git(m)['status'])
        self.assertFalse(marker.exists())

if __name__=='__main__': unittest.main()
