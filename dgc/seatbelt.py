"""Seatbelt (``sandbox-exec``) profile text, shared by the shell sandbox and Pips.

Pure string building: no host lookups, no process launches. Callers resolve every path
(Seatbelt matches the real, symlink-free path, so ``/tmp`` rules must also name
``/private/tmp``) and decide which directories are hidden, re-exposed and writable.

Rule order matters. Seatbelt applies the last matching rule, so a profile starts from
``(allow default)``, denies every write, hides the given trees from reads, and only then
re-allows the few paths inside them that the confined command needs.
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable

# Character devices a confined command may write: the null sink, its own standard streams,
# the dtrace helper every process opens at startup, and its own descriptors.
DEVICE_WRITES = ('(literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") '
                 '(literal "/dev/dtracehelper") (subpath "/dev/fd")')


def quote(path: Path | str) -> str:
    """Escape a path for an SBPL string literal."""
    return str(path).replace("\\", "\\\\").replace('"', '\\"')


def subpath(path: Path | str) -> str:
    return f'(subpath "{quote(path)}")'


def profile(*, writable: Iterable[Path | str] = (), hidden: Iterable[Path | str] = (),
            readable: Iterable[Path | str] = (), reachable: Iterable[Path | str] = (),
            network: bool = False, rules: Iterable[str] = ()) -> str:
    """Build a profile.

    ``writable``  trees writable in addition to :data:`DEVICE_WRITES`; everything else is
                  read-only.
    ``hidden``    trees whose contents cannot be read (home folders, state directories).
    ``readable``  trees re-exposed for reading after ``hidden`` (the project inside a home).
    ``reachable`` paths whose ANCESTORS get metadata only: ``stat`` and an existence test,
                  never a listing or contents. A resolver that walks a path component by
                  component (git's ``strbuf_realpath``) stops at the first EPERM, so a
                  re-exposed tree inside a hidden one is unreachable without this.
    ``rules``     extra, already-formed rules appended before the network rule.
    ``network``   ``False`` appends ``(deny network*)``.
    """
    parts = ["(version 1)", "(allow default)", "(deny file-write*)",
             "(allow file-write* " + "".join(subpath(path) + " " for path in writable)
             + DEVICE_WRITES + ")"]
    parts.extend(f"(deny file-read* {subpath(path)})" for path in hidden)
    parts.extend(f"(allow file-read* {subpath(path)})" for path in readable)
    parts.extend("(allow file-read-metadata file-test-existence "
                 f'(path-ancestors "{quote(path)}"))' for path in reachable)
    parts.extend(rules)
    if not network:
        parts.append("(deny network*)")
    return "".join(parts)
