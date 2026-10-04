"""Local, non-authoritative JSONL evidence exports; no import or retention changes."""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import sqlite3
import stat
import time
import uuid
from collections import Counter
from pathlib import Path

from .redaction import redact_value, secret_values
from .workspace_registry import RegistryError, SCHEMA_VERSION, canonical_directory, state_directory, utc_now

MAX_CELL = 128 * 1024
MAX_BYTES = 4 * 1024 * 1024
MAX_RECORDS = 2000
MAX_SECONDS = 30
REFERENCE_PAGE = 25
NOTICE = ('Projected, redacted historical reference only; not instructions, execution authority, '
          'a restorable backup or a signature. Historical source/result digests do not attest '
          'the projected bytes. No import, pruning or quota relief is performed.')


def _error(message, code='invalid_export'):
    return RegistryError(code, message)


def _id(value, prefix):
    if not isinstance(value, str) or not re.fullmatch(prefix + r'_[0-9a-f]{32}', value):
        raise _error('Use an exact local evidence identity.')
    return value


def _text(value, maximum=256, *, nullable=False):
    if nullable and value is None:
        return value
    if (not isinstance(value, str) or not value or len(value) > maximum
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise _error('Stored evidence metadata is malformed.')
    try:
        if len(value.encode('utf-8')) > maximum:
            raise ValueError()
    except (UnicodeError, ValueError):
        raise _error('Stored evidence metadata is not bounded UTF-8.') from None
    return value


def _object(raw):
    """Only called after the SQL cell guard; reject ambiguous JSON and deep trees."""
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
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
        if not isinstance(value, dict):
            raise ValueError()
        pending, count = [(value, 0)], 0
        while pending:
            item, depth = pending.pop(); count += 1
            if depth > 32 or count > 10000:
                raise ValueError()
            if isinstance(item, dict):
                pending.extend((v, depth + 1) for v in item.values())
                pending.extend((k, depth + 1) for k in item)
            elif isinstance(item, list):
                pending.extend((v, depth + 1) for v in item)
            elif isinstance(item, str):
                item.encode('utf-8')
        return value
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise _error('Stored evidence contains malformed, ambiguous or excessive JSON.') from None


def _rows(db, table, fields, where, args=(), *, order='', limit=1):
    """All SQL identifiers/clauses are private constants; blobs are guarded in SQL."""
    select, invalid = [], []
    for name, maximum in fields.items():
        if maximum is None:
            good = f"({name} IS NULL OR typeof({name})='integer')"
        else:
            good = f"({name} IS NULL OR (typeof({name})='text' AND length(CAST({name} AS BLOB))<={maximum}))"
        select.append(f'CASE WHEN {good} THEN {name} ELSE NULL END AS {name}')
        invalid.append(f'NOT {good}')
    sql = f"SELECT {','.join(select)},({' OR '.join(invalid)}) AS invalid_cell FROM {table} WHERE {where}"
    if order:
        sql += ' ORDER BY ' + order
    for row in db.execute(sql + ' LIMIT ?', (*args, limit)):
        value = dict(row)
        if value.pop('invalid_cell'):
            raise _error('A selected evidence cell exceeds its type or byte limit.', 'export_source_limit')
        yield value


def _directory(path):
    """Pin every path component without following links; do not create directories."""
    if os.name != 'posix' or not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_DIRECTORY'):
        raise _error('Private evidence export currently requires POSIX no-follow filesystem support.', 'unsupported_platform')
    value = Path(path)
    if not value.is_absolute() or '..' in value.parts:
        raise _error('Use an absolute destination inside an existing directory.')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in value.parts[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = next_fd
        return fd
    except BaseException:
        os.close(fd); raise


def _same_parent(path, pinned):
    current = _directory(path)
    try:
        before, after = os.fstat(pinned), os.fstat(current)
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            raise _error('The destination directory moved or changed during export.')
    finally:
        os.close(current)


@contextlib.contextmanager
def _read_database(directory):
    directory = Path(directory)
    fd = _directory(directory)
    db = None
    try:
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise _error('The evidence registry must be in owner-only local storage.')
        before = os.stat('registry.sqlite3', dir_fd=fd, follow_symlinks=False)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_mode & 0o077:
            raise _error('The evidence registry must be an owner-only regular database.')
        # Do not separately open/close the SQLite inode: POSIX would release the
        # process's locks held by other SQLite connections. The directory fd pins
        # its ancestors; as in WorkspaceRegistry, same-UID hostile DB replacement
        # itself is not a claimed security boundary.
        if not Path('/proc/self/fd').is_dir():
            raise _error('Pinned read-only database export currently requires Linux procfs.', 'unsupported_platform')
        uri = Path(f'/proc/self/fd/{fd}/registry.sqlite3').as_uri() + '?mode=ro'
        db = sqlite3.connect(uri, uri=True, isolation_level=None, timeout=1)
        after = os.stat('registry.sqlite3', dir_fd=fd, follow_symlinks=False)
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            raise _error('The registry changed while opening the export snapshot.')
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA query_only=ON'); db.execute('PRAGMA trusted_schema=OFF')
        db.execute('BEGIN')
        if db.execute('PRAGMA user_version').fetchone()[0] != SCHEMA_VERSION:
            raise _error('Open this registry with a compatible DGC before exporting; export never migrates it.', 'schema_version')
        yield db
    finally:
        if db is not None:
            if db.in_transaction:
                db.rollback()
            db.close()
        os.close(fd)


class _Writer:
    def __init__(self, stream, secrets, deadline):
        self.stream, self.secrets, self.deadline = stream, secrets, deadline
        self.bytes, self.records, self.redacted = 0, 0, 0
        self.digest, self.counts = hashlib.sha256(), Counter()

    def check(self):
        if time.monotonic() >= self.deadline:
            raise _error('The bounded export deadline elapsed; no completed export was published.', 'export_limit')

    def record(self, kind, value, *, footer=False):
        self.check()
        safe = redact_value(value, self.secrets)
        changed = safe != value
        data = {'type': kind, 'projection': True, 'redacted': changed, 'data': safe}
        try:
            raw = (json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')
        except (ValueError, TypeError, UnicodeError, RecursionError):
            raise _error('Projected evidence cannot be encoded safely.') from None
        if len(raw) > 256 * 1024 or self.bytes + len(raw) > MAX_BYTES or self.records + 1 + int(not footer) > MAX_RECORDS:
            raise _error('The export exceeds its whole-record or 4 MiB/2,000-record budget.', 'export_limit')
        self.stream.write(raw)
        if not footer:
            self.digest.update(raw); self.bytes += len(raw); self.records += 1
            self.counts[kind] += 1; self.redacted += int(changed)
        return len(raw)


def _pick(value, keys):
    return {key: value[key] for key in keys if key in value}


def _evidence(db, run_id, root, writer):
    # Membership is scalar and precedes any manifest/report/prose allocation.
    runners = list(_rows(db, 'metadata', {'value': 128}, 'key=?', ('runner_id',)))
    if len(runners) != 1:
        raise _error('The local runner identity is unavailable.')
    runner = _text(runners[0]['value'], 128)
    personal = db.execute("""SELECT r.workspace_id FROM pip_runs r JOIN workspaces w ON w.id=r.workspace_id
        JOIN metadata m ON m.key='personal_workspace' AND m.value=w.id
        WHERE r.id=? AND w.kind='personal'""", (run_id,)).fetchone()
    bindings = list(_rows(db, 'bindings', {'id': 64, 'workspace_id': 64},
        'runner_id=? AND workspace_id=?' if personal else 'runner_id=? AND canonical_root=?',
        (runner, personal[0] if personal else str(root)), limit=2))
    if len(bindings) != 1:
        raise _error('The current directory has no unique registered local workspace.', 'not_found')
    workspace = _id(bindings[0]['workspace_id'], 'ws')
    binding = _id(bindings[0]['id'], 'binding')
    identity = list(_rows(db, 'pip_runs', {'id': 64, 'pip_id': 64, 'workspace_id': 64,
        'binding_id': 64, 'status': 32}, 'id=? AND workspace_id=?', (run_id, workspace)))
    if not identity:
        raise _error('Run not found in the current workspace.', 'not_found')
    identity = identity[0]
    _id(identity['pip_id'], 'pip')
    if identity['binding_id'] != binding:
        raise _error('The run does not belong to this local workspace binding.')
    if identity['status'] not in ('succeeded', 'failed', 'cancelled'):
        raise _error('Finish or cancel the run before exporting its historical evidence.', 'not_terminal')
    row = next(_rows(db, 'pip_runs', {'manifest': MAX_CELL, 'result': MAX_CELL, 'error': MAX_CELL,
        'created_at': 40, 'started_at': 40, 'finished_at': 40}, 'id=? AND workspace_id=?', (run_id, workspace)))
    manifest = _object(row.pop('manifest'))
    if manifest.get('workspace_id') != workspace or manifest.get('pip_id', identity['pip_id']) != identity['pip_id']:
        raise _error('The saved manifest identity differs from its run.')
    from .pip_commit_paths import validate_parent as validate_path_parent
    from types import SimpleNamespace
    authority = next(_rows(db, 'pip_runs', {'id':64,'pip_id':64,'workspace_id':64,'binding_id':64,
        'requested_by':512,'idempotency_key':512}, 'id=? AND workspace_id=?',(run_id,workspace)))
    validate_path_parent(SimpleNamespace(db=db), authority, manifest)
    kind = manifest.get('run_kind', 'audit')
    if kind not in ('audit', 'conversation', 'draft', 'patch', 'test', 'personal_task'):
        raise _error('This run kind is not supported by the evidence exporter.')
    if identity['status'] == 'succeeded' and row['result'] is None:
        raise _error('The successful run is missing its recorded result.')
    for field in ('created_at', 'started_at', 'finished_at'):
        _text(row[field], 40, nullable=field == 'started_at')
    writer.record('header', {'format': 'dgc.pip-evidence.v1', 'schema_version': SCHEMA_VERSION,
        'exported_at': utc_now(), 'workspace_id': workspace, 'pip_id': identity['pip_id'], 'run_id': run_id,
        'notice': NOTICE, 'importable': False, 'restorable': False,
        'hash_definition': 'SHA-256 of exact UTF-8 bytes of all preceding JSONL records, including newlines; footer excluded.',
        'limits': {'bytes': MAX_BYTES, 'records': MAX_RECORDS, 'source_cell_bytes': MAX_CELL, 'seconds': MAX_SECONDS}})
    writer.record('run', {**identity, 'run_kind': kind, **_pick(row, ('created_at', 'started_at', 'finished_at'))})
    from .pip_sources import from_record
    from .pip_checkpoints import _text as evidence_text, _integer
    source = from_record(manifest)
    if type(manifest.get('schema_version')) is not int or manifest['schema_version'] != 1:
        raise _error('The saved manifest schema is unsupported.')
    if not isinstance(manifest.get('policy_digest'), str) or not re.fullmatch(r'[0-9a-f]{64}', manifest['policy_digest']):
        raise _error('The saved policy digest is malformed.')
    _integer(manifest.get('job_version'), 'Pinned job version', 1, 999999)
    from types import SimpleNamespace
    from .pip_pulse_results import stored as pulse_stored
    pulse = pulse_stored(SimpleNamespace(db=db), workspace, run_id)
    for field in ('pip_type', 'model', 'policy', 'trigger'):
        _text(manifest.get(field), 256, nullable=field == 'model' and pulse is not None)
    projected = {**_pick(manifest, ('schema_version', 'job_version', 'pip_type', 'run_kind',
        'model', 'policy', 'policy_digest', 'trigger')), **source}
    job = manifest.get('job')
    if not isinstance(job, dict):
        raise _error('The saved approved job is malformed.')
    projected['job'] = {key: evidence_text(job.get(key), 'Approved job '+key, maximum, multiline=key=='goal')
                        for key, maximum in (('name', 240), ('goal', 16000), ('source_ref', 256), ('pip_type', 32))}
    if pulse is not None:
        projected.update(execution_mode='standalone_plan', model_invoked=False,
                         verification_plan=manifest['job']['verification_plan'],
                         pulse_verification=manifest['pulse_verification'])
    writer.record('manifest_projection', projected)
    if row['error'] is not None:
        recorded_error = _object(row['error'])
        error = {'code': _text(recorded_error.get('code'), 128)}
        if recorded_error.get('message') is not None:
            error['message'] = evidence_text(recorded_error['message'], 'Recorded failure message', 6000, multiline=True)
        writer.record('recorded_error', error)
    result = None
    execution_digest = None
    if kind != 'conversation' and row['result'] is not None:
        result = _object(row['result'])
        if pulse is not None:
            result = pulse['receipt']
        elif kind == 'audit':
            from .pip_checkpoints import encode_result
            encode_result(result)
        elif kind == 'personal_task':
            from .pip_personal_results import validate
            validate(result)
        elif kind == 'draft':
            from .pip_drafts import validate_result
            validate_result(result, published=True)
        else:
            from .pip_execution import validate_execution_result
            from .pip_handoffs import validate_manifest as validate_handoff
            action = validate_handoff(manifest.get('handoff'), manifest)['payload']['action']
            result = validate_execution_result(result, action)
            from .pip_specialists import validate_result_for_manifest
            validate_result_for_manifest(result, manifest)
            from .pip_execution_reviews import _evidence as execution_evidence
            from types import SimpleNamespace
            validated = execution_evidence(SimpleNamespace(db=db), run_id)
            if validated is None:
                raise _error('Execution evidence does not belong to a completed execution run.')
            execution_digest = validated[1]
        writer.record('recorded_result', result)
    omissions = {'conversation_bodies': kind == 'conversation', 'source_files': 'excluded',
        'artifact_bodies': 'excluded', 'raw_sessions': 'excluded', 'activity_payloads': 'excluded',
        'private_manifest_fields': sorted(set(manifest) - set(projected)), 'relationships': {}}
    if manifest.get('handoff') is not None:
        from .pip_handoffs import validate_manifest
        pin = validate_manifest(manifest['handoff'], manifest)
        writer.record('reviewed_handoff_input', pin)
    # Direct checkpoint evidence and all of this checkpoint's bounded decisions.
    for checkpoint in _rows(db, 'pip_checkpoints', {'id': None, 'pip_id': 64, 'workspace_id': 64, 'payload': 65536},
            'run_id=?', (run_id,), limit=2):
        if checkpoint['pip_id'] != identity['pip_id'] or checkpoint['workspace_id'] != workspace:
            raise _error('The checkpoint belongs to a different Pip or workspace.')
        payload = _object(checkpoint['payload'])
        if payload.get('run_id') != run_id or payload.get('pip_id') != identity['pip_id'] or payload.get('workspace_id') != workspace:
            raise _error('The checkpoint payload does not match its recorded identity.')
        from .pip_checkpoints import _metadata_fields, _validate_metadata, _validate_occurrence, _validate_review
        if set(payload) != (_metadata_fields(payload)-{'id'}) | {'findings'}:
            raise _error('The checkpoint contains unsupported fields.')
        saved = {**payload, 'id': checkpoint['id']}
        _validate_metadata(saved, workspace_id=workspace, pip_id=identity['pip_id'])
        if from_record(saved) != source or kind != 'audit' or identity['status'] != 'succeeded':
            raise _error('Checkpoint source differs from its successful audit.')
        findings = saved['findings']
        if not isinstance(findings, list) or len(findings) > 16 or len(findings) != saved['counts']['total']:
            raise _error('Checkpoint findings exceed their saved count.')
        for index, finding in enumerate(findings):
            _validate_occurrence(finding, saved, reviews=False)
            if finding['finding_index'] != index:
                raise _error('Checkpoint finding order differs from its report.')
        from .pip_checkpoints import _FINDING_FIELDS
        if (not isinstance(result, dict) or [_pick(f, _FINDING_FIELDS) for f in findings] != result.get('findings')
                or saved['model'] != manifest['model'] or saved['job_version'] != manifest['job_version']):
            raise _error('Checkpoint evidence differs from its immutable run result.')
        writer.record('checkpoint', saved)
        reviews = _rows(db, 'pip_finding_reviews', {'finding_id': 128, 'finding_index': None, 'status': 16,
            'revision': None, 'actor': 128, 'reason': 1000, 'updated_at': 40}, 'checkpoint_id=?', (checkpoint['id'],),
            order='finding_index', limit=17)
        reviewed = 0
        for i, review in enumerate(reviews):
            if i >= 16:
                raise _error('Checkpoint finding review count exceeds its contract.')
            if i >= len(findings) or review['finding_id'] != findings[i]['finding_id'] or review['finding_index'] != i:
                raise _error('A finding review differs from its checkpoint identity.')
            _validate_review(_pick(review, ('status', 'revision', 'actor', 'reason', 'updated_at')))
            writer.record('finding_review', review)
            reviewed += 1
            for n, history in enumerate(_rows(db, 'pip_finding_review_history', {'finding_id': 128, 'revision': None,
                    'status': 16, 'actor': 128, 'reason': 1000, 'created_at': 40}, 'finding_id=?',
                    (review['finding_id'],), order='revision', limit=101)):
                if n >= 100:
                    raise _error('Finding review history exceeds its retained revision bound.')
                if history['revision'] != n+1 or history['revision'] > review['revision']:
                    raise _error('Finding review history is not a contiguous retained sequence.')
                _validate_review({'revision': history['revision'], 'status': history['status'], 'actor': history['actor'],
                                  'reason': history['reason'], 'updated_at': history['created_at']})
                writer.record('finding_review_history', history)
        if reviewed != len(findings):
            raise _error('A checkpoint finding decision is missing.')
    for n, review in enumerate(_rows(db, 'pip_execution_reviews', {'run_id': 64, 'revision': None,
            'result_digest': 64, 'status': 16, 'actor': 128, 'reason': 2000, 'created_at': 40},
            'run_id=?', (run_id,), order='revision', limit=101)):
        if n >= 100:
            raise _error('Execution review history exceeds its retained revision bound.')
        if review['result_digest'] != execution_digest or review['revision'] != n+1 or review['status'] not in ('open','accepted','dismissed'):
            raise _error('Execution review history does not match its result and revision sequence.')
        writer.record('execution_review', review)
    relations = (
        ('handoff_reference', 'pip_handoffs', 'workspace_id=? AND (source_run_id=? OR run_id=?)', (workspace, run_id, run_id),
         {'id': 64, 'workspace_id': 64, 'source_pip_id': 64, 'source_run_id': 64, 'target_pip_id': 64,
          'run_id': 64, 'status': 16, 'revision': None, 'payload_digest': 64}, 'created_at,id'),
        ('memory_reference', 'pip_memories', 'workspace_id=? AND source_run_id=?', (workspace, run_id),
         {'id': 64, 'source_run_id': 64, 'source_finding_index': None, 'digest': 64, 'status': 16,
          'revision': None, 'expires_at': 40}, 'seq'),
        ('context_reference', 'workspace_context_entries', 'workspace_id=? AND source_run_id=?', (workspace, run_id),
         {'id': 64, 'kind': 32, 'source_run_id': 64, 'source_finding_index': None, 'status': 16,
          'created_revision': None}, 'created_revision'),
    )
    for label, table, where, args, fields, order in relations:
        count = db.execute(f'SELECT count(*) FROM {table} WHERE {where}', args).fetchone()[0]
        returned = 0
        for reference in _rows(db, table, fields, where, args, order=order, limit=REFERENCE_PAGE):
            writer.record(label, reference); returned += 1
        omissions['relationships'][label] = {'total': count, 'included': returned, 'omitted': count-returned,
            'bodies': 'not_exported', 'external_records': True}
    # Session source references are embedded JSON, not an FK. Scan at most 1,000
    # bounded candidates, never read their transcript files or binding paths.
    candidates = db.execute('SELECT count(*) FROM workspace_session_outcomes WHERE workspace_id=?', (workspace,)).fetchone()[0]
    matched = included = scanned = 0
    for item in _rows(db, 'workspace_session_outcomes', {'id': 64, 'payload': 16384, 'digest': 64,
            'status': 16, 'entry_id': 64}, 'workspace_id=?', (workspace,), order='seq', limit=1000):
        writer.check(); scanned += 1
        payload = _object(item.pop('payload'))
        reference = payload.get('source_reference')
        if not isinstance(reference, dict):
            raise _error('A saved session statement has invalid source provenance.')
        selection = reference.get('selection')
        if selection == {'kind': 'pip_run', 'run_id': run_id}:
            matched += 1
            if included < REFERENCE_PAGE:
                writer.record('session_statement_reference', {**item, 'source_run_id': run_id,
                    'classification': 'user_reviewed_statement', 'verification': 'not_execution_verified'})
                included += 1
    omissions['relationships']['session_statement_reference'] = {'included': included, 'matching_scanned': matched,
        'omitted_matching': matched-included, 'candidates_scanned': scanned, 'candidates_unscanned': candidates-scanned,
        'bodies': 'not_exported', 'external_records': True}
    retained = db.execute('SELECT min(seq),max(seq),count(*) FROM workspace_events WHERE workspace_id=?', (workspace,)).fetchone()
    omissions['activity'] = {'body': 'not_exported', 'retained_oldest_seq': retained[0], 'retained_newest_seq': retained[1],
        'retained_workspace_events': retained[2], 'history_may_be_incomplete': True}
    writer.record('omissions', omissions)
    return workspace, identity['pip_id']


class _MarkdownWriter(_Writer):
    """Reuse all evidence authorization/validation before publishing just a document."""
    def __init__(self, *args):
        super().__init__(*args)
        self.document = {}

    def record(self, kind, value, *, footer=False):
        size = super().record(kind, value, footer=footer)
        if kind in ('run', 'manifest_projection', 'recorded_result'):
            self.document[kind] = redact_value(value, self.secrets)
        return size

    def finish_document(self):
        run = self.document.get('run', {})
        result = self.document.get('recorded_result', {})
        if run.get('status') != 'succeeded' or run.get('run_kind') not in ('personal_task', 'draft'):
            raise _error('Markdown export needs a completed personal result or Quill draft.')
        text = result.get('text') if run['run_kind'] == 'personal_task' else result.get('draft', {}).get('markdown')
        if not isinstance(text, str) or not text.strip():
            raise _error('The saved run has no document text.')
        name = self.document.get('manifest_projection', {}).get('job', {}).get('name', 'Pip result')
        raw = (f'# {name}\n\nSaved Pip result · {run["id"]}\n\n'
               'Model-authored document. Review before relying on or sharing it.\n\n'
               + text + '\n').encode('utf-8')
        if len(raw) > MAX_CELL:
            raise _error('The Markdown document exceeds its 128 KiB budget.', 'export_limit')
        self.check()
        self.stream.seek(0); self.stream.truncate(0); self.stream.write(raw)
        self.bytes, self.records = len(raw), 1
        self.digest = hashlib.sha256(raw)


def export_run(config, run_id, output, *, directory=None, format='jsonl'):
    """Human local CLI only; output publication is the sole intended mutation."""
    from .pip_access import require_unrestricted
    require_unrestricted(config)
    if format not in ('jsonl', 'markdown'):
        raise _error('Choose jsonl evidence or markdown document export.')
    _id(run_id, 'run')
    if not isinstance(output, (str, os.PathLike)):
        raise _error('Choose an absolute new destination file.')
    destination = Path(output)
    if not destination.is_absolute() or '..' in destination.parts or destination.name in ('', '.', '..'):
        raise _error('Choose an absolute new destination file.')
    root = canonical_directory(config.project_root)
    parent = _directory(destination.parent)
    temporary = '.dgc-pip-export-' + uuid.uuid4().hex + '.partial'
    owned = None
    try:
        parent_info = os.fstat(parent)
        if parent_info.st_uid != os.getuid() or parent_info.st_mode & 0o022:
            raise _error('Choose a destination directory owned by the current user and not writable by other users.')
        try:
            os.stat(destination.name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise _error('The export destination already exists; it will not be replaced.', 'destination_exists')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        owned = os.fstat(fd)
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            writer = (_MarkdownWriter if format == 'markdown' else _Writer)(stream, secret_values(config), time.monotonic() + MAX_SECONDS)
            with _read_database(directory if directory is not None else state_directory()) as db:
                db.set_progress_handler(lambda: int(time.monotonic() >= writer.deadline), 1000)
                workspace, pip_id = _evidence(db, run_id, root, writer)
            footer_bytes = 0
            if format == 'markdown':
                writer.finish_document()
            digest = writer.digest.hexdigest()
            if format == 'jsonl':
                footer_bytes = writer.record('footer', {'complete': True, 'sha256': digest,
                    'hashed_bytes': writer.bytes, 'hashed_records': writer.records, 'record_counts': dict(writer.counts),
                    'redacted_records': writer.redacted, 'footer_excluded_from_hash': True}, footer=True)
            stream.flush(); os.fsync(stream.fileno())
            writer.check()
            current = os.stat(temporary, dir_fd=parent, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (owned.st_dev, owned.st_ino) or current.st_nlink != 1:
                raise _error('The export partial file changed before publication.')
            _same_parent(destination.parent, parent)
            # link() is atomic and refuses even a concurrently created destination;
            # unlike rename(), it cannot overwrite another file.
            os.link(temporary, destination.name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            os.unlink(temporary, dir_fd=parent); owned = None
            os.fsync(parent)
        return {'export': {'path': str(destination), 'format': 'text/markdown' if format == 'markdown' else 'dgc.pip-evidence.v1', 'workspace_id': workspace,
            'pip_id': pip_id, 'run_id': run_id, 'bytes': writer.bytes + footer_bytes, 'records': writer.records + int(format == 'jsonl'),
            'sha256': digest, 'footer_excluded_from_hash': format == 'jsonl', 'notice': NOTICE}}
    finally:
        if owned is not None:
            with contextlib.suppress(FileNotFoundError):
                current = os.stat(temporary, dir_fd=parent, follow_symlinks=False)
                if (current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino):
                    os.unlink(temporary, dir_fd=parent)
        os.close(parent)
