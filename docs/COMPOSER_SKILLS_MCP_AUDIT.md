# Composer, skills, and MCP parity audit

Status: implementation in progress. This document tracks the full requested pass; an unchecked
item is not a release claim. Baseline: CLI 0.28.0 / extension 0.15.0 (`de17fac`).

## Reference and scope

The requested behavior is a composer that can discover and use commands, skills, and connected
tools after text has already been entered, together with equivalent CLI functionality. Reference
behavior is checked against the installed/reference Codex extension and official documentation:

- [Developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=ide)
- [Build skills](https://learn.chatgpt.com/docs/build-skills)
- [MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

Keep DGC's provider independence, purple theme, shared configuration, bounded input handling,
permission ordering, and private credential storage. Do not expose controls that merely imply an
unimplemented capability. Document any provider-owned execution boundary explicitly.

## Confirmed baseline gaps

- The webview deliberately filters inline `/` results to `/goal`; other commands disappear.
- There is no `$` skill completion in the composer. The skill-library action replaces the draft.
- Terminal completion only recognizes a slash at the beginning of the entire input.
- Explicit skill mentions only influence the native agent's skill catalog. They do not guarantee
  that selected instructions are loaded, and delegated turns have no equivalent DGC skill input.
- Skill discovery does not support the portable `.agents/skills` locations, per-skill enablement,
  or explicit-only invocation policy. The frontmatter parser mishandles YAML block descriptions.
- The classic CLI's `/mcp` only prints status; the editor/TUI expose more management actions.
- MCP exposes tools, but no resource/template/prompt browsing or retrieval. Per-server enablement
  and individual reconnect controls are absent from the editor management surface.
- An extension/CLI update skew caused a startup protocol error in the previous rollout. This
  release must verify compatibility and the actual installed Cursor extension, not just VS Code.

## Completion requirements and evidence

- [ ] Commands: a searchable, keyboard-accessible picker at any whitespace-delimited `/` token;
  preserve text before and after the caret, attachments, selection, IME input, and canceled menus.
- [ ] Meaningful inline actions: open management/settings without consuming the draft; attach
  skills and prompt templates; support plan/review/init flows on CLI and extension; retain goals.
- [ ] Skills: `$` and slash discovery, source/description/instructions, multiple explicit skills,
  removal, reload, enabled/disabled state, and draft/session handling.
- [ ] Skill execution: exact selected instructions reach native and delegated models; preserve
  the user's original prompt and resource authority; validate missing/disabled skills and bounds.
- [ ] Portable skills: project/user discovery with deterministic precedence, standard frontmatter
  and optional metadata, supporting-resource guidance, explicit-only policy, and diagnostics.
- [ ] Skill authoring/install: usable create/install/manage workflows in both clients, including
  local packages with supporting resources; reviewable changes and safe overwrite behavior.
- [ ] Bundled skills: audit existing packages, add useful missing coding/product workflows with
  appropriate capability requirements, examples, and meaningful validation.
- [ ] MCP management: shared CLI/editor configuration; add/edit/remove/enable/disable/reconnect;
  useful connection/auth/error state; credentials never enter prompts, logs, or public artifacts.
- [ ] MCP context: tools, resources, templates, and prompts are discoverable and usable with
  bounded pagination/results, cancellation, per-server authority, and normal permission checks.
- [ ] MCP authentication: verify remote HTTP/bearer/OAuth behavior and recovery rather than
  relying on an untested bridge; expose only controls supported by the actual implementation.
- [ ] Runtime verification: native local model and subscription runs, real CLI interaction,
  browser-rendered extension flows, actual editor host activation, regression/security checks.
- [ ] Documentation: command/skill/MCP guides, bundled-skill inventory, migration notes, website
  examples, changelog, and this evidence matrix reflect the final implementation.
- [ ] Release: clean reviewed commit; CI and release gates; scan source/history/artifacts for
  secrets and private data; publish identical reviewed bytes to GitHub, website, Marketplace,
  and Open VSX; verify public versions/checksums and update the actual Cursor installation.

## Work log

- 2026-09-06: inspected the clean public baseline, reproduced the inline command restriction in
  source, and traced the native/delegated skill and MCP management paths. Implementation branch:
  `feat/composer-skills-mcp`.
- Foundation implemented: inline command/skill selection, removable skill/template chips, draft
  preservation through management menus, terminal skill selection, and deterministic explicit skill
  instructions for native/delegated execution. Selection errors retain the rejected draft. New
  fields are additive protocol-v6 capabilities; an older backend receives no unsupported selection
  frames. Skill context is bounded, credential-redacted, and removed after the turn.
- Foundation verification: 1,387/1,387 Python checks (including 36 unittest cases), 70/70 extension
  tests, TypeScript checks, and whitespace validation passed. The first broad run exposed an
  outdated terminal test double; the fixture now uses a real prompt-toolkit Buffer. These results
  do not yet prove the remaining skill/MCP requirements or a production/editor-host rollout.
