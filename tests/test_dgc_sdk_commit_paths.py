"""API22 SDK transport gates; no provider, filesystem observation or network."""
import asyncio
import copy
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import AsyncSession, DGCCommandRejectedError, DGCConfigError, DGCUnsupportedError, RuntimePolicy
from dgc_sdk.types import SandboxStatus


def policy():
    return {'events': ['committed_paths_changed'], 'minimum_minutes': 5,
            'missed_policy': 'coalesce_latest', 'commit_paths': [
                {'kind': 'directory', 'path': 'src'}, {'kind': 'exact', 'path': 'docs/日本語.md'}]}


def proposal(trigger):
    return {'pip_id': 'pip_reviewed', 'expected_version': 7,
            'reason': 'Review literal committed paths', 'changes': {'event_trigger': copy.deepcopy(trigger)}}


class CommitPathsSDKTests(unittest.TestCase):
    def test_new_event_or_field_presence_refuses_old_capability_without_send(self):
        for version in (8, 10, 17, 18, 20, 21):
            for trigger in (policy(), {'events': ['committed_paths_changed']},
                            {'events': ['commit_changed'], 'commit_paths': None},
                            {'commit_paths': []}):
                wire = Wire(); client = session(wire, caps={**CAPS, 'pips_api_version': version})
                with self.subTest(version=version, trigger=trigger), self.assertRaisesRegex(DGCUnsupportedError, 'API 22'):
                    client.pips.mutate('propose_pip_update', proposal(trigger), approved=True)
                self.assertFalse(wire.calls)

    def test_new_policy_is_detached_and_forwarded_once_without_canonicalizing(self):
        wire = Wire(); client = session(wire, caps={**CAPS, 'pips_api_version': 22})
        values = proposal(policy()); before = copy.deepcopy(values)
        result = client.pips.mutate('propose_pip_update', values, approved=True)
        self.assertEqual({key: result['request'][key] for key in before}, before)
        values['changes']['event_trigger']['commit_paths'][0]['path'] = 'other'
        self.assertEqual(wire.calls[0][0]['request']['changes'], before['changes'])
        self.assertEqual(len(wire.calls), 1)

    def test_legacy_events_disable_and_schedules_keep_existing_capabilities(self):
        for version in (10, 18, 20, 21):
            wire = Wire(); client = session(wire, caps={**CAPS, 'pips_api_version': version})
            triggers = [None, {'events': ['context_updated']}, {'events': ['commit_changed', 'finding_accepted']}]
            if version >= 18: triggers.append({'events': ['session_turn_completed']})
            for trigger in triggers:
                values = proposal(trigger)
                result = client.pips.mutate('propose_pip_update', values, approved=True)
                self.assertEqual(result['request']['changes'], values['changes'])
            values = proposal(None); values['changes'] = {'schedule': {'type': 'interval', 'minutes': 30}}
            client.pips.mutate('propose_pip_update', values, approved=True)
            self.assertEqual(len(wire.calls), len(triggers) + 1)

    def test_review_proposal_and_acceptance_each_need_explicit_host_approval(self):
        wire = Wire(); client = session(wire, caps={**CAPS, 'pips_api_version': 22})
        for command, values in (
                ('propose_pip_update', proposal(policy())),
                ('accept_pip_update', {'pip_id': 'pip_reviewed', 'expected_version': 7, 'proposal_id': 'proposal_saved'})):
            for approved in (False, None, 1, 'true'):
                with self.assertRaises(DGCConfigError): client.pips.mutate(command, values, approved=approved)
            client.pips.mutate(command, values, approved=True)
        self.assertEqual([call[0]['request']['type'] for call in wire.calls], ['propose_pip_update', 'accept_pip_update'])

    def test_rejection_keeps_exact_version_without_lookup_retry_or_broadening(self):
        wire = Wire(); client = session(wire, caps={**CAPS, 'pips_api_version': 22})
        wire.transform = lambda event: {**event, 'ok': False,
            'error': {'code': 'conflict', 'message': 'Review the current job.'}}
        with self.assertRaises(DGCCommandRejectedError) as caught:
            client.pips.mutate('propose_pip_update', proposal(policy()), approved=True)
        self.assertEqual(caught.exception.reason, 'conflict')
        self.assertEqual(len(wire.calls), 1)
        self.assertEqual(wire.calls[0][0]['request']['expected_version'], 7)
        self.assertEqual(wire.calls[0][0]['request']['changes']['event_trigger'], policy())

    def test_api22_does_not_override_controller_permissions_or_isolation(self):
        for options in ({'isolated': True}, {'policy': RuntimePolicy()}, {'permission_mode': 'plan'},
                        {'sandbox': SandboxStatus(requirement='required')}, {'sandbox': SandboxStatus(active=True)}):
            wire = Wire(); client = session(wire, caps={**CAPS, 'pips_api_version': 22}, **options)
            with self.assertRaises(DGCUnsupportedError):
                client.pips.mutate('propose_pip_update', proposal(policy()), approved=True)
            self.assertFalse(wire.calls)
        wire = Wire(); client = session(wire, caps={**CAPS, 'pips_api_version': 22, 'pips_enabled': False})
        with self.assertRaises(DGCUnsupportedError):
            client.pips.mutate('propose_pip_update', proposal(policy()), approved=True)
        self.assertFalse(wire.calls)

    def test_async_has_same_old_refusal_and_exact_single_send(self):
        async def exercise():
            wire = Wire(); old = AsyncSession(session(wire, caps={**CAPS, 'pips_api_version': 21}))
            with self.assertRaisesRegex(DGCUnsupportedError, 'API 22'):
                await old.pips.mutate('propose_pip_update', proposal(policy()), approved=True)
            self.assertFalse(wire.calls)
            client = AsyncSession(session(wire, caps={**CAPS, 'pips_api_version': 22}))
            values = proposal(policy())
            with self.assertRaises(DGCConfigError): await client.pips.mutate('propose_pip_update', values)
            result = await client.pips.mutate('propose_pip_update', values, approved=True)
            self.assertEqual(result['request']['changes'], values['changes'])
            self.assertEqual(len(wire.calls), 1)
        asyncio.run(exercise())


if __name__ == '__main__': unittest.main()
