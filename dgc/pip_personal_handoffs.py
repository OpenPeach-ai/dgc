"""Explicitly reviewed personal-result sharing, using the existing handoff ledger.

The source contributes bounded text, never its transcript, tools or app grants.
The target keeps its own reviewed job/model/app scope. No automatic chain runs.
"""
from pathlib import Path
from . import pip_handoffs as h

TYPE = 'personal_result.v1'
ACTION = {'kind': 'personal_task', 'tools': [], 'external_actions': False}
MAX_TEXT = 12000
SOURCE_KEYS = {'pip_id', 'run_id', 'job_version', 'lifecycle_revision', 'source_revision',
               'model', 'result_digest', 'text'}
TARGET_KEYS = h._TARGET_KEYS | {'lifecycle_revision', 'app_plan_digest', 'app_plan'}


def validate_payload(value):
    source, target = value['source'], value['target']
    if (not isinstance(source, dict) or set(source) != SOURCE_KEYS
            or not isinstance(target, dict) or set(target) != TARGET_KEYS):
        raise h._error('Personal handoff source or target is incomplete.')
    h._text(value['workspace_id'], 'Personal workspace')
    for key in ('pip_id', 'run_id'):
        h._text(source[key], 'Source ' + key)
    for part in (source, target):
        h._int(part['job_version'], 'Job version', 1)
        h._int(part['lifecycle_revision'], 'Lifecycle revision', 0)
        h._text(part['model'], 'Model', 256)
    if source['source_revision'] is not None:
        raise h._error('Personal results cannot carry project commits.')
    h._text(source['text'], 'Shared result text', MAX_TEXT, multiline=True)
    h._text(target['pip_id'], 'Target Pip')
    h._text(target['name'], 'Target name', 480)
    h._text(target['source_ref'], 'Dormant target source ref', 800)
    if target['pip_id'] == source['pip_id']:
        raise h._error('Choose a different Personal Pip.')
    from .pip_types import require_type
    require_type(target['pip_type'])
    for part, key in ((source, 'result_digest'), (target, 'connection_digest'), (target, 'app_plan_digest')):
        if not isinstance(part[key], str) or not h._HASH.fullmatch(part[key]):
            raise h._error('Personal handoff digest is invalid.')
    from .pip_app_access import validate as validate_plan
    validate_plan(target['app_plan'])
    if h._digest(target['app_plan']) != target['app_plan_digest']:
        raise h._error('The target app plan does not match its digest.')
    h._text(value['task'], 'Reviewed handoff task', 4000, multiline=True)
    if (value['action'] != ACTION or value['action'].get('external_actions') is not False
            or value['action_digest'] != h._digest(ACTION)):
        raise h._error('Personal handoffs grant no tools or external actions.')
    import json
    return json.loads(h._encode(value))


def source(store, run_id, shared_text):
    """Share a verbatim, explicit excerpt; never silently truncate a saved result."""
    h._text(shared_text, 'Shared result text', MAX_TEXT, multiline=True)
    run = store.run(run_id)
    manifest = run['manifest']
    if (run['status'] != 'succeeded' or manifest.get('run_kind') != 'personal_task'
            or manifest.get('source_policy') != {'mode': 'personal'}):
        raise h._error('Choose a completed Personal Pip result.', 'source_unavailable')
    from .pip_personal_results import validate
    result = validate(run['result'])
    if shared_text not in result['text']:
        raise h._error('Shared text must be an exact excerpt of the saved result.', 'source_mismatch')
    job = store._job(run['pip_id'])
    from .pip_archive import require_live
    require_live(store, job['id'])
    if job['current_version'] != manifest['job_version']:
        raise h._error('The source job changed. Produce a fresh result before sharing.', 'stale_source')
    return run['workspace_id'], {
        'pip_id': run['pip_id'], 'run_id': run_id, 'job_version': manifest['job_version'],
        'lifecycle_revision': job['lifecycle_revision'], 'source_revision': None,
        'model': manifest['model'], 'result_digest': h._digest(result), 'text': shared_text}


def current(store, source, target_id, config):
    from .pip_archive import require_live
    from .pips import _model_settings
    from .pip_models import validate_pinned_connection
    a, b = store._job(source['pip_id']), store._job(target_id)
    for job in (a, b):
        require_live(store, job['id'])
        if (job['source_policy'] != {'mode': 'personal'}
                or store.registry.get(job['workspace_id'])['kind'] != 'personal'):
            raise h._error('Personal results may only be shared with a Personal Pip.', 'workspace_mismatch')
    if a['workspace_id'] != b['workspace_id'] or a['id'] == b['id']:
        raise h._error('Choose another Pip in the same Personal workspace.', 'workspace_mismatch')
    if (a['current_version'] != source['job_version']
            or a['lifecycle_revision'] != source['lifecycle_revision']):
        raise h._error('The source job or lifecycle changed. Prepare a new handoff.', 'stale_source')
    root = store.registry.binding(b['workspace_id'])['canonical_root']
    settings = _model_settings(config.clone_for_root(Path(root)), b['model_choice'], personal=True)
    validate_pinned_connection(config, settings)
    return {'pip_id': b['id'], 'name': b['name'], 'job_version': b['current_version'],
            'lifecycle_revision': b['lifecycle_revision'], 'pip_type': b['pip_type'],
            'source_ref': b['source_ref'], 'model': settings['model'],
            'connection_digest': h.connection_digest(settings),
            'app_plan_digest': h._digest(b.get('app_plan')), 'app_plan': b.get('app_plan')}, settings


def validate_manifest(payload, manifest):
    if (manifest.get('source_policy') != {'mode': 'personal'}
            or manifest.get('run_kind') != 'personal_task'
            or manifest.get('tools') != [] or manifest.get('policy') != 'read_only'
            or h._digest(manifest.get('app_plan')) != payload['target']['app_plan_digest']):
        raise h._error('Personal handoff target scope or app permissions do not match its review.', 'handoff_mismatch')


def require_current(store, manifest, config):
    """Controller recheck before model dispatch; queued approval is not stale authority."""
    pin = h.validate_manifest(manifest.get('handoff'), manifest)
    if pin['payload']['type'] != TYPE:
        raise h._error('Personal dispatch needs a Personal result handoff.')
    row = h._row(store, pin['handoff_id'])
    if row['status'] != 'accepted' or h._pin(row) != pin:
        raise h._error('The handoff no longer matches its saved approval.', 'handoff_mismatch')
    payload = pin['payload']
    workspace, origin = source(store, payload['source']['run_id'], payload['source']['text'])
    target, _ = current(store, origin, payload['target']['pip_id'], config)
    if workspace != payload['workspace_id'] or origin != payload['source'] or target != payload['target']:
        raise h._error('The source result or target permissions changed after review.', 'stale_handoff')
