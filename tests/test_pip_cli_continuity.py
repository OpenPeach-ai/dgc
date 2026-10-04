"""Actual local CLI relocation and artifact proposals with offline fixtures."""
import contextlib
import io
import json
import unittest
from unittest.mock import patch

from dgc import pip_cli, pips, sessions
from dgc.workspace_registry import WorkspaceRegistry
from tests import test_session_migration as moves
from tests import test_pip_artifact_handoffs as artifacts


class ConsoleMixin:
    def invoke(self, *args, expected=0):
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            result = pip_cli.handle_command(self.cfg, list(args))
        self.assertEqual(result, expected, out.getvalue() + err.getvalue())
        return out.getvalue(), err.getvalue()


class SessionMoveCliTests(ConsoleMixin, unittest.TestCase):
    setUp = moves.SessionMigrationTests.setUp
    registry = moves.SessionMigrationTests.registry
    record = moves.SessionMigrationTests.record
    prepared = moves.SessionMigrationTests.prepared

    def test_preview_apply_and_normal_resume_from_new_root(self):
        self.prepared(full=True)
        args = ('workspace','migrate-session', self.workspace['id'], self.sid,
                '--source-root',str(self.old),'--expected-revision',str(self.revision))
        before = self.path.read_bytes()
        discovered, _ = self.invoke('workspace','migrate-session',self.workspace['id'],self.sid,
                                    '--source-root',str(self.old),'--json')
        self.assertEqual(json.loads(discovered)['migration']['source_revision'],self.revision)
        self.invoke('workspace','migrate-session',self.workspace['id'],self.sid,
                    '--source-root',str(self.old),'--apply',expected=1)
        output, _ = self.invoke(*args)
        self.assertIn('Nothing has moved yet', output)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(self.destination.exists())
        output, _ = self.invoke(*args, '--apply', '--json')
        result = json.loads(output)['migration']
        self.assertEqual(result['status'], 'migrated')
        target = sessions.by_id(self.new, self.sid)
        self.assertEqual(sessions.load_record(target, self.new)['messages'], self.before['messages'])
        output, _ = self.invoke(*args, '--apply')
        self.assertIn('already_migrated', output)
        self.assertIn('dgc --resume '+self.sid, output)

    def test_stale_revision_does_not_retire_transcript(self):
        self.prepared()
        _, err = self.invoke('workspace','migrate-session', self.workspace['id'], self.sid,
                             '--source-root',str(self.old),'--expected-revision',str(self.revision+1),
                             '--apply','--json',expected=1)
        self.assertIn('revision', json.loads(err)['error']['message'])
        self.assertTrue(self.path.exists())
        self.assertFalse(self.destination.exists())


class ArtifactCliTests(ConsoleMixin, unittest.TestCase):
    setUp = artifacts.ArtifactHandoffTests.setUp
    git = artifacts.ArtifactHandoffTests.git
    commit = artifacts.ArtifactHandoffTests.commit
    setup_source = artifacts.ArtifactHandoffTests.setup_source
    propose = artifacts.ArtifactHandoffTests.propose
    accept = artifacts.ArtifactHandoffTests.accept
    raw_manifest = artifacts.ArtifactHandoffTests.raw_manifest
    completed_patch = artifacts.ArtifactHandoffTests.completed_patch

    def test_console_proposal_pins_saved_artifact_and_does_not_queue_work(self):
        self.completed_patch()
        args = ('handoff','propose-artifact', self.patch_run['id'], self.pulse['id'],
                '--task','Test this exact accepted input','--action-json',json.dumps(self.test_action),
                '--idempotency-key','cli-artifact-input','--json')
        with patch.object(pips,'WorkspaceRegistry',lambda:WorkspaceRegistry(self.registry.directory,clock=lambda:self.now)), \
             patch.object(pips,'start_queued',side_effect=AssertionError('No transient worker')):
            output, _ = self.invoke(*args)
            retry, _ = self.invoke(*args)
        saved = json.loads(output)['handoff']
        self.assertEqual(saved['id'],json.loads(retry)['handoff']['id'])
        self.assertEqual(saved['payload']['type'],'patch_artifact.v1')
        self.assertEqual(saved['payload']['source']['review_status'],'accepted')
        self.assertEqual(saved['payload']['source']['artifact'],self.patch_run['result']['execution']['changes']['artifact'])
        self.assertEqual(self.store.runs(self.pulse['id']),[])

    def test_console_refuses_unaccepted_patch_without_dispatch(self):
        self.completed_patch(accept=False)
        with patch.object(pips,'WorkspaceRegistry',lambda:WorkspaceRegistry(self.registry.directory,clock=lambda:self.now)):
            _, err = self.invoke('handoff','propose-artifact',self.patch_run['id'],self.pulse['id'],
                                 '--task','Test input','--action-json',json.dumps(self.test_action),'--json',expected=1)
        self.assertIn('accepted',json.loads(err)['error']['message'])
        self.assertEqual(self.store.runs(self.pulse['id']),[])
