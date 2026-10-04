"""Private, metadata-only receipts for saved native foreground turns.

This is not a session-close signal, a goal verdict, or execution/test proof.
The caller owns the session turn lease and supplies facts from the final save.
No recovery path infers completion from transcripts, files or dead processes.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import json
import os
from pathlib import Path
import re
import uuid

from .pip_access import restricted
from .redaction import contains_secret, secret_values
from .workspace_registry import RegistryError, WorkspaceRegistry, in_use

MAX_COMPLETIONS = 10000
MAX_RECORD_BYTES = 2048
MAX_REVISION = 2**53 - 1
EVENT_TYPE = 'workspace_session_turn_completed'
ORIGINS = frozenset(('foreground_prompt', 'foreground_continue'))
EXCLUDED_ORIGINS = frozenset(('agent_wake', 'monitor', 'goal_resume', 'child', 'pip', 'vendor'))
_ORIGIN = ContextVar('dgc_private_session_turn_origin', default=None)
SCHEMA = """
CREATE TABLE session_turn_completions(
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session_workspaces(session_id),
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), turn_id TEXT NOT NULL,
 final_revision INTEGER NOT NULL CHECK(final_revision>0),
 request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
 body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=2048),
 digest TEXT NOT NULL CHECK(length(digest)=64), created_at TEXT NOT NULL,
 event_id TEXT NOT NULL, event_seq INTEGER NOT NULL CHECK(event_seq>0),
 UNIQUE(session_id,turn_id), UNIQUE(session_id,final_revision));
CREATE INDEX session_turn_completion_scope
 ON session_turn_completions(workspace_id,session_id,created_at,id);
CREATE TRIGGER immutable_session_turn_completion_update BEFORE UPDATE ON session_turn_completions
 BEGIN SELECT RAISE(ABORT,'session turn completions are immutable'); END;
CREATE TRIGGER immutable_session_turn_completion_delete BEFORE DELETE ON session_turn_completions
 BEGIN SELECT RAISE(ABORT,'session turn completions are immutable'); END;
"""


@contextmanager
def foreground_turn(origin):
    """Private frontend scope, never a tool/request argument or mutable Agent flag.

Set this in the actual native worker thread. Context is restored on every exit;
excluded nested work can explicitly mask an outer foreground origin.
"""
    if not isinstance(origin, str) or origin not in ORIGINS | EXCLUDED_ORIGINS:
        _fail('The native turn origin is unsupported.')
    token = _ORIGIN.set(origin if origin in ORIGINS else None)
    try:
        yield
    finally:
        _ORIGIN.reset(token)


def current_origin():
    return _ORIGIN.get()


def _fail(message):
    raise RegistryError('session_event_unavailable', message)


def _id(value, pattern):
    if not isinstance(value, str) or len(value) > 128 or re.fullmatch(pattern, value) is None:
        _fail('The session completion identity is invalid.')
    return value


def _revision(value):
    if type(value) is not int or not 0 <= value <= MAX_REVISION:
        _fail('The session completion revision is invalid.')
    return value


def _time(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 40:
        _fail('The session completion timestamp is invalid.')
    try:
        instant = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if instant.utcoffset() is None:
            raise ValueError
    except ValueError:
        _fail('The session completion timestamp is invalid.')
    return value


def _path(value):
    if not isinstance(value, (str, Path)):
        _fail('A native session path is required.')
    text = str(value)
    try:
        valid = (0 < len(text) <= 4096 and len(text.encode('utf-8')) <= 4096
                 and '\0' not in text and os.path.isabs(text) and os.path.normpath(text) == text)
    except UnicodeError:
        valid = False
    if not valid:
        _fail('A bounded absolute native session path is required.')
    return text


def _encoded(value):
    # All production callers construct this closed, scalar-only object first.
    try:
        raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
                         allow_nan=False).encode('utf-8')
    except (TypeError, ValueError, UnicodeError, RecursionError):
        _fail('The session completion record is invalid.')
    if len(raw) > MAX_RECORD_BYTES:
        _fail('The session completion record exceeds its byte limit.')
    return raw.decode('utf-8'), hashlib.sha256(raw).hexdigest()


def _scope(registry, config, session_id):
    _id(session_id, r'[A-Za-z0-9_-]{1,128}')
    root = _path(config.project_root)
    row = registry.db.execute('''SELECT
      CASE WHEN length(s.workspace_id)=35 THEN s.workspace_id END AS workspace_id,
      CASE WHEN length(s.binding_id)=40 THEN s.binding_id END AS binding_id,
      CASE WHEN length(b.runner_id)<=128 THEN b.runner_id END AS runner_id,
      CASE WHEN length(CAST(b.canonical_root AS BLOB))<=4096 THEN b.canonical_root END AS root,
      CASE WHEN length(b.updated_at)<=40 THEN b.updated_at END AS binding_updated_at,
      CASE WHEN length(s.updated_at)<=40 THEN s.updated_at END AS association_updated_at
      FROM session_workspaces s JOIN bindings b ON b.id=s.binding_id
      AND b.workspace_id=s.workspace_id WHERE s.session_id=? AND b.runner_id=?''',
      (session_id, registry.runner_id)).fetchone()
    if row is None or row['root'] != root:
        _fail('The saved session has no matching local workspace association.')
    return {'session_id': session_id,
            'workspace_id': _id(row['workspace_id'], r'ws_[0-9a-f]{32}'),
            'binding_id': _id(row['binding_id'], r'binding_[0-9a-f]{32}'),
            'runner_id': _id(row['runner_id'], r'runner_[0-9a-f]{32}'),
            'binding_updated_at': _time(row['binding_updated_at']),
            'association_updated_at': _time(row['association_updated_at'])}


@dataclass(frozen=True)
class Reservation:
    """Process-local controller token; never accept a serialized token from a client."""
    directory: Path
    session_path: str
    project_root: str
    session_id: str
    workspace_id: str
    binding_id: str
    runner_id: str
    binding_updated_at: str
    association_updated_at: str
    initial_revision: int
    initial_exists: bool
    origin: str
    turn_id: str
    reserved_at: str

    def request(self, final_revision):
        _path(self.directory); _path(self.session_path); _path(self.project_root)
        _id(self.turn_id, r'turn_[0-9a-f]{32}')
        _id(self.session_id, r'[A-Za-z0-9_-]{1,128}')
        _id(self.workspace_id, r'ws_[0-9a-f]{32}')
        _id(self.binding_id, r'binding_[0-9a-f]{32}')
        _id(self.runner_id, r'runner_[0-9a-f]{32}')
        _time(self.binding_updated_at); _time(self.association_updated_at); _time(self.reserved_at)
        _revision(self.initial_revision); _revision(final_revision)
        if (not isinstance(self.origin, str) or self.origin not in ORIGINS or type(self.initial_exists) is not bool
                or final_revision <= self.initial_revision
                or (not self.initial_exists and self.initial_revision != 0)):
            _fail('The saved foreground turn did not advance its native revision.')
        return {'schema_version': 1, 'id': 'completion_' + self.turn_id[5:],
                **self.scope(), 'turn_id': self.turn_id, 'origin': self.origin,
                'initial_revision': self.initial_revision, 'initial_exists': self.initial_exists,
                'final_revision': final_revision, 'reserved_at': self.reserved_at,
                'outcome': 'foreground_turn_saved', 'verification': 'no_execution_or_test_claim'}

    def scope(self):
        return {key: getattr(self, key) for key in ('session_id', 'workspace_id', 'binding_id',
                'runner_id', 'binding_updated_at', 'association_updated_at')}


def reserve(registry, config, *, session_file, session_root, session_revision, session_exists, origin):
    """Read-only reservation from trusted native metadata; never associate or scan."""
    if (config.get('pips_enabled', False) is not True or restricted(config)
            or not isinstance(origin, str) or origin not in ORIGINS):
        return None
    path, root = _path(session_file), _path(session_root)
    if root != _path(config.project_root) or Path(path).suffix != '.json':
        _fail('The native session root or file identity is inconsistent.')
    revision = _revision(session_revision)
    if type(session_exists) is not bool or (not session_exists and revision != 0):
        _fail('The native session generation is inconsistent.')
    scope = _scope(registry, config, Path(path).stem)
    return Reservation(Path(registry.directory), path, root, **scope,
                       initial_revision=revision, initial_exists=session_exists, origin=origin,
                       turn_id='turn_' + uuid.uuid4().hex, reserved_at=_time(registry.clock()))


def _saved(registry, reservation, request):
    row = registry.db.execute('''SELECT
      CASE WHEN length(id)=43 THEN id END AS id,final_revision,
      CASE WHEN length(created_at)<=40 THEN created_at END AS created_at,
      CASE WHEN length(CAST(body AS BLOB))<=2048 THEN body END AS body,
      CASE WHEN length(digest)=64 THEN digest END AS digest,
      CASE WHEN length(request_digest)=64 THEN request_digest END AS request_digest,
      CASE WHEN length(event_id)=36 THEN event_id END AS event_id,event_seq
      FROM session_turn_completions WHERE session_id=? AND turn_id=? AND workspace_id=?''',
      (reservation.session_id, reservation.turn_id, reservation.workspace_id)).fetchone()
    if row is None:
        return None
    try:
        if not isinstance(row['body'], str):
            _fail('The saved completion exceeds its record bound.')
        value = json.loads(row['body'])
        if not isinstance(value, dict) or set(value) != set(request) | {'completed_at'}:
            raise ValueError
        _time(value['completed_at'])
        expected = {**request, 'completed_at': value['completed_at']}
        encoded, digest = _encoded(expected)
        if (row['body'] != encoded or row['id'] != request['id']
                or type(row['final_revision']) is not int or row['final_revision'] != request['final_revision']
                or row['created_at'] != value['completed_at']
                or row['request_digest'] != _encoded(request)[1]
                or digest != row['digest']
                or type(row['event_seq']) is not int or not 0 < row['event_seq'] <= MAX_REVISION):
            raise ValueError
        _id(row['event_id'], r'evt_[0-9a-f]{32}')
    except (TypeError, ValueError, UnicodeError, RecursionError):
        _fail('The turn already has a different or invalid saved completion.')
    return {'completion': value, 'digest': row['digest'], 'event_id': row['event_id'],
            'event_seq': row['event_seq'], 'replayed': True}


def record(registry, config, reservation, *, completed, saved, revision_before_save, final_revision, cancelled=None):
    """Commit only private final-save facts. This is not a public control API."""
    if (config.get('pips_enabled', False) is not True or restricted(config)
            or completed is not True or saved is not True
            or (cancelled is not None and cancelled.is_set())):
        return None
    if type(reservation) is not Reservation:
        _fail('A native foreground reservation is required.')
    _revision(revision_before_save); _revision(final_revision)
    if (final_revision != revision_before_save + 1
            or revision_before_save < reservation.initial_revision
            or Path(registry.directory) != reservation.directory
            or _path(config.project_root) != reservation.project_root):
        _fail('The final save does not match its foreground reservation.')
    request = reservation.request(final_revision)
    if contains_secret(request, secret_values(config)):
        _fail('The completion metadata cannot be safely recorded.')
    with registry.transaction():
        if _scope(registry, config, reservation.session_id) != reservation.scope():
            _fail('The workspace or session binding changed during the turn.')
        if (config.get('pips_enabled', False) is not True or restricted(config)
                or (cancelled is not None and cancelled.is_set())):
            return None
        prior = _saved(registry, reservation, request)
        if prior is not None:
            if contains_secret(prior, secret_values(config)):
                _fail('The saved completion metadata cannot be safely returned.')
            return prior
        if registry.db.execute('SELECT 1 FROM session_turn_completions WHERE session_id=? AND final_revision=?',
                               (reservation.session_id, final_revision)).fetchone():
            _fail('This saved session revision already has a different completion identity.')
        if registry.db.execute('SELECT count(*) FROM session_turn_completions').fetchone()[0] >= MAX_COMPLETIONS:
            _fail('The completion archive is full; this turn was not recorded as an event.')
        body = {**request, 'completed_at': _time(registry.clock())}
        encoded, digest = _encoded(body)
        if contains_secret(body, secret_values(config)):
            _fail('The completion metadata cannot be safely recorded.')
        registry.event(reservation.workspace_id, EVENT_TYPE, payload={
            'completion_id': request['id'], 'session_id': reservation.session_id,
            'turn_id': reservation.turn_id, 'final_revision': final_revision,
            'outcome': 'foreground_turn_saved', 'verification': 'no_execution_or_test_claim'})
        event = registry.db.execute('SELECT seq,event_id FROM workspace_events WHERE seq=last_insert_rowid()').fetchone()
        if event is None:
            _fail('The completion event could not be saved atomically.')
        _id(event['event_id'], r'evt_[0-9a-f]{32}')
        if type(event['seq']) is not int or not 0 < event['seq'] <= MAX_REVISION:
            _fail('The completion event cursor exceeds its supported bound.')
        registry.db.execute('INSERT INTO session_turn_completions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                            (request['id'], reservation.session_id, reservation.workspace_id,
                             reservation.turn_id, final_revision, _encoded(request)[1], encoded, digest,
                             body['completed_at'], event['event_id'], event['seq']))
        return {'completion': body, 'digest': digest, 'event_id': event['event_id'],
                'event_seq': event['seq'], 'replayed': False}


def _eligible(agent):
    return (type(getattr(agent, 'depth', None)) is int and agent.depth == 0
            and not getattr(agent, '_monitor_turn', False)
            and getattr(agent, '_parent_agent', None) is None
            and getattr(agent, '_subagent_id', None) is None
            and getattr(agent, '_agent_tool_allowlist', None) is None
            and not agent.config.get('subscription_engine', '')
            and agent.config.get('pips_enabled', False) is True and not restricted(agent.config)
            and not agent.cancelled.is_set() and not getattr(agent, 'stopping', False)
            and in_use())


def _notice(agent):
    try:
        agent.ui.info('Pips turn event unavailable. This turn was not recorded for session-completion triggers; no completion was inferred.')
    except Exception:
        pass


def begin_for_agent(agent, *, origin=None):
    origin = current_origin() if origin is None else origin
    if not isinstance(origin, str) or origin not in ORIGINS:
        return None
    try:
        if not _eligible(agent):
            return None
        if _path(agent.ctx.project_root) != _path(agent.config.project_root):
            _fail('The foreground execution root differs from its configured workspace.')
        with WorkspaceRegistry() as registry:
            return reserve(registry, agent.config, session_file=agent.session_file,
                           session_root=agent.session_root, session_revision=agent._session_revision,
                           session_exists=agent._session_exists, origin=origin)
    except Exception:
        _notice(agent)
        return None


def complete_for_agent(agent, reservation, *, completed, saved, revision_before_save):
    if reservation is None or completed is not True or saved is not True:
        return None
    try:
        if not _eligible(agent):
            return None
        if (type(reservation) is not Reservation or agent._session_exists is not True
                or _path(agent.session_file) != reservation.session_path
                or _path(agent.session_root) != reservation.project_root
                or _path(agent.ctx.project_root) != reservation.project_root
                or getattr(agent, '_last_turn_error', '') or getattr(agent, '_last_persist_error', '')):
            _fail('The saved foreground session did not finish consistently.')
        with WorkspaceRegistry(reservation.directory) as registry:
            return record(registry, agent.config, reservation, completed=completed, saved=saved,
                          revision_before_save=revision_before_save, final_revision=agent._session_revision,
                          cancelled=agent.cancelled)
    except Exception:
        _notice(agent)
        return None
