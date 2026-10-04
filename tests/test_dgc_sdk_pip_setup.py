"""API23 setup SDK authority. Offline transport only; no sleeps or network."""
import asyncio
import copy
import unittest

from tests.test_dgc_sdk_pips import Wire, session, CAPS
from dgc_sdk import AsyncSession, DGCConfigError, DGCUnsupportedError, DGCCommandRejectedError, DGCProtocolError, RuntimePolicy
from dgc_sdk.pips import COMMAND_FIELDS, READ_COMMANDS, MUTATION_COMMANDS
from dgc_sdk.types import SandboxStatus

READS = {'list_pip_setups': {'workspace_id': 'ws_local'}, 'get_pip_setup': {'setup_id': 'setup_saved'}}
WRITES = {command: {'setup_id': 'setup_saved', 'expected_digest': 'a' * 64}
          for command in ('accept_pip_setup', 'reject_pip_setup')}
CURRENT = {**CAPS, 'pips_api_version': 23}


class SetupSDKTests(unittest.TestCase):
    def test_api25_model_revision_is_exact_explicit_human_mutation(self):
        params = {'setup_id': 'setup_saved', 'expected_digest': 'a' * 64,
                  'model_choice': {'mode': 'model', 'model': 'review-model'}}
        from dgc.pips import _COMMAND_ARGS
        self.assertEqual(COMMAND_FIELDS['revise_pip_setup'], _COMMAND_ARGS['revise_pip_setup'])
        wire = Wire(); old = session(wire, caps={**CAPS, 'pips_api_version': 24})
        with self.assertRaisesRegex(DGCUnsupportedError, 'API 25'):
            old.pips.mutate('revise_pip_setup', params, approved=True)
        current = session(wire, caps={**CAPS, 'pips_api_version': 25})
        with self.assertRaises(DGCConfigError):
            current.pips.read('revise_pip_setup', params)
        with self.assertRaises(DGCConfigError):
            current.pips.mutate('revise_pip_setup', params)
        for field in ('actor', 'workspace_id', 'run_now', 'schedule', 'body'):
            with self.subTest(field=field), self.assertRaises(DGCConfigError):
                current.pips.mutate('revise_pip_setup', {**params, field: 'forged'}, approved=True)
        self.assertFalse(wire.calls)
        answer = current.pips.mutate('revise_pip_setup', params, approved=True)
        self.assertEqual(answer['request']['model_choice'], params['model_choice'])
        self.assertEqual(answer['request']['expected_digest'], params['expected_digest'])
        self.assertEqual(len(wire.calls), 1)

    def test_setup_alias_cannot_escape_explicit_deny_or_read_only_allowlist(self):
        from dgc_sdk.types import PermissionRequest
        request = PermissionRequest('review-fixture', 'pips_setup', {})
        for spelling in ('pips_setup', 'PipsSetup'):
            policy = RuntimePolicy(deny_tools=[spelling], network='allow')
            self.assertEqual(policy.evaluate(request, cwd=None), 'deny')
            self.assertIn('PipsSetup', policy._named_rules())
        policy = RuntimePolicy(allow_tools=['read_file', 'pips_context'], network='allow')
        self.assertEqual(policy.evaluate(request, cwd=None), 'deny')
        self.assertIn('PipsSetup', policy._named_rules())

    def test_api23_exact_fields_and_read_mutation_classification_match_runtime(self):
        from dgc.pips import _COMMAND_ARGS
        for command, params in {**READS, **WRITES}.items():
            self.assertEqual(COMMAND_FIELDS[command], set(params))
            self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command])
            self.assertEqual(command in READ_COMMANDS, command in READS)
            self.assertEqual(command in MUTATION_COMMANDS, command in WRITES)

    def test_old_invalid_disabled_capabilities_refuse_before_transport(self):
        for caps in ({**CAPS, 'pips_api_version': 22}, {**CURRENT, 'pips_api_version': True},
                     {**CURRENT, 'pips_api_version': '23'}, {**CURRENT, 'pips_supported': False},
                     {**CURRENT, 'pips_enabled': False}):
            wire = Wire(); current = session(wire, caps=caps)
            for command, params in {**READS, **WRITES}.items():
                with self.subTest(caps=caps, command=command), self.assertRaises(DGCUnsupportedError):
                    if command in READS: current.pips.read(command, params)
                    else: current.pips.mutate(command, params, approved=True)
            self.assertFalse(wire.calls)

    def test_each_review_requires_exact_explicit_approval_and_cannot_be_read(self):
        wire = Wire(); current = session(wire, caps=CURRENT)
        for command, params in {**READS, **WRITES}.items():
            before = copy.deepcopy(params)
            if command in READS:
                with self.assertRaises(DGCConfigError): current.pips.mutate(command, params, approved=True)
                result = current.pips.read(command, params)
            else:
                with self.assertRaises(DGCConfigError): current.pips.read(command, params)
                for approved in (False, 1, 'true', None):
                    with self.assertRaises(DGCConfigError): current.pips.mutate(command, params, approved=approved)
                result = current.pips.mutate(command, params, approved=True)
                with self.assertRaises(DGCConfigError): current.pips.mutate(command, params)
            self.assertEqual({key: result['request'][key] for key in params}, before)
            self.assertEqual(params, before)
        self.assertEqual(len(wire.calls), 4)

    def test_no_root_actor_schedule_run_or_digest_replacement_injection(self):
        wire = Wire(); current = session(wire, caps=CURRENT)
        for command, params in {**READS, **WRITES}.items():
            for field in ('actor', 'project_root', 'target_root', 'run_now', 'schedule', 'permissions', 'request_id', 'body'):
                with self.subTest(command=command, field=field), self.assertRaises(DGCConfigError):
                    if command in READS: current.pips.read(command, {**params, field: 'forged'})
                    else: current.pips.mutate(command, {**params, field: 'forged'}, approved=True)
            if command != 'list_pip_setups':
                with self.assertRaises(DGCConfigError):
                    if command in READS: current.pips.read(command, {**params, 'workspace_id': 'ws_other'})
                    else: current.pips.mutate(command, {**params, 'workspace_id': 'ws_other'}, approved=True)
        with self.assertRaises(DGCConfigError): current.pips.mutate('propose_pip_setup', {}, approved=True)
        self.assertFalse(wire.calls)

    def test_approval_does_not_override_isolation_policy_sandbox_or_plan(self):
        for kwargs in ({'isolated': True}, {'policy': RuntimePolicy()}, {'sandbox': SandboxStatus(active=True)},
                       {'sandbox': SandboxStatus(requirement='required')}, {'sandbox': SandboxStatus(requirement='preferred')}):
            wire = Wire(); current = session(wire, caps=CURRENT, **kwargs)
            for command, params in {**READS, **WRITES}.items():
                with self.subTest(kwargs=kwargs, command=command), self.assertRaises(DGCUnsupportedError):
                    if command in READS: current.pips.read(command, params)
                    else: current.pips.mutate(command, params, approved=True)
            self.assertFalse(wire.calls)
        wire = Wire(); planned = session(wire, caps=CURRENT, permission_mode='plan')
        planned.pips.read('get_pip_setup', READS['get_pip_setup'])
        for command, params in WRITES.items():
            with self.assertRaises(DGCUnsupportedError): planned.pips.mutate(command, params, approved=True)
        self.assertEqual(len(wire.calls), 1)

    def test_stale_digest_refusal_is_not_retried_rebased_or_accepted(self):
        wire = Wire(); current = session(wire, caps=CURRENT)
        wire.transform = lambda value: {**value, 'ok': False, 'error': {'code': 'review_changed', 'message': 'Read the exact setup again.'}}
        with self.assertRaises(DGCCommandRejectedError) as caught:
            current.pips.mutate('accept_pip_setup', WRITES['accept_pip_setup'], approved=True)
        self.assertEqual(caught.exception.reason, 'review_changed')
        self.assertEqual(len(wire.calls), 1)
        self.assertEqual(wire.calls[0][0]['request']['expected_digest'], 'a' * 64)
        self.assertEqual(wire.calls[0][0]['request']['type'], 'accept_pip_setup')

    def test_setup_result_correlation_remains_exact(self):
        for change in ({'command': 'get_pip'}, {'request_id': 'another-request'}, {'ok': 1}):
            wire = Wire(); current = session(wire, caps=CURRENT)
            wire.transform = lambda value: {**value, **change}
            with self.subTest(change=change), self.assertRaises(DGCProtocolError):
                current.pips.read('get_pip_setup', READS['get_pip_setup'])
            self.assertEqual(len(wire.calls), 1)

    def test_async_has_same_read_review_gates_and_exact_pins(self):
        async def exercise():
            wire = Wire(); current = AsyncSession(session(wire, caps=CURRENT))
            for command, params in READS.items():
                self.assertEqual((await current.pips.read(command, params))['request']['type'], command)
            for command, params in WRITES.items():
                with self.assertRaises(DGCConfigError): await current.pips.mutate(command, params)
                result = await current.pips.mutate(command, params, approved=True)
                self.assertEqual(result['request']['expected_digest'], params['expected_digest'])
            old_wire = Wire(); old = AsyncSession(session(old_wire, caps={**CAPS, 'pips_api_version': 22}))
            with self.assertRaises(DGCUnsupportedError): await old.pips.read('list_pip_setups', READS['list_pip_setups'])
            self.assertFalse(old_wire.calls); self.assertEqual(len(wire.calls), 4)
        asyncio.run(exercise())
