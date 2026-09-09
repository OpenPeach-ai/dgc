---
name: plan
description: Turn a requested complex change into an evidence-based implementation plan with dependencies, decisions and concrete validation. Use for planning requests or work that needs design decisions.
---
Plan the requested outcome: $ARGUMENTS

Read the relevant guidance, entry points, data models and callers. Inspect enough context to identify
constraints and dependencies; do not require entire large files to be loaded when focused reads suffice.
State the outcome and the decisions that would materially change implementation. Resolve ordinary
implementation choices from the project; ask only for missing requirements that affect correctness.

Describe coherent steps in dependency order, with the affected components and observable done-checks.
Include migration, compatibility or rollout work only when the change needs it. Scale detail to the
actual task; an arbitrary step limit must not discard requested work. Track parallel work only if
available and authorized, with clear ownership and integration checks.

In plan mode, remain read-only and use present_plan if available to request the controller's execution
transition. Do not edit files or bypass the mode through shell commands. Outside plan mode, a user who
already requested implementation has authorized ordinary work; planning alone adds no new approval gate.
Use todo for substantial execution when available. A normal plan is not an instruction to create a goal.

When evidence changes the approach, update the relevant steps and explain the consequence. Continue
within the authorized outcome; obtain a decision only for a material scope or authority change. Mark
steps complete on observed results and retain unresolved checks instead of silently dropping them.

Example: a protocol migration includes both producer and consumer changes, compatibility behavior,
a failure/reconnect check, and release coordination; merely updating the version constant is not done.
