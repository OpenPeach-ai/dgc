---
title: A benchmark is a protocol, not a percentage
date: 2026-09-04
description: How DGC compares coding harnesses on one model, real tests, controlled settings, and publishable provenance.
---

# A benchmark is a protocol, not a percentage

A coding-agent score looks simple at the end: problems solved divided by problems attempted. Getting to a number worth comparing is harder. The model, context window, transport, task checkout, time budget, retry policy, and grader can each move the result. If two harnesses see different conditions, the percentage says less about the harness than it appears to.

DGC’s polyglot runner treats the protocol as the result’s foundation.

## Hold the model constant

The question is not which model is strongest. It is what different harnesses help the same model accomplish. Every agent therefore points at the same controlled endpoint and model alias. For Ollama, the context size is baked into a dedicated alias because an OpenAI-compatible request cannot reliably change the server’s `num_ctx`; the runner checks that metadata before a scored task begins. {{BENCH_WEIGHTS_OPERATOR_NOTE}}

The publishable league also records the immutable model digest, hardware label, accelerator, context size, runner revision, dataset revision, harness executable versions, and expected provider transport. Missing provenance is a failed publication gate, not a footnote.

## Grade the repository, not the explanation

The Aider polyglot benchmark contains Exercism problems in {{BENCH_LANGUAGE_NAMES}}. Each task begins from its stub. The agent works in an isolated copy, and the grader runs the exercise’s official tests in a fresh fixture containing only the allowed solution files. A harness cannot improve its score by weakening tests, changing a manifest, or leaving an unrelated helper file behind.

The first round starts a fresh session and asks the agent to implement the solution. If the official tests fail, the final recovery round continues that same session with a bounded tail of the failure output, normalized so paths still point at the live exercise workspace. {{BENCH_FIRST_METRIC}} means the first attempt passed. {{BENCH_METRIC}} means it passed by the end of the recovery round.

## Time is part of the claim

A strict {{BENCH_CAP_SECONDS}}-second per-task cap answers a useful question: what finishes within a common wall-clock budget? An uncapped diagnostic answers a different one: what can a local model eventually solve? Those views should never be blended into one number or described as if they were interchangeable. The currently published {{BENCH_PUBLICATION_LABEL}} used {{BENCH_CAP_SECONDS}} seconds per round—up to {{BENCH_TOTAL_AGENT_SECONDS}} agent seconds for its configured recovery allowance—and is labelled accordingly rather than presented as a {{BENCH_CAP_SECONDS}}-second per-task curve.

Timeouts are charged to the harness that incurred them. If a provider continues computing after a client disconnect, the accounting proxy waits for that request to drain before the next task and keeps the cancelled compute attached to the correct row. Unexplained request-count differences make a result unsynchronized and therefore unpublishable.

## Keep the evidence useful without retaining the work

The benchmark stores aggregate and per-task facts: pass state, rounds, timing, timeouts, request counts, provider-reported tokens, edit failures, and bounded tool activity. The accounting proxy does not record prompts or responses. DGC’s internal metrics journal likewise uses fixed controller-owned reason labels; it does not retain model text, tool arguments, commands, or project paths as benchmark telemetry.

Reference solutions are validated before model time is spent. Runs append one task at a time, so an interrupted league can resume without silently rerunning completed work. The comparison report checks that every engine used the same task set before producing paired deltas and confidence intervals.

## Reproduction is the final check

The runner, harness installers, validation script, report tools, and protocol documentation ship in the repository. A reader can inspect the settings, run a small non-publishable canary, or reproduce a complete controlled league on another model endpoint.

That does not make every benchmark universal. A polyglot exercise suite is not a production monorepo, and {{BENCH_METRIC}} is not a promise about a particular codebase. A fully provenance-complete result can still make a narrow, inspectable, repeatable claim: under disclosed conditions, this harness produced these test outcomes. {{BENCH_RUNNER_BOUNDARY}} The current {{BENCH_PROBLEMS}}-task result is disclosed on that basis instead of being treated as release-gating evidence.
