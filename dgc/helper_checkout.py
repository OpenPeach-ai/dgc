"""An isolated helper and the user's own checkout.

A helper (a `task` sub-agent) in a Git project works in its own copy of the project, a Git
worktree (dgc/worktree.py), and its changes reach the user only when DGC integrates that copy.
In a real run that broke three ways at once: the parent's brief named the user's checkout by its
absolute path, the helper edited `billing.py` there, and its report said "completed with no file
changes" because its own copy was untouched. Three layers keep the copy the helper's only place:

1. What DGC hands a helper names its copy (`map_paths`, `hand_to`): every mention of the user's
   checkout root in the brief becomes the copy's root, and the helper's system prompt says where
   its copy is and that the user's checkout is not its to change (`prompt_lines`).
2. DGC's own file tools refuse a write into the user's checkout (`claim`, `refusal`), naming the
   same file in the helper's copy. A write outside every checkout (/tmp, a file the task exists to
   write) is unchanged: the parent's recovery point records it.
3. A shell command cannot be fenced, so when the helper ends DGC compares the user's checkout with
   how it was when the helper started (`watch_end`, from Git's view) and its report names what
   changed (`settle`). Who changed it is read from the clock: each command DGC runs, in any chat
   of this process, leaves a time span (`command_span`). A change inside one of the helper's own
   commands and no other is called the helper's, most likely; anything else is said to be unknown,
   never blamed on the helper. What DGC itself left there (this chat's file tools, an
   integration) is not reported at all.
"""
from __future__ import annotations

import os
import re
import stat
import threading
import time
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

# The tools whose run can write a file anywhere: while one runs, a change to the user's checkout
# may be its doing. Reads, searches and control tools never are.
_WRITERS = frozenset({"bash", "python", "write_file", "edit_file", "multi_edit", "apply_patch",
                      "save_memory", "monitor", "hook", "mcp_call"})
# DGC's own file tools: these take a `path` and are refused into the user's checkout.
FILE_TOOLS = frozenset({"write_file", "edit_file", "multi_edit", "apply_patch"})
# The kernel stamps a write from a coarse clock (a jiffy, a few ms, behind time.time()), so a write
# at the very start of a command can carry a time just before the span began.
_EARLY_S = 0.05
_LATE_S = 0.05
_MAX_SPANS = 8192
_SHOWN = 12


# ---------------------------------------------------------------- 1. the brief ---

def _spellings(root) -> list[str]:
    """The ways a brief may name a folder: as configured, with links resolved, and from ~."""
    out: list[str] = []
    try:
        base = Path(os.path.abspath(os.path.expanduser(str(root))))
    except (TypeError, ValueError, OSError):
        return out
    forms = [base]
    try:
        forms.append(base.resolve(strict=False))
    except (OSError, RuntimeError):
        pass
    for form in forms:
        text = str(form)
        if text not in out and text != os.sep:
            out.append(text)
    home = os.path.expanduser("~")
    if home and home != os.sep:
        for form in list(out):
            if form.startswith(home + os.sep):
                tilde = "~" + form[len(home):]
                if tilde not in out:
                    out.append(tilde)
    return out


# A root counts only as a whole path component: `/a/app` must not match inside `/x/a/app`,
# `/a/app2` or `/a/app.py`, but does match before `/`, the end, a space, a quote, `:` or a
# sentence's last full stop. `file://` in front of it is a URL to the same folder.
_BEFORE = r"(?:(?<![\w.~/-])|(?<=file://))"
_AFTER = r"(?=$|/|[^\w.-]|\.(?![\w-]))"


def map_paths(text: str, theirs, own) -> str:
    """`text` with every mention of a root in `theirs` (as a path prefix) turned into `own`.

    Mentions of `own` itself are left as they are, including when the copy sits inside one of
    those roots, and nothing else in the text changes.
    """
    if not isinstance(text, str) or not text:
        return text
    own_forms = _spellings(own)
    if not own_forms:
        return text
    target = own_forms[0]
    keep = set(own_forms)
    alternatives: list[str] = []
    for root in theirs or ():
        for form in _spellings(root):
            if form not in alternatives:
                alternatives.append(form)
    alternatives = [form for form in alternatives if form not in keep]
    if not alternatives:
        return text
    # Longest first, so a copy inside the user's checkout is matched as the copy.
    names = sorted(set(alternatives) | keep, key=len, reverse=True)
    pattern = re.compile(_BEFORE + "(" + "|".join(re.escape(name) for name in names) + ")" + _AFTER)

    def swap(match: re.Match) -> str:
        found = match.group(1)
        return found if found in keep else target

    return pattern.sub(swap, text)


def theirs(agent) -> tuple:
    """The checkouts this isolated helper must not change: its parent's, then each one above."""
    return tuple(getattr(agent, "_user_checkouts", ()) or ())


def hand_to(child, text: str) -> str:
    """What DGC hands an isolated helper, its own copy named wherever the brief named theirs."""
    roots = theirs(child)
    if not roots:
        return text
    return map_paths(text, roots, child.config.project_root)


def prompt_lines(agent) -> list[str]:
    """The helper's system prompt: where its copy is, and whose checkout is not its to change."""
    roots = theirs(agent)
    if not roots:
        return []
    own = agent.config.project_root
    user = roots[-1]
    others = roots[:-1]
    above = ""
    if others:
        named = ", ".join(str(root) for root in others)
        above = f" Nor are the copies of the helpers that started you ({named})."
    return [f"- This is your own copy of the user's project: {own}. The user's checkout, {user}, "
            "is not yours to change: read, edit, build and test only in your copy, never there "
            f"(DGC's file tools refuse writes into it).{above} When you finish, DGC brings your "
            "changes into the user's checkout itself."]


# ---------------------------------------------------------- 2. the file tools ---

def _within(path: Path, root: Path) -> Path | None:
    """The path below `root`, or None when it is not inside it."""
    try:
        if os.path.commonpath((str(root), str(path))) != str(root):
            return None
        return path.relative_to(root)
    except ValueError:
        return None


def _forms(root) -> list[Path]:
    return [Path(form) for form in _spellings(root) if not form.startswith("~")]


def claim(agent, path) -> tuple[Path, str] | None:
    """For an isolated helper's write: `(the same file in its own copy, whose checkout)` when the
    write aims into a checkout that is not its own, else None.

    Its own copy always wins, so a copy kept inside the user's checkout is still the helper's. A
    path written through a folder the user chose to share into the copy (subagent_link_paths) is
    the user's own choice and stays allowed. Both the path as written (`..` folded) and the path
    with its links followed are checked, so neither a `..` nor a link gets around it.
    """
    roots = theirs(agent)
    if not roots or path is None or str(path) == "":
        return None
    own_text = str(agent.config.project_root)
    try:
        raw = Path(os.path.expanduser(str(path)))
        if not raw.is_absolute():
            raw = Path(own_text) / raw
        lexical = Path(os.path.normpath(str(raw)))
        try:
            resolved = raw.resolve(strict=False)
        except (OSError, RuntimeError):
            resolved = lexical
    except (TypeError, ValueError, OSError):
        return None
    own_forms = _forms(own_text)
    if any(_within(resolved, form) is not None for form in own_forms):
        return None
    for form in own_forms:
        rel = _within(lexical, form)
        if rel is not None:
            shared = [str(item).strip("/") for item in getattr(agent, "_shared_dirs", ()) or ()]
            first = rel.as_posix()
            if any(first == item or first.startswith(item + "/") for item in shared if item):
                return None            # a share the user set up: their copy, by their choice
    for place, root in enumerate(roots):
        for form in sorted(_forms(root), key=lambda item: len(str(item)), reverse=True):
            for candidate in (resolved, lexical):
                rel = _within(candidate, form)
                if rel is not None:
                    whose = "user" if place == len(roots) - 1 else "helper"
                    return Path(own_text) / rel, whose
    return None


def refusal(path, own_path: Path, whose: str) -> str:
    """One plain sentence: not changed, why, and the file to use instead."""
    place = ("the user's checkout" if whose == "user"
             else "the copy of the helper that started you")
    return (f"error: not changed: {path} is in {place}, which is not yours to change; "
            f"make this edit in your own copy instead, at {own_path}.")


# ------------------------------------------------------- 3. who changed what ---

class _Span:
    __slots__ = ("lineage", "start", "end", "ends")

    def __init__(self, lineage: tuple, start: float):
        self.lineage = lineage
        self.start = start
        self.end: float | None = None
        self.ends = None              # a still-running process's end, read when needed

    def until(self, now: float) -> float:
        if self.end is not None:
            return self.end
        if self.ends is not None:
            try:
                value = self.ends()
            except Exception:
                value = None
            if value:
                return float(value)
        return now                    # still running: it covers everything up to now


_SPANS: deque = deque(maxlen=_MAX_SPANS)
_SPANS_LOCK = threading.Lock()


def lineage(agent) -> tuple:
    """Which agent this is, as a path from its chat's lead agent down. A helper's own commands are
    those whose lineage starts with its own; its helpers' commands are its work too."""
    value = getattr(agent, "_command_lineage", None)
    if isinstance(value, tuple) and value:
        return value
    value = (f"agent-{id(agent):x}",)
    try:
        agent._command_lineage = value
    except Exception:
        pass
    return value


def _background_end(agent, since: float):
    """The end of the background shell this call just started, read live from its record."""
    try:
        from .tools import _BG, _BG_LOCK
    except ImportError:
        return None
    owner = getattr(getattr(agent, "ctx", None), "tool_owner", None)
    with _BG_LOCK:
        started = [entry for entry in _BG.values()
                   if entry.get("owner") == owner and float(entry.get("started") or 0) >= since - 0.01]
    if not started:
        return None
    entry = max(started, key=lambda item: float(item.get("started") or 0))
    return lambda: entry.get("finished")


def _monitor_end(agent, since: float):
    hub = getattr(getattr(agent, "ctx", None), "monitors", None) or getattr(agent, "monitors", None)
    try:
        fresh = [monitor for monitor in hub.running() if float(monitor.started_at) >= since - 0.01]
    except Exception:
        return None
    if not fresh:
        return None
    monitor = max(fresh, key=lambda item: float(item.started_at))
    return lambda: (monitor.ended_at or None) if monitor.state == "ended" else None


@contextmanager
def command_span(agent, name: str, args=None):
    """Note when a command that can write files ran, and for which agent. A background shell's or
    a monitor's span lasts as long as its process."""
    name = str(name or "")
    if name not in _WRITERS and not name.startswith("mcp__"):
        yield
        return
    span = _Span(lineage(agent), time.time())
    with _SPANS_LOCK:
        _SPANS.append(span)
    try:
        yield
    finally:
        ends = None
        try:
            if name == "bash" and isinstance(args, dict) and args.get("background"):
                ends = _background_end(agent, span.start)
            elif name == "monitor":
                ends = _monitor_end(agent, span.start)
        except Exception:
            ends = None
        if ends is not None:
            span.ends = ends
        else:
            span.end = time.time()


def _who(changed_at: float | None, own: tuple, now: float) -> str:
    """"helper" when the change happened inside one of this helper's commands and no other's."""
    if changed_at is None:
        return "unknown"
    with _SPANS_LOCK:
        spans = list(_SPANS)
    mine = other = False
    for span in spans:
        if span.start - _EARLY_S <= changed_at <= span.until(now) + _LATE_S:
            if span.lineage[:len(own)] == own:
                mine = True
            else:
                other = True
    return "helper" if mine and not other else "unknown"


@dataclass
class OutsideReport:
    """What changed in the checkout a helper was made from, while it ran."""
    changes: list = field(default_factory=list)     # (SourceChange, "helper" | "unknown")
    error: str = ""


def watch_end(workspace, child) -> None:
    """At a helper's end: compare the checkout it was made from with how it was when it started.

    Kept on the workspace for `settle`, which the parent runs when it integrates. Never raises: a
    check that cannot be made is reported as such.
    """
    scan = getattr(workspace, "source_changes", None)
    if not callable(scan):
        return
    try:
        from .worktree import KeptTaskWorkspace
        if isinstance(workspace, KeptTaskWorkspace):
            return                     # a Pip fix's copy reports through its own card
    except ImportError:
        pass
    try:
        changes = scan()
    except Exception as exc:
        workspace.outside_report = OutsideReport(error=str(exc)[:300] or type(exc).__name__)
        return
    now = time.time()
    own = lineage(child)
    workspace.outside_report = OutsideReport([(change, _who(change.changed_at, own, now))
                                              for change in changes])


def _names(changes) -> str:
    shown = [str(change.display) for change in changes[:_SHOWN]]
    more = len(changes) - len(shown)
    return ", ".join(shown) + (f" (+{more} more)" if more > 0 else "")


def _restore_mode(target: Path, state) -> int:
    """The permission bits to put back: the file's own, when it is still the same kind of file."""
    if state.kind != "file":
        return 0o777 if state.kind == "symlink" else 0
    try:
        info = target.lstat()
    except OSError:
        return state.mode
    if stat.S_ISREG(info.st_mode) and bool(info.st_mode & 0o111) == bool(state.mode & 0o111):
        return stat.S_IMODE(info.st_mode)
    return state.mode


def settle(parent, workspace, keeper) -> str:
    """The sentence a helper's outcome carries about the checkout it was made from ("" when
    nothing changed there), after putting what is exactly known into the recovery point.

    A file whose bytes are what DGC itself last left there (`keeper.left_hash`: one of this chat's
    file tools, or an integration) is DGC's own work and is not reported. A change attributed to
    the helper is put into the recovery point only when its earlier state is exact
    (`exact_start_state`) and no DGC write to it is unaccounted for, since a wrong earlier state
    would make Undo write the wrong bytes.
    """
    report = getattr(workspace, "outside_report", None)
    if report is None:
        return ""
    where = "the user's checkout" if not getattr(parent, "depth", 0) else "your checkout"
    if report.error:
        return (f" DGC could not check {where} for changes made outside the helper's copy: "
                f"{report.error}.")
    from .worktree import _disk_digest
    left = getattr(keeper, "left_hash", None)
    mine, unknown = [], []
    for change, who in report.changes:
        target = Path(workspace.repo) / change.repo_path
        if callable(left) and change.digest is not None:
            try:
                ours = {left(str(target)), left(str(target.resolve(strict=False)))}
            except Exception:
                ours = set()
            if change.digest in ours:
                continue               # DGC left exactly this: this chat's own work, not news
        (mine if who == "helper" else unknown).append(change)
    if not mine and not unknown:
        return ""
    recorded = []
    record = getattr(keeper, "record_known", None)
    for change in mine:
        target = Path(workspace.repo) / change.repo_path
        try:
            state = workspace.exact_start_state(change)
        except Exception:
            state = None
        if state is None or not callable(record):
            continue
        if _disk_digest(target) != change.digest:
            continue                   # it moved again since the check: not what was attributed
        try:
            dgc_left = left(str(target)) if callable(left) else None
        except Exception:
            dgc_left = None
        before_digest = _state_digest(state)
        if dgc_left is not None and dgc_left != before_digest:
            continue                   # DGC wrote it some time; the earlier state may not be the turn's
        try:
            if record(str(target), state.kind, bytes(state.data), _restore_mode(target, state)):
                note = getattr(keeper, "note_written", None)
                if callable(note):
                    note(str(target))
                recorded.append(change)
        except Exception:
            continue
    parts = []
    if mine:
        it = "it" if len(mine) == 1 else "them"
        its = "its" if len(mine) == 1 else "their"
        parts.append(f" While it ran, {_names(mine)} in {where} changed outside its own copy, "
                     f"at a moment one of its own commands was running, so it most likely "
                     f"changed {it} directly.")
        rest = [change for change in mine if change not in recorded]
        if not rest:
            parts.append(f" DGC put {its} earlier state in the recovery point, so Undo takes "
                         "that change back.")
        elif recorded:
            parts.append(f" Undo takes back {_names(recorded)}; DGC doesn't know the earlier "
                         f"state of {_names(rest)} exactly, so no recovery point covers "
                         f"{'it' if len(rest) == 1 else 'them'}.")
        else:
            parts.append(" That change is already in the files, outside the integration, and "
                         "no recovery point covers it.")
    if unknown:
        it = "it" if len(unknown) == 1 else "them"
        also = "also " if mine else ""
        parts.append(f" {_names(unknown)} in {where} {also}changed while it ran; DGC can't tell "
                     f"who changed {it} (the user, this chat or another program), so don't "
                     f"present {it} as this helper's work.")
    parts.append(" Say so in your answer, and suggest the user review those files.")
    return "".join(parts)


def _state_digest(state) -> str:
    import hashlib
    if state.kind == "missing":
        return ""
    return hashlib.sha256(bytes(state.data)).hexdigest()
