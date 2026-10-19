"""Pure source-policy and source-identity validation for Pips.

These helpers authorize nothing and perform no I/O. A Git object ID still needs
controller resolution; a current-tree receipt still needs private-copy verification.
Missing legacy policy means committed source only, never an inferred snapshot.
"""
from __future__ import annotations

import re

from .pip_tree_snapshot import EXCLUSIONS, EXCLUSIONS_V2, validate_receipt, validate_policy as _source_shape
from .workspace_registry import RegistryError

_MISSING = object()
_COMMIT = re.compile(r'[0-9a-f]{40}|[0-9a-f]{64}')
_AUDIT_TYPES = frozenset({'scout', 'lens', 'rook', 'lock'})
_SOURCE_TYPES = _AUDIT_TYPES | {'quill'}
_KNOWN_TYPES = _SOURCE_TYPES | {'patch', 'pulse'}
_SOURCE_KEYS = frozenset({'source_policy', 'source_revision', 'source_snapshot'})
_AUTOMATIC_FIELDS = frozenset({'handoff', 'schedule', 'schedule_occurrence', 'scheduled_at',
                              'event_trigger', 'event_occurrence', 'pulse_verification'})


def _error(message, code='invalid_source_policy'):
    return RegistryError(code, message)


LEGACY_COMMITTED = {'mode': 'committed_only'}


def validate_policy(value=_MISSING):
    """Canonicalize the omitted/legacy committed default; explicit null is invalid.

    A missing or legacy policy is committed source under the original rules (safe_source_v1),
    never anything newer: moving to safe_source_v2 is a reviewed change.
    """
    if value is _MISSING or value == 'committed_only':
        return {'mode': 'committed_only'}
    if not isinstance(value, dict) or len(value) > 3:
        raise _error('Use a supported explicit source policy; current_tree also requires its fixed exclusion policy.')
    if set(value) == {'mode'} and value['mode'] == 'personal':
        return {'mode': 'personal'}
    return _source_shape(value)


def rules(policy):
    """The named source rules of a project policy: safe_source_v1 (original) or safe_source_v2."""
    return EXCLUSIONS_V2 if validate_policy(policy).get('exclusions') == EXCLUSIONS_V2 else EXCLUSIONS


def committed(policy):
    """True for committed source under either rule set."""
    return validate_policy(policy)['mode'] == 'committed_only'


def default_policy(pip_type):
    """What a NEW project Pip reads: committed source under safe_source_v2 for reviewers and
    Quill. Patch and Pulse work on an exact committed copy, so they keep the original rules."""
    current = isinstance(pip_type, str) and pip_type in _SOURCE_TYPES     # an invalid type is refused by its own check
    return {'mode': 'committed_only', 'exclusions': EXCLUSIONS_V2} if current else dict(LEGACY_COMMITTED)


def with_exclude(policy, exclude):
    """The same mode under safe_source_v2 with this Excluded folders list (empty clears it)."""
    selected = validate_policy(policy)
    if selected['mode'] == 'personal':
        raise _error('Personal Pips have no project source to leave things out of.', 'unsupported_source')
    value = {'mode': selected['mode'], 'exclusions': EXCLUSIONS_V2}
    if exclude:
        value['exclude'] = list(exclude)
    return validate_policy(value)


def validate_job(policy, *, pip_type, schedule=None, event_trigger=None):
    """Check source constraints alongside the normal job/type/trigger validators."""
    selected = validate_policy(policy)
    # Core is a character only a Personal Pip has: your Primary Pip (pips._definition).
    if not isinstance(pip_type, str) or (pip_type not in _KNOWN_TYPES
                                         and not (pip_type == 'core' and selected['mode'] == 'personal')):
        raise _error('The source policy requires an available, explicitly identified Pip type.')
    if selected['mode'] == 'personal' and event_trigger is not None:
        raise _error('Personal jobs do not watch project events.', 'unsupported_source')
    if selected['mode'] == 'committed_only' and selected != LEGACY_COMMITTED and pip_type not in _SOURCE_TYPES:
        raise _error('Patch and Pulse work on an exact committed copy with the original source rules; '
                     'Excluded folders are for Scout, Lens, Rook, Lock and Quill.', 'unsupported_source')
    if selected['mode'] == 'current_tree':
        if pip_type not in _SOURCE_TYPES:
            raise _error('Current-tree source is limited to read-only auditors and Quill. Patch and Pulse require committed Git source.', 'unsupported_source')
        if schedule is not None or event_trigger is not None:
            raise _error('Current-tree Pips support only explicit manual requests in this release. Remove schedules and event triggers in the same reviewed update.', 'manual_only')
    return selected


def pin(policy, *, source_revision, source_snapshot=None):
    """Return closed source metadata without confusing snapshot hashes and commits."""
    selected = validate_policy(policy)
    if selected['mode'] == 'personal':
        if source_revision is not None or source_snapshot is not None:
            raise _error('Personal jobs have no project source.', 'invalid_source')
        return {'source_policy': selected, 'source_revision': None, 'source_snapshot': None}
    if selected['mode'] == 'committed_only':
        if not isinstance(source_revision, str) or len(source_revision) not in (40, 64) or not _COMMIT.fullmatch(source_revision):
            raise _error('Committed source requires an exact resolved Git commit identity.', 'invalid_source')
        if source_snapshot is not None:
            raise _error('A current-tree receipt cannot accompany a committed-source identity.', 'invalid_source')
        receipt = None
    else:
        if source_revision is not None:
            raise _error('Current-tree source must have a null commit revision and a separately pinned snapshot receipt.', 'invalid_source')
        receipt = validate_receipt(source_snapshot)
    return {'source_policy': selected, 'source_revision': source_revision, 'source_snapshot': receipt}


def validate_pin(value):
    """Validate a closed new source pin; legacy records use from_record instead."""
    if not isinstance(value, dict) or len(value) != 3 or set(value) != _SOURCE_KEYS:
        raise _error('A source pin needs exactly source_policy, source_revision and source_snapshot.', 'invalid_source')
    return pin(value['source_policy'], source_revision=value['source_revision'], source_snapshot=value['source_snapshot'])


def from_record(record):
    """Project source fields from a bounded manifest/checkpoint, preserving legacy Git."""
    if not isinstance(record, dict) or len(record) > 128 or 'source_revision' not in record:
        raise _error('The source record is missing its explicit revision field or has unsupported structure.', 'invalid_source')
    return pin(validate_policy(record.get('source_policy', _MISSING)),
               source_revision=record['source_revision'], source_snapshot=record.get('source_snapshot'))


def validate_manifest(manifest):
    """Validate source-specific execution constraints, not the complete run envelope.

    Parent/worker must additionally validate roles, workspace bindings, native
    permission digest and any private main_chat_request authorization.
    """
    source = from_record(manifest)
    job = manifest.get('job')
    if job is not None and not isinstance(job, dict):
        raise _error('The pinned source job is malformed.', 'invalid_source')
    if isinstance(job, dict) and 'source_policy' in job and validate_policy(job['source_policy']) != source['source_policy']:
        raise _error('The run source does not match its pinned job source policy.', 'source_mismatch')
    if source['source_policy']['mode'] == 'personal':
        if (not isinstance(job, dict) or job.get('source_policy') != {'mode': 'personal'}
                or manifest.get('run_kind') not in ('conversation', 'personal_task')
                or manifest.get('policy') != 'read_only' or manifest.get('tools') != []
                or any(key in manifest for key in ('event_trigger', 'pulse_verification', 'specialists'))):
            raise _error('Personal jobs cannot inherit project, execution or MCP tools.', 'unsupported_source')
        if 'handoff' in manifest:
            from .pip_handoffs import validate_manifest as validate_handoff
            pin = validate_handoff(manifest['handoff'], manifest)
            if pin['payload']['type'] != 'personal_result.v1':
                raise _error('Personal scope requires a reviewed Personal result.', 'unsupported_source')
        return source
    if source['source_policy']['mode'] == 'committed_only':
        return source  # Existing Git execution validators retain their authority.
    if not isinstance(job, dict) or 'source_policy' not in job:
        raise _error('Current-tree runs require an explicit source policy in their immutable job pin.', 'source_mismatch')
    pip_type = job.get('pip_type')
    if manifest.get('pip_type') != pip_type:
        raise _error('The current-tree role does not match its immutable job pin.', 'source_mismatch')
    validate_job(source['source_policy'], pip_type=pip_type,
                 schedule=job.get('schedule'), event_trigger=job.get('event_trigger'))
    kind = manifest.get('run_kind')
    if kind not in ('audit', 'draft', 'conversation') or (kind == 'audit' and pip_type not in _AUDIT_TYPES) or (kind == 'draft' and pip_type != 'quill'):
        raise _error('Current-tree source cannot authorize this run kind.', 'unsupported_source')
    if (manifest.get('trigger') not in ('manual', 'main_chat')
            or any(key in manifest for key in _AUTOMATIC_FIELDS)):
        raise _error('Current-tree runs cannot contain handoffs, schedules or automatic event occurrences.', 'manual_only')
    if manifest.get('policy') != 'read_only':
        raise _error('Current-tree source cannot broaden the read-only native worker policy.', 'unsupported_source')
    # main_chat is a manual request through a separately permissioned tool. Its
    # private authority pin is validated by pip_run_tool, never inferred here.
    return source


def projection(record):
    """Small source metadata for history/UI/chat; never return a filesystem path."""
    source = from_record(record)
    if source['source_policy']['mode'] == 'personal':
        return {**source, 'label': 'Personal · no project access', 'identity_kind': 'none', 'identity': None}
    current = source['source_policy']['mode'] == 'current_tree'
    return {**source, 'label': 'Current-tree snapshot' if current else 'Committed source',
            'identity_kind': 'snapshot_sha256' if current else 'git_commit',
            'identity': source['source_snapshot']['sha256'] if current else source['source_revision']}
