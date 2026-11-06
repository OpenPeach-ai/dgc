"""Explicit, local, irreversible removal of one archived Pip and its private data."""
from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import time
from pathlib import Path

from .workspace_registry import RegistryError
from .pip_archive import _current, _integer, _require_idle

_PIP = re.compile(r"pip_[0-9a-f]{32}\Z")
_RUN = re.compile(r"run_[0-9a-f]{32}\Z")


def _q(name):
    return '"' + name.replace('"', '""') + '"'


# The tables full-text search keeps beside a virtual table (FTS5, then FTS3/4).
_SHADOW = ('_data', '_idx', '_docsize', '_config', '_content', '_segments', '_segdir', '_stat')


def _tables(db):
    # FTS shadow tables are maintained by the chat triggers; deleting their rows
    # directly corrupts the index. SQLite's table_list distinguishes them.
    rows = db.execute('PRAGMA table_list').fetchall()
    if rows:
        return {row[1] for row in rows if row[2] == 'table'
                and not row[1].startswith(('sqlite_', 'dgc_purge_'))}
    # SQLite before 3.37 has no table_list and answers nothing. sqlite_master lists a
    # virtual table and its shadow tables as plain tables: leave both out by name.
    master = db.execute("SELECT name,sql FROM sqlite_master WHERE type='table'").fetchall()
    virtual = {r[0] for r in master if re.match(r'\s*CREATE\s+VIRTUAL\s+TABLE\b', r[1] or '', re.I)}
    shadows = {v + suffix for v in virtual for suffix in _SHADOW}
    return {r[0] for r in master if r[0] not in virtual and r[0] not in shadows
            and not r[0].startswith(('sqlite_', 'dgc_purge_'))}


def _selected_rows(db, pip_id, run_ids):
    db.execute('CREATE TEMP TABLE IF NOT EXISTS dgc_purge_run_ids(id TEXT PRIMARY KEY)')
    db.execute('DELETE FROM temp.dgc_purge_run_ids')
    db.executemany('INSERT INTO temp.dgc_purge_run_ids(id) VALUES(?)', ((r,) for r in run_ids))
    tables = _tables(db)
    flow_ids = ([r[0] for r in db.execute('SELECT id FROM pip_flows WHERE instr(definition,?)>0', (pip_id,))]
                if 'pip_flows' in tables else [])
    columns = {t: [r[1] for r in db.execute(f'PRAGMA table_info({_q(t)})')] for t in tables}
    chosen = {t: set() for t in tables}
    for table, names in columns.items():
        clauses, values = [], []
        if table == 'pips':
            clauses.append('id=?'); values.append(pip_id)
        if table == 'pip_runs' and run_ids:
            clauses.append('id IN (SELECT id FROM temp.dgc_purge_run_ids)')
        if table == 'workspace_events':
            # A handoff's event may belong to the other Pip while its payload
            # still names the deleted Pip's run. Remove that event too.
            clauses.append('instr(payload,?)>0'); values.append(pip_id)
            if run_ids:
                clauses.append('EXISTS (SELECT 1 FROM temp.dgc_purge_run_ids r WHERE instr(payload,r.id)>0)')
            for flow_id in flow_ids:
                clauses.append('instr(payload,?)>0'); values.append(flow_id)
        if table == 'pip_flows':
            # The reviewed sequence stores Pip identities inside bounded JSON.
            # Removing one Pip permanently removes that entire workflow and its
            # step receipts, including references in other Pips' history.
            clauses.append('instr(definition,?)>0'); values.append(pip_id)
        for name in names:
            if name == 'pip_id' or name.endswith('_pip_id'):
                clauses.append(f'{_q(name)}=?'); values.append(pip_id)
            if run_ids and (name == 'run_id' or name.endswith('_run_id')):
                clauses.append(f'{_q(name)} IN (SELECT id FROM temp.dgc_purge_run_ids)')
        if clauses:
            chosen[table].update(row[0] for row in db.execute(
                f'SELECT rowid FROM {_q(table)} WHERE ' + ' OR '.join(clauses), values))
    # Select all descendants of owned/cross-linked rows. This covers lazy tables
    # with no Pip column (chat images, finding reviews, approval receipts, etc.).
    while True:
        changed = False
        for child in tables:
            groups = {}
            for row in db.execute(f'PRAGMA foreign_key_list({_q(child)})'):
                groups.setdefault(row[0], []).append(row)
            for refs in groups.values():
                parent = refs[0][2]
                if parent not in chosen or not chosen[parent]:
                    continue
                match = ' AND '.join(f'c.{_q(r[3])}=p.{_q(r[4] or "id")}' for r in refs)
                rows = set()
                parent_ids = sorted(chosen[parent])
                for at in range(0, len(parent_ids), 400):
                    batch = parent_ids[at:at+400]
                    marks = ','.join('?' for _ in batch)
                    rows.update(r[0] for r in db.execute(
                        f'SELECT c.rowid FROM {_q(child)} c WHERE EXISTS '
                        f'(SELECT 1 FROM {_q(parent)} p WHERE p.rowid IN ({marks}) AND {match})', batch))
                if rows - chosen[child]:
                    chosen[child].update(rows); changed = True
        if not changed:
            return {t: ids for t, ids in chosen.items() if ids}


def _child_first(db, selected):
    children = {t: set() for t in selected}
    for child in selected:
        for row in db.execute(f'PRAGMA foreign_key_list({_q(child)})'):
            if row[2] in selected and row[2] != child:
                children[row[2]].add(child)
    result, visiting, done = [], set(), set()
    def visit(table):
        if table in done or table in visiting:
            return
        visiting.add(table)
        for child in sorted(children[table]):
            visit(child)
        visiting.remove(table); done.add(table); result.append(table)
    for table in sorted(selected):
        visit(table)
    return result


def _delete_rows(db, selected):
    # Retention triggers protect normal controls. An exact human purge may
    # temporarily lift only BEFORE DELETE guards, within the same transaction.
    guards = [(r[0], r[1]) for r in db.execute(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL")
        if re.search(r'\bBEFORE\s+DELETE\b', r[1], re.I)
        and re.search(r'\bRAISE\s*\(', r[1], re.I)]
    for name, _ in guards:
        db.execute(f'DROP TRIGGER {_q(name)}')
    try:
        for table in _child_first(db, selected):
            ids = sorted(selected[table])
            for at in range(0, len(ids), 400):
                batch = ids[at:at+400]
                db.execute(f'DELETE FROM {_q(table)} WHERE rowid IN (' + ','.join('?' for _ in batch) + ')', batch)
    finally:
        for _, sql in guards:
            db.execute(sql)
    if db.execute('PRAGMA foreign_key_check').fetchone() is not None:
        raise RegistryError('unsafe_state', 'Pip deletion would leave broken registry references.')


def _names(value, pip_id):
    return pip_id in json.dumps(value)


def _without(value, pip_id):
    """A shared JSON value with this Pip's entries taken out: the list items and object members that name it."""
    if isinstance(value, list):
        return [_without(v, pip_id) for v in value if not _names(v, pip_id)]
    if isinstance(value, dict):
        return {k: _without(v, pip_id) for k, v in value.items()
                if pip_id not in k and not (isinstance(v, str) and pip_id in v)}
    return value


def _forget_metadata(db, pip_id):
    """Every per-Pip row names the Pip in its key and goes. A row shared by every Pip (the desktop notifier's seen
    list, say) loses only this Pip's entries: deleting it whole would forget the other Pips' too."""
    db.execute('DELETE FROM metadata WHERE instr(key,?)>0', (pip_id,))
    for key, value in db.execute('SELECT key,value FROM metadata WHERE instr(value,?)>0', (pip_id,)).fetchall():
        try:
            shared = json.loads(value)
        except (TypeError, ValueError, RecursionError):
            shared = None
        if isinstance(shared, (dict, list)):
            kept = _without(shared, pip_id)
            if not _names(kept, pip_id):
                db.execute('UPDATE metadata SET value=? WHERE key=?', (json.dumps(kept), key))
                continue
        db.execute('DELETE FROM metadata WHERE key=?', (key,))


def _journal_path(directory, pip_id):
    return Path(directory) / 'purges' / f'{pip_id}.json'


def _write_journal(directory, pip_id, run_ids):
    path = _journal_path(directory, pip_id)
    if path.parent.is_symlink():
        raise RegistryError('unsafe_state', 'The Pip deletion journal directory is not private.')
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    value = json.dumps({'pip_id': pip_id, 'run_ids': run_ids}, separators=(',', ':')).encode()
    tmp = path.with_suffix(f'.{os.getpid()}.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(value); stream.flush(); os.fsync(stream.fileno())
        os.replace(tmp, path)
        parent = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(parent)
        finally: os.close(parent)
    finally:
        if tmp.exists(): tmp.unlink()


def _remove_private(path, root):
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise RegistryError('unsafe_state', 'Pip deletion reached outside private DGC state.') from exc
    ancestor = root
    if ancestor.is_symlink():
        raise RegistryError('unsafe_state', 'Pip deletion state must not be a symbolic link.')
    for part in relative.parts[:-1]:
        ancestor = ancestor / part
        if ancestor.is_symlink():
            raise RegistryError('unsafe_state', 'Pip deletion state must not contain a symbolic link.')
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def _artifact_owned(folder, pip_id):
    """True for this Pip's saved Output, False for another's. None when DGC can't tell and it may be this Pip's (a
    half-made Output from a crash, a damaged or unreadable record): never decided by guessing, and never deleted."""
    from .artifact_store import Artifact, ArtifactError
    record = folder / 'artifact.json'
    if folder.is_symlink() or record.is_symlink():
        return None
    try:
        raw = record.read_bytes()
    except FileNotFoundError:
        # Half-made: the Library's own list skips these. An empty one holds nobody's data.
        try:
            return None if any(folder.iterdir()) else False
        except OSError:
            return None
    except OSError:
        return None
    try:
        meta = json.loads(raw)
    except (ValueError, RecursionError):
        return None
    if not isinstance(meta, dict):
        return None
    try:
        art = Artifact.from_json(meta)
    except ArtifactError:
        # Readable, but a record this DGC doesn't know (a newer DGC's type): whether it names this Pip is plain.
        return None if pip_id in json.dumps(meta) else False
    if art.id != folder.name[:19]:
        return None if pip_id in json.dumps(meta) else False
    if art.origin.get('surface') == 'pip' and not isinstance(art.origin.get('pip'), str):
        return None
    return art.origin.get('pip') == pip_id or art.legacy.get('pip') == pip_id


def _cleanup(registry, pip_id, run_ids):
    """Erase what the deleted Pip left on disk. Every part runs even when an earlier one fails, and the first
    failure is raised after them (the journal stays, so a later Pips command finishes it). Returns the saved
    Outputs left in place because DGC couldn't tell whether they were this Pip's."""
    from . import pip_computer
    from .pip_logins import Store as LoginStore
    from .artifact_store import ARTIFACT_ID, Store as ArtifactStore
    root = Path(registry.directory)
    left, failures = [], []

    def files():
        pip_computer.stop_host(pip_id)
        for path in (root / 'computers' / pip_id, root / 'chat_images' / pip_id,
                     root / 'chat_files' / pip_id, root / 'daily-log' / pip_id,
                     root / 'working-notes' / f'{pip_id}.md', root / 'careful' / f'{pip_id}.json'):
            _remove_private(path, root)
        for run_id in run_ids:
            _remove_private(root / 'runs' / run_id, root)

    def logins():
        store = LoginStore(root)
        with store._locked():
            data = store.read(strict=True)
            kept = []
            changed = False
            for login in data['logins']:
                grants = login['pips']
                if grants == 'all':
                    kept.append(login)
                elif pip_id not in grants:
                    kept.append(login)
                elif len(grants) > 1:
                    login['pips'] = [p for p in grants if p != pip_id]
                    kept.append(login); changed = True
                else:
                    changed = True
            if changed:
                store._write({**data, 'logins': kept})

    def outputs():
        # Pip state and the account artifact Library are siblings under .dgc.
        # Using the process-global store here can erase a different profile when
        # controls target an explicit registry (including SDK isolated homes).
        arts = ArtifactStore(root.parent / 'artifacts')
        if arts.root.is_symlink():
            raise RegistryError('unsafe_state', 'The Output Library must not be a symbolic link.')
        if not arts.root.is_dir():
            return
        with arts.lock():
            folders = [f for f in arts.root.iterdir() if ARTIFACT_ID.fullmatch(f.name)]
            trash = arts.root / '.trash'
            if trash.is_symlink():
                raise RegistryError('unsafe_state', 'The Output Library trash must not be a symbolic link.')
            if trash.is_dir():
                folders += [f for f in trash.iterdir()
                            if re.fullmatch(r'ar_[0-9a-f]{16}-\d{8}T\d{6}Z', f.name) and f.is_dir()]
            for folder in sorted(folders):
                owned = _artifact_owned(folder, pip_id)
                if owned:
                    _remove_private(folder, arts.root)
                elif owned is None:
                    # One Output DGC can't read never holds up the rest, and is never deleted on a guess.
                    left.append(str(folder))

    def memory():
        # What a Personal Pip kept in the user's one memory is tagged with it, with a quote of the chat it came
        # from. Look where the Pip wrote (DGC's memory) and in this registry's own profile.
        from . import shared_memory
        places = {}
        for where in (shared_memory.default_root(), root.parent / 'memory'):
            places.setdefault(os.path.abspath(where), Path(where))
        for where in places.values():
            if not (where / 'facts.json').exists() and not (where / 'journal.ndjson').exists():
                continue
            try:
                shared_memory.SharedMemory(where).erase_pip(pip_id)
            except shared_memory.NotRemembered as exc:
                raise RegistryError('unsafe_state', "DGC's memory file couldn't be read, so what this Pip kept "
                                    'there stays until it can be. Check it in Settings → Memory.') from exc

    for part in (files, logins, outputs, memory):
        try:
            part()
        except (RegistryError, OSError) as exc:
            failures.append(exc)
    if failures and left:
        raise RegistryError(getattr(failures[0], 'code', 'unsafe_state'),
                            f'{failures[0]} {left_note(left)}') from failures[0]
    if failures:
        raise failures[0]
    return left


def left_note(left):
    """What to tell the user about saved Outputs a deletion left in place."""
    one = len(left) == 1
    return (f"DGC couldn't read {'a saved Output' if one else f'{len(left)} saved Outputs'}, so it left "
            f"{'it' if one else 'them'} in place: {', '.join(left)}. Delete {'it' if one else 'them'} "
            f"if {'it was' if one else 'they were'} this Pip's.")


def _finish(registry, path):
    """Finish one journalled deletion: (pip_id, the saved Outputs left in place)."""
    try:
        if path.is_symlink() or not path.is_file():
            raise ValueError('unsafe purge journal')
        value = json.loads(path.read_text())
        pip_id, run_ids = value['pip_id'], value['run_ids']
        if not _PIP.fullmatch(pip_id) or path.name != f'{pip_id}.json' or not isinstance(run_ids, list) or not all(_RUN.fullmatch(r) for r in run_ids):
            raise ValueError('invalid purge journal')
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise RegistryError('unsafe_state', 'A Pip deletion journal needs repair before continuing.') from exc
    # A concurrent purge may have written the journal but not committed.
    # Wait for its write transaction before deciding the journal is stale.
    with registry.transaction():
        still_live = registry.db.execute('SELECT 1 FROM pips WHERE id=?', (pip_id,)).fetchone() is not None
    if still_live:
        # The database transaction never committed. This journal contains no
        # authorization to delete a still-live Pip's files.
        path.unlink()
        return pip_id, []
    left = _cleanup(registry, pip_id, run_ids)
    path.unlink()
    return pip_id, left


RETRY_SECONDS = 60


def recover(registry, *, strict=True):
    """Finish deletions a crash or a failure left half done: {pip_id: saved Outputs left in place}. `strict`
    raises the first problem. Otherwise (every Pips command does this first) a deletion that can't finish yet
    never fails the command: it is tried again at most once a minute, until what stops it is fixed."""
    root = Path(registry.directory) / 'purges'
    done = {}
    try:
        if not root.is_dir():
            return done
        if root.is_symlink():
            raise RegistryError('unsafe_state', 'The Pip deletion journal directory is not private.')
        journals = sorted(root.glob('pip_*.json'))
    except (RegistryError, OSError, sqlite3.Error):
        if strict:
            raise
        return done
    for path in journals:
        try:
            if not strict and time.time() - path.lstat().st_mtime < RETRY_SECONDS:
                continue
            pip_id, left = _finish(registry, path)
            done[pip_id] = left
        except (RegistryError, OSError, sqlite3.Error):
            _tried(path)
            if strict:
                raise
    return done


def _tried(path):
    """Note when a deletion was last tried: the next try waits RETRY_SECONDS."""
    try:
        if path.is_file() and not path.is_symlink():
            os.utime(path)
    except OSError:
        pass


def delete(store, pip_id, *, expected_name, expected_version, expected_lifecycle_revision, actor):
    """Only an authenticated local human may call this. It is not a model tool."""
    if not isinstance(pip_id, str) or not _PIP.fullmatch(pip_id):
        raise RegistryError('invalid_request', 'Choose an exact archived Pip.')
    if not isinstance(expected_name, str) or not expected_name.strip():
        raise RegistryError('invalid_request', 'Type the Pip name to confirm permanent deletion.')
    _integer(expected_version, 'Expected job version', 1, 999999)
    _integer(expected_lifecycle_revision, 'Expected lifecycle revision')
    if actor not in ('editor-user', 'local-console'):
        raise RegistryError('local_only', 'Permanently delete a Pip on this computer.')
    # Another Pip's unfinished deletion never stops this one.
    recover(store.registry, strict=False)
    with store.registry.transaction():
        current = _current(store, pip_id)
        if current['status'] != 'archived':
            raise RegistryError('invalid_lifecycle', 'Archive the Pip before deleting it permanently.')
        if (current['current_version'], current['lifecycle_revision']) != (expected_version, expected_lifecycle_revision):
            raise RegistryError('conflict', 'The Pip changed. Refresh before deleting it.')
        if store._job(pip_id)['name'] != expected_name:
            raise RegistryError('conflict', 'The Pip name changed. Refresh before deleting it.')
        from .pip_archive import _now
        _require_idle(store, pip_id, _now(store.registry))
        run_ids = [r[0] for r in store.db.execute('SELECT id FROM pip_runs WHERE pip_id=?', (pip_id,))]
        if not all(_RUN.fullmatch(r) for r in run_ids):
            raise RegistryError('unsafe_state', 'A Pip run has an invalid identity.')
        _write_journal(store.registry.directory, pip_id, run_ids)
        store.db.execute('PRAGMA defer_foreign_keys=ON')
        selected = _selected_rows(store.db, pip_id, run_ids)
        _delete_rows(store.db, selected)
        _forget_metadata(store.db, pip_id)
        if store.db.execute('SELECT 1 FROM pips WHERE id=?', (pip_id,)).fetchone():
            raise RegistryError('unsafe_state', 'The Pip remained in the registry.')
    journal = _journal_path(store.registry.directory, pip_id)
    try:
        _, left = _finish(store.registry, journal)
    except (RegistryError, OSError):
        _tried(journal)
        raise
    result = {'deleted': True, 'pip_id': pip_id}
    if left:
        result['outputs_left'] = left
    return result
