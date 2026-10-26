"""Continue a finished helper with its memory (0.48).

A helper (a `task` sub-agent) that has finished can be given more work, and it is the SAME helper that does it: its
earlier conversation (what it was asked, what it read, what it found and said) is put back, and the new request is
its next message. Without this a follow-up was a fresh helper that read everything again; now a review can become its
fixes, then a follow-up fix, without re-learning the code.

Who can ask:
- the model, with the `continue_task` tool (dgc/tools.py SUPERVISION_TOOL_SCHEMAS): in the turn, like `task`, or in
  the background;
- the person, with "Ask it to do more" on the helper's card in the agent map and on its report line in the chat
  (the editor command `continue_agent`), or `/agents continue <id> <text>` in the terminal. That always runs in the
  background, with no turn, and reports back like a background helper: a wake turn and its report line.
Neither asks for anything starting a helper would not: the model's call is decided as a `task` call (its
description is the helper's), and the person's request is their own (a deny rule for Task still refuses it).

How it resumes (`continue_helper`):
- From its saved conversation, `<session>.helpers/<agent id>.json` beside the chat's transcript (private, redacted
  like the transcript), written each time one of its runs ends. A chat with no saved session keeps it in memory for
  as long as the chat is open. So the chat's own helpers can be continued after a reload or a restart, once a run of
  theirs has ended; a run a restart stopped part-way never saved its conversation (its Run again starts it fresh).
  A helper's helpers, a Troupe's agents and a Pip fix are not kept.
- In a fresh copy of the project as it is now, under the same isolation rules as any helper (dgc/helper_checkout.py:
  its brief names its copy, the file tools refuse the user's checkout). Its earlier copy was integrated and removed;
  the paths of that copy in its earlier messages are moved to the new one.
- Told what changed since its run ended: the files changed in the person's project since then, named (read from
  Git: the commit and every uncommitted file's content, recorded when the run ended), and that its earlier view of
  the code may be stale, so it re-reads a file before editing it.
- Compacted first when its conversation fills half its window or more (Agent.maybe_compact, DGC's own compaction,
  before the new request is added, so the summary can never paraphrase it away).
- On the model, agent kind and permissions it had: the same agent definition, and the model its last run used.
- A helper whose work was held back (not integrated, waiting in Review) continues in a fresh copy too. Its held-back
  changes are shown to it as a diff, and its kept worktree stays in Review untouched until the person applies or
  drops it: DGC never throws away work nobody has looked at.

What shows: the agent map keeps its one row (the registry record is reopened, never a second one) with "Continued" and
its count of runs, and its transcript has a divider per run ("Continued 18:42 · asked by you"); the editor learns the
runs from `agent_runs` (dgc/editor_protocol.py). Its report, integration and Undo are any helper's.
"""
from __future__ import annotations

import copy
import difflib
import hashlib
import json
import os
import re
import stat
import tempfile
import threading
import time
from pathlib import Path

SUFFIX = ".helpers"
INDEX = "index.json"
VERSION = 1
ID_RE = re.compile(r"sub-[0-9a-f]{12}\Z")
MAX_HELPERS = 64                 # helpers whose conversation a chat keeps (the oldest goes first)
MAX_RECORD_BYTES = 12 * 1024 * 1024
MAX_MESSAGE_CHARS = 60_000       # one message's text, head and tail kept
MAX_RUNS = 20                    # runs a record (and agent_runs) remembers
MAX_TEXT = 16_000                # a request's length
MAX_PROMPT = 16_000
MAX_STATE_FILES = 2_000          # uncommitted files recorded for "changed since"
MAX_CHANGED_SHOWN = 30
MAX_HELD_DIFF = 24_000
MAX_HELD_FILES = 20
WIRE_REQUEST, WIRE_NOTE, WIRE_REPORT = 2_000, 600, 2_000
ENDED = ("finished", "failed", "stopped")
WHO = {"you": "you", "model": "DGC"}
IMAGE_NOTE = "[An image it looked at in its earlier run. Images are not kept with its memory.]"


class Refused(Exception):
    """Why a helper can't be continued now: `reason` (a short wire word) and the sentence to show."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


# ---------------------------------------------------------------------------------------- storage ---
def store_dir(session_file) -> Path:
    """``<session>.helpers/`` beside the transcript (not created)."""
    return Path(session_file).with_suffix(SUFFIX)


def _ensure_dir(session_file) -> Path:
    directory = store_dir(session_file)
    if directory.is_symlink():
        raise OSError("the helpers' store is a symlink")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        directory.chmod(0o700)
    except OSError:
        pass
    return directory


def _write(path: Path, value) -> None:
    text = json.dumps(value, ensure_ascii=False, default=str)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".part")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _read(path: Path, limit: int = MAX_RECORD_BYTES + 1024 * 1024):
    try:
        info = path.lstat()
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def remove_store(session_file) -> None:
    """Delete a session's helpers' store (with the session). A symlink in its place is unlinked, never followed."""
    directory = store_dir(session_file)
    try:
        if directory.is_symlink():
            directory.unlink()
            return
        if not directory.is_dir():
            return
        for child in directory.iterdir():
            try:
                if child.is_file() or child.is_symlink():
                    child.unlink()
            except OSError:
                pass
        directory.rmdir()
    except OSError:
        pass


def copy_store(src_session, dst_session) -> int:
    """A branch of the chat keeps its helpers' conversations: hard links, falling back to copies."""
    import shutil
    source = store_dir(src_session)
    if source.is_symlink() or not source.is_dir():
        return 0
    copied = 0
    target_dir = None
    for path in source.iterdir():
        if not path.name.endswith(".json") or path.is_symlink() or not path.is_file():
            continue
        if target_dir is None:
            target_dir = _ensure_dir(dst_session)
        target = target_dir / path.name
        try:
            os.link(path, target)
        except OSError:
            try:
                shutil.copyfile(path, target)
                os.chmod(target, 0o600)
            except OSError:
                continue
        copied += 1
    return copied


# ------------------------------------------------------------------------------------ the cache ---
def _cache(parent) -> tuple[threading.Lock, dict]:
    """This chat's helpers: `index` {id: summary} and, for a chat with no session file, `records` {id: record}.

    Keyed by the session file and the monitor hub's epoch, so a new chat (or another session opened in this tab)
    never sees the last one's helpers."""
    lock = parent.__dict__.get("_helper_memory_lock")
    if lock is None:
        lock = parent.__dict__.setdefault("_helper_memory_lock", threading.Lock())
    session = getattr(parent, "session_file", None)
    key = (str(session or ""), getattr(getattr(parent, "monitors", None), "epoch", None))
    with lock:
        cache = parent.__dict__.get("_helper_memory")
        if cache is None or cache.get("key") != key:
            index = {}
            if session:
                raw = _read(store_dir(session) / INDEX, 4 * 1024 * 1024)
                if isinstance(raw, dict) and raw.get("version") == VERSION and isinstance(raw.get("helpers"), dict):
                    for agent_id, summary in raw["helpers"].items():
                        clean = _clean_summary(agent_id, summary)
                        if clean is not None:
                            index[agent_id] = clean
            cache = {"key": key, "session": session, "index": index, "records": {}, "live": {}, "busy": set()}
            parent._helper_memory = cache
        return lock, cache


def _clean_summary(agent_id, summary) -> dict | None:
    if not isinstance(agent_id, str) or not ID_RE.match(agent_id) or not isinstance(summary, dict):
        return None
    runs = []
    for run in (summary.get("runs") or [])[-MAX_RUNS:]:
        if not isinstance(run, dict):
            continue
        number = run.get("run")
        if not isinstance(number, int) or isinstance(number, bool) or number < 1:
            continue
        by = run.get("by") if run.get("by") in WHO else "model"
        entry = {"run": number, "by": by}
        for key, limit in (("request", MAX_TEXT), ("note", 4_000), ("report", 8_000), ("kept", 4096)):
            if isinstance(run.get(key), str):
                entry[key] = run[key][:limit]
        for key in ("at", "ended_at"):
            if isinstance(run.get(key), (int, float)) and not isinstance(run.get(key), bool):
                entry[key] = float(run[key])
        entry["held"] = run.get("held") is True
        runs.append(entry)
    if not runs:
        return None
    return {"description": str(summary.get("description") or "")[:200], "runs": runs,
            "saved_at": float(summary.get("saved_at") or 0) if isinstance(summary.get("saved_at"), (int, float)) else 0.0}


def _summary_of(record: dict) -> dict:
    return {"description": record.get("description", ""), "runs": list(record.get("runs") or [])[-MAX_RUNS:],
            "saved_at": record.get("saved_at", 0.0)}


def ids(parent) -> set:
    """The helpers of this chat whose conversation is kept (finished runs). Cheap: no disk, no registry."""
    if getattr(parent, "depth", 1) != 0:
        return set()
    lock, cache = _cache(parent)
    with lock:
        return set(cache["index"])


def has_any(parent) -> bool:
    return bool(ids(parent))


def get(parent, agent_id: str) -> dict | None:
    """One helper's whole record (its messages too), or None."""
    agent_id = str(agent_id or "")
    if not ID_RE.match(agent_id):
        return None
    lock, cache = _cache(parent)
    with lock:
        if agent_id not in cache["index"]:
            return None
        record = cache["records"].get(agent_id)
        session = cache["session"]
    if record is not None:
        return record
    if not session:
        return None
    raw = _read(store_dir(session) / f"{agent_id}.json")
    return _valid_record(agent_id, raw)


def _valid_record(agent_id: str, raw) -> dict | None:
    if not isinstance(raw, dict) or raw.get("version") != VERSION or raw.get("id") != agent_id:
        return None
    messages = raw.get("messages")
    if not isinstance(messages, list) or not messages:
        return None
    clean = []
    for message in messages:
        if isinstance(message, dict) and message.get("role") in ("system", "user", "assistant", "tool"):
            clean.append(message)
    if len(clean) < 2:
        return None
    summary = _clean_summary(agent_id, raw)
    if summary is None:
        return None
    record = dict(raw)
    record["messages"] = clean
    record["runs"] = summary["runs"]
    for key in ("description", "agent", "model", "prompt", "copy_root", "state"):
        record[key] = str(raw.get(key) or "")
    return record


def _save(parent, cache: dict, lock: threading.Lock, record: dict) -> None:
    """Keep `record` in this chat's store: on disk beside the session, else in memory."""
    agent_id = record["id"]
    session = cache["session"]
    with lock:
        cache["index"][agent_id] = _summary_of(record)
        while len(cache["index"]) > MAX_HELPERS:
            oldest = min(cache["index"], key=lambda key: cache["index"][key].get("saved_at", 0.0))
            cache["index"].pop(oldest, None)
            cache["records"].pop(oldest, None)
            if session:
                try:
                    (store_dir(session) / f"{oldest}.json").unlink()
                except OSError:
                    pass
        if not session:
            cache["records"][agent_id] = record
        index = {"version": VERSION, "helpers": dict(cache["index"])}
    if session:
        try:
            directory = _ensure_dir(session)
            _write(directory / f"{agent_id}.json", record)
            _write(directory / INDEX, index)
        except OSError:
            # Unwritable storage: the helper stays continuable for as long as this chat is open.
            with lock:
                cache["records"][agent_id] = record


# --------------------------------------------------------------------------------- the messages ---
def _clip_text(text: str, limit: int = MAX_MESSAGE_CHARS) -> str:
    if len(text) <= limit:
        return text
    half = limit // 2
    return text[:half] + f"\n… [{len(text) - limit} characters of this were not kept] …\n" + text[-half:]


def _content(value):
    if isinstance(value, str):
        return _clip_text(value)
    if isinstance(value, list):
        parts = []
        for part in value:
            if not isinstance(part, dict):
                continue
            kind = str(part.get("type") or "")
            if "image" in kind:
                parts.append({"type": "text", "text": IMAGE_NOTE})
            elif isinstance(part.get("text"), str):
                parts.append({**part, "text": _clip_text(part["text"])})
            else:
                parts.append(part)
        return parts
    return value


def sanitize(messages, secrets=()) -> list:
    """A child's messages as they are kept: images out, very long texts bounded, secrets redacted."""
    from .redaction import redact_value
    out = []
    for message in messages or ():
        if not isinstance(message, dict) or message.get("role") not in ("system", "user", "assistant", "tool"):
            continue
        item = {key: (_content(value) if key == "content" else value) for key, value in message.items()}
        out.append(item)
    out = json.loads(json.dumps(out, ensure_ascii=False, default=str))
    return redact_value(out, tuple(secrets)) if secrets else out


def _fit(record: dict) -> dict:
    """Bound one record: the oldest messages after its brief go first (a later repair closes any pair cut)."""
    messages = record["messages"]
    while len(messages) > 4 and len(json.dumps(record, ensure_ascii=False, default=str)) > MAX_RECORD_BYTES:
        head = 2 if messages and messages[0].get("role") == "system" else 1
        del messages[head:head + max(1, (len(messages) - head) // 8)]
    return record


def _remap(messages: list, old_roots, new_root) -> list:
    """Its earlier messages, with the paths of its old copy moved to its new one."""
    from .helper_checkout import map_paths
    roots = [str(root) for root in old_roots if root]
    if not roots or not new_root:
        return messages

    def walk(value):
        if isinstance(value, str):
            return map_paths(value, roots, str(new_root))
        if isinstance(value, list):
            return [walk(item) for item in value]
        if isinstance(value, dict):
            return {key: (value[key] if key.startswith("_") else walk(value[key])) for key in value}
        return value
    return [walk(message) for message in messages]


# --------------------------------------------------------------------- the project, then and now ---
def _digest(state) -> str:
    return hashlib.sha256(f"{state.kind}:{int(state.mode)}:".encode() + state.data).hexdigest()


def project_state(project_root) -> dict | None:
    """What the project held at this moment, for "changed since": its commit and each uncommitted file's content."""
    from .worktree import _checked_target, _dirty_paths, _git, _read_state, repo_root
    root = Path(project_root).resolve(strict=False)
    repo = repo_root(root)
    if repo is None:
        return None
    head = _git(["rev-parse", "HEAD"], repo)
    if head.returncode != 0 or not head.stdout.strip():
        return None
    try:
        rel = root.relative_to(repo)
    except ValueError:
        return None
    commit = head.stdout.strip()
    try:
        dirty = sorted(_dirty_paths(repo, commit, rel))
    except Exception:
        return None
    if len(dirty) > MAX_STATE_FILES:
        return {"head": commit, "project_rel": str(rel), "dirty": {}, "too_many": True, "at": time.time()}
    digests = {}
    for repo_path in dirty:
        try:
            digests[repo_path] = _digest(_read_state(_checked_target(repo, repo_path)))
        except Exception:
            digests[repo_path] = "unreadable"
    return {"head": commit, "project_rel": str(rel), "dirty": digests, "at": time.time()}


def landed_states(workspace, outcome) -> dict:
    """The files a run's integration landed, by repo path, with what each holds now (just after it landed)."""
    from .worktree import _checked_target, _read_state
    if workspace is None:
        return {}
    rel = Path(getattr(workspace, "project_rel", None) or ".")
    repo = Path(getattr(workspace, "repo", ""))
    out = {}
    for shown in list(getattr(outcome, "paths", ()) or ())[:MAX_STATE_FILES]:
        repo_path = (rel / str(shown)).as_posix() if rel != Path(".") else str(shown)
        try:
            out[repo_path] = _digest(_read_state(_checked_target(repo, repo_path)))
        except Exception:
            out[repo_path] = "unreadable"
    return out


def own_dirty(workspace, record: dict) -> frozenset:
    """The uncommitted files of a fresh copy that hold exactly what this helper landed there last: its own work, not
    the user's (a file the user changed since holds something else and stays theirs)."""
    landed = record.get("landed") if isinstance(record.get("landed"), dict) else {}
    if workspace is None or not landed:
        return frozenset()
    baseline = getattr(workspace, "baseline", None) or {}
    return frozenset(path for path in getattr(workspace, "initial_dirty", ()) or ()
                     if path in landed and path in baseline and _digest(baseline[path]) == landed[path])


def view_state(workspace, outcome) -> dict | None:
    """What a helper last saw of the project, for "changed since": its copy's start (the commit and the uncommitted
    files it was given) and the files of its own that landed, as they are now. A change the person made while it
    worked, which it never saw, then counts as changed; so does a file whose work of its was held back."""
    base = str(getattr(workspace, "base_commit", "") or "")
    if workspace is None or not base:
        return None
    rel = Path(getattr(workspace, "project_rel", None) or ".")
    dirty = {}
    for repo_path, state in list((getattr(workspace, "baseline", None) or {}).items())[:MAX_STATE_FILES]:
        dirty[str(repo_path)] = _digest(state)
    dirty.update(landed_states(workspace, outcome))
    return {"head": base, "project_rel": str(rel), "dirty": dirty, "at": time.time()}


def changed_since(project_root, then) -> list[str] | None:
    """The project's files whose content is not what it was at `then`, as project paths; None when it can't tell."""
    from .worktree import _git_bytes, _head_state, repo_root
    if not isinstance(then, dict) or not isinstance(then.get("head"), str) or then.get("too_many"):
        return None
    now = project_state(project_root)
    if now is None or now.get("too_many"):
        return None
    root = Path(project_root).resolve(strict=False)
    repo = repo_root(root)
    if repo is None:
        return None
    rel = Path(now.get("project_rel") or ".")
    before, after = dict(then.get("dirty") or {}), dict(now.get("dirty") or {})
    candidates = set(before) | set(after)
    if then["head"] != now["head"]:
        spec = str(rel) if rel != Path(".") else "."
        listed = _git_bytes(["diff", "--no-ext-diff", "--name-only", "-z", "--no-renames", then["head"], now["head"],
                             "--", spec], repo)
        if listed.returncode != 0:
            return None
        candidates |= {os.fsdecode(name) for name in (listed.stdout or b"").split(b"\0") if name}
    changed = []
    for repo_path in sorted(candidates):
        try:
            was = before.get(repo_path) or _digest(_head_state(repo, then["head"], repo_path))
            is_ = after.get(repo_path) or _digest(_head_state(repo, now["head"], repo_path))
        except Exception:
            was, is_ = "?", "!"
        if was != is_:
            shown = Path(repo_path)
            if rel != Path("."):
                try:
                    shown = shown.relative_to(rel)
                except ValueError:
                    continue
            changed.append(shown.as_posix())
        if len(changed) > MAX_STATE_FILES:
            break
    return changed


def _held_meta(workspace) -> dict | None:
    """The kept worktree of a run whose work was held back, from its retained-task record, or None."""
    path = getattr(workspace, "metadata_path", None)
    if workspace is None or path is None:
        return None
    raw = _read(Path(path), 1024 * 1024)
    if not isinstance(raw, dict):
        return None
    paths = [str(p) for p in (raw.get("repo_changed_paths") or []) if isinstance(p, str)]
    if not paths:
        return None
    return {"worktree": str(raw.get("worktree") or getattr(workspace, "path", "")),
            "branch": str(raw.get("branch") or ""), "base_commit": str(raw.get("base_commit") or ""),
            "project_rel": str(raw.get("project_rel") or "."), "paths": paths[:500],
            "shown": [str(p) for p in (raw.get("changed_paths") or []) if isinstance(p, str)][:500],
            "reason": str(raw.get("reason") or "")[:600]}


def held_diff(held: dict) -> str:
    """Its held-back changes as a unified diff against where its copy started, bounded."""
    from .worktree import _checked_target, _head_state, _read_state
    worktree = Path(str(held.get("worktree") or ""))
    base = str(held.get("base_commit") or "")
    if not worktree.is_dir() or not base:
        return ""
    out, total = [], 0
    for repo_path in list(held.get("paths") or [])[:MAX_HELD_FILES]:
        try:
            old = _head_state(worktree, base, repo_path)
            new = _read_state(_checked_target(worktree, repo_path))
        except Exception:
            continue
        try:
            a = old.data.decode("utf-8").splitlines(keepends=True) if old.kind == "file" else []
            b = new.data.decode("utf-8").splitlines(keepends=True) if new.kind == "file" else []
        except UnicodeDecodeError:
            out.append(f"(binary file {repo_path} changed)\n")
            continue
        text = "".join(difflib.unified_diff(a, b, f"a/{repo_path}", f"b/{repo_path}"))
        if total + len(text) > MAX_HELD_DIFF:
            out.append(f"… (the rest of its changes are in {worktree})\n")
            break
        out.append(text)
        total += len(text)
    return "".join(out)


# ------------------------------------------------------------------------- a run ends: keep it ---
def keep(parent, agent_id: str, child, *, description: str, prompt: str, agent_name: str, workspace,
         outcome) -> str:
    """Keep what a run of one of this chat's helpers left, once it has been integrated (or held back).

    Called after every `task` helper's finalize, foreground or background, and after every continued run. Returns
    the line a foreground result ends with, naming the helper's id for `continue_task` ("" when nothing was kept)."""
    if getattr(parent, "depth", 1) != 0 or child is None or not ID_RE.match(str(agent_id or "")):
        return ""
    messages = list(getattr(child, "messages", None) or [])
    if len(messages) < 2:
        return ""
    try:
        lock, cache = _cache(parent)
        secrets = parent._secret_values() if callable(getattr(parent, "_secret_values", None)) else ()
        from .agent_reports import split_report
        output = str(getattr(outcome, "output", "") or "")
        note, said = split_report(output)
        held = _held_meta(workspace)
        run_info = getattr(child, "_helper_run", None)
        record = get(parent, agent_id) if isinstance(run_info, dict) else None
        if record is None:
            record = {"version": VERSION, "id": agent_id, "description": str(description or "")[:200],
                      "agent": str(agent_name or "")[:80], "prompt": str(prompt or "")[:MAX_PROMPT],
                      "runs": [{"run": 1, "by": "model"}]}
            run_info = None
        runs = record["runs"]
        if run_info is not None:
            runs.append({"run": int(run_info.get("run") or len(runs) + 1), "by": run_info.get("by", "model"),
                         "request": str(run_info.get("request") or "")[:MAX_TEXT],
                         "at": float(run_info.get("at") or time.time())})
        current = runs[-1]
        current.update(ended_at=time.time(), note=note[:4_000], report=said[:8_000], held=bool(held),
                       kept=(held or {}).get("worktree", ""))
        del runs[:-MAX_RUNS]
        record["messages"] = sanitize(messages, secrets if parent.config.get("session_redaction", True) else ())
        record["model"] = str(getattr(getattr(child, "client", None), "model", "") or "")
        record["copy_root"] = str(workspace.project_root) if workspace is not None else ""
        record["held"] = held
        registry = getattr(parent, "subagents", None)
        record["state"] = (registry.state(agent_id) if registry is not None else "") or "finished"
        record["project"] = (view_state(workspace, outcome) if workspace is not None
                             else project_state(parent.config.project_root))
        # What it landed, as it landed, so its next run may change those files again (own_dirty).
        landed = dict(record.get("landed") or {}) if isinstance(record.get("landed"), dict) else {}
        landed.update(landed_states(workspace, outcome))
        record["landed"] = dict(list(landed.items())[-MAX_STATE_FILES:])
        record["saved_at"] = time.time()
        _fit(record)
        _save(parent, cache, lock, record)
        with lock:
            cache["live"].pop(agent_id, None)
            cache["busy"].discard(agent_id)
    except Exception:                                   # noqa: BLE001 -- memory is never worth the helper's result
        try:
            lock, cache = _cache(parent)
            with lock:
                cache["live"].pop(agent_id, None)
                cache["busy"].discard(agent_id)
        except Exception:
            pass
        return ""
    _notify(parent, [agent_id])
    return (f"\n\n(This helper's id is {agent_id}. continue_task gives it more work, with its memory of this run.)")


def release(parent, agent_id: str) -> None:
    """A continuation that never got to run (it was refused or failed to start): the helper is free again."""
    try:
        lock, cache = _cache(parent)
        with lock:
            cache["live"].pop(agent_id, None)
            cache["busy"].discard(agent_id)
    except Exception:
        pass
    _notify(parent, [agent_id])


def _notify(parent, agent_ids) -> None:
    callback = getattr(parent, "on_helper_runs", None)
    if callable(callback):
        try:
            callback(list(agent_ids))
        except Exception:
            pass


# ----------------------------------------------------------------------------- what the map shows ---
def runs_items(parent, only=None) -> list[dict]:
    """agent_runs' items: each of this chat's helpers that can be continued or has been (or is being) continued."""
    registry = getattr(parent, "subagents", None)
    if registry is None or getattr(parent, "depth", 1) != 0:
        return []
    lock, cache = _cache(parent)
    with lock:
        index = {key: dict(value) for key, value in cache["index"].items()}
        live = {key: dict(value) for key, value in cache["live"].items()}
        busy = set(cache["busy"])
    wanted = set(only) if only is not None else set(index) | set(live)
    items = []
    for agent_id in sorted(wanted):
        summary = index.get(agent_id)
        runs = list((summary or {}).get("runs") or [])
        if agent_id in live:
            runs = [*runs, live[agent_id]]
        state = registry.state(agent_id)
        if not runs or not state:
            continue
        continuable = state in ENDED and agent_id not in busy and summary is not None
        history = []
        for run in runs[-MAX_RUNS:]:
            entry = {"run": int(run.get("run") or 1), "by": run.get("by") if run.get("by") in WHO else "model",
                     "held": run.get("held") is True}
            if isinstance(run.get("at"), (int, float)):
                entry["at"] = round(float(run["at"]), 3)
            for key, limit in (("request", WIRE_REQUEST), ("note", WIRE_NOTE), ("report", WIRE_REPORT)):
                text = str(run.get(key) or "")
                if text:
                    entry[key] = text[:limit]
            history.append(entry)
        items.append({"id": agent_id, "runs": max(len(runs), history[-1]["run"] if history else 1),
                      "continuable": bool(continuable), "history": history})
    return items


def terminal_marks(parent) -> dict:
    """What `/agents` adds to a helper's row: "continued · 2 runs", and the id to continue it by ("continue 1a2b3c4d")."""
    try:
        items = runs_items(parent)
    except Exception:                                   # noqa: BLE001 -- a listing, never the chat's work
        return {}
    marks = {}
    for item in items:
        parts = []
        if item["runs"] > 1:
            parts.append(f"continued · {item['runs']} runs")
        if item["continuable"]:
            parts.append(f"continue {item['id'][4:12]}")
        if parts:
            marks[item["id"]] = " · ".join(parts)
    return marks


def find(parent, ident: str) -> str:
    """An id from what a person or a model typed: the whole id, its hex, a unique start of it, or its description."""
    text = str(ident or "").strip()
    known = ids(parent)
    if text in known:
        return text
    hexed = text[4:] if text.startswith("sub-") else text
    if re.fullmatch(r"[0-9a-f]{4,12}", hexed):
        hits = [agent_id for agent_id in known if agent_id[4:].startswith(hexed)]
        if len(hits) == 1:
            return hits[0]
    lowered = " ".join(text.lower().split())
    if lowered:
        lock, cache = _cache(parent)
        with lock:
            named = [agent_id for agent_id, summary in cache["index"].items()
                     if " ".join(str(summary.get("description") or "").lower().split()) == lowered]
        if len(named) == 1:
            return named[0]
    return text


def listing(parent) -> str:
    """The helpers that can be continued now, for a refusal that has to name them."""
    items = [item for item in runs_items(parent) if item["continuable"]]
    if not items:
        return "No helper of this chat can be continued now."
    lock, cache = _cache(parent)
    with lock:
        names = {key: value.get("description", "") for key, value in cache["index"].items()}
    return "Helpers that can be continued: " + "; ".join(
        f"{item['id']} ({names.get(item['id'], '') or 'no description'})" for item in items[:12]) + "."


# --------------------------------------------------------------------------------- continuing ---
def _continued_ui_class():
    from .agent import _SubUI

    class _ContinuedUI(_SubUI):
        """The same helper's UI: its own id, and call ids tagged with the run (`sub-…:r2-call_0`), so a second run's
        steps never land on its first run's cards and its page can draw a divider between them."""

        def __init__(self, parent, label, *, agent_id: str, run: int, **kwargs):
            super().__init__(parent, label, **kwargs)
            self._call_prefix = agent_id
            self._run_tag = f"r{int(run)}-"

        def _call_id(self, call_id):
            return f"{self._call_prefix}:{self._run_tag}{call_id}" if call_id else call_id

    return _ContinuedUI


def note_for(parent, record: dict, *, by: str, text: str, copy_root, changed, held_text: str) -> str:
    """The continuation's message: who asked, where its copy is, what changed since, its held-back work, the request."""
    who = "the user" if by == "you" else "the main agent"
    lines = [f"[Continued — {who} asked you to do more.] You are the same helper as before: everything above is your "
             "earlier work, and that run has ended. This is a new request, in a new run."]
    if copy_root:
        last = str(((record.get("runs") or [{}])[-1]).get("note") or "")
        landed = " (your integrated changes included)" if re.search(r"(?:completed and|partly) integrated", last) else ""
        lines.append(f"Your copy of the project is new: {copy_root}. It holds the project as it is now{landed}. "
                     "Your earlier copy is gone; the paths in your earlier messages were moved to this one.")
    else:
        lines.append("You work in the project folder itself, as before.")
    if changed is None:
        lines.append("DGC can't tell which files of the project changed since you last worked on it.")
    elif changed:
        shown = ", ".join(changed[:MAX_CHANGED_SHOWN])
        more = f" and {len(changed) - MAX_CHANGED_SHOWN} more" if len(changed) > MAX_CHANGED_SHOWN else ""
        lines.append(f"Changed in the project since you last worked on it ({len(changed)} file"
                     f"{'' if len(changed) == 1 else 's'}): {shown}{more}.")
    else:
        lines.append("Nothing in the project changed since you last worked on it.")
    lines.append("Your earlier view of the code may be stale: re-read a file before you edit it.")
    held = record.get("held")
    if isinstance(held, dict) and held.get("paths"):
        names = ", ".join((held.get("shown") or held.get("paths"))[:12])
        lines.append(f"Your earlier changes were NOT applied to the project (held back"
                     f"{': ' + held['reason'] if held.get('reason') else ''}); they are kept for the user to review "
                     f"({names}). This new copy does not have them: redo what is still needed here.")
        if held_text:
            lines.append("What you had changed:\n```diff\n" + held_text.rstrip("\n") + "\n```")
    lines.append("The request:\n" + text)
    return "\n\n".join(lines)


def _check(parent, agent_id: str, text: str) -> dict:
    if getattr(parent, "depth", 1) != 0 or getattr(parent, "stopping", False):
        raise Refused("unavailable", "Only the chat's own helpers can be continued, from the chat.")
    if not isinstance(text, str) or not text.strip():
        raise Refused("invalid_text", "Say what the helper should do now.")
    if len(text) > MAX_TEXT:
        raise Refused("too_large", f"That request is longer than {MAX_TEXT} characters.")
    if getattr(parent, "mode", "default") == "plan":
        raise Refused("plan_mode", "This chat is in Plan mode, where DGC changes nothing. Switch to another mode to "
                                   "continue a helper.")
    registry = getattr(parent, "subagents", None)
    state = registry.state(agent_id) if registry is not None else ""
    if not state:
        raise Refused("unknown_agent", f"This chat has no helper {agent_id}. " + listing(parent))
    if state not in ENDED:
        raise Refused("still_running", f"{agent_id} is still working. Send it a message instead (message_task), or "
                                       "wait for it to finish.")
    lock, cache = _cache(parent)
    with lock:
        if agent_id in cache["busy"]:
            raise Refused("busy", f"{agent_id} is already being continued.")
    if agent_id in (getattr(parent, "_detached_jobs", None) or {}):
        # Its record says it ended, and its changes are being brought in right now.
        raise Refused("still_running", f"{agent_id} is still bringing its changes in. Try again in a moment.")
    record = get(parent, agent_id)
    if record is None:
        raise Refused("not_kept", f"DGC didn't keep {agent_id}'s conversation (a helper of a helper, a run a restart "
                                  "stopped part-way, or one from before DGC kept them), so it can't continue with its "
                                  "memory. Start a new helper instead.")
    return record


def denied_reason(parent, description: str) -> str:
    """A deny rule for Task that would refuse this helper's continuation ("" when none does)."""
    from .permissions import PermissionEngine
    with parent._mode_lock:
        cfg = parent.config
        rules = {action: [*(cfg.permissions.get(action, []) or []),
                          *(getattr(cfg, "session_permissions", {}).get(action, []) or [])]
                 for action in ("allow", "ask", "deny")}
    return PermissionEngine(parent.mode, rules, cfg.project_root).deny_reason("task", {"description": description})


def continue_helper(parent, ident: str, text: str, *, by: str = "model", background: bool = False,
                    call_id: str | None = None) -> str:
    """Give a finished helper of this chat more work, with its memory. Raises Refused.

    `by` "model" is a `continue_task` call inside a turn: in the turn (its result is returned, like `task`'s) unless
    `background`. `by` "you" is the person's request: always in the background, with no turn."""
    agent_id = find(parent, ident)
    record = _check(parent, agent_id, text)
    text = parent._safe_text(text)
    description = record["description"] or agent_id
    if by == "you":
        denied = denied_reason(parent, description)
        if denied:
            raise Refused("denied", f"Your permission rules don't allow it: {denied}.")
    lock, cache = _cache(parent)
    with lock:
        if agent_id in cache["busy"]:
            raise Refused("busy", f"{agent_id} is already being continued.")
        cache["busy"].add(agent_id)
    try:
        return _start(parent, agent_id, record, text, by=by, background=background, call_id=call_id,
                      description=description)
    except BaseException:
        release(parent, agent_id)
        raise


def _start(parent, agent_id, record, text, *, by, background, call_id, description) -> str:
    from .agent import _ChildStop
    from .scheduler import acquire_cancellable, workspace_mutation_lock
    from .ultra import worker_limit
    from .worktree import TaskWorkspace, repo_root
    root = parent.config.project_root
    agent_name = record.get("agent") or ""
    adef = parent.agent_defs.get(agent_name) if agent_name else None
    token = parent.cancelled if by == "model" else threading.Event()
    lease = workspace_mutation_lock(root)
    if not acquire_cancellable(lease, token):
        raise Refused("busy", lease.last_error or "DGC couldn't get the project's write lease to make the helper's copy.")
    workspace, isolation_error = None, ""
    try:
        try:
            configured = str(parent.config.get("subagent_worktree_root", "") or "").strip()
            workspace, isolation_error = TaskWorkspace.prepare(
                root, description or "delegated-work", Path(configured) if configured else None,
                link_paths=parent._subagent_link_paths())
        except Exception as exc:                        # noqa: BLE001 -- said, never thrown
            isolation_error = f"{type(exc).__name__}: {exc}"
    finally:
        lease.release()
    if workspace is None and repo_root(root) is not None:
        raise Refused("unavailable", "DGC couldn't make the helper a fresh copy of the project: "
                                     f"{isolation_error or 'unknown error'}. Nothing was changed.")
    if workspace is not None:
        # Uncommitted files that hold exactly what it landed last are its own work: its next change to them lands
        # like any file's. A file the user changed since is theirs, and keeps the standing rule.
        workspace.own_dirty = own_dirty(workspace, record)
    copy_root = str(workspace.project_root) if workspace is not None else ""
    earlier_held = copy.deepcopy(record.get("held")) if isinstance(record.get("held"), dict) else None
    changed = changed_since(root, record.get("project")) if record.get("project") else None
    held_text = held_diff(record["held"]) if isinstance(record.get("held"), dict) else ""
    prompt = note_for(parent, record, by=by, text=text, copy_root=copy_root, changed=changed, held_text=held_text)
    run = int((record.get("runs") or [{}])[-1].get("run") or len(record.get("runs") or [])) + 1
    at = time.time()
    lock, cache = _cache(parent)
    with lock:
        cache["live"][agent_id] = {"run": run, "by": by, "request": text[:MAX_TEXT], "at": at}

    jobs = getattr(parent, "_detached_jobs", None)
    if jobs is None:
        parent._ensure_detached_state()
        jobs = parent._detached_jobs
    cap = worker_limit(parent.config)
    detach = (by == "you" or bool(background)) and not parent.stopping
    if by == "model" and detach and len(jobs) >= cap:
        detach = False                                 # over the cap, a model's background request runs in the turn
    queued = detach and parent._running_detached_count() >= cap
    own_cancel = threading.Event() if detach else _ChildStop(parent.cancelled)
    sub_ui = _continued_ui_class()(parent.ui, description, agent_id=agent_id, run=run, cancel=own_cancel)
    registry = parent.subagents
    sub_ui._registry = registry
    if not detach:
        parent._foreground_stops()[agent_id] = own_cancel
    turn_hint = getattr(parent.ui, "turn_id", "") if by == "model" else ""
    reopened = registry.reopen(agent_id, background=detach, queued=queued,
                               turn_hint=turn_hint if isinstance(turn_hint, str) else "", run=run, by=by)
    if not reopened:
        parent._foreground_stops().pop(agent_id, None)
        if workspace is not None:
            parent._preserve_task_workspace(workspace, "continuation not started", never_ran=True)
        raise Refused("still_running", f"{agent_id} is not finished.")
    _notify(parent, [agent_id])
    saved = copy.deepcopy(record.get("messages") or [])

    def prepare(sub) -> None:
        body = saved[1:] if saved and saved[0].get("role") == "system" else saved
        body = _remap(body, [record.get("copy_root")], copy_root)
        from .agent import _repair_tool_transcript, _RESUME_COMPACT_RATIO
        sub.messages, _ = _repair_tool_transcript([sub.messages[0], *body])
        sub._helper_run = {"run": run, "by": by, "request": text, "at": at}
        want = str(record.get("model") or "")
        client = getattr(sub, "client", None)
        if want and client is not None and getattr(client, "model", "") != want:
            try:
                pinned = parent._new_client(client.base_url, client.api_key, want,
                                            api_mode=getattr(client, "requested_api_mode", None), source="subagent")
                window = parent._subagent_window(adef)
                if window:
                    pinned.context_size = window
                sub.client = pinned
                registry.running(agent_id, model=want)
            except Exception:                          # noqa: BLE001 -- the model it would get anyway
                pass
        if by == "you":
            sub._budget_turn = -1 - int(agent_id[4:16], 16)   # no turn asked: its own ledger, as a Pip fix's
        try:
            window = sub.context_size()
            if window > 0 and sub.estimate_tokens() >= _RESUME_COMPACT_RATIO * window:
                sub.maybe_compact(force=True, deadline=time.monotonic() + 120, trigger="continue", notify=False)
                sub._helper_run["compacted"] = str((getattr(sub, "_last_compaction", None) or {}).get("status") or "")
        except Exception:                              # noqa: BLE001 -- an uncompacted memory still runs
            pass

    if detach:
        return parent._spawn_detached_subagent(description, prompt, agent_name, workspace, sub_ui, call_id,
                                               own_cancel, queued=queued, prepare_child=prepare, continuing=True)
    handle: dict = {}
    try:
        execution = parent._execute_prepared_subagent(description, prompt, agent_name, workspace, sub_ui, call_id,
                                                      cancel=own_cancel, handle=handle, prepare_child=prepare,
                                                      continuing=True)
    finally:
        parent._foreground_stops().pop(agent_id, None)
    outcome = parent._finalize_subagent(description, workspace, *execution, stopped_by_user=own_cancel.closed)
    parent._last_task_integrated = outcome.integrated
    tail = keep(parent, agent_id, handle.get("agent"), description=description, prompt=record.get("prompt", ""),
                agent_name=agent_name, workspace=workspace, outcome=outcome)
    if not tail:
        release(parent, agent_id)
    kept = earlier_held
    still = (f"\nIts earlier held-back work is still waiting in Review ({kept.get('worktree')}): apply or drop it "
             "there." if kept and Path(str(kept.get("worktree") or "")).exists() else "")
    return outcome.output + still + tail
