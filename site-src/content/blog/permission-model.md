---
title: Permission modes are an execution contract
date: 2026-09-04
description: Why DGC enforces plan, default, acceptEdits, and auto below the model—and keeps deny rules first.
---

# Permission modes are an execution contract

Telling a coding model to “be careful” is useful guidance. It is not a security boundary. A dependable agent needs an execution layer that decides which capabilities are available, which action requires a person, and which action must be refused regardless of what the model asks for.

DGC makes that layer visible through four permission modes.

## Four modes, four clear expectations

`default` is the normal starting point. Structured reads can run without interruption, while model-requested file writes and arbitrary shell commands ask by baseline. Explicit deny, ask, and allow rules are evaluated before that baseline. Direct user `!cmd` commands are already intentional actions and do not prompt again. The model can investigate quickly while the user retains the two powers most likely to change a system.

`acceptEdits` removes friction from direct file work. Structured edits apply automatically by baseline; shell commands ask by baseline, subject to the same explicit rules. This is useful when the task is understood and the user wants to review a resulting diff without approving each patch operation.

`plan` is read-only. The agent can inspect files, search, use code intelligence, and assemble a concrete plan. Mutation tools are denied in the permission layer, external project paths are unavailable, and MCP execution is not exposed. Approval ends the planning boundary and returns to an edit-capable mode chosen by the user.

`auto` approves model-requested actions. It exists for trusted workspaces and controlled unattended runs, not as a claim that review no longer matters. DGC gives it a separate warning because a model with shell and write access has the same practical reach as the commands it can launch.

## Deny must win

Modes describe broad behavior. Fine-grained rules handle local policy: allow a formatter, ask for a deployment command, or deny reads of a credential pattern. DGC evaluates those rules in the fixed order deny, ask, allow.

That ordering prevents a convenient broad allow from overriding a narrow safety rule. It also means a deny remains a deny in `auto`. An approval containing a credential may run once, but it cannot become a persistent permission rule.

Arbitrary shell is never classified as intrinsically read-only from the command string. Redirection, substitutions, wrappers, interpreters, and project configuration make such allowlists easy to misunderstand. In `default` and `acceptEdits`, shell asks.

## The workspace is another boundary

A permission to edit in `default` or `acceptEdits` does not imply permission to edit anywhere. Structured filesystem tools resolve through a canonical project boundary. An external path needs a separate approval: “allow once” is session-scoped, while “always allow” persists a scoped external-directory rule. Neither turns an unrelated parent into a second workspace. `plan` refuses external paths, while `auto` deliberately permits model-requested external structured paths unless a deny rule blocks them. Symlink and traversal checks are applied where the path is consumed, not just when text first enters the tool. OS sandboxing wraps spawned commands and hooks; it does not confine structured file tools running in DGC's parent process.

Optional OS sandboxing adds a different layer. On supported Linux and macOS hosts it limits what a spawned command can see or change and blocks network by default. It does not bypass ordinary approval prompts. If the requested backend is unavailable, DGC refuses to claim that the process is confined.

## Keep the decision attached to the action

For DGC’s native model/tool loop, the terminal, editor, ACP adapter, and headless protocol carry typed permission requests with correlated identifiers. Late, duplicated, mismatched, or post-restart answers fail closed. Delegated subscription turns map the selected mode into the official vendor CLI instead; DGC’s fine-grained tool rules do not wrap that vendor’s internal tool calls. The interface can change; the native-loop decision semantics do not.

This is the core design principle: permission mode is not a mood in the prompt. It is an execution contract below the model. The model can propose an action, explain why it needs it, and respond to a denial. The harness decides whether that action can actually happen.
