"""API19 SDK statement authority; no provider, network, storage or timing calls."""
import asyncio
import copy
import unittest
from test_dgc_sdk_pips import Wire, session, CAPS
from dgc_sdk import AsyncSession, DGCConfigError, DGCUnsupportedError, DGCCommandRejectedError, RuntimePolicy
from dgc_sdk.types import SandboxStatus

READS = {
    'get_pip_statement_anchor': {'pip_id': 'pip_a', 'source_run_id': 'run_a'},
    'list_pip_statements': {'pip_id': 'pip_a', 'before_id': 4, 'limit': 20},
}
WRITES = {
    'record_pip_statement': {'pip_id': 'pip_a', 'kind': 'fact', 'title': 'Maintainer claim',
        'statement': 'This is an authored claim, not execution evidence.', 'reason': 'Reviewed explicitly',
        'expires_at': None, 'expected_anchor_digest': 'a' * 64, 'request_key': 'record-once', 'source_run_id': 'run_a'},
    'revoke_pip_statement': {'pip_id': 'pip_a', 'memory_id': 'memory_a', 'expected_revision': 0, 'reason': 'Revisit this claim'},
}
CURRENT = {**CAPS, 'pips_api_version': 19}

class StatementSDKTests(unittest.TestCase):
    def test_api18_and_invalid_capabilities_refuse_every_statement_command_before_transport(self):
        for caps in ({**CAPS, 'pips_api_version': 18}, {**CURRENT, 'pips_enabled': False},
                     {**CURRENT, 'pips_api_version': '19'}, {**CURRENT, 'pips_supported': False}):
            wire = Wire(); current = session(wire, caps=caps)
            for command, values in {**READS, **WRITES}.items():
                with self.subTest(caps=caps, command=command), self.assertRaises(DGCUnsupportedError):
                    if command in READS: current.pips.read(command, values)
                    else: current.pips.mutate(command, values, approved=True)
            self.assertFalse(wire.calls)

    def test_exact_fields_classification_and_approval_remain_distinct(self):
        wire = Wire(); current = session(wire, caps=CURRENT)
        for command, values in {**READS, **WRITES}.items():
            original = copy.deepcopy(values)
            if command in READS:
                with self.assertRaises(DGCConfigError): current.pips.mutate(command, values, approved=True)
                result = current.pips.read(command, values)
            else:
                with self.assertRaises(DGCConfigError): current.pips.read(command, values)
                for approved in (False, 1, 'true', None):
                    with self.assertRaises(DGCConfigError): current.pips.mutate(command, values, approved=approved)
                result = current.pips.mutate(command, values, approved=True)
                with self.assertRaises(DGCConfigError): current.pips.mutate(command, values)
            self.assertEqual({key: result['request'][key] for key in values}, original)
            self.assertEqual(values, original)
        self.assertEqual(len(wire.calls), 4)
        no_source = {k: v for k, v in WRITES['record_pip_statement'].items() if k != 'source_run_id'}
        no_source['kind'] = 'preference'
        sent = current.pips.mutate('record_pip_statement', no_source, approved=True)['request']
        self.assertIsNone(sent['expires_at']); self.assertNotIn('source_run_id', sent)

    def test_no_actor_scope_or_authority_injection_and_existing_request_bounds(self):
        wire = Wire(); current = session(wire, caps=CURRENT)
        for command, values in {**READS, **WRITES}.items():
            for field in ('actor', 'workspace_id', 'project_root', 'classification', 'verification', 'permissions', 'request_id'):
                with self.subTest(command=command, field=field), self.assertRaises(DGCConfigError):
                    if command in READS: current.pips.read(command, {**values, field: 'forged'})
                    else: current.pips.mutate(command, {**values, field: 'forged'}, approved=True)
        for text in ('\ud800', '界' * 12000):
            with self.assertRaises(DGCConfigError):
                current.pips.mutate('record_pip_statement', {**WRITES['record_pip_statement'], 'statement': text}, approved=True)
        self.assertFalse(wire.calls)

    def test_approval_does_not_override_inherited_state_policy_sandbox_or_plan(self):
        for kwargs in ({'isolated': True}, {'policy': RuntimePolicy()}, {'sandbox': SandboxStatus(active=True)},
                       {'sandbox': SandboxStatus(requirement='required')}, {'sandbox': SandboxStatus(requirement='preferred')}):
            wire = Wire(); current = session(wire, caps=CURRENT, **kwargs)
            for command, values in {**READS, **WRITES}.items():
                with self.subTest(kwargs=kwargs, command=command), self.assertRaises(DGCUnsupportedError):
                    if command in READS: current.pips.read(command, values)
                    else: current.pips.mutate(command, values, approved=True)
            self.assertFalse(wire.calls)
        wire = Wire(); planned = session(wire, caps=CURRENT, permission_mode='plan')
        planned.pips.read('get_pip_statement_anchor', READS['get_pip_statement_anchor'])
        for command, values in WRITES.items():
            with self.assertRaises(DGCUnsupportedError): planned.pips.mutate(command, values, approved=True)
        self.assertEqual(len(wire.calls), 1)

    def test_backend_conflict_is_not_retried_or_reinterpreted_as_verification(self):
        wire = Wire(); current = session(wire, caps=CURRENT)
        wire.transform = lambda value: {**value, 'ok': False, 'error': {'code': 'conflict', 'message': 'Review a fresh anchor.'}}
        with self.assertRaises(DGCCommandRejectedError) as caught:
            current.pips.mutate('record_pip_statement', WRITES['record_pip_statement'], approved=True)
        self.assertEqual(caught.exception.reason, 'conflict'); self.assertEqual(len(wire.calls), 1)
        wire.transform = lambda value: value
        current.pips.mutate('record_pip_statement', WRITES['record_pip_statement'], approved=True)
        self.assertEqual(wire.calls[0][0]['request']['request_key'], wire.calls[1][0]['request']['request_key'])
        self.assertNotEqual(wire.calls[0][0]['request']['request_id'], wire.calls[1][0]['request']['request_id'])

    def test_async_has_identical_api_gate_fields_and_per_request_approval(self):
        async def exercise():
            wire = Wire(); current = AsyncSession(session(wire, caps=CURRENT))
            for command, values in READS.items():
                self.assertEqual((await current.pips.read(command, values))['request']['type'], command)
            for command, values in WRITES.items():
                with self.assertRaises(DGCConfigError): await current.pips.mutate(command, values)
                self.assertEqual((await current.pips.mutate(command, values, approved=True))['request']['type'], command)
            old_wire = Wire(); old = AsyncSession(session(old_wire, caps={**CAPS, 'pips_api_version': 18}))
            with self.assertRaises(DGCUnsupportedError): await old.pips.read('list_pip_statements', {'pip_id': 'pip_a'})
            self.assertFalse(old_wire.calls); self.assertEqual(len(wire.calls), 4)
        asyncio.run(exercise())
