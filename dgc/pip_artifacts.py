"""Bounded reviewed text-patch inputs; never applies to a user checkout."""
from __future__ import annotations

import hashlib
import os
import re
import stat
from pathlib import Path

from . import pip_execution as execution
from .workspace_registry import RegistryError

_HASH = re.compile(r"[0-9a-f]{64}")
_RUN = re.compile(r"run_[0-9a-f]{32}")
_HUNK = re.compile(rb"@@ -([0-9]{1,8})(?:,([0-9]{1,8}))? \+([0-9]{1,8})(?:,([0-9]{1,8}))? @@[^\n]*\n")
MAX_LINES = 20000
MAX_SOURCE_LINES = 65536


def _error(message):
    return RegistryError("invalid_patch_artifact", message)


def validate_ref(value, changed_files):
    if (not isinstance(value, dict) or set(value) != {"path", "sha256", "bytes"}
            or value["path"] != "artifacts/changes.patch"
            or not isinstance(value["sha256"], str) or not _HASH.fullmatch(value["sha256"])
            or type(value["bytes"]) is not int or not 1 <= value["bytes"] <= execution.MAX_DIFF_BYTES):
        raise _error("A Patch handoff needs a nonempty bounded changes.patch reference and SHA-256.")
    if (not isinstance(changed_files, list) or not 1 <= len(changed_files) <= execution.MAX_WRITE_PATHS
            or any(not isinstance(path, str) for path in changed_files)):
        raise _error("A Patch artifact must identify one to 32 changed files.")
    paths = [execution._relative(path, "Artifact changed path") for path in changed_files]
    if len(set(paths)) != len(paths) or paths != sorted(paths):
        raise _error("Artifact changed paths must be sorted and unique.")
    return {"path": value["path"], "sha256": value["sha256"], "bytes": value["bytes"]}, paths


def read_patch(registry_directory, run_id, reference, changed_files):
    """Check size and file identity before a bounded read of one private artifact."""
    reference, _ = validate_ref(reference, changed_files)
    if not isinstance(run_id, str) or not _RUN.fullmatch(run_id):
        raise _error("The source Patch run identity is invalid.")
    try:
        root = execution._directory(Path(registry_directory).absolute())
        run = execution._directory(root / "runs" / run_id)
        path = execution._inside(run, "artifacts/changes.patch")
        with os.fdopen(os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)), "rb") as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != reference["bytes"]
                    or (os.name == "posix" and info.st_uid != os.getuid())):
                raise _error("The source Patch artifact is not the reviewed bounded private file.")
            data = stream.read(reference["bytes"] + 1)
            after = os.fstat(stream.fileno())
            if ((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) !=
                    (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)):
                raise _error("The source Patch artifact changed while it was read.")
    except OSError as exc:
        raise _error("The source Patch artifact is missing or cannot be read safely.") from exc
    if not isinstance(data, bytes) or len(data) != reference["bytes"] or hashlib.sha256(data).hexdigest() != reference["sha256"]:
        raise _error("The source Patch artifact no longer matches its approved size and SHA-256.")
    return data


def _read_source(root, path, *, added):
    target = execution._inside(root, path, missing=added)
    if added:
        if target.exists():
            raise _error("An added artifact path already exists in the committed base.")
        return b"", None
    try:
        with os.fdopen(os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)), "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > execution.MAX_FILE_BYTES:
                raise _error("The patch base must be a bounded ordinary file.")
            data = stream.read(info.st_size + 1)
            if len(data) != info.st_size:
                raise _error("The patch base changed while being read.")
    except OSError as exc:
        raise _error("A reviewed changed file is missing from the committed base.") from exc
    if b"\0" in data:
        raise _error("Binary-file artifact transfers are not supported.")
    if data.count(b"\n") > MAX_SOURCE_LINES:
        raise _error("A patch base exceeds the 65,536-line reconstruction budget.")
    return data, info


def _lines(data):
    # Git unified hunks split only on LF; bytes.splitlines also splits form-feed
    # and other legitimate file bytes. Input size/line caps precede allocation.
    parts = data.split(b"\n")
    return [part + b"\n" for part in parts[:-1]] + ([parts[-1]] if parts[-1] else [])


def _plan(root, data, changed_files):
    if (not isinstance(data, bytes) or not 1 <= len(data) <= execution.MAX_DIFF_BYTES
            or not data.endswith(b"\n") or b"\0" in data or data.count(b"\n") > MAX_LINES):
        raise _error("The artifact must be a bounded text diff with at most 20,000 lines.")
    lines = _lines(data)
    # Match exact expected headers instead of interpreting Git's C/octal quoting.
    headers = {}
    for path in changed_files:
        raw = path.encode("utf-8")
        if any(byte in raw for byte in (b'"', b"\t", b"\r", b"\n")):
            raise _error("Quoted or control-character artifact paths are not supported.")
        headers[b"diff --git a/" + raw + b" b/" + raw + b"\n"] = path
    i, plans, observed, planned_bytes = 0, [], set(), 0
    while i < len(lines):
        path = headers.get(lines[i])
        if path is None or path in observed:
            raise _error("The artifact has an unreviewed, quoted, renamed or duplicate file header.")
        observed.add(path)
        i += 1
        added = deleted = False
        while i < len(lines) and not lines[i].startswith(b"--- "):
            line = lines[i]
            if line == b"new file mode 100644\n" and not added and not deleted:
                added = True
            elif line == b"deleted file mode 100644\n" and not added and not deleted:
                deleted = True
            elif not re.fullmatch(rb"index [0-9a-f]{7,64}\.\.[0-9a-f]{7,64}(?: 100644)?\n", line):
                raise _error("Binary patches, renames, copies, mode changes, symlinks and submodules are not supported.")
            i += 1
        raw = path.encode("utf-8")
        expected_old = b"--- " + (b"/dev/null" if added else b"a/" + raw) + b"\n"
        expected_new = b"+++ " + (b"/dev/null" if deleted else b"b/" + raw) + b"\n"
        if (i + 1 >= len(lines) or lines[i] not in (expected_old, expected_old[:-1] + b"\t\n")
                or lines[i + 1] not in (expected_new, expected_new[:-1] + b"\t\n")):
            raise _error("The diff paths do not match the reviewed same-path change.")
        i += 2
        old, info = _read_source(root, path, added=added)
        old_lines, old_cursor, output, output_lines, hunks = _lines(old), 0, bytearray(), 0, 0

        def append(part):
            nonlocal output_lines
            if output and not output.endswith(b"\n"):
                raise _error("A no-newline marker may occur only at the end of the reconstructed file.")
            if len(output) + len(part) > execution.MAX_FILE_BYTES:
                raise _error("A reconstructed file exceeds 4 MiB.")
            output.extend(part)
            output_lines += 1

        while i < len(lines) and not lines[i].startswith(b"diff --git "):
            match = _HUNK.fullmatch(lines[i])
            if not match:
                raise _error("Only exact bounded unified text hunks are supported.")
            start_old, count_old, start_new, count_new = (
                int(match[1]), int(match[2] or b"1"), int(match[3]), int(match[4] or b"1"))
            if max(start_old, count_old, start_new, count_new) > execution.MAX_FILE_BYTES:
                raise _error("Diff line counts exceed the bounded source budget.")
            old_index = start_old - (1 if count_old else 0)
            new_index = start_new - (1 if count_new else 0)
            if old_index < old_cursor or old_index > len(old_lines):
                raise _error("A diff hunk has an invalid or overlapping base position.")
            for part in old_lines[old_cursor:old_index]:
                append(part)
            old_cursor = old_index
            if new_index != output_lines:
                raise _error("The diff's new-file position is inconsistent.")
            i += 1
            seen_old = seen_new = 0
            while seen_old < count_old or seen_new < count_new:
                if i >= len(lines) or lines[i][:1] not in (b" ", b"+", b"-"):
                    raise _error("A diff hunk is truncated or has inconsistent line counts.")
                prefix, part = lines[i][:1], lines[i][1:]
                i += 1
                if i < len(lines) and lines[i] == b"\\ No newline at end of file\n":
                    if not part.endswith(b"\n"):
                        raise _error("The diff's newline marker is invalid.")
                    part = part[:-1]
                    i += 1
                if prefix != b"+":
                    if seen_old >= count_old or old_cursor >= len(old_lines) or old_lines[old_cursor] != part:
                        raise _error("The artifact does not match the exact committed source context.")
                    old_cursor += 1
                    seen_old += 1
                if prefix != b"-":
                    if seen_new >= count_new:
                        raise _error("A diff hunk exceeds its declared new-file count.")
                    append(part)
                    seen_new += 1
            hunks += 1
        for part in old_lines[old_cursor:]:
            append(part)
        if not hunks or (deleted and output) or (not deleted and bytes(output) == old):
            raise _error("The artifact contains no corresponding reviewed content change.")
        planned_bytes += len(output)
        if planned_bytes > execution.MAX_SOURCE_BYTES:
            raise _error("Reconstructed files exceed their 64 MiB aggregate budget.")
        plans.append((path, None if deleted else bytes(output), info))
    if observed != set(changed_files):
        raise _error("The artifact's complete path set differs from the accepted Patch result.")
    return plans


def apply_reviewed_patch(prepared, data, reference, changed_files):
    """Validate every hunk before writing exclusively to this run's private copy."""
    reference, changed_files = validate_ref(reference, changed_files)
    if len(data) != reference["bytes"] or hashlib.sha256(data).hexdigest() != reference["sha256"]:
        raise _error("The artifact differs from the approved input.")
    _, root = execution._prepared(prepared)
    files, total = execution._files(root)
    plans = _plan(root, data, changed_files)
    sizes = {path: size for path, size, _ in files}
    new_total = total + sum((len(content) if content is not None else 0) - sizes.get(path, 0) for path, content, _ in plans)
    entries = set()
    # The committed source has no empty directories. Include every existing and
    # newly needed parent directory before mkdir can allocate filesystem entries.
    for relative in sizes:
        parts = Path(relative).parts
        for index in range(1, len(parts) + 1):
            entries.add("/".join(parts[:index]))
            if len(entries) > execution.MAX_FILES:
                raise _error("The reconstructed source exceeds its entry budget.")
    for relative, content, _ in plans:
        if content is None:
            entries.discard(relative)  # Parent directories remain in the copy.
        else:
            parts = Path(relative).parts
            for index in range(1, len(parts) + 1):
                entries.add("/".join(parts[:index]))
                if len(entries) > execution.MAX_FILES:
                    raise _error("The reconstructed source exceeds its entry budget.")
    if new_total > execution.MAX_SOURCE_BYTES:
        raise _error("The reconstructed source exceeds its aggregate file/byte budget.")
    for relative, content, expected in plans:
        target = execution._inside(root, relative, missing=expected is None)
        if expected is not None:
            actual = target.lstat()
            if (actual.st_dev, actual.st_ino, actual.st_size, actual.st_mtime_ns) != (
                    expected.st_dev, expected.st_ino, expected.st_size, expected.st_mtime_ns):
                raise _error("The private source changed before applying the reviewed artifact.")
        if content is None:
            target.unlink()
            continue
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        flags = os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
        if expected is None:
            flags |= os.O_CREAT | os.O_EXCL
        fd = os.open(target, flags, 0o600)
        with os.fdopen(fd, "wb") as stream:
            info = os.fstat(stream.fileno())
            if expected is not None and (info.st_dev, info.st_ino, info.st_nlink) != (expected.st_dev, expected.st_ino, 1):
                raise _error("The private target changed before the reviewed write.")
            stream.truncate(0)
            stream.write(content)
    execution._files(root)
    # Pulse's own change audit begins at the reconstructed approved input. The
    # source Patch diff remains separately pinned in its immutable handoff.
    execution._git(prepared, "add", "--all", "--force", "--", ".")
    baseline = execution._git(prepared, "write-tree").decode("ascii").strip()
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", baseline):
        raise _error("The reconstructed input tree has an invalid identity.")
    prepared["baseline"] = baseline
    return {"source_sha256": reference["sha256"], "changed_files": list(changed_files), "tree": baseline}
