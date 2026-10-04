# Pip report formatting investigation

The private Linux QA profile recorded two failed native Ollama audits using
`qwen3.8:27b-q4km`, thinking off, a 4,096-token output allowance, and the same
captured current-tree fixture with a pinned user-recorded exception:

- `run_01da2dd4c1b74f21b4707eb41e22fc9b`: `invalid_report`, expected a JSON value at
  line 1, column 1; 1,001 UTF-8 bytes.
- `run_a1e01a4fa740414183f90d8fb796be94`: `invalid_report`, expected a comma or closing
  delimiter at line 2, column 1; 1,034 UTF-8 bytes. This request included the final
  report-schema reminder after reference envelopes.

Those rows remain failed. Their rejected answer bodies were deliberately not
retained, so there is no historical raw response available to prove the exact
syntax mistake. Neither failure produced an accepted report or findings.

## Explicit diagnostic replay

After the separate native Patch acceptance run had finished, an explicitly
requested diagnostic replay used the second audit's immutable source snapshot,
manifest, model settings and read-only worker policy. It did not enqueue a run,
retry or complete either stored failure, change a job, or grant source-write or
command authority. The normal existing worker/Agent path performed the work;
there was no additional model loop and no format-repair fallback.

The replay succeeded: three provider requests, three read-tool calls and one
finding accepted by the unchanged report and source-excerpt validator.
`tests_executed` remained false. The final Ollama native answer, processed
`ChatResult.content` and `validate_report` input were identical:

- 1,097 UTF-8 bytes;
- SHA256 `3b023763869c858f8c7b6d37f3848ca52e30555c85f0f0aeaea1bbb6e5d02331`;
- final provider finish reason `stop`, zero thinking bytes;
- a valid JSON object at all three boundaries.

Metadata-only evidence is in the lab's
`output/pips-audit-format-diagnostic.json`. The diagnostic script is
`scripts/diagnose-pip-audit.py` in the lab root, outside the product checkout. It
records hashes, sizes and JSON grammar metadata, not source text, prompts,
answers or private reasoning. Two earlier launcher preflights refused before
provider access because their policy serialization did not match the exact
production policy bytes; separate `*-preflight*.json` receipts record that.

The replay establishes that this reproduced native path did not corrupt the
answer. Intermittent model JSON noncompliance is the likely explanation for the
previous failures, but cannot be proven from their intentionally limited stored
diagnostics. A successful replay is not a reliability-rate measurement, nor a
claim that local models always follow the schema. Parsing remains strict;
there is no automatic retry or acceptance of partial reports.

## Separate final-answer extraction correction

The investigation reproduced a separate deterministic bug with generic-provider
results and `preserve_thinking=True`: the Agent legitimately stores its reasoning
as a marked `<think>` prefix in the transcript, but the Pip worker used that
entire saved string as its answer. Valid audit/draft JSON then failed validation,
and freeform replies could include the saved prefix.

The worker now uses the existing reasoning-display helper only when the final
assistant message carries the explicit positive integer `_dgc_think_splice`
marker written by the harness. It does not infer or remove a reasoning prefix
from arbitrary model prose. Literal tags within JSON or Markdown remain intact.
The same selection precedes audit, conversation, draft and execution-summary
handling. No provider adapter or general Agent behavior changed.

This correction does **not** explain the two native failures: native Ollama
preserves its own `provider_message`, preventing this transcript splice, and the
actual runs used thinking off. The successful replay also had no splice.

Deterministic regressions use the real native Agent loop with mocked provider
I/O and a network refusal guard. They cover marked reasoning removal, literal
source/Markdown tags, native-provider compatibility, conversation/draft answers,
and continued refusal of unmarked prose and malformed JSON. The focused final
answer, report-diagnostic and local-Pips gate passed 68 tests.
