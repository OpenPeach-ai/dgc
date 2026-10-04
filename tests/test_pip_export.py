"""Offline export boundaries: scoped snapshots, projection and exclusive publication."""
import contextlib
import hashlib
import io
import json
import os
import stat
import unittest
from unittest.mock import patch

from dgc import pip_chat, pip_cli, pip_export as export, pip_checkpoints
from dgc.workspace_registry import RegistryError
from tests import test_pip_handoffs as fixtures


class PipExportTests(unittest.TestCase):
    setUp = fixtures.PipHandoffTests.setUp
    git = fixtures.PipHandoffTests.git
    commit = fixtures.PipHandoffTests.commit
    setup_source = fixtures.PipHandoffTests.setup_source
    propose = fixtures.PipHandoffTests.propose

    def write(self, run_id=None, name='evidence.jsonl'):
        return export.export_run(self.cfg, run_id or self.source_run['id'], self.base/name,
                                 directory=self.registry.directory)

    def rows(self, name='evidence.jsonl'):
        return [json.loads(line) for line in (self.base/name).read_text().splitlines()]

    def unchanged(self):
        return '\n'.join(self.registry.db.iterdump())

    def assert_clean(self):
        self.assertFalse((self.base/'evidence.jsonl').exists())
        self.assertEqual(list(self.base.glob('.dgc-pip-export-*.partial')), [])

    def test_complete_private_export_hash_and_zero_registry_changes(self):
        self.setup_source(); self.propose()
        pip_checkpoints.review_finding(self.store,self.source_run['id'],0,'accepted',0,'device','Inspected assessment')
        before=self.unchanged(); receipt=self.write()['export']; self.assertEqual(self.unchanged(),before)
        path=self.base/'evidence.jsonl'; raw=path.read_bytes(); lines=raw.splitlines(keepends=True)
        rows=self.rows(); footer=rows[-1]['data']
        self.assertEqual(footer['sha256'],hashlib.sha256(b''.join(lines[:-1])).hexdigest())
        self.assertEqual(footer['hashed_bytes'],len(b''.join(lines[:-1])))
        self.assertEqual(footer['hashed_records'],len(rows)-1)
        self.assertEqual(receipt['bytes'],len(raw));self.assertEqual(receipt['records'],len(rows))
        self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o600)
        self.assertTrue(footer['complete']);self.assertTrue(footer['footer_excluded_from_hash'])
        self.assertFalse(rows[0]['data']['importable']);self.assertFalse(rows[0]['data']['restorable'])
        self.assertIn('finding_review_history',[r['type'] for r in rows])
        self.assertIn('handoff_reference',[r['type'] for r in rows])
        self.assertNotIn('base_url',raw.decode());self.assertNotIn(str(self.root),raw.decode())

    def test_foreign_workspace_is_rejected_before_any_json_decode(self):
        self.setup_source(); other=self.base/'other';other.mkdir();self.cfg.project_root=other
        self.registry.resolve(other)
        with patch.object(export,'_object',side_effect=AssertionError('Foreign prose was decoded')):
            with self.assertRaisesRegex(RegistryError,'current workspace'):self.write()
        self.assert_clean()

    def test_unregistered_workspace_is_not_created(self):
        self.setup_source();self.cfg.project_root=self.base;before=self.unchanged()
        with self.assertRaisesRegex(RegistryError,'registered'):self.write()
        self.assertEqual(self.unchanged(),before);self.assert_clean()

    def test_secret_is_redacted_and_hash_describes_exported_projection(self):
        self.setup_source();secret='private-credential-example-382790'
        report=dict(self.source_run['result']);report['summary']='Observed '+secret
        self.registry.db.execute('UPDATE pip_runs SET result=? WHERE id=?',(json.dumps(report),self.source_run['id']))
        with patch.object(export,'secret_values',return_value=(secret,)):
            self.write()
        body=(self.base/'evidence.jsonl').read_text();self.assertNotIn(secret,body);self.assertIn('[REDACTED]',body)
        self.assertGreater(self.rows()[-1]['data']['redacted_records'],0)

    def test_conversation_text_and_pinned_history_are_never_exported(self):
        self.setup_source()
        sent=pip_chat.send(self.store,self.source['id'],'PRIVATE QUESTION UNIQUE','chat-export','device',self.cfg)
        self.store.claim_next();self.store.finish(sent['run']['id'],result={'text':'PRIVATE ANSWER UNIQUE'})
        self.write(sent['run']['id'])
        raw=(self.base/'evidence.jsonl').read_text()
        self.assertNotIn('PRIVATE QUESTION UNIQUE',raw);self.assertNotIn('PRIVATE ANSWER UNIQUE',raw)
        self.assertNotIn('recorded_result',[r['type'] for r in self.rows()])
        self.assertTrue(next(r['data'] for r in self.rows() if r['type']=='omissions')['conversation_bodies'])

    def test_source_bodies_and_artifact_files_are_never_opened(self):
        self.setup_source();directory=self.registry.directory/'runs'/self.source_run['id']/'artifacts'
        directory.mkdir(parents=True);(directory/'changes.patch').write_text('PRIVATE RAW ARTIFACT')
        with patch('builtins.open',side_effect=AssertionError('No raw source/artifact reads')):self.write()
        self.assertNotIn('PRIVATE RAW ARTIFACT',(self.base/'evidence.jsonl').read_text())

    def test_nonterminal_run_refuses_without_changing_it(self):
        self.setup_source();run=self.store.enqueue(self.target['id'],'queued-export','device',self.cfg)
        before=self.unchanged()
        with self.assertRaisesRegex(RegistryError,'Finish or cancel'):self.write(run['id'])
        self.assertEqual(self.unchanged(),before);self.assert_clean()

    def test_oversized_source_cell_refuses_before_json_allocation(self):
        self.setup_source();self.registry.db.execute('UPDATE pip_runs SET result=? WHERE id=?',('x'*(export.MAX_CELL+1),self.source_run['id']))
        with patch.object(export,'_object',side_effect=AssertionError('Oversize cell parsed')):
            with self.assertRaisesRegex(RegistryError,'cell exceeds'):self.write()
        self.assert_clean()

    def test_malformed_duplicate_and_hostile_json_are_refused(self):
        self.setup_source()
        for data in ('[]','{"summary":1,"summary":2}','{"secret":"\\ud800"}','{"a":NaN}'):
            with self.subTest(data=data):
                self.registry.db.execute('UPDATE pip_runs SET result=? WHERE id=?',(data,self.source_run['id']))
                with self.assertRaises(RegistryError):self.write()
                self.assert_clean()

    def test_header_identity_and_timestamp_cannot_be_injected(self):
        self.setup_source()
        self.registry.db.execute('UPDATE pip_runs SET finished_at=? WHERE id=?',('2026\n{"type":"footer"}',self.source_run['id']))
        with self.assertRaisesRegex(RegistryError,'metadata'):self.write()
        self.assert_clean()

    def test_malformed_manifest_projection_cannot_hide_a_transcript_in_metadata(self):
        self.setup_source()
        manifest=json.loads(self.registry.db.execute('SELECT manifest FROM pip_runs WHERE id=?',(self.source_run['id'],)).fetchone()[0])
        manifest['policy_digest']={'transcript':'PRIVATE TRANSCRIPT IN CORRUPT HEADER'}
        self.registry.db.execute('DROP TRIGGER immutable_run_manifest')
        self.registry.db.execute('UPDATE pip_runs SET manifest=? WHERE id=?',(json.dumps(manifest),self.source_run['id']))
        with self.assertRaisesRegex(RegistryError,'policy digest'):self.write()
        self.assert_clean()

    def test_failed_and_cancelled_runs_export_honest_terminal_state(self):
        self.setup_source()
        for status in ('failed','cancelled'):
            run=self.store.enqueue(self.target['id'],'export-'+status,'device',self.cfg)
            if status=='failed':
                self.store.claim_next();self.store.finish(run['id'],error={'code':'fixture_failure','message':'No completed assessment'})
            else:self.store.cancel(run['id'],'device')
            self.write(run['id'],name=status+'.jsonl')
            values=self.rows(status+'.jsonl')
            self.assertEqual(next(r['data'] for r in values if r['type']=='run')['status'],status)
            self.assertNotIn('recorded_result',[r['type'] for r in values])

    def test_restricted_policy_refuses_before_opening_private_state(self):
        self.setup_source()
        self.cfg.data['sandbox']=True
        with patch.object(export,'_directory',side_effect=AssertionError('No private state open')):
            with self.assertRaises(RegistryError):self.write()

    def test_record_cap_reserves_completion_footer_and_leaves_no_partial(self):
        self.setup_source()
        with patch.object(export,'MAX_RECORDS',2),self.assertRaisesRegex(RegistryError,'budget'):self.write()
        self.assert_clean()

    def test_relationship_paging_reports_exact_omissions_without_dispatch(self):
        from dgc import pip_handoffs
        self.setup_source()
        for index in range(27):
            saved=self.propose(idempotency_key='export-related-'+str(index))
            pip_handoffs.reject(self.store,saved['id'],0,'device','Retain reference only')
        self.write()
        rows=self.rows();references=[r for r in rows if r['type']=='handoff_reference']
        self.assertEqual(len(references),25)
        omissions=next(r['data'] for r in rows if r['type']=='omissions')['relationships']['handoff_reference']
        self.assertEqual((omissions['total'],omissions['included'],omissions['omitted']),(27,25,2))
        self.assertTrue(omissions['external_records']);self.assertEqual(self.store.runs(self.target['id']),[])

    def test_incompatible_schema_is_not_migrated(self):
        self.setup_source();version=self.registry.db.execute('PRAGMA user_version').fetchone()[0]
        self.registry.db.execute('PRAGMA user_version='+str(version-1));before=self.unchanged()
        try:
            with self.assertRaisesRegex(RegistryError,'never migrates'):self.write()
            self.assertEqual(self.registry.db.execute('PRAGMA user_version').fetchone()[0],version-1)
            self.assertEqual(self.unchanged(),before);self.assert_clean()
        finally:self.registry.db.execute('PRAGMA user_version='+str(version))

    def test_existing_file_and_symlink_are_never_replaced(self):
        self.setup_source();path=self.base/'evidence.jsonl';path.write_text('KEEP')
        with self.assertRaisesRegex(RegistryError,'already exists'):self.write()
        self.assertEqual(path.read_text(),'KEEP');path.unlink()
        target=self.base/'target';target.write_text('KEEP TARGET');path.symlink_to(target)
        with self.assertRaisesRegex(RegistryError,'already exists'):self.write()
        self.assertEqual(target.read_text(),'KEEP TARGET');self.assertTrue(path.is_symlink())

    def test_relative_path_and_symlink_parent_refuse(self):
        self.setup_source()
        with self.assertRaisesRegex(RegistryError,'absolute'):
            export.export_run(self.cfg,self.source_run['id'],'relative.jsonl',directory=self.registry.directory)
        alias=self.base/'alias';alias.symlink_to(self.base,target_is_directory=True)
        with self.assertRaises(OSError):
            export.export_run(self.cfg,self.source_run['id'],alias/'evidence.jsonl',directory=self.registry.directory)
        self.assert_clean()

    def test_atomic_publication_does_not_replace_a_late_collision(self):
        self.setup_source();link=os.link
        def collision(source,destination,**kwargs):
            (self.base/'evidence.jsonl').write_text('LATE OWNER')
            return link(source,destination,**kwargs)
        with patch.object(export.os,'link',side_effect=collision),self.assertRaises(FileExistsError):self.write()
        self.assertEqual((self.base/'evidence.jsonl').read_text(),'LATE OWNER')
        self.assertEqual(list(self.base.glob('.dgc-pip-export-*.partial')),[])

    def test_failure_budget_and_interruption_remove_only_owned_partial(self):
        self.setup_source();before=self.unchanged()
        for limit in (30,512):
            with patch.object(export,'MAX_BYTES',limit),self.assertRaisesRegex(RegistryError,'budget'):self.write()
            self.assert_clean()
        with patch.object(export._Writer,'record',side_effect=KeyboardInterrupt()),self.assertRaises(KeyboardInterrupt):self.write()
        self.assert_clean();self.assertEqual(self.unchanged(),before)

    def test_replaced_partial_is_never_removed_on_failure(self):
        self.setup_source()
        def replace(*args):
            partial=next(self.base.glob('.dgc-pip-export-*.partial'))
            partial.rename(self.base/'original-owned-partial')
            partial.write_text('UNRELATED REPLACEMENT')
            raise OSError('controlled failure')
        with patch.object(export,'_evidence',side_effect=replace),self.assertRaises(OSError):self.write()
        partial=next(self.base.glob('.dgc-pip-export-*.partial'))
        self.assertEqual(partial.read_text(),'UNRELATED REPLACEMENT')

    def test_parent_rename_and_replacement_refuses_misleading_public_path(self):
        self.setup_source();destination=self.base/'destination';destination.mkdir()
        original=export._evidence
        def moved(*args):
            result=original(*args)
            destination.rename(self.base/'old-destination');destination.mkdir()
            (destination/'evidence.jsonl').write_text('UNRELATED NEW PATH')
            return result
        with patch.object(export,'_evidence',side_effect=moved),self.assertRaisesRegex(RegistryError,'directory moved'):
            export.export_run(self.cfg,self.source_run['id'],destination/'evidence.jsonl',directory=self.registry.directory)
        self.assertEqual((destination/'evidence.jsonl').read_text(),'UNRELATED NEW PATH')
        self.assertEqual(list((self.base/'old-destination').iterdir()),[])

    def test_snapshot_stays_consistent_while_another_connection_reviews(self):
        self.setup_source();record=export._Writer.record;updated=False
        def concurrent(writer,kind,value,**kwargs):
            nonlocal updated
            if kind=='header' and not updated:
                updated=True
                pip_checkpoints.review_finding(self.store,self.source_run['id'],0,'accepted',0,'device','After snapshot')
            return record(writer,kind,value,**kwargs)
        with patch.object(export._Writer,'record',concurrent):self.write()
        review=next(r['data'] for r in self.rows() if r['type']=='finding_review')
        self.assertEqual(review['status'],'open');self.assertEqual(review['revision'],0)
        self.assertEqual(pip_checkpoints.for_run(self.store,self.source_run['id'])['findings'][0]['review']['status'],'accepted')

    def test_expired_proposals_are_not_materialized_or_reviewed(self):
        self.setup_source();self.registry.clock=lambda:'2000-01-01T00:00:00.000Z'
        proposal=self.store.propose(self.source['id'],1,{'goal':'Another inspection'},'device')
        before=self.unchanged();self.write();self.assertEqual(self.unchanged(),before)
        self.assertEqual(self.registry.db.execute('SELECT status FROM pip_approvals WHERE proposal_id=?',
            (proposal['id'],)).fetchone()[0],'pending')


    def test_cli_is_local_only_and_does_not_require_enable_or_start_runtime(self):
        self.setup_source();self.cfg.data['pips_enabled']=False
        args=['export-run',self.source_run['id'],'--output',str(self.base/'evidence.jsonl'),'--json']
        with patch.object(export,'state_directory',return_value=self.registry.directory), \
             patch.object(pip_cli,'WorkspaceRegistry',side_effect=AssertionError('No mutation-capable registry')):
            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                self.assertEqual(pip_cli.handle_command(self.cfg,args),0)
            self.assertEqual(json.loads(stdout.getvalue())['export']['run_id'],self.source_run['id'])
            with contextlib.redirect_stderr(io.StringIO()) as stderr:
                self.assertEqual(pip_cli.handle_command(self.cfg,args,in_chat=True),1)
            self.assertIn('separate_terminal',stderr.getvalue())


class ExecutionExportTests(unittest.TestCase):
    from tests.test_pip_artifact_handoffs import ArtifactHandoffTests as Fixture
    setUp=Fixture.setUp
    git=Fixture.git
    commit=Fixture.commit
    setup_source=Fixture.setup_source
    propose=Fixture.propose
    accept=Fixture.accept
    raw_manifest=Fixture.raw_manifest
    completed_patch=Fixture.completed_patch

    def test_patch_review_and_receipts_export_without_reading_patch_artifact(self):
        self.completed_patch();path=self.base/'patch.jsonl'
        artifact=self.patch_directory/'artifacts'/'changes.patch';saved=artifact.read_bytes()
        artifact.unlink()
        result=export.export_run(self.cfg,self.patch_run['id'],path,directory=self.registry.directory)
        rows=[json.loads(line) for line in path.read_text().splitlines()]
        self.assertIn('execution_review',[r['type'] for r in rows])
        self.assertIn('reviewed_handoff_input',[r['type'] for r in rows])
        self.assertEqual(next(r['data'] for r in rows if r['type']=='recorded_result')['execution']['changes']['artifact']['sha256'],
                         hashlib.sha256(saved).hexdigest())
        self.assertFalse(artifact.exists());self.assertTrue(result['export']['footer_excluded_from_hash'])
