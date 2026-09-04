---
title: The harness is the product
date: 2026-09-04
description: Why coding quality depends on the loop around the model: context, tools, recovery, verification, and interface.
---

# The harness is the product

Swap a model between two coding agents and it can look like two different models. In one, it finds the relevant definition, lands a small patch, reads the failing test, and corrects itself. In the other, it burns context on a repository dump, misses an edit target, repeats the same attempt, and declares success before running anything.

The weights did not change. The harness did.

## A coding agent is a loop

The visible answer is only the last step. Before it, a useful coding agent has to translate intent into an operating sequence:

1. Build a bounded view of the project and its instructions.
2. Give the model tools with schemas it can use reliably.
3. Execute reads, edits, and commands under an explicit policy.
4. Return exact results without breaking tool-call continuity.
5. Preserve enough state for the next correction.
6. Verify the mutation before allowing a completion claim.

Each step changes what the next model request sees. A noisy repository map can hide the one file that matters. A vague edit primitive can turn the right idea into the wrong patch. A truncated compiler message can send recovery toward a file that no longer exists. A summary that breaks a tool-call/result pair can make a long session unrecoverable.

This is why “just call the model again” is not an agent architecture.

## Local models make the system visible

Large hosted models can sometimes reason around a weak interface. Smaller local models expose every ambiguity. They benefit disproportionately from a compact stable system prefix, a focused tool catalog, exact edit feedback, bounded command output, and a clear signal about what happens next.

That does not mean removing safety to gain speed. It means measuring the cost of the boundary and designing it well. Canonical path resolution, atomic writes, approval checks, and process cleanup should be deterministic local work. Provider latency and repeated generations should be accounted for separately, so a slow task is not blamed on a filesystem check that took milliseconds—or “optimized” by weakening a boundary that was not the bottleneck.

## Verification owns the ending

Models are good at writing plausible completion summaries. Plausibility is not evidence. When DGC records a native action as tracked or potentially workspace-mutating, it can hold the attempted final answer until the configured verifier passes. A red test returns to the loop as evidence; a green result lets the turn close. The optional persistent `python` tool is not mutation-tracked, so its effects require explicit review and verification. The user sees tool commentary and progress as it happens, but an unsupported “done” does not become the final record.

This distinction also shapes the interface. Tool calls should appear as compact actions, diffs should make the changed lines obvious, tests should carry unmistakable status, and commentary should say what is next without narrating every internal thought. A terminal and an editor can render those events differently while sharing the same typed lifecycle.

## Ownership is a systems property

DGC lets the user choose where inference happens: a local server, a compatible API, or a supported subscription. But endpoint choice is only one part of ownership. Sessions should resume locally. Plans should remain reviewable artifacts. Goals should keep their lifecycle. Permission decisions should not disappear when the UI changes. Training export should be initiated by the user, scrubbed before it is written, and never uploaded by the harness.

On DGC's native local and API routes, the model proposes while the harness owns context, execution, recovery, verification, and presentation. A supported subscription route is different: the vendor CLI owns its model-and-tool turn while DGC retains its session record, SessionStart/Stop hooks, mode mapping, and presentation. Improving the native harness layers can make the same model more capable, more legible, and safer to trust with real work. That is not packaging around the product. It is the product.
