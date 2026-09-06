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
- [x] Meaningful inline actions: open management/settings without consuming the draft; attach
  skills and prompt templates; support plan/review/init flows on CLI and extension; retain goals.
- [x] Skills: `$` and slash discovery, source/description/instructions, multiple explicit skills,
  removal, reload, enabled/disabled state, and draft/session handling.
- [x] Skill execution: exact selected instructions reach native and delegated execution inputs; preserve
  the user's original prompt and resource authority; validate missing/disabled skills and bounds.
- [x] Portable skills: project/user discovery with deterministic precedence, standard frontmatter
  and optional metadata, supporting-resource guidance, explicit-only policy, and diagnostics.
- [x] Skill authoring/install: usable create/install/manage workflows in both clients, including
  local packages with supporting resources; reviewable changes and safe overwrite behavior.
- [x] Bundled skills: audit existing packages, add useful missing coding/product workflows with
  appropriate capability requirements, examples, and meaningful validation.
- [x] MCP management: shared CLI/editor configuration; add/edit/remove/enable/disable/reconnect;
  useful connection/auth/error state; credentials never enter prompts, logs, or public artifacts.
- [x] MCP context: tools, resources, templates, and prompts are discoverable and usable with
  bounded pagination/results, cancellation, per-server authority, and normal permission checks.
- [x] MCP authentication: verify remote HTTP/bearer/OAuth behavior and recovery rather than
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
- Shared workflows implemented: `/plan`, `/review`, and `/init` now have real CLI/TUI/editor routes.
  Inline choices prepare the draft for an explicit send; typed prefix/suffix forms keep selected
  inputs and correlated rejection recovery. Review uses plan mode and concrete comparison targets;
  init uses ordinary file edits after inspection instead of precreating DGC.md. Bare plan enters
  read-only mode rather than toggling back to execution. Native and delegated execution use the same
  workflow instructions. User-facing live/restored history shows the original command.
- Workflow hardening: skill preflight uses fresh discovery without mutating a running turn's
  catalog; missing/disabled or over-budget selections reject before mode changes. A paused goal no
  longer injects stale explicit skill instructions into an unrelated turn. Terminal file mentions
  expand only in the execution body, preserving the original display metadata and avoiding duplicate
  file reads. Active goals must be paused before starting a separate workflow.
- Workflow development evidence: Chromium rendered the actual product assets at 460×900 with a
  protocol fixture. Mid-sentence review selection preserved both surrounding text and a selected
  skill; explicit send carried the selection; rejection restored it. The composer remained visible
  with no horizontal overflow. Captures are ignored development evidence. Actual VS Code 1.107.1
  host checks passed with typed workflow/skill/context routing in addition to session, permission,
  goal and workspace lifecycle checks. These do not establish live model or Cursor verification.
- Workflow regression verification: 1,387/1,387 Python checks, including 87 discovered unittest
  cases (four optional real-bridge cases skipped), 89/89 extension tests, TypeScript/build and
  actual editor-host checks passed. Initial failures caught an outdated completion expectation and
  a source-spelling assertion whose runtime attachment checks already passed; the latter was removed.
  The first new host fixture emitted an invalid terminal event; correcting it to the generated v6
  schema made the complete host run pass. This remains a development checkpoint, not publication.
- Remaining release work now includes the host file-change inspection hardening, bundled-skill
  audit/additions, remote-host OAuth behavior, live local/subscription runs, actual Cursor checks,
  final docs/site/version updates, full source/history/artifact review, CI and publication.
- Host inspection gap resolved: automatic change summaries and previews now use the CLI's bounded
  object/no-follow file reader through correlated, capability-gated requests. No host-side Git diff
  command or racy file-content read remains. Sparse omissions, staged-only changes, overlapping
  roots, missing reports, partial counts, duplicate folder labels and backend restart cancellation
  have explicit handling. Two bounded inspection workers leave model and approval handling usable.
  Owner preview bodies are not forwarded to the webview conversation or model input.
- Inspection verification: 1,387/1,387 Python checks, 96 discovered unittest cases (four optional
  bridge cases skipped), 90/90 extension tests, TypeScript/build and actual VS Code 1.107.1 host
  checks passed. Real Git fixtures exercise hostile filters, symlinks, initial commits, sparse
  checkouts, staged-only previews, multiroot bounds and cancellation. The host opens an actual
  native diff. Its initial test incorrectly treated a waiting-for-roots notice as a completed
  report; it now waits for the populated summary. A separate regression proves pending requests
  reject immediately on backend disposal and release their listeners. See [Git review](GIT_REVIEW.md).
- Bundled skills audited: 22 packages now include browser testing, CI diagnosis, PR feedback,
  skill authoring and MCP server development, with narrow routing and five portable UI labels.
  Existing guidance no longer recommends blanket shell-prefix allowances, raw secret-value searches,
  weakening tests to pass, repeated approval gates outside plan mode or DGC branding on other products.
  All 22 packages pass the skill validator; CLI/editor catalog, selection and nearby nonmatching tasks
  have runtime tests. A development wheel includes every body and UI metadata file.
- Skill verification: 1,387/1,387 Python checks and 98 discovered unittest cases passed (four optional
  bridge skips). Chromium exercised actual UI assets with the real public skill catalog: filtering,
  labels, attaching without replacing the draft and exact selected-name submission. At 460×900 the
  composer stayed visible without horizontal overflow. A live Codex subscription one-shot created
  a project skill and ran local validation; independent DGC discovery and selection checks passed.
  The local-model one-shot created a package but reached its test time limit before verification,
  so it is not a successful end-to-end result. That run also exposed a zero CLI exit status on
  timeout, which requires a separate correction before release. Its generated package overgeneralized
  temporary authoring restrictions; skill-author now explicitly distinguishes one-off constraints
  from reusable policy. A repeat with the revised instructions is in progress.
- Native skill repeat completed: the actual local-model CLI created a 211-word project package and
  ran its local validation. Independent DGC parsing/discovery confirmed the project source, exact
  invocation and exclusion from a generic API-edit request. The generated package did not repeat the
  earlier blanket network/dependency restriction. Both live CLI routes used isolated DGC profiles;
  this is source-run evidence, not yet installed-release or actual Cursor verification.
- Timeout/cancellation success bug fixed: native interrupted paths now return failure. The one-shot
  CLI exits nonzero, the editor emits an error/cancelled terminal event and active goals pause before
  any premature completion report is applied. Focused tests cover deadlines before and during model
  generation, subsequent successful turns, goal reports, CLI status, editor status and user/provider
  cancellation. Full regression: 1,387/1,387 Python checks and 102 discovered cases passed (four
  optional real-bridge skips). No editor JavaScript change was needed for this outcome correction.
- MCP callback forwarding implemented: only a validated callback from the pinned local bridge can
  request editor port forwarding before the browser opens. The registered redirect stays unchanged;
  incompatible mappings explain same-port desktop forwarding and reconnect. Duplicate acceptance,
  cancellation, expired requests and backend replacement cannot launch or acknowledge stale sign-in.
  Generic MCP URL requests do not acquire forwarding authority. See [MCP context](MCP_CONTEXT.md)
  for remote-editor and provider-owned device-code limits.
- Authentication checkpoint: the actual bridge passed all four HTTP/bearer/OAuth/PKCE/cache/refresh/
  cancellation tests again. Full regression passed 1,387/1,387 checks and 104 discovered Python cases
  (four optional bridge skips), 95/95 extension tests, TypeScript/build and the VS Code 1.107.1 host.
  A public DeepWiki HTTPS smoke attempt failed with a network connection timeout from this machine;
  no public-endpoint success is claimed. Forwarding behavior is covered through the editor API test
  boundary; an actual SSH identity-provider exchange and browser-only remote editors are not claimed.
- Live editor completion audit found that an ordinary timed native turn could stop immediately after
  a passing test, before selected-skill obligations or a goal report. Normal turns now return that
  evidence to the model and retain tools for remaining work. Immediate verifier-only completion is
  an explicit advanced opt-in and cannot skip active goals, explicit skills or unfinished todos.
  Cancellation between sequential tools now returns failure while preserving completed results and
  repairing unexecuted calls. Sentence-ending periods no longer hide a known prose skill invocation;
  installed exact dotted names retain precedence.
- Completion regression passed 1,387/1,387 checks and 110 discovered Python cases (four optional
  bridge skips). The first broad run found two old cancellation assertions that required success;
  they now require failure while preserving all transcript-integrity checks. The selected-skill
  regression exposed the punctuation issue above before the final green run.
- Live VS Code 1.107.1 + actual source CLI + local Qwen completed a goal using a resource fetched
  from an actual MCP subprocess and two selected skills. Independent assertions verified the unique
  resource contract and selected skill's saved verification note; both generated unit tests passed
  again. The corrected run completed in one cycle (109 seconds, 42,992 reported tokens). An earlier
  run paused truthfully at its 25,000-token boundary and is not counted as a completed run. This uses
  an isolated synthetic workspace/profile and a fixture MCP server with a real model and editor host.
- Command resource cleanup: foreground and background output readers now close their pipes after
  drainage. Completed background handles retain their captured output without retaining descriptors.
  Real-process regressions cover repeated successful/failed commands and a retained background
  result; the full 1,387-check / 110-case run above includes these checks without the earlier pipe
  ResourceWarning. Existing timeout, cancellation, process-tree and bounded-output checks remain green.
- Live subscription-editor audit found a critical execution boundary defect: vendor processes
  inherited the editor's open NDJSON stdin. A vendor reading piped input could wait indefinitely
  before generation or consume frontend control frames. Noninteractive vendor launches now use
  closed stdin; their prompts already travel through their engine arguments. A real subprocess
  regression keeps the parent's control pipe open and proves its pending frame remains unread.
- After the stdin correction, actual VS Code 1.107.1 + source DGC + Codex subscription completed the
  same MCP-resource/two-skill goal in one cycle (32 seconds). Independent contract assertions, the
  selected skill's verification note and both generated tests passed. The vendor reported 105,462
  tokens during its single turn, exceeding the test's 60,000-token budget as permitted by the
  documented between-vendor-turn budget boundary; this is not an in-flight hard token cap.
  Full regression passed 1,387/1,387 checks and 111 discovered Python cases (four bridge skips).
