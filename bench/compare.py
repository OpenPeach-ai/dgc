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


def wilson(successes: int, total: int, z: float = 1.959963984540054) -> tuple[float, float]:
    if total <= 0:
        return 0.0, 0.0
    p = successes / total
    denominator = 1 + z * z / total
    center = (p + z * z / (2 * total)) / denominator
    margin = z * math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator
    return max(0.0, center - margin), min(1.0, center + margin)


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
    engine = str(records[0].get("engine") or path.stem)
    tasks = {(str(r.get("lang")), str(r.get("ex"))) for r in records}
    p1 = sum(bool(r.get("solved") and r.get("solved_round") == 1) for r in records)
    p2 = sum(bool(r.get("solved")) for r in records)
    rounds = [rd for r in records for rd in (r.get("rounds") or [])]
    timeouts = sum(bool((rd.get("agent") or rd.get("dgc") or {}).get("timeout")) for rd in rounds)
    agent_s = sum(float((rd.get("agent") or rd.get("dgc") or {}).get("time") or 0) for rd in rounds)
    edit_fails = sum(int((rd.get("stats") or {}).get("edit_fails") or 0) for rd in rounds)
    usages = [((rd.get("agent") or rd.get("dgc") or {}).get("usage")) for rd in rounds]
    attributed_usages = [
        usage for usage in usages
        if (isinstance(usage, dict) and int(usage.get("requests", 0) or 0) > 0
            and usage.get("synchronized", True) is not False)
    ]
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
    def timing_value(usage: dict, key: str) -> float | None:
        if key not in usage or usage.get(key) is None:
            return None
        try:
            value = float(usage[key])
        except (TypeError, ValueError):
            return None
        return value if math.isfinite(value) and value >= 0 else None

    provider_timings = []
    for usage in attributed_usages:
        values = tuple(timing_value(usage, key) for key in
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
    for item in stats:
        for source_key, target in (("by_tool_us", by_tool_us),
                                   ("by_tool_samples", by_tool_samples)):
            values = item.get(source_key) if isinstance(item.get(source_key), dict) else {}
            valid_names = [str(name) for name in sorted(values)
                           if re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", str(name))][:64]
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
            "by_tool_us": by_tool_us, "by_tool_samples": by_tool_samples}


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
    args = parser.parse_args()
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
                              "by_tool_us", "by_tool_samples")}
                          | {"pass1_ci95": [lo1, hi1], "pass2_ci95": [lo2, hi2],
                             "efficiency": efficiency,
                             "source": str(run["path"])})
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps({"schema_version": 3, "task_count": len(baseline),
                                         "runs": comparison}, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
