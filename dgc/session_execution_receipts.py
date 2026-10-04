"""Private controller facts for foreground configured verifiers, never test proof.

No transcript parsing, source copies, process launch, replay or context promotion.
An attempt without a final is unfinalized, including after a controller crash.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import uuid

from . import pip_tree_snapshot as tree
from .permissions import ALLOW, PermissionEngine
from .pip_access import restricted
from .redaction import contains_secret, secret_values
from .workspace_registry import RegistryError, WorkspaceRegistry, canonical_directory, utc_now

MAX_RECORD_BYTES = 16384
MAX_COMMAND_BYTES = 8192
MAX_PREVIEW_BYTES = 4096
MAX_ATTEMPTS = 10000
SCHEMA = """
CREATE TABLE session_execution_attempts(
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session_workspaces(session_id),
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=16384),
 digest TEXT NOT NULL CHECK(length(digest)=64), created_at TEXT NOT NULL);
CREATE TABLE session_execution_finals(
 attempt_id TEXT PRIMARY KEY REFERENCES session_execution_attempts(id),
 body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=16384),
 digest TEXT NOT NULL CHECK(length(digest)=64), created_at TEXT NOT NULL);
CREATE INDEX session_execution_scope ON session_execution_attempts(workspace_id,session_id,created_at,id);
CREATE TRIGGER immutable_session_execution_attempt_update BEFORE UPDATE ON session_execution_attempts
 BEGIN SELECT RAISE(ABORT,'execution attempts are immutable'); END;
CREATE TRIGGER immutable_session_execution_attempt_delete BEFORE DELETE ON session_execution_attempts
 BEGIN SELECT RAISE(ABORT,'execution attempts are immutable'); END;
CREATE TRIGGER immutable_session_execution_final_update BEFORE UPDATE ON session_execution_finals
 BEGIN SELECT RAISE(ABORT,'execution finals are immutable'); END;
CREATE TRIGGER immutable_session_execution_final_delete BEFORE DELETE ON session_execution_finals
 BEGIN SELECT RAISE(ABORT,'execution finals are immutable'); END;
"""


def _encoded(value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')
    if len(raw) > MAX_RECORD_BYTES:
        raise RegistryError('receipt_limit', 'The execution receipt exceeds its byte limit.')
    return raw.decode('utf-8'), hashlib.sha256(raw).hexdigest()


def _permissions(config, mode):
    rules = {action: [*(config.permissions.get(action, []) or []),
                      *(getattr(config, 'session_permissions', {}).get(action, []) or [])]
             for action in ('allow', 'ask', 'deny')}
    return PermissionEngine(mode, rules, config.project_root)


def _can_observe(config, mode):
    if restricted(config):
        return False
    permission = _permissions(config, mode)
    return (not any(rule.action in ('ask', 'deny') and rule.tool in ('*', 'read_file', 'glob', 'repo_map')
                    for rule in permission.rules)
            and permission.decide('glob', {'pattern': '**/*'})[0] == ALLOW)


def observe(config, mode, expected_root, *, cancelled=None):
    """Stream a checked, non-atomic eligible-source hash; never retain source bytes.

Any path-limited read restriction conservatively disables whole-tree observation.
Limits protect allocation, not wall time on a stalled filesystem.
"""
    parent = fd = None
    def checkpoint():
        if cancelled is not None and cancelled.is_set():
            raise RegistryError('observation_cancelled', 'Source observation stopped at cancellation.')
    class CancellableDigest:
        def __init__(self, digest): self.digest = digest
        def update(self, value):
            checkpoint()
            self.digest.update(value)
        def hexdigest(self): return self.digest.hexdigest()
    try:
        checkpoint()
        if not _can_observe(config, mode):
            return {'status': 'unavailable', 'reason': 'source_permissions'}
        tree._platform()
        path, parent, fd, before = tree._root(config.project_root, expected_root)
        records, excluded, directories = tree._scan(fd, exclude=True)
        checkpoint()
        digest, files, total = CancellableDigest(tree._digest(records)), 0, 0
        secrets = tree._secrets(secret_values(config))
        for relative, (kind, version) in sorted(records.items()):
            if kind != 'file':
                continue
            checkpoint()
            if (not _can_observe(config, mode)
                    or _permissions(config, mode).decide('read_file', {'path': relative})[0] != ALLOW):
                return {'status': 'unavailable', 'reason': 'source_permissions'}
            tree._read(fd, relative, version, digest, secrets=secrets)
            files += 1
            total += version[4]
        tree._unchanged(path, parent, fd, before, records, exclude=True)
        checkpoint()
        return {'status': 'observed', 'kind': 'current_tree_observation',
                'sha256': digest.hexdigest(), 'files': files, 'bytes': total,
                'exclusions': tree.EXCLUSIONS, 'excluded_entries': excluded,
                'excluded_directories': directories, 'consistency': tree.CONSISTENCY}
    except RegistryError as error:
        allowed = {'snapshot_limit', 'unsafe_snapshot', 'source_changed', 'empty_snapshot',
                   'secret_in_source', 'unsupported_platform', 'observation_cancelled'}
        return {'status': 'unavailable', 'reason': error.code if error.code in allowed else 'source_unavailable'}
    except (OSError, ValueError, UnicodeError):
        return {'status': 'unavailable', 'reason': 'source_unavailable'}
    finally:
        for descriptor in (fd, parent):
            if descriptor is not None:
                os.close(descriptor)


def _scope(registry, config, origin):
    if (not isinstance(origin, dict) or set(origin) != {'session_id', 'workspace_id'}
            or not isinstance(origin['session_id'], str)
            or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', origin['session_id'])
            or not isinstance(origin['workspace_id'], str)
            or not re.fullmatch(r'ws_[0-9a-f]{32}', origin['workspace_id'])):
        raise RegistryError('receipt_scope', 'Execution receipts require the owning foreground session.')
    identity = registry.session_identity(origin['session_id'])
    if not identity or identity['workspace_id'] != origin['workspace_id']:
        raise RegistryError('receipt_scope', 'Execution receipt session association changed.')
    binding = registry.binding(origin['workspace_id'])
    if (binding['id'] != identity['workspace_binding_id'] or binding['runner_id'] != registry.runner_id
            or binding['canonical_root'] != str(canonical_directory(config.project_root))):
        raise RegistryError('receipt_scope', 'Execution receipt workspace binding changed.')
    return {'workspace_id': origin['workspace_id'], 'session_id': origin['session_id'],
            'binding_id': binding['id'], 'binding_updated_at': binding['updated_at'],
            'runner_id': registry.runner_id}


def _notice(notify, message):
    try:
        if callable(notify):
            notify(message)
    except Exception:
        pass


def begin(config, origin, command, turn_id, *, session_revision=0, mode='default', notify=None, cancelled=None):
    """Called only by the foreground controller; failure never cancels its command.

The caller must refuse Pip children/monitor turns and clone the tool context.
This function independently refuses disabled/restricted contexts before storage.
"""
    if config.get('pips_enabled', False) is not True or restricted(config):
        return None
    try:
        if (not isinstance(command, str) or not command.strip() or len(command) > MAX_COMMAND_BYTES
                or len(command.encode('utf-8')) > MAX_COMMAND_BYTES or '\0' in command
                or command != config.get('verify_command')
                or contains_secret(command, secret_values(config))
                or type(session_revision) is not int or not 0 <= session_revision <= 2**53-1
                or not isinstance(turn_id, str) or not re.fullmatch(r'turn_[0-9a-f]{32}', turn_id)):
            raise RegistryError('receipt_command', 'The configured command cannot be recorded safely.')
        with WorkspaceRegistry() as registry:
            scope = _scope(registry, config, origin)
            info = os.stat(config.project_root, follow_symlinks=False)
            root_identity = {'device': info.st_dev, 'inode': info.st_ino}
            before = observe(config, mode, root_identity, cancelled=cancelled)
            created_at = utc_now()
            attempt = {'schema_version': 1, 'id': 'exec_' + uuid.uuid4().hex,
                       **scope, 'turn_id': turn_id, 'kind': 'configured_verifier',
                       'session_revision_at_attempt': session_revision,
                       'classification': 'controller_observed_execution',
                       'verification': 'native_process_facts_only', 'root_identity': root_identity,
                       'command': command, 'command_sha256': hashlib.sha256(command.encode('utf-8')).hexdigest(),
                       'command_digest_kind': 'original_utf8', 'created_at': created_at,
                       'source_relation': 'observed_before_and_after_not_execution_attestation',
                       'source_before': before}
            body, digest = _encoded(attempt)
            with registry.transaction():
                if _scope(registry, config, origin) != scope:
                    raise RegistryError('receipt_scope', 'Execution receipt workspace changed during observation.')
                if registry.db.execute('SELECT count(*) FROM session_execution_attempts').fetchone()[0] >= MAX_ATTEMPTS:
                    raise RegistryError('receipt_limit', 'The execution receipt archive is full; no new receipt was saved.')
                registry.db.execute('INSERT INTO session_execution_attempts VALUES(?,?,?,?,?,?)',
                                    (attempt['id'], origin['session_id'], origin['workspace_id'], body, digest, created_at))
            return Capture(registry.directory, config, origin, mode, root_identity, attempt, digest, notify, cancelled)
    except Exception:
        _notice(notify, 'Execution receipt unavailable; the configured command will still run normally.')
        return None


def for_agent(agent, command, turn_id, *, cancelled=None):
    """One private controller entry; no receipt authority travels in tool args."""
    config = agent.config
    if (config.get('pips_enabled', False) is not True or restricted(config)
            or getattr(agent, 'depth', None) != 0 or getattr(agent, '_monitor_turn', False)
            or getattr(agent, '_parent_agent', None) is not None
            or getattr(agent, '_subagent_id', None) is not None
            or getattr(agent, '_agent_tool_allowlist', None) is not None):
        return None
    notify = getattr(agent.ui, 'info', None)
    try:
        if agent.ctx.project_root != config.project_root:
            raise RegistryError('receipt_scope', 'The foreground execution root differs from its configured workspace.')
        return begin(config, agent._pip_proposal_origin(), command, turn_id,
                     session_revision=agent._session_revision, mode=agent.mode, notify=notify, cancelled=cancelled)
    except Exception:
        _notice(notify, 'Execution receipt unavailable; the configured command will still run normally.')
        return None


def validate_facts(facts):
    keys = {'state', 'exit_code', 'duration_ms', 'output_sha256', 'output_bytes', 'preview',
            'preview_bytes', 'omitted_bytes', 'output_complete', 'started_at', 'ended_at', 'output_digest_kind'}
    if not isinstance(facts, dict) or set(facts) != keys:
        raise RegistryError('invalid_receipt', 'Native execution facts have unsupported fields.')
    state = facts['state']
    if not isinstance(state, str) or state not in ('exited', 'timed_out', 'cancelled', 'failed_to_start', 'interrupted'):
        raise RegistryError('invalid_receipt', 'Native execution state is invalid.')
    code = facts['exit_code']
    if code is not None and (type(code) is not int or not -2147483648 <= code <= 2147483647):
        raise RegistryError('invalid_receipt', 'Native exit code is invalid.')
    if (state == 'exited' and code is None) or (state == 'failed_to_start' and code is not None):
        raise RegistryError('invalid_receipt', 'Native exit code does not match execution state.')
    from datetime import datetime
    for key in ('started_at', 'ended_at'):
        if key == 'started_at' and facts[key] is None and state == 'failed_to_start':
            continue
        value = facts[key]
        if not isinstance(value, str) or len(value) > 40:
            raise RegistryError('invalid_receipt', 'Native execution time is invalid.')
        try:
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError:
            raise RegistryError('invalid_receipt', 'Native execution time is invalid.') from None
        if parsed.utcoffset() is None:
            raise RegistryError('invalid_receipt', 'Native execution time needs an offset.')
    for key in ('duration_ms', 'output_bytes', 'preview_bytes', 'omitted_bytes'):
        if type(facts[key]) is not int or not 0 <= facts[key] <= 2**53-1:
            raise RegistryError('invalid_receipt', 'Native execution counts are invalid.')
    if (facts['output_digest_kind'] != 'decoded_redacted_utf8'
            or type(facts['output_complete']) is not bool or not isinstance(facts['output_sha256'], str)
            or not re.fullmatch(r'[0-9a-f]{64}', facts['output_sha256'])
            or not isinstance(facts['preview'], str) or len(facts['preview']) > MAX_PREVIEW_BYTES
            or len(facts['preview'].encode('utf-8')) != facts['preview_bytes']
            or facts['preview_bytes'] > MAX_PREVIEW_BYTES
            or facts['preview_bytes'] + facts['omitted_bytes'] != facts['output_bytes']):
        raise RegistryError('invalid_receipt', 'Native output facts are inconsistent.')
    return dict(facts)


class Capture:
    def __init__(self, directory, config, origin, mode, root_identity, attempt, digest, notify, cancelled=None):
        self.directory, self.config, self.origin = directory, config, origin
        self.mode, self.root_identity, self.attempt = mode, root_identity, attempt
        self.digest, self.notify = digest, notify
        self.cancelled = cancelled

    def _saved(self, registry, facts):
        saved = registry.db.execute('''SELECT CASE WHEN length(CAST(body AS BLOB))<=16384 THEN body END AS body,
            CASE WHEN length(digest)=64 THEN digest END AS digest FROM session_execution_finals WHERE attempt_id=?''',
            (self.attempt['id'],)).fetchone()
        if saved is None:
            return False
        prior = json.loads(saved['body'])
        if (_encoded(prior)[1] != saved['digest'] or prior.get('attempt_id') != self.attempt['id']
                or prior.get('attempt_digest') != self.digest or validate_facts(prior['facts']) != facts):
            raise RegistryError('receipt_conflict', 'Native execution already has different final facts.')
        return True

    def complete(self, facts):
        """Persist native final once; exact repeat is observational, conflicting repeat refused."""
        try:
            facts = validate_facts(facts)
            # Any credential discovered after the command began disables persistence of its
            # output rather than changing a previously computed output digest silently.
            if contains_secret(facts['preview'], secret_values(self.config)):
                raise RegistryError('invalid_receipt', 'The native output preview cannot be persisted safely.')
            with WorkspaceRegistry(self.directory) as registry:
                if self._saved(registry, facts):
                    return True
                try:
                    same_binding = _scope(registry, self.config, self.origin) == {key: self.attempt[key] for key in
                        ('workspace_id', 'session_id', 'binding_id', 'binding_updated_at', 'runner_id')}
                except RegistryError:
                    same_binding = False
                after = (observe(self.config, self.mode, self.root_identity, cancelled=self.cancelled) if same_binding else
                         {'status': 'unavailable', 'reason': 'binding_changed'})
                before = self.attempt['source_before']
                comparison = ('unchanged_observation' if before == after else 'changed_observation') if (
                    before['status'] == after['status'] == 'observed') else 'unavailable'
                final = {'schema_version': 1, 'attempt_id': self.attempt['id'], 'attempt_digest': self.digest,
                         'completed_at': utc_now(), 'facts': facts, 'source_after': after,
                         'source_comparison': comparison}
                with registry.transaction():
                    if self._saved(registry, facts):
                        return True
                    current = registry.db.execute('SELECT digest FROM session_execution_attempts WHERE id=?',
                                                  (self.attempt['id'],)).fetchone()
                    if not current or current['digest'] != self.digest:
                        raise RegistryError('receipt_conflict', 'Execution attempt changed before final recording.')
                    try:
                        final_binding = _scope(registry, self.config, self.origin)
                    except RegistryError:
                        final_binding = None
                    if final_binding != {key: self.attempt[key] for key in
                            ('workspace_id', 'session_id', 'binding_id', 'binding_updated_at', 'runner_id')}:
                        final['source_after'] = {'status': 'unavailable', 'reason': 'binding_changed'}
                        final['source_comparison'] = 'unavailable'
                    body, digest = _encoded(final)
                    registry.db.execute('INSERT INTO session_execution_finals VALUES(?,?,?,?)',
                                        (self.attempt['id'], body, digest, final['completed_at']))
            return True
        except Exception:
            _notice(self.notify, 'Execution receipt finalization unavailable; use the command result. No success receipt was inferred.')
            return False


class NativeFacts:
    """The Bash executor feeds only its already-redacted stream, before truncation.

    No stdout status parsing. The digest covers decoded, redacted UTF-8 output,
    not original process bytes; newline/invalid UTF-8 conversion already occurred.
    """
    def __init__(self, receipt):
        self.receipt = receipt
        self.started_at = None
        self.start = time.monotonic()
        self.digest = hashlib.sha256()
        self.output_bytes = 0
        self.preview = bytearray()
        self.lock = threading.Lock()
        self.closed = False

    def started(self):
        self.started_at = utc_now()
        self.start = time.monotonic()

    def feed_safe(self, text):
        with self.lock:
            if self.closed:
                return
            for offset in range(0, len(text), 16384):
                raw = text[offset:offset + 16384].encode('utf-8', errors='replace')
                self.digest.update(raw)
                self.output_bytes += len(raw)
                left = MAX_PREVIEW_BYTES - len(self.preview)
                if left > 0:
                    self.preview.extend(raw[:left])

    def complete(self, state, code, *, output_complete):
        with self.lock:
            self.closed = True
            preview = bytes(self.preview).decode('utf-8', errors='ignore')
            size = len(preview.encode('utf-8'))
            facts = {'state': state, 'exit_code': code, 'duration_ms': max(0, int((time.monotonic() - self.start) * 1000)),
                     'started_at': self.started_at, 'ended_at': utc_now(),
                     'output_sha256': self.digest.hexdigest(), 'output_bytes': self.output_bytes,
                     'output_digest_kind': 'decoded_redacted_utf8',
                     'preview': preview, 'preview_bytes': size, 'omitted_bytes': self.output_bytes - size,
                     'output_complete': output_complete}
        return self.receipt.complete(facts)
