"""Explicitly reviewed session statements, never reconstructed test attestations.

Only bounded session identity/generation metadata is retained. The streaming JSON
reader validates and hashes the complete private transcript without materializing
its messages. A selected source is a reference for a statement, not evidence that
any transcript command executed on that source.
"""
from __future__ import annotations

import codecs
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from .workspace_registry import RegistryError, _execute_schema, canonical_directory, identifier
from .workspace_context import ContextStore, _integer, _json_bytes, _text

MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
MAX_STATEMENT_BYTES = 1536
MAX_PROPOSAL_BYTES = 8192
MAX_PROPOSALS = 1000
MAX_PENDING = 32
MAX_DEPTH = 64
MAX_VALUES = 200000
_SID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,255}\Z')
_SHA = re.compile(r'[0-9a-f]{64}\Z')
_COMMIT = re.compile(r'(?:[0-9a-f]{40}|[0-9a-f]{64})\Z')
_NUMBER = re.compile(r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?\Z')
_NOTICE = ('User-reviewed statement; execution was not verified. The source reference was selected for this statement, '
           'not recorded as the source used by a command. This grants no tools, permissions or execution.\n\n')
_PAYLOAD_KEYS = {'id', 'workspace_id', 'session', 'title', 'statement', 'source_reference',
                 'classification', 'verification', 'created_at', 'created_by'}
SCHEMA = """
CREATE TABLE workspace_session_outcomes(
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    session_id TEXT NOT NULL REFERENCES session_workspaces(session_id),
    request_key TEXT NOT NULL, request_digest TEXT NOT NULL, binding_pin TEXT NOT NULL,
    payload TEXT NOT NULL, digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),
    reviewed_at TEXT, reviewed_by TEXT, entry_id TEXT REFERENCES workspace_context_entries(id),
    UNIQUE(workspace_id,session_id,request_key),
    CHECK((status='pending' AND reviewed_at IS NULL AND reviewed_by IS NULL AND entry_id IS NULL) OR
          (status='accepted' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND entry_id IS NOT NULL) OR
          (status='rejected' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND entry_id IS NULL)));
CREATE INDEX workspace_session_outcomes_page ON workspace_session_outcomes(workspace_id,seq);
CREATE TRIGGER immutable_session_outcome
    BEFORE UPDATE OF seq,id,workspace_id,session_id,request_key,request_digest,binding_pin,payload,digest
    ON workspace_session_outcomes BEGIN SELECT RAISE(ABORT,'immutable session statement'); END;
CREATE TRIGGER retained_session_outcome BEFORE DELETE ON workspace_session_outcomes
    BEGIN SELECT RAISE(ABORT,'retained session statement'); END;
CREATE TRIGGER review_session_outcome BEFORE UPDATE OF status,reviewed_at,reviewed_by,entry_id
    ON workspace_session_outcomes WHEN OLD.status!='pending' OR NEW.status NOT IN ('accepted','rejected')
    BEGIN SELECT RAISE(ABORT,'session statement can be reviewed once'); END;
"""


def migrate_v12(registry):
    from .workspace_registry import _SCHEMA_V2
    schema = _SCHEMA_V2[_SCHEMA_V2.index('CREATE TABLE workspace_context_entries'):]
    schema = schema[:schema.index('CREATE TRIGGER monotonic_context_revision')]
    schema = schema.replace("'exception','finding'", "'exception','finding','execution','session_outcome'")
    schema = schema.replace("(kind!='finding' AND source_run_id IS NULL AND source_finding_index IS NULL)",
        "(kind='execution' AND source_run_id IS NOT NULL AND source_finding_index IS NULL) OR\n"
        "          (kind NOT IN ('finding','execution') AND source_run_id IS NULL AND source_finding_index IS NULL)")
    for name in ('immutable_context_entry', 'immutable_context_history', 'one_way_context_archive'):
        registry.db.execute('DROP TRIGGER ' + name)
    for name in ('workspace_context_active', 'workspace_context_finding_active', 'workspace_context_execution_active'):
        registry.db.execute('DROP INDEX ' + name)
    registry.db.execute('ALTER TABLE workspace_context_entries RENAME TO workspace_context_entries_v11')
    _execute_schema(registry.db, schema)
    registry.db.execute('INSERT INTO workspace_context_entries SELECT * FROM workspace_context_entries_v11')
    registry.db.execute('DROP TABLE workspace_context_entries_v11')
    registry.db.execute("CREATE UNIQUE INDEX workspace_context_execution_active ON workspace_context_entries(workspace_id,source_run_id) WHERE kind='execution' AND status='active'")
    _execute_schema(registry.db, SCHEMA)


def _error(message, code='invalid_session_outcome'):
    return RegistryError(code, message)


def _hash(value):
    return hashlib.sha256(_json_bytes(value, MAX_PROPOSAL_BYTES)).hexdigest()


def _id(value, prefix):
    if not isinstance(value, str) or not re.fullmatch(prefix + r'_[0-9a-f]{32}', value):
        raise _error('A session statement has an invalid identity.')
    return value


def _sid(value):
    if not isinstance(value, str) or not _SID.fullmatch(value):
        raise _error('Select a session identity from this workspace; paths are not accepted.')
    return value


class _JSONStream:
    """Strict full JSON validation with bounded tokens, depth and retained keys."""
    def __init__(self, handle):
        self.handle = handle
        self.decoder = codecs.getincrementaldecoder('utf-8')('strict')
        self.buffer, self.position, self.done = '', 0, False
        self.digest, self.bytes, self.values, self.key_bytes = hashlib.sha256(), 0, 0, 0

    def peek(self):
        while self.position == len(self.buffer) and not self.done:
            raw = self.handle.read(65536)
            self.bytes += len(raw)
            if self.bytes > MAX_TRANSCRIPT_BYTES:
                raise _error('The session exceeds the 8 MiB statement-review limit.', 'session_limit')
            self.digest.update(raw)
            self.done = not raw
            self.buffer = self.decoder.decode(raw, final=self.done)
            self.position = 0
        return self.buffer[self.position] if self.position < len(self.buffer) else ''

    def pop(self):
        value = self.peek()
        if value:
            self.position += 1
        return value

    def expect(self, expected):
        if self.pop() != expected:
            raise _error('The session is not complete valid JSON.', 'invalid_record')

    def space(self):
        while self.peek() and self.peek() in ' \t\r\n':
            self.pop()

    def string(self, limit=0):
        self.expect('"')
        kept = [] if limit else None
        length = 0
        while True:
            char = self.pop()
            if not char or ord(char) < 32:
                raise _error('The session contains an invalid JSON string.', 'invalid_record')
            if char == '"':
                return ''.join(kept) if kept is not None else None
            if char == '\\':
                char = self.pop()
                if char == 'u':
                    digits = ''.join(self.pop() for _ in range(4))
                    if not re.fullmatch(r'[0-9a-fA-F]{4}', digits):
                        raise _error('The session has an invalid Unicode escape.', 'invalid_record')
                    scalar = int(digits, 16)
                    if 0xD800 <= scalar <= 0xDBFF:
                        self.expect('\\'); self.expect('u')
                        low = ''.join(self.pop() for _ in range(4))
                        if not re.fullmatch(r'[0-9a-fA-F]{4}', low) or not 0xDC00 <= int(low, 16) <= 0xDFFF:
                            raise _error('The session contains an unpaired Unicode surrogate.', 'invalid_record')
                        scalar = 0x10000 + ((scalar - 0xD800) << 10) + int(low, 16) - 0xDC00
                    elif 0xDC00 <= scalar <= 0xDFFF:
                        raise _error('The session contains an unpaired Unicode surrogate.', 'invalid_record')
                    char = chr(scalar)
                elif char in ('"', '\\', '/', 'b', 'f', 'n', 'r', 't'):
                    char = {'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t'}.get(char, char)
                else:
                    raise _error('The session has an invalid JSON escape.', 'invalid_record')
            if kept is not None:
                length += len(char.encode('utf-8'))
                if length > limit:
                    raise _error('Session metadata exceeds its review budget.', 'session_limit')
                kept.append(char)

    def value(self, depth=0, *, metadata=False, messages=False):
        self.values += 1
        if self.values > MAX_VALUES or depth > MAX_DEPTH:
            raise _error('The session exceeds its JSON nesting or value budget.', 'session_limit')
        self.space()
        char = self.peek()
        if messages and char != '[':
            raise _error('Session messages must be an array.', 'invalid_record')
        if char == '{':
            self.pop(); self.space()
            keys, retained = set(), {}
            local_bytes = 0
            try:
                if self.peek() == '}':
                    self.pop(); return retained if metadata else None
                while True:
                    self.space()
                    key = self.string(1024)
                    if key in keys:
                        raise _error('The session contains duplicate JSON object keys.', 'invalid_record')
                    size = len(key.encode('utf-8'))
                    local_bytes += size; self.key_bytes += size
                    if self.key_bytes > 65536 or len(keys) >= 1024:
                        raise _error('Session JSON keys exceed their review budget.', 'session_limit')
                    keys.add(key); self.space(); self.expect(':')
                    if metadata and key in ('id', 'project'):
                        self.space(); retained[key] = self.string(4096 if key == 'project' else 256)
                    elif metadata and key == 'revision':
                        retained[key] = self.value(depth + 1, metadata=True)
                    elif metadata and key == 'messages':
                        self.value(depth + 1, messages=True); retained['messages'] = True
                    else:
                        self.value(depth + 1)
                    self.space(); end = self.pop()
                    if end == '}':
                        return retained if metadata else None
                    if end != ',':
                        raise _error('The session contains an incomplete JSON object.', 'invalid_record')
            finally:
                self.key_bytes -= local_bytes
        if char == '[':
            self.pop(); self.space()
            if self.peek() == ']':
                self.pop(); return None
            while True:
                self.space()
                if messages and self.peek() != '{':
                    raise _error('Each session message must be a JSON object.', 'invalid_record')
                self.value(depth + 1)
                self.space(); end = self.pop()
                if end == ']':
                    return None
                if end != ',':
                    raise _error('The session contains an incomplete JSON array.', 'invalid_record')
        if char == '"':
            self.string(); return None
        for literal, value in (('true', True), ('false', False), ('null', None)):
            if char == literal[0]:
                for expected in literal:
                    self.expect(expected)
                return value if metadata else None
        token = ''
        while self.peek() and self.peek() not in ' \t\r\n,]}':
            token += self.pop()
            if len(token) > 128:
                raise _error('A JSON scalar exceeds its review budget.', 'session_limit')
        if not _NUMBER.fullmatch(token):
            raise _error('The session contains an invalid JSON scalar.', 'invalid_record')
        if metadata:
            if re.fullmatch(r'-?(?:0|[1-9][0-9]*)', token):
                return int(token)
            raise _error('Session revision must be an integer.', 'invalid_record')
        return None

    def read(self):
        self.space()
        if self.peek() != '{':
            raise _error('A session transcript must be a JSON object.', 'invalid_record')
        value = self.value(metadata=True)
        self.space()
        if self.peek():
            raise _error('The session has trailing data.', 'invalid_record')
        return value


def _signature(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _open_directory(path):
    if os.name != 'posix' or not hasattr(os, 'O_NOFOLLOW') or os.open not in os.supports_dir_fd:
        raise _error('Safe session-statement inspection requires POSIX no-follow directory descriptors.', 'unsupported_platform')
    path = Path(path)
    if not path.is_absolute():
        raise _error('Private session storage must have an absolute path.', 'unsafe_session')
    fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in path.parts[1:]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        info = os.fstat(fd)
        if info.st_uid != os.getuid():
            raise _error('The private session directory belongs to another user.', 'unsafe_session')
        return fd
    except BaseException:
        os.close(fd); raise


@contextlib.contextmanager
def inspect_session(root, session_id):
    """Hash/validate under the ordinary session lease; yield metadata and cheap CAS."""
    from . import sessions
    _sid(session_id)
    bucket = sessions.SESSIONS_DIR / sessions._slug(root)
    path = bucket / (session_id + '.json')
    directory_fd = file_fd = None
    try:
        directory_fd = _open_directory(bucket)
        directory_identity = os.fstat(directory_fd)
        with sessions._lock_for(path):
            # A retired source bucket is never a second live copy of a moved chat.
            if os.path.lexists(bucket / '.session-migrations' / session_id / 'retired'):
                raise _error('This session was moved; select it in its reviewed destination.', 'session_moved')
            before = os.stat(path.name, dir_fd=directory_fd, follow_symlinks=False)
            if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.getuid()):
                raise _error('Session review refuses links, shared files and special files.', 'unsafe_session')
            if not 0 < before.st_size <= MAX_TRANSCRIPT_BYTES:
                raise _error('The session must be nonempty and at most 8 MiB for statement review.', 'session_limit')
            file_fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
            if _signature(os.fstat(file_fd)) != _signature(before):
                raise _error('The session changed before inspection; retry the review.', 'session_changed')
            with os.fdopen(os.dup(file_fd), 'rb') as handle:
                parser = _JSONStream(handle)
                record = parser.read()
            revision = record.get('revision', 0)
            if (record.get('id') != session_id or record.get('project') != str(root)
                    or record.get('messages') is not True or type(revision) is not int or not 0 <= revision <= 2147483647):
                raise _error('The session identity, project, messages or revision does not match this workspace.', 'invalid_record')
            receipt = {'id': session_id, 'revision': revision, 'sha256': parser.digest.hexdigest(), 'bytes': parser.bytes}
            def check():
                current_fd = _open_directory(bucket)
                try:
                    current = os.fstat(current_fd)
                    if (current.st_dev, current.st_ino) != (directory_identity.st_dev, directory_identity.st_ino):
                        raise _error('The private session directory changed during review.', 'session_changed')
                    latest = os.stat(path.name, dir_fd=current_fd, follow_symlinks=False)
                    if _signature(latest) != _signature(before) or _signature(os.fstat(file_fd)) != _signature(before):
                        raise _error('The session changed during review; create a new statement proposal.', 'session_changed')
                finally:
                    os.close(current_fd)
            check()
            yield receipt, check
    except RegistryError:
        raise
    except (OSError, UnicodeError, ValueError, RecursionError):
        raise _error('The private session cannot be safely inspected; check its file and retry.', 'invalid_record') from None
    finally:
        if file_fd is not None:
            os.close(file_fd)
        if directory_fd is not None:
            os.close(directory_fd)


def _selection(value):
    if isinstance(value, dict) and len(value) == 2 and set(value) == {'kind', 'revision'} and value['kind'] == 'commit':
        if isinstance(value['revision'], str) and _COMMIT.fullmatch(value['revision']):
            return dict(value)
    if isinstance(value, dict) and len(value) == 2 and set(value) == {'kind', 'run_id'} and value['kind'] == 'pip_run':
        _id(value['run_id'], 'run'); return dict(value)
    raise _error('Select an exact Git commit or a completed Pip run from this workspace; arbitrary source metadata is refused.')


def _source(registry, workspace_id, binding, selection):
    from .pip_sources import pin, from_record
    if selection['kind'] == 'commit':
        from .pips import source_revision
        revision = source_revision(binding['canonical_root'], selection['revision'])
        if revision != selection['revision']:
            raise _error('The selected source is not the exact requested commit.', 'source_changed')
        source = pin('committed_only', source_revision=revision)
        token = None
    else:
        row = registry.db.execute('SELECT id,workspace_id, '
            'CASE WHEN length(CAST(pip_id AS BLOB))<=64 THEN pip_id ELSE NULL END AS pip_id, '
            'CASE WHEN length(CAST(binding_id AS BLOB))<=64 THEN binding_id ELSE NULL END AS binding_id, '
            'CASE WHEN typeof(requested_by)=\'text\' AND length(CAST(requested_by AS BLOB))<=512 THEN requested_by END AS requested_by, '
            'CASE WHEN typeof(idempotency_key)=\'text\' AND length(CAST(idempotency_key AS BLOB))<=512 THEN idempotency_key END AS idempotency_key, '
            'CASE WHEN length(CAST(status AS BLOB))<=16 THEN status ELSE NULL END AS status, '
            'CASE WHEN length(CAST(manifest AS BLOB))<=131072 THEN manifest ELSE NULL END AS manifest, '
            'CASE WHEN length(CAST(result AS BLOB))<=65536 THEN result ELSE NULL END AS result '
            'FROM pip_runs WHERE id=? AND workspace_id=?', (selection['run_id'], workspace_id)).fetchone()
        if row is None or row['status'] != 'succeeded' or row['binding_id'] != binding['id']:
            raise _error('Select a successfully completed source run in this workspace and binding.', 'source_unavailable')
        try:
            manifest, result = json.loads(row['manifest']), json.loads(row['result'])
        except (ValueError, TypeError, RecursionError):
            raise _error('The selected source run is invalid or exceeds its metadata budget.', 'source_unavailable') from None
        if (not isinstance(manifest, dict) or not isinstance(result, dict)
                or manifest.get('workspace_id') != workspace_id or manifest.get('pip_id') != row['pip_id']
                or manifest.get('binding_id') != row['binding_id']):
            raise _error('The selected run does not match its immutable source identity.', 'source_unavailable')
        # Selecting historical source is not execution verification, but a new
        # committed-path run must still match its original reviewed event job.
        # This check is DB-only and leaves legacy source references unchanged.
        from .pip_commit_paths import validate_parent as validate_path_parent
        validate_path_parent(registry, row, manifest)
        source = from_record(manifest)
        if source['source_snapshot'] is not None and result.get('snapshot') != {
                key: source['source_snapshot'][key] for key in ('sha256', 'files', 'bytes')}:
            raise _error('The completed run does not preserve its captured source receipt.', 'source_unavailable')
        token = (row['id'], row['pip_id'], row['workspace_id'], row['binding_id'], row['status'], row['manifest'], row['result'])
    return {'selection': selection, **source, 'relation': 'selected_for_statement'}, token


def _validate_reference(value):
    from .pip_sources import from_record
    if (not isinstance(value, dict) or set(value) != {'selection', 'source_policy', 'source_revision', 'source_snapshot', 'relation'}
            or value['relation'] != 'selected_for_statement'):
        raise _error('Session statements must identify a selected source reference, not execution evidence.')
    selected = _selection(value['selection'])
    source = from_record(value)
    if selected['kind'] == 'commit' and (source['source_policy']['mode'] != 'committed_only' or source['source_revision'] != selected['revision']):
        raise _error('The statement source reference disagrees with its exact commit.')


def _validate_payload(value):
    if not isinstance(value, dict) or set(value) != _PAYLOAD_KEYS:
        raise _error('A saved session statement has unsupported fields.')
    _id(value['id'], 'outcome'); _id(value['workspace_id'], 'ws')
    session = value['session']
    if not isinstance(session, dict) or set(session) != {'id', 'revision', 'sha256', 'bytes'}:
        raise _error('A session statement requires its exact historical generation.')
    _sid(session['id']); _integer(session['revision'], 'Session revision'); _integer(session['bytes'], 'Session bytes', 1, MAX_TRANSCRIPT_BYTES)
    if not isinstance(session['sha256'], str) or not _SHA.fullmatch(session['sha256']):
        raise _error('The session digest is invalid.')
    _text(value['title'], 'Statement title', 240)
    _text(value['statement'], 'Reviewed statement', MAX_STATEMENT_BYTES, multiline=True)
    _text(value['created_at'], 'Statement creation time', 40); _text(value['created_by'], 'Statement author', 128)
    if value['classification'] != 'user_reviewed_statement' or value['verification'] != 'not_execution_verified':
        raise _error('A session statement cannot impersonate verified tests or a runner receipt.')
    _validate_reference(value['source_reference'])
    _json_bytes(value, MAX_PROPOSAL_BYTES)
    return value


def content_for(provenance):
    return _NOTICE + provenance['proposal']['statement']


def validate_entry(entry):
    value = entry['provenance']
    if (not isinstance(value, dict) or set(value) != {'source', 'proposal', 'proposal_digest'}
            or value['source'] != 'session_statement'):
        raise _error('Session context must preserve its reviewed statement provenance.')
    proposal = _validate_payload(value['proposal'])
    if (value['proposal_digest'] != _hash(proposal)
            or entry['title'] != proposal['title'] or entry['content'] != content_for(value)):
        raise _error('Session context does not match the exact reviewed statement.')


class SessionOutcomeStore:
    def __init__(self, registry):
        self.registry, self.db = registry, registry.db

    def _scope(self, workspace_id, session_id, config):
        if config.get('pips_enabled', False) is not True:
            raise _error('Enable Pips before recording workspace session statements.', 'disabled')
        from .pip_access import require_unrestricted
        require_unrestricted(config)
        _id(workspace_id, 'ws'); _sid(session_id)
        root = canonical_directory(config.project_root)
        binding = self.registry.binding(workspace_id)
        identity = self.registry.session_identity(session_id)
        if (binding['canonical_root'] != str(root) or identity != {'workspace_id': workspace_id,
                'workspace_binding_id': binding['id'], 'runner_id': self.registry.runner_id}):
            raise _error('The session must be privately associated with this exact local workspace binding.', 'session_required')
        info = root.stat()
        return {**binding, 'root_device': info.st_dev, 'root_inode': info.st_ino}

    def _row(self, workspace_id, proposal_id):
        _id(workspace_id, 'ws'); _id(proposal_id, 'outcome')
        scalars = {'id': 64, 'workspace_id': 64, 'session_id': 256, 'status': 16,
                   'digest': 64, 'reviewed_at': 40, 'reviewed_by': 128, 'entry_id': 64}
        selected = ','.join('CASE WHEN length(CAST(' + key + ' AS BLOB))<=' + str(size) + ' THEN ' + key + ' ELSE NULL END AS ' + key
                            for key, size in scalars.items())
        row = self.db.execute('SELECT seq,' + selected + ', '
            'CASE WHEN length(CAST(binding_pin AS BLOB))<=8192 THEN binding_pin ELSE NULL END AS binding_pin, '
            'CASE WHEN length(CAST(payload AS BLOB))<=8192 THEN payload ELSE NULL END AS payload '
            'FROM workspace_session_outcomes WHERE id=? AND workspace_id=?',
            (proposal_id, workspace_id)).fetchone()
        if row is None:
            raise _error('Session statement proposal not found in this workspace.', 'not_found')
        try:
            payload, binding = json.loads(row['payload']), json.loads(row['binding_pin'])
        except (ValueError, TypeError, RecursionError):
            raise _error('The saved proposal is invalid or exceeds its data budget.', 'stored_data_limit') from None
        _validate_payload(payload)
        if (payload['id'] != row['id'] or payload['workspace_id'] != row['workspace_id'] or payload['session']['id'] != row['session_id']
                or _hash(payload) != row['digest'] or not isinstance(binding, dict)
                or set(binding) != {'id', 'workspace_id', 'runner_id', 'canonical_root', 'updated_at', 'root_device', 'root_inode'}
                or binding.get('workspace_id') != workspace_id or not isinstance(binding.get('canonical_root'), str)):
            raise _error('The saved proposal does not match its private review identity.', 'stored_data_limit')
        _id(binding['id'], 'binding'); _id(binding['runner_id'], 'runner')
        _text(binding['canonical_root'], 'Private workspace root', 4096); _text(binding['updated_at'], 'Binding time', 40)
        _integer(binding['root_device'], 'Root device', 0, 2**64 - 1); _integer(binding['root_inode'], 'Root inode', 0, 2**64 - 1)
        if row['status'] not in ('pending', 'accepted', 'rejected'):
            raise _error('The saved proposal has an invalid review state.', 'stored_data_limit')
        if row['status'] == 'pending':
            if any(row[key] is not None for key in ('reviewed_at', 'reviewed_by', 'entry_id')):
                raise _error('The pending statement contains a false review receipt.', 'stored_data_limit')
        else:
            _text(row['reviewed_at'], 'Review time', 40); _text(row['reviewed_by'], 'Reviewer', 128)
            if row['status'] == 'accepted':
                _id(row['entry_id'], 'ctx')
                entry = self.db.execute('SELECT CASE WHEN length(CAST(kind AS BLOB))<=16 THEN kind ELSE NULL END AS kind, '
                    'CASE WHEN length(CAST(title AS BLOB))<=240 THEN title ELSE NULL END AS title, '
                    'CASE WHEN length(CAST(content AS BLOB))<=4096 THEN content ELSE NULL END AS content, '
                    'CASE WHEN length(CAST(provenance AS BLOB))<=6144 THEN provenance ELSE NULL END AS provenance '
                    'FROM workspace_context_entries WHERE id=? AND workspace_id=?', (row['entry_id'], workspace_id)).fetchone()
                expected_provenance = {'source': 'session_statement', 'proposal': payload, 'proposal_digest': row['digest']}
                try:
                    provenance = json.loads(entry['provenance']) if entry is not None else None
                except (TypeError, ValueError, RecursionError):
                    provenance = None
                if (entry is None or entry['kind'] != 'session_outcome' or entry['title'] != payload['title']
                        or entry['content'] != content_for(expected_provenance) or provenance != expected_provenance):
                    raise _error('The accepted statement does not match its immutable workspace-context entry.', 'stored_data_limit')
            elif row['entry_id'] is not None:
                raise _error('A rejected statement cannot claim a context entry.', 'stored_data_limit')
        result = {**payload, **{key: row[key] for key in ('digest', 'status', 'reviewed_at', 'reviewed_by', 'entry_id')}}
        return row, binding, result

    def get(self, workspace_id, proposal_id):
        return {'workspace_id': workspace_id, 'proposal': self._row(workspace_id, proposal_id)[2]}

    def inspect(self, workspace_id, session_id, *, config):
        if self.db.in_transaction:
            raise _error('Inspect session data before opening a database transaction.', 'preparation_required')
        binding = self._scope(workspace_id, session_id, config)
        with inspect_session(Path(binding['canonical_root']), session_id) as (session, check):
            if self._scope(workspace_id, session_id, config) != binding:
                raise _error('The workspace binding changed during inspection.', 'conflict')
            check()
            return {'workspace_id': workspace_id, 'session': session}

    def list(self, workspace_id, *, before_id=None, limit=20):
        _id(workspace_id, 'ws'); _integer(limit, 'Statement page size', 1, 20)
        if before_id is not None:
            _integer(before_id, 'Statement cursor', 1, 9007199254740991)
        self.registry.get(workspace_id)
        rows = self.db.execute('SELECT seq,CASE WHEN length(CAST(id AS BLOB))<=64 THEN id ELSE NULL END AS id FROM workspace_session_outcomes WHERE workspace_id=? AND seq<? ORDER BY seq DESC LIMIT ?',
            (workspace_id, before_id or 9007199254740991, limit + 1)).fetchall()
        proposals, size = [], 256
        for row in rows[:limit]:
            proposal = self._row(workspace_id, row['id'])[2]
            encoded = _json_bytes(proposal, MAX_PROPOSAL_BYTES + 1024)
            if size + len(encoded) > 65536:
                break
            proposals.append(proposal); size += len(encoded) + 1
        return {'workspace_id': workspace_id, 'proposals': proposals,
                'next_before_id': rows[len(proposals) - 1]['seq'] if len(rows) > len(proposals) else None}

    def propose(self, workspace_id, session_id, title, statement, source, expected_session_revision, request_key, actor, *, config):
        if self.db.in_transaction:
            raise _error('Inspect session/source data before opening a database transaction.', 'preparation_required')
        _integer(expected_session_revision, 'Expected session revision')
        _text(title, 'Statement title', 240); _text(statement, 'Reviewed statement', MAX_STATEMENT_BYTES, multiline=True)
        _text(request_key, 'Review retry key', 128); _text(actor, 'Authenticated author', 128)
        source = _selection(source)
        from .redaction import contains_secret, secret_values
        if contains_secret({'title': title, 'statement': statement, 'request_key': request_key}, secret_values(config)):
            raise _error('Remove credentials from the statement and retry key before review.', 'secret_detected')
        binding = self._scope(workspace_id, session_id, config)
        request_digest = _hash({'session_id': session_id, 'title': title, 'statement': statement, 'source': source,
                                'expected_session_revision': expected_session_revision, 'request_key': request_key, 'actor': actor})
        def saved():
            old = self.db.execute('SELECT CASE WHEN length(CAST(id AS BLOB))<=64 THEN id ELSE NULL END AS id, '
                                 'CASE WHEN length(CAST(request_digest AS BLOB))=64 THEN request_digest ELSE NULL END AS request_digest '
                                 'FROM workspace_session_outcomes WHERE workspace_id=? AND session_id=? AND request_key=?',
                                 (workspace_id, session_id, request_key)).fetchone()
            if old:
                if old['request_digest'] != request_digest:
                    raise _error('That retry key already identifies a different statement proposal.', 'conflict')
                return self.get(workspace_id, old['id'])
        previous = saved()
        if previous is not None:
            return previous
        reference, token = _source(self.registry, workspace_id, binding, source)
        with inspect_session(Path(binding['canonical_root']), session_id) as (session, check):
            if session['revision'] != expected_session_revision:
                raise _error('The session revision changed; inspect its current generation before proposing a statement.', 'session_changed')
            payload = _validate_payload({'id': identifier('outcome'), 'workspace_id': workspace_id, 'session': session,
                'title': title, 'statement': statement, 'source_reference': reference, 'classification': 'user_reviewed_statement',
                'verification': 'not_execution_verified', 'created_at': self.registry.clock(), 'created_by': actor})
            with self.registry.transaction():
                if self._scope(workspace_id, session_id, config) != binding:
                    raise _error('The workspace binding changed during review.', 'conflict')
                previous = saved()
                if previous is not None:
                    return previous
                check(); self._source_cas(token)
                if (self.db.execute('SELECT count(*) FROM workspace_session_outcomes').fetchone()[0] >= MAX_PROPOSALS
                        or self.db.execute("SELECT count(*) FROM workspace_session_outcomes WHERE workspace_id=? AND status='pending'", (workspace_id,)).fetchone()[0] >= MAX_PENDING):
                    raise _error('The statement review archive or pending queue is full; no proposal was created.', 'limit')
                self.db.execute('INSERT INTO workspace_session_outcomes(id,workspace_id,session_id,request_key,request_digest,binding_pin,payload,digest,status) VALUES(?,?,?,?,?,?,?,?,?)',
                    (payload['id'], workspace_id, session_id, request_key, request_digest, _json_bytes(binding, 8192).decode(),
                     _json_bytes(payload, MAX_PROPOSAL_BYTES).decode(), _hash(payload), 'pending'))
                self.registry.event(workspace_id, 'workspace_session_outcome_proposed', payload={'proposal_id': payload['id'], 'session_id': session_id})
            return self.get(workspace_id, payload['id'])

    def _source_cas(self, token):
        if token is None:
            return
        row = self.db.execute('SELECT id,pip_id,workspace_id,binding_id,status,manifest,result FROM pip_runs WHERE id=? '
            'AND length(CAST(pip_id AS BLOB))<=64 AND length(CAST(workspace_id AS BLOB))<=64 '
            'AND length(CAST(binding_id AS BLOB))<=64 AND length(CAST(status AS BLOB))<=16 '
            'AND length(CAST(manifest AS BLOB))<=131072 AND length(CAST(result AS BLOB))<=65536', (token[0],)).fetchone()
        if row is None or tuple(row) != token:
            raise _error('The selected source run changed before the review was stored.', 'source_changed')

    def accept(self, workspace_id, proposal_id, expected_digest, expected_context_revision, actor, *, config):
        if self.db.in_transaction:
            raise _error('Inspect session/source data before opening a database transaction.', 'preparation_required')
        _integer(expected_context_revision, 'Expected context revision'); _text(actor, 'Authenticated reviewer', 128)
        if config.get('pips_enabled', False) is not True:
            raise _error('Enable Pips before recording workspace session statements.', 'disabled')
        from .pip_access import require_unrestricted
        require_unrestricted(config)
        _id(workspace_id, 'ws'); _id(proposal_id, 'outcome')
        own = self.registry.lookup(canonical_directory(config.project_root))
        if own is None or own['id'] != workspace_id:
            raise _error('The statement must belong to this exact local workspace.', 'session_required')
        member = self.db.execute('SELECT CASE WHEN length(CAST(session_id AS BLOB))<=256 THEN session_id ELSE NULL END AS session_id '
            'FROM workspace_session_outcomes WHERE workspace_id=? AND id=?', (workspace_id, proposal_id)).fetchone()
        if member is None:
            raise _error('Session statement proposal not found in this workspace.', 'not_found')
        current_binding = self._scope(workspace_id, member['session_id'], config)
        row, binding, proposal = self._row(workspace_id, proposal_id)
        self._digest(expected_digest, row)
        if current_binding != binding:
            raise _error('The workspace binding changed since this proposal; prepare a new review.', 'conflict')
        if proposal['status'] == 'accepted':
            return {**self.get(workspace_id, proposal_id), 'context': ContextStore(self.registry).get(workspace_id), 'replayed': True}
        if proposal['status'] != 'pending':
            raise _error('This statement proposal was already rejected.', 'conflict')
        reference, token = _source(self.registry, workspace_id, binding, proposal['source_reference']['selection'])
        if reference != proposal['source_reference']:
            raise _error('The selected source no longer matches this proposal.', 'source_changed')
        with inspect_session(Path(binding['canonical_root']), row['session_id']) as (session, check):
            if session != proposal['session']:
                raise _error('The session changed since this proposal; prepare a new review.', 'session_changed')
            with self.registry.transaction():
                latest, _, review = self._row(workspace_id, proposal_id)
                self._digest(expected_digest, latest)
                if self._scope(workspace_id, row['session_id'], config) != binding:
                    raise _error('The workspace binding changed during review.', 'conflict')
                if review['status'] == 'accepted':
                    return {**self.get(workspace_id, proposal_id), 'context': ContextStore(self.registry).get(workspace_id), 'replayed': True}
                if review['status'] != 'pending':
                    raise _error('This proposal was reviewed concurrently.', 'conflict')
                check(); self._source_cas(token)
                hub = ContextStore(self.registry)
                view = hub._prepare(workspace_id, expected_context_revision, actor)
                payload = {key: review[key] for key in _PAYLOAD_KEYS}
                provenance = {'source': 'session_statement', 'proposal': payload, 'proposal_digest': review['digest']}
                context = hub._append(view, 'session_outcome', review['title'], content_for(provenance), actor, provenance)
                entry_id = context['entries'][-1]['id']
                self.db.execute("UPDATE workspace_session_outcomes SET status='accepted',reviewed_at=?,reviewed_by=?,entry_id=? WHERE id=? AND status='pending'",
                    (self.registry.clock(), actor, entry_id, proposal_id))
            return {**self.get(workspace_id, proposal_id), 'context': context, 'replayed': False}

    @staticmethod
    def _digest(expected, row):
        if not isinstance(expected, str) or not _SHA.fullmatch(expected) or expected != row['digest']:
            raise _error('The proposal digest changed; review the exact saved statement before deciding.', 'conflict')

    def reject(self, workspace_id, proposal_id, expected_digest, actor):
        _text(actor, 'Authenticated reviewer', 128)
        with self.registry.transaction():
            row, _, proposal = self._row(workspace_id, proposal_id)
            self._digest(expected_digest, row)
            if proposal['status'] == 'accepted':
                raise _error('This statement is already recorded; archive its context entry instead.', 'conflict')
            if proposal['status'] == 'pending':
                self.db.execute("UPDATE workspace_session_outcomes SET status='rejected',reviewed_at=?,reviewed_by=? WHERE id=? AND status='pending'",
                    (self.registry.clock(), actor, proposal_id))
                self.registry.event(workspace_id, 'workspace_session_outcome_rejected', payload={'proposal_id': proposal_id})
        return self.get(workspace_id, proposal_id)
