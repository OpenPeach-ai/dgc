"""Session statements are explicit reviews, not inferred execution attestations."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch

from dgc import sessions, workspace_session_outcomes as outcomes, pips
from dgc.workspace_context import ContextStore, validate_snapshot
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures


class SessionOutcomeTests(unittest.TestCase):
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        self.revision = self.commit()
        self.ws = self.workspace['id']
        self.outcomes = outcomes.SessionOutcomeStore(self.registry)
        self.hub = ContextStore(self.registry)
        self.sid = '20261002-120000-deadbeef'
        self.session_root = patch.object(sessions, 'SESSIONS_DIR', self.base / 'private-sessions')
        self.session_root.start(); self.addCleanup(self.session_root.stop)
        self.path = sessions.project_dir(self.root) / (self.sid + '.json')
        self.record = {'id': self.sid, 'project': str(self.root), 'revision': 3,
                       'messages': [{'role': 'assistant', 'content': 'PRIVATE_TRANSCRIPT tests passed'}]}
        self.write()
        self.registry.associate_session(self.sid, self.root)

    def write(self, record=None):
        self.path.write_text(json.dumps(self.record if record is None else record), encoding='utf-8')

    def propose(self, **changes):
        args = dict(workspace_id=self.ws, session_id=self.sid, title='Reviewed routing outcome',
                    statement='The router change is ready for the next review.',
                    source={'kind': 'commit', 'revision': self.revision}, expected_session_revision=3,
                    request_key='statement-one', actor='local-user', config=self.cfg)
        args.update(changes)
        return self.outcomes.propose(**args)['proposal']

    def accept(self, proposal, **changes):
        args = dict(workspace_id=self.ws, proposal_id=proposal['id'], expected_digest=proposal['digest'],
                    expected_context_revision=0, actor='local-user', config=self.cfg)
        args.update(changes)
        return self.outcomes.accept(**args)

    def test_inspection_returns_exact_bounded_metadata_only(self):
        result = self.outcomes.inspect(self.ws, self.sid, config=self.cfg)
        self.assertEqual(result['session'], {'id': self.sid, 'revision': 3,
            'bytes': self.path.stat().st_size, 'sha256': hashlib.sha256(self.path.read_bytes()).hexdigest()})
        self.assertNotIn('PRIVATE_TRANSCRIPT', json.dumps(result))
        self.assertEqual(self.hub.get(self.ws)['revision'], 0)

    def test_propose_review_accept_and_restart_preserve_honest_classification(self):
        proposal = self.propose(statement='I believe the tests passed.')
        self.assertEqual(proposal['status'], 'pending')
        self.assertEqual(self.hub.get(self.ws)['entries'], [])
        self.assertNotIn('PRIVATE_TRANSCRIPT', json.dumps(proposal))
        accepted = self.accept(proposal)
        entry = accepted['context']['entries'][0]
        self.assertEqual(entry['kind'], 'session_outcome')
        pin = entry['provenance']['proposal']
        self.assertEqual(pin['classification'], 'user_reviewed_statement')
        self.assertEqual(pin['verification'], 'not_execution_verified')
        self.assertEqual(pin['source_reference']['relation'], 'selected_for_statement')
        self.assertIn('execution was not verified', entry['content'])
        self.assertIn('I believe the tests passed.', entry['content'])
        snapshot = self.hub.snapshot(self.ws)
        self.assertEqual(validate_snapshot(snapshot, self.ws), snapshot)
        with WorkspaceRegistry(self.registry.directory) as restarted:
            self.assertEqual(outcomes.SessionOutcomeStore(restarted).get(self.ws, proposal['id'])['proposal'], accepted['proposal'])
            self.assertEqual(ContextStore(restarted).snapshot(self.ws), snapshot)

    def test_exact_proposal_retry_does_not_reread_and_changed_request_conflicts(self):
        first = self.propose()
        with patch.object(outcomes, 'inspect_session', side_effect=AssertionError('No retry transcript')):
            self.assertEqual(self.propose(), first)
        for change in ({'statement': 'Different'}, {'expected_session_revision': 4}, {'title': 'Other'}, {'actor': 'another-user'}):
            with self.subTest(change=change), self.assertRaisesRegex(RegistryError, 'different statement'):
                self.propose(**change)
        self.assertEqual(len(self.outcomes.list(self.ws)['proposals']), 1)

    def test_accepted_retry_is_historical_and_never_duplicates_or_restores_context(self):
        proposal = self.propose(); accepted = self.accept(proposal)
        entry_id = accepted['proposal']['entry_id']
        self.hub.archive(self.ws, entry_id, 1, 'user')
        self.path.unlink()
        with patch.object(outcomes, 'inspect_session', side_effect=AssertionError('No historical reread')):
            retry = self.accept(proposal)
        self.assertTrue(retry['replayed'])
        self.assertEqual(retry['context']['entries'], [])
        self.assertEqual(retry['context']['revision'], 2)

    def test_reject_is_idempotent_and_cannot_promote(self):
        proposal = self.propose()
        rejected = self.outcomes.reject(self.ws, proposal['id'], proposal['digest'], 'user')
        self.assertEqual(rejected['proposal']['status'], 'rejected')
        self.assertEqual(self.outcomes.reject(self.ws, proposal['id'], proposal['digest'], 'user'), rejected)
        with self.assertRaisesRegex(RegistryError, 'rejected'):
            self.accept(proposal)
        self.assertEqual(self.hub.get(self.ws)['revision'], 0)

    def test_stale_digest_context_and_session_cannot_accept(self):
        proposal = self.propose()
        with self.assertRaisesRegex(RegistryError, 'digest'):
            self.accept(proposal, expected_digest='0' * 64)
        self.hub.record(self.ws, 'decision', 'Other', 'Concurrent user record.', 0, 'user')
        with self.assertRaisesRegex(RegistryError, 'context changed'):
            self.accept(proposal)
        self.record['revision'] += 1; self.write()
        with self.assertRaisesRegex(RegistryError, 'session changed'):
            self.accept(proposal, expected_context_revision=1)
        self.assertEqual(self.outcomes.get(self.ws, proposal['id'])['proposal']['status'], 'pending')

    def test_session_same_generation_changed_bytes_is_not_accepted(self):
        proposal = self.propose()
        self.record['messages'][0]['content'] = 'Changed bytes'; self.write()
        with self.assertRaisesRegex(RegistryError, 'session changed'):
            self.accept(proposal)

    def test_disabled_restricted_and_foreign_scope_refuse_before_payload_read(self):
        proposal = self.propose()
        with patch.object(self.outcomes, '_row', side_effect=AssertionError('Must authorize first')):
            self.cfg.data['pips_enabled'] = False
            with self.assertRaisesRegex(RegistryError, 'Enable Pips'):
                self.accept(proposal)
            self.cfg.data['pips_enabled'] = True
            with patch('dgc.pip_access.restricted', return_value=True), self.assertRaises(RegistryError):
                self.accept(proposal)
            other = self.base / 'other'; other.mkdir(); self.cfg.project_root = other
            with self.assertRaisesRegex(RegistryError, 'exact local workspace'):
                self.accept(proposal)

    def test_path_and_private_association_cannot_be_supplied_by_transcript(self):
        for sid in ('../outside', '/etc/passwd', 'a/b', 'a\\b', '.hidden', 'a.json\n'):
            with self.subTest(sid=sid), self.assertRaises(RegistryError): self.propose(session_id=sid)
        self.registry.db.execute('DELETE FROM session_workspaces WHERE session_id=?', (self.sid,))
        self.record.update(workspace_id=self.ws, workspace_binding_id=self.workspace['binding_id']); self.write()
        with self.assertRaisesRegex(RegistryError, 'privately associated'):
            self.propose()

    def test_bad_identity_project_revision_and_messages_refuse(self):
        for delta in ({'id': 'other'}, {'project': str(self.base)}, {'project': '.'}, {'revision': True},
                      {'revision': -1}, {'revision': 1.5}, {'messages': {}}, {'messages': ['not a message']}):
            self.write({**self.record, **delta})
            with self.subTest(delta=delta), self.assertRaises(RegistryError): self.propose()
        self.assertEqual(self.outcomes.list(self.ws)['proposals'], [])

    def test_symlink_hardlink_fifo_and_oversize_refuse_before_content_read(self):
        real = self.base / 'real'; real.write_text(json.dumps(self.record))
        self.path.unlink(); self.path.symlink_to(real)
        with self.assertRaisesRegex(RegistryError, 'refuses links'): self.propose()
        self.path.unlink(); os.link(real, self.path)
        with self.assertRaisesRegex(RegistryError, 'refuses links'): self.propose()
        self.path.unlink(); os.mkfifo(self.path)
        with self.assertRaisesRegex(RegistryError, 'special files'): self.propose()
        self.path.unlink()
        with self.path.open('wb') as handle: handle.truncate(outcomes.MAX_TRANSCRIPT_BYTES + 1)
        with patch.object(outcomes._JSONStream, 'read', side_effect=AssertionError('No allocation/read')):
            with self.assertRaisesRegex(RegistryError, '8 MiB'): self.propose()

    def test_ancestor_link_and_root_replacement_refuse(self):
        bucket = self.path.parent; old = bucket.with_name('old'); bucket.rename(old); bucket.symlink_to(old, target_is_directory=True)
        with self.assertRaises(RegistryError): self.propose()
        bucket.unlink(); old.rename(bucket)
        proposal = self.propose()
        moved = self.base / 'moved'; self.root.rename(moved); self.root.mkdir()
        with self.assertRaisesRegex(RegistryError, 'binding changed'):
            self.accept(proposal)

    def test_source_inputs_are_closed_exact_and_cannot_supply_a_fake_receipt(self):
        for source in ({'kind': 'commit', 'revision': 'HEAD'}, {'kind': 'commit', 'revision': '-flag'},
                       {'kind': 'commit', 'revision': self.revision, 'verified': True},
                       {'kind': 'current_tree', 'sha256': 'a'*64}, {'kind': 'pip_run', 'run_id': '../run'}):
            with self.subTest(source=source), self.assertRaises(RegistryError): self.propose(source=source)
        with self.assertRaises(RegistryError): self.propose(source={'kind': 'commit', 'revision': 'a'*40})

    def test_source_and_session_io_happen_outside_sql_transaction(self):
        real_source, real_read = outcomes._source, outcomes._JSONStream.read
        def source(*args):
            self.assertFalse(self.registry.db.in_transaction); return real_source(*args)
        def read(reader):
            self.assertFalse(self.registry.db.in_transaction); return real_read(reader)
        with patch.object(outcomes, '_source', source), patch.object(outcomes._JSONStream, 'read', read):
            proposal = self.propose(); self.accept(proposal)
        with self.registry.transaction(), self.assertRaisesRegex(RegistryError, 'before opening'):
            self.propose(request_key='nested')

    def test_deterministic_session_change_between_inspection_and_commit_refuses(self):
        original = outcomes._JSONStream.read
        def mutate(reader):
            result = original(reader); self.record['revision'] = 4; self.write(); return result
        with patch.object(outcomes._JSONStream, 'read', mutate), self.assertRaisesRegex(RegistryError, 'changed during review'):
            self.propose()
        self.assertEqual(self.outcomes.list(self.ws)['proposals'], [])

    def test_complete_private_run_source_receipt_is_reference_not_test_attestation(self):
        job = self.store.create(self.ws, 'Reviewer', 'Inspect source.', 'user')
        run = self.store.enqueue(job['id'], 'reference-run', 'user', self.cfg)
        report = {'summary': 'No claim', 'findings': [], 'limitations': [], 'tests_executed': False}
        from dgc.pip_checkpoints import _SOURCE_VERIFICATION
        report['verification'] = _SOURCE_VERIFICATION
        self.store.claim_next(); self.store.finish(run['id'], result=report)
        proposal = self.propose(source={'kind': 'pip_run', 'run_id': run['id']})
        self.assertEqual(proposal['source_reference']['source_revision'], self.revision)
        self.assertEqual(proposal['verification'], 'not_execution_verified')
        self.accept(proposal)

    def test_current_tree_reference_keeps_null_commit_and_completed_receipt(self):
        job = self.store.create(self.ws, 'Tree reviewer', 'Inspect current source.', 'user')
        pending = self.store.propose(job['id'], 1, {'source_policy': {'mode': 'current_tree', 'exclusions': 'safe_source_v1'}}, 'user')
        self.store.accept(job['id'], pending['id'], 1, 'user')
        run = self.store.enqueue(job['id'], 'tree-reference', 'user', self.cfg)
        from dgc.pip_checkpoints import _SOURCE_VERIFICATION
        self.store.claim_next()
        self.store.finish(run['id'], result={'summary': 'Tree report', 'findings': [], 'limitations': [],
            'tests_executed': False, 'verification': _SOURCE_VERIFICATION,
            'snapshot': {key: run['manifest']['source_snapshot'][key] for key in ('sha256', 'files', 'bytes')}})
        proposal = self.propose(source={'kind': 'pip_run', 'run_id': run['id']})
        self.assertIsNone(proposal['source_reference']['source_revision'])
        self.assertEqual(proposal['source_reference']['source_snapshot'], run['manifest']['source_snapshot'])
        self.accept(proposal)

    def test_two_connection_accept_race_records_once(self):
        proposal = self.propose(); barrier = Barrier(2); original = outcomes._source
        def synchronize(*args):
            result = original(*args); barrier.wait(timeout=10); return result
        def accept():
            with WorkspaceRegistry(self.registry.directory) as registry:
                return outcomes.SessionOutcomeStore(registry).accept(self.ws, proposal['id'], proposal['digest'], 0, 'user', config=self.cfg)
        with patch.object(outcomes, '_source', synchronize), ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(accept) for _ in range(2)]
            results = [future.result(timeout=15) for future in futures]
        self.assertEqual(sorted(value['replayed'] for value in results), [False, True])
        self.assertEqual(self.hub.get(self.ws)['revision'], 1)
        self.assertEqual(len(self.hub.get(self.ws)['entries']), 1)

    def test_selected_human_workspace_config_is_nonpersisting_and_still_scoped(self):
        unrelated = self.base / 'unrelated'; unrelated.mkdir()
        foreground = fixtures.config(unrelated)
        selected = copy.copy(foreground); selected.project_root = self.root; selected._persist = False
        proposal = self.propose(config=selected)
        self.accept(proposal, config=selected)
        self.assertEqual(foreground.project_root, unrelated)
        self.assertFalse((unrelated / '.dgc').exists())

    def test_corrupt_metadata_or_linked_acceptance_refuses_bounded_reads(self):
        proposal = self.propose(); self.accept(proposal)
        self.registry.db.execute('DROP TRIGGER immutable_session_outcome')
        self.registry.db.execute('DROP TRIGGER review_session_outcome')
        self.registry.db.execute('UPDATE workspace_session_outcomes SET reviewed_by=?', ('x'*100000,))
        with self.assertRaises(RegistryError): self.outcomes.get(self.ws, proposal['id'])
        self.registry.db.execute('UPDATE workspace_session_outcomes SET reviewed_by=?', ('user',))
        other = self.hub.record(self.ws, 'decision', 'Unrelated', 'Other reference.', 1, 'user')['entries'][-1]['id']
        self.registry.db.execute('UPDATE workspace_session_outcomes SET entry_id=?', (other,))
        with self.assertRaisesRegex(RegistryError, 'immutable workspace-context'):
            self.outcomes.get(self.ws, proposal['id'])

    def test_concurrent_context_cas_and_failed_review_roll_back_both_writes(self):
        proposal = self.propose()
        self.registry.db.execute("CREATE TRIGGER fixture_review_failure BEFORE UPDATE ON workspace_session_outcomes BEGIN SELECT RAISE(ABORT,'fixture'); END")
        with self.assertRaises(sqlite3.IntegrityError): self.accept(proposal)
        self.assertEqual(self.hub.get(self.ws)['revision'], 0)
        self.assertEqual(self.outcomes.get(self.ws, proposal['id'])['proposal']['status'], 'pending')
        self.registry.db.execute('DROP TRIGGER fixture_review_failure')
        with WorkspaceRegistry(self.registry.directory) as other:
            ContextStore(other).record(self.ws, 'decision', 'Elsewhere', 'Concurrent accepted record.', 0, 'user')
        with self.assertRaisesRegex(RegistryError, 'context changed'): self.accept(proposal)

    def test_page_cursor_pending_limits_secret_and_statement_bounds(self):
        for n in range(3): self.propose(request_key=str(n))
        first = self.outcomes.list(self.ws, limit=2)
        second = self.outcomes.list(self.ws, limit=2, before_id=first['next_before_id'])
        self.assertEqual(len(second['proposals']), 1); self.assertIsNone(second['next_before_id'])
        self.assertFalse({p['id'] for p in first['proposals']} & {p['id'] for p in second['proposals']})
        with self.assertRaises(RegistryError): self.outcomes.list(self.ws, before_id=2**53)
        with patch.object(outcomes, 'MAX_PENDING', 3), self.assertRaisesRegex(RegistryError, 'full'):
            self.propose(request_key='limit')
        with self.assertRaises(RegistryError): self.propose(statement='x'*(outcomes.MAX_STATEMENT_BYTES+1))
        self.cfg.set('api_key', 'private-fixture-secret-123', persist=False)
        with self.assertRaisesRegex(RegistryError, 'credentials'): self.propose(statement='Key private-fixture-secret-123')

    def test_provenance_cannot_change_statement_classification_or_content(self):
        accepted = self.accept(self.propose()); snapshot = self.hub.snapshot(self.ws)
        for key, value in [('verification', 'tests_passed'), ('classification', 'runner_receipt')]:
            bad = copy.deepcopy(snapshot); bad['entries'][0]['provenance']['proposal'][key] = value
            with self.assertRaises(RegistryError): validate_snapshot(bad)
        bad = copy.deepcopy(snapshot); bad['entries'][0]['content'] = 'Verified tests passed'
        with self.assertRaises(RegistryError): validate_snapshot(bad)
        bad = copy.deepcopy(snapshot)
        provenance = bad['entries'][0]['provenance']
        provenance['proposal']['workspace_id'] = 'ws_' + 'f'*32
        provenance['proposal_digest'] = outcomes._hash(provenance['proposal'])
        with self.assertRaisesRegex(RegistryError, 'another workspace'): validate_snapshot(bad)
        with self.assertRaises(RegistryError): self.hub.record(self.ws, 'session_outcome', 'Fake', 'Fake', 1, 'user')

    def test_schema_eleven_upgrade_preserves_existing_context_digest_and_rollback(self):
        from dgc.workspace_registry import SCHEMA_VERSION
        self.hub.record(self.ws, 'decision', 'Original', 'Keep exact old context.', 0, 'user')
        original = self.hub.snapshot(self.ws)
        from tests.pip_test_migrations import drop_archive_schema
        drop_archive_schema(self.registry.db)
        for table in ('pip_memories', 'pip_notifications', 'pip_notification_seen', 'pip_notification_state'):
            self.registry.db.execute('DROP TABLE '+table)
        self.registry.db.execute('DROP TABLE workspace_session_outcomes')
        self.registry.db.execute('PRAGMA user_version=11')
        directory = self.registry.directory; self.registry.close()
        self.registry.close = lambda: None
        execute = outcomes._execute_schema
        def fail(db, script):
            if script == outcomes.SCHEMA: raise sqlite3.OperationalError('fixture rollback')
            return execute(db, script)
        with patch.object(outcomes, '_execute_schema', fail), self.assertRaises(sqlite3.OperationalError):
            WorkspaceRegistry(directory)
        db = sqlite3.connect(directory / 'registry.sqlite3')
        self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 11); db.close()
        with WorkspaceRegistry(directory) as migrated:
            self.assertEqual(ContextStore(migrated).snapshot(self.ws), original)
            self.assertEqual(migrated.db.execute('PRAGMA user_version').fetchone()[0], SCHEMA_VERSION)


class StreamingSessionJSONTests(unittest.TestCase):
    def parser(self, raw):
        return outcomes._JSONStream(io.BytesIO(raw))

    def test_complete_stream_validates_skipped_content_and_hashes_exact_bytes(self):
        raw = json.dumps({'id': 'chat', 'project': '/fixture', 'revision': 4,
            'messages': [{'content': 'ignored' * 50000, 'emoji': '\U0001f600', 'raw': '\\"'}]}, ensure_ascii=True).encode()
        class Bounded(io.BytesIO):
            def read(self, count=-1):
                self_outer.assertGreater(count, 0); self_outer.assertLessEqual(count, 65536)
                return super().read(count)
        self_outer = self
        parser = outcomes._JSONStream(Bounded(raw)); result = parser.read()
        self.assertEqual(result, {'id': 'chat', 'project': '/fixture', 'revision': 4, 'messages': True})
        self.assertEqual(parser.bytes, len(raw)); self.assertEqual(parser.digest.hexdigest(), hashlib.sha256(raw).hexdigest())
        self.assertLessEqual(len(parser.buffer), 65536)

    def test_hostile_json_is_not_sampled_or_regex_extracted(self):
        invalid = [b'{"id":"one","id":"two"}', b'{"messages":[{"x":1,"x":2}]}',
            b'{"messages":[{"x":"bad\\q"}]}', b'{"messages":[{"x":"\\ud800"}]}',
            b'{"messages":[{"x":"\\udc00"}]}', b'{"messages":[{"x":"\xff"}]}',
            b'{"messages":[{"x":NaN}]}', b'{"messages":[{"x":01}]}', b'{"messages":[{"x":1,}]}',
            b'{"messages":[],}', b'{"messages":[]} trailing', b'{"messages":[{}]',
            b'{"messages":[1]}', b'{"revision":1e0}', b'{"messages":[{"x":"\x00"}]}']
        for raw in invalid:
            with self.subTest(raw=raw), self.assertRaises((RegistryError, UnicodeError)):
                self.parser(raw).read()

    def test_nesting_values_keys_and_input_bytes_have_independent_budgets(self):
        with patch.object(outcomes, 'MAX_DEPTH', 8), self.assertRaisesRegex(RegistryError, 'nesting'):
            self.parser(b'{"x":' + b'['*10 + b'0' + b']'*10 + b'}').read()
        with patch.object(outcomes, 'MAX_VALUES', 5), self.assertRaisesRegex(RegistryError, 'value budget'):
            self.parser(b'{"x":[1,2,3,4,5,6]}').read()
        with self.assertRaisesRegex(RegistryError, 'metadata'):
            self.parser(b'{"' + b'x'*1025 + b'":0}').read()
        with patch.object(outcomes, 'MAX_TRANSCRIPT_BYTES', 16), self.assertRaisesRegex(RegistryError, '8 MiB'):
            self.parser(b'{"long":"0123456789abcdef"}').read()


if __name__ == '__main__': unittest.main()
