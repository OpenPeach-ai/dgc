"""API24 reply controls: offline SDK authority, compatibility and async parity."""
import asyncio
import copy
import unittest

from test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import AsyncSession, DGCCommandRejectedError, DGCConfigError, DGCUnsupportedError, RuntimePolicy
from dgc_sdk.pips import COMMAND_FIELDS
from dgc_sdk.types import SandboxStatus

CURRENT = {**CAPS, 'pips_api_version': 25}
MESSAGE = {'pip_id': 'pip_rook', 'text': 'Explain this source excerpt.', 'idempotency_key': 'same-message'}
OPTIONS = {'context_size': 8192, 'thinking': 'medium'}


class PipChatOptionsSDKTests(unittest.TestCase):
    def test_large_context_requires_api25_but_api24_small_context_remains_supported(self):
        wire = Wire(); old = session(wire, caps={**CAPS, 'pips_api_version': 24})
        for size in (32769, 65536, 1048576):
            with self.subTest(size=size), self.assertRaisesRegex(DGCUnsupportedError, 'API 25'):
                old.pips.mutate('send_pip_message', {**MESSAGE, 'chat_options': {**OPTIONS, 'context_size': size}}, approved=True)
        self.assertFalse(wire.calls)
        old.pips.mutate('send_pip_message', {**MESSAGE, 'chat_options': OPTIONS}, approved=True)
        self.assertEqual(len(wire.calls), 1)

    def test_send_fields_match_runtime_and_options_are_optional_only_at_outer_level(self):
        from dgc.pips import _COMMAND_ARGS
        self.assertEqual(COMMAND_FIELDS['send_pip_message'], _COMMAND_ARGS['send_pip_message'])
        self.assertEqual(COMMAND_FIELDS['send_pip_message'], {'pip_id', 'text', 'idempotency_key', 'chat_options', 'images', 'files', 'spooled_images', 'spooled_files'})
        self.assertNotIn('chat_options', COMMAND_FIELDS['list_pip_messages'])

    def test_option_presence_requires_api24_but_absent_message_keeps_api8_gate(self):
        for version in (8, 12, 22, 23):
            wire = Wire(); current = session(wire, caps={**CAPS, 'pips_api_version': version})
            for options in (OPTIONS, {}, None):
                with self.subTest(version=version, options=options), self.assertRaisesRegex(DGCUnsupportedError, 'API 24'):
                    current.pips.mutate('send_pip_message', {**MESSAGE, 'chat_options': options}, approved=True)
            self.assertFalse(wire.calls)
            result = current.pips.mutate('send_pip_message', MESSAGE, approved=True)
            self.assertNotIn('chat_options', result['request'])
            self.assertEqual(result['request']['idempotency_key'], MESSAGE['idempotency_key'])
            self.assertEqual(len(wire.calls), 1)

    def test_images_require_api43_and_must_be_image_data_uris(self):
        dot = 'data:image/png;base64,iVBORw0KGgo='
        wire = Wire(); old = session(wire, caps={**CAPS, 'pips_api_version': 42})
        with self.assertRaisesRegex(DGCUnsupportedError, 'API 43'):
            old.pips.mutate('send_pip_message', {**MESSAGE, 'images': [dot]}, approved=True)
        self.assertFalse(wire.calls)
        current = session(wire, caps={**CAPS, 'pips_api_version': 43})
        for images in (None, [], dot, [dot] * 5, ['https://example.com/a.png'], [1]):
            with self.subTest(images=images), self.assertRaises(DGCConfigError):
                current.pips.mutate('send_pip_message', {**MESSAGE, 'images': images}, approved=True)
        self.assertFalse(wire.calls)
        answer = current.pips.mutate('send_pip_message', {**MESSAGE, 'text': '', 'images': [dot]}, approved=True)
        self.assertEqual(answer['request']['images'], [dot])
        self.assertEqual(len(wire.calls), 1)
        photo = 'data:image/png;base64,' + 'A' * 1_900_000
        answer = current.pips.mutate('send_pip_message', {**MESSAGE, 'images': [photo]}, approved=True)
        self.assertEqual(answer['request']['images'], [photo], 'a photo-sized image is not held to the 32 KiB budget')
        for params in ({**MESSAGE, 'images': [photo, photo]}, {**MESSAGE, 'text': 'x' * 40000, 'images': [photo]}):
            with self.assertRaises(DGCConfigError):
                current.pips.mutate('send_pip_message', params, approved=True)
        self.assertEqual(len(wire.calls), 2)

    def test_files_require_api43_share_the_2_mb_budget_and_keep_plain_names(self):
        note = {'name': 'notes.txt', 'data': 'data:text/plain;base64,aGk='}
        wire = Wire(); old = session(wire, caps={**CAPS, 'pips_api_version': 42})
        with self.assertRaisesRegex(DGCUnsupportedError, 'API 43'):
            old.pips.mutate('send_pip_message', {**MESSAGE, 'files': [note]}, approved=True)
        current = session(wire, caps={**CAPS, 'pips_api_version': 43})
        for files in (None, [], [note] * 5, [{'name': '../x.txt', 'data': note['data']}], [{'name': 'a.txt'}],
                      [{'name': 'a.txt', 'data': 'https://example.com'}], [{**note, 'extra': 1}]):
            with self.subTest(files=files), self.assertRaises(DGCConfigError):
                current.pips.mutate('send_pip_message', {**MESSAGE, 'files': files}, approved=True)
        half = 'data:text/plain;base64,' + 'A' * 1_500_000
        with self.assertRaises(DGCConfigError):
            current.pips.mutate('send_pip_message', {**MESSAGE, 'files': [{'name': 'a.txt', 'data': half}],
                                                     'images': ['data:image/png;base64,' + 'A' * 1_500_000]}, approved=True)
        self.assertFalse(wire.calls)
        answer = current.pips.mutate('send_pip_message', {**MESSAGE, 'text': '', 'files': [{'name': 'a.txt', 'data': half}]}, approved=True)
        self.assertEqual(answer['request']['files'], [{'name': 'a.txt', 'data': half}])
        self.assertEqual(len(wire.calls), 1)

    def test_exact_choices_and_boundary_values_forward_detached_once(self):
        wire = Wire(); current = session(wire, caps=CURRENT)
        for size in (2048, 8192, 32768, 65536, 131072, 1048576):
            for thinking in ('off', 'low', 'medium', 'high', 'xhigh'):
                params = {**MESSAGE, 'chat_options': {'context_size': size, 'thinking': thinking}}
                before = copy.deepcopy(params)
                answer = current.pips.mutate('send_pip_message', params, approved=True)
                params['chat_options']['context_size'] = 2049
                self.assertEqual(answer['request']['chat_options'], before['chat_options'])
                self.assertEqual(wire.calls[-1][0]['request']['chat_options'], before['chat_options'])
                self.assertEqual(answer['request']['idempotency_key'], 'same-message')
        self.assertEqual(len(wire.calls), 30)

    def test_invalid_options_fail_before_transport_without_normalization(self):
        wire = Wire(); current = session(wire, caps=CURRENT)
        invalid = [None, {}, [], 'high', {'thinking': 'off'}, {'context_size': 8192},
                   *({'context_size': size, 'thinking': 'off'} for size in (True, False, 2048.0, '8192', 2047, 1048577, -1)),
                   *({'context_size': 8192, 'thinking': level} for level in (None, True, 1, [], 'HIGH', 'max')),
                   *({**OPTIONS, field: 'forged'} for field in ('permissions', 'mode', 'model', 'base_url', 'api_key', 'actor', 'max_tokens'))]
        for options in invalid:
            with self.subTest(options=options), self.assertRaises(DGCConfigError):
                current.pips.mutate('send_pip_message', {**MESSAGE, 'chat_options': options}, approved=True)
        self.assertFalse(wire.calls)

    def test_options_do_not_bypass_approval_plan_policy_or_isolation(self):
        params = {**MESSAGE, 'chat_options': OPTIONS}
        wire = Wire(); current = session(wire, caps=CURRENT)
        for approved in (False, 1, 'true', None):
            with self.assertRaises(DGCConfigError):
                current.pips.mutate('send_pip_message', params, approved=approved)
        for restrictions in ({'isolated': True}, {'policy': RuntimePolicy()}, {'permission_mode': 'plan'},
                             {'sandbox': SandboxStatus(requirement='required')}, {'sandbox': SandboxStatus(active=True)}):
            restricted = session(wire, caps=CURRENT, **restrictions)
            with self.subTest(restrictions=restrictions), self.assertRaises(DGCUnsupportedError):
                restricted.pips.mutate('send_pip_message', params, approved=True)
        for caps in ({**CURRENT, 'pips_enabled': False}, {**CURRENT, 'pips_supported': False},
                     {**CURRENT, 'pips_api_version': True}, {**CURRENT, 'pips_api_version': '24'}):
            with self.subTest(caps=caps), self.assertRaises(DGCUnsupportedError):
                session(wire, caps=caps).pips.mutate('send_pip_message', params, approved=True)
        self.assertFalse(wire.calls)

    def test_list_messages_keeps_legacy_gate_and_preserves_additive_metadata(self):
        metadata = {'version': 1, 'mode': 'read_only', 'options': OPTIONS, 'options_source': 'last_message',
                    'inherited_context_size': 131072, 'effective_context_size': 8192, 'context_min': 2048,
                    'context_max': 32768, 'context_note': 'Bounded reply context, not a job change.',
                    'thinking_levels': ['off', 'low', 'medium', 'high', 'xhigh'],
                    'reasoning_control': 'provider_dependent', 'reasoning_note': 'Provider mappings vary.'}
        wire = Wire()
        wire.transform = lambda event: {**event, 'result': {'messages': [], 'chat_controls': metadata}}
        self.assertEqual(session(wire, caps=CURRENT).pips.read('list_pip_messages', {'pip_id': 'pip_rook'})['chat_controls'], metadata)
        wire.transform = lambda event: {**event, 'result': {'messages': []}}
        self.assertEqual(session(wire).pips.read('list_pip_messages', {'pip_id': 'pip_rook'}), {'messages': []})
        self.assertEqual(len(wire.calls), 2)

    def test_backend_refusal_never_retries_or_discards_the_reviewed_options(self):
        wire = Wire()
        wire.transform = lambda event: {**event, 'ok': False,
            'error': {'code': 'idempotency_conflict', 'message': 'This key names a different reply request.'}}
        with self.assertRaises(DGCCommandRejectedError) as caught:
            session(wire, caps=CURRENT).pips.mutate('send_pip_message', {**MESSAGE, 'chat_options': OPTIONS}, approved=True)
        self.assertEqual(caught.exception.reason, 'idempotency_conflict')
        self.assertEqual(len(wire.calls), 1)
        self.assertEqual(wire.calls[0][0]['request']['chat_options'], OPTIONS)
        self.assertEqual(wire.calls[0][0]['request']['idempotency_key'], MESSAGE['idempotency_key'])

    def test_async_preserves_optional_gate_approval_and_exact_options(self):
        async def exercise():
            wire = Wire(); old = AsyncSession(session(wire, caps={**CAPS, 'pips_api_version': 23}))
            params = {**MESSAGE, 'chat_options': OPTIONS}
            with self.assertRaises(DGCUnsupportedError): await old.pips.mutate('send_pip_message', params, approved=True)
            self.assertFalse(wire.calls)
            await old.pips.mutate('send_pip_message', MESSAGE, approved=True)
            current = AsyncSession(session(wire, caps=CURRENT))
            with self.assertRaises(DGCConfigError): await current.pips.mutate('send_pip_message', params)
            result = await current.pips.mutate('send_pip_message', params, approved=True)
            self.assertEqual(result['request']['chat_options'], OPTIONS)
            self.assertEqual(len(wire.calls), 2)
        asyncio.run(exercise())


if __name__ == '__main__':
    unittest.main()
