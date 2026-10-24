"""API20 is role-specific backend capability, not a blanket SDK schedule gate.

Fixture transports exercise forwarding/refusal behavior; actual Quill schedule
and worker enforcement belongs to the core integration suite.
"""
import asyncio
import copy
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import AsyncSession, DGCCommandRejectedError, DGCConfigError, DGCUnsupportedError, RuntimePolicy
from dgc_sdk.pips import COMMAND_FIELDS
from dgc_sdk.types import SandboxStatus
from dgc.pip_schedules import validate_schedule


def proposal(changes, *, pip_id='pip_audit', version=7):
    return {'pip_id': pip_id, 'expected_version': version, 'reason': 'Human reviewed this automation choice',
            'changes': copy.deepcopy(changes)}


class QuillAutomationSDKTests(unittest.TestCase):
    def test_api19_audit_schedule_event_and_disable_requests_keep_existing_shape(self):
        changes = [
            {'schedule': {'type': 'interval', 'minutes': 30}},
            {'schedule': {'type': 'daily', 'time': '09:00', 'timezone': 'UTC'}},
            {'schedule': {'type': 'cron', 'cron': '0 9 * * 1-5', 'timezone': 'UTC'}},
            {'schedule': {'type': 'once', 'at': '2026-10-03T12:00:00.000Z'}},
            {'schedule': None, 'event_trigger': {'events': ['session_turn_completed'], 'minimum_minutes': 30}},
            {'schedule': None, 'event_trigger': None},
        ]
        wire = Wire(); current = session(wire, caps={**CAPS, 'pips_api_version': 19})
        for change in changes:
            if 'schedule' in change:
                validate_schedule(change['schedule'])  # Valid backend syntax; this test still only forwards.
            values = proposal(change); original = copy.deepcopy(values)
            result = current.pips.mutate('propose_pip_update', values, approved=True)
            self.assertEqual({key: result['request'][key] for key in values}, original)
            self.assertEqual(values, original)
        self.assertEqual(len(wire.calls), len(changes))
        self.assertTrue(all(call[0]['request']['type'] == 'propose_pip_update' for call in wire.calls))

    def test_backend_quill_refusal_survives_without_read_retry_or_downgrade(self):
        for code, changes in (
                ('manual_only', {'schedule': {'type': 'interval', 'minutes': 30}}),
                ('invalid_event_trigger', {'event_trigger': {'events': ['context_updated'], 'minimum_minutes': 30}})):
            wire = Wire(); old = session(wire, caps={**CAPS, 'pips_api_version': 19})
            wire.transform = lambda event, reason=code: {**event, 'ok': False,
                'error': {'code': reason, 'message': 'This runtime cannot automate Quill.'}}
            values = proposal(changes, pip_id='pip_quill')
            with self.assertRaises(DGCCommandRejectedError) as caught:
                old.pips.mutate('propose_pip_update', values, approved=True)
            self.assertEqual((caught.exception.reason, caught.exception.command), (code, 'propose_pip_update'))
            self.assertEqual(len(wire.calls), 1)
            self.assertEqual(wire.calls[0][0]['request']['changes'], changes)
            self.assertEqual(wire.calls[0][0]['request']['expected_version'], 7)

    def test_api20_proposal_and_separate_accept_both_require_host_approval(self):
        wire = Wire(); current = session(wire, caps={**CAPS, 'pips_api_version': 20})
        values = proposal({'schedule': {'type': 'interval', 'minutes': 60}}, pip_id='pip_quill')
        accept = {'pip_id': 'pip_quill', 'proposal_id': 'proposal_saved', 'expected_version': 7}
        for command, params in (('propose_pip_update', values), ('accept_pip_update', accept)):
            for approved in (False, None, 1, 'true'):
                with self.assertRaises(DGCConfigError): current.pips.mutate(command, params, approved=approved)
            current.pips.mutate(command, params, approved=True)
        self.assertEqual([call[0]['request']['type'] for call in wire.calls], ['propose_pip_update', 'accept_pip_update'])
        self.assertEqual(COMMAND_FIELDS['propose_pip_update'], {'pip_id', 'expected_version', 'changes', 'reason'})
        for field in ('pip_type', 'minimum_api_version', 'actor', 'permissions'):
            with self.assertRaises(DGCConfigError):
                current.pips.mutate('propose_pip_update', {**values, field: 'forged'}, approved=True)
        self.assertEqual(len(wire.calls), 2)

    def test_stale_version_is_forwarded_and_conflict_does_not_trigger_lookup(self):
        wire = Wire(); current = session(wire, caps={**CAPS, 'pips_api_version': 20})
        wire.transform = lambda event: {**event, 'ok': False, 'error': {'code': 'conflict', 'message': 'Review the current job.'}}
        values = proposal({'event_trigger': {'events': ['commit_changed'], 'minimum_minutes': 60}}, pip_id='pip_quill', version=2)
        with self.assertRaises(DGCCommandRejectedError) as caught:
            current.pips.mutate('propose_pip_update', values, approved=True)
        self.assertEqual(caught.exception.reason, 'conflict')
        self.assertEqual(len(wire.calls), 1)
        self.assertEqual(wire.calls[0][0]['request']['expected_version'], 2)

    def test_api20_does_not_override_restricted_disabled_or_plan_authority(self):
        values = proposal({'schedule': {'type': 'interval', 'minutes': 30}}, pip_id='pip_quill')
        for kwargs in ({'isolated': True}, {'policy': RuntimePolicy()}, {'permission_mode': 'plan'},
                       {'sandbox': SandboxStatus(active=True)}, {'sandbox': SandboxStatus(requirement='required')}):
            wire = Wire(); current = session(wire, caps={**CAPS, 'pips_api_version': 20}, **kwargs)
            with self.assertRaises(DGCUnsupportedError): current.pips.mutate('propose_pip_update', values, approved=True)
            self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, 'pips_api_version': 20, 'pips_enabled': False})
        with self.assertRaises(DGCUnsupportedError): current.pips.mutate('propose_pip_update', values, approved=True)
        self.assertFalse(wire.calls)

    def test_async_forwards_same_schedule_and_structured_old_quill_refusal(self):
        async def exercise():
            wire = Wire(); old = AsyncSession(session(wire, caps={**CAPS, 'pips_api_version': 19}))
            values = proposal({'schedule': {'type': 'interval', 'minutes': 30}})
            self.assertEqual((await old.pips.mutate('propose_pip_update', values, approved=True))['request']['changes'], values['changes'])
            wire.transform = lambda event: {**event, 'ok': False, 'error': {'code': 'manual_only', 'message': 'Quill is manual on this runtime.'}}
            with self.assertRaises(DGCCommandRejectedError) as caught:
                await old.pips.mutate('propose_pip_update', {**values, 'pip_id': 'pip_quill'}, approved=True)
            self.assertEqual(caught.exception.reason, 'manual_only'); self.assertEqual(len(wire.calls), 2)
            next_wire = Wire(); current = AsyncSession(session(next_wire, caps={**CAPS, 'pips_api_version': 20}))
            with self.assertRaises(DGCConfigError): await current.pips.mutate('propose_pip_update', values)
            await current.pips.mutate('propose_pip_update', values, approved=True)
            self.assertEqual(len(next_wire.calls), 1)
        asyncio.run(exercise())


if __name__ == '__main__': unittest.main()
