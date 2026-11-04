"""Permanent archived Pip deletion removes owned rows and private state only."""
import json
import os
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

    def _damaged_owned_output_is_left_and_named(self, damage):
        self.setup_source(); archived=self.archive(self.source)
        arts=artifact_store.Store(Path(self.registry.directory).parent/'artifacts')
        owned=arts.create('doc','Pip report','private',origin={'surface':'pip','pip':archived['id']})
        damage(arts.root/owned.id/'artifact.json',archived['id'])
        # Never deleted on a guess, never holding up the rest: the deletion finishes and names the folder.
        result=self.delete(archived)
        self.assertEqual(result['outputs_left'],[str(arts.root/owned.id)])
        self.assertTrue((arts.root/owned.id).exists())
        self.assertFalse(pip_purge._journal_path(self.registry.directory,archived['id']).exists())
        self.assertIsNone(self.registry.db.execute('SELECT 1 FROM pips WHERE id=?',(archived['id'],)).fetchone())

    def test_damaged_owned_output_is_left_in_place_and_named(self):
        self._damaged_owned_output_is_left_and_named(lambda record,pip_id: record.write_bytes(
            b'{"origin":{"pip":"'+pip_id.encode()+b'"}'))

    def test_damaged_output_without_readable_owner_is_left_in_place_and_named(self):
        self._damaged_owned_output_is_left_and_named(lambda record,_: record.write_bytes(b'{damaged'))

    def test_non_object_output_record_is_left_in_place_and_named(self):
        self._damaged_owned_output_is_left_and_named(lambda record,_: record.write_bytes(b'[]'))

    def test_missing_output_record_is_left_in_place_and_named(self):
        self._damaged_owned_output_is_left_and_named(lambda record,_: record.unlink())

    def test_unrelated_half_made_or_newer_output_never_blocks_deletion_or_other_commands(self):
        self.setup_source(); archived=self.archive(self.source)
        root=Path(self.registry.directory)
        (root/'chat_images'/archived['id']).mkdir(parents=True); (root/'chat_images'/archived['id']/'one.png').write_text('x')
        arts=artifact_store.Store(root.parent/'artifacts')
        chat=arts.create('doc','Chat report','keep',origin={'surface':'chat','chat':'chat_x'})
        newer=arts.create('doc','Newer report','keep',origin={'surface':'chat','chat':'chat_y'})
        record=arts.root/newer.id/'artifact.json'
        data=json.loads(record.read_text()); data['type']='image'   # a type only a later DGC knows
        record.write_text(json.dumps(data))
        empty=arts.root/('ar_'+'a'*16); empty.mkdir(mode=0o700)        # a crash before anything was written
        partial=arts.root/('ar_'+'b'*16); (partial/'blobs').mkdir(parents=True)
        (partial/'blobs'/'part').write_text('half written')            # a crash part way through
        owned=arts.create('doc','Pip report','private',origin={'surface':'pip','pip':archived['id']})
        result=self.delete(archived)
        self.assertEqual(result,{'deleted':True,'pip_id':archived['id'],'outputs_left':[str(partial)]})
        self.assertFalse((arts.root/owned.id).exists())
        self.assertFalse((root/'chat_images'/archived['id']).exists())
        for kept in (arts.root/chat.id, arts.root/newer.id, empty, partial):
            self.assertTrue(kept.exists(), kept)
        self.assertFalse(pip_purge._journal_path(root,archived['id']).exists())
        def registry(): return WorkspaceRegistry(self.registry.directory, clock=self.registry.clock)
        with patch.object(pips,'WorkspaceRegistry',registry):
            out=pips.handle_control(self.cfg,{'type':'list_pip_runs','request_id':'r1','pip_id':self.target['id']},
                                    'editor-user',start_worker=False)
        self.assertTrue(out['ok'],out)

    def test_a_deletion_that_cant_finish_never_fails_other_commands(self):
        self.setup_source(); archived=self.archive(self.source)
        root=Path(self.registry.directory)
        image=root/'chat_images'/archived['id']/'one.png'
        image.parent.mkdir(parents=True); image.write_text('private')
        arts=artifact_store.Store(root.parent/'artifacts')
        partial=arts.root/('ar_'+'c'*16); partial.mkdir(parents=True); (partial/'part').write_text('x')
        sealed=pip_logins.Store(root).root/pip_logins.SEALED
        sealed.write_bytes(b'not a sealed file DGC can open')
        with self.assertRaises(RegistryError) as raised:
            self.delete(archived)
        # It says what stopped it, and the Output it left; the rest was still erased.
        self.assertIn('saved logins', str(raised.exception))
        self.assertIn(str(partial), str(raised.exception))
        self.assertFalse(image.exists())
        journal=pip_purge._journal_path(root,archived['id'])
        self.assertTrue(journal.exists())
        def registry(): return WorkspaceRegistry(self.registry.directory, clock=self.registry.clock)
        request={'type':'list_pip_runs','request_id':'r1','pip_id':self.target['id']}
        with patch.object(pips,'WorkspaceRegistry',registry):
            for _ in range(2):
                out=pips.handle_control(self.cfg,request,'editor-user',start_worker=False)
                self.assertTrue(out['ok'],out)
            # Once what stopped it is fixed, a later command finishes it (tried at most once a minute).
            sealed.unlink()
            out=pips.handle_control(self.cfg,request,'editor-user',start_worker=False)
            self.assertTrue(out['ok'],out); self.assertTrue(journal.exists())
            old=journal.stat().st_mtime-pip_purge.RETRY_SECONDS-1
            os.utime(journal,(old,old))
            out=pips.handle_control(self.cfg,request,'editor-user',start_worker=False)
        self.assertTrue(out['ok'],out)
        self.assertFalse(journal.exists())
        self.assertTrue(partial.exists())

    def test_shared_metadata_rows_lose_only_the_deleted_pips_entries(self):
        self.setup_source(); archived=self.archive(self.source)
        other=self.target['id']
        seen={'alerts':['alert_other'],'reviews':['rev_other'],'ran':[f'ran:{other}:1'],'finished':['chat:msg_other'],
              'asking':[],'blocked':[f"blocked:{archived['id']}:2026-10-01T00:00:00Z",f'blocked:{other}:2026-10-02T00:00:00Z']}
        db=self.registry.db
        db.execute('INSERT INTO metadata VALUES(?,?)',('desktop_notifications_seen',json.dumps(seen)))
        db.execute('INSERT INTO metadata VALUES(?,?)',('pip_level:'+archived['id'],'{"level":"ask"}'))
        db.execute('INSERT INTO metadata VALUES(?,?)',('pip_level:'+other,'{"level":"ask"}'))
        self.delete(archived)
        row=db.execute("SELECT value FROM metadata WHERE key='desktop_notifications_seen'").fetchone()
        self.assertIsNotNone(row)   # the other Pips' notices are not announced again
        self.assertEqual(json.loads(row[0]),{**seen,'blocked':[f'blocked:{other}:2026-10-02T00:00:00Z']})
        self.assertIsNone(db.execute('SELECT 1 FROM metadata WHERE key=?',('pip_level:'+archived['id'],)).fetchone())
        self.assertIsNotNone(db.execute('SELECT 1 FROM metadata WHERE key=?',('pip_level:'+other,)).fetchone())
        self.assertIsNone(db.execute('SELECT 1 FROM metadata WHERE instr(key,?)>0 OR instr(value,?)>0',
                                     (archived['id'],archived['id'])).fetchone())

    def test_sqlite_without_table_list_still_deletes_and_leaves_search_tables_alone(self):
        # SQLite before 3.37 (RHEL 9's Python, say) ignores PRAGMA table_list and answers no rows.
        modern=pip_purge._tables(self.registry.db)
        self.assertNotIn('pip_chat_fts',modern); self.assertNotIn('pip_chat_fts_data',modern)
        real=self.registry.db
        class OldSqlite:
            def execute(self,sql,*args):
                if sql.strip().upper()=='PRAGMA TABLE_LIST':
                    return real.execute('SELECT 1 WHERE 0')
                return real.execute(sql,*args)
            def __getattr__(self,name): return getattr(real,name)
        old=OldSqlite()
        self.assertEqual(pip_purge._tables(old),modern)
        self.setup_source(); archived=self.archive(self.source)
        message_id='msg_'+'d'*32
        real.execute('INSERT INTO pip_chat_messages(id,pip_id,workspace_id,run_id,role,text,model,created_at) VALUES(?,?,?,?,?,?,?,?)',
            (message_id,archived['id'],self.workspace['id'],self.source_run['id'],'assistant','private chat text','fixture',self.now))
        self.registry.db=self.store.db=old
        try:
            self.assertEqual(self.delete(archived),{'deleted':True,'pip_id':archived['id']})
        finally:
            self.registry.db=self.store.db=real
        self.assertIsNone(real.execute('SELECT 1 FROM pips WHERE id=?',(archived['id'],)).fetchone())
        self.assertEqual(real.execute("SELECT count(*) FROM pip_chat_fts WHERE pip_chat_fts MATCH 'private'").fetchone()[0],0)
        real.execute("INSERT INTO pip_chat_fts(pip_chat_fts) VALUES('integrity-check')")   # raises when the index is broken

    def test_facts_the_pip_kept_in_shared_memory_go_with_it(self):
        from dgc import shared_memory
        place=self.base/'account'/'.dgc'/'memory'
        with patch.object(shared_memory,'default_root',return_value=place):
            self.setup_source(); archived=self.archive(self.source)
            memory=shared_memory.SharedMemory()
            kept=memory.remember("The user's bank is Northwind Savings",surface='pip',where=archived['name'],
                                 said='My bank is Northwind Savings and my account manager is Priya Raman.',
                                 pip=archived['id'],run=self.source_run['id'])
            edited=memory.remember('The account manager is Priya Raman',surface='pip',where=archived['name'],
                                   said='My bank is Northwind Savings and my account manager is Priya Raman.',
                                   pip=archived['id'],run=self.source_run['id'])
            memory.edit(edited['id'],'The account manager at Northwind is Priya Raman')
            memory.forget(kept['id']); memory.undo(memory.history()[0]['id'])   # forgotten, then brought back
            other=memory.remember('The user walks to work',said='I walk to work every day.',surface='pip',
                                  where='Other',pip=self.target['id'],run='run_'+'e'*32)
            mine=memory.add('Short replies, please')
            self.assertEqual(len(memory.from_pip(archived['id'])),2)
            self.delete(archived)
            after=shared_memory.SharedMemory()
            self.assertEqual(after.from_pip(archived['id']),[])
            self.assertEqual({f['id'] for f in after.facts()},{other['id'],mine['id']})
            journal=(place/'journal.ndjson').read_text()
            for gone in ('Northwind','Priya',archived['id']):
                self.assertNotIn(gone,journal)
            self.assertIn('walks to work',journal); self.assertIn('Short replies',journal)

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
