"""Owner-facing change summaries/diffs backed by bounded object and no-follow file reads."""
from __future__ import annotations

import difflib
import hashlib
from pathlib import Path

from .git_review import MAX_FILE_BYTES, MAX_FILES, MAX_LINES, Review, _OID
from .workspace import capture_file_state

MAX_DISPLAY_FILES = 500
MAX_DIFF_BYTES = 256 * 1024  # two worst-case JSON-escaped sides fit a 4 MiB protocol frame


def _head(review: Review) -> dict:
    identity = review.git(["rev-parse", "--revs-only", "HEAD"]).decode().strip()
    return review.entries(identity) if _OID.fullmatch(identity) else {}


def _working(review: Review, name: str, old, index):
    if name in review.skip_worktree:
        return index, None, "sparse"
    kind, raw, mode = capture_file_state(review.repo / name, maximum=MAX_FILE_BYTES)
    review.account(raw)
    if kind == "missing":
        return None, b"", kind
    algorithm = "sha256" if any(entry and len(entry[1]) == 64 for entry in (old, index)) else "sha1"
    identity = hashlib.new(algorithm, b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
    git_mode = "120000" if kind == "symlink" else "100755" if mode & 0o111 else "100644"
    return (git_mode, identity), raw, kind


def _counts(before: bytes, after: bytes) -> dict:
    if b"\0" in before or b"\0" in after:
        return {"additions": 0, "deletions": 0, "binary": True, "counted": True}
    left, right = before.splitlines(), after.splitlines()
    if not left or not right:
        return {"additions": len(right), "deletions": len(left), "binary": False, "counted": True}
    if len(left) + len(right) > MAX_LINES:
        return {"additions": 0, "deletions": 0, "binary": False, "counted": False}
    additions = deletions = 0
    for tag, i, j, a, b in difflib.SequenceMatcher(None, left, right, autojunk=True).get_opcodes():
        if tag in ("replace", "delete"):
            deletions += j - i
        if tag in ("replace", "insert"):
            additions += b - a
    return {"additions": additions, "deletions": deletions, "binary": False, "counted": True}


def collect_changes(root: Path, cancel=None, *, deadline=None) -> dict:
    result = {"root": str(root), "files": [], "total": 0, "complete": True, "notices": []}
    review = None
    try:
        # Canonicalize only the approved root (for example macOS /var → /private/var).
        # Child names stay lexical so capture_file_state can reject parent symlinks.
        root = root.resolve()
        review = Review(root, root, cancel, deadline=deadline)
        old, index = _head(review), review.entries()
        untracked = review.git(["ls-files", "--others", "--exclude-standard", "-z", "--", review.scope])
        untracked_names = {review.path(raw) for raw in untracked.rstrip(b"\0").split(b"\0") if raw}
        names = set(index) | set(old) | untracked_names
        if len(names) > MAX_FILES:
            raise ValueError(f"More than {MAX_FILES} entries; use Source Control or inspect a narrower scope.")
        for name in sorted(names):
            review.check()
            before, staged = old.get(name), index.get(name)
            counts = {"additions": 0, "deletions": 0, "binary": False, "counted": False}
            kind, error = "", ""
            try:
                after, raw, kind = _working(review, name, before, staged)
            except (ValueError, OSError) as exc:
                after, raw = None, None
                error = str(exc)[:300]
            if error:
                result["complete"] = False
                if before == staged and name not in untracked_names:
                    # Failed inspection is not evidence that an otherwise unchanged file changed.
                    continue
            # Include staged-only changes even if working bytes were restored to HEAD. Their
            # net line totals may be zero, but the index still contains a real pending change.
            if not error and before == after and before == staged:
                continue
            result["total"] += 1
            if len(result["files"]) >= MAX_DISPLAY_FILES:
                continue
            if not error:
                try:
                    if any(entry and entry[0] in ("160000", "conflict") for entry in (before, staged, after)):
                        error = "Submodule or conflict: inspect in Source Control."
                    else:
                        before_raw = review.blob(before)
                        after_raw = review.blob(after) if raw is None else raw
                        counts = _counts(before_raw, after_raw)
                except (ValueError, OSError) as exc:
                    error = str(exc)[:300]
            relative = (review.repo / name).relative_to(root).as_posix()
            result["files"].append({"path": relative, **counts, "untracked": before is None and staged is None,
                                    "staged": before != staged, "deleted": kind == "missing",
                                    "kind": kind, "error": error})
            if error or not counts["counted"]:
                result["complete"] = False
        if result["total"] > MAX_DISPLAY_FILES:
            result["complete"] = False
            result["notices"].append(f"Showing {MAX_DISPLAY_FILES} of {result['total']} changed files; totals cover displayed files.")
        if not result["complete"]:
            result["notices"].append("Some files or line counts could not be inspected completely. Open Source Control for those entries.")
    except (ValueError, OSError) as exc:
        result["complete"] = False
        result["notices"].append("Changes are incomplete: " + str(exc)[:500])
    return result


def read_change(root: Path, path: str, cancel=None) -> dict:
    """Read a literal current file and its HEAD blob; never follow a worktree symlink."""
    if not isinstance(path, str):
        raise ValueError("Choose a literal file inside the current workspace.")
    relative = Path(path)
    if (not path or len(path) > 4096 or relative.is_absolute()
            or any(part in ("..", ".git") for part in relative.parts) or "\0" in path):
        raise ValueError("Choose a literal file inside the current workspace.")
    root = root.resolve()
    target = root / relative
    # Use the workspace as the Git process cwd even when a selected file's parent was deleted.
    review = Review(root, root, cancel)
    review.scope = target.relative_to(review.repo).as_posix()
    before_map, index = _head(review), review.entries()
    name = review.scope
    before, staged = before_map.get(name), index.get(name)
    after, raw, kind = _working(review, name, before, staged)
    if any(entry and entry[0] in ("160000", "conflict") for entry in (before, staged, after)):
        raise ValueError("Submodule and conflict entries must be inspected in Source Control.")
    before_raw = review.blob(before)
    if before == after and before != staged:
        # A staged-only row still has a useful preview when working bytes match HEAD.
        after, raw, kind = staged, None, "staged"
    after_raw = review.blob(after) if raw is None else raw
    if len(before_raw) > MAX_DIFF_BYTES or len(after_raw) > MAX_DIFF_BYTES:
        raise ValueError("This change is too large for a text preview. Open Source Control or the file.")
    if b"\0" in before_raw or b"\0" in after_raw:
        raise ValueError("Binary changes do not have a text diff to review.")
    if before is None and after is None:
        raise ValueError("This file no longer has a change to preview.")
    before_text, after_text = before_raw.decode(errors="replace"), after_raw.decode(errors="replace")
    if before and before[0] == "120000":
        before_text += "\n"
    if after and after[0] == "120000":
        after_text += "\n"
    return {"root": str(root), "path": path, "before": before_text, "after": after_text, "kind": kind}
