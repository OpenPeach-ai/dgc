"""Permanent archived Pip deletion removes owned rows and private state only."""
import sqlite3
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_archive, pip_purge, pips
from dgc import artifact_store, pip_logins
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pip_handoffs as fixtures


class PipPurgeTests(unittest.TestCase):
    setUp = fixtures.PipHandoffTests.setUp
    git = fixtures.PipHandoffTests.git
    commit = fixtures.PipHandoffTests.commit
    setup_source = fixtures.PipHandoffTests.setup_source
    propose = fixtures.PipHandoffTests.propose

    def archive(self, pip):
        current = self.store.get(pip['id'])
        return pip_archive.transition(self.store, pip['id'], archived=True,
            expected_version=current['current_version'],
            expected_lifecycle_revision=current['lifecycle_revision'],
            request_key='purge-test', reason='Done', actor='editor-user')['pip']

    def delete(self, pip, **kwargs):
        values = dict(expected_name=pip['name'], expected_version=pip['current_version'],
                      expected_lifecycle_revision=pip['lifecycle_revision'], actor='editor-user')
        values.update(kwargs)
        return pip_purge.delete(self.store, pip['id'], **values)

    def test_deletes_archived_pip_run_receipts_cross_links_and_files(self):
        self.setup_source()
        handoff = self.propose()
        from dgc import pip_handoffs
        pip_handoffs.reject(self.store, handoff['id'], 0, 'device', 'No')
        archived = self.archive(self.source)
        root = Path(self.registry.directory)
        message_id='msg_'+'c'*32
        self.registry.db.execute('INSERT INTO pip_chat_messages(id,pip_id,workspace_id,run_id,role,text,model,created_at) VALUES(?,?,?,?,?,?,?,?)',
            (message_id,archived['id'],self.workspace['id'],self.source_run['id'],'assistant','private chat text','fixture',self.now))
        self.registry.db.execute('INSERT INTO pip_chat_images(message_id,idx,sha256,mime,bytes) VALUES(?,?,?,?,?)',
            (message_id,0,'a'*64,'image/png',10))
        self.registry.db.execute('INSERT INTO metadata(key,value) VALUES(?,?)',
            ('pip-cross-reference', archived['id']))
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_chat_fts WHERE pip_chat_fts MATCH 'private'").fetchone()[0],1)
        for path in (root/'computers'/archived['id']/'home'/'file.txt',
                     root/'chat_images'/archived['id']/'one.png',
                     root/'runs'/self.source_run['id']/'data.txt'):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('private')
        self.assertEqual(self.delete(archived), {'deleted': True, 'pip_id': archived['id']})
        self.assertIsNone(self.registry.db.execute('SELECT 1 FROM pips WHERE id=?',(archived['id'],)).fetchone())
        self.assertIsNone(self.registry.db.execute('SELECT 1 FROM pip_runs WHERE id=?',(self.source_run['id'],)).fetchone())
        self.assertIsNone(self.registry.db.execute('SELECT 1 FROM pip_handoffs WHERE id=?',(handoff['id'],)).fetchone())
        self.assertIsNone(self.registry.db.execute('SELECT 1 FROM pip_archive_requests WHERE pip_id=?',(archived['id'],)).fetchone())
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_chat_fts WHERE pip_chat_fts MATCH 'private'").fetchone()[0],0)
        self.assertIsNotNone(self.registry.db.execute('SELECT 1 FROM pips WHERE id=?',(self.target['id'],)).fetchone())
        self.assertIsNone(self.registry.db.execute('PRAGMA foreign_key_check').fetchone())
        self.assertFalse((root/'computers'/archived['id']).exists())
        self.assertFalse((root/'chat_images'/archived['id']).exists())
        self.assertFalse((root/'runs'/self.source_run['id']).exists())
        self.assertFalse(pip_purge._journal_path(root,archived['id']).exists())
        self.assertIsNotNone(self.registry.db.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='retain_pip_archive_request'").fetchone())
        for table in pip_purge._tables(self.registry.db):
            for row in self.registry.db.execute(f'SELECT * FROM "{table}"'):
                values=' '.join(str(value) for value in row)
                self.assertNotIn(archived['id'],values,table)
                self.assertNotIn(self.source_run['id'],values,table)

    def test_active_pip_and_stale_name_are_refused(self):
        self.setup_source()
        with self.assertRaisesRegex(RegistryError, 'Archive'):
            self.delete(self.source)
        archived = self.archive(self.source)
        with self.assertRaisesRegex(RegistryError, 'name changed'):
            self.delete(archived,expected_name='Other')
        self.assertIsNotNone(self.registry.db.execute('SELECT 1 FROM pips WHERE id=?',(archived['id'],)).fetchone())

    def test_failed_transaction_does_not_remove_files(self):
        self.setup_source(); archived=self.archive(self.source)
        path=Path(self.registry.directory)/'chat_images'/archived['id']/'one.png'
        path.parent.mkdir(parents=True); path.write_text('keep')
        with patch.object(pip_purge,'_delete_rows',side_effect=sqlite3.OperationalError('synthetic')):
            with self.assertRaises(sqlite3.OperationalError):self.delete(archived)
        self.assertTrue(path.is_file())
        self.assertIsNotNone(self.registry.db.execute('SELECT 1 FROM pips WHERE id=?',(archived['id'],)).fetchone())
        pip_purge.recover(self.registry)
        self.assertFalse(pip_purge._journal_path(self.registry.directory,archived['id']).exists())

    def test_exclusive_login_and_owned_output_are_erased_but_shared_data_stays(self):
        self.setup_source(); archived=self.archive(self.source)
        root=Path(self.registry.directory)
        logins=pip_logins.Store(root)
        logins.save(address='https://one.example',username='owner',password='secret',pips=[archived['id']],source='page')
        logins.save(address='https://shared.example',username='owner',password='shared-secret',
                    pips=[archived['id'],self.target['id']],source='page')
        arts=artifact_store.Store(root.parent/'artifacts')
        owned=arts.create('doc','Pip report','private report',origin={'surface':'pip','pip':archived['id']})
        other=arts.create('doc','Other report','keep',origin={'surface':'pip','pip':self.target['id']})
        self.delete(archived)
        self.assertFalse((arts.root/owned.id).exists())
        self.assertTrue((arts.root/other.id).exists())
        saved=logins.read()['logins']
        self.assertEqual(len(saved),1)
        self.assertEqual(saved[0]['pips'],[self.target['id']])

    def test_control_rejects_remote_actor_and_accepts_exact_local_confirmation(self):
        self.setup_source(); archived=self.archive(self.source)
        request={'type':'delete_archived_pip','request_id':'delete-one','pip_id':archived['id'],
                 'expected_name':archived['name'],'expected_version':archived['current_version'],
                 'expected_lifecycle_revision':archived['lifecycle_revision']}
        def registry(): return WorkspaceRegistry(self.registry.directory, clock=self.registry.clock)
        with patch.object(pips,'WorkspaceRegistry',registry):
            remote=pips.handle_control(self.cfg,request,'paired-device',start_worker=False)
            self.assertFalse(remote['ok'])
            self.assertIsNotNone(self.registry.db.execute('SELECT 1 FROM pips WHERE id=?',(archived['id'],)).fetchone())
            local=pips.handle_control(self.cfg,request,'editor-user',start_worker=False)
        self.assertTrue(local['ok'],local)
        self.assertEqual(local['result'],{'deleted':True,'pip_id':archived['id']})

    def test_cleanup_failure_is_retried_from_private_journal(self):
        self.setup_source(); archived=self.archive(self.source)
        path=Path(self.registry.directory)/'chat_images'/archived['id']/'one.png'
        path.parent.mkdir(parents=True);path.write_text('private')
        actual=pip_purge._cleanup
        with patch.object(pip_purge,'_cleanup',side_effect=OSError('synthetic disk error')):
            with self.assertRaises(OSError):self.delete(archived)
        self.assertIsNone(self.registry.db.execute('SELECT 1 FROM pips WHERE id=?',(archived['id'],)).fetchone())
        self.assertTrue(path.exists())
        self.assertTrue(pip_purge._journal_path(self.registry.directory,archived['id']).exists())
        with patch.object(pip_purge,'_cleanup',side_effect=actual):pip_purge.recover(self.registry)
        self.assertFalse(path.exists())
        self.assertFalse(pip_purge._journal_path(self.registry.directory,archived['id']).exists())

    def test_damaged_owned_output_keeps_recovery_pending(self):
        self.setup_source(); archived=self.archive(self.source)
        arts=artifact_store.Store(Path(self.registry.directory).parent/'artifacts')
        owned=arts.create('doc','Pip report','private',origin={'surface':'pip','pip':archived['id']})
        record=arts.root/owned.id/'artifact.json'
        intact=record.read_bytes()
        record.write_bytes(b'{"origin":{"pip":"'+archived['id'].encode()+b'"}')
        with self.assertRaisesRegex(RegistryError,'saved Output needs repair'):
            self.delete(archived)
        self.assertTrue(pip_purge._journal_path(self.registry.directory,archived['id']).exists())
        self.assertTrue((arts.root/owned.id).exists())
        record.write_bytes(intact)
        pip_purge.recover(self.registry)
        self.assertFalse((arts.root/owned.id).exists())
        self.assertFalse(pip_purge._journal_path(self.registry.directory,archived['id']).exists())

    def test_damaged_output_without_readable_owner_keeps_recovery_pending(self):
        self.setup_source(); archived=self.archive(self.source)
        arts=artifact_store.Store(Path(self.registry.directory).parent/'artifacts')
        owned=arts.create('doc','Pip report','private',origin={'surface':'pip','pip':archived['id']})
        record=arts.root/owned.id/'artifact.json'
        intact=record.read_bytes()
        record.write_bytes(b'{damaged')
        with self.assertRaisesRegex(RegistryError,'saved Output needs repair'):
            self.delete(archived)
        self.assertTrue(pip_purge._journal_path(self.registry.directory,archived['id']).exists())
        record.write_bytes(intact)
        pip_purge.recover(self.registry)
        self.assertFalse((arts.root/owned.id).exists())

    def test_linked_state_parent_cannot_redirect_file_cleanup(self):
        self.setup_source(); archived=self.archive(self.source)
        root=Path(self.registry.directory)
        outside=self.base/'outside'
        target=outside/archived['id']
        target.mkdir(parents=True)
        (target/'keep.txt').write_text('outside')
        link=root/'chat_images'
        link.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(RegistryError,'symbolic link'):
            self.delete(archived)
        self.assertEqual((target/'keep.txt').read_text(),'outside')
        self.assertTrue(pip_purge._journal_path(self.registry.directory,archived['id']).exists())
        link.unlink()
        pip_purge.recover(self.registry)
        self.assertEqual((target/'keep.txt').read_text(),'outside')
        self.assertFalse(pip_purge._journal_path(self.registry.directory,archived['id']).exists())
