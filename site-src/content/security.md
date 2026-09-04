---
title: Security
description: DGC's permission, workspace, sandbox, credential, and vulnerability-reporting boundaries.
---

# Security in DGC

DGC is a local coding agent. Reading a repository, editing files, and running commands are intended capabilities, so security starts with making those powers explicit and bounded.

## Permission model

DGC’s native local/API loop ships in `default` mode: structured reads can run automatically, while model-requested file writes and arbitrary shell commands ask by baseline. `acceptEdits` auto-approves model-requested file edits by baseline but still asks for shell commands. Explicit deny, ask, and allow rules are evaluated before those baseline decisions. Direct user `!cmd` commands do not prompt again. `plan` blocks model-requested mutation tools. `auto` approves model-requested actions and should be used only in a trusted workspace with a model and provider you trust. A delegated subscription turn instead maps the selected mode into the vendor CLI’s supported flags; that CLI owns its tool decisions and policies.

In the native loop, fine-grained permission rules are evaluated in a fixed order: deny, then ask, then allow. A deny rule therefore remains effective in every native mode, including `auto`. Approval prompts can authorize one action or save a narrowly matched rule.

## Workspace and process boundaries

Structured filesystem tools resolve paths through a canonical workspace boundary. In `default` and `acceptEdits`, a path outside the project requires a separate approval; “allow once” is session-scoped, while “always allow” persists a scoped external-directory rule. `plan` refuses external paths. `auto` deliberately allows model-requested external structured paths unless a deny rule blocks them. Symlink and traversal tricks do not silently widen an approved boundary.

Optional OS sandboxing adds defense in depth to native-loop spawned shell commands and hooks without replacing permission review or confining parent-process structured file tools. It does not wrap delegated vendor-CLI processes or their internal tools. A delegated vendor CLI runs unsandboxed in the workspace and inherits DGC’s ambient process environment, including any unrelated credentials it contains; use a trusted vendor CLI and launch DGC with only the environment secrets that turn needs. On Linux, DGC can use bubblewrap to expose the project as the only persistent writable host path, hide ambient home state, isolate temporary/runtime/process namespaces, and block network access by default. On macOS, sandbox-exec applies a policy that denies ambient-home reads, host writes outside the project and shared system temporary paths, and network access by default. If a requested sandbox is unavailable, DGC fails closed rather than claiming confinement it cannot provide.

Configured MCP and language-server commands are trusted executables. Their processes start unsandboxed in the workspace, and DGC cannot mediate their own filesystem or network activity through model-tool permissions, the shell sandbox, or the workspace mutation lease. Only configure commands you trust.

The optional persistent `python` code-action tool runs in its own unsandboxed process and inherits DGC's environment. Its arbitrary filesystem changes are not captured by the structured-tool checkpoint system or tracked as verifier-invalidating mutations. It is off by default; if you enable it, review its effects and run verification explicitly.

## Credentials and network access

Provider credentials are kept separate from ordinary configuration. The editor uses VS Code SecretStorage rather than plaintext settings. In the native loop, DGC masks configured secrets and high-confidence credential patterns before direct-model context, native tool results, terminal/editor/headless output, saved plans, and persisted session text. Delegated vendor-CLI streams shown in the full-screen TUI or subscription one-shot CLI are displayed as that vendor emits them after terminal-control cleanup, so treat vendor output as sensitive and do not ask it to echo credentials. Exact rewind snapshots remain private local recovery data and are not rewritten as text.

Web fetches block private, loopback, and link-local targets and revalidate redirects. Untrusted workspace automation requires explicit trust. MCP forms reject credential and payment fields; URL and sampling requests remain user-gated.

Your prompts, code excerpts, and tool results go to the model endpoint you select. With a local endpoint they can remain on infrastructure you control. With a cloud API or subscription, that provider receives the context needed to answer under its own terms and privacy policy.

## Report a vulnerability

Do not open a public issue for a vulnerability that could expose files, credentials, model traffic, or command execution. Use [GitHub’s private vulnerability reporting](https://github.com/OpenPeach-ai/dgc/security/advisories/new). Include the DGC version, operating system, permission mode, reproduction steps, and whether the run used a local or cloud model endpoint.

Security fixes target the latest release. Release archives and checksums are published on vibedgc.com. The current GitHub release has provenance attestations, and the tagged-release workflow is configured to produce them for future builds.
