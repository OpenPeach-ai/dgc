"""Per-run usage records and cost. Prices are embedder-supplied; DGC does not invent tariffs.

Token counts come from the provider usage DGC reports for the session (the ``context`` event's
``input_tokens`` / ``output_tokens`` / ``cached_input_tokens`` totals); a run records the change
across its turns. When the provider reported nothing, the count is ``None`` (unknown), never 0.
``token_estimate`` is DGC's estimate of the conversation's context size, not billed tokens.
"""
from __future__ import annotations

import json
import math
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

USAGE_TOTAL_KEYS = ("input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens",
                    "requests")
MAX_USAGE_LINE_CHARS = 1024 * 1024


@dataclass(frozen=True)
class Pricing:
    """USD per 1,000,000 tokens. Both sides optional; missing side counts as 0.

    ``cached_input_per_million`` prices the part of the input the provider served from its
    cache; left at 0 it is billed at ``input_per_million``.
    """

    input_per_million: float = 0.0
    output_per_million: float = 0.0
    cached_input_per_million: float = 0.0


def cost_usd(input_tokens: int | None, output_tokens: int | None, cached_input_tokens: int | None,
             pricing: Pricing | None) -> float | None:
    """Cost of one usage record, or None without pricing or when the token counts are unknown.

    ``input_tokens`` counts every prompt token, cached ones included (as DGC reports them);
    ``cached_input_tokens`` is the part of it served from a cache, billed at the cached price.
    """
    if pricing is None or input_tokens is None or output_tokens is None:
        return None
    total_in = max(0, input_tokens)
    cached = min(total_in, max(0, cached_input_tokens or 0))
    cached_rate = float(pricing.cached_input_per_million) or float(pricing.input_per_million)
    dollars = (
        ((total_in - cached) / 1_000_000) * float(pricing.input_per_million)
        + (cached / 1_000_000) * cached_rate
        + (max(0, output_tokens) / 1_000_000) * float(pricing.output_per_million)
    )
    return round(dollars, 8)


def _count(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if number >= 0 else None


def tokens_from_usage_map(usage: Mapping[str, Any]) -> tuple[int, int, int, int]:
    """Return input, output, cached, estimate; a missing count reads as 0 (see usage_totals)."""
    def _n(*keys: str) -> int:
        for key in keys:
            number = _count(usage.get(key))
            if number is not None:
                return number
        return 0
    inp = _n("input_tokens", "prompt_tokens")
    out = _n("output_tokens", "completion_tokens")
    cached = _n("cached_input_tokens", "cache_read_input_tokens")
    estimate = _n("token_estimate")
    return inp, out, cached, estimate


def usage_totals(event: Mapping[str, Any]) -> dict[str, int] | None:
    """The cumulative session totals a ``context`` event carries, or None if it has none."""
    totals: dict[str, int] = {}
    for key in USAGE_TOTAL_KEYS:
        number = _count(event.get(key))
        if number is None:
            if key in ("input_tokens", "output_tokens", "requests"):
                return None
            number = 0
        totals[key] = number
    return totals


def usage_delta(before: Mapping[str, int], after: Mapping[str, int]) -> dict[str, int] | None:
    """What one turn added, or None when the totals were reset (a new or resumed session)."""
    delta = {key: int(after.get(key, 0)) - int(before.get(key, 0)) for key in USAGE_TOTAL_KEYS}
    if any(value < 0 for value in delta.values()):
        return None
    return delta


def reported(delta: Mapping[str, int]) -> bool:
    """False when requests were made but the provider reported no token usage for them."""
    if int(delta.get("requests", 0)) <= 0:
        return True
    return bool(int(delta.get("input_tokens", 0)) or int(delta.get("output_tokens", 0)))


class UsageLog:
    """Append-only JSONL under the isolated state_dir. Queryable without dgc serve."""

    def __init__(self, directory: Path):
        from ._state import private_dir
        self.directory = private_dir(Path(directory))
        self._lock = threading.Lock()
        self.path = self.directory / "usage.jsonl"

    def record(self, row: Mapping[str, Any]) -> None:
        from .audit import _open_private_append
        payload = dict(row)
        payload.setdefault("ts", time.time())
        line = json.dumps(payload, ensure_ascii=False, default=str) + "\n"
        with self._lock:
            with _open_private_append(self.path) as handle:
                handle.write(line)

    def query(self, *, department: str | None = None, since: float | None = None,
              until: float | None = None) -> dict[str, Any]:
        """Totals over recorded runs. ``unknown_usage_runs`` counts runs whose provider did not
        report tokens; their tokens and cost are excluded from the sums, not counted as 0."""
        rows = deque(maxlen=500)
        runs = unknown = input_tokens = output_tokens = cached_input_tokens = 0
        total_cost = 0.0
        has_cost = False
        buckets: dict[str, dict[str, Any]] = {}
        if self.path.is_file():
            with self.path.open(encoding="utf-8", errors="replace") as handle:
                while True:
                    line = handle.readline(MAX_USAGE_LINE_CHARS + 1)
                    if not line:
                        break
                    if len(line) > MAX_USAGE_LINE_CHARS:
                        while line and not line.endswith("\n"):
                            line = handle.readline(MAX_USAGE_LINE_CHARS + 1)
                        continue
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except (ValueError, RecursionError):
                        continue
                    if not isinstance(row, dict):
                        continue
                    if department and str(row.get("department") or "") != department:
                        continue
                    try:
                        ts = float(row.get("ts") or 0)
                    except (TypeError, ValueError, OverflowError):
                        continue
                    if not math.isfinite(ts):
                        continue
                    if since is not None and ts < since:
                        continue
                    if until is not None and ts > until:
                        continue
                    runs += 1
                    rows.append(row)
                    key = str(row.get("department") or "")
                    slot = buckets.setdefault(key, {"department": key, "runs": 0,
                        "unknown_usage_runs": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0})
                    slot["runs"] += 1
                    if not _row_known(row):
                        unknown += 1
                        slot["unknown_usage_runs"] += 1
                        continue
                    inp = _count(row.get("input_tokens")) or 0
                    out = _count(row.get("output_tokens")) or 0
                    input_tokens += inp
                    output_tokens += out
                    cached_input_tokens += _count(row.get("cached_input_tokens")) or 0
                    slot["input_tokens"] += inp
                    slot["output_tokens"] += out
                    cost = row.get("cost_usd")
                    if isinstance(cost, (int, float)):
                        try:
                            cost = float(cost)
                        except OverflowError:
                            continue
                        if math.isfinite(cost):
                            total_cost += cost
                            slot["cost_usd"] += cost
                            has_cost = True
        return {
            "runs": runs,
            "unknown_usage_runs": unknown,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cached_input_tokens": cached_input_tokens,
            "cost_usd": round(total_cost, 8) if has_cost else None,
            "by_department": list(buckets.values()),
            "rows": list(rows),
        }


def _row_known(row: Mapping[str, Any]) -> bool:
    return _count(row.get("input_tokens")) is not None and _count(row.get("output_tokens")) is not None
