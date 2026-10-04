"""Offline Pulse console reviews, bounded inputs and exact manual authority."""
import copy
import json
import os
import unittest
from unittest.mock import patch

from dgc import pip_cli, pips, pip_pulse_plans as plans
from dgc.workspace_registry import RegistryError
from tests import test_pip_cli as fixtures


class PulseCliTests(unittest.TestCase):
    setUp = fixtures.PipCliTests.setUp
    invoke = fixtures.PipCliTests.invoke
    value = fixtures.PipCliTests.value
    git = fixtures.PipCliTests.git
    commit = fixtures.PipCliTests.commit
    heartbeat = fixtures.PipCliTests.heartbeat
    hold_supervisor = fixtures.PipCliTests.hold_supervisor

    def request(self, *argv):
        return pip_cli._request(pip_cli.parser().parse_args(argv))

    def plan(self):
        return plans.validate_plan({'schema_version': 1, 'action': {'kind': 'test',
            'tests': [{'argv': ['/usr/bin/python3', '-c', 'print("fixture")'], 'cwd': '.'}]}})

    def create(self):
        return self.value('create', 'Verifier', '--type', 'pulse', '--goal', 'Check reviewed commands',
                          '--reviewed-execution')['pip']

    def test_real_proposal_separate_review_and_pinned_run(self):
        from dgc.pip_execution import capability
        if not capability()['available']:
            self.skipTest('Actual confined Pulse enqueue requires available Linux/bubblewrap support')
        self.commit(); self.hold_supervisor(); job = self.create()
        with patch.object(pips, 'start_queued', side_effect=AssertionError('No transient worker')):
            proposal = self.value('verification-plan', job['id'], '--expected-version', '1',
                                  '--plan-json', json.dumps(self.plan()))['proposal']
            unchanged = self.value('show', job['id'])['pip']
            self.assertIsNone(unchanged['verification_plan'])
            self.assertEqual(self.store.runs(job['id']), [])
            self.assertEqual(proposal['status'], 'proposed')
            accepted = self.value('accept', job['id'], proposal['id'], '--expected-version', '1')['pip']
            self.assertEqual(accepted['verification_plan'], self.plan())
            args = ('run', job['id'], '--expected-version', '2', '--expected-lifecycle-revision', '0',
                    '--expected-plan-digest', accepted['verification_plan_digest'], '--idempotency-key', 'cli-reviewed')
            with patch.object(pips, '_model_settings', side_effect=AssertionError('No model resolution')):
                run = self.value(*args)['run']
                retry = self.value(*args)['run']
            self.assertEqual(run['id'], retry['id'])
            self.assertIsNone(run['manifest']['model'])
            self.assertEqual(run['manifest']['job']['verification_plan'], self.plan())
            self.assertEqual(len(self.store.runs(job['id'])), 1)

    def test_removal_proposes_both_plan_and_calendar_without_accepting(self):
        job = self.create()
        proposal = self.store.propose(job['id'], 1, {'verification_plan': self.plan(),
            'schedule': {'type': 'interval', 'minutes': 5}}, 'local-console')
        self.store.accept(job['id'], proposal['id'], 1, 'local-console')
        args = ('verification-plan', job['id'], '--expected-version', '2', '--remove')
        self.assertEqual(self.request(*args)['changes'], {'verification_plan': None, 'schedule': None})
        removed = self.value(*args)['proposal']
        self.assertIsNotNone(self.value('show', job['id'])['pip']['verification_plan'])
        final = self.value('accept', job['id'], removed['id'], '--expected-version', '2')['pip']
        self.assertIsNone(final['verification_plan']); self.assertIsNone(final['schedule'])
        self.assertEqual(self.store.runs(job['id']), [])

    def test_explicit_pins_forwarded_without_lookup_legacy_requests_unchanged(self):
        with patch.object(pips.PipStore, 'get', side_effect=AssertionError('No hidden lookup')):
            legacy = self.request('run', 'pip_fixture', '--idempotency-key', 'old')
            request = self.request('run', 'pip_fixture', '--expected-version', '9',
                '--expected-lifecycle-revision', '4', '--expected-plan-digest', 'a' * 64, '--idempotency-key', 'exact')
        self.assertEqual(set(legacy), {'type', 'request_id', 'pip_id', 'idempotency_key'})
        self.assertEqual(request['expected_version'], 9)
        self.assertEqual(request['expected_lifecycle_revision'], 4)
        self.assertEqual(request['expected_plan_digest'], 'a' * 64)
        for flags in (('--expected-version', '2'), ('--expected-plan-digest', 'a' * 64),
                      ('--expected-version', '2', '--expected-lifecycle-revision', '0')):
            with self.subTest(flags=flags), self.assertRaises(RegistryError) as caught:
                self.request('run', 'pip_fixture', *flags)
            self.assertEqual(caught.exception.code, 'invalid_request')

    def test_bounded_utf8_json_and_hostile_paths_before_open(self):
        prefix = ('verification-plan', 'pip_fixture', '--expected-version', '1')
        path = self.base / 'plan.json'; path.write_text(json.dumps(self.plan()), encoding='utf-8')
        self.assertEqual(self.request(*prefix, '--plan-file', str(path))['changes']['verification_plan'], self.plan())
        oversized = self.base / 'large.json'; oversized.write_bytes(b' ' * (plans.MAX_PLAN_BYTES + 1))
        link = self.base / 'link.json'; link.symlink_to(path)
        pipe = self.base / 'pipe'; os.mkfifo(pipe)
        for source in (oversized, link, pipe, self.base):
            with self.subTest(source=source), patch.object(pip_cli.os, 'open', side_effect=AssertionError('Must refuse before opening')), self.assertRaises(RegistryError):
                self.request(*prefix, '--plan-file', str(source))
        for body in ('"' + 'é' * plans.MAX_PLAN_BYTES + '"', ' ' * (plans.MAX_PLAN_BYTES + 1),
                     '{"schema_version":1,"schema_version":1}', '{"a":NaN}', 'null', '[]', '\ud800'):
            with self.subTest(body=body[:30]), self.assertRaises(RegistryError):
                self.request(*prefix, '--plan-json', body)
        path.write_bytes(b'\xff')
        with self.assertRaises(RegistryError): self.request(*prefix, '--plan-file', str(path))

    def test_plan_cannot_expand_permission_or_infer_shell(self):
        prefix = ('verification-plan', 'pip_fixture', '--expected-version', '1', '--plan-json')
        for change in ({'network': True}, {'kind': 'patch'}, {'tests': ['pytest -q']}, {'write_paths': ['.']}):
            value = self.plan(); value['action'].update(change)
            with self.subTest(change=change), self.assertRaises(RegistryError):
                self.request(*prefix, json.dumps(value))
        value = self.plan(); value['action']['tests'][0]['argv'][-1] = 'literal; $(never execute)'
        self.assertEqual(self.request(*prefix, json.dumps(value))['changes']['verification_plan'], value)

    def test_cli_report_separates_unexecuted_unknown_and_recorded_outcomes(self):
        manifest = {'job_version': 2, 'model': None, 'source_revision': '1' * 40,
            'source_policy': {'mode': 'committed_only'}, 'source_snapshot': None, 'run_kind': 'test',
            'pulse_verification': {'plan_digest': 'a' * 64},
            'job': {'verification_plan': self.plan()}}
        base = {'id': 'run_fixture', 'pip_id': 'pip_fixture', 'status': 'failed', 'manifest': manifest}
        for state, phrase in [('not_started', 'not started'), ('launch_reserved', 'outcome unknown')]:
            value = {'classification': 'reviewed_command_outcomes', 'terminal_reason': 'interrupted',
                     'commands': [{'index': 0, 'launch_state': state, 'outcome': None}]}
            rendered = pip_cli._format({'run': {**base, 'result': value}})
            self.assertIn(phrase, rendered); self.assertIn('no model was invoked', rendered)
            self.assertNotIn('Pinned handoff', rendered)
        value = copy.deepcopy(value)
        value['commands'][0].update(launch_state='finished', outcome={'status': 'failed', 'exit_code': 7,
            'output': '\x1b[31m untrusted', 'output_truncated': False})
        rendered = pip_cli._format({'run': {**base, 'result': value}})
        self.assertIn('exit code: 7', rendered); self.assertIn('\\u001b', rendered)
        self.assertNotIn('\x1b', rendered)
        self.assertIn('No command receipt recorded yet', pip_cli._format({'run': {**base, 'result': None}}))


if __name__ == '__main__':
    unittest.main()
