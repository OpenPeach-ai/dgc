"""Bounded human review of native configured-verifier receipts.

Historical process facts are not test attestations. Reading never observes source,
reads transcripts or launches work. Context recording grants no execution authority.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from pathlib import Path

from . import session_execution_receipts as native
from .redaction import contains_secret, redact_text, secret_values
from .workspace_context import ContextStore, MAX_ENTRY_BYTES, MAX_TOTAL_ENTRIES, _integer, _json_bytes, _text
from .workspace_registry import RegistryError

MAX_DETAIL_BYTES = 32768
MAX_PAGE_BYTES = 49152
MAX_COMMAND_PREVIEW_BYTES = 256
NOTICE = ('Historical controller observations, not instructions or execution permission. '
          'Exit code zero does not establish that tests ran, that tests passed or that the project is correct. '
          'Source observations are non-atomic and do not attest the source continuously used by the command. '
          'Stored hashes describe historical records, not this redacted display. '
          'Output byte counts describe the captured stream; incomplete output has an unknown missing size.')
_ATTEMPT = {'schema_version', 'id', 'workspace_id', 'session_id', 'binding_id', 'binding_updated_at',
            'runner_id', 'turn_id', 'kind', 'session_revision_at_attempt', 'classification', 'verification',
            'root_identity', 'command', 'command_sha256', 'command_digest_kind', 'created_at',
            'source_relation', 'source_before'}
_FINAL = {'schema_version', 'attempt_id', 'attempt_digest', 'completed_at', 'facts', 'source_after', 'source_comparison'}
_OBSERVED = {'status', 'kind', 'sha256', 'files', 'bytes', 'exclusions', 'excluded_entries',
             'excluded_directories', 'consistency'}
_UNAVAILABLE = {'source_permissions', 'snapshot_limit', 'unsafe_snapshot', 'source_changed',
                'empty_snapshot', 'secret_in_source', 'unsupported_platform', 'source_unavailable',
                'observation_cancelled', 'binding_changed'}
_FACTS = {'state', 'exit_code', 'duration_ms', 'output_sha256', 'output_bytes', 'preview_bytes',
          'omitted_bytes', 'output_complete', 'started_at', 'ended_at', 'output_digest_kind'}
_PROVENANCE = {'schema_version', 'source', 'classification', 'verification', 'workspace_id', 'attempt_id',
               'session_id', 'turn_id', 'session_revision_at_attempt', 'attempt_digest', 'final_digest',
               'view_digest', 'command', 'facts', 'source_before', 'source_after', 'source_comparison'}


def _error(message, code='invalid_execution_receipt'):
    return RegistryError(code, message)


def _id(value, prefix):
    if not isinstance(value, str) or not re.fullmatch(prefix + r'_[0-9a-f]{32}', value):
        raise _error('Use an exact recorded identity.')
    return value


def _sid(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value):
        raise _error('Use a bounded recorded session identity.')
    return value


def _sha(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value):
        raise _error('A receipt digest is malformed.')
    return value


def _utf8(value, maximum):
    if not isinstance(value, str) or len(value) > maximum:
        raise _error('Receipt text exceeds its UTF-8 limit.')
    try:
        raw = value.encode('utf-8')
    except UnicodeError:
        raise _error('Receipt text must be valid UTF-8.') from None
    if len(raw) > maximum:
        raise _error('Receipt text exceeds its UTF-8 limit.')
    return raw


def _time(value):
    _text(value, 'Receipt time', 40)
    try:
        if datetime.fromisoformat(value.replace('Z', '+00:00')).utcoffset() is None:
            raise ValueError()
    except ValueError:
        raise _error('Receipt times require an explicit timezone.') from None
    return value


def _hash(value, maximum=native.MAX_RECORD_BYTES):
    return hashlib.sha256(_json_bytes(value, maximum)).hexdigest()


def _object(raw):
    # SQL limits are authoritative; keep this guard for direct validation callers.
    if not isinstance(raw, str) or len(raw) > native.MAX_RECORD_BYTES:
        raise _error('A stored receipt exceeds its read budget.', 'stored_data_limit')
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError()
            result[key] = value
        return result
    def constant(_):
        raise ValueError()
    try:
        if len(raw.encode('utf-8')) > native.MAX_RECORD_BYTES:
            raise ValueError()
        result = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
        if not isinstance(result, dict):
            raise ValueError()
        pending, count = [(result, 0)], 0
        while pending:
            item, depth = pending.pop(); count += 1
            if count > 2000 or depth > 16:
                raise ValueError()
            if isinstance(item, dict):
                pending.extend((v, depth + 1) for v in item.values())
                pending.extend((k, depth + 1) for k in item)
            elif isinstance(item, list):
                pending.extend((v, depth + 1) for v in item)
            elif isinstance(item, str):
                item.encode('utf-8')
        return result
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise _error('A stored receipt is malformed or exceeds its read budget.', 'stored_data_limit') from None


def _observation(value, *, after=False):
    if not isinstance(value, dict):
        raise _error('A source observation is malformed.')
    if value.get('status') == 'unavailable':
        if (set(value) != {'status', 'reason'} or not isinstance(value['reason'], str)
                or value['reason'] not in _UNAVAILABLE or (value['reason'] == 'binding_changed' and not after)):
            raise _error('A source observation has an unsupported unavailable reason.')
        return
    if (set(value) != _OBSERVED or value['status'] != 'observed'
            or value['kind'] != 'current_tree_observation' or value['exclusions'] != 'safe_source_v1'
            or value['consistency'] != 'checked_non_atomic'):
        raise _error('Source observations must remain checked, non-atomic historical observations.')
    _sha(value['sha256'])
    for key, low, high in (('files', 1, 10000), ('bytes', 0, 64 * 1024 * 1024),
                           ('excluded_entries', 0, 10000), ('excluded_directories', 0, 10000)):
        _integer(value[key], 'Source ' + key, low, high)
    if value['files'] + value['excluded_entries'] > 10000 or value['excluded_directories'] > value['excluded_entries']:
        raise _error('Source observation counts are inconsistent.')


def _comparison(before, after, value):
    expected = ('unchanged_observation' if before == after else 'changed_observation') if (
        before['status'] == after['status'] == 'observed') else 'unavailable'
    if value != expected:
        raise _error('The source comparison disagrees with its historical observations.')


def _facts(value, *, preview):
    fields = _FACTS | ({'preview'} if preview else set())
    if not isinstance(value, dict) or set(value) != fields:
        raise _error('Native facts have unsupported or missing fields.')
    # The native validator checks all counters, hashes, native status and timestamps.
    if preview:
        native.validate_facts(value)
    else:
        state = value['state']
        if not isinstance(state, str) or state not in ('exited', 'failed_to_start', 'timed_out', 'cancelled', 'interrupted'):
            raise _error('Native facts cannot assert passed tests.')
        code = value['exit_code']
        if code is not None:
            _integer(code, 'Native exit code', -2147483648, 2147483647)
        if (state == 'exited' and code is None) or (state == 'failed_to_start' and code is not None):
            raise _error('Native state disagrees with its exit code.')
        for key in ('duration_ms', 'output_bytes', 'preview_bytes', 'omitted_bytes'):
            _integer(value[key], key, 0, 2**53 - 1)
        if (value['preview_bytes'] > 4096 or value['preview_bytes'] + value['omitted_bytes'] != value['output_bytes']
                or type(value['output_complete']) is not bool or value['output_digest_kind'] != 'decoded_redacted_utf8'):
            raise _error('Native output metadata is inconsistent.')
        _sha(value['output_sha256'])
        if value['started_at'] is not None:
            _time(value['started_at'])
        _time(value['ended_at'])
    if value['state'] == 'failed_to_start':
        if (value['started_at'] is not None or value['output_bytes'] != 0 or value['preview_bytes'] != 0
                or value['output_sha256'] != hashlib.sha256(b'').hexdigest()):
            raise _error('An unstarted command cannot claim process output or a start time.')
    elif value['started_at'] is None:
        raise _error('A started native command requires its recorded start time.')
    if value['output_bytes'] == 0 and value['output_sha256'] != hashlib.sha256(b'').hexdigest():
        raise _error('An empty observed output must have its empty-stream digest.')
    if preview and value['omitted_bytes'] == 0 and hashlib.sha256(value['preview'].encode()).hexdigest() != value['output_sha256']:
        raise _error('The complete retained output disagrees with its recorded digest.')


def validate_records(attempt, final, *, attempt_digest, final_digest=None):
    """Validate original bounded records; public projections are not originals."""
    if (not isinstance(attempt, dict) or set(attempt) != _ATTEMPT
            or type(attempt['schema_version']) is not int or attempt['schema_version'] != 1
            or attempt['kind'] != 'configured_verifier' or attempt['classification'] != 'controller_observed_execution'
            or attempt['verification'] != 'native_process_facts_only'
            or attempt['command_digest_kind'] != 'original_utf8'
            or attempt['source_relation'] != 'observed_before_and_after_not_execution_attestation'):
        raise _error('The attempt has an unsupported native receipt contract.')
    for name, prefix in (('id', 'exec'), ('workspace_id', 'ws'), ('binding_id', 'binding'), ('runner_id', 'runner'), ('turn_id', 'turn')):
        _id(attempt[name], prefix)
    _sid(attempt['session_id'])
    _integer(attempt['session_revision_at_attempt'], 'Historical session revision', 0, 2**53 - 1)
    _time(attempt['created_at']); _time(attempt['binding_updated_at'])
    root = attempt['root_identity']
    if not isinstance(root, dict) or set(root) != {'device', 'inode'}:
        raise _error('The private source identity is malformed.')
    for value in root.values():
        _integer(value, 'Private filesystem identity', 0, 2**64 - 1)
    # The native producer permits multiline shell commands and controls other than NUL.
    command = attempt['command']
    raw_command = _utf8(command, 8192)
    if not command.strip() or '\0' in command:
        raise _error('The original configured command exceeds its native bound.')
    _sha(attempt['command_sha256'])
    if hashlib.sha256(raw_command).hexdigest() != attempt['command_sha256']:
        raise _error('The original command digest changed.')
    _observation(attempt['source_before'])
    if _hash(attempt) != _sha(attempt_digest):
        raise _error('The immutable attempt failed its stored digest check.')
    if final is None:
        if final_digest is not None:
            raise _error('An unfinalized attempt cannot claim a final digest.')
        return
    if (not isinstance(final, dict) or set(final) != _FINAL or type(final['schema_version']) is not int
            or final['schema_version'] != 1 or final['attempt_id'] != attempt['id']
            or final['attempt_digest'] != attempt_digest):
        raise _error('The final is not linked to this exact immutable attempt.')
    _time(final['completed_at']); _facts(final['facts'], preview=True)
    _observation(final['source_after'], after=True)
    _comparison(attempt['source_before'], final['source_after'], final['source_comparison'])
    if _hash(final) != _sha(final_digest):
        raise _error('The immutable final failed its stored digest check.')


def _prefix(value, maximum=MAX_COMMAND_PREVIEW_BYTES):
    raw = value.encode('utf-8')
    kept = raw[:maximum].decode('utf-8', errors='ignore')
    return kept, kept != value


def _projection(attempt, final, attempt_digest, final_digest, config):
    secrets = secret_values(config)
    command = redact_text(attempt['command'], secrets)
    preview = None if final is None else redact_text(final['facts']['preview'], secrets)
    command_redacted = command != attempt['command']
    output_redacted = final is not None and preview != final['facts']['preview']
    value = {'schema_version': 1, 'id': attempt['id'], 'workspace_id': attempt['workspace_id'],
             'session_id': attempt['session_id'], 'turn_id': attempt['turn_id'],
             'session_revision_at_attempt': attempt['session_revision_at_attempt'], 'created_at': attempt['created_at'],
             'finalized_at': None if final is None else final['completed_at'],
             'kind': 'configured_verifier', 'state': 'unfinalized' if final is None else final['facts']['state'],
             'attempt_digest': attempt_digest, 'final_digest': final_digest,
             'command': {'text': command, 'sha256': attempt['command_sha256'], 'digest_kind': 'original_utf8',
                         'redacted': command_redacted},
             'source_before': attempt['source_before'], 'source_after': None if final is None else final['source_after'],
             'source_comparison': None if final is None else final['source_comparison'],
             'facts': None if final is None else {k: v for k, v in final['facts'].items() if k != 'preview'},
             'output_preview': None if final is None else {'text': preview, 'redacted': bool(output_redacted)},
             'projection': {'kind': 'redacted_historical_reference', 'redacted': bool(command_redacted or output_redacted), 'notice': NOTICE}}
    # The entire display, including fixed notices and field names, must survive
    # the outer controller's redactor unchanged. Otherwise its digest would pin
    # bytes different from those actually reviewed by the person.
    if contains_secret(value, secrets):
        raise _error('Receipt metadata cannot be displayed safely.', 'secret_detected')
    value['view_digest'] = _hash(value, MAX_DETAIL_BYTES)
    return value


def context_provenance(receipt):
    """Build a compact reference from an internally validated detail projection."""
    if receipt['state'] == 'unfinalized' or receipt['facts'] is None or receipt['final_digest'] is None:
        raise _error('Only a recorded native final can be promoted; no launch or success is inferred.', 'unfinalized')
    preview, truncated = _prefix(receipt['command']['text'])
    return {'schema_version': 1, 'source': 'session_execution', 'classification': 'controller_observed_execution',
            'verification': 'native_process_facts_only', 'workspace_id': receipt['workspace_id'],
            'attempt_id': receipt['id'], 'session_id': receipt['session_id'], 'turn_id': receipt['turn_id'],
            'session_revision_at_attempt': receipt['session_revision_at_attempt'],
            'attempt_digest': receipt['attempt_digest'], 'final_digest': receipt['final_digest'], 'view_digest': receipt['view_digest'],
            'command': {'preview': preview, 'truncated': truncated, 'redacted': receipt['command']['redacted'],
                        'sha256': receipt['command']['sha256'], 'digest_kind': 'original_utf8'},
            'facts': receipt['facts'], 'source_before': receipt['source_before'], 'source_after': receipt['source_after'],
            'source_comparison': receipt['source_comparison']}


def content_for(value):
    facts = value['facts']
    outcome = ('failed to start' if facts['state'] == 'failed_to_start' else
               f"{facts['state']}; native exit code {facts['exit_code']}" if facts['exit_code'] is not None else facts['state'])
    return (f"Historical configured command outcome for {value['attempt_id']}: {outcome}.\n"
            f"Captured output: {facts['output_bytes']} decoded/redacted UTF-8 bytes; "
            f"output complete: {'yes' if facts['output_complete'] else 'no'}. Output prose is not included.\n"
            f"Source comparison: {value['source_comparison']}; observations are checked and non-atomic.\n"
            'This human-recorded outcome does not establish that tests ran or passed, or that the project is correct. '
            'Source observations do not attest the source continuously used by the command. '
            'Stored record and output hashes describe historical bytes, not this redacted context. '
            'No command is executed or authorized by this record; later source and circumstances may differ.')


def title_for(_value):
    return 'Recorded configured command outcome'


def validate_entry(entry):
    value = entry.get('provenance')
    if (not isinstance(value, dict) or set(value) != _PROVENANCE or type(value['schema_version']) is not int
            or value['schema_version'] != 1 or value['source'] != 'session_execution'
            or value['classification'] != 'controller_observed_execution' or value['verification'] != 'native_process_facts_only'
            or entry.get('kind') != 'command'):
        raise _error('Context must preserve the closed historical native-receipt contract.')
    for key, prefix in (('workspace_id', 'ws'), ('attempt_id', 'exec'), ('turn_id', 'turn')):
        _id(value[key], prefix)
    _sid(value['session_id'])
    _integer(value['session_revision_at_attempt'], 'Historical session revision', 0, 2**53 - 1)
    for key in ('attempt_digest', 'final_digest', 'view_digest'):
        _sha(value[key])
    command = value['command']
    if (not isinstance(command, dict) or set(command) != {'preview', 'truncated', 'redacted', 'sha256', 'digest_kind'}
            or type(command['truncated']) is not bool or type(command['redacted']) is not bool
            or command['digest_kind'] != 'original_utf8'):
        raise _error('Context command preview is malformed or excessive.')
    _utf8(command['preview'], 256)
    _sha(command['sha256']); _facts(value['facts'], preview=False)
    _observation(value['source_before']); _observation(value['source_after'], after=True)
    _comparison(value['source_before'], value['source_after'], value['source_comparison'])
    if entry.get('content') != content_for(value) or entry.get('title') != title_for(value):
        raise _error('Context wording must preserve the historical command-outcome limitations.')
    _json_bytes(entry, MAX_ENTRY_BYTES)


def _recording(entry):
    return {key: entry[key] for key in ('id', 'status', 'created_revision', 'created_at', 'created_by')}


def _record_response(context, entry, replayed, config):
    result = {'context': context, 'recording': _recording(entry), 'replayed': replayed}
    if contains_secret(result, secret_values(config)):
        raise _error('Current context needs additional redaction. Review or archive the affected context before recording this outcome; historical records were not changed.',
                     'secret_detected')
    return result


def _match_recordings(entries, receipt):
    """A saved human decision must still refer to these exact historical facts."""
    active = 0
    for entry in entries:
        value = entry['provenance']
        if receipt['facts'] is None:
            raise _error('An unfinalized attempt cannot have a recorded command outcome.')
        expected = {key: receipt[key] for key in ('workspace_id', 'session_id', 'turn_id', 'session_revision_at_attempt',
                    'attempt_digest', 'final_digest', 'facts', 'source_before', 'source_after', 'source_comparison')}
        if (any(value[key] != wanted for key, wanted in expected.items()) or value['attempt_id'] != receipt['id']
                or value['command']['sha256'] != receipt['command']['sha256']):
            raise _error('A context recording differs from its immutable native evidence.')
        active += entry['status'] == 'active'
    if active > 1:
        raise _error('A native receipt cannot have multiple active context recordings.')


class SessionExecutionStore:
    def __init__(self, registry):
        self.registry, self.db = registry, registry.db

    def _scope(self, workspace_id, config):
        from .pip_access import require_unrestricted
        require_unrestricted(config)
        if config.get('pips_enabled', False) is not True:
            raise _error('Enable Pips before accessing native command receipts.', 'disabled')
        _id(workspace_id, 'ws')
        row = self.db.execute('''SELECT CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))<=64 THEN id END AS id,
            CASE WHEN typeof(canonical_root)='text' AND length(CAST(canonical_root AS BLOB))<=4096 THEN canonical_root END AS canonical_root,
            CASE WHEN typeof(updated_at)='text' AND length(CAST(updated_at AS BLOB))<=40 THEN updated_at END AS updated_at
            FROM bindings WHERE workspace_id=? AND runner_id=?''', (workspace_id, self.registry.runner_id)).fetchone()
        if row is None:
            raise _error('This workspace has no local receipt binding.', 'not_found')
        _id(row['id'], 'binding'); _time(row['updated_at'])
        # A historical read/promotion requires no live source folder. The human
        # controller supplies its selected binding as a non-persisting config
        # clone; payloads cannot provide a root. Match that stored absolute path
        # lexically without stat/resolve or implicitly creating a workspace.
        selected_root = Path(config.project_root)
        if (not selected_root.is_absolute() or '..' in selected_root.parts
                or row['canonical_root'] != str(selected_root)):
            raise _error('Select the owning registered workspace before reading its receipts.', 'receipt_scope')
        return tuple(row)

    def _load(self, workspace_id, attempt_id):
        _id(attempt_id, 'exec')
        # Membership is part of SQL before any native body can be allocated.
        row = self.db.execute('''SELECT a.id,a.workspace_id,
            CASE WHEN typeof(a.session_id)='text' AND length(CAST(a.session_id AS BLOB))<=128 THEN a.session_id END AS session_id,
            CASE WHEN typeof(a.created_at)='text' AND length(CAST(a.created_at AS BLOB))<=40 THEN a.created_at END AS created_at,
            CASE WHEN typeof(a.body)='text' AND length(CAST(a.body AS BLOB))<=16384 THEN a.body END AS body,
            CASE WHEN typeof(a.digest)='text' AND length(CAST(a.digest AS BLOB))=64 THEN a.digest END AS digest,
            f.attempt_id AS final_id,
            CASE WHEN typeof(f.body)='text' AND length(CAST(f.body AS BLOB))<=16384 THEN f.body END AS final_body,
            CASE WHEN typeof(f.digest)='text' AND length(CAST(f.digest AS BLOB))=64 THEN f.digest END AS final_digest,
            CASE WHEN typeof(f.created_at)='text' AND length(CAST(f.created_at AS BLOB))<=40 THEN f.created_at END AS final_created_at
            FROM session_execution_attempts a LEFT JOIN session_execution_finals f ON f.attempt_id=a.id
            JOIN session_workspaces s ON s.session_id=a.session_id AND s.workspace_id=a.workspace_id
            JOIN bindings b ON b.id=s.binding_id AND b.workspace_id=s.workspace_id
            WHERE a.id=? AND a.workspace_id=? AND b.runner_id=?''', (attempt_id, workspace_id, self.registry.runner_id)).fetchone()
        if row is None:
            raise _error('Native receipt not found in this workspace.', 'not_found')
        attempt = _object(row['body'])
        final = None if row['final_id'] is None else _object(row['final_body'])
        validate_records(attempt, final, attempt_digest=row['digest'], final_digest=row['final_digest'])
        if (attempt['id'] != row['id'] or attempt['workspace_id'] != row['workspace_id']
                or attempt['session_id'] != row['session_id'] or attempt['created_at'] != row['created_at']
                or attempt['runner_id'] != self.registry.runner_id
                or (final is not None and (row['final_id'] != attempt_id or final['completed_at'] != row['final_created_at']))):
            raise _error('Native receipt rows disagree with their immutable identities.')
        if self.db.execute('SELECT 1 FROM bindings WHERE id=? AND workspace_id=? AND runner_id=?',
                           (attempt['binding_id'], workspace_id, self.registry.runner_id)).fetchone() is None:
            raise _error('The historical binding does not belong to this receipt workspace.')
        return attempt, final, row['digest'], row['final_digest']

    def _recordings(self, workspace_id, attempt_id=None):
        count = self.db.execute('SELECT count(*) FROM workspace_context_entries WHERE workspace_id=? AND kind=?',
                                (workspace_id, 'command')).fetchone()[0]
        if count > MAX_TOTAL_ENTRIES:
            raise _error('Context history exceeds its bounded read contract.', 'stored_data_limit')
        result = []
        fields = {'id': 64, 'status': 16, 'created_at': 40, 'created_by': 128, 'title': 240, 'content': 4096, 'provenance': 6144}
        selected = ','.join(f"CASE WHEN typeof({key})='text' AND length(CAST({key} AS BLOB))<={size} THEN {key} END AS {key}"
                            for key, size in fields.items())
        for row in self.db.execute("SELECT CASE WHEN typeof(created_revision)='integer' THEN created_revision END AS created_revision," + selected + ' FROM workspace_context_entries '
                                   'WHERE workspace_id=? AND kind=? ORDER BY created_revision LIMIT ?',
                                   (workspace_id, 'command', MAX_TOTAL_ENTRIES)):
            item = dict(row)
            # Bound every selected text cell before decoding, even unrelated rows.
            if any(item[key] is None for key in fields):
                raise _error('Context history contains an excessive or malformed record.', 'stored_data_limit')
            provenance = _object(item['provenance'])
            if provenance.get('source') != 'session_execution':
                continue
            item.update(kind='command', provenance=provenance)
            _id(item['id'], 'ctx'); _time(item['created_at']); _text(item['created_by'], 'Reviewer', 128)
            _integer(item['created_revision'], 'Recorded context revision', 1)
            validate_entry(item)
            if item['status'] not in ('active', 'archived') or provenance['workspace_id'] != workspace_id:
                raise _error('The historical recording has invalid workspace or lifecycle metadata.')
            if attempt_id is None or provenance['attempt_id'] == attempt_id:
                result.append(item)
        return result

    def get(self, workspace_id, attempt_id, *, config):
        with ContextStore(self.registry)._read():
            self._scope(workspace_id, config)
            receipt = _projection(*self._load(workspace_id, attempt_id), config)
            recordings = self._recordings(workspace_id, attempt_id)
            _match_recordings(recordings, receipt)
            receipt['recording'] = _recording(recordings[-1]) if recordings else None
            receipt['record_blocked_reason'] = ('unfinalized' if receipt['state'] == 'unfinalized' else
                                                'already_recorded' if any(x['status'] == 'active' for x in recordings) else None)
            receipt['can_record'] = receipt['record_blocked_reason'] is None
            result = {'workspace_id': workspace_id, 'receipt': receipt}
            _json_bytes(result, MAX_DETAIL_BYTES)
            if contains_secret(result, secret_values(config)):
                raise _error('Receipt metadata cannot be displayed safely.', 'secret_detected')
            return result

    def list(self, workspace_id, *, session_id=None, before_id=None, limit=20, config):
        _integer(limit, 'Receipt page size', 1, 20)
        if session_id is not None:
            _sid(session_id)
        if before_id is not None:
            _id(before_id, 'exec')
        with ContextStore(self.registry)._read():
            self._scope(workspace_id, config)
            if session_id is not None and self.db.execute('SELECT 1 FROM session_workspaces WHERE session_id=? AND workspace_id=?',
                                                         (session_id, workspace_id)).fetchone() is None:
                raise _error('The session is not associated with this workspace.', 'not_found')
            clause, args = 'workspace_id=?', [workspace_id]
            if session_id is not None:
                clause += ' AND session_id=?'; args.append(session_id)
            total = self.db.execute('SELECT count(*) FROM session_execution_attempts WHERE ' + clause, args).fetchone()[0]
            if total > native.MAX_ATTEMPTS:
                raise _error('The receipt archive exceeds its bounded retention contract.', 'stored_data_limit')
            if before_id is not None:
                previous = self._load(workspace_id, before_id)[0]
                if session_id is not None and previous['session_id'] != session_id:
                    raise _error('The receipt cursor belongs to another session.', 'invalid_cursor')
                clause += ' AND (created_at<? OR (created_at=? AND id<?))'
                args.extend((previous['created_at'], previous['created_at'], before_id))
            rows = self.db.execute('SELECT CASE WHEN typeof(id)=\'text\' AND length(CAST(id AS BLOB))<=64 THEN id END AS id '
                                   'FROM session_execution_attempts WHERE ' + clause + ' ORDER BY created_at DESC,id DESC LIMIT ?',
                                   (*args, limit + 1)).fetchall()
            recordings = self._recordings(workspace_id)
            links = {entry['provenance']['attempt_id']: _recording(entry) for entry in recordings}
            items = []
            for row in rows[:limit]:
                receipt = _projection(*self._load(workspace_id, row['id']), config)
                _match_recordings([entry for entry in recordings if entry['provenance']['attempt_id'] == receipt['id']], receipt)
                preview, truncated = _prefix(receipt['command']['text'])
                item = {key: receipt[key] for key in ('id', 'workspace_id', 'session_id', 'created_at', 'state')}
                item.update(exit_code=None if receipt['facts'] is None else receipt['facts']['exit_code'],
                            command_preview=preview, command_truncated=truncated,
                            redacted=receipt['projection']['redacted'], recording=links.get(receipt['id']))
                _json_bytes(items + [item], MAX_PAGE_BYTES - 1024)
                items.append(item)
            result = {'workspace_id': workspace_id, 'session_id': session_id, 'receipts': items,
                    'next_before_id': items[-1]['id'] if len(rows) > len(items) else None,
                    'has_more': len(rows) > len(items), 'total_in_scope': total, 'retention_limit': native.MAX_ATTEMPTS}
            if contains_secret(result, secret_values(config)):
                raise _error('Receipt metadata cannot be displayed safely.', 'secret_detected')
            return result

    def record(self, workspace_id, attempt_id, expected_attempt_digest, expected_final_digest,
               expected_view_digest, expected_context_revision, actor, *, config):
        """Explicit human recording with native-evidence and context-revision CAS."""
        for value in (expected_attempt_digest, expected_final_digest, expected_view_digest):
            _sha(value)
        _integer(expected_context_revision, 'Expected context revision'); _text(actor, 'Authenticated reviewer', 128)
        if contains_secret(actor, secret_values(config)):
            raise _error('The reviewer identity cannot be persisted safely.', 'secret_detected')
        with self.registry.transaction():
            self._scope(workspace_id, config)
            attempt, final, attempt_digest, final_digest = self._load(workspace_id, attempt_id)
            if final is None:
                raise _error('Unfinalized attempts cannot become command-outcome context.', 'unfinalized')
            if (attempt_digest, final_digest) != (expected_attempt_digest, expected_final_digest):
                raise _error('The historical receipt differs from the one reviewed.', 'context_conflict')
            previous = self._recordings(workspace_id, attempt_id)
            # Exact retries are allowed after the display's redaction changes,
            # but their stored native facts and original digests must still match.
            historical = {'id': attempt['id'], 'workspace_id': attempt['workspace_id'], 'session_id': attempt['session_id'],
                          'turn_id': attempt['turn_id'], 'session_revision_at_attempt': attempt['session_revision_at_attempt'],
                          'attempt_digest': attempt_digest, 'final_digest': final_digest,
                          'command': {'sha256': attempt['command_sha256']},
                          'facts': {k: v for k, v in final['facts'].items() if k != 'preview'},
                          'source_before': attempt['source_before'], 'source_after': final['source_after'],
                          'source_comparison': final['source_comparison']}
            _match_recordings(previous, historical)
            hub = ContextStore(self.registry)
            for entry in previous:
                pin = entry['provenance']
                if (entry['created_by'] == actor and entry['created_revision'] == expected_context_revision + 1
                        and (pin['attempt_digest'], pin['final_digest'], pin['view_digest']) ==
                        (expected_attempt_digest, expected_final_digest, expected_view_digest)):
                    return _record_response(hub.get(workspace_id), entry, True, config)
            if any(entry['status'] == 'active' for entry in previous):
                raise _error('This receipt already has an active context record; archive it before a new recording.', 'context_conflict')
            receipt = _projection(attempt, final, attempt_digest, final_digest, config)
            if receipt['view_digest'] != expected_view_digest:
                raise _error('The displayed receipt changed; review its current redacted projection.', 'context_conflict')
            view = hub._prepare(workspace_id, expected_context_revision, actor)
            provenance = context_provenance(receipt)
            title, content = title_for(provenance), content_for(provenance)
            if contains_secret({'title': title, 'content': content, 'provenance': provenance}, secret_values(config)):
                raise _error('The canonical command-outcome context cannot be persisted safely.', 'secret_detected')
            context = hub._append(view, 'command', title, content, actor, provenance)
            # Still inside BEGIN IMMEDIATE: if another active context entry is
            # newly sensitive, refuse this entire response and roll back the new
            # append rather than silently alter historical projection metadata.
            return _record_response(context, context['entries'][-1], False, config)
