"""Explicit, local, irreversible removal of one archived Pip and its private data."""
from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path

from .workspace_registry import RegistryError
from .pip_archive import _current, _integer, _require_idle

_PIP = re.compile(r"pip_[0-9a-f]{32}\Z")
_RUN = re.compile(r"run_[0-9a-f]{32}\Z")


def _q(name):
    return '"' + name.replace('"', '""') + '"'


def _tables(db):
    # FTS shadow tables are maintained by the chat triggers; deleting their rows
    # directly corrupts the index. SQLite's table_list distinguishes them.
    return {row[1] for row in db.execute('PRAGMA table_list') if row[2] == 'table'
            and not row[1].startswith(('sqlite_', 'dgc_purge_'))}


def _selected_rows(db, pip_id, run_ids):
    db.execute('CREATE TEMP TABLE IF NOT EXISTS dgc_purge_run_ids(id TEXT PRIMARY KEY)')
    db.execute('DELETE FROM temp.dgc_purge_run_ids')
    db.executemany('INSERT INTO temp.dgc_purge_run_ids(id) VALUES(?)', ((r,) for r in run_ids))
    tables = _tables(db)
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
    record = folder / 'artifact.json'
    if folder.is_symlink() or record.is_symlink():
        raise RegistryError('unsafe_state', 'A saved Output needs repair before Pip deletion can finish.')
    try:
        raw = record.read_bytes()
    except FileNotFoundError:
        return False
    try:
        meta = json.loads(raw)
    except ValueError as exc:
        # Ownership cannot be established from a damaged record. Keep the
        # journal pending instead of claiming that all of this Pip's data was
        # removed while an unknown Output remains in the Library.
        raise RegistryError('unsafe_state', 'A saved Output needs repair before Pip deletion can finish.') from exc
    if not isinstance(meta, dict):
        return False
    return any(isinstance(meta.get(key), dict) and meta[key].get('pip') == pip_id
               for key in ('origin', 'legacy'))


def _cleanup(registry, pip_id, run_ids):
    from . import pip_computer
    from .pip_logins import Store as LoginStore
    from .artifact_store import ARTIFACT_ID, Store as ArtifactStore
    pip_computer.stop_host(pip_id)
    root = Path(registry.directory)
    for path in (root / 'computers' / pip_id, root / 'chat_images' / pip_id,
                 root / 'chat_files' / pip_id, root / 'daily-log' / pip_id,
                 root / 'working-notes' / f'{pip_id}.md', root / 'careful' / f'{pip_id}.json'):
        _remove_private(path, root)
    for run_id in run_ids:
        _remove_private(root / 'runs' / run_id, root)
    logins = LoginStore(root)
    with logins._locked():
        data = logins.read(strict=True)
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
            logins._write({**data, 'logins': kept})
    # Pip state and the account artifact Library are siblings under .dgc.
    # Using the process-global store here can erase a different profile when
    # controls target an explicit registry (including SDK isolated homes).
    arts = ArtifactStore(root.parent / 'artifacts')
    if arts.root.is_symlink():
        raise RegistryError('unsafe_state', 'The Output Library must not be a symbolic link.')
    with arts.lock():
        for folder in arts.root.iterdir():
            if ARTIFACT_ID.fullmatch(folder.name) and _artifact_owned(folder, pip_id):
                _remove_private(folder, arts.root)
        trash = arts.root / '.trash'
        if trash.is_symlink():
            raise RegistryError('unsafe_state', 'The Output Library trash must not be a symbolic link.')
        if trash.is_dir():
            for folder in trash.iterdir():
                if not folder.is_dir() or not re.fullmatch(r'ar_[0-9a-f]{16}-\d{8}T\d{6}Z', folder.name):
                    continue
                if _artifact_owned(folder, pip_id):
                    _remove_private(folder, arts.root)


def recover(registry):
    root = Path(registry.directory) / 'purges'
    if not root.is_dir():
        return
    if root.is_symlink():
        raise RegistryError('unsafe_state', 'The Pip deletion journal directory is not private.')
    for path in root.glob('pip_*.json'):
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
            path.unlink(); continue
        _cleanup(registry, pip_id, run_ids)
        path.unlink()


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
    recover(store.registry)
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
        store.db.execute('DELETE FROM metadata WHERE instr(key,?)>0 OR instr(value,?)>0', (pip_id, pip_id))
        if store.db.execute('SELECT 1 FROM pips WHERE id=?', (pip_id,)).fetchone():
            raise RegistryError('unsafe_state', 'The Pip remained in the registry.')
    recover(store.registry)
    return {'deleted': True, 'pip_id': pip_id}
