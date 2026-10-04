"""Observe approved local Git refs; emit metadata hints, never dispatch work.

Only an armed read-only Pip is observed. The initial/ref-change baseline creates
no event. Missed changes coalesce to the current commit; ancestry is not inferred.
"""
from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from pathlib import Path
import re
import stat
import time

from .pip_schedules import _instant, timestamp
from .pip_source_changes import _capture, _Unavailable
from .workspace_registry import RegistryError

MAX_TICK_ITEMS = 8
CHECK_SECONDS = 30
PROBE_SECONDS = 3.0
SCHEMA_V10 = """
CREATE TABLE pip_commit_observations(
    pip_id TEXT PRIMARY KEY REFERENCES pips(id),
    job_version INTEGER NOT NULL,
    binding_id TEXT NOT NULL REFERENCES bindings(id),
    binding_updated_at TEXT NOT NULL,
    binding_digest TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    revision TEXT,
    last_checked_at TEXT,
    observed_changes INTEGER NOT NULL DEFAULT 0 CHECK(typeof(observed_changes)='integer' AND observed_changes>=0),
    FOREIGN KEY(pip_id,job_version) REFERENCES pip_versions(pip_id,version));
CREATE INDEX pip_commit_observation_due ON pip_commit_observations(last_checked_at,pip_id);
"""
_SHA = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
_FIELDS = ("pip_id","job_version","binding_id","binding_updated_at","binding_digest","source_ref","revision","last_checked_at","observed_changes")


def _bad(message):
    return RegistryError("invalid_commit_observation", message)


def _ref(value):
    if (not isinstance(value,str) or len(value)>200 or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*",value)
            or ".." in value):
        raise _bad("Commit observation needs an approved local branch, HEAD or full commit ID.")
    return value


def _current(registry, pip_id):
    from .pip_event_triggers import _definition
    try:
        row, spec = _definition(registry, pip_id)
    except RecursionError as exc:
        raise _bad("The stored observer definition exceeds its nesting budget.") from exc
    if spec is None or "commit_changed" not in spec["events"]:
        raise _bad("This Pip does not have an approved commit-change trigger.")
    try:
        definition = json.loads(row["definition"])
        source_ref = _ref(definition.get("source_ref"))
    except (TypeError, ValueError, RecursionError) as exc:
        raise _bad("The current source reference is malformed.") from exc
    binding = registry.db.execute("""SELECT
        CASE WHEN length(CAST(id AS BLOB))<=128 THEN id END AS id,
        CASE WHEN length(CAST(canonical_root AS BLOB))<=4096 THEN canonical_root END AS canonical_root,
        CASE WHEN length(CAST(updated_at AS BLOB))<=40 THEN updated_at END AS updated_at
        FROM bindings WHERE workspace_id=? AND runner_id=?""",(row["workspace_id"],registry.runner_id)).fetchone()
    if binding is None or any(value is None for value in binding):
        raise _bad("The workspace has no bounded local binding for this observer.")
    timestamp(binding["updated_at"])
    return {"pip_id":pip_id,"workspace_id":row["workspace_id"],"job_version":row["current_version"],
            "status":row["status"],"binding_id":binding["id"],"binding_updated_at":binding["updated_at"],
            "binding_digest":hashlib.sha256(json.dumps([binding["id"],binding["canonical_root"]],ensure_ascii=False).encode("utf-8")).hexdigest(),
            "source_ref":source_ref,"canonical_root":binding["canonical_root"]}


def _state(registry,pip_id):
    row=registry.db.execute("""SELECT pip_id,job_version,
        CASE WHEN length(CAST(binding_id AS BLOB))<=128 THEN binding_id END AS binding_id,
        CASE WHEN length(CAST(binding_updated_at AS BLOB))<=40 THEN binding_updated_at END AS binding_updated_at,
        CASE WHEN length(CAST(binding_digest AS BLOB))=64 THEN binding_digest END AS binding_digest,
        CASE WHEN length(CAST(source_ref AS BLOB))<=200 THEN source_ref END AS source_ref,
        CASE WHEN revision IS NULL OR length(CAST(revision AS BLOB))<=64 THEN revision ELSE 'oversize' END AS revision,
        CASE WHEN last_checked_at IS NULL OR length(CAST(last_checked_at AS BLOB))<=40 THEN last_checked_at ELSE 'oversize' END AS last_checked_at,
        observed_changes FROM pip_commit_observations WHERE pip_id=?""",(pip_id,)).fetchone()
    if row is None: return None
    item=dict(row)
    _ref(item["source_ref"])
    if (not isinstance(item["binding_id"],str) or not item["binding_id"]
            or not isinstance(item["binding_digest"],str) or not re.fullmatch(r"[0-9a-f]{64}",item["binding_digest"])
            or type(item["job_version"]) is not int or not 1<=item["job_version"]<1000000
            or type(item["observed_changes"]) is not int or not 0<=item["observed_changes"]<2**53
            or (item["revision"] is not None and (not isinstance(item["revision"],str) or not _SHA.fullmatch(item["revision"])))):
        raise _bad("Stored commit observation metadata is invalid.")
    timestamp(item["binding_updated_at"])
    if item["last_checked_at"] is not None: timestamp(item["last_checked_at"])
    return item


def reset_observation(registry,pip_id,job_version,spec,approved_at):
    """Keep/cancel/rebaseline observation atomically with the approved job version."""
    if not registry.db.in_transaction:
        raise _bad("Commit observations must change with the approved job transaction.")
    from .pip_event_triggers import validate_event_trigger
    spec=validate_event_trigger(spec)
    timestamp(approved_at)
    _reset_path_observation(registry, pip_id, job_version, spec, approved_at)
    if spec is None or "commit_changed" not in spec["events"]:
        registry.db.execute("DELETE FROM pip_commit_observations WHERE pip_id=?",(pip_id,))
        return
    current=_current(registry,pip_id)
    if type(job_version) is not int or current["job_version"]!=job_version:
        raise RegistryError("conflict","Commit observation does not match the current approved job version.")
    previous=_state(registry,pip_id)
    same=previous is not None and all(previous[key]==current[key] for key in ("binding_id","binding_updated_at","binding_digest","source_ref"))
    registry.db.execute("""INSERT INTO pip_commit_observations VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(pip_id) DO UPDATE SET job_version=excluded.job_version,binding_id=excluded.binding_id,
        binding_updated_at=excluded.binding_updated_at,binding_digest=excluded.binding_digest,source_ref=excluded.source_ref,revision=excluded.revision,
        last_checked_at=excluded.last_checked_at,observed_changes=excluded.observed_changes""",
        (pip_id,job_version,current["binding_id"],current["binding_updated_at"],current["binding_digest"],current["source_ref"],
         previous["revision"] if same else None,previous["last_checked_at"] if same else None,
         previous["observed_changes"] if previous else 0))


def observe_commit(root,source_ref):
    """One <=3-second local-only probe, <=4KiB root and <=128-byte revision output."""
    _ref(source_ref)
    deadline=time.monotonic()+PROBE_SECONDS
    try:
        location=Path(root)
        if len(str(location).encode("utf-8"))>4096 or not location.is_absolute() or location.resolve(strict=True)!=location or not location.is_dir():
            raise _Unavailable("comparison_unavailable")
        code,raw=_capture(location,["rev-parse","--show-toplevel"],4097,deadline=deadline)
        if code or raw!=str(location).encode("utf-8")+b"\n":
            raise _Unavailable("comparison_unavailable")
        code,raw=_capture(location,["rev-parse","--verify","--end-of-options",source_ref+"^{commit}"],128,deadline=deadline)
    except (OSError,ValueError,RuntimeError) as exc:
        raise _Unavailable("comparison_unavailable") from exc
    if code:
        raise _Unavailable("comparison_unavailable")
    try: value=raw.decode("ascii")
    except UnicodeError as exc: raise _Unavailable("invalid_metadata") from exc
    if not value.endswith("\n") or not _SHA.fullmatch(value[:-1]):
        raise _Unavailable("invalid_metadata")
    return value[:-1]


def _stopped(registry,config,stop_event):
    if config.get("pips_enabled",False) is not True or (stop_event is not None and stop_event.is_set()):
        return True
    try:
        control = _control_value(registry)
        return control is not None and (type(control.get('paused')) is not bool or control['paused'])
    except RegistryError:
        return True


def _legacy_tick(registry,config,*,now=None,limit=MAX_TICK_ITEMS,stop_event=None,_pip_id=None):
    """At most eight probes, off heartbeat. Cancellation is checked between probes."""
    if type(limit) is not int or not 1<=limit<=MAX_TICK_ITEMS:
        raise _bad("A commit observation tick may probe one to eight Pips.")
    result={"checked":0,"baselined":0,"changed":0,"unavailable":0,"skipped":0}
    if _stopped(registry,config,stop_event): return result
    checked=timestamp(registry.clock() if now is None else now)
    threshold=timestamp(_instant(checked)-timedelta(seconds=CHECK_SECONDS))
    candidates=[(_pip_id,)] if _pip_id is not None else registry.db.execute("""SELECT CASE WHEN length(CAST(s.pip_id AS BLOB))<=128 THEN s.pip_id END
        FROM pip_commit_observations s JOIN pips p ON p.id=s.pip_id
        WHERE p.status='active' AND (s.last_checked_at IS NULL OR s.last_checked_at<=?)
        ORDER BY s.last_checked_at,s.pip_id LIMIT ?""",(threshold,limit)).fetchall()
    for candidate in candidates:
        if _stopped(registry,config,stop_event): break
        pip_id=candidate[0]
        if pip_id is None: result["unavailable"]+=1; continue
        try:
            state=_state(registry,pip_id)
            current=_current(registry,pip_id)
            if state is None or current["status"]!='active': result["skipped"]+=1; continue
            # Recovery for a changed binding or older observer version. It is
            # bookkeeping only, never a comparison between unrelated references.
            identity=("job_version","binding_id","binding_updated_at","binding_digest","source_ref")
            if any(state[k]!=current[k] for k in identity):
                with registry.transaction():
                    again=_current(registry,pip_id)
                    if again!=current or _stopped(registry,config,stop_event): result["skipped"]+=1; continue
                    from .pip_event_triggers import _definition
                    reset_observation(registry,pip_id,current["job_version"],_definition(registry,pip_id)[1],checked)
                state=_state(registry,pip_id)
            result["checked"]+=1
            try: revision=observe_commit(current["canonical_root"],current["source_ref"])
            except _Unavailable: revision=None; result["unavailable"]+=1
            with registry.transaction():
                if (_stopped(registry,config,stop_event) or _state(registry,pip_id)!=state
                        or _current(registry,pip_id)!=current):
                    result["skipped"]+=1; continue
                changed=revision is not None and state["revision"] is not None and revision!=state["revision"]
                if changed and state["observed_changes"] >= 2**53-1:
                    raise _bad("The observation counter has reached its safe integer limit.")
                registry.db.execute("""UPDATE pip_commit_observations SET revision=?,last_checked_at=?,observed_changes=? WHERE pip_id=?""",
                    (revision if revision is not None else state["revision"],checked,state["observed_changes"]+int(changed),pip_id))
                if changed:
                    registry.event(current["workspace_id"],"workspace_commit_changed",pip_id=pip_id,
                        payload={"job_version":current["job_version"],"source_ref":current["source_ref"],"previous_revision":state["revision"],"revision":revision})
                    result["changed"]+=1
                elif revision is not None and state["revision"] is None: result["baselined"]+=1
        except RegistryError:
            result["unavailable"]+=1  # Invalid local metadata is not authority.
    return result


PROBE_CURSOR_KEY = 'pip_commit_probe_cursor'
_PATH_IDENTITY = ('job_version','binding_id','binding_updated_at','binding_digest','source_ref','policy_digest')


def _control_value(registry):
    """Keep old pause semantics while bounding the SQL cell before allocation."""
    from .pip_daemon import CONTROL_KEY
    row = registry.db.execute("SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))<=8192 THEN value END FROM metadata WHERE key=?",
                              (CONTROL_KEY,)).fetchone()
    if row is None:
        return None
    try:
        value = json.loads(row[0])
        if not isinstance(value, dict) or value.get('schema_version') != 1 or type(value.get('schema_version')) is not int:
            raise ValueError('control')
        return value
    except (ValueError, TypeError, RecursionError) as exc:
        raise _bad('The runtime control is malformed; commit observation is stopped.') from exc


def _control_revision(registry):
    """New-mode detached I/O pins the actual control identity, never a Boolean."""
    value = _control_value(registry)
    if value is None:
        return None
    if (type(value.get('paused')) is not bool or not isinstance(value.get('revision'),str)
            or not re.fullmatch(r'control_[0-9a-f]{32}',value['revision'])):
        raise _bad('The path observer requires a valid runtime control revision.')
    return False if value['paused'] else value['revision']


def _canonical_time(value):
    if not isinstance(value,str) or len(value) != 24 or timestamp(value) != value:
        raise _bad('The path observation requires canonical UTC timestamps.')
    return value


def _path_current(registry, pip_id):
    from .pip_event_triggers import validate_event_trigger
    from .pip_commit_paths import rules_digest
    if not isinstance(pip_id,str) or not re.fullmatch(r'pip_[0-9a-f]{32}',pip_id):
        raise _bad('The path observer requires a valid Pip identity.')
    row = registry.db.execute("""SELECT CASE WHEN typeof(p.workspace_id)='text' AND length(CAST(p.workspace_id AS BLOB))<=128 THEN p.workspace_id END workspace_id,
        CASE WHEN typeof(p.current_version)='integer' AND p.current_version BETWEEN 1 AND 999999 THEN p.current_version END current_version,
        CASE WHEN p.status IN ('active','paused','archived') THEN p.status END status,
        CASE WHEN typeof(v.definition)='text' AND length(CAST(v.definition AS BLOB))<=24576 THEN v.definition END definition
        FROM pips p JOIN pip_versions v ON v.pip_id=p.id AND v.version=p.current_version WHERE p.id=?""",(pip_id,)).fetchone()
    if row is None or any(value is None for value in row) or not re.fullmatch(r'ws_[0-9a-f]{32}',row['workspace_id']):
        raise _bad('The path observer has no bounded owning workspace.')
    from .pip_commit_paths import _load
    definition = _load(row['definition'],24576)
    spec = validate_event_trigger(definition.get('event_trigger'))
    if spec is None or 'committed_paths_changed' not in spec['events']:
        raise _bad('This Pip has no reviewed committed-path trigger.')
    from .pips import _definition as canonical_definition
    if canonical_definition(**{key:definition.get(key) for key in ('name','goal','source_ref','schedule','pip_type','model_choice',
            'adaptation_policy','event_trigger','source_policy','verification_plan','github_plan')}) != definition:
        raise _bad('The path observer requires its exact canonical reviewed definition.')
    source_ref = _ref(definition.get('source_ref'))
    bindings = registry.db.execute("""SELECT
        CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))<=128 THEN id END id,
        CASE WHEN typeof(canonical_root)='text' AND length(CAST(canonical_root AS BLOB))<=4096 THEN canonical_root END canonical_root,
        CASE WHEN typeof(updated_at)='text' AND length(CAST(updated_at AS BLOB))<=40 THEN updated_at END updated_at
        FROM bindings WHERE workspace_id=? AND runner_id=? LIMIT 2""", (row['workspace_id'],registry.runner_id)).fetchall()
    if len(bindings) != 1 or any(value is None for value in bindings[0]):
        raise _bad('The path observer needs one bounded local workspace binding.')
    binding = bindings[0]
    _canonical_time(binding['updated_at'])
    return {'pip_id':pip_id,'workspace_id':row['workspace_id'],'job_version':row['current_version'],'status':row['status'],
            'binding_id':binding['id'],'binding_updated_at':binding['updated_at'],
            'binding_digest':hashlib.sha256(json.dumps([binding['id'],binding['canonical_root']],ensure_ascii=False).encode('utf-8')).hexdigest(),
            'source_ref':source_ref,'canonical_root':binding['canonical_root'],'policy':spec,
            'policy_digest':rules_digest(spec['commit_paths'])}


def _path_state(registry, pip_id):
    # Never decode a stored diagnostic before its SQL cell budget is enforced.
    columns = {'binding_id':128,'binding_updated_at':40,'binding_digest':64,'source_ref':200,'policy_digest':64,
               'revision':64,'last_checked_at':24,'last_probe':1024,'last_comparison_at':24,'last_comparison':2048}
    projections = ["CASE WHEN {0} IS NULL OR (typeof({0})='text' AND length(CAST({0} AS BLOB))<={1}) THEN {0} ELSE 0 END AS {0}".format(k,v)
                   for k,v in columns.items()]
    row = registry.db.execute("SELECT CASE WHEN typeof(pip_id)='text' AND length(CAST(pip_id AS BLOB))<=128 THEN pip_id END pip_id,job_version,observed_changes,"+','.join(projections)+
                              ' FROM pip_commit_path_observations WHERE pip_id=?',(pip_id,)).fetchone()
    if row is None:
        return None
    value = dict(row)
    if (value['pip_id'] != pip_id or any(type(value[k]) is not str for k in ('binding_id','binding_updated_at','binding_digest','source_ref','policy_digest'))
            or type(value['job_version']) is not int or not 1 <= value['job_version'] < 1000000
            or type(value['observed_changes']) is not int or not 0 <= value['observed_changes'] < 2**53
            or any(value[k] is not None and type(value[k]) is not str for k in ('revision','last_checked_at','last_probe','last_comparison_at','last_comparison'))
            or not re.fullmatch(r'[0-9a-f]{64}',value['binding_digest']) or not re.fullmatch(r'[0-9a-f]{64}',value['policy_digest'])
            or (value['revision'] is not None and not _SHA.fullmatch(value['revision']))
            or (value['last_comparison'] is None) != (value['last_comparison_at'] is None)
            or (value['last_probe'] is None) != (value['last_checked_at'] is None)):
        raise _bad('The saved path-observation metadata is malformed.')
    _ref(value['source_ref'])
    for key in ('binding_updated_at','last_checked_at','last_comparison_at'):
        if value[key] is not None:
            _canonical_time(value[key])
    return value


def _reset_path_observation(registry, pip_id, job_version, spec, approved_at):
    if not registry.db.in_transaction:
        raise _bad('Path observation resets require the reviewed version transaction.')
    if spec is None or 'committed_paths_changed' not in spec['events']:
        registry.db.execute('DELETE FROM pip_commit_path_observations WHERE pip_id=?',(pip_id,))
        return
    _canonical_time(approved_at)
    current = _path_current(registry, pip_id)
    if current['job_version'] != job_version:
        raise RegistryError('conflict','The path observer does not match the approved job version.')
    previous = _path_state(registry,pip_id)
    same = previous is not None and all(previous[k] == current[k] for k in _PATH_IDENTITY if k != 'job_version')
    retain = lambda key: previous[key] if same else None
    registry.db.execute("""INSERT INTO pip_commit_path_observations
        (pip_id,job_version,binding_id,binding_updated_at,binding_digest,source_ref,policy_digest,revision,last_checked_at,last_probe,observed_changes,last_comparison_at,last_comparison)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(pip_id) DO UPDATE SET
        job_version=excluded.job_version,binding_id=excluded.binding_id,binding_updated_at=excluded.binding_updated_at,
        binding_digest=excluded.binding_digest,source_ref=excluded.source_ref,policy_digest=excluded.policy_digest,
        revision=excluded.revision,last_checked_at=excluded.last_checked_at,last_probe=excluded.last_probe,
        observed_changes=excluded.observed_changes,last_comparison_at=excluded.last_comparison_at,last_comparison=excluded.last_comparison""",
        (pip_id,job_version,current['binding_id'],current['binding_updated_at'],current['binding_digest'],current['source_ref'],current['policy_digest'],
         retain('revision'),retain('last_checked_at'),retain('last_probe'),previous['observed_changes'] if previous else 0,
         retain('last_comparison_at'),retain('last_comparison')))


def _root_identity(root):
    location = Path(root)
    if not location.is_absolute() or len(str(location).encode('utf-8')) > 4096:
        raise _Unavailable('root_unavailable')
    try:
        identities = []
        for component in reversed((location,*location.parents)):
            info = component.lstat()
            if not stat.S_ISDIR(info.st_mode):
                raise _Unavailable('root_unavailable')
            identities.append((info.st_dev,info.st_ino))
        if location.resolve(strict=True) != location:
            raise _Unavailable('root_unavailable')
        return tuple(identities)
    except (OSError, ValueError, RuntimeError) as exc:
        raise _Unavailable('root_unavailable') from exc


def _path_probe(current, state, *, checked_at, deadline):
    from .pip_commit_paths import compare, validate_probe
    before, after, comparison = state['revision'], None, None
    status, reason = 'unavailable', None
    root = Path(current['canonical_root'])
    try:
        identity = _root_identity(root)
        code, raw = _capture(root,['rev-parse','--show-toplevel'],4097,deadline=deadline)
        if code or raw != str(root).encode('utf-8') + b'\n':
            raise _Unavailable('root_unavailable')
        code, raw = _capture(root,['rev-parse','--verify','--end-of-options',current['source_ref']+'^{commit}'],128,deadline=deadline)
        if code:
            raise _Unavailable('ref_unavailable')
        try:
            text = raw.decode('ascii')
        except UnicodeError as exc:
            raise _Unavailable('invalid_metadata') from exc
        if not text.endswith('\n') or not _SHA.fullmatch(text[:-1]):
            raise _Unavailable('invalid_metadata')
        after = text[:-1]
        if before is None:
            status = 'baselined'
        elif before == after:
            status = 'unchanged'
        else:
            comparison = compare(root,before,after,current['policy']['commit_paths'],deadline=deadline)
            status = 'compared' if comparison['status'] != 'unavailable' else 'unavailable'
            reason = comparison['reason']
        if time.monotonic() >= deadline:
            raise _Unavailable('comparison_timeout')
        if _root_identity(root) != identity:
            raise _Unavailable('root_changed')
    except _Unavailable as exc:
        status, reason, comparison = 'unavailable', exc.reason, None
    except (OSError, ValueError, RuntimeError):
        status, reason, comparison = 'unavailable','comparison_unavailable',None
    probe = {'schema_version':1,'checked_at':checked_at,'status':status,'reason':reason,
             'before_revision':before,'after_revision':after,'policy_digest':current['policy_digest'],
             'comparison_digest':comparison['digest'] if status == 'compared' else None}
    return validate_probe(probe,rules=current['policy']['commit_paths'],checked_at=checked_at), comparison


def _observe_paths(registry, config, pip_id, checked, stop_event):
    from .pip_archive import revision as lifecycle_revision
    from .pip_commit_paths import pin_match, validate_probe, validate_comparison, _load
    with registry.transaction():
        current = _path_current(registry,pip_id)
        state = _path_state(registry,pip_id)
        if state is None or current['status'] != 'active' or _stopped(registry,config,stop_event):
            return 'skipped'
        if any(state[k] != current[k] for k in _PATH_IDENTITY):
            _reset_path_observation(registry,pip_id,current['job_version'],current['policy'],checked)
            state = _path_state(registry,pip_id)
        lifecycle, control = lifecycle_revision(registry,pip_id), _control_revision(registry)
        # A corrupt prior diagnostic never becomes an authority claim or a
        # fresh empty comparison merely because a new probe was attempted.
        _path_history(current,state)
    if _stopped(registry,config,stop_event):
        return 'skipped'
    probe, comparison = _path_probe(current,state,checked_at=checked,deadline=time.monotonic()+PROBE_SECONDS)
    if _stopped(registry,config,stop_event):
        return 'skipped'
    with registry.transaction():
        if (_stopped(registry,config,stop_event) or _path_current(registry,pip_id) != current or _path_state(registry,pip_id) != state
                or lifecycle_revision(registry,pip_id) != lifecycle or _control_revision(registry) != control):
            return 'skipped'
        changed = probe['status'] == 'compared'
        if changed and state['observed_changes'] >= 2**53-1:
            probe = {**probe,'status':'unavailable','reason':'metadata_limit','comparison_digest':None}
            validate_probe(probe,rules=current['policy']['commit_paths'],checked_at=checked)
            changed, comparison = False, None
        successful = comparison is not None and comparison['status'] in ('matched','unmatched')
        encoded = lambda value: json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False)
        registry.db.execute("""UPDATE pip_commit_path_observations SET revision=?,last_checked_at=?,last_probe=?,observed_changes=?,
            last_comparison_at=?,last_comparison=? WHERE pip_id=?""",
            (probe['after_revision'] if probe['status'] != 'unavailable' else state['revision'],checked,encoded(probe),state['observed_changes']+int(changed),
             checked if successful else state['last_comparison_at'],encoded(comparison) if successful else state['last_comparison'],pip_id))
        if successful and comparison['status'] == 'matched':
            match = pin_match(**{key:current[key] for key in ('pip_id','workspace_id','job_version','binding_id','binding_digest','source_ref')},
                              rules=current['policy']['commit_paths'],comparison=comparison,observed_at=checked)
            registry.event(current['workspace_id'],'workspace_committed_paths_changed',pip_id=pip_id,payload=match,created_at=checked)
        return 'changed' if changed else 'baselined' if probe['status'] == 'baselined' else 'unavailable' if probe['status'] == 'unavailable' else 'unchanged'


def _candidates(registry, threshold, limit):
    row = registry.db.execute("SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))<=256 THEN value END FROM metadata WHERE key=?",(PROBE_CURSOR_KEY,)).fetchone()
    cursor = ('','')
    if row is not None:
        try:
            saved = json.loads(row[0])
            if (set(saved) != {'schema_version','last_pip_id','last_kind'} or type(saved['schema_version']) is not int or saved['schema_version'] != 1
                    or not isinstance(saved['last_pip_id'],str) or not re.fullmatch(r'pip_[0-9a-f]{32}',saved['last_pip_id'])
                    or saved['last_kind'] not in ('commit','paths')):
                raise ValueError('cursor')
            cursor = (saved['last_pip_id'],saved['last_kind'])
        except (ValueError, TypeError, KeyError, RecursionError, UnicodeError):
            # This is fairness bookkeeping, never a source/authority cursor.
            cursor = ('','')
    query = """WITH candidates AS (
        SELECT s.pip_id,'commit' kind FROM pip_commit_observations s JOIN pips p ON p.id=s.pip_id
        WHERE p.status='active' AND typeof(s.pip_id)='text' AND length(s.pip_id)=36 AND substr(s.pip_id,1,4)='pip_'
        AND substr(s.pip_id,5) NOT GLOB '*[^0-9a-f]*' AND (s.last_checked_at IS NULL OR s.last_checked_at<=?)
        UNION ALL
        SELECT s.pip_id,'paths' kind FROM pip_commit_path_observations s JOIN pips p ON p.id=s.pip_id
        WHERE p.status='active' AND typeof(s.pip_id)='text' AND length(s.pip_id)=36 AND substr(s.pip_id,1,4)='pip_'
        AND substr(s.pip_id,5) NOT GLOB '*[^0-9a-f]*' AND (s.last_checked_at IS NULL OR s.last_checked_at<=?))
        SELECT pip_id,kind FROM candidates WHERE (pip_id,kind) {op} (?,?) ORDER BY pip_id,kind LIMIT ?"""
    selected = registry.db.execute(query.format(op='>'),(threshold,threshold,*cursor,limit)).fetchall()
    if len(selected) < limit:
        selected += registry.db.execute(query.format(op='<='),(threshold,threshold,*cursor,limit-len(selected))).fetchall()
    return selected


def tick(registry, config, *, now=None, limit=MAX_TICK_ITEMS, stop_event=None):
    """One round-robin selection budget shared by both committed-source modes."""
    if type(limit) is not int or not 1 <= limit <= MAX_TICK_ITEMS:
        raise _bad('A commit observation tick may probe one to eight Pips.')
    result = {'checked':0,'baselined':0,'changed':0,'unavailable':0,'skipped':0}
    if _stopped(registry,config,stop_event):
        return result
    checked = timestamp(registry.clock() if now is None else now)
    threshold = timestamp(_instant(checked)-timedelta(seconds=CHECK_SECONDS))
    for pip_id, kind in _candidates(registry,threshold,limit):
        if _stopped(registry,config,stop_event):
            break
        with registry.transaction():
            registry.db.execute('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                (PROBE_CURSOR_KEY,json.dumps({'schema_version':1,'last_pip_id':pip_id,'last_kind':kind},separators=(',',':'),ensure_ascii=False)))
        if kind == 'commit':
            old = _legacy_tick(registry,config,now=checked,limit=1,stop_event=stop_event,_pip_id=pip_id)
            for key in result:
                result[key] += old[key]
        else:
            result['checked'] += 1
            try:
                status = _observe_paths(registry,config,pip_id,checked,stop_event)
                if status in result:
                    result[status] += 1
            except (RegistryError, ValueError, TypeError, RecursionError):
                result['unavailable'] += 1
    return result


def _path_history(current, state):
    """Cross-link diagnostics before display or any subsequent observation."""
    from .pip_commit_paths import _load, validate_probe, validate_comparison
    probe, comparison = None, None
    if state['last_probe'] is not None:
        probe = validate_probe(_load(state['last_probe'],1024),rules=current['policy']['commit_paths'],checked_at=state['last_checked_at'])
    if state['last_comparison'] is not None:
        saved = _load(state['last_comparison'],2048)
        comparison = validate_comparison(saved,before_revision=saved.get('before_revision'),after_revision=saved.get('after_revision'),rules=current['policy']['commit_paths'])
        if (comparison['status'] not in ('matched','unmatched') or comparison['after_revision'] != state['revision']
                or probe is None or state['last_comparison_at'] > state['last_checked_at'] or state['observed_changes'] < 1):
            raise _bad('The saved last comparison does not match its observed baseline.')
    if probe is not None:
        if probe['status'] in ('baselined','unchanged','compared') and probe['after_revision'] != state['revision']:
            raise _bad('The saved successful probe does not match its baseline.')
        if probe['status'] == 'unavailable' and probe['before_revision'] != state['revision']:
            raise _bad('The unavailable probe does not retain the prior baseline.')
        if probe['status'] == 'compared' and (comparison is None or probe['comparison_digest'] != comparison['digest']
                or any(probe[key] != comparison[key] for key in ('before_revision','after_revision'))
                or state['last_comparison_at'] != state['last_checked_at']):
            raise _bad('The saved path probe does not match its complete comparison.')
    return probe, comparison


def path_observation(registry, pip_id):
    """Bounded stored observation only; never touch a repository on a read."""
    try:
        current = _path_current(registry,pip_id)
        state = _path_state(registry,pip_id)
        if state is None:
            return None
        if any(state[key] != current[key] for key in _PATH_IDENTITY):
            return {'schema_version':1,'status':'unavailable','reason':'stale_observation'}
        probe, comparison = _path_history(current,state)
        return {'schema_version':1,'status':'available',**{key:state[key] for key in ('job_version','policy_digest','revision','last_checked_at','observed_changes','last_comparison_at')},
                'last_probe':probe,'last_comparison':comparison}
    except (RegistryError,ValueError,TypeError,KeyError,RecursionError):
        return {'schema_version':1,'status':'unavailable','reason':'invalid_stored_observation'}
