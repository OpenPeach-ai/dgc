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
   write) is unchanged: the parent's recovery point records it. DGC's own read and search tools
   read only the helper's copy (`read_refusal`), naming the same file there when the path was the
   user's; a shared folder, a skill's folder and what the helper itself wrote stay readable.
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
            "(DGC's file tools refuse writes into it, and read and search only inside your copy)."
            f"{above} When you finish, DGC brings your changes into the user's checkout itself."]


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


# ------------------------------------------------------------- 2b. the reads ---
#
# A helper read the user's checkout and searched up the tree into other scratch folders, while its
# brief only asked it not to. DGC's own read and search tools now read only the helper's copy; the
# same file in the copy is named when the path was the user's. What stays readable outside it:
#   - a folder the user shared into the copy (subagent_link_paths), by either of its names;
#   - a skill's own folder, since a skill's instructions point at files beside its SKILL.md;
#   - a file the helper itself wrote outside its copy with DGC's file tools (a /tmp script).
# The helper's brief, its memory and its instructions reach it as messages, never as files.
# A shell command (bash, python, a monitor) cannot be fenced: the docs say so.

READ_TOOLS = frozenset({"read_file", "view_image", "glob", "grep", "repo_map", "code_intel",
                        "git_diff"})
# How each tool's refusal says what was not done, and what to do instead.
_READ_WORDS = {"read_file": ("not read", "Read"), "view_image": ("not viewed", "View"),
               "glob": ("not searched", "Search"), "grep": ("not searched", "Search"),
               "repo_map": ("not mapped", "Map"), "code_intel": ("not searched", "Search"),
               "git_diff": ("not read", "Use")}
_MAX_OWN_WRITES = 512


def _copy_forms(agent) -> list[Path]:
    """The helper's own copy: its project folder and, when the project is a folder inside a bigger
    repository, the whole worktree it was given (a sibling package there is in its copy too)."""
    forms = _forms(agent.config.project_root)
    tree = getattr(agent, "_copy_tree", None)
    if tree:
        forms.extend(form for form in _forms(tree) if form not in forms)
    return forms


def _inside(path: Path, forms) -> bool:
    return any(_within(path, form) is not None for form in forms)


def _shared_read(agent, lexical: Path, resolved: Path) -> bool:
    """A read in a folder the user shared into the copy, named through the copy or as theirs."""
    shared = [str(item).strip("/") for item in getattr(agent, "_shared_dirs", ()) or ()]
    shared = [item for item in shared if item]
    if not shared:
        return False
    for form in _forms(agent.config.project_root):
        rel = _within(lexical, form)
        if rel is not None:
            first = rel.as_posix()
            if any(first == item or first.startswith(item + "/") for item in shared):
                return True
    for root in (agent.config.project_root, *theirs(agent)):
        for item in shared:
            folder_forms = _forms(Path(str(root)) / item)
            if _inside(lexical, folder_forms) or _inside(resolved, folder_forms):
                return True
    return False


def _skill_read(agent, resolved: Path) -> bool:
    """A file in the folder of one of the helper's skills, with its links followed."""
    skills = getattr(agent, "skills", None)
    if not isinstance(skills, dict):
        return False
    for skill in skills.values():
        if not getattr(skill, "enabled", True):
            continue
        source = getattr(skill, "path", None)
        if not source:
            continue
        if _inside(resolved, _forms(Path(str(source)).parent)):
            return True
    return False


def _their_places(agent) -> list[tuple[Path, Path, str]]:
    """(a checkout that is not the helper's, the same place in its copy, whose), longest first."""
    roots = theirs(agent)
    own = Path(str(agent.config.project_root))
    tree = Path(str(getattr(agent, "_copy_tree", None) or own))
    trees = tuple(getattr(agent, "_user_trees", ()) or ())
    places: list[tuple[Path, Path, str]] = []
    for group, target in ((roots, own), (trees, tree)):
        for place, root in enumerate(group):
            whose = "user" if place == len(group) - 1 else "helper"
            for form in _forms(root):
                places.append((form, target, whose))
    places.sort(key=lambda item: len(str(item[0])), reverse=True)
    return places


def note_write(agent, path) -> None:
    """A file an isolated helper wrote outside its copy with DGC's file tools stays readable to it."""
    if not theirs(agent) or path in (None, ""):
        return
    try:
        raw = Path(os.path.expanduser(str(path)))
        if not raw.is_absolute():
            raw = Path(str(agent.config.project_root)) / raw
        resolved = raw.resolve(strict=False)
    except (TypeError, ValueError, OSError, RuntimeError):
        return
    if _inside(resolved, _copy_forms(agent)):
        return
    written = agent.__dict__.setdefault("_outside_writes", set())
    if len(written) < _MAX_OWN_WRITES:
        written.add(str(resolved))


def read_refusal(agent, name: str, path) -> str | None:
    """For an isolated helper's read or search with DGC's own tools: the refusal to return, or None
    when it may go on (to the permission check, as before).

    Its own copy is decided on the path with its links followed, so neither `..` nor a link out of
    the copy reads elsewhere. The main chat and a helper without a copy of its own are never
    refused here, and a call without a path reads the copy's root.
    """
    if name not in READ_TOOLS or not theirs(agent) or path is None or str(path) == "":
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
        return None                    # the tool's own check refuses a path it cannot read
    if _inside(resolved, _copy_forms(agent)) or _shared_read(agent, lexical, resolved):
        return None
    done, verb = _READ_WORDS.get(name, ("not read", "Read"))
    for form, target, whose in _their_places(agent):
        for candidate in (resolved, lexical):
            rel = _within(candidate, form)
            if rel is None:
                continue
            mine = target / rel
            place = ("the user's checkout" if whose == "user"
                     else "the copy of the helper that started you")
            if os.path.exists(candidate) and not os.path.exists(mine):
                return (f"error: {done}: {path} is in {place}, outside this helper's own copy, and "
                        f"the copy has no {mine}: a file Git ignores is not copied into it. Work "
                        "from what your copy has; if the task needs that file, say so in your report.")
            return (f"error: {done}: {path} is in {place}. {verb} {mine} instead: this helper "
                    "works in its own copy.")
    # Outside every checkout: a skill's folder, and what the helper wrote there itself. Never a
    # way into a checkout that is not its own, even for a skill kept inside one.
    written = getattr(agent, "_outside_writes", None) or ()
    if _skill_read(agent, resolved) or str(resolved) in written:
        return None
    return (f"error: {done}: {path} is outside this helper's own copy ({own_text}), and a helper "
            "reads only its own copy. If the task needs it, say so in your report.")


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
    # The parent is itself a helper: the checkout that changed is its own disposable copy, and the
    # change goes to the user with the rest of its work. Nothing to record here.
    disposable = bool(theirs(parent))
    record = getattr(keeper, "record_known", None) if not disposable else None
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
        if disposable:
            parts.append(f" {'It is' if len(mine) == 1 else 'They are'} in your own copy now, so "
                         "the change goes to the user with your own when you finish.")
        elif not rest:
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
