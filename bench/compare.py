#!/usr/bin/env python3
"""Compare controlled DGC/peer benchmark result files with confidence intervals."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

REQUIRED_ENGINES = {"dgc", "aider", "codex", "goose", "opencode", "pi"}
REQUIRED_LANGS = {"cpp", "go", "java", "javascript", "python", "rust"}


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
    usage_rounds = sum(isinstance(usage, dict)
                       and int(usage.get("requests", 0) or 0) > 0
                       and usage.get("synchronized", True) is not False
                       for usage in usages)
    input_tokens = sum(int((usage or {}).get("input_tokens", 0) or 0) for usage in usages)
    output_tokens = sum(int((usage or {}).get("output_tokens", 0) or 0) for usage in usages)
    reasoning_tokens = sum(int((usage or {}).get("reasoning_tokens", 0) or 0) for usage in usages)
    errors = sum(bool(r.get("error")) for r in records)
    return {"path": path, "manifest": manifest, "engine": engine, "records": records,
            "tasks": tasks, "n": len(records),
            "p1": p1, "p2": p2, "timeouts": timeouts, "agent_s": agent_s,
            "edit_fails": edit_fails, "errors": errors, "usage_rounds": usage_rounds,
            "rounds": len(rounds), "input_tokens": input_tokens,
            "output_tokens": output_tokens, "reasoning_tokens": reasoning_tokens}


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
          f"{'avg_s':>8} {'avg_in':>9} {'avg_out':>9} {'t/o':>5} {'errors':>7} {'editfail':>9}")
    comparison = []
    for run in sorted(runs, key=lambda r: (-r["p2"], r["agent_s"], r["engine"])):
        lo1, hi1 = wilson(run["p1"], run["n"])
        lo2, hi2 = wilson(run["p2"], run["n"])
        avg = run["agent_s"] / run["n"]
        avg_in = (str(round(run["input_tokens"] / run["n"]))
                  if run["usage_rounds"] == run["rounds"] else "?")
        avg_out = (str(round(run["output_tokens"] / run["n"]))
                   if run["usage_rounds"] == run["rounds"] else "?")
        print(f"{run['engine']:12s} {run['n']:4d} "
              f"{100*run['p1']/run['n']:5.1f}% [{100*lo1:4.1f},{100*hi1:4.1f}] "
              f"{100*run['p2']/run['n']:5.1f}% [{100*lo2:4.1f},{100*hi2:4.1f}] "
              f"{avg:8.1f} {avg_in:>9} {avg_out:>9} "
              f"{run['timeouts']:5d} {run['errors']:7d} {run['edit_fails']:9d}")
        comparison.append({k: run[k] for k in
                           ("engine", "n", "p1", "p2", "timeouts", "agent_s", "errors", "edit_fails",
                            "input_tokens", "output_tokens", "reasoning_tokens", "usage_rounds", "rounds")}
                          | {"pass1_ci95": [lo1, hi1], "pass2_ci95": [lo2, hi2],
                             "source": str(run["path"])})
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps({"schema_version": 2, "task_count": len(baseline),
                                         "runs": comparison}, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
