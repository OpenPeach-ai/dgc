"""A Pip's inference choices: its context window and how much it thinks, independent of its approved job.

Chosen in the Pip's prompt box, as DGC's own and ChatDGC's are, and kept per Pip (founder, 2026-10-14): they
apply to its chat replies and to everything it does on its own (schedules, routines, triggers, tasks, handoffs).
A new Pip starts with main DGC's context window and thinking off. No modes, tools, endpoints or credentials are
accepted here; these are not standing job permissions.

A Pip run keeps going: no step limit, no time limit and no small output cap. Its requests use main DGC's output
budget (`max_tokens`), it compacts as any DGC session does when its window fills, and it ends when its work is
done, when the user stops it, or when the Agent's loop guards see it repeating itself.
"""
from __future__ import annotations

import json

from .workspace_registry import RegistryError

CONTEXT_MIN = 2048
CONTEXT_MAX = 1048576
CONTEXT_DEFAULT = 32768
THINKING_LEVELS = ('off', 'low', 'medium', 'high', 'xhigh')
OUTPUT_CAP = 4096          # helper requests only (a chat brief, a report reformat): bind_client
SAVED = 'pip_chat_options:'   # + pip id, in registry metadata: the Pip's own choices
_REASONING_BUDGET = {'off': 2048, 'low': 512, 'medium': 1024, 'high': 1536, 'xhigh': 2048}


def validate(value):
    if (type(value) is not dict or set(value) != {'context_size', 'thinking'}
            or type(value['context_size']) is not int
            or not CONTEXT_MIN <= value['context_size'] <= CONTEXT_MAX
            or type(value['thinking']) is not str or value['thinking'] not in THINKING_LEVELS):
        raise RegistryError('invalid_chat_options',
                            'Pip reply options require context_size from 2048 to 1048576 and thinking off, low, medium, high or xhigh. Permissions and job settings cannot be changed here.')
    return {'context_size': value['context_size'], 'thinking': value['thinking']}


def window_words(tokens) -> str:
    """64K for 65,536 tokens, 1M for 1,048,576; the exact count when it is not a whole number of K."""
    if tokens == CONTEXT_MAX:
        return "1M"
    return f"{tokens // 1024:,}K" if tokens % 1024 == 0 else f"{tokens:,}"


def inherited_context(config):
    value = config.get('context_size', CONTEXT_DEFAULT)
    if type(value) is not int or not CONTEXT_MIN <= value <= 2**53 - 1:
        return CONTEXT_DEFAULT
    return value


def saved(db, pip_id):
    """The Pip's own choices, or None when it has none yet. Takes a registry's database."""
    row = db.execute('SELECT value FROM metadata WHERE key=?', (SAVED + pip_id,)).fetchone()
    if row is None:
        return None
    try:
        return validate(json.loads(row[0]))
    except (RegistryError, ValueError, TypeError):
        return None


def save(registry, pip_id, options) -> dict:
    """Keep these as the Pip's choices (its prompt box, or a reply sent with them)."""
    selected = validate(options)
    if registry.db.execute('SELECT 1 FROM pips WHERE id=?', (pip_id,)).fetchone() is None:
        raise RegistryError('not_found', 'Pip not found on this runner.')
    import contextlib
    with contextlib.nullcontext() if registry.db.in_transaction else registry.transaction():
        registry.db.execute('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                            (SAVED + pip_id, json.dumps(selected, sort_keys=True)))
    return selected


def apply(settings, options, config):
    selected = validate(options)
    overrides = config.get('provider_capabilities', {})
    overrides = overrides if isinstance(overrides, dict) else {}
    return {**settings, **selected,
            'think_budget_tokens': _REASONING_BUDGET[selected['thinking']],
            'provider_capabilities': {key: overrides[key] for key in ('reasoning', 'max_output_tokens')
                                      if type(overrides.get(key)) is bool}}


def validate_manifest(manifest):
    """A reply's pinned options, checked against the settings it ran with. Replies from before runs kept going
    pinned 4096 output tokens and 12 or 30 steps; replies since pin main DGC's output budget and no step limit."""
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
            or type(settings.get('max_tokens')) is not int or settings['max_tokens'] < 1
            or type(settings.get('max_turns')) is not int or settings['max_turns'] < 0):
        raise RegistryError('invalid_chat_options', 'Saved reply options do not match the settings the reply ran with.')
    return options


def bind_client(client):
    """Keep a helper request (a chat brief, a report reformat) inside its small output cap, including provider
retries. Never the Pip's run itself, which has main DGC's output budget.

The normal provider adapter adds reasoning allowance to max_tokens; a helper keeps it inside the cap.
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
    own = saved(store.db, pip_id)
    # The Pip's own choices. Reported as 'last_message', the remembered choice editors since API 24 know.
    row = None if own is not None else store.db.execute('''SELECT r.id,length(CAST(r.manifest AS BLOB)) AS size
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
    if own is not None:
        options, source = own, 'last_message'
    reasoning = 'provider_dependent'
    note = ('Requested effort uses DGC’s provider mappings. Some models only support on/off, '
            'map levels differently, or use instruction guidance.')
    # Cached capability inspection only. Opening a conversation must not perform
    # provider discovery or contact a model endpoint on the editor command thread.
    try:
        from .llm import LLMClient
        from .pip_models import _connection, _model_id, default_model
        base, mode = _connection(config)
        choice = pip.get('model_choice', {'mode': 'default'})
        model = _model_id(choice['model'] if choice.get('mode') == 'model' else default_model(config))
        client = LLMClient(base, '', model, api_mode=mode,
                           provider_capabilities=config.get('provider_capabilities', {}))
        if client.capability_snapshot().get('reasoning_control') == 'instructions':
            reasoning = 'instructions'
            note = ('This model has no advertised native reasoning control. Effort adds instruction '
                    'guidance only; it does not enable hidden reasoning.')
    except (RegistryError, ValueError, TypeError):
        pass  # An unavailable connection remains unavailable at send time.
    return {'version': 1, 'mode': 'read_only', 'options': options, 'options_source': source,
            'inherited_context_size': requested, 'effective_context_size': options['context_size'],
            'context_min': CONTEXT_MIN, 'context_max': CONTEXT_MAX,
            'context_note': ('This Pip’s context window, for its replies and the work it does on its own; the provider '
                             'may apply a smaller limit. A saved continuation brief plus recent complete messages '
                             'carries context between replies; older messages are summarized, not deleted. It '
                             'auto-compacts as DGC does when the window fills.'),
            'thinking_levels': list(THINKING_LEVELS), 'reasoning_control': reasoning,
            'reasoning_note': note}


def context_estimate(store, pip_id, config, context_size=None) -> dict:
    """How much of the context window this chat takes in the next reply: its brief and the recent
    messages that fit, as the reply itself prepares them, and what its last reply measured besides (its
    instructions, tools, job, memory, skills, apps and references), part by part in `breakdown`
    (dgc/context_breakdown.py's shape). Read-only; about four bytes a token."""
    pip = store._job(pip_id)
    if pip['source_policy'] != {'mode': 'personal'}:
        raise RegistryError('invalid_request', 'Context use is shown for Personal Pips.')
    size = controls(store, pip_id, config)['options']['context_size'] if context_size is None else context_size
    if type(size) is not int or not CONTEXT_MIN <= size <= CONTEXT_MAX:
        raise RegistryError('invalid_request', f'Choose a context window from {CONTEXT_MIN:,} to {CONTEXT_MAX:,} tokens.')
    from .pip_chat_continuity import encoded, prepare
    from .redaction import secret_values
    continuity, history = prepare(store, pip_id, size, secrets=secret_values(config))
    brief = len(continuity['state']['summary'].encode())
    recent = len(encoded(history)) if history else 0
    # Part by part (pip_chat_breakdown): what its last reply measured, then its brief and these messages.
    from .pip_chat_breakdown import breakdown, last_parts
    try:
        threshold = float(config.get('compact_threshold', 0.85))
    except (AttributeError, TypeError, ValueError):
        threshold = 0.85
    shown = breakdown(last_parts(store, pip_id), brief=(brief + 3) // 4, recent=(recent + 3) // 4, window=size,
                      compact_at=threshold if 0 < threshold <= 1 else 0.85)
    return {'pip_id': pip_id, 'context_size': size, 'used_tokens': shown['used'],
            'brief_tokens': (brief + 3) // 4, 'recent_messages': len(history),
            'summarized_messages': int(continuity['state'].get('messages') or 0), 'breakdown': shown}
