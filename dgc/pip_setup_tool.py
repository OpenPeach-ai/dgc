"""The chat's Pip setup. Permitted like any tool call (auto mode, an allow rule, or the user's
Allow), it creates the Pip at once; a setup that reads connected accounts or runs commands on a
schedule is saved as a card for the user's own review instead (pip_setup.needs_card)."""
from __future__ import annotations

import json
import sqlite3

from . import pip_setup
from .redaction import contains_secret, secret_values
from .workspace_registry import RegistryError, WorkspaceRegistry


def _create(registry, setup, request, config):
    """Accept the card the permitted call just saved. (None, why) when it cannot be created now; the
    card then stays for the user, exactly as it would have before."""
    actor = 'chat-permission:' + str(config.get('mode', 'default') or 'default')
    if request.get('run_now'):
        from .pip_runtime import require_supervisor, start_runtime
        try:
            require_supervisor(config)
        except RegistryError as exc:
            if exc.code != 'runner_required':
                return None, str(exc)
            try:
                start_runtime(config, resume=False)   # never clears an emergency stop
            except RegistryError as start_error:
                return None, str(start_error)
    try:
        accepted = pip_setup.review(registry, setup['id'], setup['workspace_id'], setup['digest'], actor, config, True)
    except RegistryError as exc:
        return None, str(exc)
    limit = None
    if not request.get('pip_id') and accepted['receipt'] and accepted['receipt'].get('pip_id'):
        from .pip_spend import apply_default
        limit = apply_default(registry, accepted['receipt']['pip_id'])
    return {'setup': accepted, 'daily_token_limit': limit}, ''


def propose(args, ctx) -> str:
    if ctx.config.get('pips_enabled', False) is not True:
        raise RegistryError('disabled', 'Pips are disabled in this session.')
    from .pip_access import require_unrestricted
    require_unrestricted(ctx.config)
    request = pip_setup.validate_request(args)
    root = pip_setup.validate_root(request, ctx.project_root)
    if contains_secret(request, secret_values(ctx.config)):
        raise RegistryError('secret_detected', 'Do not include credentials in a Pip setup card or retry key.')
    callback = getattr(ctx, 'pip_proposal_origin', None)
    if not callable(callback):
        raise RegistryError('session_required', 'Setup needs an owning main-chat session.')
    try:
        with WorkspaceRegistry() as registry:
            workspace = registry.lookup(root)
            if workspace is None:
                raise RegistryError('not_found', 'This directory has no registered Pips workspace.')
            origin = callback()
            if (type(origin) is not dict or set(origin) != {'session_id', 'workspace_id'}
                    or origin['workspace_id'] != workspace['id']):
                raise RegistryError('session_required', 'The setup chat does not match this project.')
            setup = pip_setup.propose(registry, request, root, origin['session_id'])
            if setup['status'] == 'pending' and not pip_setup.needs_card(request):
                created, note = _create(registry, setup, request, ctx.config)
                if created is not None:
                    return json.dumps({'setup': created['setup'], 'created': True, 'review_required': False,
                                       'job_changed_by_this_call': True, 'execution_started': created['setup']['receipt']['run_id'] is not None,
                                       'daily_token_limit': created['daily_token_limit'],
                                       'message': 'Created and on. Tell the user it exists, when it runs, and that they can pause, '
                                                  'change or delete it in Pips' + (f', and that it starts with a daily limit of '
                                                  f'{created["daily_token_limit"]:,} tokens they can change in its Job tab'
                                                  if created['daily_token_limit'] else '') + '.'},
                                      ensure_ascii=False, separators=(',', ':'))
                return json.dumps({'setup': setup, 'review_required': True, 'job_changed_by_this_call': False,
                                   'execution_started': False,
                                   'message': 'Saved as a card for the user to review, because ' + note},
                                  ensure_ascii=False, separators=(',', ':'))
            return json.dumps({'setup': setup, 'review_required': setup['status'] == 'pending',
                               'job_changed_by_this_call': False, 'execution_started': False,
                               'message': ('This Pip reads the user\'s connected accounts or runs commands on a schedule, so the user '
                                           'reviews this card in Pips or the CLI before it exists. Mention the pending card; never claim it is on.')},
                              ensure_ascii=False, separators=(',', ':'))
    except RegistryError:
        raise
    except (OSError, sqlite3.Error) as exc:
        raise RegistryError('registry_unavailable', 'Pip setup storage is unavailable. Retry the same request key after checking local state.') from exc
