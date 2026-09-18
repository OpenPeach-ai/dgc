"""Typed failures that happen before a run is accepted, or during transport.

Every exception the SDK raises is a :class:`DGCError`. The vendored transport's own errors
subclass these too, so ``except DGCError`` also catches a failure reached through ``Session.raw``.
"""

from __future__ import annotations


class DGCError(Exception):
    """Base SDK error."""


class DGCConfigError(DGCError, ValueError):
    """Session or client options are invalid."""


class DGCRuntimeError(DGCError):
    """The DGC runtime could not start, handshake, stay alive, or carry out a command."""


class DGCProtocolError(DGCRuntimeError):
    """The runtime speaks a protocol this SDK does not, or broke the one it offered."""


class DGCCommandRejectedError(DGCRuntimeError):
    """The runtime refused a command (``command_rejected``, or an ``error`` naming the request).

    ``reason`` is the runtime's machine-readable code when it sent one (for example
    ``turn_in_progress`` or ``session_unavailable``); ``command`` is the refused command type.
    """

    def __init__(self, message: str, *, reason: str = "", command: str = ""):
        super().__init__(message)
        self.reason = reason
        self.command = command


class DGCTimeoutError(DGCError, TimeoutError):
    """A control request, the runtime handshake, or a wait on a run's result ran out of time.

    A run that hits its own ``timeout`` does not raise: its result has ``status="failed"`` and
    ``reason="timeout"``, and the partial output is kept.
    """


class DGCUnsupportedError(DGCConfigError):
    """A requested capability is not available on this host or runtime."""


def public_error(exc: BaseException, *, context: str = "") -> DGCError:
    """The SDK's own exception for a transport failure, keeping its message and details.

    A transport error already subclasses one of the classes above; this drops the transport
    class (which callers never need to import) while keeping ``reason`` and ``command``.
    ``context`` prefixes the message, for example ``"session setup failed"``.
    """
    message = str(exc) or type(exc).__name__
    if context:
        message = f"{context}: {message}"
    if isinstance(exc, DGCCommandRejectedError):
        return DGCCommandRejectedError(message, reason=exc.reason, command=exc.command)
    for kind in (DGCUnsupportedError, DGCProtocolError, DGCTimeoutError, DGCConfigError):
        if isinstance(exc, kind):
            return kind(message)
    return DGCRuntimeError(message)
