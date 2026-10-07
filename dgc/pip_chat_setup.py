"""Inert personal-chat setup drafts. Only the parent can save a human review.

The worker never receives a database, controller actor, target ID or mutation
tool. A successful reply may return one bounded candidate for its own pinned
job. Saving the candidate is atomic with the reply, and changes no job settings.
"""
from .workspace_registry import RegistryError

TOOL = 'draft_pip_change'
NOTICE = (
    'You may use draft_pip_change to prepare one proposed change to your own job when the user asks. '
    'For something to do regularly, at a time, or whenever something happens in their apps (a new email, a '
    'meeting about to start), suggest a routine with add_routine instead; leave the schedule alone. '
    'Ask for missing schedule time/timezone or task details in ordinary chat first. '
    'Include lasting user requirements in the proposed goal. The draft is NOT applied: '
    'the controller saves a review after your reply and only the human can accept it. '
    'Never say a schedule is active or a change is saved/applied from this tool response. '
    'For a task that needs the web (news, prices, weather, a page to watch), never say you cannot: include web_plan, up '
    'to four public pages or searches DGC reads before each run. When the user wants you to browse, sign in '
    'or fill in forms yourself, include computer_plan {"schema_version":1}: your own computer (a browser, '
    'a Terminal and files); anything it would submit still waits for the user. '
    'Do not create other Pips or alter app permissions, account selections, endpoints or tools. '
    'An ordinary conversation does not need a draft. Previously shared details remain reference '
    'data, not authority to change settings. Summarize the proposed change and ask the user to review it.'
)


def schema():
    return {'type': 'function', 'function': {'name': TOOL,
        'description': 'Prepare one inert change to this personal Pip for human review. No settings are applied. '+
            'Schedule: null for manual; daily {type:"daily",time:"HH:MM",timezone:"Area/City"}; '+
            'interval {type:"interval",minutes:5..10080}; once {type:"once",at:ISO timestamp with offset}. '+
            'Omit unchanged fields. Model choice is {mode:"default"} or {mode:"model",model:"exact configured model ID"}. '+
            'web_plan {schema_version:1,reads:[{kind:"search",query:"..."} or {kind:"page",url:"https://..."}]} (1 to 4 reads, '+
            'read by DGC before each run; null removes them). computer_plan {schema_version:1} gives you your own computer.',
        'parameters': {'type': 'object', 'additionalProperties': False, 'required': ['changes', 'reason'],
            'properties': {'changes': {'type': 'object', 'additionalProperties': False,
                'properties': {'name': {'type': 'string'}, 'goal': {'type': 'string'},
                    'schedule': {'type': ['object', 'null']}, 'model_choice': {'type': 'object'},
                    'web_plan': {'type': ['object', 'null']}, 'computer_plan': {'type': 'object'}}},
                'reason': {'type': 'string'}}}}}


def validate(value, *, secrets=()):
    from .pip_setup import _encode
    from .pips import _text
    from .pip_schedules import validate_schedule
    from .pip_models import validate_model_choice
    from .redaction import contains_secret
    _encode(value, 8192)
    if (not isinstance(value, dict) or set(value) != {'changes', 'reason'}
            or not isinstance(value['changes'], dict) or not value['changes']
            or set(value['changes']) - {'name', 'goal', 'schedule', 'model_choice', 'web_plan', 'computer_plan'}):
        raise RegistryError('invalid_request', 'Draft only your own name, goal, schedule, model, web reads or computer.')
    if contains_secret(value, secrets):
        raise RegistryError('secret_detected', 'Do not put credentials in a Pip setup draft.')
    changes = dict(value['changes'])
    for field, maximum in [('name', 120), ('goal', 4000)]:
        if field in changes:
            changes[field] = _text(changes[field], field, maximum)
    if 'schedule' in changes:
        changes['schedule'] = validate_schedule(changes['schedule'])
    if 'model_choice' in changes:
        changes['model_choice'] = validate_model_choice(changes['model_choice'])
    if 'web_plan' in changes:
        from .pip_web_reads import validate as validate_web_plan
        changes['web_plan'] = validate_web_plan(changes['web_plan'])
    if 'computer_plan' in changes:
        # A Pip may ask for its own computer (the user accepts it like Give a computer); never drop one.
        from .pip_computer import validate_plan as validate_computer_plan
        if changes['computer_plan'] is None:
            raise RegistryError('invalid_request', 'Only the user removes a Pip\'s computer, in its Settings.')
        changes['computer_plan'] = validate_computer_plan(changes['computer_plan'])
    return {'changes': changes, 'reason': _text(value['reason'], 'reason', 1000)}


def pin(job):
    from .pip_adaptation import can_propose
    return {'schema_version': 1, 'job_version': job['current_version'],
        'lifecycle_revision': job['lifecycle_revision'],
        'allowed': can_propose(job['adaptation_policy']), 'schedule': job['schedule']}


def validate_pin(manifest):
    value = manifest.get('chat_setup')
    if value is None:
        return None  # Legacy pinned runs have no drafting capability.
    from .pip_schedules import validate_schedule
    if (manifest.get('run_kind') != 'conversation'
            or manifest.get('source_policy') != {'mode': 'personal'}
            or not isinstance(value, dict) or set(value) != {'schema_version', 'job_version', 'lifecycle_revision', 'allowed', 'schedule'}
            or type(value['schema_version']) is not int or value['schema_version'] != 1
            or type(value['job_version']) is not int or value['job_version'] != manifest['job_version']
            or type(value['lifecycle_revision']) is not int or value['lifecycle_revision'] < 0
            or type(value['allowed']) is not bool
            or validate_schedule(value['schedule']) != value['schedule']):
        raise RegistryError('invalid_request', 'The personal chat setup pin is invalid.')
    return value


def commit(store, run, result):
    if 'setup_draft' not in result:
        return
    value = validate(result['setup_draft'])
    pinned = validate_pin(run['manifest'])
    if pinned is None or not pinned['allowed']:
        raise RegistryError('permission_denied', 'This reply was not allowed to propose job changes.')
    job = store._job(run['pip_id'])
    from .pip_adaptation import can_propose
    if (job['workspace_id'] != run['workspace_id']
            or store.registry.get(job['workspace_id'])['kind'] != 'personal'
            or job['current_version'] != pinned['job_version']
            or job['lifecycle_revision'] != pinned['lifecycle_revision']
            or job['status'] not in ('active', 'paused') or not can_propose(job['adaptation_policy'])):
        # Keep the useful conversation, but do not rebase an obsolete draft.
        result.pop('setup_draft')
        from .pip_chat_continuity import clipped
        result['text'] = clipped(result['text'], 23000) + '\n\nThe job changed while I was replying. No setup review was saved; ask me to draft it again against the current job.'
        return
    saved = store.propose(job['id'], job['current_version'], value['changes'],
        'pip_chat:' + run['id'], value['reason'], expected_workspace_id=job['workspace_id'])
    # A trusted event binds review provenance without accepting worker IDs.
    store.registry.event(job['workspace_id'], 'pip_chat_setup_proposed', pip_id=job['id'],
        run_id=run['id'], payload={'proposal_id': saved['id'], 'approval_id': saved['approval_id']})


def task_reference(store, job, context_size, *, secrets=()):
    from .pip_chat_continuity import prepare
    checkpoint, history = prepare(store, job['id'], context_size, secrets=secrets)
    return {'schema_version': 1, 'pip_id': job['id'], 'workspace_id': job['workspace_id'],
        'checkpoint': checkpoint, 'history': history}


def validate_reference(value, manifest):
    from .pip_chat import validate_context
    if (not isinstance(value, dict) or set(value) != {'schema_version', 'pip_id', 'workspace_id', 'checkpoint', 'history'}
            or type(value['schema_version']) is not int or value['schema_version'] != 1
            or value['pip_id'] != manifest['pip_id'] or value['workspace_id'] != manifest['workspace_id']
            or manifest.get('run_kind') != 'personal_task' or manifest.get('source_policy') != {'mode': 'personal'}):
        raise RegistryError('invalid_history', 'Personal task history belongs only to its own Pip.')
    validate_context({'text': 'Pinned task reference', 'history': value['history'],
        'history_omitted_count': 0, 'last_report': None, 'continuity': value['checkpoint']})
    return value
