"""Inference choices for one Pip reply, independent of its approved job.

No modes, tools, endpoints or credentials are accepted here. Saved immutable run
manifests provide last-used UI defaults; they are not standing job permissions.
"""
from __future__ import annotations

import json

from .workspace_registry import RegistryError

CONTEXT_MIN = 2048
CONTEXT_MAX = 1048576
CONTEXT_DEFAULT = 32768
THINKING_LEVELS = ('off', 'low', 'medium', 'high', 'xhigh')
OUTPUT_CAP = 4096
_REASONING_BUDGET = {'off': 2048, 'low': 512, 'medium': 1024, 'high': 1536, 'xhigh': 2048}


def validate(value):
    if (type(value) is not dict or set(value) != {'context_size', 'thinking'}
            or type(value['context_size']) is not int
            or not CONTEXT_MIN <= value['context_size'] <= CONTEXT_MAX
            or type(value['thinking']) is not str or value['thinking'] not in THINKING_LEVELS):
        raise RegistryError('invalid_chat_options',
                            'Pip reply options require context_size from 2048 to 1048576 and thinking off, low, medium, high or xhigh. Permissions and job settings cannot be changed here.')
    return {'context_size': value['context_size'], 'thinking': value['thinking']}


def inherited_context(config):
    value = config.get('context_size', CONTEXT_DEFAULT)
    if type(value) is not int or not CONTEXT_MIN <= value <= 2**53 - 1:
        return CONTEXT_DEFAULT
    return value


def apply(settings, options, config):
    selected = validate(options)
    overrides = config.get('provider_capabilities', {})
    overrides = overrides if isinstance(overrides, dict) else {}
    return {**settings, **selected,
            'think_budget_tokens': _REASONING_BUDGET[selected['thinking']],
            'provider_capabilities': {key: overrides[key] for key in ('reasoning', 'max_output_tokens')
                                      if type(overrides.get(key)) is bool}}


def validate_manifest(manifest):
    if 'chat_options' not in manifest:
        return None
    options = validate(manifest['chat_options'])
    settings = manifest.get('model_settings')
    if (manifest.get('run_kind') != 'conversation' or type(settings) is not dict
            or any(settings.get(key) != value for key, value in options.items())
            or settings.get('think_budget_tokens') != _REASONING_BUDGET[options['thinking']]
            or type(settings.get('provider_capabilities')) is not dict
            or set(settings['provider_capabilities']) - {'reasoning', 'max_output_tokens'}
            or any(type(v) is not bool for v in settings['provider_capabilities'].values())
            or settings.get('max_tokens') != OUTPUT_CAP
            or settings.get('max_turns') not in (12, 30)):      # pips.STEPS, COMPUTER_STEPS
        raise RegistryError('invalid_chat_options', 'Saved reply options do not match the pinned conversation limits.')
    return options


def bind_client(client):
    """Keep reasoning inside the existing request cap, including provider retries.

The normal provider adapter adds reasoning allowance to max_tokens. Pip reply
controls select effort without increasing that pre-existing output ceiling.
"""
    from .llm import LLMError
    feature_supported = client._feature_supported
    mark_rejected = client._mark_rejected
    def bounded_feature(feature):
        supported = feature_supported(feature)
        if feature == 'max_output_tokens' and not supported:
            raise LLMError('This model connection does not support the output-token cap required for a bounded Pip reply.')
        return supported
    def bounded_rejection(feature, ttl_s=None):
        if feature == 'max_output_tokens':
            # The ordinary interactive adapters retry unsupported caps without
            # the field. A bounded Pip reply must stop before that retry.
            raise LLMError('The model connection rejected the Pip reply output-token cap. No uncapped request was sent.')
        return mark_rejected(feature, ttl_s)
    bounded_feature('max_output_tokens')
    client._feature_supported = bounded_feature
    client._mark_rejected = bounded_rejection
    request_max = client._request_max_tokens
    client._request_max_tokens = lambda level, base=None: min(OUTPUT_CAP, request_max(level, base))
    return client


def controls(store, pip_id, config):
    pip = store._job(pip_id)
    requested = inherited_context(config)
    options = {'context_size': min(CONTEXT_MAX, requested), 'thinking': 'off'}
    source = 'default'
    row = store.db.execute('''SELECT r.id,length(CAST(r.manifest AS BLOB)) AS size
        FROM pip_chat_messages m JOIN pip_runs r ON r.id=m.run_id
        WHERE m.pip_id=? AND m.role='user' ORDER BY m.seq DESC LIMIT 1''', (pip_id,)).fetchone()
    if row is not None:
        if row['size'] is None or row['size'] > 128 * 1024:
            raise RegistryError('stored_data_limit', 'The saved reply manifest exceeds its read budget.')
        manifest = json.loads(store.db.execute('SELECT manifest FROM pip_runs WHERE id=?', (row['id'],)).fetchone()[0])
        if manifest.get('pip_id') != pip_id or manifest.get('workspace_id') != pip['workspace_id']:
            raise RegistryError('invalid_history', 'Saved reply controls belong to another Pip.')
        selected = validate_manifest(manifest)
        if selected is not None:
            options, source = selected, 'last_message'
    reasoning = 'provider_dependent'
    note = ('Requested effort uses DGC’s provider mappings. Some models only support on/off, '
            'map levels differently, or use instruction guidance. Reasoning and answer share '
            'the 4096-token request cap; the existing time and tool limits still apply.')
    # Cached capability inspection only. Opening a conversation must not perform
    # provider discovery or contact a model endpoint on the editor command thread.
    try:
        from .llm import LLMClient
        from .pip_models import _connection, _model_id
        base, mode = _connection(config)
        choice = pip.get('model_choice', {'mode': 'default'})
        model = _model_id(choice['model'] if choice.get('mode') == 'model' else config.get('model', ''))
        client = LLMClient(base, '', model, api_mode=mode,
                           provider_capabilities=config.get('provider_capabilities', {}))
        if client.capability_snapshot().get('reasoning_control') == 'instructions':
            reasoning = 'instructions'
            note = ('This model has no advertised native reasoning control. Effort adds instruction '
                    'guidance only; it does not enable hidden reasoning. The existing output, time '
                    'and tool limits still apply.')
    except (RegistryError, ValueError, TypeError):
        pass  # An unavailable connection remains unavailable at send time.
    return {'version': 1, 'mode': 'read_only', 'options': options, 'options_source': source,
            'inherited_context_size': requested, 'effective_context_size': options['context_size'],
            'context_min': CONTEXT_MIN, 'context_max': CONTEXT_MAX,
            'context_note': ('Reply context budget; the provider may apply a smaller limit. '
                             'A saved continuation brief plus recent complete messages carries context between replies. '
                             'Older messages are summarized, not deleted. Briefs are lossy; open Conversation continuity '
                             'to inspect coverage and fallback status. DGC also auto-compacts within each reply. '
                             'These choices do not change scheduled jobs.'),
            'thinking_levels': list(THINKING_LEVELS), 'reasoning_control': reasoning,
            'reasoning_note': note}
