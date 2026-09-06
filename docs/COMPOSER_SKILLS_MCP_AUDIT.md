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

- [x] Commands: a searchable, keyboard-accessible picker at any whitespace-delimited `/` token;
  preserve text before and after the caret, attachments, selection, IME input, and canceled menus.
- [ ] Meaningful inline actions: open management/settings without consuming the draft; attach
  skills and prompt templates; support plan/review/init flows on CLI and extension; retain goals.
- [x] Skills: `$` and slash discovery, source/description/instructions, multiple explicit skills,
  removal, reload, enabled/disabled state, and draft/session handling.
- [x] Skill execution: exact selected instructions reach native and delegated execution inputs; preserve
  the user's original prompt and resource authority; validate missing/disabled skills and bounds.
- [x] Portable skills: project/user discovery with deterministic precedence, standard frontmatter
  and optional metadata, supporting-resource guidance, explicit-only policy, and diagnostics.
- [x] Skill authoring/install: usable create/install/manage workflows in both clients, including
  local packages with supporting resources; reviewable changes and safe overwrite behavior.
- [ ] Bundled skills: audit existing packages, add useful missing coding/product workflows with
  appropriate capability requirements, examples, and meaningful validation.
- [x] MCP management: shared CLI/editor configuration; add/edit/remove/enable/disable/reconnect;
  useful connection/auth/error state; credentials never enter prompts, logs, or public artifacts.
- [x] MCP context: tools, resources, templates, and prompts are discoverable and usable with
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
- Draft/session restoration implemented: bounded workspace-scoped webview state retains each chat's
  text, selected skills/templates, MCP snapshots, images and cursor. Confirmed rejections remain
  recoverable alongside a newer draft; uncertain delivery is offered for review without automatic
  resubmission. Pending image reads stay with their original chat and block premature submission.
  A backend restart restores the remembered session after settings and workspace grants, before
  releasing queued prompts. Missing sessions preserve the draft in a new chat; restoration timeouts
  retain the draft and close the connection. Loaded goals remain paused. Terminal MCP staging is
  cleared when loading a different saved conversation.
- Restoration verification: 1,387/1,387 Python checks, 63 discovered unittest cases (four optional
  bridge cases skipped), 82/82 extension tests, TypeScript and whitespace checks passed. Tests cover
  crossed acknowledgements, changing workspace grants, backend generation changes, missing/external
  sessions, bounded display history, rejected/uncertain deliveries and delayed image loading. The
  actual VS Code 1.107.1 host test passed with backend-restart session restoration, settings/roots,
  SecretStorage and permission/plan lifecycle checks. The host emitted environment file-watcher
  limit warnings (ENOSPC); this does not constitute a current Cursor UI or live-model verification.
  Setup descriptions that still advertised protocol v5 now correctly describe protocol v6.
- Goal inputs implemented: prefix/suffix/picker actions submit the same complete composer payload;
  the backend validates selections, context and images before replacing the goal or starting work.
  Saved goals retain selected names and snapshots, revalidate skills/templates on resume, reject
  unsupported delegated images, and expose only attachment summaries in status events. Corrupted
  saved inputs prevent resumption. Rejected startup preserves the draft. Classic CLI and TUI share
  template selection, explicit skills, bounded file/image capture and staged MCP snapshot capture;
  TUI resume no longer rereads a saved file attachment. See [Goals](GOALS.md) for behavior and limits.
- Goal input hardening: nested reference frames stay outside skill/tool intent selection. Template
  text loaded after the initial prompt sanitation is redacted again before model/delegated input.
  Client selection limits and host validation prevent silent truncation; the attachment area scrolls
  within a bounded height so many files or a long filename cannot push the composer offscreen.
- Goal verification: 1,387/1,387 Python checks, 73 discovered unittest cases (four optional bridge
  cases skipped), 86/86 extension tests, TypeScript and the actual VS Code 1.107.1 host test passed.
  Tests include native/delegated payloads, persistence failures, pause/reopen/resume, removed/disabled
  packages, template-only redaction, no model start on rejected input, original-goal preservation,
  CLI/TUI dispatch and exact host payload forwarding. Chromium rendered actual product assets at
  460×900 with protocol fixtures: inline selected-goal submission, review, and 64 attachments with
  a long label. The attachment list stayed at 104px, the composer stayed visible, and there was no
  horizontal overflow. Captures remain ignored development evidence, not promoted product imagery.
- Regression follow-up: a repeated process-state sample made the MCP descendant-cleanup assertion
  intermittently disagree with its own diagnostic (child stopped and both readers closed). The
  check now preserves its first terminal observation and handles Linux's documented zombie/dead
  states. Eight initial and 50 diagnostic isolated cleanup runs passed; the final full suite passed
  with this corrected observer. No MCP process-cleanup implementation was relaxed. The editor host
  still emits environment ENOSPC watcher warnings but completes its checks.
- Current remaining work: meaningful plan/review/init flows; bundled-skill audit/additions; remote
  host OAuth behavior; real local/subscription model runs and actual Cursor verification; final
  docs/site/version updates; reviewed-source/CI gates and publication to every release channel.
- Review foundation: added a bounded native `git_diff` tool usable in plan mode. It compares stored
  Git objects and raw workspace files without running repository filters, diff drivers, or transports.
  It supports staged/working/untracked changes, branch merge-base review, and individual commits.
  Scope, symlinks, conflicts, byte/line/output limits and cancellation are explicit. The Git capture
  helper now also closes successful process pipes instead of relying on garbage collection.
- Audit follow-up discovered while tracing review: the extension's automatic file-change summary
  still uses ordinary `git diff --numstat`. Disabling external diff and textconv does not disable
  clean filters. Its Git executable/environment boundary also needs the same review as native tools.
  Fix and verify this before release; the native tool alone does not resolve this host-side gap.
