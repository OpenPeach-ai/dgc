"""What the ``dgc serve`` child does when a model request fails. Cancel always wins."""
from __future__ import annotations

from dataclasses import dataclass

from .errors import DGCConfigError, DGCUnsupportedError

#: HTTP statuses the runtime retries on its own. Fixed in CLI 0.41.
RUNTIME_RETRY_STATUSES: tuple[int, ...] = (429, 500, 502, 503, 504)
#: The runtime's first backoff, in seconds; later tries wait this times the attempt number,
#: or the server's Retry-After when it sends one.
RUNTIME_BACKOFF_S = 0.5
_MAX_ATTEMPTS = 11


@dataclass(frozen=True)
class RetryPolicy:
    """Retries the runtime performs for one model request.

    ``max_attempts`` counts sends of a request whose stream *stalls* (no tokens, only
    keep-alives): the first try plus ``max_attempts - 1`` re-issues, 1 to 11. It becomes the
    runtime's ``model_stall_retries``. ``RetryPolicy(max_attempts=1)`` turns stall re-issues off.

    HTTP 408, 429 and 5xx answers and dropped connections are retried by the runtime on a fixed
    schedule: up to 4 tries, waiting 0.5 s times the attempt number or the server's Retry-After.
    CLI 0.41 has no setting for that schedule, so ``retry_on`` and ``backoff_s`` only describe it:
    any value other than the default raises :class:`DGCUnsupportedError` instead of being
    silently ignored. Only failed or stalled model requests are retried, never tool calls.
    """

    max_attempts: int = 4
    retry_on: tuple[int, ...] = RUNTIME_RETRY_STATUSES
    backoff_s: float = RUNTIME_BACKOFF_S

    def __post_init__(self) -> None:
        attempts = self.max_attempts
        if isinstance(attempts, bool) or not isinstance(attempts, int) or not (
                1 <= attempts <= _MAX_ATTEMPTS):
            raise DGCConfigError(f"RetryPolicy.max_attempts must be an integer from 1 to {_MAX_ATTEMPTS}")
        try:
            statuses = tuple(sorted(int(code) for code in self.retry_on))
        except (TypeError, ValueError) as exc:
            raise DGCConfigError("RetryPolicy.retry_on must be a sequence of HTTP status codes") from exc
        if statuses != tuple(sorted(RUNTIME_RETRY_STATUSES)):
            raise DGCUnsupportedError(
                "RetryPolicy.retry_on cannot be changed: the DGC runtime always retries HTTP 408, "
                "429 and 5xx answers up to 4 tries. Leave retry_on at its default.")
        if isinstance(self.backoff_s, bool) or not isinstance(self.backoff_s, (int, float)) or (
                float(self.backoff_s) != RUNTIME_BACKOFF_S):
            raise DGCUnsupportedError(
                "RetryPolicy.backoff_s cannot be changed: the DGC runtime waits 0.5 s times the "
                "attempt number, or the server's Retry-After. Leave backoff_s at its default.")

    def isolated_values(self) -> dict[str, int]:
        """The runtime config this policy sets."""
        return {"model_stall_retries": int(self.max_attempts) - 1}
