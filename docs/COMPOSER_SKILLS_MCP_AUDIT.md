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
- The webview has no persisted draft state. Skills/context can remain in memory across a session
  change instead of belonging to the draft's session, and a webview reload can lose them.
- Goal submission explicitly excludes drafts with attachments, so adding a skill or MCP snapshot
  prevents the inline goal action from starting that prepared request. Goal start needs the same
  validated prompt payload and rejected-draft recovery as a normal send.

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
- Skill management implemented: portable project/user `.agents/skills` discovery; bounded scalar
  frontmatter/sidecar metadata; explicit-only policy; shared enable/disable commands and controls;
  refresh before native/delegated execution; create and local-package install in CLI/TUI/editor.
  Package installation copies supporting resources without execution or overwrite, rejects links,
  private/generated files and excessive input, and publishes the discovery marker last. The TUI's
  old name-based personal-directory deletion was replaced with disabling the selected skill.
- Skill-management verification: 1,387/1,387 Python checks (including 44 unittest cases), 71/71
  extension tests, TypeScript, and whitespace validation passed. The first broad run caught two
  assertions tied to the old catalog shape and an overlong help token; metadata assertions now
  verify enablement and no host paths, and the help token remains readable. Current package tests
  include native/delegated disabled/removed selections, source edits, source precedence, unsafe
  sidecars, package links/private files/size limits, and preserving supporting files without executing
  them. Real editor/model verification and the remaining MCP/composer work are still pending.
- MCP context and management implemented: bounded live resources/templates/prompts catalogs;
  shared modern MRTR and legacy request completion; exact server-owned resource reads; prompt
  argument validation; safe text/media handling; normal MCP permission/hook/redaction boundaries;
  editor preview and removable draft snapshots; terminal snapshot staging. CLI, TUI and editor
  `/mcp` commands share add/edit/remove/enable/disable/reconnect and context operations. Interactive
  editor operations run off the stdin loop so input decisions and cancellation remain available.
- Remote MCP startup fix: the reviewed `mcp-remote@0.8.3` bridge uses its known initialize handshake
  and is no longer killed by the three-second modern probe. Explicit connects have a cancellable
  OAuth window and transient browser sign-in cards. Separate disablement preserves credential
  identity; runtime credentials remain available to a same-server reconnect.
- Real-bridge evidence: four isolated loopback tests passed against the actual 0.8.3 package,
  covering public HTTP, bearer auth, slow startup without process restart, OAuth PKCE, cached login,
  expired-token 401 refresh, cancellation, declining sign-in and owner-private token files. A
  proactive-refresh issue in the bridge's path-specific resource/issuer comparison remains recorded
  in [MCP context and authentication](MCP_CONTEXT.md). SSH callback forwarding and provider-specific
  OAuth/device-code behavior still need actual remote-host verification.
- Current MCP tests also prove deny rules prevent server execution, fetched text is redacted before
  preview, native/delegated turns receive inert snapshots, headless completion releases its worker
  before the response, and the standalone CLI can add/read/disable/remove a real subprocess without
  invoking a model. Chromium rendered the actual webview HTML/CSS/JS at 460×900: browse, Markdown
  preview, attachment, and inline `/` selection preserved the draft and snapshot without horizontal
  overflow. This used protocol fixtures, not an actual extension host or a live model. Browser
  artifacts stay in ignored `output/playwright`; they are not promoted product captures.
- MCP regression verification: 1,387/1,387 Python checks, with 60 discovered unittest cases (four
  optional bridge cases skipped there and run separately), 73/73 extension tests, TypeScript and
  whitespace checks passed. A final deadline test also verifies that a modern input decision cannot
  be sent after its originating request expires. Escape and the panel close button cancel pending
  context operations and ignore their late results. Initial broad runs caught old fixture assumptions
  about runtime arguments and a removed terminal preflight; these were corrected before the green
  run. This evidence is a development checkpoint, not a release or full-goal completion claim.
- Remaining before release: draft/session persistence and goal interaction for selected skills and
  context; meaningful plan/review/init flows; the bundled-skill audit/additions; real local and
  subscription model runs; actual editor/Cursor host verification; remote-host authentication;
  final documentation/site/version updates; source/artifact review, CI and multi-channel publication.
