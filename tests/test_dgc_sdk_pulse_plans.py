"""Offline forwarding/authority gates for API21; not native command acceptance."""
import asyncio
import copy
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import AsyncSession, DGCCommandRejectedError, DGCConfigError, DGCUnsupportedError, RuntimePolicy
from dgc_sdk.pips import COMMAND_FIELDS
from dgc_sdk.types import SandboxStatus
from dgc.pip_execution import validate_action


def proposal(plan=None):
    return {'pip_id': 'pip_pulse', 'expected_version': 3, 'reason': 'Human reviewed exact commands',
            'changes': {'verification_plan': copy.deepcopy(plan)}}


def run_request():
    return {'pip_id': 'pip_pulse', 'idempotency_key': 'reviewed-one', 'expected_version': 4,
            'expected_lifecycle_revision': 2, 'expected_plan_digest': 'a' * 64}


def plan():
    # An actual valid existing action, including literal shell-looking argv data.
    return {'schema_version': 1, 'action': validate_action('pulse', {'kind': 'test',
        'tests': [{'argv': ['/usr/bin/python3', '-c', 'print("$HOME; $(never-expanded)")'], 'cwd': '.'}]})}


class PulsePlanSDKTests(unittest.TestCase):
    def test_new_fields_including_removal_refuse_old_api_before_any_request(self):
        cases = [('propose_pip_update', proposal(value)) for value in (None, plan())]
        for field in ('expected_version', 'expected_lifecycle_revision', 'expected_plan_digest'):
            cases.append(('run_pip', {key: value for key, value in run_request().items()
                                      if key in ('pip_id', 'idempotency_key', field)}))
        for version in (8, 19, 20):
            for command, values in cases:
                with self.subTest(version=version, command=command, fields=tuple(values)):
                    wire = Wire(); client = session(wire, caps={**CAPS, 'pips_api_version': version})
                    with self.assertRaisesRegex(DGCUnsupportedError, 'API 21'):
                        client.pips.mutate(command, values, approved=True)
                    self.assertFalse(wire.calls)

    def test_plan_and_exact_run_pins_are_detached_forwarded_once_without_lookup(self):
        wire = Wire(); client = session(wire, caps={**CAPS, 'pips_api_version': 21})
        values = proposal(plan()); before = copy.deepcopy(values)
        result = client.pips.mutate('propose_pip_update', values, approved=True)
        self.assertEqual({key: result['request'][key] for key in before}, before)
        values['changes']['verification_plan']['action']['tests'][0]['argv'][2] = 'changed later'
        self.assertEqual(wire.calls[0][0]['request']['changes'], before['changes'])
        request = run_request()
        result = client.pips.mutate('run_pip', request, approved=True)
        self.assertEqual({key: result['request'][key] for key in request}, request)
        self.assertEqual([call[0]['request']['type'] for call in wire.calls], ['propose_pip_update', 'run_pip'])
        self.assertEqual(COMMAND_FIELDS['run_pip'], set(request))

    def test_propose_accept_and_run_require_separate_explicit_approval(self):
        wire = Wire(); client = session(wire, caps={**CAPS, 'pips_api_version': 21})
        calls = [('propose_pip_update', proposal(plan())),
                 ('accept_pip_update', {'pip_id': 'pip_pulse', 'proposal_id': 'proposal_saved', 'expected_version': 3}),
                 ('run_pip', run_request())]
        for command, values in calls:
            for approved in (False, None, 1, 'true'):
                with self.assertRaises(DGCConfigError):
                    client.pips.mutate(command, values, approved=approved)
            client.pips.mutate(command, values, approved=True)
        self.assertEqual(len(wire.calls), 3)

    def test_legacy_run_and_schedule_are_not_blanket_gated(self):
        wire = Wire(); old = session(wire, caps={**CAPS, 'pips_api_version': 8})
        old.pips.mutate('run_pip', {'pip_id': 'pip_rook', 'idempotency_key': 'one'}, approved=True)
        old.pips.mutate('propose_pip_update', {'pip_id': 'pip_rook', 'expected_version': 1, 'reason': 'Human review',
            'changes': {'schedule': {'type': 'interval', 'minutes': 30}}}, approved=True)
        self.assertEqual(len(wire.calls), 2)

    def test_conflict_is_not_retried_or_rebased_and_reserved_fields_are_refused(self):
        wire = Wire(); client = session(wire, caps={**CAPS, 'pips_api_version': 21})
        wire.transform = lambda event: {**event, 'ok': False, 'error': {'code': 'conflict', 'message': 'Review the saved job again.'}}
        values = run_request()
        with self.assertRaises(DGCCommandRejectedError) as caught:
            client.pips.mutate('run_pip', values, approved=True)
        self.assertEqual(caught.exception.reason, 'conflict')
        self.assertEqual(len(wire.calls), 1)
        self.assertEqual(wire.calls[0][0]['request']['expected_version'], 4)
        for key in ('actor', 'argv', 'permissions', 'pulse_verification', 'result', 'project_root'):
            with self.assertRaises(DGCConfigError):
                client.pips.mutate('run_pip', {**values, key: 'forged'}, approved=True)
        self.assertEqual(len(wire.calls), 1)

    def test_new_capability_never_bypasses_existing_authority(self):
        for kwargs in ({'isolated': True}, {'policy': RuntimePolicy()}, {'permission_mode': 'plan'},
                       {'sandbox': SandboxStatus(active=True)}, {'sandbox': SandboxStatus(requirement='required')}):
            wire = Wire(); client = session(wire, caps={**CAPS, 'pips_api_version': 21}, **kwargs)
            for command, values in (('propose_pip_update', proposal(plan())), ('run_pip', run_request())):
                with self.assertRaises(DGCUnsupportedError): client.pips.mutate(command, values, approved=True)
            self.assertFalse(wire.calls)
        wire = Wire(); client = session(wire, caps={**CAPS, 'pips_api_version': 21, 'pips_enabled': False})
        with self.assertRaises(DGCUnsupportedError): client.pips.mutate('run_pip', run_request(), approved=True)
        self.assertFalse(wire.calls)

    def test_async_has_same_new_field_gate_forwarding_and_error(self):
        async def exercise():
            wire = Wire(); old = AsyncSession(session(wire, caps={**CAPS, 'pips_api_version': 20}))
            for command, values in (('propose_pip_update', proposal()), ('run_pip', run_request())):
                with self.assertRaises(DGCUnsupportedError): await old.pips.mutate(command, values, approved=True)
            self.assertFalse(wire.calls)
            wire = Wire(); client = AsyncSession(session(wire, caps={**CAPS, 'pips_api_version': 21}))
            with self.assertRaises(DGCConfigError): await client.pips.mutate('run_pip', run_request())
            result = await client.pips.mutate('run_pip', run_request(), approved=True)
            self.assertEqual(result['request']['expected_plan_digest'], 'a' * 64)
            wire.transform = lambda event: {**event, 'ok': False, 'error': {'code': 'stale_grant', 'message': 'Review again.'}}
            with self.assertRaises(DGCCommandRejectedError) as caught:
                await client.pips.mutate('run_pip', run_request(), approved=True)
            self.assertEqual(caught.exception.reason, 'stale_grant')
            self.assertEqual(len(wire.calls), 2)
        asyncio.run(exercise())


if __name__ == '__main__': unittest.main()
