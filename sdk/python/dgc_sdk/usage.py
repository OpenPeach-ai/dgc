"""Per-run usage records and cost. Prices are embedder-supplied; DGC does not invent tariffs."""
from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping


@dataclass(frozen=True)
class Pricing:
    """USD per 1,000,000 tokens. Both sides optional; missing side counts as 0."""

    input_per_million: float = 0.0
    output_per_million: float = 0.0
    cached_input_per_million: float = 0.0


def cost_usd(input_tokens: int, output_tokens: int, cached_input_tokens: int,
             pricing: Pricing | None) -> float | None:
    if pricing is None:
        return None
    dollars = (
        (max(0, input_tokens) / 1_000_000) * float(pricing.input_per_million)
        + (max(0, output_tokens) / 1_000_000) * float(pricing.output_per_million)
        + (max(0, cached_input_tokens) / 1_000_000) * float(pricing.cached_input_per_million)
    )
    return round(dollars, 8)


def tokens_from_usage_map(usage: Mapping[str, Any]) -> tuple[int, int, int, int]:
    """Return input, output, cached, estimate."""
    def _n(*keys: str) -> int:
        for key in keys:
            value = usage.get(key)
            if isinstance(value, bool):
                continue
            try:
                number = int(value)
            except (TypeError, ValueError):
                continue
            if number >= 0:
                return number
        return 0
    inp = _n("input_tokens", "prompt_tokens")
    out = _n("output_tokens", "completion_tokens")
    cached = _n("cached_input_tokens", "cache_read_input_tokens")
    estimate = _n("token_estimate")
    return inp, out, cached, estimate


class UsageLog:
    """Append-only JSONL under the isolated state_dir. Queryable without dgc serve."""

    def __init__(self, directory: Path):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self.path = self.directory / "usage.jsonl"

    def record(self, row: Mapping[str, Any]) -> None:
        payload = dict(row)
        payload.setdefault("ts", time.time())
        line = json.dumps(payload, ensure_ascii=False, default=str) + "\n"
        with self._lock:
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(line)

    def query(self, *, department: str | None = None, since: float | None = None,
              until: float | None = None) -> dict[str, Any]:
        rows = []
        if self.path.is_file():
            with self.path.open(encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if department and str(row.get("department") or "") != department:
                        continue
                    ts = float(row.get("ts") or 0)
                    if since is not None and ts < since:
                        continue
                    if until is not None and ts > until:
                        continue
                    rows.append(row)
        inp = sum(int(row.get("input_tokens") or 0) for row in rows)
        out = sum(int(row.get("output_tokens") or 0) for row in rows)
        cached = sum(int(row.get("cached_input_tokens") or 0) for row in rows)
        costs = [row.get("cost_usd") for row in rows if isinstance(row.get("cost_usd"), (int, float))]
        return {
            "runs": len(rows),
            "input_tokens": inp,
            "output_tokens": out,
            "cached_input_tokens": cached,
            "cost_usd": round(sum(costs), 8) if costs else None,
            "by_department": _by_department(rows),
            "rows": rows[-500:],
        }


def _by_department(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = str(row.get("department") or "")
        slot = buckets.setdefault(key, {
            "department": key, "runs": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0,
        })
        slot["runs"] += 1
        slot["input_tokens"] += int(row.get("input_tokens") or 0)
        slot["output_tokens"] += int(row.get("output_tokens") or 0)
        if isinstance(row.get("cost_usd"), (int, float)):
            slot["cost_usd"] += float(row["cost_usd"])
    return list(buckets.values())
