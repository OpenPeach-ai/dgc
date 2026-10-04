"""A successful Patch/Pulse run must not break the Pip's next conversation."""
import json
import unittest

from dgc import pip_chat
from tests import test_pip_context_execution as fixtures


class ExecutionConversationReferenceTests(unittest.TestCase):
    setUp = fixtures.ExecutionReadTests.setUp
    git = fixtures.ExecutionReadTests.git
    commit = fixtures.ExecutionReadTests.commit
    setup_source = fixtures.ExecutionReadTests.setup_source
    propose = fixtures.ExecutionReadTests.propose
    accept = fixtures.ExecutionReadTests.accept
    completed = fixtures.ExecutionReadTests.completed

    def test_chat_after_execution_receives_actual_failed_command_not_audit_claim(self):
        finished = self.completed()
        value = pip_chat.send(self.store, self.target['id'], 'Explain the failed test.', 'after-test', 'device', self.cfg)
        raw = self.registry.db.execute('SELECT manifest FROM pip_runs WHERE id=?', (value['run']['id'],)).fetchone()[0]
        context = json.loads(raw)['conversation']
        reference = context['last_report']
        self.assertEqual(reference['classification'], 'historical_execution')
        self.assertEqual(reference['run_id'], finished['id'])
        self.assertEqual(reference['commands'][0]['exit_code'], 1)
        self.assertEqual(reference['commands'][0]['status'], 'failed')
        self.assertFalse(reference['changes']['applied_to_workspace'])
        self.assertNotIn('findings', reference)
        self.assertLessEqual(len(json.dumps(reference).encode()), 8192)
        pip_chat.validate_context(context)

    def test_long_exact_argv_is_omitted_with_digest_never_partially_named(self):
        self.completed(argv=['python3', '-c', 'x' * 700])
        reference = pip_chat._last_report(self.store, self.target['id'])
        command = reference['commands'][0]
        self.assertIsNone(command['argv'])
        self.assertTrue(command['argv_omitted'])
        self.assertEqual(len(command['argv_sha256']), 64)
        self.assertEqual(command['exit_code'], 1)
