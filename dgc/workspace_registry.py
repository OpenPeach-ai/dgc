"""Private local workspace identity and transactional storage for opt-in Pips.

An identity is a UUID, never a path hash or a Git remote. Resolving a new path creates
a separate binding. Only the local caller can explicitly rebind an existing identity.
Existing transcript files and their path-based lookup remain unchanged.
"""
from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import stat
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 44
MAX_WORKSPACES = 256
MAX_SESSION_ASSOCIATIONS = 100000
MAX_EVENTS = 5000
_DATABASE_OPEN_LOCK = threading.RLock()

_SCHEMA_V1 = """
            CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS workspaces(
                id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS bindings(
                id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                runner_id TEXT NOT NULL, canonical_root TEXT NOT NULL,
                updated_at TEXT NOT NULL, UNIQUE(runner_id, canonical_root));
            CREATE TABLE IF NOT EXISTS session_workspaces(
                session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                binding_id TEXT NOT NULL REFERENCES bindings(id), updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS pips(
                id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                status TEXT NOT NULL CHECK(status IN ('active','paused','archived')),
                current_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS pip_versions(
                pip_id TEXT NOT NULL REFERENCES pips(id), version INTEGER NOT NULL,
                definition TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL,
                created_at TEXT NOT NULL, PRIMARY KEY(pip_id,version));
            CREATE TABLE IF NOT EXISTS pip_proposals(
                id TEXT PRIMARY KEY, pip_id TEXT NOT NULL REFERENCES pips(id),
                expected_version INTEGER NOT NULL, definition TEXT NOT NULL, actor TEXT NOT NULL,
                reason TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS pip_runs(
                id TEXT PRIMARY KEY, pip_id TEXT NOT NULL REFERENCES pips(id),
                workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                binding_id TEXT NOT NULL REFERENCES bindings(id),
                idempotency_key TEXT NOT NULL, requested_by TEXT NOT NULL,
                manifest TEXT NOT NULL, status TEXT NOT NULL,
                created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
                result TEXT, error TEXT, UNIQUE(pip_id,idempotency_key));
            CREATE TABLE IF NOT EXISTS workspace_events(
                seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
                workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                event_type TEXT NOT NULL, pip_id TEXT, run_id TEXT,
                payload TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TRIGGER IF NOT EXISTS immutable_job_version
                BEFORE UPDATE ON pip_versions BEGIN SELECT RAISE(ABORT,'immutable job version'); END;
            CREATE TRIGGER IF NOT EXISTS immutable_run_manifest
                BEFORE UPDATE OF manifest,pip_id,workspace_id,binding_id,idempotency_key,requested_by,created_at
                ON pip_runs BEGIN SELECT RAISE(ABORT,'immutable run manifest'); END;
"""

_SCHEMA_V2 = """
CREATE TABLE workspace_context_revisions(
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0));
CREATE TABLE workspace_context_entries(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    kind TEXT NOT NULL CHECK(kind IN ('decision','milestone','command','risk','exception','finding')),
    title TEXT NOT NULL, content TEXT NOT NULL, provenance TEXT NOT NULL,
    created_at TEXT NOT NULL, created_by TEXT NOT NULL,
    created_revision INTEGER NOT NULL CHECK(typeof(created_revision)='integer' AND created_revision>0),
    status TEXT NOT NULL CHECK(status IN ('active','archived')),
    archived_at TEXT, archived_by TEXT, archived_revision INTEGER,
    source_run_id TEXT REFERENCES pip_runs(id), source_finding_index INTEGER,
    UNIQUE(workspace_id,created_revision),
    CHECK((kind='finding' AND source_run_id IS NOT NULL AND
           typeof(source_finding_index)='integer' AND source_finding_index>=0) OR
          (kind!='finding' AND source_run_id IS NULL AND source_finding_index IS NULL)),
    CHECK((status='active' AND archived_at IS NULL AND archived_by IS NULL AND archived_revision IS NULL) OR
          (status='archived' AND archived_at IS NOT NULL AND archived_by IS NOT NULL AND
           typeof(archived_revision)='integer' AND archived_revision>created_revision)));
CREATE INDEX workspace_context_active ON workspace_context_entries(workspace_id,status,created_revision);
CREATE UNIQUE INDEX workspace_context_finding_active
    ON workspace_context_entries(workspace_id,source_run_id,source_finding_index)
    WHERE source_run_id IS NOT NULL AND status='active';
CREATE TRIGGER immutable_context_entry
    BEFORE UPDATE OF id,workspace_id,kind,title,content,provenance,created_at,created_by,
        created_revision,source_run_id,source_finding_index
    ON workspace_context_entries BEGIN SELECT RAISE(ABORT,'immutable context entry'); END;
CREATE TRIGGER immutable_context_history
    BEFORE DELETE ON workspace_context_entries BEGIN SELECT RAISE(ABORT,'immutable context history'); END;
CREATE TRIGGER one_way_context_archive
    BEFORE UPDATE OF status,archived_at,archived_by,archived_revision ON workspace_context_entries
    WHEN OLD.status!='active' OR NEW.status!='archived'
    BEGIN SELECT RAISE(ABORT,'context can only be archived once'); END;
CREATE TRIGGER monotonic_context_revision
    BEFORE UPDATE ON workspace_context_revisions WHEN NEW.workspace_id!=OLD.workspace_id OR
        NEW.revision!=OLD.revision+1
    BEGIN SELECT RAISE(ABORT,'context revision must advance once'); END;
"""


def _execute_schema(db, script):
    statement = ""
    for line in script.splitlines():
        statement += line + "\n"
        if sqlite3.complete_statement(statement):
            db.execute(statement)
            statement = ""
    if statement.strip():
        raise RuntimeError("Incomplete registry schema statement")


class RegistryError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def identifier(prefix: str) -> str:
    return prefix + "_" + uuid.uuid4().hex


def state_directory() -> Path:
    # Match Config's DGC_HOME convention: the override is the parent of .dgc.
    override = os.environ.get("DGC_HOME")
    if override:
        return Path(override).expanduser().resolve() / ".dgc" / "pips"
    from .config import USER_HOME
    return USER_HOME / "pips"


def in_use() -> bool:
    """Has this profile used Pips? Pips are on for everyone, but per-turn bookkeeping (session
    association, turn records, verifier receipts) waits until a Pip exists. Checking only that
    the registry file exists creates nothing and costs one stat."""
    try:
        return (state_directory() / "registry.sqlite3").is_file()
    except OSError:
        return False


def _private_directory(path: Path) -> None:
    if path.is_symlink():
        raise RegistryError("unsafe_state", "Pips state must not be a symbolic link.")
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode):
        raise RegistryError("unsafe_state", "Pips state is not a directory.")
    if os.name == "posix":
        if info.st_uid != os.getuid():
            raise RegistryError("unsafe_state", "Pips state belongs to another user.")
        path.chmod(0o700)


def canonical_directory(value) -> Path:
    try:
        result = Path(value).expanduser().resolve(strict=True)
    except (OSError, ValueError, RuntimeError) as exc:
        raise RegistryError("invalid_workspace", "The workspace directory is unavailable.") from exc
    if not result.is_dir():
        raise RegistryError("invalid_workspace", "The workspace must be a directory.")
    return result


def _database_info(path):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        raise RegistryError("unsafe_state", "Pips database must not be a symbolic link.")
    if not stat.S_ISREG(info.st_mode) or (os.name == "posix" and info.st_uid != os.getuid()):
        raise RegistryError("unsafe_state", "Pips database is not an owned regular file.")
    return info


def _connect_private_database(path):
    # POSIX closes release *all* this process's record locks on that inode,
    # including locks held by other SQLite connections. Never open/close an
    # existing SQLite file ourselves. Serialize initial exclusive creation so
    # no registry thread can connect before its one creation descriptor closes.
    with _DATABASE_OPEN_LOCK:
        try:
            before = _database_info(path)
        except FileNotFoundError:
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            except FileExistsError:
                pass  # Another process created it; validate without opening it.
            else:
                os.close(fd)
            before = _database_info(path)
        if os.name == "posix":
            path.chmod(0o600)
        # URI rw refuses a disappearing file instead of creating a replacement.
        # Python sqlite3 does not expose SQLITE_OPEN_NOFOLLOW. Private owned
        # directories are the boundary against foreign-user path replacement;
        # these checks do not claim protection from a malicious same-UID actor.
        db = sqlite3.connect(path.absolute().as_uri() + "?mode=rw", uri=True, timeout=3, isolation_level=None)
        try:
            after = _database_info(path)
            if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                raise RegistryError("unsafe_state", "Pips database changed while it was opening.")
        except BaseException:
            with contextlib.suppress(sqlite3.Error):
                db.close()
            raise
        return db


class WorkspaceRegistry:
    def __init__(self, directory: Path | None = None, *, clock=utc_now):
        self.directory = Path(directory) if directory is not None else state_directory()
        _private_directory(self.directory)
        self.path = self.directory / "registry.sqlite3"
        self.clock = clock
        self.db = _connect_private_database(self.path)
        try:
            self.db.row_factory = sqlite3.Row
            self.db.execute("PRAGMA foreign_keys=ON")
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=FULL")
            version = self.db.execute("PRAGMA user_version").fetchone()[0]
            if version not in range(SCHEMA_VERSION + 1):
                raise RegistryError("schema_version", "This Pips database needs a compatible DGC version.")
            # Opening an up-to-date registry is a read, including while the
            # runner commits progress. Taking a write lock on every UI refresh
            # needlessly competes with the worker. Recheck the version inside
            # the transaction when an actual creation/upgrade is required.
            if version != SCHEMA_VERSION:
                # executescript implicitly commits: execute complete statements
                # individually so failed schema upgrades leave v1 intact.
                with self.transaction():
                    self._initialize_schema()
            self.runner_id = self.db.execute("SELECT value FROM metadata WHERE key='runner_id'").fetchone()[0]
        except BaseException:
            with contextlib.suppress(sqlite3.Error):
                self.close()
            raise

    def _initialize_schema(self):
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version not in range(SCHEMA_VERSION + 1):
            raise RegistryError("schema_version", "This Pips database needs a compatible DGC version.")
        if version == 0:
            _execute_schema(self.db, _SCHEMA_V1)
        if version < 2:
            _execute_schema(self.db, _SCHEMA_V2)
        if version < 3:
            from . import pip_approvals
            _execute_schema(self.db, pip_approvals.SCHEMA)
            pip_approvals.migrate(self)
        if version < 4:
            from . import pip_chat
            _execute_schema(self.db, pip_chat.SCHEMA)
        if version < 5:
            from . import pip_checkpoints, pip_schedules
            _execute_schema(self.db, pip_schedules.SCHEMA_V5)
            _execute_schema(self.db, pip_checkpoints.SCHEMA)
        if version < 6:
            from . import pip_handoffs, pip_execution_reviews
            _execute_schema(self.db, pip_handoffs.SCHEMA)
            _execute_schema(self.db, pip_execution_reviews.SCHEMA)
        if version < 7:
            from .pip_handoffs import migrate_v7
            migrate_v7(self)
        if version < 8:
            from .workspace_context_execution import migrate_v8
            migrate_v8(self)
        self.db.execute("INSERT OR IGNORE INTO metadata VALUES('runner_id',?)", (identifier("runner"),))
        if version < 9:
            from .pip_adaptation import SCHEMA as adaptation_schema
            _execute_schema(self.db, adaptation_schema)
        if version < 10:
            from .pip_event_triggers import SCHEMA_V10 as event_schema
            from .pip_commit_detector import SCHEMA_V10 as commit_schema
            _execute_schema(self.db, event_schema)
            _execute_schema(self.db, commit_schema)
        if version < 11:
            from .pip_lifecycle_tool import SCHEMA as lifecycle_schema
            _execute_schema(self.db, lifecycle_schema)
        if version < 12:
            from .workspace_session_outcomes import migrate_v12
            migrate_v12(self)
        if version < 13:
            from .pip_notifications import SCHEMA as notification_schema
            _execute_schema(self.db, notification_schema)
        if version < 14:
            from .pip_memory import SCHEMA as memory_schema
            _execute_schema(self.db, memory_schema)
        if version < 15:
            from .pip_archive import SCHEMA as archive_schema
            _execute_schema(self.db, archive_schema)
        if version < 16:
            from .session_execution_receipts import SCHEMA as execution_receipt_schema
            _execute_schema(self.db, execution_receipt_schema)
        # Version17 adds a closed command/source=session_execution context
        # interpretation, without DDL or historical row rewrites. Older readers
        # must refuse the version rather than partly interpret new context.
        if version < 18:
            from .session_turn_events import SCHEMA as session_turn_schema
            _execute_schema(self.db, session_turn_schema)
        if version < 19:
            from .pip_memory_statements import SCHEMA as statement_schema
            _execute_schema(self.db, statement_schema)
        # Version20 permits reviewed recurring Quill drafts with a closed worker
        # grant. No DDL or historical row rewrite; older readers must refuse the
        # new job semantics before interpreting schedules or queued manifests.
        # Schema21 interprets reviewed standalone Pulse plans and durable partial
        # command receipts in existing columns. Historical rows remain unchanged.
        # Older runtimes must refuse this version before loading the new authority.
        if version < 22:
            from .pip_commit_paths import SCHEMA_V22 as commit_path_schema
            _execute_schema(self.db, commit_path_schema)
        if version < 23:
            from .pip_setup import SCHEMA as setup_schema
            _execute_schema(self.db, setup_schema)
        if version < 24:
            from .pip_chat_continuity import SCHEMA as chat_checkpoint_schema
            _execute_schema(self.db, chat_checkpoint_schema)
        if version < 26:
            from .pip_app_actions import SCHEMA as app_action_schema
            _execute_schema(self.db, app_action_schema)
        if version < 27:
            from .pip_message_drafts import SCHEMA as message_draft_schema
            _execute_schema(self.db, message_draft_schema)
        if version < 29:
            from .pip_message_drafts import CALENDAR_SCHEMA
            _execute_schema(self.db, CALENDAR_SCHEMA)
        if version < 31:
            from .pip_message_drafts import CONNECTOR_SCHEMA
            _execute_schema(self.db, CONNECTOR_SCHEMA)
        if version < 34:
            from .pip_digest import SCHEMA as digest_schema
            _execute_schema(self.db, digest_schema)
        if version < 35:
            from .pip_computer import SCHEMA as computer_schema
            _execute_schema(self.db, computer_schema)
        if version < 36:
            # Images sent in a Pip's chat (pip_chat.IMAGES_SCHEMA).
            from .pip_chat import IMAGES_SCHEMA as chat_images_schema
            _execute_schema(self.db, chat_images_schema)
        if version < 37:
            # Files sent in a Pip's chat (pip_chat.FILES_SCHEMA).
            from .pip_chat import FILES_SCHEMA as chat_files_schema
            _execute_schema(self.db, chat_files_schema)
        if version < 38:
            # A Personal Pip's own apps, connected from its chat (pip_app_links.SCHEMA).
            from .pip_app_links import SCHEMA as app_links_schema
            _execute_schema(self.db, app_links_schema)
        if version < 39:
            # Choices a Pip offers under its reply (pip_chat.CHOICES_SCHEMA).
            from .pip_chat import CHOICES_SCHEMA as chat_choices_schema
            _execute_schema(self.db, chat_choices_schema)
        if version < 40:
            # A Personal Pip's routines: what it does by itself, and when (pip_routines.SCHEMA).
            from .pip_routines import SCHEMA as routines_schema
            _execute_schema(self.db, routines_schema)
        if version < 41:
            # A Personal Pip's own page: its face, colour, title and notifications (pip_profile.SCHEMA).
            from .pip_profile import SCHEMA as profile_schema
            _execute_schema(self.db, profile_schema)
        if version < 42:
            # The plugins each Personal Pip asked to use, and the actions a run was offered (pip_plugins.SCHEMA).
            from .pip_plugins import SCHEMA as plugins_schema
            _execute_schema(self.db, plugins_schema)
        if version < 43:
            # A full-text index over Pip chats, for search (pip_search); none without FTS5.
            from .pip_search import install as install_search
            install_search(self.db)
        if version < 44:
            # What each Personal Pip remembers about you, from your chat, deletable (pip_notes.SCHEMA).
            from .pip_notes import SCHEMA as notes_schema
            _execute_schema(self.db, notes_schema)
        # Schema33 admits explicit version3 bounded additional app-read grants.
        # Schema32 adds explicit guest and finite-series semantics to calendar drafts/actions.
        # Older readers must refuse the registry instead of rendering a partial review.
        # Schema30 also admits exact connector-call reviews. Schema28 added calendar
        # creation. Old readers must refuse both new semantics.
        # Schema28 admits closed calendar-creation review payloads in the existing
        # immutable action ledger. Older readers must refuse these semantics.
        self.db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

    def close(self):
        self.db.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    @contextlib.contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self._rollback_after_error()
            raise

    def _rollback_after_error(self):
        # SQLite can already have rolled back an I/O failure. Cleanup must not
        # replace that actionable error with "no transaction is active".
        with contextlib.suppress(sqlite3.Error):
            if self.db.in_transaction:
                self.db.rollback()

    def personal(self) -> dict:
        """One private profile workspace, never the editor's current directory."""
        root = self.directory / "personal"
        _private_directory(root)
        root = canonical_directory(root)
        with contextlib.nullcontext() if self.db.in_transaction else self.transaction():
            row = self.db.execute("SELECT value FROM metadata WHERE key='personal_workspace'").fetchone()
            if row:
                result = self.get(row[0])
                binding = self.binding(row[0])
                if result['kind'] != 'personal' or binding['canonical_root'] != str(root):
                    raise RegistryError('unsafe_state', 'The personal workspace binding changed.')
                return result
            existing = self.lookup(root)
            if existing is not None:
                raise RegistryError('conflict', 'The private personal root is already registered as a project.')
            workspace_id = self._resolve(root)
            self.db.execute("UPDATE workspaces SET name='Personal',kind='personal' WHERE id=?", (workspace_id,))
            self.db.execute("INSERT INTO metadata VALUES('personal_workspace',?)", (workspace_id,))
        return self.get(workspace_id)

    def binding(self, workspace_id: str) -> dict:
        row = self.db.execute("SELECT * FROM bindings WHERE workspace_id=? AND runner_id=?",
                              (workspace_id, self.runner_id)).fetchone()
        if row is None:
            raise RegistryError("not_found", "This workspace has no binding on this runner.")
        return dict(row)

    def resolve(self, root) -> dict:
        root = canonical_directory(root)
        existing = self.lookup(root)
        if existing is not None:
            return existing
        with self.transaction():
            workspace_id = self._resolve(root)
        return self.get(workspace_id)

    def _resolve(self, root: Path) -> str:
        """Resolve an already-canonical root inside the caller's write transaction."""
        row = self.db.execute("SELECT workspace_id FROM bindings WHERE runner_id=? AND canonical_root=?",
                              (self.runner_id, str(root))).fetchone()
        if row is not None:
            return row[0]
        if self.db.execute("SELECT count(*) FROM workspaces").fetchone()[0] >= MAX_WORKSPACES:
            raise RegistryError("limit", "The local workspace registry is full.")
        workspace_id, binding_id, now = identifier("ws"), identifier("binding"), self.clock()
        # Descriptive only: neither Git remotes nor committed metadata grant identity.
        kind = "git" if (root / ".git").exists() else "folder"
        self.db.execute("INSERT INTO workspaces VALUES(?,?,?,?,?)",
                        (workspace_id, root.name[:160] or "Workspace", kind, now, now))
        self.db.execute("INSERT INTO bindings VALUES(?,?,?,?,?)",
                        (binding_id, workspace_id, self.runner_id, str(root), now))
        self.event(workspace_id, "workspace_resolved", payload={"binding_id": binding_id})
        return workspace_id

    def lookup(self, root) -> dict | None:
        """Read a binding without implicitly creating a workspace."""
        root = canonical_directory(root)
        row = self.db.execute("SELECT workspace_id FROM bindings WHERE runner_id=? AND canonical_root=?",
                              (self.runner_id, str(root))).fetchone()
        return self.get(row[0]) if row is not None else None

    def get(self, workspace_id: str) -> dict:
        row = self.db.execute("""SELECT w.*,b.id AS binding_id,b.runner_id
            FROM workspaces w JOIN bindings b ON b.workspace_id=w.id
            WHERE w.id=? AND b.runner_id=?""", (workspace_id, self.runner_id)).fetchone()
        if row is None:
            raise RegistryError("not_found", "Workspace not found on this runner.")
        return dict(row)

    def list(self) -> list[dict]:
        return [dict(row) for row in self.db.execute("""SELECT w.*,b.id AS binding_id,b.runner_id
            FROM workspaces w JOIN bindings b ON b.workspace_id=w.id
            WHERE b.runner_id=? ORDER BY w.created_at,w.id LIMIT ?""", (self.runner_id, MAX_WORKSPACES))]

    def rebind(self, workspace_id: str, root, *, expected_root, dry_run=False) -> dict:
        """Explicit local-only move; compare the old binding to avoid replacing another move."""
        if self.get(workspace_id)['kind'] == 'personal':
            raise RegistryError('permission_denied', 'Personal storage cannot be rebound to a project directory.')
        root = canonical_directory(root)
        expected = str(Path(expected_root).expanduser().resolve(strict=False))
        with self.transaction():
            current = self.binding(workspace_id)
            if current["canonical_root"] != expected:
                raise RegistryError("conflict", "The workspace binding changed; review it before rebinding.")
            other = self.db.execute("SELECT workspace_id FROM bindings WHERE runner_id=? AND canonical_root=?",
                                    (self.runner_id, str(root))).fetchone()
            if other is not None and other[0] != workspace_id:
                raise RegistryError("conflict", "The destination already belongs to another workspace.")
            if self.db.execute("SELECT 1 FROM pip_runs WHERE workspace_id=? AND status IN ('queued','running','cancelling')",
                               (workspace_id,)).fetchone():
                raise RegistryError("busy", "Finish or cancel this workspace's runs before rebinding.")
            # This is a moved-directory repair, not a way to link two copies or
            # silently detach live sessions from an existing checkout.
            if str(root) != expected:
                try:
                    Path(expected).lstat()
                except FileNotFoundError:
                    pass
                else:
                    raise RegistryError("source_exists", "The old directory still exists. Rebind only repairs a moved directory; it does not link or merge checkouts.")
                if not dry_run:
                    self.db.execute("UPDATE bindings SET canonical_root=?,updated_at=? WHERE id=?",
                                    (str(root), self.clock(), current["id"]))
                    self.event(workspace_id, "workspace_rebound", payload={"binding_id": current["id"]})
        return self.get(workspace_id)

    @staticmethod
    def _session_id(session_id):
        if not isinstance(session_id, str) or not 1 <= len(session_id) <= 256 or "\x00" in session_id:
            raise RegistryError("invalid_session", "Invalid session identity.")

    def session_identity(self, session_id: str) -> dict | None:
        self._session_id(session_id)
        row = self.db.execute("""SELECT s.workspace_id,s.binding_id AS workspace_binding_id,b.runner_id
            FROM session_workspaces s JOIN bindings b ON b.id=s.binding_id
            WHERE s.session_id=? AND b.runner_id=?""", (session_id, self.runner_id)).fetchone()
        return dict(row) if row is not None else None

    def associate_session(self, session_id: str, root) -> dict:
        self._session_id(session_id)
        root = canonical_directory(root)
        with self.transaction():
            old = self.db.execute("""SELECT s.workspace_id,s.binding_id AS workspace_binding_id,
                b.runner_id,b.canonical_root FROM session_workspaces s
                JOIN bindings b ON b.id=s.binding_id WHERE s.session_id=?""", (session_id,)).fetchone()
            if old is not None:
                if old["canonical_root"] != str(root) or old["runner_id"] != self.runner_id:
                    raise RegistryError("conflict", "This session is already associated with another workspace.")
                # Idempotent reads must not rewrite association dates or manufacture events.
                return {key: old[key] for key in ("workspace_id", "workspace_binding_id", "runner_id")}
            if self.db.execute("SELECT count(*) FROM session_workspaces").fetchone()[0] >= MAX_SESSION_ASSOCIATIONS:
                raise RegistryError("limit", "The local session association registry is full.")
            workspace = self.get(self._resolve(root))
            self.db.execute("INSERT INTO session_workspaces VALUES(?,?,?,?)",
                            (session_id, workspace["id"], workspace["binding_id"], self.clock()))
            self.event(workspace["id"], "session_associated", payload={"session_id": session_id})
            return {"workspace_id": workspace["id"], "workspace_binding_id": workspace["binding_id"],
                    "runner_id": self.runner_id}

    def sessions(self, workspace_id: str, *, after="", limit=50) -> dict:
        """Page identity records only; no transcript content or filesystem paths."""
        self.get(workspace_id)
        if not isinstance(after, str) or len(after) > 256 or "\x00" in after:
            raise RegistryError("invalid_cursor", "Session cursor must be a session ID.")
        if type(limit) is not int or not 1 <= limit <= 100:
            raise RegistryError("invalid_limit", "Session page limit must be between 1 and 100.")
        rows = self.db.execute("""SELECT session_id,workspace_id,binding_id AS workspace_binding_id,updated_at
            FROM session_workspaces WHERE workspace_id=? AND session_id>? ORDER BY session_id LIMIT ?""",
            (workspace_id, after, limit + 1)).fetchall()
        items = [{**dict(row), "runner_id": self.runner_id} for row in rows[:limit]]
        return {"workspace_id": workspace_id, "sessions": items,
                "next_cursor": items[-1]["session_id"] if items else after,
                "has_more": len(rows) > limit}

    def event(self, workspace_id: str, event_type: str, *, pip_id=None, run_id=None, payload=None,
              created_at=None):
        # Internal controller observations can bind their payload and event row to
        # one exact instant. This is not a caller-controlled wire field. Preserve
        # legacy clock behavior when no timestamp is supplied.
        if created_at is not None:
            valid = type(created_at) is str and len(created_at) == 24 and created_at.endswith('Z')
            if valid:
                try:
                    instant = datetime.fromisoformat(created_at[:-1] + '+00:00')
                    valid = instant.isoformat(timespec='milliseconds').replace('+00:00', 'Z') == created_at
                except (ValueError, OverflowError):
                    valid = False
            if not valid:
                raise RegistryError('invalid_event_time', 'Activity timestamp must be a canonical UTC instant.')
        encoded = json.dumps(payload or {}, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        if len(encoded.encode()) > 8192:
            raise RegistryError("limit", "Activity payload exceeds 8 KiB.")
        self.db.execute("""INSERT INTO workspace_events
            (event_id,workspace_id,event_type,pip_id,run_id,payload,created_at) VALUES(?,?,?,?,?,?,?)""",
            (identifier("evt"), workspace_id, event_type, pip_id, run_id, encoded,
             self.clock() if created_at is None else created_at))
        # Explicit bounded retention; immutable while retained, not an unlimited audit archive.
        self.db.execute("""DELETE FROM workspace_events WHERE workspace_id=? AND seq NOT IN
            (SELECT seq FROM workspace_events WHERE workspace_id=? ORDER BY seq DESC LIMIT ?)""",
            (workspace_id, workspace_id, MAX_EVENTS))

    def activity(self, workspace_id: str, after: int = 0) -> dict:
        self.get(workspace_id)
        if type(after) is not int or after < 0:
            raise RegistryError("invalid_cursor", "Activity cursor must be a nonnegative integer.")
        rows = self.db.execute("SELECT * FROM workspace_events WHERE workspace_id=? AND seq>? ORDER BY seq LIMIT 50",
                               (workspace_id, after)).fetchall()
        events = [{**dict(row), "payload": json.loads(row["payload"])} for row in rows]
        oldest = self.db.execute("SELECT min(seq) FROM workspace_events WHERE workspace_id=?", (workspace_id,)).fetchone()[0]
        return {"events": events, "next_cursor": events[-1]["seq"] if events else after,
                "oldest_cursor": oldest or 0, "retention_limit": MAX_EVENTS}
