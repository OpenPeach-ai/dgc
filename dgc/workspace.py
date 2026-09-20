"""Canonical workspace-boundary helpers.

Tool arguments are untrusted model output.  Every filesystem consumer resolves through this
module so absolute paths, ``..`` segments, and symlinks cannot silently escape the project.
External access is possible only when the permission layer has explicitly approved it.
"""
from __future__ import annotations

import os
import secrets
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path


class WorkspaceBoundaryError(ValueError):
    """A requested path is outside the active project boundary."""


# Windows reports a file's identity in two widths. ``os.stat``/``os.lstat`` on a *path* return the
# 128-bit NTFS file id and a 64-bit volume serial; ``os.fstat`` on an open *handle* returns the
# 64-bit file index and the 32-bit serial that GetFileInformationByHandle gives. From Python 3.13
# on Windows the two therefore disagree for the same file, and every "did this file change while I
# read it?" check compared one against the other and said yes. Compare what both widths can
# express, keep every other field exact, and on POSIX compare everything exactly.
_WINDOWS_FILE_ID_MASK = (1 << 64) - 1
_WINDOWS_VOLUME_MASK = (1 << 32) - 1
#: Whether identity comparison must tolerate the two widths. True exactly on Windows; a test
#: turns it on elsewhere to prove the comparison is still strict about every other field.
_TOLERATE_ID_WIDTH = os.name == "nt"


@dataclass(frozen=True, eq=False)
class FileVersion:
    """Identity used to reject a stale structured edit at its final commit point."""

    device: int
    inode: int
    file_type: int
    size: int
    modified_ns: int
    changed_ns: int

    _FIELDS = ("device", "inode", "file_type", "size", "modified_ns", "changed_ns")

    def _key(self) -> tuple:
        return (self.file_type, self.size, self.modified_ns, self.changed_ns,
                self.inode & _WINDOWS_FILE_ID_MASK, self.device & _WINDOWS_VOLUME_MASK)

    def __eq__(self, other) -> bool:
        if not isinstance(other, FileVersion):
            return NotImplemented
        if not _TOLERATE_ID_WIDTH:
            return all(getattr(self, name) == getattr(other, name) for name in self._FIELDS)
        return self._key() == other._key()

    def __hash__(self) -> int:
        return hash(self._key())

    def difference(self, other: "FileVersion") -> str:
        """The fields that differ, for an error a reader can act on."""
        if not isinstance(other, FileVersion):
            return "not a file version"
        return ", ".join(f"{name} {getattr(self, name)} != {getattr(other, name)}"
                         for name in self._FIELDS
                         if getattr(self, name) != getattr(other, name)) or "no field differs"


_ANY_VERSION = object()


def _version(info: os.stat_result) -> FileVersion:
    return FileVersion(
        int(info.st_dev), int(info.st_ino), stat.S_IFMT(info.st_mode), int(info.st_size),
        int(getattr(info, "st_mtime_ns", info.st_mtime * 1_000_000_000)),
        int(getattr(info, "st_ctime_ns", info.st_ctime * 1_000_000_000)),
    )


def _windows_long_name(path: Path) -> Path:
    """Expand 8.3 short components (``RUNNER~1``, ``PROGRA~1``) into their real spelling.

    ``GetLongPathNameW`` rewrites the spelling of each component and nothing else: unlike
    ``resolve()`` it does not traverse a symlink or a junction, so the no-follow walk below still
    inspects the real components. Windows hands out short names in ordinary places — ``%TEMP%``
    under a profile whose name is longer than eight characters is one — and DGC compared such a
    path with its own canonical form as text, so every tool refused to touch anything below it.
    """
    try:
        import ctypes
        from ctypes import wintypes
        expand = ctypes.windll.kernel32.GetLongPathNameW       # type: ignore[attr-defined]
    except (ImportError, AttributeError, OSError):             # pragma: no cover - Windows only
        return path
    expand.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    expand.restype = wintypes.DWORD

    def longest(text: str) -> str:
        buffer = ctypes.create_unicode_buffer(32768)
        size = expand(text, buffer, len(buffer))
        return buffer.value if 0 < size < len(buffer) else ""

    # Only a component that actually exists can be expanded, so walk up to the deepest ancestor
    # Windows knows and re-attach the rest exactly as it was spelled.
    tail: list[str] = []
    current = path
    while True:
        expanded = longest(str(current))
        if expanded:
            return Path(expanded).joinpath(*reversed(tail))
        parent = current.parent
        if parent == current:
            return path
        tail.append(current.name)
        current = parent


def windows_canonical_text(value: str) -> str:
    """One spelling per file on Windows: no ``\\\\?\\`` prefix, one separator, no data stream.

    A deny list, a permission rule and a workspace boundary all compare paths. Windows lets the
    same file be spelled several ways, and each alternative spelling was a way past all three:
    ``\\\\?\\C:\\...`` skips the normalisation the rest of the OS applies, ``C:/x`` and ``C:\\x``
    are the same file, and ``secret.txt:hidden`` names an alternate data stream — a second set of
    bytes hanging off a file whose own name looks innocent.

    Parsing is Windows-rules regardless of the host, so this is testable everywhere; only the 8.3
    expansion in :func:`_windows_long_name` needs a real Windows filesystem.
    """
    import ntpath
    text = str(value)
    if text.startswith("\\\\?\\UNC\\"):
        text = "\\\\" + text[8:]
    elif text.startswith("\\\\?\\") or text.startswith("\\\\.\\"):
        text = text[4:]
    text = ntpath.normpath(text)
    head = ntpath.splitdrive(text)[1]
    if ":" in head:
        raise WorkspaceBoundaryError(
            f"an alternate data stream is not a file DGC will open: {value}")
    return text


def _windows_canonical_spelling(path: Path) -> Path:
    """:func:`windows_canonical_text`, then the real component names from the filesystem."""
    return _windows_long_name(Path(windows_canonical_text(str(path))))


def canonicalize_trusted_os_alias(path: Path | str) -> Path:
    """Give one path exactly one spelling, without following anything a repository can change.

    Darwin deliberately exposes roots such as ``/var`` and ``/tmp`` as root-owned links into
    ``/private``.  Treating those stable aliases like repository-controlled links makes otherwise
    canonical tempfile workspaces unusable on macOS.  Only the first component below a
    protected filesystem anchor is eligible; links anywhere below it remain untouched and are
    rejected by the descriptor walk or fallback validation.  On Windows the equivalent job is
    spelling, not links: see :func:`_windows_canonical_spelling`.
    """
    value = Path(path)
    if not value.is_absolute() or "\x00" in str(value):
        raise WorkspaceBoundaryError("a canonical absolute path is required")
    if os.name == "nt":
        return _windows_canonical_spelling(value)
    path = Path(os.path.normpath(str(value)))
    if os.name != "posix" or not path.anchor or len(path.parts) < 2:
        return path
    anchor = Path(path.anchor)
    alias = anchor / path.parts[1]
    try:
        anchor_info = anchor.stat()
        before = alias.lstat()
    except OSError:
        return path
    # A process running the repository must not be able to replace the alias.  POSIX filesystem
    # roots and their compatibility aliases are owned by uid 0, and the root itself is not writable
    # by group/other.  Anything less trusted stays spelled as-is so the normal no-follow walk fails.
    if (not stat.S_ISDIR(anchor_info.st_mode)
            or int(getattr(anchor_info, "st_uid", -1)) != 0
            or stat.S_IMODE(anchor_info.st_mode) & (stat.S_IWGRP | stat.S_IWOTH)
            or not stat.S_ISLNK(before.st_mode)
            or int(getattr(before, "st_uid", -1)) != 0):
        return path
    try:
        link_value = os.readlink(alias)
        after = alias.lstat()
    except OSError:
        return path
    if _version(before) != _version(after):
        raise WorkspaceBoundaryError(f"operating-system path alias changed: {alias}")
    target = Path(link_value)
    if not target.is_absolute():
        target = alias.parent / target
    target = Path(os.path.normpath(str(target)))
    if not target.is_absolute() or not target.parts[1:]:
        return path
    # Do not use resolve() here: a nested target link could be controlled independently of the
    # protected anchor alias.  Walk the literal target and require every intermediate directory to
    # be OS-owned and non-writable by group/other.  The final directory may itself be writable
    # (Darwin's /private/tmp is 01777), because its protected parent prevents replacement of the
    # directory entry; repository-controlled descendants are still checked normally.
    canonical_target = Path(target.anchor)
    for index, part in enumerate(target.parts[1:]):
        candidate = canonical_target / part
        try:
            target_info = candidate.lstat()
        except OSError:
            return path
        if (stat.S_ISLNK(target_info.st_mode) or not stat.S_ISDIR(target_info.st_mode)
                or int(getattr(target_info, "st_uid", -1)) != 0):
            return path
        if (index < len(target.parts[1:]) - 1
                and stat.S_IMODE(target_info.st_mode) & (stat.S_IWGRP | stat.S_IWOTH)):
            return path
        canonical_target = candidate
    suffix = path.parts[2:]
    return canonical_target.joinpath(*suffix)


# Internal compatibility for callers/tests developed while the helper was private.  New consumers
# should use the deliberately narrow public name, which makes clear that this is not a general
# symlink resolver.
_canonicalize_os_alias = canonicalize_trusted_os_alias


def _absolute_frozen(path: Path | str) -> Path:
    """Normalize spelling without following a component that may have changed since approval."""
    value = Path(path)
    if not value.is_absolute() or "\x00" in str(value) or ".." in value.parts:
        raise WorkspaceBoundaryError("a canonical absolute path is required")
    return canonicalize_trusted_os_alias(value)


def _dirfd_supported() -> bool:
    return (os.name == "posix" and bool(getattr(os, "O_DIRECTORY", 0))
            and bool(getattr(os, "O_NOFOLLOW", 0))
            and os.open in getattr(os, "supports_dir_fd", set()))


def _open_parent_fd(path: Path, *, create: bool) -> int:
    """Walk an absolute parent one held directory at a time without following symlinks.

    Holding each directory descriptor while opening the next prevents a repository process from
    redirecting the final read/write through a parent symlink after permission resolution.
    """
    if not _dirfd_supported():
        raise NotImplementedError
    anchor = path.anchor
    if not anchor or path.name in ("", ".", ".."):
        raise WorkspaceBoundaryError("a file or directory below an absolute root is required")
    flags = (os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
             | getattr(os, "O_CLOEXEC", 0))
    current = os.open(anchor, flags)
    try:
        parts = path.parts[1:-1]
        for part in parts:
            if part in ("", ".", "..") or os.sep in part:
                raise WorkspaceBoundaryError("unsafe path component")
            try:
                child = os.open(part, flags, dir_fd=current)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(part, mode=0o755, dir_fd=current)
                child = os.open(part, flags, dir_fd=current)
            info = os.fstat(child)
            if not stat.S_ISDIR(info.st_mode):
                os.close(child)
                raise WorkspaceBoundaryError(f"path parent is not a directory: {part}")
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


# Reparse tags that redirect a name somewhere else. A junction's tag is MOUNT_POINT, which
# S_ISLNK does not flag, so without this a junction swapped in mid-write sends the write outside
# the workspace (critic C6). Other reparse tags — OneDrive placeholders, deduplication — name the
# same file and are left alone.
_IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003
_IO_REPARSE_TAG_SYMLINK = 0xA000000C


def _redirects_elsewhere(info: os.stat_result) -> bool:
    """Whether this directory entry is a Windows junction or symlink to another name."""
    if os.name != "nt":
        return False
    attributes = int(getattr(info, "st_file_attributes", 0) or 0)
    if not attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
        return False
    tag = int(getattr(info, "st_reparse_tag", 0) or 0)
    return tag in (_IO_REPARSE_TAG_MOUNT_POINT, _IO_REPARSE_TAG_SYMLINK)


def _fallback_parent(path: Path, *, create: bool) -> Path:
    """Best-effort non-dirfd validation for platforms without POSIX openat semantics.

    On native Windows this is the only validation available: there is no ``openat``, so the walk
    is check-then-use and the write boundary is best-effort rather than a guarantee. It rejects
    every parent component that is a symlink or a junction, and rejects a parent whose canonical
    form is a different path, which is as far as the platform allows.
    """
    parent = path.parent
    current = Path(parent.anchor)
    for part in parent.parts[1:]:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            if not create:
                raise
            current.mkdir(mode=0o755)
            info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise WorkspaceBoundaryError(f"path parent is not a real directory: {current}")
        if _redirects_elsewhere(info):
            raise WorkspaceBoundaryError(f"path parent is a junction: {current}")
    # Compare canonical forms, not text. resolve() expands Windows 8.3 short names, so a path
    # DGC was handed as C:\Users\RUNNER~1\... used to look like a path that "changed" — which
    # aborted every tool below %TEMP%. canonicalize_trusted_os_alias() now gives both sides the
    # same spelling, so a remaining difference really is a link or a swap.
    resolved = parent.resolve(strict=True)
    if _spelling_key(resolved) != _spelling_key(canonicalize_trusted_os_alias(parent)):
        raise WorkspaceBoundaryError(
            f"path parent changed or contains a symlink: {parent} (canonically {resolved})")
    return parent


def _spelling_key(path: Path | str) -> str:
    """One comparable string per path: case-folded and separator-normalised where the OS is."""
    return os.path.normcase(os.path.normpath(str(path)))


def read_regular_bytes(path: Path | str, *, maximum: int | None = None,
                       missing_ok: bool = False) -> tuple[bytes, FileVersion] | None:
    """Read one frozen canonical regular file without following a late parent/final symlink."""
    target = _absolute_frozen(path)
    if maximum is not None and maximum < 0:
        raise ValueError("maximum must be non-negative")
    if _dirfd_supported():
        try:
            parent_fd = _open_parent_fd(target, create=False)
        except FileNotFoundError:
            if missing_ok:
                return None
            raise
        try:
            flags = (os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
                     | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
            try:
                fd = os.open(target.name, flags, dir_fd=parent_fd)
            except FileNotFoundError:
                if missing_ok:
                    return None
                raise
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode):
                    raise WorkspaceBoundaryError(f"path is not a regular file: {target}")
                if maximum is not None and info.st_size > maximum:
                    raise OSError(f"file exceeds the {maximum}-byte safety limit: {target}")
                chunks: list[bytes] = []
                total = 0
                while maximum is None or total <= maximum:
                    size = 65_536 if maximum is None else min(65_536, maximum + 1 - total)
                    if size <= 0:
                        break
                    chunk = os.read(fd, size)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    total += len(chunk)
                if maximum is not None and total > maximum:
                    raise OSError(f"file grew beyond the {maximum}-byte safety limit: {target}")
                after = _version(os.fstat(fd))
                if after != _version(info):
                    raise WorkspaceBoundaryError(
                        f"file changed while it was being read: {target} "
                        f"({after.difference(_version(info))})")
                return b"".join(chunks), after
            finally:
                os.close(fd)
        finally:
            os.close(parent_fd)

    try:
        before = target.lstat()
    except FileNotFoundError:
        if missing_ok:
            return None
        raise
    if not stat.S_ISREG(before.st_mode) or target.is_symlink():
        raise WorkspaceBoundaryError(f"path is not a regular file: {target}")
    resolved = target.resolve(strict=True)
    if _spelling_key(resolved) != _spelling_key(canonicalize_trusted_os_alias(target)):
        raise WorkspaceBoundaryError(
            f"path changed or contains a symlink: {target} (canonically {resolved})")
    if _redirects_elsewhere(before):
        raise WorkspaceBoundaryError(f"path is a junction: {target}")
    if maximum is not None and before.st_size > maximum:
        raise OSError(f"file exceeds the {maximum}-byte safety limit: {target}")
    with target.open("rb") as handle:
        data = handle.read() if maximum is None else handle.read(maximum + 1)
        opened = os.fstat(handle.fileno())
    after = target.lstat()
    if _version(before) != _version(opened) or _version(after) != _version(opened):
        raise WorkspaceBoundaryError(
            f"file changed while it was being read: {target} "
            f"(open {_version(opened).difference(_version(before))}; "
            f"after {_version(opened).difference(_version(after))})")
    if maximum is not None and len(data) > maximum:
        raise OSError(f"file grew beyond the {maximum}-byte safety limit: {target}")
    return data, _version(opened)


def stat_entry(path: Path | str, *, missing_ok: bool = False) -> os.stat_result | None:
    """Stat one exact directory entry without following its final link or mutable parents."""
    target = _absolute_frozen(path)
    if _dirfd_supported():
        try:
            parent_fd = _open_parent_fd(target, create=False)
        except FileNotFoundError:
            if missing_ok:
                return None
            raise
        try:
            try:
                return os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                if missing_ok:
                    return None
                raise
        finally:
            os.close(parent_fd)

    try:
        _fallback_parent(target, create=False)
        before = target.lstat()
        _fallback_parent(target, create=False)
        after = target.lstat()
    except FileNotFoundError:
        if missing_ok:
            return None
        raise
    if _version(before) != _version(after):
        raise WorkspaceBoundaryError(f"path changed while it was being inspected: {target}")
    return after


def scan_directory_entries(path: Path | str, *, maximum: int = 200_000
                           ) -> tuple[list[tuple[str, os.stat_result]], bool, int]:
    """Return a bounded no-follow snapshot of one exact directory.

    The boolean is true when more entries existed than the caller allowed, and the final integer is
    the number scanned (including entries that vanished before stat). Entry metadata is a discovery
    hint only; callers that open a returned child must use another exact-path primitive.
    """
    target = _absolute_frozen(path)
    if not isinstance(maximum, int) or isinstance(maximum, bool) or maximum < 0:
        raise ValueError("maximum must be a non-negative integer")

    if _dirfd_supported():
        parent_fd = _open_parent_fd(target, create=False)
        directory_fd = -1
        try:
            flags = (os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                     | getattr(os, "O_CLOEXEC", 0))
            directory_fd = os.open(target.name, flags, dir_fd=parent_fd)
            if not stat.S_ISDIR(os.fstat(directory_fd).st_mode):
                raise WorkspaceBoundaryError(f"path is not a directory: {target}")
            rows: list[tuple[str, os.stat_result]] = []
            truncated = False
            seen = 0
            with os.scandir(directory_fd) as entries:
                for entry in entries:
                    if seen >= maximum:
                        truncated = True
                        break
                    seen += 1
                    try:
                        rows.append((entry.name, entry.stat(follow_symlinks=False)))
                    except OSError:
                        continue
            rows.sort(key=lambda item: item[0])
            return rows, truncated, seen
        finally:
            if directory_fd >= 0:
                os.close(directory_fd)
            os.close(parent_fd)

    _fallback_parent(target, create=False)
    before = target.lstat()
    if not stat.S_ISDIR(before.st_mode) or stat.S_ISLNK(before.st_mode):
        raise WorkspaceBoundaryError(f"path is not a directory: {target}")
    rows = []
    truncated = False
    seen = 0
    with os.scandir(target) as entries:
        for entry in entries:
            if seen >= maximum:
                truncated = True
                break
            seen += 1
            try:
                rows.append((entry.name, entry.stat(follow_symlinks=False)))
            except OSError:
                continue
    _fallback_parent(target, create=False)
    after = target.lstat()
    if (_version(before) != _version(after) or not stat.S_ISDIR(after.st_mode)
            or stat.S_ISLNK(after.st_mode)):
        raise WorkspaceBoundaryError(f"directory changed while it was being listed: {target}")
    rows.sort(key=lambda item: item[0])
    return rows, truncated, seen


def list_directory(path: Path | str, *, limit: int = 200) -> list[str]:
    """List one canonical directory through a descriptor that cannot be redirected by a symlink."""
    limit = max(0, int(limit))
    rows, _truncated, _scanned = scan_directory_entries(path, maximum=limit)
    return [name for name, _info in rows]


def create_file_tree(path: Path | str, files: dict[str, bytes], *, marker: str) -> None:
    """Create an exclusive package directory, publishing its discovery marker last.

    The caller bounds and validates the package before this function. Held directory descriptors
    prevent late parent symlinks from redirecting writes. Existing directories are never merged.
    An I/O failure can leave an incomplete directory without its marker; it is never a live package.
    """
    target = _absolute_frozen(path)
    if marker not in files or not files:
        raise ValueError("package requires its discovery marker")
    for name, payload in files.items():
        parts = name.split("/")
        if (not isinstance(payload, bytes) or any(part in ("", ".", "..") for part in parts)
                or "\\" in name or "\x00" in name):
            raise ValueError("invalid package resource")
    ordered = [name for name in files if name != marker] + [marker]
    if not _dirfd_supported():
        _fallback_parent(target, create=True)
        target.mkdir(mode=0o700, exist_ok=False)
        for name in ordered:
            atomic_write_bytes(target / name, files[name], mode=0o600, expected=None)
        return
    parent_fd = _open_parent_fd(target, create=True)
    root_fd = -1
    try:
        os.mkdir(target.name, mode=0o700, dir_fd=parent_fd)
        info = os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False)
        root_fd = os.open(target.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        if _version(os.fstat(root_fd)) != _version(info):
            raise WorkspaceBoundaryError("package directory changed before writing")
        for name in ordered:
            current = os.dup(root_fd)
            try:
                parts = name.split("/")
                for part in parts[:-1]:
                    try:
                        os.mkdir(part, mode=0o700, dir_fd=current)
                    except FileExistsError:
                        pass
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                    os.close(current)
                    current = child
                write_name = (".package-marker-" + secrets.token_hex(16)) if name == marker else parts[-1]
                fd = os.open(write_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=current)
                with os.fdopen(fd, "wb") as handle:
                    handle.write(files[name])
                    handle.flush()
                    os.fsync(handle.fileno())
                if name == marker:
                    # Link is an atomic, exclusive publication of the fully written marker.
                    os.link(write_name, parts[-1], src_dir_fd=current, dst_dir_fd=current,
                            follow_symlinks=False)
                    os.unlink(write_name, dir_fd=current)
                os.fsync(current)
            finally:
                os.close(current)
        current_info = os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False)
        if (current_info.st_dev, current_info.st_ino) != (info.st_dev, info.st_ino):
            raise WorkspaceBoundaryError("package directory moved during installation")
        os.fsync(parent_fd)
    finally:
        if root_fd >= 0:
            os.close(root_fd)
        os.close(parent_fd)


def atomic_write_bytes(path: Path | str, data: bytes, *,
                       expected: FileVersion | None | object = _ANY_VERSION,
                       mode: int | None = None) -> FileVersion:
    """Atomically replace one canonical file without following late symlinks.

    When ``expected`` is a ``FileVersion`` or ``None`` (expected missing), the final commit also
    rejects a file that changed after the caller read it.
    """
    target = _absolute_frozen(path)
    payload = bytes(data)
    if expected is not _ANY_VERSION and expected is not None and not isinstance(expected, FileVersion):
        raise TypeError("expected must be a FileVersion, None, or omitted")
    if mode is not None and (not isinstance(mode, int) or isinstance(mode, bool)
                             or mode < 0 or mode > 0o7777):
        raise ValueError("mode must be an integer between 0 and 0o7777")
    if _dirfd_supported():
        parent_fd = _open_parent_fd(target, create=True)
        temp_name = ""
        try:
            try:
                current_info = os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                current_info = None
            if current_info is not None and not stat.S_ISREG(current_info.st_mode):
                raise WorkspaceBoundaryError(f"write target is not a regular file: {target}")
            current = _version(current_info) if current_info is not None else None
            if expected is not _ANY_VERSION and current != expected:
                raise WorkspaceBoundaryError(f"file changed before the edit could be committed: {target}")
            file_mode = int(mode if mode is not None else
                            (stat.S_IMODE(current_info.st_mode) & 0o777)
                            if current_info is not None else 0o644)
            flags = (os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
                     | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_BINARY", 0))
            for _ in range(128):
                candidate = f".{target.name}.{secrets.token_hex(8)}.tmp"
                try:
                    fd = os.open(candidate, flags, file_mode, dir_fd=parent_fd)
                    temp_name = candidate
                    break
                except FileExistsError:
                    continue
            else:
                raise OSError(f"could not allocate a private temporary file beside {target}")
            try:
                try:
                    os.fchmod(fd, file_mode)
                except (AttributeError, OSError):
                    pass
                with os.fdopen(fd, "wb") as handle:
                    handle.write(payload)
                    handle.flush()
                    try:
                        os.fchmod(handle.fileno(), file_mode)
                    except (AttributeError, OSError):
                        pass
                    os.fsync(handle.fileno())
            except BaseException:
                try:
                    os.close(fd)
                except OSError:
                    pass
                raise
            try:
                before_replace = os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                before_replace = None
            before_version = _version(before_replace) if before_replace is not None else None
            if before_replace is not None and not stat.S_ISREG(before_replace.st_mode):
                raise WorkspaceBoundaryError(f"write target changed type before commit: {target}")
            if before_version != current:
                raise WorkspaceBoundaryError(f"file changed while the edit was being prepared: {target}")
            os.replace(temp_name, target.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            temp_name = ""
            try:
                os.fsync(parent_fd)
            except OSError:
                pass
            return _version(os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False))
        finally:
            if temp_name:
                try:
                    os.unlink(temp_name, dir_fd=parent_fd)
                except FileNotFoundError:
                    pass
            os.close(parent_fd)

    parent = _fallback_parent(target, create=True)
    try:
        current_info = target.lstat()
    except FileNotFoundError:
        current_info = None
    if current_info is not None and (not stat.S_ISREG(current_info.st_mode) or target.is_symlink()):
        raise WorkspaceBoundaryError(f"write target is not a regular file: {target}")
    current = _version(current_info) if current_info is not None else None
    if expected is not _ANY_VERSION and current != expected:
        raise WorkspaceBoundaryError(f"file changed before the edit could be committed: {target}")
    file_mode = int(mode if mode is not None else
                    (stat.S_IMODE(current_info.st_mode) & 0o777)
                    if current_info is not None else 0o644)
    fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=str(parent))
    try:
        try:
            os.fchmod(fd, file_mode)
        except (AttributeError, OSError):
            pass
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            try:
                os.fchmod(handle.fileno(), file_mode)
            except (AttributeError, OSError):
                pass
            os.fsync(handle.fileno())
        _fallback_parent(target, create=False)
        try:
            before_replace = target.lstat()
        except FileNotFoundError:
            before_replace = None
        before_version = _version(before_replace) if before_replace is not None else None
        if (before_replace is not None and
                (not stat.S_ISREG(before_replace.st_mode) or target.is_symlink())):
            raise WorkspaceBoundaryError(f"write target changed type before commit: {target}")
        if before_version != current:
            raise WorkspaceBoundaryError(f"file changed while the edit was being prepared: {target}")
        os.replace(temp_name, target)
        temp_name = ""
        return _version(target.stat())
    finally:
        if temp_name:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass


def capture_file_state(path: Path | str, *, maximum: int | None = None) -> tuple[str, bytes, int]:
    """Capture exact regular-file, symlink, or missing state through a frozen canonical path."""
    target = _absolute_frozen(path)
    if maximum is not None and maximum < 0:
        raise ValueError("maximum must be non-negative")
    if _dirfd_supported():
        try:
            parent_fd = _open_parent_fd(target, create=False)
        except FileNotFoundError:
            return "missing", b"", 0
        try:
            try:
                info = os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                return "missing", b"", 0
            before = _version(info)
            if stat.S_ISLNK(info.st_mode):
                value = os.readlink(target.name, dir_fd=parent_fd)
                after = os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False)
                if _version(after) != before:
                    raise WorkspaceBoundaryError(
                        f"symlink changed while it was being captured: {target}")
                data = os.fsencode(value)
                if maximum is not None and len(data) > maximum:
                    raise OSError(f"file exceeds the {maximum}-byte safety limit: {target}")
                return "symlink", data, 0o777
            if not stat.S_ISREG(info.st_mode):
                raise WorkspaceBoundaryError(f"checkpoint target is not a file or symlink: {target}")
            flags = (os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
                     | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
            fd = os.open(target.name, flags, dir_fd=parent_fd)
            try:
                opened = os.fstat(fd)
                if _version(opened) != before:
                    raise WorkspaceBoundaryError(
                        f"file changed while it was being captured: {target}")
                if maximum is not None and opened.st_size > maximum:
                    raise OSError(f"file exceeds the {maximum}-byte safety limit: {target}")
                chunks: list[bytes] = []
                total = 0
                while maximum is None or total <= maximum:
                    size = 65_536 if maximum is None else min(65_536, maximum + 1 - total)
                    if size <= 0:
                        break
                    chunk = os.read(fd, size)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    total += len(chunk)
                if maximum is not None and total > maximum:
                    raise OSError(f"file grew beyond the {maximum}-byte safety limit: {target}")
                after = os.fstat(fd)
                if _version(after) != before:
                    raise WorkspaceBoundaryError(
                        f"file changed while it was being captured: {target}")
                return "file", b"".join(chunks), stat.S_IMODE(after.st_mode)
            finally:
                os.close(fd)
        finally:
            os.close(parent_fd)

    try:
        _fallback_parent(target, create=False)
        info = target.lstat()
    except FileNotFoundError:
        return "missing", b"", 0
    before = _version(info)
    if stat.S_ISLNK(info.st_mode):
        value = os.readlink(target)
        after = target.lstat()
        if _version(after) != before:
            raise WorkspaceBoundaryError(f"symlink changed while it was being captured: {target}")
        data = os.fsencode(value)
        if maximum is not None and len(data) > maximum:
            raise OSError(f"file exceeds the {maximum}-byte safety limit: {target}")
        return "symlink", data, 0o777
    if not stat.S_ISREG(info.st_mode):
        raise WorkspaceBoundaryError(f"checkpoint target is not a file or symlink: {target}")
    captured = read_regular_bytes(target, maximum=maximum)
    assert captured is not None
    data, version = captured
    if version != before:
        raise WorkspaceBoundaryError(f"file changed while it was being captured: {target}")
    return "file", data, stat.S_IMODE(info.st_mode)


def _entry_version_at(parent_fd: int, name: str) -> tuple[os.stat_result | None, FileVersion | None]:
    try:
        info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None, None
    return info, _version(info)


def restore_file_state(path: Path | str, kind: str, data: bytes = b"", mode: int = 0) -> bool:
    """Atomically restore exact file/symlink/absence state without following late parent links."""
    target = _absolute_frozen(path)
    if kind not in ("missing", "file", "symlink") or not isinstance(data, bytes):
        raise ValueError("invalid file-state snapshot")
    if (not isinstance(mode, int) or isinstance(mode, bool) or mode < 0 or mode > 0o7777
            or (kind == "missing" and data)):
        raise ValueError("invalid file-state mode or missing payload")
    if kind == "file":
        atomic_write_bytes(target, data, mode=mode)
        return True

    if _dirfd_supported():
        try:
            parent_fd = _open_parent_fd(target, create=(kind == "symlink"))
        except FileNotFoundError:
            return kind == "missing"
        temp_name = ""
        try:
            current_info, current = _entry_version_at(parent_fd, target.name)
            if current_info is not None and stat.S_ISDIR(current_info.st_mode):
                return False
            if kind == "missing":
                if current_info is None:
                    return True
                check_info, check = _entry_version_at(parent_fd, target.name)
                if check_info is None or check != current:
                    raise WorkspaceBoundaryError(
                        f"file changed while its missing state was being restored: {target}")
                os.unlink(target.name, dir_fd=parent_fd)
                try:
                    os.fsync(parent_fd)
                except OSError:
                    pass
                return True

            for _ in range(128):
                candidate = f".{target.name}.{secrets.token_hex(8)}.tmp"
                try:
                    os.symlink(os.fsdecode(data), candidate, dir_fd=parent_fd)
                    temp_name = candidate
                    break
                except FileExistsError:
                    continue
            else:
                raise OSError(f"could not allocate a private temporary symlink beside {target}")
            check_info, check = _entry_version_at(parent_fd, target.name)
            if ((check_info is not None and stat.S_ISDIR(check_info.st_mode))
                    or check != current):
                raise WorkspaceBoundaryError(
                    f"file changed while its symlink state was being restored: {target}")
            os.replace(temp_name, target.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            temp_name = ""
            try:
                os.fsync(parent_fd)
            except OSError:
                pass
            return True
        finally:
            if temp_name:
                try:
                    os.unlink(temp_name, dir_fd=parent_fd)
                except FileNotFoundError:
                    pass
            os.close(parent_fd)

    try:
        parent = _fallback_parent(target, create=(kind == "symlink"))
    except FileNotFoundError:
        return kind == "missing"
    try:
        current_info = target.lstat()
    except FileNotFoundError:
        current_info = None
    if current_info is not None and stat.S_ISDIR(current_info.st_mode):
        return False
    current = _version(current_info) if current_info is not None else None
    if kind == "missing":
        if current_info is None:
            return True
        _fallback_parent(target, create=False)
        check = _version(target.lstat())
        if check != current:
            raise WorkspaceBoundaryError(
                f"file changed while its missing state was being restored: {target}")
        target.unlink()
        return True

    temp_name = ""
    try:
        for _ in range(128):
            candidate = str(parent / f".{target.name}.{secrets.token_hex(8)}.tmp")
            try:
                os.symlink(os.fsdecode(data), candidate)
                temp_name = candidate
                break
            except FileExistsError:
                continue
        else:
            raise OSError(f"could not allocate a private temporary symlink beside {target}")
        _fallback_parent(target, create=False)
        try:
            check_info = target.lstat()
        except FileNotFoundError:
            check_info = None
        check = _version(check_info) if check_info is not None else None
        if ((check_info is not None and stat.S_ISDIR(check_info.st_mode)) or check != current):
            raise WorkspaceBoundaryError(
                f"file changed while its symlink state was being restored: {target}")
        os.replace(temp_name, target)
        temp_name = ""
        return True
    finally:
        if temp_name:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass


def canonical_root(root: Path | str) -> Path:
    return Path(root).expanduser().resolve(strict=False)


def canonical_path(path: Path | str, root: Path | str) -> Path:
    """Resolve a model-supplied path, including existing symlink components."""
    raw = str(path)
    if not raw or "\x00" in raw:
        raise WorkspaceBoundaryError("a non-empty path inside the project is required")
    base = canonical_root(root)
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = base / candidate
    return candidate.resolve(strict=False)


def is_within(path: Path | str, root: Path | str) -> bool:
    """True when ``path`` is the root or one of its descendants."""
    target = Path(path).resolve(strict=False)
    base = canonical_root(root)
    try:
        return os.path.commonpath((str(base), str(target))) == str(base)
    except ValueError:  # different Windows drives, or otherwise incomparable paths
        return False


def resolve_path(path: Path | str, root: Path | str, *, allow_external: bool = False) -> Path:
    target = canonical_path(path, root)
    if not allow_external and not is_within(target, root):
        raise WorkspaceBoundaryError(
            f"path is outside the project: {target} (project root: {canonical_root(root)})"
        )
    return target


def relative_rule_value(path: Path | str, root: Path | str) -> str:
    """Stable permission-rule value: project-relative inside, canonical absolute outside."""
    target = canonical_path(path, root)
    base = canonical_root(root)
    if is_within(target, base):
        rel = target.relative_to(base)
        return rel.as_posix() or "."
    return str(target)
