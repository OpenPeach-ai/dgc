"""Typed failures that happen before a run is accepted, or during transport."""

from __future__ import annotations


class DGCError(Exception):
    """Base SDK error."""


class DGCConfigError(DGCError, ValueError):
    """Session or client options are invalid."""


class DGCRuntimeError(DGCError):
    """The DGC child could not start, handshake, or stay alive."""


class DGCProtocolError(DGCRuntimeError):
    """The child spoke an incompatible or corrupt protocol."""


class DGCTimeoutError(DGCError, TimeoutError):
    """A run or event wait exceeded its deadline."""


class DGCUnsupportedError(DGCConfigError):
    """A requested capability is not available on this host or runtime."""
