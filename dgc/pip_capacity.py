"""Staged local retained-capacity visibility; no dependency or reclamation claims."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sqlite3
import time

from .pip_access import require_unrestricted
from .pip_export import _read_database
from .redaction import redact_value, secret_values
from .workspace_registry import RegistryError, SCHEMA_VERSION, state_directory, utc_now

REGISTRY_SCHEMA = SCHEMA_VERSION
MAX_QUERIES = 32
MAX_VM_INSTRUCTIONS = 2_000_000
PROGRESS_INTERVAL = 1000
MAX_SECONDS = 3
MAX_OUTPUT_BYTES = 32 * 1024
NOTICE = ('Retained records across this local runner share these ceilings. Archived Pips and '
          'failed, cancelled, expired or revoked history still count. Exporting does not free slots. '
          'Counts are a read snapshot, not reserved capacity or validation of stored evidence. '
          'Dependencies, disk usage and safe reclamation are not assessed.')
KINDS = ('runs', 'checkpoints', 'pip_memory', 'session_statements')


def _error(code, message):
    return RegistryError(code, message)


def _id(value, prefix):
    if type(value) is not str or not re.fullmatch(prefix + r'_[0-9a-f]{32}', value):
        raise _error('invalid_capacity_metadata', 'The local workspace identity is malformed.')
    return value


def _root(config):
    # Config already owns workspace selection. Never resolve/open a source path,
    # clone Config, expand a caller root, or create a registration during reads.
    root = config.project_root
    if not isinstance(root, (str, Path)):
        raise _error('invalid_capacity_scope', 'Use an existing configured workspace binding.')
    value = str(root)
    if (len(value) > 4096 or not os.path.isabs(value) or '..' in Path(value).parts
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise _error('invalid_capacity_scope', 'Use an existing absolute configured workspace binding.')
    try:
        if len(value.encode('utf-8')) > 4096:
            raise ValueError()
    except (UnicodeError, ValueError):
        raise _error('invalid_capacity_scope', 'The configured workspace path exceeds its metadata bound.') from None
    return value


class _BudgetExceeded(Exception):
    pass


class _Budget:
    def __init__(self):
        self.deadline = time.monotonic() + MAX_SECONDS
        self.queries = 0
        self.instructions = 0
        self.reason = None

    def _expired(self):
        if self.reason is not None:
            return True
        if time.monotonic() >= self.deadline:
            self.reason = 'deadline'
            return True
        return False

    def progress(self):
        self.instructions += PROGRESS_INTERVAL
        if self.instructions >= MAX_VM_INSTRUCTIONS:
            self.reason = self.reason or 'vm_budget'
        return int(self._expired())

    def execute(self, db, sql, parameters=()):
        if self._expired():
            raise _BudgetExceeded()
        if self.queries >= MAX_QUERIES:
            self.reason = 'query_budget'
            raise _BudgetExceeded()
        # Reserve a full progress quantum for this statement's unsampled tail.
        # Callback quanta are charged in addition; this is conservative accounting,
        # not an exact measurement of SQLite instructions actually executed.
        self.instructions += PROGRESS_INTERVAL
        if self.instructions >= MAX_VM_INSTRUCTIONS:
            self.reason = 'vm_budget'
            raise _BudgetExceeded()
        self.queries += 1
        cursor = db.execute(sql, parameters)
        if self._expired():
            cursor.close()
            raise _BudgetExceeded()
        return cursor

    def fetchone(self, db, sql, parameters=()):
        cursor = self.execute(db, sql, parameters)
        try:
            value = cursor.fetchone()
        finally:
            cursor.close()
        if self._expired():
            raise _BudgetExceeded()
        return value

    def fetchall(self, db, sql, parameters=()):
        cursor = self.execute(db, sql, parameters)
        try:
            value = cursor.fetchall()
        finally:
            cursor.close()
        if self._expired():
            raise _BudgetExceeded()
        return value


def _scope(db, root, budget):
    try:
        rows = budget.fetchall(db, '''SELECT CASE WHEN typeof(value)='text'
            AND length(CAST(value AS BLOB))<=128 THEN value END AS runner_id
            FROM metadata WHERE key='runner_id' LIMIT 2''')
        if len(rows) != 1:
            raise _error('invalid_capacity_metadata', 'The local runner identity is unavailable.')
        runner = _id(rows[0]['runner_id'], 'runner')
        rows = budget.fetchall(db, '''SELECT CASE WHEN typeof(b.workspace_id)='text'
            AND length(CAST(b.workspace_id AS BLOB))<=128 THEN b.workspace_id END AS workspace_id
            FROM bindings b JOIN workspaces w ON w.id=b.workspace_id
            WHERE b.runner_id=? AND b.canonical_root=? LIMIT 2''', (runner, root))
        if len(rows) != 1:
            raise _error('not_found', 'The current directory has no unique registered local workspace.')
        return _id(rows[0]['workspace_id'], 'ws')
    except _BudgetExceeded:
        raise _error('capacity_scope_unavailable', 'The bounded inspection could not establish local workspace scope.') from None
    except sqlite3.DatabaseError:
        raise _error('capacity_scope_unavailable', 'Local workspace scope could not be read within the inspection budget.') from None


def _limits():
    # These are the actual retained limits, not independently configurable quotas.
    from .pips import MAX_RUNS
    from .pip_checkpoints import MAX_CHECKPOINTS
    from .pip_memory_statements import MAX_RECORDS
    from .workspace_session_outcomes import MAX_PROPOSALS
    return dict(zip(KINDS, (MAX_RUNS, MAX_CHECKPOINTS, MAX_RECORDS, MAX_PROPOSALS)))


def _count(db, kind, ceiling, workspace_id, budget):
    tables = {'runs': ('pip_runs',), 'checkpoints': ('pip_checkpoints',),
              'pip_memory': ('pip_memories', 'pip_memory_statements'),
              'session_statements': ('workspace_session_outcomes',)}[kind]
    parameters = []
    terms = []
    for table in tables:
        if kind == 'runs':
            # The run ceiling bounds project runs, which keep a source copy; Personal runs
            # have their own, larger ceiling (pips.MAX_PERSONAL_RUNS).
            term = ("SELECT 1 FROM pip_runs r JOIN workspaces w ON w.id=r.workspace_id "
                    "WHERE w.kind!='personal'")
            if workspace_id is not None:
                term += ' AND r.workspace_id=?'
                parameters.append(workspace_id)
        else:
            term = 'SELECT 1 FROM ' + table
            if workspace_id is not None:
                term += ' WHERE workspace_id=?'
                parameters.append(workspace_id)
        terms.append(term)
    sql = 'SELECT count(*) FROM (' + ' UNION ALL '.join(terms) + ' LIMIT ?)'
    parameters.append(ceiling + 1)
    try:
        row = budget.fetchone(db, sql, parameters)
        value = row[0]
        if type(value) is not int or not 0 <= value <= ceiling + 1:
            raise ValueError()
        return {'value': value, 'relation': 'at_least' if value == ceiling + 1 else 'exact', 'reason': None}
    except _BudgetExceeded:
        return {'value': None, 'relation': 'unknown', 'reason': budget.reason}
    except sqlite3.DatabaseError:
        return {'value': None, 'relation': 'unknown', 'reason': budget.reason or 'invalid_stored_metadata'}
    except (ValueError, TypeError, IndexError):
        return {'value': None, 'relation': 'unknown', 'reason': 'invalid_stored_metadata'}


def _pressure(counter, ceiling):
    value = counter['value']
    if counter['relation'] == 'unknown':
        return 'unknown'
    if value > ceiling:
        return 'over_limit'
    if value == ceiling:
        return 'full'
    return 'near_limit' if value * 5 >= ceiling * 4 else 'normal'


def inspect_capacity(config, *, directory=None):
    """Human local read. `directory` is internal test injection, never a CLI field."""
    require_unrestricted(config)
    root = _root(config)
    limits = _limits()
    budget = _Budget()
    as_of = utc_now()
    try:
        with _read_database(directory if directory is not None else state_directory()) as db:
            db.set_progress_handler(budget.progress, PROGRESS_INTERVAL)
            try:
                try:
                    schema = budget.fetchone(db, 'PRAGMA user_version')[0]
                    if type(schema) is not int or schema != REGISTRY_SCHEMA:
                        raise _error('schema_version', f'Capacity inspection requires existing schema{REGISTRY_SCHEMA} and never migrates it.')
                    workspace = _scope(db, root, budget)
                except _BudgetExceeded:
                    raise _error('capacity_scope_unavailable', 'The bounded inspection could not establish the registry schema.') from None
                except sqlite3.DatabaseError:
                    raise _error('capacity_scope_unavailable', 'The registry schema could not be read within the inspection budget.') from None
                rows = []
                for kind in KINDS:
                    ceiling = limits[kind]
                    global_count = _count(db, kind, ceiling, None, budget)
                    local_count = _count(db, kind, ceiling, workspace, budget)
                    rows.append({'kind': kind, 'ceiling_scope': 'local_runner', 'ceiling': ceiling,
                        'retained': global_count, 'workspace_retained': local_count,
                        'remaining_slots': max(0, ceiling - global_count['value']) if global_count['relation'] == 'exact' else None,
                        'pressure': _pressure(global_count, ceiling)})
            finally:
                # Also disable after scope failure, so a sticky interrupt cannot
                # replace its refusal while the opening helper rolls back/closes.
                db.set_progress_handler(None, 0)
    except FileNotFoundError:
        raise _error('not_initialized', 'No existing local Pip registry is available; nothing was created.') from None
    except RegistryError as exc:
        if exc.code == 'unsupported_platform':
            raise _error(exc.code, 'Read-only capacity inspection requires Linux procfs or macOS, and POSIX no-follow filesystem support.') from None
        if exc.code == 'schema_version':
            raise _error(exc.code, f'Capacity inspection requires an existing compatible schema{REGISTRY_SCHEMA} registry and never migrates it.') from None
        raise
    result = {'schema_version': 1, 'registry_schema_version': REGISTRY_SCHEMA, 'as_of': as_of,
        'scope': {'kind': 'local_runner_with_workspace', 'workspace_id': workspace}, 'capacity': rows,
        'partial': any(row[key]['relation'] != 'exact' for row in rows for key in ('retained', 'workspace_retained')),
        'dependency_closure': 'not_established', 'reclamation_assessment': 'not_performed',
        'filesystem_usage': 'not_inspected', 'other_capacity_limits': 'not_inspected', 'notice': NOTICE}
    envelope = {'capacity_inspection': result}
    if redact_value(envelope, secret_values(config)) != envelope:
        raise _error('secret_detected', 'Capacity metadata overlaps a configured secret; no altered identity was displayed.')
    if len(json.dumps(envelope, ensure_ascii=False, indent=2, allow_nan=False).encode('utf-8')) + 1 > MAX_OUTPUT_BYTES:
        raise _error('capacity_output_limit', 'The complete capacity report exceeds its bounded output size.')
    return envelope


def format_capacity(value):
    value = value['capacity_inspection']
    labels = {'runs': 'Runs', 'checkpoints': 'Audit checkpoints',
              'pip_memory': 'Pip exceptions and statements', 'session_statements': 'Session statements'}
    def count(item):
        return ('unknown (' + item['reason'] + ')' if item['relation'] == 'unknown'
                else ('at least ' if item['relation'] == 'at_least' else '') + str(item['value']))
    lines = ['Local runner retained capacity', 'Selected workspace: ' + value['scope']['workspace_id']]
    for row in value['capacity']:
        lines.append(f"{labels[row['kind']]}: {count(row['retained'])} / {row['ceiling']} across this runner; "
                     f"{count(row['workspace_retained'])} in this workspace; {row['pressure']}.")
    lines.extend(['Incomplete counters are not zero.' if value['partial'] else 'All four scoped counters completed.', value['notice']])
    return '\n'.join(lines)
