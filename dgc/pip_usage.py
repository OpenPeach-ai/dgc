"""Import terminal Pip request accounting without sharing the parent's home with workers.

Each run is imported atomically once. A crash before commit imports nothing; a
retry after commit is a no-op. The parent reads bounded, untrusted worker data.
"""
from __future__ import annotations
import re
import sqlite3
import time
from pathlib import Path
from contextlib import closing

MAX_LEDGER_BYTES = 8 * 1024 * 1024
MAX_REQUESTS = 1024
BATCH_RUNS = 64
RUN_ID = re.compile(r"run_[a-f0-9]{32}\Z")


def _rows(path):
    if path.is_symlink() or not path.is_file():
        if path.is_symlink(): raise ValueError('Pip usage ledger is a symlink')
        return []
    if path.stat().st_size > MAX_LEDGER_BYTES:
        raise ValueError('Pip usage ledger exceeds its byte bound')
    for suffix in ('-wal', '-shm'):
        side = Path(str(path) + suffix)
        if side.is_symlink() or side.exists() and side.stat().st_size > MAX_LEDGER_BYTES:
            raise ValueError('Pip usage sidecar exceeds its safe bounds')
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=.1)) as source:
        source.execute('PRAGMA query_only=ON')
        source.execute('PRAGMA trusted_schema=OFF')
        steps = 0
        def bounded():
            nonlocal steps
            steps += 1
            return int(steps > 2000)
        source.set_progress_handler(bounded, 1000)
        kind = source.execute("SELECT type FROM sqlite_master WHERE name='requests'").fetchone()
        if kind != ('table',): raise ValueError('Pip usage must contain a requests table')
        rows = source.execute('SELECT ts,provider,host,model,input_tokens,output_tokens,cached_input_tokens,metered FROM requests ORDER BY id LIMIT ?', (MAX_REQUESTS + 1,)).fetchall()
    if len(rows) > MAX_REQUESTS: raise ValueError('Pip usage exceeds its request bound')
    for row in rows:
        if type(row[0]) is not int or not 0 <= row[0] <= 2**63-1: raise ValueError('Invalid Pip usage timestamp')
        for text, limit in zip(row[1:4], (64,255,256)):
            if not isinstance(text,str) or not text or len(text)>limit or any(ord(c)<32 for c in text): raise ValueError('Invalid Pip usage label')
        if any(type(n) is not int or not 0 <= n <= 1_000_000_000 for n in row[4:7]) or type(row[7]) is not int or row[7] not in (0,1): raise ValueError('Invalid Pip usage count')
    return rows


def _imports_table(db):
    """Which runs are imported, with each run's totals (added in 0.48; older rows have none)."""
    db.execute('CREATE TABLE IF NOT EXISTS pip_usage_imports(run_id TEXT PRIMARY KEY, imported_at INTEGER NOT NULL)')
    columns = {row[1] for row in db.execute('PRAGMA table_info(pip_usage_imports)')}
    for name in ('input_tokens', 'output_tokens', 'requests'):
        if name not in columns:
            db.execute(f'ALTER TABLE pip_usage_imports ADD COLUMN {name} INTEGER')


def run_totals(run_ids, *, home=None) -> dict:
    """{run_id: (input_tokens, output_tokens)} for imported runs that recorded totals."""
    from . import config, usage_ledger as ledger
    ids = [r for r in run_ids if isinstance(r, str) and RUN_ID.fullmatch(r)]
    path = (Path(home) if home is not None else Path(config.USER_HOME)) / ledger.LEDGER_NAME
    if not ids or path.is_symlink() or not path.is_file():
        return {}
    totals = {}
    try:
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=.2)) as db:
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='pip_usage_imports'").fetchone() is None:
                return {}
            columns = {row[1] for row in db.execute('PRAGMA table_info(pip_usage_imports)')}
            if not {'input_tokens', 'output_tokens'} <= columns:
                return {}
            for start in range(0, len(ids), 500):
                chunk = ids[start:start + 500]
                marks = ",".join("?" * len(chunk))
                for run_id, inp, out in db.execute(
                        f'SELECT run_id,input_tokens,output_tokens FROM pip_usage_imports WHERE run_id IN ({marks})', chunk):
                    if type(inp) is int and type(out) is int:
                        totals[run_id] = (inp, out)
    except sqlite3.Error:
        return {}
    return totals


def import_run(run_id, *, home=None):
    from . import config, usage_ledger as ledger
    if not isinstance(run_id,str) or not RUN_ID.fullmatch(run_id): raise ValueError('Invalid Pip usage run identity')
    home=Path(home) if home is not None else Path(config.USER_HOME)
    base=home/'pips'/'runs'/run_id/'worker-home'/'.dgc'
    # Refuse a worker-controlled ancestor redirect, not only the final filename.
    for part in (home/'pips', home/'pips'/'runs', base.parent.parent, base.parent, base):
        if part.is_symlink(): raise ValueError('Pip usage path is a symlink')
    with ledger._lock:
        db=ledger._open(home/ledger.LEDGER_NAME,create=True)
        _imports_table(db)
        if db.execute('SELECT 1 FROM pip_usage_imports WHERE run_id=?',(run_id,)).fetchone():return False
        rows=_rows((base/ledger.LEDGER_NAME).absolute())
        cutoff=int(time.time())-ledger.RETENTION_DAYS*86400
        db.execute('BEGIN IMMEDIATE')
        try:
            if db.execute('SELECT 1 FROM pip_usage_imports WHERE run_id=?',(run_id,)).fetchone():
                db.execute('ROLLBACK');return False
            db.executemany('INSERT INTO requests(ts,provider,host,model,source,input_tokens,output_tokens,cached_input_tokens,metered) VALUES (?,?,?,?,?,?,?,?,?)',
                [(r[0],r[1],r[2],r[3],'pip',*r[4:]) for r in rows if r[0]>=cutoff])
            # The run's own totals too, all of its requests: what each Pip costs (pip_spend),
            # including a run that failed or timed out and so reported no usage of its own.
            db.execute('INSERT INTO pip_usage_imports(run_id,imported_at,input_tokens,output_tokens,requests) VALUES (?,?,?,?,?)',
                       (run_id,int(time.time()),sum(r[4] for r in rows),sum(r[5] for r in rows),len(rows)))
            db.execute('COMMIT')
        except BaseException:
            db.execute('ROLLBACK');raise
    return True


def sync_completed():
    """Catch up runs completed before upgrade or a parent crash; bounded per refresh."""
    from . import config, usage_ledger as ledger
    home=Path(config.USER_HOME);path=home/'pips'/'registry.sqlite3'
    if not path.is_file():return ''
    try:
        with ledger._lock:
            db=ledger._open(home/ledger.LEDGER_NAME,create=True)
            _imports_table(db)
        with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=.1)) as registry:
            registry.execute('ATTACH DATABASE ? AS accounting', ((home/ledger.LEDGER_NAME).as_uri()+'?mode=ro',))
            registry.execute('PRAGMA query_only=ON')
            pending=[r[0] for r in registry.execute("""
                SELECT r.id FROM pip_runs AS r
                WHERE r.status IN ('succeeded','failed','cancelled')
                AND NOT EXISTS (SELECT 1 FROM accounting.pip_usage_imports AS i WHERE i.run_id=r.id)
                ORDER BY r.created_at,r.id LIMIT ?
            """, (BATCH_RUNS+1,))]
        for run_id in pending[:BATCH_RUNS]:import_run(run_id)
        return 'Older Pip usage is still importing. Refresh to finish.' if len(pending)>BATCH_RUNS else ''
    except (OSError,ValueError,sqlite3.Error) as exc:
        return 'Pip usage could not be imported: '+str(exc)[:200]
