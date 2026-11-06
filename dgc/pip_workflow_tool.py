"""Create a Pip workflow from the main Work chat after a one-time user approval.

The permission card approves the exact order, handoff tasks and routing mode. A
workflow only routes results; each receiving Pip keeps its own action permissions.
"""
from __future__ import annotations

import json

from .workspace_registry import RegistryError, WorkspaceRegistry, canonical_directory


def create(args, ctx):
    if ctx.config.get('pips_enabled', False) is not True:
        raise RegistryError('disabled', 'Pips are disabled in this session.')
    from .pip_access import require_unrestricted
    require_unrestricted(ctx.config)
    if (type(args) is not dict or set(args) !=
            {'scope', 'name', 'pip_ids', 'pip_names', 'tasks', 'mode', 'expected_pins'}):
        raise RegistryError('invalid_request', 'Choose scope, name, ordered Pips and their names, handoff tasks, mode and inspected pins.')
    if args['scope'] not in ('personal', 'project'):
        raise RegistryError('invalid_request', 'Choose a Personal or Project workflow.')
    if (type(args['pip_ids']) is not list or not 2 <= len(args['pip_ids']) <= 4
            or not all(type(value) is str for value in args['pip_ids'])
            or type(args['pip_names']) is not list or len(args['pip_names']) != len(args['pip_ids'])
            or not all(type(value) is str and 1 <= len(value) <= 160 for value in args['pip_names'])
            or type(args['tasks']) is not list or len(args['tasks']) != len(args['pip_ids']) - 1
            or not all(type(value) is str for value in args['tasks'])):
        raise RegistryError('invalid_request', 'Choose two to four Pip IDs and one task for each handoff.')
    pins = args['expected_pins']
    if (type(pins) is not list or len(pins) != len(args['pip_ids'])
            or any(type(pin) is not dict or set(pin) != {'pip_id', 'job_version', 'lifecycle_revision'}
                   or type(pin['pip_id']) is not str or type(pin['job_version']) is not int
                   or type(pin['lifecycle_revision']) is not int or pin['job_version'] < 1
                   or pin['lifecycle_revision'] < 0 for pin in pins)
            or [pin['pip_id'] for pin in pins] != args['pip_ids']):
        raise RegistryError('invalid_request', 'Use the exact Pip IDs and versions from pips_context definition.')
    callback = getattr(ctx, 'pip_proposal_origin', None)
    if not callable(callback):
        raise RegistryError('session_required', 'A Pip workflow needs an owning Work session.')
    origin = callback()
    if (type(origin) is not dict or set(origin) != {'session_id', 'workspace_id'}):
        raise RegistryError('session_required', 'The Work session has no registered project.')
    from .pips import PipStore
    from . import pip_flows
    with WorkspaceRegistry() as registry:
        bound = registry.db.execute('SELECT workspace_id FROM bindings WHERE runner_id=? AND canonical_root=?',
                                    (registry.runner_id, str(canonical_directory(ctx.project_root)))).fetchone()
        if bound is None or bound[0] != origin['workspace_id']:
            raise RegistryError('session_required', 'The Work session and Pip workspace differ.')
        workspace_id = bound[0]
        if args['scope'] == 'personal':
            saved = registry.db.execute("SELECT value FROM metadata WHERE key='personal_workspace'").fetchone()
            if saved is None or registry.get(saved[0])['kind'] != 'personal':
                raise RegistryError('not_found', 'No Personal Pips workspace is registered.')
            workspace_id = saved[0]
        store = PipStore(registry)
        for pip_id, pip_name in zip(args['pip_ids'], args['pip_names']):
            job = store._job(pip_id)
            if job['workspace_id'] != workspace_id:
                raise RegistryError('not_found', 'A selected Pip is outside this workflow workspace.')
            if job['name'] != pip_name:
                raise RegistryError('conflict', 'A Pip name changed since Work inspected it. Read its definition again.')
        flow = pip_flows.create(store, args['name'], args['pip_ids'], args['tasks'], args['mode'],
                                'work-reviewed', ctx.config, expected_pins=pins, unique_name=True)
    return json.dumps({'flow': {'id': flow['id'], 'name': flow['name'], 'mode': flow['mode'],
                                'status': flow['status'], 'revision': flow['revision'],
                                'pip_ids': [p['pip_id'] for p in flow['definition']['pips']]},
                       'message': 'Workflow is on. Routing mode controls handoff review only; each Pip keeps its own action permissions.'},
                      ensure_ascii=False, separators=(',', ':'))
