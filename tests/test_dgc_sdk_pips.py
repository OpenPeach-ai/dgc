"""Pips SDK authority, nested correlation and async parity. No network or sleeps."""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sdk/python'))
from dgc_sdk import (DGC, AsyncSession, DGCCommandRejectedError, DGCConfigError,
                     DGCProtocolError, DGCTimeoutError, DGCUnsupportedError, RuntimePolicy)
from dgc_sdk.pips import COMMAND_FIELDS, READ_COMMANDS, MUTATION_COMMANDS
from dgc_sdk.session import Session
from dgc_sdk.types import SandboxStatus
from dgc_sdk.wire.client import DGCClient, DGCEventTimeout
from dgc_sdk.wire.editor_protocol import command_error

CAPS = {'pips_supported': True, 'pips_api_version': 8, 'pips_enabled': True}


class Wire:
    def __init__(self):
        self.calls = []
        self.transform = lambda event: event

    def request(self, payload, response, **kwargs):
        self.calls.append((payload, response, kwargs))
        if payload['type'] != 'pips_control':
            return {'request_id': payload['request_id'], 'items': []}
        assert command_error(payload) is None, command_error(payload)
        request = payload['request']
        assert kwargs['request_id'] == request['request_id']
        return self.transform({'type': 'pips_result', 'request_id': request['request_id'],
                               'command': request['type'], 'ok': True, 'result': {'request': request}})


def session(wire=None, caps=None, **kwargs):
    kwargs.setdefault('isolated', False)
    return Session(wire or Wire(), {'capabilities': CAPS if caps is None else caps},
                   unhandled='deny', on_permission=None, on_plan=None, on_question=None, **kwargs)


class PipsSDKTests(unittest.TestCase):
    def test_api46_a_pip_s_notes_in_the_shared_memory_require_new_runtime(self):
        wire=Wire();old=session(wire,caps={**CAPS,'pips_api_version':45})
        with self.assertRaisesRegex(DGCUnsupportedError,'API 46'):old.pips.read('list_pip_notes',{'pip_id':'pip_test','shared':True})
        with self.assertRaisesRegex(DGCUnsupportedError,'API 46'):old.pips.mutate('forget_pip_note',{'pip_id':'pip_test','note_id':'mem_'+'a'*12,'shared':True},approved=True)
        self.assertEqual(wire.calls,[],"nothing reaches an older runtime, which would refuse the field")
        self.assertEqual(old.pips.read('list_pip_notes',{'pip_id':'pip_test'})['request']['type'],'list_pip_notes',"without it, as before")
        current=session(caps={**CAPS,'pips_api_version':46})
        self.assertIs(current.pips.read('list_pip_notes',{'pip_id':'pip_test','shared':True})['request']['shared'],True)
        self.assertIs(current.pips.mutate('add_pip_note',{'pip_id':'pip_test','text':'Likes tea','shared':True},approved=True)['request']['shared'],True)

    def test_api38_calendar_guests_and_repeat_require_new_runtime(self):
        from tests.test_pip_calendar_series import EXT
        args={'source_run_id':'run_test','server':'composio','connection_digest':'a'*64,'account':'ca_test','schema_digest':'b'*64,'event':EXT,'request_key':'series'}
        wire=Wire();old=session(wire,caps={**CAPS,'pips_api_version':37})
        with self.assertRaisesRegex(DGCUnsupportedError,'API 38'):old.pips.mutate('propose_pip_calendar_action',args,approved=True)
        self.assertEqual(wire.calls,[])
        current=session(caps={**CAPS,'pips_api_version':38})
        with self.assertRaises(DGCConfigError):current.pips.mutate('propose_pip_calendar_action',args)
        self.assertEqual(current.pips.mutate('propose_pip_calendar_action',args,approved=True)['request']['event'],EXT)

    def test_api37_connector_drafts_require_explicit_human_preparation(self):
        old=session(caps={**CAPS,'pips_api_version':36})
        with self.assertRaisesRegex(DGCUnsupportedError,'API 37'):old.pips.read('get_pip_connector_draft',{'draft_id':'conndraft_test'})
        current=session(caps={**CAPS,'pips_api_version':37})
        self.assertEqual(current.pips.read('list_pip_connector_drafts',{'pip_id':'pip_test'})['request']['type'],'list_pip_connector_drafts')
        args={'draft_id':'conndraft_test','expected_digest':'a'*64,'call':{'tool':'run_workflow','arguments':{'workflow_id':'123'}}}
        with self.assertRaises(DGCConfigError):current.pips.mutate('prepare_pip_connector_draft',args)
        with self.assertRaises(DGCConfigError):current.pips.mutate('prepare_pip_connector_draft',{**args,'execute':True},approved=True)
        self.assertEqual(current.pips.mutate('prepare_pip_connector_draft',args,approved=True)['request']['call'],args['call'])

    def test_api36_connector_review_gate_and_explicit_approval(self):
        args={'source_run_id':'run_saved','server':'make','connection_digest':'a'*64,'schema_digest':'b'*64,'call':{'tool':'run_workflow','arguments':{'workflow_id':'123'}},'request_key':'one'}
        old=session(caps={**CAPS,'pips_api_version':35})
        with self.assertRaisesRegex(DGCUnsupportedError,'API 36'):old.pips.read('inspect_pip_connector_actions',{'server':'make'})
        with self.assertRaisesRegex(DGCUnsupportedError,'API 36'):old.pips.mutate('propose_pip_connector_action',args,approved=True)
        current=session(caps={**CAPS,'pips_api_version':36})
        with self.assertRaises(DGCConfigError):current.pips.mutate('propose_pip_connector_action',args)
        with self.assertRaises(DGCConfigError):current.pips.mutate('propose_pip_connector_action',{**args,'account':'ca_extra'},approved=True)
        self.assertEqual(current.pips.read('inspect_pip_connector_actions',{'server':'make'})['request']['server'],'make')
        self.assertEqual(current.pips.mutate('propose_pip_connector_action',args,approved=True)['request']['call'],args['call'])

    def test_api35_calendar_drafts_gate_and_explicit_preparation(self):
        old=session(caps={**CAPS,'pips_api_version':34})
        with self.assertRaisesRegex(DGCUnsupportedError,'API 35'):old.pips.read('get_pip_calendar_draft',{'draft_id':'caldraft_test'})
        current=session(caps={**CAPS,'pips_api_version':35})
        self.assertEqual(current.pips.read('list_pip_calendar_drafts',{'pip_id':'pip_test'})['request']['type'],'list_pip_calendar_drafts')
        args={'draft_id':'caldraft_test','expected_digest':'a'*64,'server':'composio','connection_digest':'b'*64,'account':'ca_test','schema_digest':'c'*64,'event':{'summary':'Reading','description':'One chapter','start_datetime':'2026-12-01T11:00:00Z','end_datetime':'2026-12-01T11:30:00Z','timezone':'UTC'}}
        with self.assertRaises(DGCConfigError):current.pips.mutate('prepare_pip_calendar_draft',args)
        with self.assertRaises(DGCConfigError):current.pips.mutate('prepare_pip_calendar_draft',{**args,'approve':True},approved=True)
        result=current.pips.mutate('prepare_pip_calendar_draft',args,approved=True)
        self.assertEqual(result['request']['event'],args['event']);self.assertEqual(result['request']['type'],'prepare_pip_calendar_draft')

    def test_api34_calendar_preparation_requires_explicit_approval(self):
        args={'source_run_id':'run_test','server':'composio','connection_digest':'a'*64,'account':'ca_test','schema_digest':'b'*64,
              'event':{'summary':'Read','description':'A chapter','start_datetime':'2026-12-01T11:00:00Z','end_datetime':'2026-12-01T11:30:00Z','timezone':'UTC'},'request_key':'event'}
        old=session(caps={**CAPS,'pips_api_version':33})
        with self.assertRaisesRegex(DGCUnsupportedError,'API 34'):old.pips.read('inspect_pip_calendar_connection',{'server':'composio'})
        with self.assertRaisesRegex(DGCUnsupportedError,'API 34'):old.pips.mutate('propose_pip_calendar_action',args,approved=True)
        current=session(caps={**CAPS,'pips_api_version':34})
        with self.assertRaises(DGCConfigError):current.pips.mutate('propose_pip_calendar_action',args)
        with self.assertRaises(DGCConfigError):current.pips.mutate('propose_pip_calendar_action',{**args,'actor':'model'},approved=True)
        self.assertEqual(current.pips.read('inspect_pip_calendar_connection',{'server':'composio'})['request']['type'],'inspect_pip_calendar_connection')
        result=current.pips.mutate('propose_pip_calendar_action',args,approved=True)
        self.assertEqual(result['request']['event'],args['event'])

    def test_api32_drafts_are_reads_and_preparation_is_not_acceptance(self):
        args={'draft_id':'maildraft_test','expected_digest':'a'*64}
        old=session(caps={**CAPS,'pips_api_version':31})
        with self.assertRaisesRegex(DGCUnsupportedError,'API 32'):old.pips.read('get_pip_message_draft',{'draft_id':'maildraft_test'})
        current=session(caps={**CAPS,'pips_api_version':32})
        self.assertEqual(current.pips.read('list_pip_message_drafts',{'pip_id':'pip_test'})['request']['type'],'list_pip_message_drafts')
        with self.assertRaises(DGCConfigError):current.pips.mutate('dismiss_pip_message_draft',args)
        self.assertEqual(current.pips.mutate('dismiss_pip_message_draft',args,approved=True)['request']['draft_id'],args['draft_id'])

    def test_api31_message_reviews_need_explicit_host_approval_and_no_extra_fields(self):
        args={'action_id':'appaction_test','expected_digest':'a'*64}
        for name in ('accept_pip_app_action','reject_pip_app_action'):
            old=session(caps={**CAPS,'pips_api_version':30})
            with self.assertRaisesRegex(DGCUnsupportedError,'API 31'):old.pips.mutate(name,args,approved=True)
            current=session(caps={**CAPS,'pips_api_version':31})
            with self.assertRaises(DGCConfigError):current.pips.read(name,args)
            with self.assertRaises(DGCConfigError):current.pips.mutate(name,args)
            with self.assertRaises(DGCConfigError):current.pips.mutate(name,{**args,'actor':'model'},approved=True)
            self.assertEqual(current.pips.mutate(name,args,approved=True)['request']['expected_digest'],args['expected_digest'])
        current=session(caps={**CAPS,'pips_api_version':31})
        for name,params in [('inspect_pip_send_connection',{'server':'composio'}),('get_pip_app_action',{'action_id':'appaction_test'}),('list_pip_app_actions',{'pip_id':'pip_test'})]:
            self.assertEqual(current.pips.read(name,params)['request']['type'],name)

    def test_api18_saved_turn_trigger_gates_only_new_event_and_keeps_review(self):
        params = {'pip_id': 'pip_a', 'expected_version': 2, 'reason': 'Review saved turn trigger',
                  'changes': {'event_trigger': {'events': ['session_turn_completed'], 'minimum_minutes': 30}}}
        wire = Wire()
        old = session(wire, caps={**CAPS, 'pips_api_version': 17})
        with self.assertRaisesRegex(DGCUnsupportedError, 'API 18'):
            old.pips.mutate('propose_pip_update', params, approved=True)
        self.assertFalse(wire.calls)
        current = session(wire, caps={**CAPS, 'pips_api_version': 18})
        with self.assertRaises(DGCConfigError):
            current.pips.mutate('propose_pip_update', params)
        result = current.pips.mutate('propose_pip_update', params, approved=True)
        self.assertEqual(result['request']['changes'], params['changes'])
        self.assertEqual(len(wire.calls), 1)
        for spec in (None, {'events': ['context_updated']}, {'events': ['finding_accepted', 'commit_changed']}):
            legacy = {**params, 'changes': {'event_trigger': spec}}
            old.pips.mutate('propose_pip_update', legacy, approved=True)
        self.assertEqual(len(wire.calls), 4)

    def test_api17_native_receipts_require_matching_capability_and_review_authority(self):
        commands = {'list_workspace_execution_receipts': {'workspace_id': 'ws_a', 'session_id': 'chat-one', 'limit': 20},
            'get_workspace_execution_receipt': {'workspace_id': 'ws_a', 'attempt_id': 'exec_a'},
            'record_workspace_execution_context': {'workspace_id': 'ws_a', 'attempt_id': 'exec_a',
                'expected_attempt_digest': 'a' * 64, 'expected_final_digest': 'b' * 64,
                'expected_view_digest': 'c' * 64, 'expected_context_revision': 3}}
        for command, params in commands.items():
            mutation = command == 'record_workspace_execution_context'
            wire = Wire()
            old = session(wire, caps={**CAPS, 'pips_api_version': 16})
            with self.assertRaises(DGCUnsupportedError):
                old.pips.mutate(command, params, approved=True) if mutation else old.pips.read(command, params)
            self.assertFalse(wire.calls)
            current = session(wire, caps={**CAPS, 'pips_api_version': 17})
            if mutation:
                with self.assertRaises(DGCConfigError): current.pips.read(command, params)
                with self.assertRaises(DGCConfigError): current.pips.mutate(command, params)
                result = current.pips.mutate(command, params, approved=True)
            else:
                with self.assertRaises(DGCConfigError): current.pips.mutate(command, params, approved=True)
                result = current.pips.read(command, params)
            self.assertEqual({k: result['request'][k] for k in params}, params)
            for key in ('actor', 'project_root', 'command', 'verified', 'permissions'):
                with self.assertRaises(DGCConfigError):
                    if mutation: current.pips.mutate(command, {**params, key: 'forged'}, approved=True)
                    else: current.pips.read(command, {**params, key: 'forged'})
            self.assertEqual(len(wire.calls), 1)

    def test_api16_optional_lifecycle_pin_keeps_legacy_pause_resume_compatible(self):
        for command in ('pause_pip', 'resume_pip'):
            params = {'pip_id': 'pip_a'}
            wire = Wire()
            legacy = session(wire)
            legacy.pips.mutate(command, params, approved=True)
            with self.assertRaises(DGCUnsupportedError):
                legacy.pips.mutate(command, {**params, 'expected_lifecycle_revision': 3}, approved=True)
            self.assertEqual(len(wire.calls), 1)
            current = session(wire, caps={**CAPS, 'pips_api_version': 16})
            result = current.pips.mutate(command, {**params, 'expected_lifecycle_revision': 3}, approved=True)
            self.assertEqual(result['request']['expected_lifecycle_revision'], 3)

    def test_api16_archive_restore_are_explicit_mutations_with_exact_lifecycle_pins(self):
        params = {'pip_id': 'pip_a', 'expected_version': 2, 'expected_lifecycle_revision': 3,
                  'request_key': 'review-once', 'reason': 'Reviewed lifecycle change'}
        for command in ('archive_pip', 'restore_pip'):
            wire = Wire()
            with self.subTest(command=command), self.assertRaises(DGCUnsupportedError):
                session(wire, caps={**CAPS, 'pips_api_version': 15}).pips.mutate(command, params, approved=True)
            self.assertFalse(wire.calls)
            current = session(wire, caps={**CAPS, 'pips_api_version': 16})
            for _ in range(2):
                with self.assertRaises(DGCConfigError): current.pips.read(command, params)
                with self.assertRaises(DGCConfigError): current.pips.mutate(command, params)
                result = current.pips.mutate(command, params, approved=True)
                self.assertEqual({k: result['request'][k] for k in params}, params)
            for reserved in ('actor', 'archived', 'workspace_id', 'permissions', 'project_root'):
                with self.assertRaises(DGCConfigError):
                    current.pips.mutate(command, {**params, reserved: 'forged'}, approved=True)
            self.assertEqual(len(wire.calls), 2)

    def test_reviewed_specialists_require_api15_without_changing_old_handoff_gate(self):
        values = {'source_run_id': 'run_a', 'finding_index': 0, 'target_pip_id': 'pip_a',
                  'task': 'Review a fix', 'action': {'kind': 'patch', 'write_paths': ['one.py'], 'tests': []},
                  'idempotency_key': 'one'}
        self.assertEqual(session().pips.mutate('propose_pip_handoff', values, approved=True)['request']['action'], values['action'])
        with_specialists = {**values, 'action': {**values['action'], 'specialists': {'roles': ['critic'], 'max_calls': 1}}}
        wire = Wire()
        with self.assertRaises(DGCUnsupportedError):
            session(wire, caps={**CAPS, 'pips_api_version': 14}).pips.mutate('propose_pip_handoff', with_specialists, approved=True)
        self.assertFalse(wire.calls)
        result = session(wire, caps={**CAPS, 'pips_api_version': 15}).pips.mutate('propose_pip_handoff', with_specialists, approved=True)
        self.assertEqual(result['request']['action']['specialists'], {'roles': ['critic'], 'max_calls': 1})
        with self.assertRaises(DGCConfigError):
            session(caps={**CAPS, 'pips_api_version': 15}).pips.mutate('propose_pip_handoff', with_specialists)

    def test_api14_source_exceptions_require_reviewed_arguments_and_explicit_mutations(self):
        commands = {'get_pip_exception_source': {'pip_id': 'pip_a', 'run_id': 'run_a', 'finding_index': 0},
                    'list_pip_memories': {'pip_id': 'pip_a', 'before_id': 5, 'limit': 20},
                    'record_pip_exception': {'pip_id': 'pip_a', 'run_id': 'run_a', 'finding_index': 0,
                        'expected_source_digest': 'a' * 64, 'reason': 'Reviewed local exception', 'expires_at': None, 'request_key': 'one'},
                    'revoke_pip_exception': {'pip_id': 'pip_a', 'memory_id': 'memory_a', 'expected_revision': 0, 'reason': 'No longer applies'}}
        for command, params in commands.items():
            read = command in ('get_pip_exception_source', 'list_pip_memories')
            wire = Wire()
            old = session(wire, caps={**CAPS, 'pips_api_version': 13})
            with self.subTest(command=command), self.assertRaises(DGCUnsupportedError):
                old.pips.read(command, params) if read else old.pips.mutate(command, params, approved=True)
            self.assertFalse(wire.calls)
            current = session(wire, caps={**CAPS, 'pips_api_version': 14})
            if read:
                current.pips.read(command, params)
                with self.assertRaises(DGCConfigError):
                    current.pips.mutate(command, params, approved=True)
            else:
                with self.assertRaises(DGCConfigError):
                    current.pips.mutate(command, params)
                current.pips.mutate(command, params, approved=True)
            with self.assertRaises(DGCConfigError):
                forged = {**params, 'permissions': {'allow': ['Bash']}}
                current.pips.read(command, forged) if read else current.pips.mutate(command, forged, approved=True)
            self.assertEqual(len(wire.calls), 1)
            self.assertEqual(wire.calls[0][0]['request']['type'], command)

    def test_api13_inbox_reads_and_acknowledgements_require_distinct_authority(self):
        commands = {'list_pip_notifications': {'workspace_id': 'ws_a', 'limit': 20},
                    'mark_pip_notification_read': {'notification_id': 'notification_a', 'expected_revision': 0}}
        for command, params in commands.items():
            read = command == 'list_pip_notifications'
            wire = Wire()
            old = session(wire, caps={**CAPS, 'pips_api_version': 12})
            with self.subTest(command=command), self.assertRaises(DGCUnsupportedError):
                old.pips.read(command, params) if read else old.pips.mutate(command, params, approved=True)
            self.assertFalse(wire.calls)
            current = session(wire, caps={**CAPS, 'pips_api_version': 13})
            if read:
                with self.assertRaises(DGCConfigError):
                    current.pips.mutate(command, params, approved=True)
                current.pips.read(command, params)
            else:
                for _ in range(2):
                    with self.assertRaises(DGCConfigError):
                        current.pips.mutate(command, params)
                    current.pips.mutate(command, params, approved=True)
            sent = len(wire.calls)
            with self.assertRaises(DGCConfigError):
                forged = {**params, 'actor': 'forged'}
                current.pips.read(command, forged) if read else current.pips.mutate(command, forged, approved=True)
            self.assertEqual(len(wire.calls), sent)
            self.assertEqual(wire.calls[0][0]['request']['type'], command)

    def test_transport_id_is_nested_only_and_original_request_untouched(self):
        wire = Wire()
        s = session(wire)
        values = {'workspace_id': 'ws_a'}
        result = s.pips.read('list_pips', values)
        payload, response, options = wire.calls[0]
        self.assertEqual(set(payload), {'type', 'request'})
        self.assertEqual(response, 'pips_result')
        self.assertEqual(result['request']['workspace_id'], 'ws_a')
        self.assertEqual(values, {'workspace_id': 'ws_a'})
        self.assertFalse(s._outstanding)
        self.assertNotIn('request_id', values)
        s.pips.get('pip_a'); s.pips.runs('pip_a'); s.pips.get_run('run_a'); s.pips.list('ws_a')
        self.assertEqual(len({c[2]['request_id'] for c in wire.calls}), 5)

    def test_mutation_needs_exact_per_request_approval(self):
        wire = Wire(); s = session(wire)
        for value in (False, None, 1, 'true'):
            with self.subTest(value=value), self.assertRaises(DGCConfigError):
                s.pips.mutate('pause_pip', {'pip_id': 'pip_a'}, approved=value)
        with self.assertRaises(DGCConfigError):
            s.pips.mutate('pause_pip', {'pip_id': 'pip_a'})
        self.assertEqual(wire.calls, [])
        s.pips.mutate('pause_pip', {'pip_id': 'pip_a'}, approved=True)
        with self.assertRaises(DGCConfigError):
            s.pips.mutate('pause_pip', {'pip_id': 'pip_a'})
        self.assertEqual(len(wire.calls), 1)

    def test_no_enabling_starting_future_or_misclassified_commands(self):
        wire = Wire(); s = session(wire)
        for command in ('pips_enable', 'pips_runtime', 'future_control', 'run_pip'):
            with self.subTest(command=command), self.assertRaises(DGCConfigError):
                s.pips.read(command)
        for command in ('pips_enable', 'pips_runtime', 'future_control', 'list_pips'):
            with self.subTest(command=command), self.assertRaises(DGCConfigError):
                s.pips.mutate(command, {}, approved=True)
        self.assertFalse(wire.calls)

    def test_capability_missing_disabled_wrong_types_and_older_versions_refuse(self):
        for caps in ({}, {**CAPS, 'pips_supported': 1}, {**CAPS, 'pips_enabled': False},
                     {**CAPS, 'pips_api_version': 7}, {**CAPS, 'pips_api_version': True},
                     {**CAPS, 'pips_api_version': '8'}):
            wire = Wire()
            with self.subTest(caps=caps), self.assertRaises(DGCUnsupportedError):
                session(wire, caps).pips.read('list_workspaces')
            self.assertFalse(wire.calls)

    def test_api9_promotion_is_additive_and_explicit(self):
        params = {'workspace_id': 'ws_a', 'run_id': 'run_a',
                  'expected_revision': 0, 'expected_review_revision': 1}
        with self.assertRaises(DGCUnsupportedError):
            session().pips.mutate('accept_pip_execution_context', params, approved=True)
        s = session(caps={**CAPS, 'pips_api_version': 9})
        result = s.pips.mutate('accept_pip_execution_context', params, approved=True)
        self.assertEqual(result['request']['expected_review_revision'], 1)

    def test_api10_reads_require_advertisement_and_stay_reads(self):
        commands = ('get_pip_proposal', 'list_workspace_overviews', 'list_pending_pip_reviews',
                    'list_recent_workspace_activity', 'list_pip_adaptations')
        for command in commands:
            with self.subTest(command=command):
                wire = Wire()
                with self.assertRaises(DGCUnsupportedError):
                    session(wire, caps={**CAPS, 'pips_api_version': 9}).pips.read(command)
                self.assertEqual(wire.calls, [])
                params = ({'pip_id':'pip_a','proposal_id':'proposal_a'} if command=='get_pip_proposal' else {'pip_id':'pip_a'} if command == 'list_pip_adaptations' else {'limit':20})
                result = session(wire, caps={**CAPS, 'pips_api_version': 10}).pips.read(command, params)
                self.assertEqual(result['request']['type'], command)
                self.assertEqual(set(wire.calls[0][0]), {'type','request'})
                with self.assertRaises(DGCConfigError):
                    session(caps={**CAPS, 'pips_api_version': 10}).pips.mutate(command, params, approved=True)

    def test_api11_source_policy_proposals_require_advertisement(self):
        params = {'pip_id': 'pip_a', 'expected_version': 1, 'reason': 'Review source',
                  'changes': {'source_policy': {'mode': 'current_tree', 'exclusions': 'safe_source_v1'},
                              'schedule': None, 'event_trigger': None}}
        for version in (8, 9, 10):
            wire = Wire()
            with self.assertRaises(DGCUnsupportedError):
                session(wire, caps={**CAPS, 'pips_api_version': version}).pips.mutate('propose_pip_update', params, approved=True)
            self.assertFalse(wire.calls)
        result = session(caps={**CAPS, 'pips_api_version': 11}).pips.mutate('propose_pip_update', params, approved=True)
        self.assertEqual(result['request']['changes'], params['changes'])
        # Existing metadata proposals keep their older runtime contract.
        legacy = {**params, 'changes': {'name': 'Reviewed label'}}
        self.assertEqual(session().pips.mutate('propose_pip_update', legacy, approved=True)['request']['changes'], legacy['changes'])

    def test_api12_session_statement_reads_and_mutations_stay_separate(self):
        commands = {'list_workspace_sessions': {'workspace_id': 'ws_a', 'after': '', 'limit': 20},
            'inspect_workspace_session_outcome': {'workspace_id': 'ws_a', 'session_id': 'session_a'},
            'get_workspace_session_outcome': {'workspace_id': 'ws_a', 'proposal_id': 'outcome_a'},
            'list_workspace_session_outcomes': {'workspace_id': 'ws_a', 'limit': 20},
            'propose_workspace_session_outcome': {'workspace_id': 'ws_a', 'session_id': 'session_a',
                'title': 'Decision', 'statement': 'This is my statement, not execution evidence.',
                'source': {'kind': 'commit', 'revision': 'a' * 40}, 'expected_session_revision': 3, 'request_key': 'one'},
            'accept_workspace_session_outcome': {'workspace_id': 'ws_a', 'proposal_id': 'outcome_a',
                'expected_digest': 'a' * 64, 'expected_context_revision': 0},
            'reject_workspace_session_outcome': {'workspace_id': 'ws_a', 'proposal_id': 'outcome_a', 'expected_digest': 'a' * 64}}
        for command, params in commands.items():
            read = command in READ_COMMANDS
            wire = Wire()
            old = session(wire, caps={**CAPS, 'pips_api_version': 11})
            with self.subTest(command=command), self.assertRaises(DGCUnsupportedError):
                old.pips.read(command, params) if read else old.pips.mutate(command, params, approved=True)
            self.assertFalse(wire.calls)
            current = session(wire, caps={**CAPS, 'pips_api_version': 12})
            if not read:
                with self.assertRaises(DGCConfigError): current.pips.mutate(command, params)
                self.assertFalse(wire.calls)
                result = current.pips.mutate(command, params, approved=True)
            else:
                with self.assertRaises(DGCConfigError): current.pips.mutate(command, params, approved=True)
                result = current.pips.read(command, params)
            self.assertEqual(result['request']['type'], command)
            with self.assertRaises(DGCConfigError):
                current.pips.read(command, {**params, 'session_path': '/outside'}) if read else current.pips.mutate(
                    command, {**params, 'session_path': '/outside'}, approved=True)
            self.assertEqual(len(wire.calls), 1)

    def test_policy_and_sandbox_are_not_bypassed_by_host_approval(self):
        for kwargs in ({'isolated': True}, {'policy': RuntimePolicy()},
                       {'sandbox': SandboxStatus(requirement='required')},
                       {'sandbox': SandboxStatus(requirement='preferred')},
                       {'sandbox': SandboxStatus(active=True)}):
            wire = Wire(); s = session(wire, **kwargs)
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(DGCUnsupportedError):
                    s.pips.read('list_workspaces')
                with self.assertRaises(DGCUnsupportedError):
                    s.pips.mutate('run_pip', {'pip_id': 'pip_a', 'idempotency_key': 'once'}, approved=True)
                self.assertFalse(wire.calls)
        s = session(permission_mode='plan')
        s.pips.read('list_workspaces')
        with self.assertRaises(DGCUnsupportedError):
            s.pips.mutate('run_pip', {'pip_id': 'pip_a', 'idempotency_key': 'once'}, approved=True)

    def test_unknown_reserved_and_non_json_parameters_refuse_before_transport(self):
        cyclic = {}; cyclic['changes'] = cyclic
        deep = []
        for _ in range(14): deep = [deep]
        invalid = [{'request_id': 'forged'}, {'type': 'run_pip'}, {'api_key': 'secret'},
                   {'workspace_id': '\ud800'}, {'workspace_id': 'x' * 40000},
                   {'workspace_id': float('nan')}, {'workspace_id': 2**54},
                   {'workspace_id': object()}, {'workspace_id': deep}, cyclic,
                   {'workspace_id': list(range(2049))}, []]
        wire = Wire(); s = session(wire)
        for params in invalid:
            with self.subTest(kind=type(params)), self.assertRaises(DGCConfigError):
                s.pips.read('list_pips', params)
        self.assertFalse(wire.calls)

    def test_unicode_request_byte_limit_and_defensive_detach(self):
        wire = Wire(); s = session(wire)
        params = {'pip_id': 'pip_a', 'changes': {'goal': '\u754c' * 12000}, 'expected_version': 1, 'reason': 'review'}
        with self.assertRaises(DGCConfigError):
            s.pips.mutate('propose_pip_update', params, approved=True)
        params['changes']['goal'] = 'new goal'
        s.pips.mutate('propose_pip_update', params, approved=True)
        params['changes']['goal'] = 'changed later'
        self.assertEqual(wire.calls[0][0]['request']['changes']['goal'], 'new goal')

    def test_response_requires_matching_id_command_boolean_and_object(self):
        for changes in ({'request_id': 'wrong'}, {'command': 'run_pip'}, {'ok': 1},
                        {'result': None}, {'result': []}, {'ok': False, 'error': {}},
                        {'ok': False, 'error': {'code': 2, 'message': 'failure'}}):
            wire = Wire(); wire.transform = lambda event, changes=changes: {**event, **changes}
            with self.subTest(changes=changes), self.assertRaises(DGCProtocolError):
                session(wire).pips.read('list_workspaces')

    def test_structured_backend_failure_and_timeout_keep_types_and_cleanup(self):
        wire = Wire()
        wire.transform = lambda event: {**event, 'ok': False, 'error': {'code': 'stale_version', 'message': 'Review again'}}
        s = session(wire)
        with self.assertRaises(DGCCommandRejectedError) as caught:
            s.pips.mutate('pause_pip', {'pip_id': 'pip_a'}, approved=True)
        self.assertEqual((caught.exception.reason, caught.exception.command), ('stale_version', 'pause_pip'))
        self.assertFalse(s._outstanding)
        with mock.patch.object(wire, 'request', side_effect=DGCEventTimeout('fixture timeout')):
            with self.assertRaises(DGCTimeoutError): s.pips.read('list_workspaces')
        self.assertFalse(s._outstanding)

    def test_non_pip_correlation_unchanged(self):
        wire = Wire(); s = session(wire)
        event = s._request({'type': 'list_sessions'}, 'sessions')
        self.assertIn('request_id', wire.calls[0][0])
        self.assertNotIn('request_id', wire.calls[0][2])
        self.assertEqual(event['request_id'], wire.calls[0][0]['request_id'])

    def test_sdk_allowlist_tracks_current_runtime_fields(self):
        from dgc.pips import _COMMAND_ARGS
        self.assertEqual({k: set(v) for k, v in COMMAND_FIELDS.items()}, _COMMAND_ARGS)
        self.assertFalse(READ_COMMANDS & MUTATION_COMMANDS)
        self.assertEqual(READ_COMMANDS | MUTATION_COMMANDS, set(COMMAND_FIELDS))

    def test_async_read_mutate_and_errors_match_sync(self):
        async def exercise():
            s = AsyncSession(session())
            self.assertEqual((await s.pips.list('ws_a'))['request']['workspace_id'], 'ws_a')
            await s.pips.get('pip_a'); await s.pips.runs('pip_a'); await s.pips.get_run('run_a')
            with self.assertRaises(DGCConfigError):
                await s.pips.mutate('pause_pip', {'pip_id': 'pip_a'})
            value = await s.pips.mutate('pause_pip', {'pip_id': 'pip_a'}, approved=True)
            self.assertEqual(value['request']['type'], 'pause_pip')
        asyncio.run(exercise())


FAKE = r'''
import json, sys
seq = 0
def emit(kind, **fields):
    global seq
    print(json.dumps({'type': kind, 'seq': seq, **fields}), flush=True)
    seq += 1
emit('ready', version='fixture', protocol_version=14,
     capabilities={'pips_supported':True,'pips_api_version':8,'pips_enabled':True},
     model='fixture', mode='default', think='off', base_url='http://127.0.0.1:1/v1',
     workspace_trusted=False, commands=[],custom_commands=[],goal={'text':'','status':'none'},context_size=32768)
pending = []
for line in sys.stdin:
    cmd = json.loads(line)
    if cmd['type'] == 'shutdown': break
    assert set(cmd) == {'type', 'request'}
    pending.append(cmd['request'])
    if len(pending) == 2:
        emit('info', message='unrelated event retained')
        for r in reversed(pending):
            if r['pip_id'] == 'rejected_command':
                emit('command_rejected', request_id=r['request_id'], command='pips_control',
                     reason='session_policy', message='policy fixture')
            elif r['pip_id'] == 'rejected_control':
                emit('pips_result', request_id=r['request_id'], command=r['type'], ok=False,
                     error={'code':'not_found','message':'control fixture'})
            else:
                emit('pips_result', request_id=r['request_id'], command=r['type'], ok=True,
                     result={'pip_id':r['pip_id']})
        pending=[]
'''


class NestedWireTests(unittest.TestCase):
    def test_authorized_inherited_controller_roundtrips_real_backend_without_network_or_config_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); home = root / 'profile'; home.mkdir(mode=0o700)
            workspace = root / 'workspace'; workspace.mkdir()
            (home / '.dgc').mkdir(mode=0o700)
            cfg = home / '.dgc' / 'config.json'
            cfg.write_text(json.dumps({'model': 'fixture', 'base_url': 'http://127.0.0.1:1/v1',
                'pips_enabled': True, 'sandbox': False, 'mcp_servers': {}, 'hooks': {},
                'artifact_autostart': False, 'notify': 'off', 'suggest': False}))
            cfg.chmod(0o600); original = cfg.read_bytes()
            network_marker = root / 'network-attempt'
            bootstrap = (
                f'import sys; sys.path.insert(0, {str(ROOT)!r})\n'
                'import socket\n'
                f'def refuse(*args, **kwargs):\n from pathlib import Path\n Path({str(network_marker)!r}).write_text("unexpected network")\n raise AssertionError("network forbidden")\n'
                'socket.socket.connect = refuse\nsocket.create_connection = refuse\n'
                'from dgc.cli import main\nsys.argv = ["dgc", "serve"]\nmain()\n')
            with DGC(runtime=[sys.executable, '-c', bootstrap], inherit_user_state=True,
                     sandbox='off', extra_env={'DGC_HOME': str(home)}) as dgc:
                with dgc.session(cwd=workspace) as s:
                    self.assertEqual(s._ready['capabilities']['session_policy']['digest'], '')
                    value = s.pips.read('list_workspaces')
                    self.assertIn('workspaces', value)
                    self.assertEqual(len(value['workspaces']), 2)
                    self.assertEqual(sum(w['kind'] == 'personal' for w in value['workspaces']), 1)
                    self.assertEqual(s.pips.read('list_workspace_overviews')['total_workspaces'], 2)
                    self.assertEqual(s.pips.read('list_pending_pip_reviews')['reviews'], [])
                    self.assertIn('events', s.pips.read('list_recent_workspace_activity', {'limit':20}))
                    self.assertEqual(s.pips.read('get_pip_runner')['runner']['online'], False)
            self.assertEqual(cfg.read_bytes(), original)
            self.assertFalse(network_marker.exists())
            self.assertFalse((home / '.dgc' / 'pips' / 'runs').exists())

    def test_parallel_same_command_reverse_replies_keep_correct_owner(self):
        # Real NDJSON transport and threads, ordered by protocol messages, never timing.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'runtime.py'; path.write_text(FAKE)
            with DGCClient([sys.executable, str(path)], cwd=directory) as wire:
                s = session(wire)
                with ThreadPoolExecutor(max_workers=2) as pool:
                    a = pool.submit(s.pips.get, 'pip_a'); b = pool.submit(s.pips.get, 'pip_b')
                    self.assertEqual(a.result(timeout=10), {'pip_id': 'pip_a'})
                    self.assertEqual(b.result(timeout=10), {'pip_id': 'pip_b'})
                    a = pool.submit(s.pips.get, 'rejected_command')
                    b = pool.submit(s.pips.get, 'rejected_control')
                    for future, reason in ((a, 'session_policy'), (b, 'not_found')):
                        with self.assertRaises(DGCCommandRejectedError) as caught:
                            future.result(timeout=10)
                        self.assertEqual(caught.exception.reason, reason)
                self.assertFalse(s._outstanding)
                self.assertEqual(wire.next_event(timeout=1)['type'], 'ready')
                self.assertEqual(wire.next_event(timeout=1)['message'], 'unrelated event retained')


if __name__ == '__main__': unittest.main()
