"""Validated, derived site facts for the published benchmark.

``site-src/data/bench.json`` is the only hand-edited source of benchmark
numbers and run conditions.  Templates consume the context returned here so a
new measured run cannot leave an old score, rank, timeout, or command flag in a
different part of the site.
"""
from __future__ import annotations

import math
import re
from typing import Any


class BenchmarkDataError(ValueError):
    """The public benchmark data is internally inconsistent or unsafe."""


def _integer(value: object, label: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise BenchmarkDataError(f"{label} must be an integer >= {minimum}")
    return value


def _number(value: object, label: str, *, minimum: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise BenchmarkDataError(f"{label} must be numeric")
    result = float(value)
    if not math.isfinite(result) or result < minimum:
        raise BenchmarkDataError(f"{label} must be finite and >= {minimum}")
    return result


def _text(value: object, label: str, *, pattern: str | None = None) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 512:
        raise BenchmarkDataError(f"{label} must be non-empty bounded text")
    if any(ord(char) < 32 for char in value):
        raise BenchmarkDataError(f"{label} contains a control character")
    if pattern and not re.fullmatch(pattern, value):
        raise BenchmarkDataError(f"{label} has an invalid format")
    return value


def _number_word(value: int) -> str:
    words = (
        "zero", "one", "two", "three", "four", "five", "six", "seven",
        "eight", "nine", "ten", "eleven", "twelve",
    )
    return words[value] if 0 <= value < len(words) else str(value)


def _list_phrase(values: list[str]) -> str:
    if not values:
        return ""
    if len(values) == 1:
        return values[0]
    if len(values) == 2:
        return f"{values[0]} and {values[1]}"
    return ", ".join(values[:-1]) + f", and {values[-1]}"


def ranked_harnesses(bench: dict[str, Any]) -> list[dict[str, Any]]:
    """Return display order without making JSON array order carry a ranking."""
    harnesses = list(bench["harnesses"])
    return sorted(
        harnesses,
        key=lambda item: (-float(item["pass_at_2"]), -int(item["solved"]), str(item["name"]).casefold()),
    )


def subject_harness(bench: dict[str, Any]) -> dict[str, Any]:
    subject = bench["subject_harness"]
    rows = [item for item in bench["harnesses"] if item["name"] == subject]
    if len(rows) != 1:
        raise BenchmarkDataError("subject_harness must name exactly one harness row")
    return rows[0]


def score_rank(bench: dict[str, Any], row: dict[str, Any]) -> tuple[int, list[str]]:
    score = float(row["pass_at_2"])
    rank = 1 + sum(float(item["pass_at_2"]) > score for item in bench["harnesses"])
    ties = [
        str(item["name"]) for item in ranked_harnesses(bench)
        if item is not row and float(item["pass_at_2"]) == score
    ]
    return rank, ties


def validate_benchmark(bench: dict[str, Any]) -> None:
    """Validate facts and every deliberately duplicated aggregate."""
    if not isinstance(bench, dict) or bench.get("schema_version") != 1:
        raise BenchmarkDataError("unsupported benchmark schema")

    problems = _integer(bench.get("problems"), "problems", minimum=1)
    rounds = _integer(bench.get("rounds"), "rounds", minimum=1)
    cap = _integer(bench.get("cap_seconds_per_round"), "cap_seconds_per_round", minimum=1)
    _integer(bench.get("grader_timeout_seconds"), "grader_timeout_seconds", minimum=1)
    _integer(bench.get("context_tokens"), "context_tokens", minimum=1)
    gate_problems = _integer(bench.get("publication_gate_problems"), "publication_gate_problems", minimum=1)
    if gate_problems < problems:
        raise BenchmarkDataError("publication_gate_problems cannot be smaller than problems")

    _text(bench.get("run_version"), "run_version", pattern=r"[0-9]+\.[0-9]+\.[0-9]+")
    _text(bench.get("subject_harness"), "subject_harness")
    _text(bench.get("publication_label"), "publication_label")
    _text(bench.get("publication_state"), "publication_state")
    _text(bench.get("suite"), "suite")
    metric = _text(bench.get("metric"), "metric", pattern=r"pass@[1-9][0-9]*")
    if metric != f"pass@{rounds}":
        raise BenchmarkDataError("metric must describe the configured round count")
    _text(bench.get("model"), "model", pattern=r"[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,127}")
    _text(bench.get("model_size_label"), "model_size_label", pattern=r"[0-9]+(?:\.[0-9]+)?[BM]")
    _text(bench.get("model_digest"), "model_digest", pattern=r"sha256-[0-9a-f]{64}")
    _text(bench.get("dataset_commit"), "dataset_commit", pattern=r"[0-9a-f]{40}")
    _text(bench.get("task_order"), "task_order", pattern=r"[A-Za-z][A-Za-z0-9 _-]*")
    _text(bench.get("reasoning_mode"), "reasoning_mode", pattern=r"[A-Za-z][A-Za-z0-9 _-]*")
    _text(bench.get("base_url"), "base_url", pattern=r"https?://[^\s<>\"']+")
    _text(bench.get("endpoint_policy"), "endpoint_policy")
    for key in ("runner_revision_recorded", "model_weights_verified"):
        if not isinstance(bench.get(key), bool):
            raise BenchmarkDataError(f"{key} must be boolean")

    languages = bench.get("languages")
    if not isinstance(languages, list) or not languages:
        raise BenchmarkDataError("languages must be a non-empty array")
    language_slugs: list[str] = []
    language_population = 0
    for index, language in enumerate(languages):
        if not isinstance(language, dict):
            raise BenchmarkDataError(f"languages[{index}] must be an object")
        _text(language.get("name"), f"languages[{index}].name")
        slug = _text(language.get("slug"), f"languages[{index}].slug", pattern=r"[a-z][a-z0-9-]*")
        solved = _integer(language.get("solved"), f"languages[{index}].solved")
        total = _integer(language.get("total"), f"languages[{index}].total", minimum=1)
        if solved > total:
            raise BenchmarkDataError(f"languages[{index}].solved exceeds total")
        language_slugs.append(slug)
        language_population += total
    if len(set(language_slugs)) != len(language_slugs):
        raise BenchmarkDataError("language slugs must be unique")
    if language_population != problems:
        raise BenchmarkDataError("language task totals must equal problems")

    harnesses = bench.get("harnesses")
    if not isinstance(harnesses, list) or len(harnesses) < 2:
        raise BenchmarkDataError("harnesses must contain at least two rows")
    names: list[str] = []
    slugs: list[str] = []
    for index, harness in enumerate(harnesses):
        if not isinstance(harness, dict):
            raise BenchmarkDataError(f"harnesses[{index}] must be an object")
        name = _text(harness.get("name"), f"harnesses[{index}].name")
        slug = _text(harness.get("slug"), f"harnesses[{index}].slug", pattern=r"[a-z][a-z0-9-]*")
        pass_one = _integer(harness.get("pass_at_1_solved"), f"harnesses[{index}].pass_at_1_solved")
        solved = _integer(harness.get("solved"), f"harnesses[{index}].solved")
        score = _number(harness.get("pass_at_2"), f"harnesses[{index}].pass_at_2")
        timeouts = _integer(harness.get("timeouts"), f"harnesses[{index}].timeouts")
        measured_rounds = _integer(harness.get("rounds"), f"harnesses[{index}].rounds", minimum=1)
        average = _number(harness.get("average_round_seconds"), f"harnesses[{index}].average_round_seconds")
        _integer(harness.get("output_tokens"), f"harnesses[{index}].output_tokens", minimum=1)
        per_language = harness.get("per_language")
        if pass_one > solved or solved > problems or timeouts > measured_rounds \
                or not problems <= measured_rounds <= problems * rounds or average > cap + 1:
            raise BenchmarkDataError(f"harnesses[{index}] has impossible totals")
        if score > 100 or not math.isclose(score, round(100 * solved / problems, 1), abs_tol=1e-9):
            raise BenchmarkDataError(f"harnesses[{index}].pass_at_2 disagrees with solved/problems")
        if not isinstance(per_language, dict) or set(per_language) != set(language_slugs):
            raise BenchmarkDataError(f"harnesses[{index}].per_language has the wrong language set")
        per_language_solved = 0
        for language in languages:
            value = _integer(per_language[language["slug"]], f"harnesses[{index}].per_language")
            if value > language["total"]:
                raise BenchmarkDataError(f"harnesses[{index}].per_language exceeds task total")
            per_language_solved += value
        if per_language_solved != solved:
            raise BenchmarkDataError(f"harnesses[{index}].per_language does not sum to solved")
        names.append(name)
        slugs.append(slug)
    if len(set(names)) != len(names) or len(set(slugs)) != len(slugs):
        raise BenchmarkDataError("harness names and slugs must be unique")

    dgc = subject_harness(bench)
    language_claims = {item["slug"]: item["solved"] for item in languages}
    if dgc["per_language"] != language_claims:
        raise BenchmarkDataError("language display rows must equal the subject harness results")

    chart = bench.get("chart")
    if not isinstance(chart, dict):
        raise BenchmarkDataError("chart must be an object")
    axis_min = _number(chart.get("axis_min_percent"), "chart.axis_min_percent")
    axis_max = _number(chart.get("axis_max_percent"), "chart.axis_max_percent")
    tick_step = _number(chart.get("tick_step_percent"), "chart.tick_step_percent", minimum=0.1)
    if axis_max <= axis_min or axis_max > 100:
        raise BenchmarkDataError("chart axis bounds are invalid")
    tick_count = (axis_max - axis_min) / tick_step
    if not math.isclose(tick_count, round(tick_count), abs_tol=1e-9) or not 1 <= tick_count <= 10:
        raise BenchmarkDataError("chart tick step must divide the bounded axis")
    scores = [float(item["pass_at_2"]) for item in harnesses]
    if min(scores) < axis_min or max(scores) > axis_max:
        raise BenchmarkDataError("chart axis does not contain every score")

    leader = ranked_harnesses(bench)[0]
    expected_delta = round((dgc["output_tokens"] / leader["output_tokens"] - 1) * 100, 1)
    cost = bench.get("dgc_cost")
    if not isinstance(cost, dict) or cost.get("timeouts") != dgc["timeouts"] \
            or cost.get("average_round_seconds") != dgc["average_round_seconds"] \
            or cost.get("output_tokens_vs_leader_percent") != expected_delta:
        raise BenchmarkDataError("dgc_cost must equal the metrics derived from harness rows")

    trace = bench.get("featured_trace")
    if not isinstance(trace, dict):
        raise BenchmarkDataError("featured_trace must be an object")
    _text(trace.get("run_id"), "featured_trace.run_id", pattern=r"[0-9a-f]{16}")
    trace_language = _text(trace.get("language_slug"), "featured_trace.language_slug", pattern=r"[a-z][a-z0-9-]*")
    _text(trace.get("exercise"), "featured_trace.exercise", pattern=r"[A-Za-z0-9][A-Za-z0-9._-]*")
    _integer(trace.get("resumed_messages"), "featured_trace.resumed_messages", minimum=1)
    solved_round = _integer(trace.get("solved_round"), "featured_trace.solved_round", minimum=1)
    _number(trace.get("grader_seconds"), "featured_trace.grader_seconds")
    if not isinstance(trace.get("isolated"), bool):
        raise BenchmarkDataError("featured_trace.isolated must be boolean")
    if trace_language not in language_slugs or solved_round > rounds:
        raise BenchmarkDataError("featured_trace does not fit the configured benchmark")

    swe = bench.get("swe_bench_lite")
    if not isinstance(swe, dict):
        raise BenchmarkDataError("swe_bench_lite must be an object")
    swe_solved = _integer(swe.get("solved"), "swe_bench_lite.solved")
    swe_total = _integer(swe.get("total"), "swe_bench_lite.total", minimum=1)
    swe_percent = _number(swe.get("percent"), "swe_bench_lite.percent")
    retained = _integer(swe.get("predictions_retained"), "swe_bench_lite.predictions_retained")
    non_empty = _integer(swe.get("non_empty_patches"), "swe_bench_lite.non_empty_patches")
    if swe_solved > swe_total or retained < swe_total or non_empty > retained \
            or not math.isclose(swe_percent, round(100 * swe_solved / swe_total, 1), abs_tol=1e-9):
        raise BenchmarkDataError("swe_bench_lite contains inconsistent totals")
    _text(swe.get("claim_source"), "swe_bench_lite.claim_source")
    _text(swe.get("local_evidence_note"), "swe_bench_lite.local_evidence_note")
    _text(swe.get("publication_record_commit"), "swe_bench_lite.publication_record_commit", pattern=r"[0-9a-f]{7,40}")

    if bench.get("completion_profile") is not None:
        if not isinstance(bench["completion_profile"], list):
            raise BenchmarkDataError("completion_profile must be null or an array")
    if not isinstance(bench.get("trace_bundles"), list):
        raise BenchmarkDataError("trace_bundles must be an array")


def benchmark_context(bench: dict[str, Any]) -> dict[str, str | int]:
    """Return all benchmark values templates are allowed to publish."""
    validate_benchmark(bench)
    dgc = subject_harness(bench)
    ranked = ranked_harnesses(bench)
    leader = ranked[0]
    rank, ties = score_rank(bench, dgc)
    languages = bench["languages"]
    language_names = {str(item["slug"]): str(item["name"]) for item in languages}
    totals = {int(item["total"]) for item in languages}
    if len(totals) != 1:
        raise BenchmarkDataError("site reproduction commands require one task limit for every language")
    tasks_per_language = str(next(iter(totals)))
    swe = bench["swe_bench_lite"]
    trace = bench["featured_trace"]
    delta = round((dgc["output_tokens"] / leader["output_tokens"] - 1) * 100, 1)
    avg_rank = 1 + sum(
        float(item["average_round_seconds"]) < float(dgc["average_round_seconds"])
        for item in bench["harnesses"]
    )
    avg_label = "fastest measured" if avg_rank == 1 else f"speed rank {avg_rank}"
    rank_label = f"rank {rank}"
    if ties:
        rank_label += f", tied with {_list_phrase(ties)}"
    runner_clause = (
        "its runner commit was recorded"
        if bench["runner_revision_recorded"]
        else "its runner commit was not recorded"
    )
    weights_clause = (
        "model weights were independently verified"
        if bench["model_weights_verified"]
        else "model weights were not independently verified"
    )
    runner_reproduction = (
        "The saved manifest records its runner revision for a pinned recreation."
        if bench["runner_revision_recorded"]
        else "The saved manifest did not record its runner revision, so exact byte-for-byte recreation is not possible."
    )
    runner_boundary = (
        "The current slice records its runner revision."
        if bench["runner_revision_recorded"]
        else "The current slice does not record its runner revision, so its site page calls out that reproduction boundary."
    )
    weights_operator_note = (
        "The recorded digest was independently verified against the endpoint weights."
        if bench["model_weights_verified"]
        else "The endpoint operator must separately pin and verify the model weights because the runner records a supplied digest but does not derive it from the response server."
    )
    weights_reproduction_note = (
        "The published evidence includes independent verification of the endpoint weights."
        if bench["model_weights_verified"]
        else "Confirm the endpoint’s model digest separately because the runner records that value but does not verify the weights."
    )
    return {
        "BENCH_VERSION": bench["run_version"],
        "BENCH_PUBLICATION_LABEL": bench["publication_label"],
        "BENCH_PUBLICATION_BADGE": str(bench["publication_label"]).split()[0],
        "BENCH_SUITE": bench["suite"],
        "BENCH_PROBLEMS": bench["problems"],
        "BENCH_ROUNDS": bench["rounds"],
        "BENCH_METRIC": bench["metric"],
        "BENCH_METRIC_UPPER": str(bench["metric"]).upper(),
        "BENCH_FIRST_METRIC": str(bench["metric"]).split("@", 1)[0] + "@1",
        "BENCH_CAP_SECONDS": bench["cap_seconds_per_round"],
        "BENCH_TOTAL_AGENT_SECONDS": f'{bench["rounds"] * bench["cap_seconds_per_round"]:,}',
        "BENCH_GRADER_TIMEOUT_SECONDS": bench["grader_timeout_seconds"],
        "BENCH_MODEL": bench["model"],
        "BENCH_MODEL_SIZE": bench["model_size_label"],
        "BENCH_MODEL_DIGEST": bench["model_digest"],
        "BENCH_MODEL_DIGEST_SHORT": bench["model_digest"][:22] + "…",
        "BENCH_DATASET_COMMIT": bench["dataset_commit"],
        "BENCH_DATASET_SHORT": bench["dataset_commit"][:16] + "…",
        "BENCH_TASK_ORDER": bench["task_order"],
        "BENCH_CONTEXT_TOKENS": bench["context_tokens"],
        "BENCH_CONTEXT_TOKENS_FORMATTED": f'{bench["context_tokens"]:,}',
        "BENCH_REASONING_MODE": bench["reasoning_mode"],
        "BENCH_BASE_URL": bench["base_url"],
        "BENCH_GATE_PROBLEMS": bench["publication_gate_problems"],
        "BENCH_LANGUAGE_COUNT": len(languages),
        "BENCH_LANGUAGE_COUNT_WORD": _number_word(len(languages)),
        "BENCH_LANGUAGE_NAMES": _list_phrase([str(item["name"]) for item in languages]),
        "BENCH_TASKS_PER_LANGUAGE": tasks_per_language,
        "BENCH_HARNESS_COUNT": len(ranked),
        "BENCH_HARNESS_COUNT_WORD": _number_word(len(ranked)),
        "BENCH_HARNESS_NAMES": _list_phrase([str(item["name"]) for item in ranked]),
        "BENCH_DGC_NAME": dgc["name"],
        "BENCH_DGC_SCORE": f'{dgc["pass_at_2"]:.1f}',
        "BENCH_DGC_SOLVED": dgc["solved"],
        "BENCH_DGC_TIMEOUTS": dgc["timeouts"],
        "BENCH_DGC_AVERAGE_ROUND_SECONDS": f'{dgc["average_round_seconds"]:.1f}',
        "BENCH_DGC_RANK": rank,
        "BENCH_DGC_RANK_LABEL": rank_label,
        "BENCH_DGC_AVERAGE_LABEL": avg_label,
        "BENCH_DGC_TOKEN_DELTA": f"{delta:.1f}",
        "BENCH_SCORE_LEADER": leader["name"],
        "BENCH_RUNNER_CLAUSE": runner_clause,
        "BENCH_RUNNER_REPRODUCTION": runner_reproduction,
        "BENCH_RUNNER_BOUNDARY": runner_boundary,
        "BENCH_WEIGHTS_CLAUSE": weights_clause,
        "BENCH_WEIGHTS_OPERATOR_NOTE": weights_operator_note,
        "BENCH_WEIGHTS_REPRODUCTION_NOTE": weights_reproduction_note,
        "BENCH_TRACE_RUN_ID": trace["run_id"],
        "BENCH_TRACE_TASK": f'{trace["language_slug"]}/{trace["exercise"]}',
        "BENCH_TRACE_LANGUAGE": language_names[str(trace["language_slug"])],
        "BENCH_TRACE_EXERCISE": trace["exercise"],
        "BENCH_TRACE_MESSAGES": trace["resumed_messages"],
        "BENCH_TRACE_ROUNDS": trace["solved_round"],
        "BENCH_TRACE_RECOVERY_LABEL": (
            f'{trace["solved_round"] - 1} recovery round'
            + ("" if trace["solved_round"] == 2 else "s")
        ),
        "BENCH_TRACE_GRADER_SECONDS": f'{trace["grader_seconds"]:.1f}',
        "BENCH_TRACE_ISOLATED": str(trace["isolated"]).lower(),
        "BENCH_TRACE_ISOLATION_LABEL": "isolated" if trace["isolated"] else "not isolated",
        "BENCH_SWE_SOLVED": swe["solved"],
        "BENCH_SWE_TOTAL": swe["total"],
        "BENCH_SWE_PERCENT": f'{swe["percent"]:.1f}',
        "BENCH_SWE_PREDICTIONS_RETAINED": swe["predictions_retained"],
        "BENCH_SWE_NON_EMPTY_PATCHES": swe["non_empty_patches"],
        "BENCH_SWE_CLAIM_SOURCE": swe["claim_source"],
        "BENCH_SWE_CLAIM_SOURCE_TITLE": str(swe["claim_source"])[0].upper() + str(swe["claim_source"])[1:],
        "BENCH_SWE_PUBLICATION_COMMIT": swe["publication_record_commit"],
        "BENCH_AXIS_MIN": f'{bench["chart"]["axis_min_percent"]:g}',
        "BENCH_AXIS_MAX": f'{bench["chart"]["axis_max_percent"]:g}',
    }
