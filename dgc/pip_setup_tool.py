"""The chat's Pip setup. In auto mode (or on an allow rule, or the user's Allow on an ask rule) it
creates the Pip at once; otherwise it saves a card the editor docks above the chat box, where the
user's Create Pip is the approval. A project Pulse that runs commands on a schedule is always a
card (pip_setup.needs_card)."""
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
    return {'setup': accepted}, ''


def propose(args, ctx) -> str:
    args = dict(args)
    create_now = args.pop('_dgc_create_now', None) is True   # set by the agent, never by the model
    for key in ('name', 'goal', 'reason'):
        if key in args:
            args[key] = pip_setup.unescape_entities(args[key])   # a provider's &amp; for the model's &
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
            blocked = pip_setup.cannot_run_here(request)
            warning = ({'cannot_run_here': blocked} if blocked else {})
            caution = (" It can't run on this computer yet: " + blocked + " Tell the user that plainly, with the fix, "
                       "and never say it is working or checking." if blocked else "")
            if setup['status'] == 'pending' and not pip_setup.needs_card(request) and not create_now:
                return json.dumps({'setup': setup, 'review_required': True, 'job_changed_by_this_call': False,
                                   'execution_started': False,
                                   'message': 'Shown to the user as a card above the chat box. They create it there with '
                                              'one click (Create Pip), see the details, or say not now. Say in a sentence '
                                              'what the Pip will do; never claim it is on.'},
                                  ensure_ascii=False, separators=(',', ':'))
            if setup['status'] == 'pending' and not pip_setup.needs_card(request):
                created, note = _create(registry, setup, request, ctx.config)
                if created is not None:
                    return json.dumps({'setup': created['setup'], 'created': True, 'review_required': False,
                                       'job_changed_by_this_call': True, 'execution_started': created['setup']['receipt']['run_id'] is not None,
                                       'message': 'Created and on. Tell the user it exists, when it runs, and that they can pause, '
                                                  'change or delete it in Pips.'},
                                      ensure_ascii=False, separators=(',', ':'))
                return json.dumps({'setup': setup, 'review_required': True, 'job_changed_by_this_call': False,
                                   'execution_started': False,
                                   'message': 'Saved as a card for the user to review, because ' + note},
                                  ensure_ascii=False, separators=(',', ':'))
            return json.dumps({'setup': setup, 'review_required': setup['status'] == 'pending',
                               'job_changed_by_this_call': False, 'execution_started': False, **warning,
                               'message': ('This Pip runs commands on a schedule, so it is shown '
                                           'to the user as a card above the chat box, and it exists only once they choose Create Pip there. '
                                           'Mention the card; never claim it is on.' + caution)},
                              ensure_ascii=False, separators=(',', ':'))
    except RegistryError:
        raise
    except (OSError, sqlite3.Error) as exc:
        raise RegistryError('registry_unavailable', 'Pip setup storage is unavailable. Retry the same request key after checking local state.') from exc
