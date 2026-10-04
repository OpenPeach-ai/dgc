"""Lifecycle authority and stale retry behavior through the actual controller."""
import copy
import json
import unittest
from unittest.mock import patch

from dgc import pips
from tests import test_pip_checkpoint_integration as fixtures


class ArchiveControlTests(unittest.TestCase):
    setUp = fixtures.CheckpointIntegrationTests.setUp
    git = fixtures.CheckpointIntegrationTests.git
    commit = fixtures.CheckpointIntegrationTests.commit
    create = fixtures.CheckpointIntegrationTests.create
    completed = fixtures.CheckpointIntegrationTests.completed
    control = fixtures.CheckpointIntegrationTests.control

    def request(self, pip, command='archive_pip', **overrides):
        return {'type': command, 'pip_id': pip['id'],
                'expected_version': pip['current_version'],
                'expected_lifecycle_revision': pip['lifecycle_revision'],
                'request_key': command + '-once', 'reason': 'Reviewed lifecycle decision',
                **overrides}

    def test_archive_restore_replay_and_evidence_preserve_config(self):
        original = copy.deepcopy(self.cfg.data), copy.deepcopy(self.cfg.permissions), self.cfg.project_root
        job = self.create(); run = self.completed(job, 'original-evidence')
        request = self.request(job)
        saved = self.control(request)
        self.assertTrue(saved['ok'], saved)
        archived = saved['result']['pip']
        self.assertEqual(archived['status'], 'archived')
        self.assertEqual(saved['result']['receipt']['actor'], 'review-device')
        restored = self.control(self.request(archived, 'restore_pip'))
        self.assertTrue(restored['ok'], restored)
        self.assertEqual(restored['result']['pip']['status'], 'paused')
        replay = self.control(request)
        self.assertTrue(replay['ok'], replay)
        self.assertTrue(replay['result']['replayed'])
        self.assertEqual(replay['result']['receipt'], saved['result']['receipt'])
        self.assertEqual(replay['result']['pip']['status'], 'paused')
        unpinned = self.control({'type': 'resume_pip', 'pip_id': job['id']})
        self.assertFalse(unpinned['ok'], unpinned)
        resumed = self.control({'type': 'resume_pip', 'pip_id': job['id'],
            'expected_lifecycle_revision': restored['result']['pip']['lifecycle_revision']})
        self.assertTrue(resumed['ok'], resumed)
        self.assertEqual(resumed['result']['pip']['status'], 'active')
        stale = self.control(self.request(job, request_key='stale-second-decision'))
        self.assertFalse(stale['ok'])
        report = self.control({'type': 'get_pip_run', 'run_id': run['id']})
        self.assertTrue(report['ok'], report)
        self.assertEqual(report['result']['run']['status'], 'succeeded')
        self.assertEqual((self.cfg.data, self.cfg.permissions, self.cfg.project_root), original)

    def test_archive_controls_do_not_resolve_or_register_launch_directory(self):
        job = self.create()
        with patch.object(type(self.registry), 'resolve', side_effect=AssertionError('No launch-root resolution')):
            result = self.control(self.request(job))
        self.assertTrue(result['ok'], result)

    def test_user_pause_and_resume_do_not_restore_archived_pip(self):
        job = self.create()
        self.assertTrue(self.control(self.request(job))['ok'])
        for command in ('pause_pip', 'resume_pip', 'run_pip', 'send_pip_message'):
            request = {'type': command, 'pip_id': job['id']}
            if command in ('run_pip', 'send_pip_message'): request['idempotency_key'] = 'bypass'
            if command == 'send_pip_message': request['text'] = 'Please inspect'
            result = self.control(request)
            self.assertFalse(result['ok'], result)
        self.assertEqual(self.control({'type': 'get_pip', 'pip_id': job['id']})['result']['pip']['status'], 'archived')

    def test_scope_actor_and_resume_flags_cannot_be_forged(self):
        job = self.create()
        for key, value in (('actor', 'forged'), ('workspace_id', 'ws_foreign'),
                           ('archived', False), ('resume', True), ('project_root', '/tmp'),
                           ('permissions', {'allow': ['Bash']})):
            result = self.control({**self.request(job), key: value})
            self.assertFalse(result['ok'], result)
            self.assertEqual(result['error']['code'], 'invalid_request')
        current = self.control({'type': 'get_pip', 'pip_id': job['id']})['result']['pip']
        self.assertEqual(current['status'], job['status'])
        self.assertEqual(current['lifecycle_revision'], job['lifecycle_revision'])

    def test_disabled_restricted_and_sandboxed_calls_refuse_before_storage(self):
        job = self.create()
        for command in ('archive_pip', 'restore_pip'):
            for restriction in ('dgc.permissions.session_policy', 'dgc.sandbox.requested'):
                with patch(restriction, return_value=object()), \
                        patch.object(pips, 'WorkspaceRegistry', side_effect=AssertionError('No restricted storage')):
                    result = self.control(self.request(job, command))
                self.assertFalse(result['ok'])
                self.assertEqual(result['error']['code'], 'session_policy')
        self.cfg.data['pips_enabled'] = False
        with patch.object(pips, 'WorkspaceRegistry', side_effect=AssertionError('No disabled storage')):
            result = self.control(self.request(job))
        self.assertFalse(result['ok']); self.assertEqual(result['error']['code'], 'disabled')

    def test_bad_pins_and_configured_secret_do_not_transition(self):
        job = self.create()
        for malformed in (None, True, '0'):
            result = self.control({'type': 'resume_pip', 'pip_id': job['id'],
                                   'expected_lifecycle_revision': malformed})
            self.assertFalse(result['ok'], result)
        for changes in ({'expected_version': True}, {'expected_lifecycle_revision': None},
                        {'request_key': None}, {'reason': 'x' * 1001}):
            result = self.control(self.request(job, **changes))
            self.assertFalse(result['ok'], result)
        secret = 'fixture-secret-lifecycle-never-store'
        self.cfg.set('api_key', secret, persist=False)
        result = self.control(self.request(job, reason='Archive ' + secret))
        self.assertFalse(result['ok']); self.assertEqual(result['error']['code'], 'invalid_archive')
        self.assertNotIn(secret, json.dumps(result))
        self.assertFalse(any(secret in row for row in self.registry.db.iterdump()))
        current = self.control({'type': 'get_pip', 'pip_id': job['id']})['result']['pip']
        self.assertEqual(current['status'], job['status'])
        self.assertEqual(current['lifecycle_revision'], job['lifecycle_revision'])


if __name__ == '__main__': unittest.main()
