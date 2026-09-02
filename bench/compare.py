#!/usr/bin/env python3
"""Compare controlled DGC/peer benchmark result files with confidence intervals."""
from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path

REQUIRED_ENGINES = {"dgc", "aider", "codex", "goose", "opencode", "pi"}
REQUIRED_LANGS = {"cpp", "go", "java", "javascript", "python", "rust"}
EXPECTED_PROVIDER_TRANSPORTS = {
    "dgc": "ollama_chat", "goose": "ollama_chat", "codex": "responses",
    "aider": "chat_completions", "opencode": "chat_completions", "pi": "chat_completions",
}
_PROVIDER_TRANSPORTS = frozenset(EXPECTED_PROVIDER_TRANSPORTS.values())
_REQUEST_REASON_LABELS = frozenset({
    "user_turn", "tool_result", "steering", "output_continue", "tool_reissue",
    "todo_gate", "empty_final", "goal_gate", "autonomous_gate", "verifier_evidence", "convergence_nudge",
    "transport_retry", "context_retry", "provider_pause", "fallback", "title", "suggestion",
    "handoff",
    "compaction", "mcp_sampling", "subagent", "unattributed", "other",
})


def wilson(successes: int, total: int, z: float = 1.959963984540054) -> tuple[float, float]:
    if total <= 0:
        return 0.0, 0.0
    p = successes / total
    denominator = 1 + z * z / total
    center = (p + z * z / (2 * total)) / denominator
    margin = z * math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator
    return max(0.0, center - margin), min(1.0, center + margin)


def _timing_value(usage: dict, key: str) -> float | None:
    if key not in usage or usage.get(key) is None:
        return None
    try:
        value = float(usage[key])
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) and value >= 0 else None


def _attributed_usage(value: object) -> dict | None:
    if (not isinstance(value, dict) or int(value.get("requests", 0) or 0) <= 0
            or value.get("synchronized", True) is False):
        return None
    return value


def load(path: Path) -> dict:
    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not record.get("dry_run"):
            records.append(record)
    if not records:
        raise ValueError(f"no scored records in {path}")
    manifest_path = path.with_name(path.name.replace("results-", "manifest-", 1)).with_suffix(".json")
    if not manifest_path.is_file():
        raise ValueError(f"missing run manifest for {path}: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if int(manifest.get("schema_version") or 0) < 3:
        raise ValueError(f"controlled comparison requires a schema-v3 manifest: {manifest_path}")
    record_engines = {str(record.get("engine") or path.stem) for record in records}
    if len(record_engines) != 1:
        raise ValueError(f"mixed engine records in {path}")
    engine = next(iter(record_engines))
    declared_engine = (manifest.get("settings") or {}).get("engine")
    if declared_engine and str(declared_engine) != engine:
        raise ValueError(f"manifest engine {declared_engine!r} does not match {engine!r} in {path}")
    task_rows = [(str(record.get("lang")), str(record.get("ex"))) for record in records]
    tasks = set(task_rows)
    if len(tasks) != len(task_rows):
        seen: set[tuple[str, str]] = set()
        duplicate = ("", "")
        for task in task_rows:
            if task in seen:
                duplicate = task
                break
            seen.add(task)
        label = re.sub(r"[\x00-\x1f\x7f]", "?", f"{duplicate[0]}/{duplicate[1]}")[:80]
        raise ValueError(f"duplicate scored task in {path}: {label}")
    p1 = sum(bool(r.get("solved") and r.get("solved_round") == 1) for r in records)
    p2 = sum(bool(r.get("solved")) for r in records)
    rounds = [rd for r in records for rd in (r.get("rounds") or [])]
    timeouts = sum(bool((rd.get("agent") or rd.get("dgc") or {}).get("timeout")) for rd in rounds)
    agent_s = sum(float((rd.get("agent") or rd.get("dgc") or {}).get("time") or 0) for rd in rounds)
    edit_fails = sum(int((rd.get("stats") or {}).get("edit_fails") or 0) for rd in rounds)
    usages = [((rd.get("agent") or rd.get("dgc") or {}).get("usage")) for rd in rounds]
    attributed_usages = [usage for value in usages
                         if (usage := _attributed_usage(value)) is not None]
    usage_rounds = len(attributed_usages)
    input_tokens = sum(int(usage.get("input_tokens", 0) or 0) for usage in attributed_usages)
    output_tokens = sum(int(usage.get("output_tokens", 0) or 0) for usage in attributed_usages)
    reasoning_tokens = sum(int(usage.get("reasoning_tokens", 0) or 0)
                           for usage in attributed_usages)
    provider_requests = sum(
        max(0, int(usage.get("requests", 0) or 0))
        for usage in attributed_usages)
    provider_transports: dict[str, int] = {}
    for usage in attributed_usages:
        values = usage.get("provider_transports")
        if not isinstance(values, dict):
            continue
        for name in sorted(values):
            if name not in _PROVIDER_TRANSPORTS:
                continue
            provider_transports[name] = provider_transports.get(name, 0) + max(
                0, int(values.get(name, 0) or 0))
    provider_timings = []
    for usage in attributed_usages:
        values = tuple(_timing_value(usage, key) for key in
                       ("provider_duration_s", "provider_wall_s", "provider_max_duration_s"))
        if all(value is not None for value in values):
            provider_timings.append(values)
    provider_timing_rounds = len(provider_timings)
    provider_duration_s = sum(values[0] for values in provider_timings)
    provider_wall_s = sum(values[1] for values in provider_timings)
    provider_max_duration_s = max((values[2] for values in provider_timings), default=0.0)
    stats = [(rd.get("stats") or {}) for rd in rounds]
    builtin_timing_rounds = sum("builtin_tool_us" in item for item in stats)
    builtin_tool_s = sum(max(0, int(item.get("builtin_tool_us", 0) or 0))
                         for item in stats) / 1_000_000
    builtin_tool_samples = sum(max(0, int(item.get("builtin_tool_samples", 0) or 0))
                               for item in stats)
    by_tool_us: dict[str, int] = {}
    by_tool_samples: dict[str, int] = {}
    by_request_reason: dict[str, int] = {}
    for item in stats:
        for source_key, target in (("by_tool_us", by_tool_us),
                                   ("by_tool_samples", by_tool_samples),
                                   ("by_request_reason", by_request_reason)):
            if source_key == "by_request_reason" and engine != "dgc":
                continue
            values = item.get(source_key) if isinstance(item.get(source_key), dict) else {}
            valid_names = [str(name) for name in sorted(values)
                           if re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", str(name))
                           and (source_key != "by_request_reason"
                                or str(name) in _REQUEST_REASON_LABELS)][:64]
            for name in valid_names:
                amount = values.get(name, 0)
                target[name] = target.get(name, 0) + max(0, int(amount or 0))
    errors = sum(bool(r.get("error")) for r in records)
    return {"path": path, "manifest": manifest, "engine": engine, "records": records,
            "tasks": tasks, "n": len(records),
            "p1": p1, "p2": p2, "timeouts": timeouts, "agent_s": agent_s,
            "edit_fails": edit_fails, "errors": errors, "usage_rounds": usage_rounds,
            "rounds": len(rounds), "input_tokens": input_tokens,
            "output_tokens": output_tokens, "reasoning_tokens": reasoning_tokens,
            "provider_timing_rounds": provider_timing_rounds,
            "provider_duration_s": provider_duration_s, "provider_wall_s": provider_wall_s,
            "provider_max_duration_s": provider_max_duration_s,
            "provider_requests": provider_requests, "provider_transports": provider_transports,
            "builtin_timing_rounds": builtin_timing_rounds,
            "builtin_tool_s": builtin_tool_s, "builtin_tool_samples": builtin_tool_samples,
            "by_tool_us": by_tool_us, "by_tool_samples": by_tool_samples,
            "by_request_reason": by_request_reason}


def efficiency_metrics(run: dict) -> dict[str, float | None]:
    """Derive honest per-task/generation metrics only from complete attribution.

    ``provider_wall_s`` is the union of active provider-request intervals, so subtracting it from
    agent wall time exposes time spent in the harness, tools, approvals, and gaps between generations.
    It deliberately does not pretend to assign that remainder to any one subsystem.
    """
    tasks = max(0, int(run.get("n") or 0))
    rounds = max(0, int(run.get("rounds") or 0))
    usage_complete = rounds > 0 and int(run.get("usage_rounds") or 0) == rounds
    timing_complete = rounds > 0 and int(run.get("provider_timing_rounds") or 0) == rounds
    requests = max(0, int(run.get("provider_requests") or 0))

    def per_task(key: str) -> float | None:
        return float(run.get(key) or 0) / tasks if usage_complete and tasks else None

    outside_provider_s = max(
        0.0, float(run.get("agent_s") or 0) - float(run.get("provider_wall_s") or 0))
    return {
        "provider_requests_per_task": requests / tasks if usage_complete and tasks else None,
        "input_tokens_per_task": per_task("input_tokens"),
        "output_tokens_per_task": per_task("output_tokens"),
        "output_tokens_per_request": (
            float(run.get("output_tokens") or 0) / requests
            if usage_complete and requests else None),
        "agent_s_per_request": (
            float(run.get("agent_s") or 0) / requests
            if usage_complete and requests else None),
        "provider_wall_s_per_request": (
            float(run.get("provider_wall_s") or 0) / requests
            if timing_complete and requests else None),
        "outside_provider_s_per_task": (
            outside_provider_s / tasks if timing_complete and tasks else None),
    }


def task_metrics(engine: str, record: dict) -> dict:
    """Return a trace-free, per-task diagnostic row with fail-closed attribution."""
    rounds = list(record.get("rounds") or [])
    agents = [(rd.get("agent") or rd.get("dgc") or {}) for rd in rounds]
    usages = [_attributed_usage(agent.get("usage")) for agent in agents]
    usage_complete = bool(rounds) and all(usage is not None for usage in usages)
    complete_usages = [usage for usage in usages if usage is not None]
    provider_requests = (sum(max(0, int(usage.get("requests", 0) or 0))
                             for usage in complete_usages)
                         if usage_complete else None)

    def token_total(key: str) -> int | None:
        return (sum(max(0, int(usage.get(key, 0) or 0)) for usage in complete_usages)
                if usage_complete else None)

    timing_rows = [tuple(_timing_value(usage, key) for key in
                         ("provider_duration_s", "provider_wall_s", "provider_max_duration_s"))
                   for usage in complete_usages]
    attributed_timings = [row for row in timing_rows
                          if all(value is not None for value in row)]
    timing_complete = usage_complete and len(attributed_timings) == len(rounds)
    provider_duration_s = (sum(row[0] for row in attributed_timings)
                           if timing_complete else None)
    provider_wall_s = (sum(row[1] for row in attributed_timings)
                       if timing_complete else None)
    provider_max_duration_s = (max((row[2] for row in attributed_timings), default=0.0)
                               if timing_complete else None)
    agent_s = sum(float(agent.get("time") or 0) for agent in agents)

    transport_complete = (usage_complete
                          and all(isinstance(usage.get("provider_transports"), dict)
                                  for usage in complete_usages))
    transports: dict[str, int] | None = {} if transport_complete else None
    if transports is not None:
        for usage in complete_usages:
            values = usage.get("provider_transports")
            if not isinstance(values, dict):
                continue
            for name in sorted(values):
                if name in _PROVIDER_TRANSPORTS:
                    transports[name] = transports.get(name, 0) + max(
                        0, int(values.get(name, 0) or 0))
        if sum(transports.values()) != provider_requests:
            transports = None

    stats = [rd.get("stats") if isinstance(rd.get("stats"), dict) else None for rd in rounds]

    def stat_total(key: str) -> int | None:
        return (sum(max(0, int(item.get(key, 0) or 0)) for item in stats if item is not None)
                if rounds and all(item is not None and key in item for item in stats) else None)

    def stat_map_total(key: str) -> dict[str, int] | None:
        if not rounds or not all(
                item is not None and isinstance(item.get(key), dict) for item in stats):
            return None
        total: dict[str, int] = {}
        names = sorted({str(name) for item in stats if item is not None
                        for name in item[key]
                        if re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", str(name))
                        and (key != "by_request_reason"
                             or str(name) in _REQUEST_REASON_LABELS)})[:64]
        for name in names:
            total[name] = sum(max(0, int(item[key].get(name, 0) or 0))
                              for item in stats if item is not None)
        return total

    builtin_us = stat_total("builtin_tool_us")
    output_tokens = token_total("output_tokens")
    solved_round = record.get("solved_round")
    return {
        "engine": str(engine), "lang": str(record.get("lang") or ""),
        "exercise": str(record.get("ex") or ""),
        "solved": bool(record.get("solved")),
        "solved_round": int(solved_round) if isinstance(solved_round, int) else None,
        "rounds": len(rounds), "timeout_rounds": sum(bool(agent.get("timeout")) for agent in agents),
        "error": bool(record.get("error")), "agent_s": agent_s,
        "usage_rounds": len(complete_usages),
        "provider_requests": provider_requests,
        "input_tokens": token_total("input_tokens"), "output_tokens": output_tokens,
        "reasoning_tokens": token_total("reasoning_tokens"),
        "output_tokens_per_request": (
            output_tokens / provider_requests
            if output_tokens is not None and provider_requests else None),
        "provider_timing_rounds": len(attributed_timings),
        "provider_duration_s": provider_duration_s, "provider_wall_s": provider_wall_s,
        "provider_max_duration_s": provider_max_duration_s,
        "outside_provider_s": (max(0.0, agent_s - provider_wall_s)
                               if provider_wall_s is not None else None),
        "provider_transports": transports,
        "tool_calls": stat_total("tool_calls"), "edits": stat_total("edits"),
        "edit_fails": stat_total("edit_fails"),
        "builtin_tool_s": builtin_us / 1_000_000 if builtin_us is not None else None,
        "builtin_tool_samples": stat_total("builtin_tool_samples"),
        "by_request_reason": (stat_map_total("by_request_reason")
                              if engine == "dgc" else None),
    }


def task_outliers(runs: list[dict], limit: int) -> list[dict]:
    """Select a bounded union of the slowest and highest-request tasks per engine."""
    limit = max(0, min(20, int(limit)))
    if limit == 0:
        return []
    selected: list[dict] = []
    for run in sorted(runs, key=lambda item: str(item.get("engine") or "")):
        rows = [task_metrics(str(run.get("engine") or ""), record)
                for record in run.get("records") or []]
        signals: dict[tuple[str, str], set[str]] = {}
        by_key = {(row["lang"], row["exercise"]): row for row in rows}
        slow_rows = sorted(
            rows, key=lambda item: (-item["agent_s"], item["lang"], item["exercise"]))[:limit]
        for row in slow_rows:
            signals.setdefault((row["lang"], row["exercise"]), set()).add("slow")
        request_rows = [row for row in rows if row["provider_requests"] is not None]
        request_rows = sorted(request_rows, key=lambda item: (
            -item["provider_requests"], -item["agent_s"],
            item["lang"], item["exercise"]))[:limit]
        for row in request_rows:
            signals.setdefault((row["lang"], row["exercise"]), set()).add("requests")
        for key in sorted(signals, key=lambda item: (
                -by_key[item]["timeout_rounds"],
                -(by_key[item]["provider_requests"] or 0), -by_key[item]["agent_s"], item)):
            selected.append(dict(by_key[key], signals=sorted(signals[key])))
    return selected


def paired_task_deltas(runs: list[dict], baseline_engine: str = "dgc") -> list[dict]:
    """Join exact task identities and compute baseline-minus-peer diagnostic deltas."""
    rows_by_engine: dict[str, dict[tuple[str, str], dict]] = {}
    for run in runs:
        engine = str(run.get("engine") or "")
        rows_by_engine[engine] = {
            (row["lang"], row["exercise"]): row
            for row in (task_metrics(engine, record) for record in run.get("records") or [])}
    baseline = rows_by_engine.get(str(baseline_engine))
    if not baseline:
        return []

    deltas: list[dict] = []
    for peer_engine in sorted(engine for engine in rows_by_engine if engine != baseline_engine):
        peer = rows_by_engine[peer_engine]
        for key in sorted(set(baseline) & set(peer)):
            base_row, peer_row = baseline[key], peer[key]

            def delta(field: str) -> float | int | None:
                left, right = base_row.get(field), peer_row.get(field)
                return left - right if left is not None and right is not None else None

            base_solved, peer_solved = base_row["solved"], peer_row["solved"]
            quality = ("both" if base_solved and peer_solved else
                       "baseline_only" if base_solved else
                       "peer_only" if peer_solved else "neither")
            base_result = (f"p{base_row['solved_round']}"
                           if base_row["solved_round"] else "fail")
            peer_result = (f"p{peer_row['solved_round']}"
                           if peer_row["solved_round"] else "fail")
            base_quality = (2 if base_row["solved_round"] == 1 else
                            1 if base_solved else 0)
            peer_quality = (2 if peer_row["solved_round"] == 1 else
                            1 if peer_solved else 0)
            deltas.append({
                "baseline_engine": str(baseline_engine), "peer_engine": peer_engine,
                "lang": key[0], "exercise": key[1], "quality": quality,
                "baseline_result": base_result, "peer_result": peer_result,
                "quality_tier_delta": base_quality - peer_quality,
                "baseline_solved": base_solved, "peer_solved": peer_solved,
                "baseline_solved_round": base_row["solved_round"],
                "peer_solved_round": peer_row["solved_round"],
                "p1_delta": (int(base_row["solved_round"] == 1)
                             - int(peer_row["solved_round"] == 1)),
                "p2_delta": int(base_solved) - int(peer_solved),
                "agent_s_delta": delta("agent_s"),
                "provider_requests_delta": delta("provider_requests"),
                "input_tokens_delta": delta("input_tokens"),
                "output_tokens_delta": delta("output_tokens"),
                "outside_provider_s_delta": delta("outside_provider_s"),
                "timeout_rounds_delta": delta("timeout_rounds"),
                "tool_calls_delta": delta("tool_calls"), "edits_delta": delta("edits"),
                "edit_fails_delta": delta("edit_fails"),
            })
    return deltas


def paired_summaries(deltas: list[dict]) -> list[dict]:
    """Aggregate task-paired quality and efficiency without filling missing attribution."""
    summaries: list[dict] = []
    peers = sorted({(row["baseline_engine"], row["peer_engine"]) for row in deltas})
    for baseline_engine, peer_engine in peers:
        rows = [row for row in deltas
                if row["baseline_engine"] == baseline_engine and row["peer_engine"] == peer_engine]
        request_rows = [row for row in rows if row["provider_requests_delta"] is not None]
        output_rows = [row for row in rows if row["output_tokens_delta"] is not None]
        outside_rows = [row for row in rows if row["outside_provider_s_delta"] is not None]
        summaries.append({
            "baseline_engine": baseline_engine, "peer_engine": peer_engine,
            "tasks": len(rows),
            "baseline_p1": sum(row["baseline_solved_round"] == 1 for row in rows),
            "peer_p1": sum(row["peer_solved_round"] == 1 for row in rows),
            "baseline_p2": sum(row["baseline_solved"] for row in rows),
            "peer_p2": sum(row["peer_solved"] for row in rows),
            "baseline_only_solved": sum(row["quality"] == "baseline_only" for row in rows),
            "peer_only_solved": sum(row["quality"] == "peer_only" for row in rows),
            "both_solved": sum(row["quality"] == "both" for row in rows),
            "neither_solved": sum(row["quality"] == "neither" for row in rows),
            "baseline_quality_wins": sum(row["quality_tier_delta"] > 0 for row in rows),
            "peer_quality_wins": sum(row["quality_tier_delta"] < 0 for row in rows),
            "equal_quality": sum(row["quality_tier_delta"] == 0 for row in rows),
            "agent_s_delta": sum(row["agent_s_delta"] for row in rows),
            "request_paired_tasks": len(request_rows),
            "provider_requests_delta": (sum(row["provider_requests_delta"] for row in request_rows)
                                        if request_rows else None),
            "output_paired_tasks": len(output_rows),
            "output_tokens_delta": (sum(row["output_tokens_delta"] for row in output_rows)
                                    if output_rows else None),
            "outside_provider_paired_tasks": len(outside_rows),
            "outside_provider_s_delta": (
                sum(row["outside_provider_s_delta"] for row in outside_rows)
                if outside_rows else None),
            "timeout_rounds_delta": sum(row["timeout_rounds_delta"] for row in rows),
        })
    return summaries


def paired_regressions(deltas: list[dict], limit: int) -> list[dict]:
    """Select a bounded union of baseline quality, latency, and request regressions per peer."""
    limit = max(0, min(20, int(limit)))
    if limit == 0:
        return []
    selected: list[dict] = []
    peers = sorted({row["peer_engine"] for row in deltas})
    for peer in peers:
        rows = [row for row in deltas if row["peer_engine"] == peer]
        by_key = {(row["lang"], row["exercise"]): row for row in rows}
        signals: dict[tuple[str, str], set[str]] = {}
        quality_rows = sorted(
            (row for row in rows if row["quality_tier_delta"] < 0),
            key=lambda row: (row["quality_tier_delta"], row["lang"], row["exercise"]))[:limit]
        for row in quality_rows:
            signals.setdefault((row["lang"], row["exercise"]), set()).add("quality")
        comparable_rows = [row for row in rows
                           if row["quality_tier_delta"] == 0 and row["baseline_solved"]]
        slow_rows = sorted(
            (row for row in comparable_rows if row["agent_s_delta"] > 0),
            key=lambda row: (-row["agent_s_delta"], row["lang"], row["exercise"]))[:limit]
        for row in slow_rows:
            signals.setdefault((row["lang"], row["exercise"]), set()).add("slow")
        request_rows = sorted(
            (row for row in comparable_rows
             if row["provider_requests_delta"] is not None
             and row["provider_requests_delta"] > 0),
            key=lambda row: (-row["provider_requests_delta"],
                             -row["agent_s_delta"], row["lang"], row["exercise"]))[:limit]
        for row in request_rows:
            signals.setdefault((row["lang"], row["exercise"]), set()).add("requests")
        for key in sorted(signals, key=lambda item: (
                "quality" not in signals[item],
                -(by_key[item]["provider_requests_delta"] or 0),
                -by_key[item]["agent_s_delta"], item)):
            selected.append(dict(by_key[key], signals=sorted(signals[key])))
    return selected


def publication_errors(runs: list[dict]) -> list[str]:
    """Return every reason a league is unsuitable for a public frontier claim."""
    errors: list[str] = []
    actual_engines = {run.get("engine") for run in runs}
    if len(runs) != len(REQUIRED_ENGINES) or actual_engines != REQUIRED_ENGINES:
        errors.append("publishable league requires exactly: " + ", ".join(sorted(REQUIRED_ENGINES)))
        return errors
    for run in runs:
        manifest = run["manifest"]
        settings = manifest.get("settings") or {}
        preflight_tasks = (manifest.get("preflight") or {}).get("tasks") or {}
        missing = []
        if not settings.get("model_digest"):
            missing.append("model digest")
        if not (manifest.get("environment") or {}).get("hardware_label"):
            missing.append("hardware label")
        if settings.get("thinking") != "transport-reasoning-off":
            missing.append("transport reasoning normalization")
        if settings.get("usage_source") != "provider-proxy":
            missing.append("provider-side usage")
        context_preflight = (manifest.get("preflight") or {}).get("provider_context") or {}
        try:
            context_tokens = int(settings.get("context_tokens") or 0)
            requested_context = int(context_preflight.get("requested_context") or 0)
            configured_context = int(context_preflight.get("configured_context") or 0)
        except (TypeError, ValueError, OverflowError):
            context_tokens = requested_context = configured_context = 0
        if (settings.get("context_policy") != "baked-model-alias+native-proxy"
                or context_tokens < 2_048
                or context_preflight.get("status") != "pass"
                or requested_context != context_tokens
                or configured_context != context_tokens):
            missing.append("verified shared provider context")
        expected_transport = EXPECTED_PROVIDER_TRANSPORTS[run["engine"]]
        if manifest.get("provider_transport") != expected_transport:
            missing.append(f"declared {expected_transport} provider transport")
        observed_transports = run.get("provider_transports") or {}
        if (set(observed_transports) != {expected_transport}
                or sum(observed_transports.values()) != int(run.get("provider_requests") or 0)):
            missing.append(f"observed {expected_transport} provider transport")
        if (not manifest.get("runner", {}).get("commit")
                or manifest.get("runner", {}).get("dirty") is not False):
            missing.append("clean runner revision")
        if (not manifest.get("dataset", {}).get("commit")
                or manifest.get("dataset", {}).get("dirty") is not False):
            missing.append("clean dataset revision")
        if (set(settings.get("langs") or []) != REQUIRED_LANGS
                or int(settings.get("limit") or 0) != 0 or settings.get("exercises")
                or int(settings.get("rounds") or 0) != 2
                or sum(int(value) for value in preflight_tasks.values()) != 225):
            missing.append("complete two-round 225-task corpus")
        if missing:
            errors.append(f"{run['engine']} is not publishable: " + ", ".join(missing))
    return errors


def main() -> None:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("results", nargs="+", type=Path)
    parser.add_argument("--json", type=Path, help="also write the comparison as JSON")
    parser.add_argument("--allow-partial", action="store_true",
                        help="allow incomplete task sets (never use for published claims)")
    parser.add_argument("--top-tasks", type=int, default=0, metavar="N",
                        help="show the N slowest and highest-request tasks per engine (0-20)")
    parser.add_argument("--baseline-engine", default="dgc", metavar="ENGINE",
                        help="engine used for paired task deltas (default: dgc)")
    args = parser.parse_args()
    if not 0 <= args.top_tasks <= 20:
        parser.error("--top-tasks must be between 0 and 20")
    runs = [load(path) for path in args.results]
    if not args.allow_partial:
        problems = publication_errors(runs)
        if problems:
            parser.error("; ".join(problems))
    baseline = runs[0]["tasks"]
    mismatches = [r for r in runs[1:] if r["tasks"] != baseline]
    if mismatches:
        details = ", ".join(f"{r['engine']}={len(r['tasks'])}" for r in mismatches)
        parser.error(f"task sets differ from {runs[0]['engine']}={len(baseline)}: {details}")
    for run in runs:
        settings = run["manifest"]["settings"]
        selected = settings.get("exercises") or ""
        expected = (len([x for x in selected.split(",") if x.strip()])
                    if selected else sum(min(int(settings.get("limit") or count), count)
                                         for count in run["manifest"]["preflight"]["tasks"].values()))
        if not args.allow_partial and run["n"] != expected:
            parser.error(f"{run['engine']} is incomplete: {run['n']}/{expected} tasks")
        if not args.allow_partial and run["usage_rounds"] != run["rounds"]:
            parser.error(f"{run['engine']} lacks provider usage for "
                         f"{run['rounds'] - run['usage_rounds']}/{run['rounds']} rounds")

    def comparable(manifest: dict) -> dict:
        settings = dict(manifest["settings"])
        settings.pop("engine", None)
        environment = manifest.get("environment") or {}
        return {"settings": settings, "runner": manifest.get("runner"),
                "dataset": manifest.get("dataset"),
                "hardware": {k: environment.get(k) for k in
                             ("machine", "cpu_count", "memory_bytes", "hardware_label", "accelerator")}}

    reference = comparable(runs[0]["manifest"])
    incompatible = [run["engine"] for run in runs[1:] if comparable(run["manifest"]) != reference]
    if incompatible:
        parser.error("run provenance/settings differ for: " + ", ".join(incompatible))

    print(f"{'engine':12s} {'n':>4} {'pass@1 (95% CI)':>24} {'pass@2 (95% CI)':>24} "
          f"{'avg_s':>8} {'prov_s':>8} {'other_s':>8} {'tool_s':>8} {'req/t':>6} "
          f"{'avg_in':>9} {'avg_out':>9} {'out/req':>8} {'t/o':>5} {'errors':>7} "
          f"{'editfail':>9}")
    comparison = []
    for run in sorted(runs, key=lambda r: (-r["p2"], r["agent_s"], r["engine"])):
        lo1, hi1 = wilson(run["p1"], run["n"])
        lo2, hi2 = wilson(run["p2"], run["n"])
        avg = run["agent_s"] / run["n"]
        efficiency = efficiency_metrics(run)
        avg_in = (str(round(efficiency["input_tokens_per_task"]))
                  if efficiency["input_tokens_per_task"] is not None else "?")
        avg_out = (str(round(efficiency["output_tokens_per_task"]))
                   if efficiency["output_tokens_per_task"] is not None else "?")
        avg_requests = (f"{efficiency['provider_requests_per_task']:.1f}"
                        if efficiency["provider_requests_per_task"] is not None else "?")
        output_per_request = (str(round(efficiency["output_tokens_per_request"]))
                              if efficiency["output_tokens_per_request"] is not None else "?")
        avg_provider = (f"{run['provider_wall_s'] / run['n']:.1f}"
                        if run["provider_timing_rounds"] == run["rounds"] else "?")
        avg_outside_provider = (f"{efficiency['outside_provider_s_per_task']:.1f}"
                                if efficiency["outside_provider_s_per_task"] is not None else "?")
        avg_tool = (f"{run['builtin_tool_s'] / run['n']:.1f}"
                    if run["builtin_timing_rounds"] == run["rounds"] else "?")
        print(f"{run['engine']:12s} {run['n']:4d} "
              f"{100*run['p1']/run['n']:5.1f}% [{100*lo1:4.1f},{100*hi1:4.1f}] "
              f"{100*run['p2']/run['n']:5.1f}% [{100*lo2:4.1f},{100*hi2:4.1f}] "
              f"{avg:8.1f} {avg_provider:>8} {avg_outside_provider:>8} {avg_tool:>8} "
              f"{avg_requests:>6} {avg_in:>9} {avg_out:>9} {output_per_request:>8} "
              f"{run['timeouts']:5d} {run['errors']:7d} {run['edit_fails']:9d}")
        comparison.append({k: run[k] for k in
                           ("engine", "n", "p1", "p2", "timeouts", "agent_s", "errors", "edit_fails",
                            "input_tokens", "output_tokens", "reasoning_tokens", "usage_rounds", "rounds")}
                          | {k: run[k] for k in
                             ("provider_timing_rounds", "provider_duration_s", "provider_wall_s",
                              "provider_max_duration_s", "builtin_timing_rounds",
                              "builtin_tool_s", "builtin_tool_samples",
                              "provider_requests", "provider_transports",
                              "by_tool_us", "by_tool_samples", "by_request_reason")}
                          | {"pass1_ci95": [lo1, hi1], "pass2_ci95": [lo2, hi2],
                             "efficiency": efficiency,
                             "source": str(run["path"])})
    for run in sorted(runs, key=lambda item: item["engine"]):
        reasons = run.get("by_request_reason")
        if not isinstance(reasons, dict) or not reasons:
            continue
        ranked = sorted(reasons.items(), key=lambda item: (-int(item[1]), item[0]))
        details = ", ".join(f"{name}={int(count)}" for name, count in ranked[:10])
        print(f"{run['engine']} completed-request reasons (argument-free): {details}")
    outliers = task_outliers(runs, args.top_tasks)
    if outliers:
        print("\ntask outliers (bounded union of slowest and highest-request tasks per engine)")
        print(f"{'engine':12s} {'task':34s} {'result':>7} {'agent_s':>8} {'req':>5} "
              f"{'out':>7} {'other_s':>8} {'edits':>6} {'ef':>4} {'t/o':>4} {'signal':>13}")
        for row in outliers:
            result = (f"p{row['solved_round']}" if row["solved_round"] else "fail")
            requests = str(row["provider_requests"]) if row["provider_requests"] is not None else "?"
            output = str(row["output_tokens"]) if row["output_tokens"] is not None else "?"
            outside = (f"{row['outside_provider_s']:.1f}"
                       if row["outside_provider_s"] is not None else "?")
            edits = str(row["edits"]) if row["edits"] is not None else "?"
            edit_fails = str(row["edit_fails"]) if row["edit_fails"] is not None else "?"
            task = re.sub(r"[\x00-\x1f\x7f]", "?", f"{row['lang']}/{row['exercise']}")[:34]
            print(f"{row['engine']:12.12s} {task:34s} {result:>7} {row['agent_s']:8.1f} "
                  f"{requests:>5} {output:>7} {outside:>8} {edits:>6} {edit_fails:>4} "
                  f"{row['timeout_rounds']:4d} {'+'.join(row['signals']):>13}")
    baseline_engine = (args.baseline_engine
                       if args.baseline_engine in {run["engine"] for run in runs} else None)
    paired = paired_task_deltas(runs, baseline_engine) if baseline_engine else []
    paired_summary = paired_summaries(paired)
    regressions = paired_regressions(paired, args.top_tasks)
    if regressions:
        print(f"\npaired {baseline_engine} regressions (positive deltas mean baseline used more)")
        print(f"{'peer':12s} {'task':34s} {'base/peer':>13} {'agent_Δs':>9} {'req_Δ':>6} "
              f"{'out_Δ':>8} {'t/o_Δ':>6} {'signal':>21}")
        for row in regressions:
            request_delta = (f"{row['provider_requests_delta']:+g}"
                             if row["provider_requests_delta"] is not None else "?")
            output_delta = (f"{row['output_tokens_delta']:+g}"
                            if row["output_tokens_delta"] is not None else "?")
            task = re.sub(r"[\x00-\x1f\x7f]", "?", f"{row['lang']}/{row['exercise']}")[:34]
            results = f"{row['baseline_result']}/{row['peer_result']}"
            print(f"{row['peer_engine']:12.12s} {task:34s} {results:>13} "
                  f"{row['agent_s_delta']:+9.1f} {request_delta:>6} {output_delta:>8} "
                  f"{row['timeout_rounds_delta']:+6g} {'+'.join(row['signals']):>21}")
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        tasks = sorted((task_metrics(run["engine"], record) for run in runs
                        for record in run["records"]),
                       key=lambda row: (row["engine"], row["lang"], row["exercise"]))
        args.json.write_text(json.dumps({"schema_version": 5, "task_count": len(baseline),
                                         "baseline_engine": baseline_engine,
                                         "runs": comparison, "tasks": tasks,
                                         "paired_summaries": paired_summary,
                                         "paired_task_deltas": paired},
                                        indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
