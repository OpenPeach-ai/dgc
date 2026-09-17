"""Retry contract the SDK documents and tests. The dgc serve child performs the retries."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RetryPolicy:
    """429 and 5xx are retried by the runtime. Cancel always wins.

    ``max_attempts`` is the number of HTTP tries (first try + retries). The child already
    retries 429/5xx with backoff (see dgc/llm.py). The SDK passes ``model_stall_retries``
    into isolated config and surfaces how many model HTTP posts the mock/endpoint saw
    when tests assert the contract.
    """

    max_attempts: int = 4
    retry_on: tuple[int, ...] = (429, 500, 502, 503, 504)
    backoff_s: float = 0.5

    def isolated_values(self) -> dict[str, int]:
        # stall_retries is "re-issues after a stall"; keep it aligned with extra attempts.
        extra = max(0, int(self.max_attempts) - 1)
        return {"model_stall_retries": extra}
