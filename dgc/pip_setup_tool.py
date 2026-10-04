"""Model-facing setup drafting only. Human acceptance is a separate command."""
from __future__ import annotations

import json
import sqlite3

from . import pip_setup
from .redaction import contains_secret, secret_values
from .workspace_registry import RegistryError, WorkspaceRegistry


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
            return json.dumps({'setup': setup, 'review_required': setup['status'] == 'pending',
                               'job_changed_by_this_call': False, 'execution_started': False,
                               'message': 'A draft only. The user must review and accept this exact card in Pips or the CLI.'},
                              ensure_ascii=False, separators=(',', ':'))
    except RegistryError:
        raise
    except (OSError, sqlite3.Error) as exc:
        raise RegistryError('registry_unavailable', 'Pip setup storage is unavailable. Retry the same request key after checking local state.') from exc
