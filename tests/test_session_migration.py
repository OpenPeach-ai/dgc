"""Deterministic reviewed workspace moves; no model/network/sleep dependency."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from dgc import sessions, session_migration as moves
from dgc.checkpoints import CheckpointManager
from dgc.workspace_registry import RegistryError
from tests import test_workspace_sessions as fixtures


class SessionMigrationTests(unittest.TestCase):
    setUp = fixtures.WorkspaceSessionTests.setUp
    registry = fixtures.WorkspaceSessionTests.registry
    record = fixtures.WorkspaceSessionTests.record
    agent = fixtures.WorkspaceSessionTests.agent

    def prepared(self, *, full=False):
        self.old = self.root
        self.registry_ = self.registry()
        self.workspace = self.registry_.resolve(self.old)
        self.path = self.record()
        self.sid = self.path.stem
        self.registry_.associate_session(self.sid, self.old)
        if full:
            (self.old / 'source.py').write_text('before\n')
            messages = [{'role': 'user', 'content': 'Keep the complete history'},
                        {'role': 'assistant', 'content': 'Recorded'}]
            manager = CheckpointManager(self.old)
            manager.open(1, 'First turn', messages=messages[:1])
            self.assertTrue(manager.record_file(str(self.old / 'source.py')))
            (self.old / 'source.py').write_text('after\n')
            manager.note_written(str(self.old / 'source.py'))
            self.assertTrue(sessions.save(self.path, messages, self.old, name='Moved project',
                goal='Keep intended scope', usage={'requests': 3},
                checkpoints=manager.state(), todos=[{'content': 'Next step', 'status': 'pending'}],
                subscription_sessions={'codex': {'id': 'vendor-session', 'mode': 'auto', 'model': 'model', 'effort': ''}}))
            self.assertTrue(sessions.save_plan(self.path, '# Existing plan\n', self.old))
            self.assertTrue(sessions.save_recall(self.path, self.old, [{'who': 'user', 'body': 'Earlier conversation'}])['saved'])
            self.assertTrue(sessions.save_workspace(self.path, self.old, kind='manual', worktree=self.old, branch='main'))
            images = self.path.with_suffix('.images')
            images.mkdir()
            (images / ('1' * 32 + '.png')).write_bytes(b'private retained image bytes')
        self.before = json.loads(self.path.read_text())
        self.revision = self.before['revision']
        self.new = self.base / 'moved-project'
        self.old.rename(self.new)
        self.registry_.rebind(self.workspace['id'], self.new, expected_root=self.old)
        self.cfg = self.cfg.clone_for_root(self.new)
        self.destination = sessions.SESSIONS_DIR / sessions._slug(self.new)
        self.archive = self.path.parent / '.session-migrations' / self.sid
        return self.path

    def migrate(self, **changes):
        args = {'workspace_id': self.workspace['id'], 'source_root': self.old,
                'expected_revision': self.revision, 'dry_run': True, 'registry': self.registry_}
        args.update(changes)
        return sessions.migrate_workspace_session(self.cfg, self.sid, **args)

    def test_preview_is_read_only_and_binding_and_session_identity_unchanged(self):
        self.prepared(full=True)
        before = {str(p): p.read_bytes() for p in sessions.SESSIONS_DIR.rglob('*') if p.is_file()}
        events = self.registry_.db.execute('SELECT count(*) FROM workspace_events').fetchone()[0]
        with patch.object(moves, 'named_process_lock', side_effect=AssertionError('preview must not create locks')):
            result = self.migrate()
        after = {str(p): p.read_bytes() for p in sessions.SESSIONS_DIR.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        self.assertEqual(result['status'], 'ready')
        self.assertFalse(self.destination.exists())
        self.assertFalse(self.archive.exists())
        self.assertEqual(result['source_revision'], self.revision)
        self.assertEqual(result['destination_revision'], self.revision + 1)
        self.assertEqual(len(result['warnings']), 2)
        self.assertEqual(events, self.registry_.db.execute('SELECT count(*) FROM workspace_events').fetchone()[0])

    def test_preview_discovers_revision_but_apply_requires_it(self):
        self.prepared()
        result = self.migrate(expected_revision=None)
        self.assertEqual(result['source_revision'], self.revision)
        with self.assertRaises(RegistryError) as raised:
            self.migrate(expected_revision=None, dry_run=False)
        self.assertEqual(raised.exception.code, 'invalid_request')
        self.assertFalse(self.archive.exists())

    def test_apply_preserves_history_sidecars_identity_and_relative_recovery_points(self):
        self.prepared(full=True)
        original = self.path.read_bytes()
        identity = self.registry_.session_identity(self.sid)
        result = self.migrate(dry_run=False)
        target = Path(result['session_path'])
        record = sessions.load_record(target, self.new)
        self.assertEqual(result['status'], 'migrated')
        self.assertEqual(record['messages'], self.before['messages'])
        self.assertEqual((record['id'], record['goal'], record['todos']), (self.sid, self.before['goal'], self.before['todos']))
        self.assertEqual(record['revision'], self.revision + 1)
        self.assertEqual({key: record[key] for key in identity}, identity)
        self.assertEqual(self.registry_.session_identity(self.sid), identity)
        self.assertEqual(record['checkpoints']['project'], str(self.new))
        self.assertEqual(record['checkpoints']['points'], self.before['checkpoints']['points'])
        self.assertEqual(len(CheckpointManager.from_state(record['checkpoints'], self.new).points), 1)
        self.assertEqual(sessions.usage_of(target, self.new)['requests'], 3)
        self.assertEqual(sessions.load_plan(target, self.new), '# Existing plan')
        self.assertEqual(sessions.load_recall(target, self.new)[0]['body'], 'Earlier conversation')
        self.assertEqual((target.with_suffix('.images') / ('1' * 32 + '.png')).read_bytes(), b'private retained image bytes')
        self.assertNotIn('subscription_sessions', record)
        self.assertIsNone(sessions.load_workspace(target, self.new))
        self.assertEqual((self.archive / 'original' / self.path.name).read_bytes(), original)
        self.assertTrue((self.archive / 'original' / (self.sid + '.workspace')).exists())
        self.assertFalse(self.path.exists())
        self.assertEqual(sessions.by_id(self.new, self.sid), target)
        self.assertEqual(sessions.latest(self.new), target)
        self.assertEqual(sessions.find_global(self.sid), (target, self.new))

    def test_ordinary_agent_resume_and_next_save_keep_same_identity(self):
        self.prepared()
        result = self.migrate(dry_run=False)
        agent, notes = self.agent()
        self.assertEqual(agent.load_session(result['session_path']), 1)
        self.assertEqual(agent.workspace_identity, self.registry_.session_identity(self.sid))
        agent.messages.append({'role':'user', 'content':'Continue here'})
        self.assertTrue(agent._persist())
        self.assertEqual(sessions.load_record(agent.session_file, self.new)['revision'], self.revision + 2)
        self.assertEqual(self.migrate(dry_run=False)['status'], 'already_migrated')
        self.assertEqual(notes, [])

    def test_retirement_blocks_legacy_writers_and_archived_path_resume(self):
        self.prepared()
        self.migrate(dry_run=False)
        self.old.mkdir()  # another project later occupies the previous directory
        self.assertFalse(sessions.save(self.path, [{'role':'user','content':'stale'}], self.old))
        self.assertFalse(sessions.save_plan(self.path, 'stale', self.old))
        with self.assertRaisesRegex(ValueError, 'moved'):
            sessions.load_record(self.archive / 'original' / self.path.name, self.old)
        self.assertFalse(self.path.exists())
        self.assertEqual(sessions.listing(self.old), [])

    def test_disabled_is_exact_true_and_does_not_access_storage(self):
        for enabled in (False, 1, 'true', None):
            self.cfg.data['pips_enabled'] = enabled
            with patch.object(moves, '_backfill_registry', side_effect=AssertionError('no storage')), self.assertRaises(RegistryError) as raised:
                sessions.migrate_workspace_session(self.cfg, 'sid', workspace_id='ws_' + '0'*32, source_root='/absent', expected_revision=0)
            self.assertEqual(raised.exception.code, 'disabled')

    def test_unknown_or_other_workspace_association_is_not_imported_from_metadata(self):
        self.prepared()
        self.registry_.db.execute('DELETE FROM session_workspaces WHERE session_id=?', (self.sid,))
        data = copy.deepcopy(self.before)
        data.update(workspace_id=self.workspace['id'], workspace_binding_id=self.workspace['binding_id'], runner_id=self.registry_.runner_id)
        self.path.write_text(json.dumps(data))
        with self.assertRaises(RegistryError) as raised:
            self.migrate(dry_run=False)
        self.assertEqual(raised.exception.code, 'workspace_mismatch')
        self.assertFalse(self.archive.exists())

    def test_stale_rebind_and_replaced_old_directory_refuse(self):
        self.prepared()
        self.old.mkdir()
        with self.assertRaisesRegex(RegistryError, 'replaced'):
            self.migrate()
        self.old.rmdir()
        newer = self.base / 'moved-again'
        self.new.rename(newer)
        self.registry_.rebind(self.workspace['id'], newer, expected_root=self.new)
        self.new.mkdir()
        with self.assertRaisesRegex(RegistryError, 'binding'):
            self.migrate()

    def test_old_root_symlink_and_alias_traversal_refuse(self):
        self.prepared()
        self.old.symlink_to(self.new, target_is_directory=True)
        with self.assertRaises(RegistryError):
            self.migrate()
        self.old.unlink()
        for root in ('relative', str(self.base)+'/unused/../project', self.base / 'missing' / '..' / 'project'):
            with self.subTest(root=root), self.assertRaises(RegistryError):
                self.migrate(source_root=root)

    def test_invalid_ids_revision_and_boolean_flags_refuse_before_io(self):
        self.prepared()
        for value in ('../session', '/tmp/session', 'session.json', 'a/b', 'a\\b', 'x\x00', '\ud800'):
            with self.subTest(sid=repr(value)), self.assertRaises(RegistryError):
                sessions.migrate_workspace_session(self.cfg, value, workspace_id=self.workspace['id'], source_root=self.old, expected_revision=1)
        for key, value in [('expected_revision', True), ('expected_revision', -1), ('expected_revision', 1.5), ('dry_run', 1)]:
            with self.subTest(key=key, value=value), self.assertRaises(RegistryError):
                self.migrate(**{key:value})

    def test_corrupt_truncated_project_id_revision_and_message_records_refuse(self):
        self.prepared()
        for data in (b'{', b'[]', json.dumps({**self.before,'project':str(self.new)}).encode(),
                     json.dumps({**self.before,'id':'other'}).encode(),
                     json.dumps({**self.before,'revision':True}).encode(),
                     json.dumps({**self.before,'messages':[1]}).encode()):
            self.path.write_bytes(data)
            with self.subTest(data=data[:20]), self.assertRaises(RegistryError):
                self.migrate(dry_run=False)
            self.assertFalse(self.archive.exists())

    def test_source_revision_cas_preserves_everything(self):
        self.prepared()
        with self.assertRaises(RegistryError) as raised:
            self.migrate(dry_run=False, expected_revision=self.revision + 1)
        self.assertEqual(raised.exception.code, 'conflict')
        self.assertTrue(self.path.exists())
        self.assertFalse(self.destination.exists())

    def test_destination_transcript_and_sidecar_collisions_never_overwrite(self):
        self.prepared(full=True)
        self.destination.mkdir()
        for suffix in ('.json', '.plan.md', '.workspace'):
            existing = self.destination / (self.sid + suffix)
            existing.write_text('unrelated destination')
            with self.subTest(suffix=suffix), self.assertRaisesRegex(RegistryError, 'already exists'):
                self.migrate(dry_run=False)
            self.assertEqual(existing.read_text(), 'unrelated destination')
            existing.unlink()
            self.assertFalse(self.archive.exists())

    def test_orphan_destination_worktree_metrics_and_images_are_never_adopted(self):
        self.prepared()
        self.destination.mkdir()
        for suffix in ('.workspace', '.metrics', '.images'):
            existing = self.destination / (self.sid + suffix)
            if suffix == '.images': existing.mkdir()
            else: existing.write_text('unrelated saved authority or counts')
            with self.subTest(suffix=suffix), self.assertRaises(RegistryError) as raised:
                self.migrate(dry_run=False)
            self.assertEqual(raised.exception.code, 'destination_exists')
            if suffix == '.images': existing.rmdir()
            else: existing.unlink()
        self.assertFalse(self.archive.exists())

    def test_return_to_retired_bucket_is_refused_explicitly(self):
        self.prepared()
        self.destination.mkdir()
        retired = self.destination / '.session-migrations' / self.sid
        retired.mkdir(parents=True)
        (retired / 'retired').write_text('')
        with self.assertRaises(RegistryError) as raised:
            self.migrate()
        self.assertEqual(raised.exception.code, 'retired_destination')

    def test_migrated_checkpoints_do_not_follow_replaced_parent_symlink(self):
        self.prepared()
        inner = self.new / 'inner'
        inner.mkdir()
        tracked = inner / 'source.py'
        tracked.write_text('before\n')
        manager = CheckpointManager(self.new)
        manager.open(1, 'Earlier edit', messages=self.before['messages'])
        manager.record_file(str(tracked))
        tracked.write_text('after\n')
        manager.note_written(str(tracked))
        checkpoints = manager.state()
        checkpoints['project'] = str(self.old)
        record = {**self.before, 'checkpoints': checkpoints}
        self.path.write_text(json.dumps(record))
        outside = self.base / 'external'
        inner.rename(outside)
        inner.symlink_to(outside, target_is_directory=True)
        result = self.migrate(dry_run=False)
        loaded = sessions.load_record(result['session_path'], self.new)
        resumed = CheckpointManager.from_state(loaded['checkpoints'], self.new)
        self.assertEqual(resumed.rewind(0), (-1, 0))
        self.assertEqual((outside / 'source.py').read_text(), 'after\n')

    def test_current_known_credentials_are_redacted_in_migrated_copy_only(self):
        self.prepared()
        key = 'test-private-token-that-must-stay-private'
        self.cfg.set('api_key', key, persist=False)
        self.path.write_text(json.dumps({**self.before, 'messages':[{'role':'user','content':'Credential ' + key}]}))
        result = self.migrate(dry_run=False)
        self.assertNotIn(key, Path(result['session_path']).read_text())
        self.assertIn(key, (self.archive / 'original' / self.path.name).read_text())

    def test_source_file_hardlink_symlink_fifo_and_oversize_refuse_before_read(self):
        self.prepared()
        raw = self.path.read_bytes()
        other = self.base / 'other-private-file'
        other.write_bytes(raw)
        self.path.unlink()
        for kind in ('symlink', 'hardlink', 'fifo', 'oversize'):
            if kind == 'symlink': self.path.symlink_to(other)
            elif kind == 'hardlink': os.link(other, self.path)
            elif kind == 'fifo': os.mkfifo(self.path)
            else:
                with self.path.open('wb') as stream: stream.truncate(moves.MAX_TRANSCRIPT_BYTES + 1)
            with self.subTest(kind=kind), patch.object(moves, '_json', side_effect=AssertionError('must refuse before parse')), self.assertRaises(RegistryError):
                self.migrate()
            self.path.unlink()

    def test_symlink_bucket_or_image_directory_refuses(self):
        self.prepared()
        images = self.path.with_suffix('.images')
        images.symlink_to(self.base, target_is_directory=True)
        with self.assertRaises(RegistryError):
            self.migrate()
        images.unlink()
        self.destination.symlink_to(self.path.parent, target_is_directory=True)
        with self.assertRaises(RegistryError):
            self.migrate()

    def test_legacy_slug_collision_is_explicit_not_a_merge(self):
        self.prepared()
        with patch.object(sessions, '_slug', return_value=self.path.parent.name), self.assertRaises(RegistryError) as raised:
            self.migrate()
        self.assertEqual(raised.exception.code, 'bucket_collision')

    def test_active_turn_lease_refuses_without_partial_migration(self):
        self.prepared()
        class Busy:
            def acquire(self, **kwargs): return False
            def release(self): raise AssertionError('not acquired')
        with patch.object(moves, 'named_process_lock', return_value=Busy()), self.assertRaises(RegistryError) as raised:
            self.migrate(dry_run=False)
        self.assertEqual(raised.exception.code, 'busy')
        self.assertFalse(self.archive.exists())

    def test_checkpoint_traversal_or_other_project_does_not_gain_rewind_authority(self):
        self.prepared(full=True)
        for change in ('project', 'traversal'):
            value = copy.deepcopy(self.before)
            if change == 'project': value['checkpoints']['project'] = '/other'
            else:
                files = value['checkpoints']['points'][0]['files']
                files['../outside'] = files.pop('source.py')
            self.path.write_text(json.dumps(value))
            with self.subTest(change=change), self.assertRaises(RegistryError) as raised:
                self.migrate(dry_run=False)
            self.assertEqual(raised.exception.code, 'invalid_checkpoint')
            self.assertFalse(self.archive.exists())

    def test_incompatible_sidecar_identity_refuses_entire_family(self):
        self.prepared(full=True)
        metrics = self.path.with_suffix('.metrics')
        data = json.loads(metrics.read_text())
        data['id'] = 'other-session'
        metrics.write_text(json.dumps(data))
        with self.assertRaises(RegistryError):
            self.migrate(dry_run=False)
        self.assertTrue(self.path.exists())
        self.assertFalse(self.archive.exists())

    def test_interrupted_retirement_recovers_without_duplicate_or_overwrite(self):
        self.prepared(full=True)
        original = moves.os.rename
        failed = False
        def interrupt(source, target):
            nonlocal failed
            if not failed and '/original/' in str(target):
                failed = True
                original(source, target)
                raise OSError('fixture interruption after one atomic retirement')
            return original(source, target)
        with patch.object(moves.os, 'rename', side_effect=interrupt), self.assertRaises(RegistryError):
            self.migrate(dry_run=False)
        self.assertTrue((self.archive / 'retired').exists())
        self.assertFalse((self.destination / self.path.name).exists())
        self.assertEqual(self.migrate()['status'], 'interrupted')
        result = self.migrate(dry_run=False)
        self.assertEqual(result['status'], 'migrated')
        self.assertEqual(sessions.load_record(result['session_path'], self.new)['messages'], self.before['messages'])

    def test_interrupted_publication_recovers_and_transcript_is_published_last(self):
        self.prepared(full=True)
        original = moves.os.rename
        failed = False
        def interrupt(source, target):
            nonlocal failed
            if not failed and str(target).startswith(str(self.destination)):
                self.assertNotEqual(Path(target).suffix, '.json')
                failed = True
                original(source, target)
                raise OSError('fixture interruption during sidecar publication')
            return original(source, target)
        with patch.object(moves.os, 'rename', side_effect=interrupt), self.assertRaises(RegistryError):
            self.migrate(dry_run=False)
        self.assertFalse((self.destination / self.path.name).exists())
        self.assertEqual(self.migrate(dry_run=False)['status'], 'migrated')

    def test_tampered_interrupted_journal_does_not_follow_paths(self):
        self.prepared()
        with patch.object(moves, '_transform', wraps=moves._transform) as transform:
            original = moves._write
            def interrupt(path, raw):
                if path.name == 'retired': raise OSError('fixture before retirement')
                return original(path, raw)
            with patch.object(moves, '_write', side_effect=interrupt), self.assertRaises(RegistryError):
                self.migrate(dry_run=False)
        journal = self.archive / 'journal.json'
        value = json.loads(journal.read_text())
        value['files']['../outside'] = value['files'].pop(self.path.name)
        journal.write_text(json.dumps(value))
        with self.assertRaises(RegistryError) as raised:
            self.migrate(dry_run=False)
        self.assertEqual(raised.exception.code, 'invalid_journal')
        self.assertTrue(self.path.exists())

    def test_unknown_temporary_or_oversized_directory_requires_review(self):
        self.prepared()
        extra = self.path.parent / ('.' + self.path.name + '.tmp')
        extra.write_text('unfinished')
        with self.assertRaises(RegistryError) as raised:
            self.migrate()
        self.assertEqual(raised.exception.code, 'unsupported_member')
        extra.unlink()
        with patch.object(moves, 'MAX_DIRECTORY_ENTRIES', 0), self.assertRaises(RegistryError) as raised:
            self.migrate()
        self.assertEqual(raised.exception.code, 'migration_limit')


if __name__ == '__main__':
    unittest.main()
