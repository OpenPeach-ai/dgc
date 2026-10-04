"""Human machine controls explicitly select a registered session workspace."""
import copy
import unittest
from unittest.mock import patch

from dgc import pips, workspace_session_outcomes as outcomes
from dgc.workspace_registry import WorkspaceRegistry
from tests import test_workspace_session_outcomes as fixtures
from tests import test_pips_local as local


class SessionOutcomeControlTests(unittest.TestCase):
    setUp = fixtures.SessionOutcomeTests.setUp
    git = local.LocalPipsTests.git
    commit = local.LocalPipsTests.commit
    write = fixtures.SessionOutcomeTests.write

    def control(self, foreground, kind, **fields):
        with patch.object(pips, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)):
            return pips.handle_control(foreground, {'type': kind, 'request_id': 'fixture-request',
                'workspace_id': self.ws, **fields}, 'authenticated-human', start_worker=False)

    def test_explicit_selected_workspace_inspect_propose_accept_isolated_from_foreground(self):
        other = self.base / 'foreground'; other.mkdir()
        foreground = local.config(other)
        original = (foreground.project_root, copy.deepcopy(foreground.data), copy.deepcopy(foreground.permissions))
        inspected = self.control(foreground, 'inspect_workspace_session_outcome', session_id=self.sid)
        self.assertTrue(inspected['ok'], inspected)
        self.assertEqual(inspected['result']['session']['revision'], 3)
        created = self.control(foreground, 'propose_workspace_session_outcome', session_id=self.sid,
            title='Reviewed decision', statement='Keep the reviewed interface.', source={'kind': 'commit', 'revision': self.revision},
            expected_session_revision=3, request_key='human-review')
        self.assertTrue(created['ok'], created)
        proposal = created['result']['proposal']
        accepted = self.control(foreground, 'accept_workspace_session_outcome', proposal_id=proposal['id'],
            expected_digest=proposal['digest'], expected_context_revision=0)
        self.assertTrue(accepted['ok'], accepted)
        self.assertEqual(accepted['result']['proposal']['status'], 'accepted')
        self.assertEqual(accepted['result']['context']['entries'][0]['provenance']['proposal']['verification'], 'not_execution_verified')
        self.assertEqual((foreground.project_root, foreground.data, foreground.permissions), original)
        self.assertFalse((other / '.dgc').exists())
        self.assertIsNone(self.registry.lookup(other))

    def test_selected_workspace_cannot_read_a_different_session_or_inject_root(self):
        other = self.base / 'other'; other.mkdir()
        foreground = local.config(other)
        self.registry.associate_session('foreign-chat', other)
        with patch.object(outcomes, 'inspect_session', side_effect=AssertionError('No foreign transcript read')):
            denied = self.control(foreground, 'inspect_workspace_session_outcome', session_id='foreign-chat')
            self.assertFalse(denied['ok']); self.assertEqual(denied['error']['code'], 'session_required')
        injected = self.control(foreground, 'inspect_workspace_session_outcome', session_id=self.sid, project_root=str(other))
        self.assertFalse(injected['ok']); self.assertEqual(injected['error']['code'], 'invalid_request')

    def test_restricted_human_control_cannot_bypass_policy_through_selected_root_clone(self):
        other = self.base / 'other'; other.mkdir()
        foreground = local.config(other)
        with patch('dgc.pip_access.restricted', return_value=True), \
                patch.object(outcomes, 'inspect_session', side_effect=AssertionError('No restricted transcript read')):
            denied = self.control(foreground, 'inspect_workspace_session_outcome', session_id=self.sid)
            self.assertFalse(denied['ok']); self.assertEqual(denied['error']['code'], 'session_policy')


if __name__ == '__main__': unittest.main()
