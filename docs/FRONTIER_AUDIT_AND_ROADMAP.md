# DGC Frontier Audit and Implementation Roadmap

Status: implementation contract + local-candidate delivery report
Audit date: 2026-08-25
Audited local version: DGC 0.20.8 / editor extension 0.8.1
Scope: core agent, LLM/provider layer, tools, permissions and sandboxing, context and sessions,
CLI/TUI, VS Code/Cursor extension, ACP/headless protocols, benchmarks, website, GitHub, installers,
and release operations.

## Executive verdict

DGC is already a real coding harness. Its TUI, local-model support, tolerant edit matcher, plan
artifacts, skills, sub-agents, background tools, checkpoints, and provider flexibility are meaningful
strengths. The product is not behind because it lacks features.

At the audit baseline, it was behind the frontier because several boundaries were not dependable
under adversarial or long-running workloads:

1. The permission layer labels shell commands as read-only using unsafe token heuristics.
2. Filesystem and session paths are not consistently confined to the project/session roots.
3. Context compaction can split an assistant tool-call group from its tool results.
4. Headless, ACP, and multi-agent paths share mutable state without a serialized runtime or isolated
   worktrees.
5. The provider layer is a Chat Completions compatibility client rather than a capability-negotiated,
   stateful provider runtime.
6. Secrets, sessions, and prompt history are stored or transported too broadly.
7. The benchmark and release systems cannot yet support a trustworthy frontier claim.

The strategy is therefore **correctness and evidence before feature expansion**. DGC should retain
its strongest differentiators—excellent local-model behavior and a polished terminal experience—while
rebuilding the execution, provider, protocol, evaluation, and release boundaries beneath them.

## Implementation status — 2026-08-26 local candidate

The ordered plan below was written before implementation. The local main branch now contains the
hardened candidate, but it has deliberately **not** been published to GitHub, the website, PyPI, or
the editor registries: those are external release actions that require a reviewed clean commit/tag.

| Area | Implemented and verified in this local candidate | Still required for a defensible frontier claim |
|---|---|---|
| Policy and filesystem | Fail-closed shell approval, canonical workspace boundary, symlink/traversal rejection (including bounded descendant discovery, exact model-visible grep reads, and late parent swaps across structured files, repository maps, static code intelligence, checkpoints and recovery), explicit session-scoped external roots, deny→ask→allow precedence | Windows OS sandbox and a larger cross-platform adversarial corpus |
| OS sandbox | Linux bubblewrap isolates user/process/network namespaces, hides ambient home/secrets, uses private tmp/run, exposes only the writable project, blocks network by default, and never bypasses approval; macOS policy also blocks writes/network; an explicitly requested sandbox fails closed if its backend is unavailable, inside the writable workspace, or resolves to a non-executable; runtime-injection environment names cannot be opted back in | Windows implementation; macOS integration runner and seccomp/resource quotas |
| Runtime correctness | Atomic file/session writes with bounded post-crash temp reclamation, UUID/private schema-v6 sessions with validated monotonic generations, crash-released cross-process session-family leases and compare-and-swap writes, content-addressed exact conversation/file checkpoints durable across resume and compaction with late-symlink-safe capture/restore, fail-closed pre-edit persistence, transactional rewind persistence/rollback, exact bounded transactional last-known-good recovery, transactional exact-generation compaction, provider-safe tool-group repair/compaction including final-commit closure after interruption, truthful terminal turn outcomes, split-stream-safe credential redaction across model/tool/wire/durable conversation boundaries, immediate text-tool fallback, full process-group cleanup, bounded redacted lifecycle-hook output, bounded internal-Git diagnostics, and bounded redacted foreground/background command output with session-scoped continuation handles | Optional at-rest encryption for exact rewind file snapshots and broader cross-platform crash-fuzz campaigns |
| Concurrency | Per-session ACP/headless runtimes, truthful busy/error completion, race-free bounded editor follow-up FIFO across completion/cancel boundaries, startup-safe cancellation in editor/ACP/classic/TUI workers, owner-private crash-safe cross-process checkout/session-family/full-turn leases, generation preflight before hooks or model execution, revision/existence guards that reject stale transcript/metrics/goal/name/plan/workspace/delete mutations, active-turn exclusion for deletion/rewind/compaction/retained work and TUI workspace attach/finalize, pre-edit snapshots and rewind captured/restored inside the checkout lease, background leases held to process exit, lifecycle hooks serialized under the same checkout lease with one cancellable batch deadline, separate TUI config/MCP state, automatic source-leased TUI fleet worktrees whose internal Git is pinned outside the repository, non-interactive, hook-suppressed, output-bounded, and process-group reaped, exact dirty baselines and safe resume/retention, manual named worktrees, automatic `task` worktrees, bounded concurrent all-task batches, deterministic conflict-safe integration, plus typed terminal/editor retained-task inspect/apply/drop recovery with parent rewind | Cross-platform fleet crash/reopen soak and measured local/remote fan-out latency/throughput |
| Model effectiveness | Typed provider profiles and endpoint+model capability negotiation; native Ollama chat/model discovery with exact thinking/tool continuation, options and usage; OpenAI Responses with opt-in stored continuation, default stateless encrypted-reasoning replay, prompt-cache routing, nested usage accounting; cancellation-safe bounded retry/backoff and streamed-response cleanup across all transports; compatible-provider tool-delta normalization without call corruption; independently scoped primary/fallback/sub-agent transports and credentials; idle-only serialized/cancelable title and suggestion generation; stable call IDs, hash-addressed atomic `apply_patch`, repository map, bounded static code intelligence plus explicitly configured managed LSP symbols/diagnostics/definitions/references with capped per-project reuse, adaptive intent-aware tool exposure, parallel independent reads, lean plan-mode tools, stronger convergence guards | Native transports beyond Ollama, server-side compaction, richer per-model discovery, optional tree-sitter parsing and measured code-intelligence accuracy/latency |
| MCP / ACP | Dual-era stdio MCP negotiation: real stateless 2026 discovery/per-request metadata with fresh-process legacy fallback, deterministic resource-bounded tool catalogs, validated TTL/scope caching, generation-safe ID-correlated subscriptions plus legacy invalidation, and roots/elicitation/sampling MRTR; frontend-specific capability negotiation, credential-safe validated forms, consent-gated URL navigation, twice-approved tools/context-free sampling, associated legacy callbacks, typed content/resources, correlated progress, severity-filtered logging, cancellation, visible failures and process cleanup; stable ACP v1 multi-session operations, plan approval, resources, roots and stdio MCP | Wider external MCP/ACP conformance, durable/shared cache policy if measurements justify it, and a published SDK/schema package |
| Editor | Adapter-backed authenticated model discovery (including native Ollama tags), endpoint-scoped SecretStorage with plaintext-setting removal and stale-key invalidation, installed-host migration/backend-restart/endpoint-invalidation evidence, typed selection/tab/diagnostic resources and canonical multi-root file mentions with display/path separation, acknowledged live multi-root grant reconciliation (including active-turn deferral and removal), accurate failures/IDs/usage/reset/plan feedback, modal auto warning, a single-source generated protocol-v3 Python/TypeScript/JSON contract, exact-wire validation with optional-field normalization, bounded startup/backpressure queues with priority decision/cancel frames, first-response-wins request correlation, stale/restart rejection, strict event shape/sequence validation, restart-on-next-command recovery, real installed-VS-Code activation/command registration/webview-handshake and live multi-root lifecycle evidence, and automated keyboard/ARIA/reduced-motion coverage | Cross-platform OS-keychain relaunch and installed-host decision interaction scenarios plus manual screen-reader, zoom, forced-colors, and contrast audit |
| Evaluation | Pinned six-harness toolchain; engine-scoped schema-v3 records; executable/toolchain provenance; bounded redacted traces; per-exercise HOME; real round-two session continuation; isolated grading; all 225 canonical references validated; transport-normalized reasoning; synchronized provider-side usage and overlap-aware latency; crash-safe argument-free DGC built-in timing by bounded tool name; strict clean/full-corpus publication gate | Complete 225-task same-model DGC/Codex/OpenCode/Goose/Pi/Aider league on controlled hardware, then optimize from attributed traces |
| Delivery | Normal non-force Git flow scripts, Linux/macOS/Windows CI, CodeQL, Dependabot, pinned editor release tooling, deterministic source archive, dependency locks, CycloneDX SBOM, attestable tag release, transactional site promotion docs | Branch-protection configuration, external release signing/promotion rehearsal, clean-install matrix, public-history migration |

**Current verdict:** the code is a substantially safer and more capable release candidate, not yet
a proven frontier leader. The blocking evidence is the complete same-model peer league and production
release rehearsal—not another round of unmeasured feature claims.

## What is correct today

### Agent and local-model behavior

- A genuine multi-turn tool loop with native tool calls and a text-tool fallback.
- Provider-aware reasoning controls, bounded output, cancellation, retry/backoff, context-overflow
  recovery, a thinking watchdog, repeated-tool guards, edit-grind recovery, and completion nudges.
- Mid-turn user steering, goals, todos, hooks, skills, sub-agents, fallback models, MCP tools,
  artifacts, checkpoints, and proactive/reactive compaction are integrated into one agent surface.
- Text-tool parsing is unusually useful for small local models that do not implement native tools.
- The system prompt is mode-aware and already attempts to reduce instructions that cannot be used.

### Editing

- `edit_file` tolerates quote confusables, CRLF drift, reindentation, a changed interior line, and
  elisions while refusing ambiguous matches.
- `multi_edit` lets a model submit several edits in one call.
- The 19,591-case edit corpus currently reports 17,443 accepted cases (89.0%) with zero recorded
  wrong-applies. The corpus is valuable and should become a required CI artifact.
- Long command output is drained through streaming credential masking into a bounded in-process
  head/tail result. `bash_output` exposes line paging and case-insensitive literal search, works
  independently of the command sandbox's `/tmp`, isolates handles between agent sessions, expires
  them after 30 minutes, and truthfully marks output omitted at the 2 MB retention ceiling.

### CLI/TUI product

- The full-screen TUI has a coherent visual system, responsive composer, streaming reasoning,
  grouped tool cards, readable diffs, context display, dashboard/fleet UI, artifacts, documentation,
  settings, and session controls.
- The classic CLI gives a useful fallback for terminals that cannot support the full-screen UI.
- The live website accurately communicates the product's strongest visual differentiator and is
  responsive at desktop and phone widths.

### Extension and integration surface

- The editor extension drives the same Python runtime rather than maintaining a second agent.
- NDJSON streaming, permissions, diffs, session resume/rewind, editor selection context, and a
  settings panel are already present.
- The webview uses a Content Security Policy and generally escapes model/tool output.
- ACP support establishes the right architectural direction even though the current adapter is not
  production-safe.

### Distribution

- The installer is non-root, creates a private virtualenv, and verifies a published SHA-256 when it
  is present.
- Site, CLI, extension, GitHub release, and update manifests use a consistent current domain.
- GitHub release scripts verify pushed/tagged SHAs in several places.
- Marketplace and Open VSX listings exist for extension 0.8.1.

## Evidence baseline and current local-candidate gates

| Gate | Audit baseline | Current local candidate | Meaning |
|---|---:|---:|---|
| Python test harness | 225 / 226 | 773 / 773 | Environment-independent unit, adversarial, interaction-contract, provider, protocol, benchmark-control and mock-model E2E coverage. |
| Python compile/import | Pass | Pass | `compileall` succeeds. |
| Python dependency/package | Pass | Pass | Locked runtime set, `pip check`, wheel build and dry-run install succeed. |
| Extension typecheck | Pass | Pass | TypeScript compiles. |
| Extension tests | 2 / 2 | 18 / 18 + host 1 / 1 | jsdom protocol/render/safety/accessibility, real spawned-child transport/backpressure/decision-race flows, and activation/command registration/webview handshake inside installed VS Code are green. |
| Extension dependency audit | 1 moderate | 0 | Updated build chain; `npm audit --audit-level=moderate` is clean. |
| Edit microbenchmark | 17,443 / 19,591 | 17,443 / 19,591 | 89.0% accepted and zero wrong-applies; unchanged corpus baseline. |
| Release preflight | None | Previous clean candidate passed; current rerun deferred | Python suite, edit corpus, editor type/test/package/audit, dependency check, SBOM and script gates must pass together after the explicit release freeze is lifted. |
| Polyglot run | 40 / 52 pass@2 | Not rerun | 76.9% on 26 C++ + 26 Go tasks only; not a complete or comparative benchmark. |
| Polyglot agent timeouts | 28 / 67 rounds | Not rerun | Original main operational failure; the new convergence/runtime work must be measured. |
| Grader reference validation | 6 / 6 | 225 / 225 | Every canonical solution passes its official suite; validator now maps Rust manifests and Java helpers correctly. |
| Six-harness protocol canary | None | 6 / 6 pass on `python/proverb` | Final replacement run used one loaded model, official grading, transport reasoning-off, and synchronized provider usage for every engine. Pi 73.7s, DGC 83.2s, Codex 85.2s, Aider 86.4s, OpenCode 89.7s, Goose 101.6s; zero reasoning tokens. This one-task smoke is not ranking evidence. |
| Stratified six-harness diagnostic | None | 12 tasks × 6 engines complete | Same model, controlled hardware, two tasks in each of six languages, official isolated grading, reasoning-off transport and synchronized usage. It is trace/controls evidence, not ranking evidence or a replacement for the 225-task league. |
| Full controlled league | None | New replacement run required | Attempts 1–3 exposed compaction-sensitive counters, hard-timeout persistence loss, deleted isolated-grader paths, and a 573-second late provider completion. Targeted attempt 4 on `cpp/binary-search-tree` validated portable recovery paths and the fail-closed quiescence boundary, then exposed four retry-generated provider completions after deadline cancellation and a premature five-failure stop despite landed edits. After those fixes, clean commit `9c45749` solved the same hard case on round one: 12/12 tests in 1,022.6s, 23 provider requests exactly matching the journal, zero disconnected/reasoning requests, 13 landed edits, one edit mismatch, and no timeout. All partial attempts remain diagnostic only. The controls are covered by 453 checks; the complete six-engine league still requires a new clean candidate run. |
| Public GitHub history | 1 commit | External state unchanged | New scripts forbid force/snapshot publishing, but the public history has not been migrated. |

The existing 40/52 result is encouraging, but it is not publishable evidence of parity. It covers
only two languages, includes successful-but-timed-out runs, records no token usage or model digest,
and predates the controlled protocol. The six-harness one-task smoke proves installation, endpoint
routing, grading, reasoning normalization, and accounting—not comparative quality. With `n=1`, even
a pass has a Wilson 95% interval of 20.7–100%; the complete 225-task clean league remains the evidence
gate.

### Controlled stratified diagnostic — non-ranking evidence

The clean synthetic runner commit `8ff345f4` completed a 12-task diagnostic (the first two
exercises in each language) across all six harnesses using `qwen3.8:27b-q4km`, immutable model
digest `sha256:9c155f…d972f`, the clean dataset commit `7e0611e7`, the same NVIDIA GB10 host,
transport-enforced reasoning off, two rounds, and 600 seconds per round. The strict publication
gate correctly rejected this limited corpus; the comparison below was generated only with the
explicit `--allow-partial` diagnostic flag.

| Engine | pass@1 | pass@2 | Average agent seconds/task | Timed-out rounds |
|---|---:|---:|---:|---:|
| Codex | 12 / 12 | 12 / 12 | 143.6 | 0 |
| DGC (pre-trace-fix snapshot) | 12 / 12 | 12 / 12 | 216.2 | 1 |
| Pi | 11 / 12 | 12 / 12 | 202.0 | 1 |
| Goose | 11 / 12 | 11 / 12 | 190.4 | 0 |
| OpenCode | 11 / 12 | 11 / 12 | 249.0 | 3 |
| Aider | 7 / 12 | 9 / 12 | 661.2 | 6 |

The diagnostic establishes that DGC can match Codex's sample pass rate and already exceeds the
other measured peers on at least one hard stress case. It also exposes a repeatable efficiency gap:
Codex averaged 1.5× less wall time. DGC's old JavaScript alphametics files passed at the 600-second
external kill after tests were already green, while Rust runs received contradictory shell status
or had legitimate re-tests blocked.

A clean post-trace DGC snapshot (`4182c6e`) then reran the same 12 tasks. It scored 11/12 because a
new stochastic Go alphametics trajectory failed both rounds, so its aggregate 222.6-second average
is not evidence of a universal quality improvement. On the other 11 paired tasks that passed in
both runs, however, average time fell from 194.0 to 140.2 seconds (27.8%), model requests fell from
101 to 68, timed-out rounds fell from one to zero, and edit failures fell from two to one. The most
diagnostic paired traces were:

| Task | Before | After | Trace evidence |
|---|---:|---:|---|
| JavaScript alphametics | 600s / 20 requests | 355s / 6 requests | Jest passed, then the next no-tools request produced the final summary. |
| Rust accumulate | 173s / 12 requests | 66s / 6 requests | No compiler failure was mislabeled `exit code: 0`. |
| Rust acronym | 322s / 23 requests | 145s / 13 requests | Five test commands ran after intervening edits with no false loop block. |

These paired results justify the controller fixes, but the 12-task confidence intervals remain wide
and the failed Go rerun demonstrates sampling variance. No leaderboard, parity, or frontier claim may
be published until the reviewed clean 225-task × six-engine league passes the existing publication
gate.

## Original critical and high-severity findings

These findings preserve the audit trail. The working-tree remediation state is summarized above;
items described in present tense below reflect the pre-implementation baseline unless explicitly
listed under “still required.”

### P0 — execution security

1. **Unsafe read-only shell classification.** Commands such as `echo x > file`,
   `echo $(touch file)`, `find . -delete`, `env sh -c '...'`, `git branch new`, and
   `git branch -D main` are auto-approved as read-only. `bash_kill` is also classified as read-only.
   Replace the heuristic with a fail-closed parser/policy and treat process mutation as mutation.

2. **No canonical project boundary.** Absolute paths, `..`, and symlinks can reach outside the
   project. Rules match the model-supplied path rather than the canonical target. Resolve paths,
   reject escapes by default, add an explicit `external_directory` permission, and match rules on
   canonical paths.

3. **The optional sandbox is not a security boundary matching its claims.** It read-binds the
   entire host filesystem, inherits the environment, permits network access, and writes to the host
   `/tmp`; any sandboxed shell call is then auto-approved. Introduce explicit filesystem, network,
   environment, and process policies. Sandbox activation must not by itself bypass approval policy.

4. **Secret exposure.** API keys live in plaintext config and VS Code settings; `/connect ... KEY`
   and `/subagent ... KEY` can enter persistent prompt history; `dgc serve` emits the sub-agent key
   to the webview. Use OS keyring/VS Code SecretStorage, masked input, redaction, and reference IDs.

5. **Web and remote-skill trust.** `web_fetch` can reach loopback, link-local, private-network, and
   non-HTTP targets through redirects. Downloaded skills become persistent instructions without a
   provenance/trust gate. Add SSRF defenses, redirect revalidation, size/type limits, content
   isolation, and explicit skill provenance approval.

6. **Non-interactive trust bypass.** Headless/extension launches skip the repository trust gate.
   A non-interactive auto-mode process can run an untrusted repository immediately.

### P0 — runtime correctness

1. **Compaction can create an invalid transcript.** Keeping the last six raw messages can retain a
   `tool` result without the assistant tool call that created it, or the reverse. Compact only at
   complete turn/tool-group boundaries and validate every transcript before sending it.

2. **Tool fallback is incomplete on the first rejected request.** When a server rejects native
   tools, the same request is retried without tools before the system prompt contains the text-tool
   protocol. Rebuild the request before retrying.

3. **Fallback and sub-agent clients lose runtime settings.** Read timeout, output budget, thinking
   budget, and keep-alive are not consistently copied.

4. **Background processes can outlive DGC.** Background bash lacks a process group and timeout;
   `bash_kill` can terminate only the shell while leaving children running. The registry grows
   without a lifecycle policy.

5. **Sessions are non-atomic and weakly identified.** Same-second filenames can collide; writes are
   not atomic or locked; full prompts, tool output, and images are plaintext; checkpoint state is
   in-memory only. `sessions.delete(path)` accepts an arbitrary path.

6. **No authoritative usage accounting.** Context meters estimate characters, ignore provider usage,
   and over-count base64 images. There is no cost/token/latency event stream for optimization.

### P0 — concurrency and protocols

1. **ACP has one global session and allows concurrent prompts on the same `Agent`.** A second
   `session/new` replaces the first; concurrent threads can mutate conversation and files together;
   uncaught worker exceptions can leave a client waiting forever.

2. **ACP auto-approves plans.** `present_plan` silently moves into `acceptEdits` instead of obtaining
   a user decision. This violates the advertised plan boundary.

3. **ACP tool correlation is lossy.** A single `_last_tool` cannot represent overlapping or repeated
   calls, and diff events use the tool name as the path.

4. **Headless commands race with active turns.** Resume, new-session, rewind, compact, and config
   changes can mutate the shared agent while a worker is running. Session paths supplied by the
   webview are not constrained before load/delete.

5. **Resolved in the current implementation: TUI fleet agents previously edited the same checkout.**
   Additional Git sessions now snapshot the source under its mutation lease into owner-private
   `dgc/fleet-*` worktrees. Conversation sidecars preserve source-scoped discovery and validate
   reattachment; close/exit releases approval waits, cancels workers, removes only an unchanged
   checkout, and retains changed/committed/uncertain/running work with its branch and path. Non-Git
   projects retain an explicit serialized fallback.

### P1 — provider and agent quality

1. The single Chat Completions compatibility path cannot use Responses API state, persisted
   reasoning, prompt caching, server-side compaction, usage data, provider-native tool controls, or
   modern streaming semantics.
2. Provider/model capabilities are inferred from static substrings or failed production requests.
   Capability rejection is cached forever on the client.
3. A generic request mixes provider-specific reasoning fields; on rejection it strips features
   broadly rather than selecting a validated adapter shape.
4. The full tool catalog and large protocol instructions are exposed too often. Frontier guidance
   favors lean prompts and only the tools relevant to the phase.
5. Tool calls execute serially even when independent. Parallel reads/searches and isolated
   sub-agent work should be schedulable, while writes to one checkout must remain serialized.
6. There is no `apply_patch`/hash-addressed editing primitive, no code index/repository map, and no
   first-class diagnostics/LSP tool. These are high-leverage improvements for multi-file work.
7. Auto-title and next-prompt generation compete with the main local model immediately after each
   turn, increasing visible latency and GPU contention.

### P1 — CLI and editor UX

1. Full-screen `/clear` clears only the rendered blocks; classic `/clear` clears model context.
2. TUI commands are not at parity with classic mode (`/init`, `/search`, permission and memory
   editing), while help/docs imply one product surface.
3. Shift+Tab and editor mode cycling can enter `auto` without the warning used by classic mode.
4. Plan rejection feedback is discarded or unavailable across classic, TUI, headless, and ACP.
5. Extension model discovery omits the Authorization header, so keyed endpoints often fail.
6. Extension context uses only the first workspace folder and injects editor content as prompt text;
   diagnostics, structured resources, and multi-root workspaces are missing.
7. Tool-result errors are displayed as successes because the headless event omits an error flag.
8. The webview receives a sub-agent secret and escapes text but not quotes in a model `<option>`
   attribute.
9. The live site's carousel dots have no accessible names. The extension page incorrectly says the
   Marketplace/Open VSX listings are still coming, and security/product claims need to match code.

### P1 — benchmark, GitHub, and release engineering

1. Benchmark output filenames omit the engine, so different harnesses can collide and incorrectly
   skip each other's tasks. Records label every engine result `dgc`.
2. Runs do not record harness commit/version, model digest, provider capabilities, sampling values,
   hardware, prompt hash, token usage, or reproducibility metadata.
3. API keys are supplied on command lines. Timed-out DGC processes lose the most useful session
   trace. Full stdout/event traces are discarded.
4. The existing run stopped after 52/225 tasks and contains 28 agent-round timeouts. A missing Boost
   dependency also invalidated at least one task independently of model quality.
5. Release tarballs and the public repository exclude the benchmark despite reproducibility claims.
6. `github-publish.sh` stages the current working tree into a temporary index and force-pushes a
   parentless snapshot. Uncommitted work can ship, history and provenance disappear, and normal
   contribution/review workflows are broken.
7. There is no CI, dependency update automation, security scanning, coverage, release attestation,
   SBOM, or branch protection evidence in the repository.
8. Release scripts use hardcoded machine paths and unpinned `latest`/`npx -y` tooling. Marketplace
   failures are swallowed, so a partial release can report success.
9. The extension release builds the self-hosted updater flavor and publishes that same artifact to
   registries even though registry builds are documented not to self-update.
10. Licensing and public metadata drifted between MIT and PolyForm Noncommercial. The live metadata
    is now PolyForm, but README/history and GitHub's cached view still expose stale claims.
11. The installer validates a checksum hosted beside the artifact. This detects accidental
    corruption, not a compromised publication origin. Signed releases/attestations are required.

## Competitive position

| Capability | DGC today | Frontier reference | Direction |
|---|---|---|---|
| Weak/local-model editing | Strong tolerant matcher and text tools | Aider's edit formats and benchmark discipline | Keep the tolerance; add patch/hash edits and publish well-formed/edit-failure metrics. |
| Provider runtime | Generic Chat Completions adapter | Codex Responses/state; Pi unified provider runtime | Build typed provider adapters with negotiated capabilities and state. |
| Safety | String rules plus opt-in broad sandbox | Codex OS-enforced workspace/no-network defaults; OpenCode external-directory permission | Fail closed at canonical filesystem, command, network, environment, and protocol boundaries. |
| Context | Estimated tokens and summary slicing | Stateful turns, prompt caches, validated compaction trees | Preserve tool groups, use actual usage, cache static context, and support provider compaction/state. |
| Code intelligence | Repository map, exact static symbols/references/definitions, syntax diagnostics, hash-addressed patching, and optional managed stdio LSP escalation with bounded warm reuse | Aider repo map; OpenCode LSP/apply-patch | Measure cold/warm latency and semantic accuracy across the league; add optional tree-sitter parsing where it materially improves results. |
| Parallel work | Automatically worktree-isolated TUI fleet sessions with validated resume and lossless retention; automatically isolated `task` sub-agents; bounded same-baseline concurrent fan-out; call-ordered conflict-safe integration; explicit retained-delta recovery | Worktree-isolated agent work | Measure fan-out latency/throughput across local and remote providers and run cross-platform crash/reopen soak. |
| Extensibility | Skills, hooks, minimal MCP | Goose MCP ecosystem; Pi packages/extensions/SDK/RPC | Complete MCP/ACP, version protocols, publish schemas, then add a stable plugin SDK. |
| Terminal UX | Strong | Competitive already | Preserve; make state, safety, and command behavior consistent. |
| IDE | Attractive panel, thin protocol | Codex app-server/IDE shared state; OpenCode client/server | Make the backend the authoritative multi-session service and use structured editor context. |
| Evaluation | Partial local polyglot run | Aider's 225-task manifests and published trace details | Build a reproducible same-model harness league plus real-repo task suite. |
| Supply chain | Manual scripts and same-origin checksum | Pi pinned dependencies and release smoke/audit pipeline | CI, signed artifacts, provenance, conventional Git history, and transactional release promotion. |

Useful primary references:

- OpenAI model/harness guidance: <https://developers.openai.com/api/docs/guides/latest-model>
- Codex documentation and app-server: <https://learn.chatgpt.com/docs/app-server>
- OpenCode agents/permissions: <https://opencode.ai/docs/agents/>
- Goose: <https://block.github.io/goose/>
- Pi coding agent: <https://github.com/earendil-works/pi/tree/main/packages/coding-agent>
- Aider polyglot leaderboard: <https://aider.chat/docs/leaderboards/>

## Target architecture

```text
CLI / TUI / VS Code / Cursor / ACP / headless
                  |
          versioned Agent Service
     session queues | events | approvals
                  |
        deterministic Agent Runtime
   phase state | tool groups | cancellation | usage
          /                         \
 capability-negotiated          Policy Engine
 provider adapters          fs | exec | net | secrets
          \                         /
        typed Tool Scheduler + Result Store
 reads parallel | writes serialized | worktree isolation
                  |
     repo map / patch / LSP / shell / web / MCP
                  |
  atomic sessions + traces + checkpoints + telemetry
```

The service owns sessions, queues, cancellation, approvals, and event IDs. Frontends become clients
of one versioned protocol. The runtime owns valid model state and tool-call grouping. The policy
engine independently authorizes canonical actions. The scheduler is allowed to parallelize reads but
serializes conflicting writes and isolates independent agents in worktrees.

## Ordered implementation roadmap

### Milestone 1 — make every boundary safe and deterministic (P0)

1. Replace read-only command detection with a fail-closed shell policy. Remove shell/process tools
   from `READ_ONLY_TOOLS`; add adversarial tests for redirection, substitution, `find`, `git`, wrappers,
   interpreters, encodings, and compound commands.
2. Add a canonical `WorkspacePath` resolver used by every filesystem tool, permission rule,
   checkpoint, session command, artifact, and editor operation. Introduce explicit external-directory
   approvals.
3. Harden web fetch/search and remote skill installation against SSRF, redirects, oversized content,
   prompt injection, and untrusted persistence.
4. Add a credential abstraction: keyring when available, environment/key reference fallback, masked
   prompts, VS Code SecretStorage, and systematic event/log/history redaction.
5. Redesign session persistence around UUIDs, atomic replace, file locking, schema versions,
   encryption/redaction policy, scoped path lookup, and durable checkpoints.
6. Implement transcript invariants and group-aware compaction; validate before every provider call.
7. Make shell foreground/background execution share process groups, timeout/cancel semantics, bounded
   output storage, and lifecycle cleanup.
8. Serialize each session runtime. Reject or queue mutations while busy. Isolate parallel write agents
   in worktrees and add per-worktree write locks.
9. Rebuild ACP as a multi-session server with exception-safe responses, real plan decisions, stable
   call IDs, correct diff paths, cancel/permission timeouts, persistence, and protocol tests.
10. Make all current tests environment-independent and green; add security and race regression suites.

Exit gate: zero known permission escapes in the adversarial corpus; zero orphan tool messages in
randomized compaction tests; no leaked child processes; no arbitrary session paths; Python and editor
gates green on Linux/macOS/Windows CI.

Implementation note for step 5: schema-v6 sessions now atomically embed bounded rewind state rather
than preserving only the visible transcript. SHA-256-addressed message blobs and linked prefixes keep
each exact pre-turn non-system conversation available after local transcript compaction without
quadratically copying every prefix. Project-relative snapshots preserve bytes, executable mode,
symlink target, deletion, and absence; their manifest is bound to the execution checkout even when a
fleet conversation is discovered under a different source checkout. Malformed hashes, traversal,
checkout rebinding, oversized state, and parent-symlink escapes fail closed. Direct file mutations
capture and save their pre-edit state under the checkout lease and do not run if that save fails.
Rewind also runs under the lease, preflights rollback images for every target, and consumes its
checkpoint only after the restored conversation and reduced checkpoint stack are atomically saved;
a save failure restores the pre-rewind files/conversation and retains the recovery point. Explicitly
approved external paths remain current-process snapshots so resume cannot silently gain write
authority outside the project, and arbitrary shell writes remain outside the exact-file guarantee.
The same schema now carries a validated monotonic revision. Every Agent save uses revision-and-
existence compare-and-swap beneath a re-entrant session-family lock backed by an owner-private OS
lease, so independently resumed DGC processes cannot silently replace newer transcript, checkpoint,
goal, name, plan, workspace-association, or metrics state. Transcript and metrics commits share one
lease; a stale current generation may merge monotonic counters but cannot recreate a deleted session
or contaminate a colliding new path. Legacy records migrate from revision zero, malformed identity or
revision fields fail closed, and an Agent that loses the race stops before its next model request or
workspace edit. Deterministic multiprocess tests cover simultaneous writers, monotonic loser metrics,
normal handoff, crash release, stale deletion, sidecar resurrection, and legacy migration. Atomic
session/metrics/plan/workspace writes now use and reclaim one deterministic same-target temporary
file only while holding that family lease, keeping recovery O(1). A real child-process regression
pauses immediately after opening that temp, is killed while holding the lease, proves the prior
generation remains readable, then proves the next
locked reopen removes the orphan and the next CAS writer advances cleanly.
The session family now also has a separate crash-released foreground-turn lease. A process must own
it and revalidate the exact generation before `SessionStart`, prompt hooks, model requests, or tools;
it retains ownership through checkpointing and the final transcript commit. Concurrent turns and
out-of-turn goal/name/plan/rewind/compaction/retained-task/delete mutations fail immediately, while
ACP, headless, classic CLI, and TUI report failure instead of a false successful completion. TUI
workspace attachment, cleanup, and association updates use the same exclusion boundary, so an active
saved session cannot be rebound or cleaned by another process. Manual compaction rolls its in-memory
result back if the exact session generation cannot be committed. Tests cover process crash release,
same-revision contention, pre-hook stale rejection, deletion, attachment/finalization, transactional
compaction failure, and truthful ACP/headless completion.
Turn completion now distinguishes a successfully persisted generation from a successfully completed
agent lifecycle. Handled provider/fallback/context/convergence failures, repeated empty finals, and
repeated text/tool-call truncation return an explicit failed outcome, so headless/editor, ACP,
classic CLI, one-shot CLI, TUI, and sub-agents cannot label them complete merely because the error
transcript was saved. Cancellation remains a distinct clean stop. Before every final session commit,
the runtime closes interrupted native tool groups with explicit “unavailable; do not assume it ran”
results; fenced text-tool batches flush all results produced before cancellation. A resume therefore
never depends on a future provider call to make its saved transcript structurally valid.
Credential handling now has one contract rather than per-surface masking. DGC-owned credentials,
sensitive MCP/server environment values, and high-confidence authorization/token/private-key shapes
are removed from prompt ingress, mid-turn steering, model streams (including values split across
arbitrary chunks), auxiliary generations, displayed tool arguments, tool results, headless NDJSON,
ACP JSON-RPC, plans, goals, names, and durable transcript history. Credential-bearing “always”
approvals are downgraded to one-time execution so a raw secret cannot become a permission rule.
Checkpoint conversation blobs are redacted and their content-addressed chain is rebuilt before save;
opaque provider signatures/encrypted reasoning retain exact replay bytes. Exact file rewind snapshots
remain byte-correct owner-private recovery data rather than being text-mutated; optional at-rest
encryption for those snapshots remains open.

Implementation note for step 8: the mutation scheduler now combines one canonical-checkout thread
lock with a private hash-addressed OS file lock. Separate CLI, editor, headless, ACP, and fleet
processes therefore cannot run conflicting tool write/shell/MCP actions concurrently on the same
checkout. Descriptors are non-inheritable, contention stays cancellable, backend failures fail
closed, and the OS releases a lease after a crash. Pre-edit checkpoint capture happens after lease
acquisition, while distinct worktrees retain independent locks. Multiprocess contention, normal
handoff, crash recovery, permissions, cancellation, and backend recovery are regression-tested.
The `task` tool now passes through the ordinary permission and hook lifecycle, snapshots the caller's
tracked/non-ignored-untracked state under that lease into a unique private Git worktree, and runs the
child with a transient rooted config plus fresh MCP manager. Completed deltas integrate only after a
second content check under the parent lease. Paths dirty before delegation and paths changed by the
parent never auto-merge; incomplete/conflicting work is retained with owner-private metadata. Binary,
mode, symlink, deletion, rollback, cleanup, cancellation, call-ID, rewind, and root-session metric
paths are contract-tested. Non-Git projects retain the prior shared-checkout behavior with an explicit
warning. Manually spawned TUI fleet sessions now use the same source lease to copy the exact tracked
and non-ignored untracked baseline into an owner-private `dgc/fleet-*` checkout. The launch session
stays in the selected checkout; every additional Git session has its own config, MCP runtime, branch,
and write lease. Owner-private conversation sidecars keep resume discovery scoped to the launch
project and reattach only after metadata/path/branch/repository validation. Close and process exit
release pending approvals and cancel workers; untouched checkouts and generated branches are removed,
while changed, committed, uncertain, or still-running work is retained. Manual `/worktree remove`
also no longer force-discards dirty files. Storage-inside-repository rejection, exact baseline copy,
reattachment, dirty retention, untouched cleanup, non-force removal, and TUI spawn/close/exit lifecycle are
regression-tested.
`/tasks` and the typed editor command now list these records, revalidate a selected delta under the
checkout lease, apply it into the parent rewind stack, or drop it only after explicit confirmation.
Versioned metadata stores bounded content fingerprints rather than file contents; legacy records fail
closed for auto-apply while remaining inspectable and droppable.
An all-`task` response in full-auto mode now prepares every child under one source lease before any
child starts, rejects a mixed manual-editor baseline, and runs up to `max_parallel_tasks` private
checkouts concurrently. Per-child UI events buffer and replay atomically on the originating frontend
thread, while rare interactive child questions serialize. After all workers stop, DGC integrates in
model-call order: disjoint deltas land in the parent checkpoint and overlapping later deltas remain
available through `/tasks`. Permission modes, hooks, mixed batches, nesting limits, cancellation,
non-Git fallbacks, and loop guards retain their existing serial semantics.

### Milestone 2 — raise model effectiveness and efficiency (P1)

1. Introduce a `ProviderAdapter` interface and capability registry. Add dedicated adapters for
   OpenAI Responses, OpenAI-compatible Chat Completions, Ollama, llama.cpp/vLLM/SGLang, Anthropic,
   OpenRouter, and other advertised clouds. Cache negotiated capabilities by endpoint+model with
   invalidation and explicit overrides.
2. Carry request timeout, output/reasoning budgets, keep-alive, sampling, usage, and cancellation
   consistently into primary, fallback, compacting, title, suggestion, and sub-agent clients.
3. Support provider-native continuation/state, prompt caching, usage events, reasoning-item continuity,
   server compaction where available, and validated local compaction elsewhere.
4. Replace the monolithic prompt/tool exposure with phase-aware tool allowlists and lean prompt
   modules. Send the text-tool protocol in the same retry that disables native tools.
5. Add `apply_patch` and hash-addressed line editing. Keep current fuzzy edits as an explicit fallback,
   never as an unobserved first choice for capable models.
6. Add a fast repository map and code-intelligence layer: ripgrep-backed search, language-aware symbol
   inventory, optional tree-sitter, and LSP diagnostics/definitions/references.
7. Add dependency-aware parallel read/search execution and scheduler telemetry. Keep writes to a
   checkout serial; use worktrees for parallel implementation.
8. Add a convergence controller that understands test state, changed files, repeated failure
   signatures, remaining budget, and a verified done condition. Stop immediately after verified
   success instead of spending the wall timeout.
9. Schedule titles/suggestions at low priority or on a separate lightweight model, never in contention
   with the active local generation.

Exit gate: full provider contract suite passes; no settings disappear on fallback/sub-agent paths;
actual usage powers context UI; median/p95 task latency and timeout rate improve without reducing
pass@2; zero wrong-applies in the edit corpus.

Implementation note for step 7: independent read batches execute concurrently. In a Git-backed
full-auto turn, an all-`task` response now snapshots siblings from one stable baseline, executes them
concurrently with a configurable bounded pool, replays each completed child trace without stream
interleaving, and integrates in call order. Disjoint changes land; overlapping changes fail closed to
retained-task recovery. The remaining evidence work is measured fan-out latency/throughput and wider
frontend race coverage, not scheduler implementation.

Implementation note for step 6: `code_intel` now supplies bounded dependency-free symbols,
definitions, references, Python/JSON diagnostics, and TOML diagnostics on Python 3.11+. A user may
explicitly configure a stdio language server for richer results; DGC uses bounded JSON-RPC messages
and timeouts, UTF-8/16/32 position conversion, a minimal inherited environment without unrelated
credential variables, no shell, project-confined returned locations, cancellation, static fallback,
and POSIX process-group cleanup. Configured servers now reuse a serialized project/spec session for a
bounded idle TTL, with a four-session pool, a 128-document LRU, content-aware close/reopen sync,
failure retirement, external-file one-shot isolation, explicit/exit cleanup, and
`code_intel_lsp_idle_s: 0` one-shot compatibility.
Unsolicited or late diagnostics outside the bounded active-document set are discarded.
`grep` and `glob` now use a no-shell ripgrep fast path when available and a bounded dependency-free
walker otherwise. Both refuse repository descendant file/directory symlinks instead of inheriting
outside-read authority from an approved project root; direct external roots still require the normal
explicit approval. Search subprocesses receive a credential-minimal environment and have cancellation,
timeout, POSIX process-group cleanup, global file/result/record/stdout/stderr ceilings, safe NUL-delimited
filename framing, control-character/path redaction, and truthful partial-result notices. The fallback
also skips non-regular/binary/oversized files and caps entries without retaining an unbounded file list.
Structured `read_file`, `write_file`, `edit_file`, `multi_edit`, and `apply_patch` operations now walk
canonical POSIX paths one held directory descriptor at a time with no-follow semantics. A repository
cannot redirect their final read/write through a parent symlink after approval, and edits bind the
final atomic replacement to the exact file identity read by the tool so concurrent changes fail stale.
Platforms without `openat`-style directory descriptors receive repeated canonical/type/identity
validation, while the Windows OS sandbox and cross-platform adversarial runner remain explicit gaps.
Checkpoint/last-good capture and restoration now reuse the same exact-entry boundary for regular
files, symlink targets, modes, and absence. A parent swap after checkpoint validation or rollback
capture therefore fails the whole transaction without reading or overwriting the outside target.
Repository mapping, static code intelligence, and dependency-free search now enumerate directories
through bounded no-follow snapshots and reopen every source through the same exact-entry reader.
Ripgrep remains a discovery accelerator, but its reported line is disclosed only when an independent
exact-path reread matches it, so a transient descendant swap cannot smuggle outside content through
the fast path. Non-dirfd platforms retain bounded repeated validation; their stronger OS boundary
remains covered by the explicit Windows sandbox/cross-platform evidence gap above.
The complete offline evidence is 773/773 Python checks, 18/18 editor transport/webview checks, and
1/1 installed-VS-Code host smoke.

Performance evidence now separates synchronized provider request-seconds, overlap-aware provider
wall time, and DGC built-in tool-seconds with per-tool sample counts. Built-in timings contain no
arguments, commands, paths, prompts, or results; labels and counters are bounded, survive
compaction/resume/crash journals, and use the existing activity persistence boundary rather than an
extra write per execution. Round-two values are exact deltas of additive counters. Reports retain
legacy timing as unknown and explicitly avoid treating parallel tool-seconds as subtractable wall
time. This makes confinement regressions attributable without weakening the P0 boundary first.

Implementation note for command-output continuity: foreground pipes are drained continuously rather
than accumulated without a bound. Exact credentials are masked across arbitrary reader chunks before
the collector, preview, result store, or line ceiling sees them; read/grep/diff/web display paths use
the same mask-before-truncate ordering. Oversized foreground results stay searchable/pageable through
the existing `bash_output` tool, while per-result/global/TTL caps and per-agent ownership prevent the
continuation store from becoming an unbounded or cross-session side channel. Timeout accounting
includes descendants that keep an inherited output pipe open and reaps their process group.

Implementation note for step 8: verified-done is now an ordered, fail-closed state rather than a
test-keyword substring. Shell-aware recognition removes comments, requires a real test-runner
invocation, rejects help/collect-only forms and status-masking `||`, `;`, pipeline, or background
syntax, while still accepting an exact configured verifier or its complete segment inside a
fail-propagating `&&` chain. A later shell action or landed file/task edit invalidates an earlier
pass; only successful mutations count as edits for hard closeout. Repeated final answers against a
failing `verify_before_done` command stop visibly, while a corrective tool action re-arms the gate.
The configured final gate uses the same sandboxed, process-group-cleaned shell executor under the
checkout mutation lease, so timeout, launch, cancellation, and confinement failures cannot be
silently treated as success.
The budget controller's last-known-good state now reuses checkpoint-authorized project paths and
captures exact bytes, modes, symlinks, and absence under that lease. Ephemeral snapshots are bounded,
checkout-bound, exclude one-time external grants, validate parent symlinks, restore atomically, roll
back a partial multi-file failure, and report restore failure instead of claiming success. Integrated
sub-agent paths participate through the same checkpoint set; raw text `Path.write_text` recovery is gone.
Adversarial unit cases and the mock-model closeout exercise cover false comments/echoes, masked
failures, ordered pass-then-fail batches, real test execution, and schema-free summary closeout.

Implementation note for step 4: `tool_profile: adaptive` keeps the complete core coding catalog but
activates network and product-specific schemas/instructions only from explicit turn or standing-goal
intent, including mid-turn steering. The stateful `present_plan` and `update_goal` tools remain scoped
to valid modes/lifecycles, configured MCP tools are never filtered, and `tool_profile: full` restores
the complete execution catalog. A plain coding turn's serialized built-in schemas fall from 9,910 to
6,798 bytes (31.4%) before provider framing, while explicit web/artifact/skill/memory/delegation
requests preserve those capabilities.

### Milestone 3 — one coherent product across terminal and editor (P1)

1. Make CLI, TUI, headless, ACP, and editor clients consume the same command registry and state
   transitions. `/clear`, mode changes, plan feedback, permissions, memory, and search must mean the
   same thing everywhere.
2. Require an explicit warning/confirmation whenever an interactive surface enters `auto`.
3. Build a versioned editor protocol with generated TypeScript/Python schemas, stable event IDs,
   error status, backpressure, reconnect/resume, busy/queued states, and compatibility negotiation.
4. Move all editor secrets to SecretStorage and keep them out of the webview. Authenticate model
   discovery and support multi-root workspaces.
5. Send editor context as typed resources with origin and priority, including selections, open files,
   diagnostics, terminal/test failures, and explicit user mentions.
6. Add real VS Code extension-host integration tests, accessibility checks, keyboard navigation,
   cancel/approval race tests, and malicious-output rendering tests.
7. Preserve DGC's visual identity while reducing ambiguity: clear queued/running/waiting states,
   prominent sandbox/network scope, exact context/usage, consistent plan approval, and accessible
   site controls.

Exit gate: protocol conformance and extension-host suites green; no key reaches webview output;
multi-root and authenticated model listing work; all interactive commands have parity tests.

Implementation note for step 3: `dgc/editor_protocol.py` is now the protocol-v3 source of truth and
generates both the checked-in JSON Schema and the TypeScript client contract. Python validates every
incoming command before dispatch and every emitted event before it reaches stdout. The editor rejects
unknown or malformed events, any event before `ready`, and duplicate/out-of-order sequence numbers;
sequence allocation and NDJSON writes share one lock. The backend bounds binary command frames,
rejects invalid UTF-8, drains the rejected line, and recovers at the next frame. Generated-artifact
drift, declared-event coverage, invalid enums/fields, concurrent ordering, and spawned-child failures
are regression-tested.

Implementation note for step 6: the local `test:host` gate launches the already-installed VS Code
Electron executable with isolated user/extension directories, updates/telemetry/background networking
disabled, and no editor download. It proves that the development extension is discovered, activates,
registers every command declared by its manifest, resolves the real webview, launches a networkless
local protocol fixture, completes a two-folder workspace-root handshake, and propagates live removal
and restoration of the secondary root. The extension coalesces root revisions, waits for backend
acknowledgement, defers mutation during active turns, retries a busy-race rejection at turn end, and
reconciles removed-folder grants at the next backend-idle boundary. The same installed host seeds a
disposable legacy plaintext key, proves migration through VS Code's SecretStorage API, verifies the
plaintext setting is removed on disk, restarts the backend and recovers the key only from
SecretStorage, then changes endpoints and proves the stale key is deleted and remains absent after a
second restart. It uses VS Code's in-memory test provider rather than reading or mutating the
developer's desktop keychain; cross-platform persisted-keychain relaunch remains separate evidence.
The jsdom suite now covers semantic labels,
combobox/listbox state, menu arrow/Escape navigation, dialog focus trapping/restoration, attachment
removal, tool/reasoning disclosures, live status, and reduced-motion CSS. Decision lifecycles are now
first-writer-wins in the headless registry; cancel emits exact expirations, clears queued prompts,
and cannot be overwritten by a late approval. The extension transport admits only the expected
response type for an active request, never restarts for a stale control frame, prioritizes bounded
decision/cancel traffic over prompt backpressure, and drops controls that outlive their turn. The
webview tags every permission/plan/option/MCP card by ID, disables it exactly once on response,
expiration, teardown, or exit, and prevents double submission. These paths are covered through real
spawned-child stdin pressure and jsdom interaction races. Cross-platform OS-keychain relaunch,
installed-host decision interactions, and manual assistive-technology review remain.

### Milestone 4 — build evidence users can trust (P1)

1. Version the benchmark manifest and include engine in every output path and field. Record DGC/peer
   commit, executable version, model digest, endpoint type, model parameters, hardware, task commit,
   prompts, budgets, usage, timings, exit reason, and artifact hashes.
2. Remove keys from argv, preserve redacted structured traces even on kill, preflight all toolchains,
   and distinguish harness/model/infrastructure failures. Record provider request-seconds and the
   union of overlapping provider intervals separately from bounded argument-free DGC tool timings;
   never infer a round maximum by subtracting cumulative maxima.
3. Fully validate all 225 reference solutions before scoring any engine.
4. Run DGC, Codex, OpenCode, Goose, Pi, and Aider on the same exact local model, task manifest,
   timeout, context, sampling, permissions, and hardware. Publish confidence intervals, pass@1,
   pass@2, timeout rate, tokens, time, edit failures, and malformed tool calls—not a single headline.
5. Add a real-repository suite for bug fixing, multi-file changes, tests, refactors, dependency
   upgrades, UI tasks, and long-context continuation. Preserve every task as a reproducible container.
6. Add nightly small canaries and scheduled full runs. Block release on statistically significant
   regressions in pass rate, timeout rate, wrong applies, safety, or protocol correctness.

Exit gate: complete same-model peer matrix with reproducible artifacts; DGC is at least tied with the
best peer on pass@2 and materially better on either timeout-adjusted latency or local-model resource
efficiency; results can be reproduced from the public repository.

### Milestone 5 — professionalize delivery and ecosystem (P1/P2)

1. Stop force-pushing parentless snapshots. Publish reviewed commits/tags from clean `HEAD`, preserve
   history, require status checks, and keep benchmarks and build inputs public.
2. Add GitHub Actions for Python versions/platforms, extension type/test/package, security/adversarial
   tests, benchmark smoke, dependency audit, secret scan, CodeQL, artifact build, and release smoke.
3. Make releases transactional: build once in CI, generate SBOM/provenance, sign artifacts and
   manifests, verify in a clean environment, then promote the same bytes to GitHub/site/registries.
4. Pin release tooling and dependencies, use `npm ci`, remove hardcoded developer paths, use private
   temp directories, and fail the release if any target fails. Build separate self-hosted and registry
   extension flavors.
5. Choose and consistently apply the commercial/open-source license strategy. Update README, package
   metadata, site, GitHub description, Marketplace, Open VSX, and release notes from one source.
6. Finish MCP semantics (structured/image/resource content, progress, cancellation, roots,
   elicitation, logging, process diagnostics) and publish a stable plugin/tool SDK after the core
   protocol is versioned.
7. Replace hand-maintained release prose and version copies with generated changelogs/manifests and a
   post-deploy verification report.

Exit gate: a clean tagged commit produces signed identical artifacts across channels; rollback is
documented and tested; public docs and manifests agree; release provenance is independently
verifiable.

Implementation note for step 6: DGC previously sent the removed `initialize` handshake while
claiming MCP `2026-07-28`. It now probes `server/discover` on a disposable stdio process, attaches
the required protocol/client/capability metadata to every modern request, validates modern
`resultType`, and restarts on a clean process before a truthful `2025-11-25`-era fallback. Tool
wire frames and catalog pagination are bounded; roots, elicitation, and sampling multi-round-trip
input is retried with byte-preserved opaque request state. Frontend-specific capabilities advertise
only modes the active surface can represent. Form schemas are restricted, bounded, screened for
credential/payment fields, reviewed, and type-checked again before disclosure. URL mode shows the
exact host and URL, rejects embedded credentials and remote plaintext HTTP, never prefetches, and
opens only after consent. Sampling is text-only with no tools, ambient MCP context, or project
transcript; it requires approval both before an isolated stateless model call and before the bounded
result is sent to the server. Legacy roots are served only after negotiation; elicitation/sampling
callbacks require exactly one active originating request. Unsupported modes remain unadvertised and fail closed. Inbound and outbound
stdio frames are bounded, and a stalled request write retires and reaps the poisoned process before
returning control. Progress tokens and
severity-filtered server logs stay correlated with the active tool card across classic CLI, TUI,
headless/editor, and ACP surfaces. Connection failures and negotiated eras remain visible in
`/mcp`, and generation-scoped pending requests prevent a retired probe reader from failing the
replacement connection. Modern/legacy fixtures cover wire metadata, MRTR roots/forms/sampling,
double sampling consent, sensitive-schema rejection, URL policy, progress monotonicity, logging,
cancellation, process replacement, and cleanup. Modern catalogs now validate required cache hints,
cap their local freshness window, retain the last known-good routes across bounded retry backoff,
reject cyclic/oversized/malformed catalogs, and refresh atomically on expiration or a
generation-safe, exactly ID-correlated `subscriptions/listen` event. Early, forged, duplicate, and
unhonored subscription events cannot invalidate routes; graceful completion and stdio cancellation
end the subscription lifecycle, while legacy capability-gated free-floating invalidation remains
compatible. Wider external conformance and the stable SDK/schema package remain open.

## Interaction-semantics audit and implementation plan — 2026-08-25

The plan workflow, response cadence, slash-command surface, and standing-goal behavior are part of
the harness runtime, not cosmetic UI. They directly determine whether a model stays oriented,
whether the user understands what happens between tool batches, and whether every frontend exposes
the same safe state transitions.

### What is already correct

- Plan mode exposes a deliberately small read-only tool set and the permission engine independently
  denies mutation. An approved plan exits into the selected execution mode before the next model
  iteration; headless and ACP do not silently auto-approve it.
- Plans are persisted beside the session and can be reopened in the terminal. The plan renderer
  escapes Markdown source before turning it into HTML.
- The runtime streams model commentary before rendering tool cards, requires a normal final answer,
  repairs empty-final and truncated-tool-call cases, and has todo, loop, verification, and standing
  goal convergence guards.
- The terminal has a useful command palette, custom Markdown commands, persisted session goals, and
  a visible plan approval gate.

### Gaps found

1. **Plan feedback is lost.** The classic CLI asks for feedback but discards it; the TUI has no
   feedback field; headless reports feedback to the client but returns only a generic tool result;
   ACP has no feedback path. The next model iteration therefore cannot revise the plan accurately.
2. **The plan boundary is porous and its settings are conflated.** `present_plan` can be invoked
   outside plan mode and accepts an empty plan. `artifact_in_plan` simultaneously controls arbitrary
   project previews and automatic rendering of the proposed plan, so the documented default and the
   actual behavior disagree.
3. **Plan artifacts are not fully private/self-contained.** They can inherit the LAN bind setting,
   fetch Google Fonts, persist registry state non-atomically, and embed artifact names in a script
   without script-context escaping. The live dropdown also rebuilds options with `innerHTML`.
4. **Cadence depends entirely on model obedience.** The prompt asks for short commentary, but many
   local models emit a bare tool-call batch. This leaves the user watching unexplained operations.
   Final-answer instructions also demand changed files even for answer-only turns.
5. **Slash commands have no authoritative registry.** The TUI, classic CLI, headless protocol, ACP,
   and editor maintain different hardcoded lists. Custom commands work when typed in the terminal but
   do not appear in its palette; the editor can forward unsupported built-ins as literal model text.
6. **`/goal` is terminal-only and has no lifecycle.** The string persists and is injected into every
   turn, but the editor/headless/classic surfaces cannot inspect or change it; it is unbounded; and
   there is no explicit active/completed/blocked state. A model can claim completion while the stale
   goal continues to consume context indefinitely.

### Ordered implementation

1. Capture one-shot plan feedback on every interactive/protocol surface and include it verbatim in
   the `present_plan` tool result. Restrict the tool to plan mode and reject empty plans.
2. Introduce `plan_artifact` (default on) for the sanitized proposed-plan page, independent of
   `artifact_in_plan` (default off) for arbitrary project HTML. Automatic plan pages always bind to
   loopback. Make them self-contained and harden registry writes, script JSON, DOM updates, and HTTP
   headers.
3. Specify a Codex-style response cadence in the system prompt: a concise preamble before grouped
   calls, progress only at phase changes or material discoveries, what was learned plus what comes
   next, and a compact outcome-focused final. When a local model emits tool calls with no normal
   text, synthesize a truthful phase preamble before displaying those calls; never overwrite genuine
   model commentary.
4. Move built-in command metadata into one registry, derive the terminal palette from it, merge
   discoverable custom commands, and add routing/parity tests so no surface advertises an action it
   cannot execute. Carry core plan, goal, artifact, session, mode, and safety actions over typed
   headless/editor messages rather than sending slash text to the model.
5. Add bounded, persisted goal state with explicit active/completed/blocked transitions. Expose it
   consistently in terminal, classic, editor, headless, and ACP state updates. Completion remains
   user-visible and auditable; it must never be silently inferred merely because a model stopped.
6. Run unit/protocol/editor suites, artifact security regressions, command-route conformance, and the
   complete preflight. Only then resume the clean 225-task × six-engine league and release rehearsal.

Implementation status: steps 1–5 are implemented in the working tree. Plan rejection feedback now
round-trips through classic/TUI/headless (and ACP captures client-provided reason fields); plan
transitions are scoped and non-empty; plan previews have a dedicated loopback server; artifact state
and rendering are hardened; bare tool batches receive an ordered truthful preamble; classic help and
completion, the TUI palette, editor/headless metadata, and ACP custom-command discovery consume the
canonical registry; and goals have bounded persisted lifecycle state plus typed headless/editor/ACP
control. Custom prompt catalogs reserve every built-in name and alias, prefer project templates,
and bound names, entries, and bytes. Directory/final symlinks and late file swaps fail closed through
the exact workspace reader rather than disclosing outside content to the model. The current offline
evidence is 773/773 Python checks, 18/18 editor transport/webview checks, and 1/1 installed-VS-Code
host smoke.
Step 6's complete preflight was green before the current post-preflight hardening series and must be
rerun on the next clean candidate, including
the 19,591-case edit corpus (17,443 applied, zero wrong applies), type/package checks, a 441-component
SBOM, and zero npm audit findings. A clean synthetic-snapshot release rehearsal also caught and fixed
a `pipefail`/SIGPIPE failure in archive membership validation; two subsequent builds were
byte-identical and checksum-valid. Authoritative reviewed-commit release evidence and the clean full
league remain outstanding.

The stratified diagnostic added trace-backed runtime controls after this interaction delivery:

1. Operator interruption now kills and drains the entire benchmark harness process group before
   re-raising, so canceled trials cannot leave a competing model client or browser behind.
2. Aider's first-run release-note/browser UI is disabled explicitly. DGC receives an internal
   graceful turn budget ending 15 seconds before the outer hard timeout, reserving time for
   cancellation, snapshot restoration, transcript persistence, and journal flush.
3. Budgeted DGC turns transition directly from a recognized green build/test after edits to one
   no-tools closing-summary request. Normal interactive and standing-`/goal` turns retain the soft
   completion nudge so a passing subsystem test cannot prematurely terminate larger work.
4. Foreground, background, and sandboxed Bash use `pipefail`; `test | tail` can no longer report a
   compiler/test failure as exit zero.
5. Loop signatures for tests and repository reads reset after a successful edit, while repeated
   failed edits retain their grind evidence. Background-output polling is exempt from identical-call
   blocking.
6. Budgeted model requests now inherit the remaining monotonic deadline, including a cancellation
   view that closes an in-flight stream without mutating the user's Stop event. Provider retry waits
   use the same terminal cancellation boundary, so a deadline expiring during exponential or
   `Retry-After` backoff cannot start another billable generation. This control is unit-covered but
   postdates the frozen post-trace benchmark snapshot.
7. Tool calls and successful/failed file edits are persisted as monotonic session-schema-v6
   counters (with schema-v5 compatibility). An atomic `.metrics` journal checkpoints usage and
   activity after every completed request/tool call, so benchmark deltas survive both compaction and
   an external SIGKILL before the transcript finalizer. Schema-v4-and-earlier sessions retain an
   explicitly non-publishable reconstruction fallback.
8. Controlled benchmark sessions configure the official test command as DGC's bounded
   verify-before-done gate. Build-only probes no longer trigger a false green closeout, prompts state
   that canonical expectations are reference-validated, and the varied-failure cap tightens only in
   the final 10% of the turn budget rather than discarding useful correction time at 80%.

The provider-runtime slice is also implemented and contract-tested:

1. Provider profiles now describe tools, reasoning, Responses, server state, encrypted reasoning,
   cache routing, usage, parallel tools, output caps, and sampling. Explicit config overrides take
   precedence; production rejections are cached only for a bounded endpoint+model TTL and can be
   invalidated after a server upgrade.
2. OpenAI Responses remains privacy-preserving by default (`store: false`), requests encrypted
   reasoning content and replays exact output items across stateless tool loops. Provider-private
   items are stripped on any Chat Completions fallback.
3. Stored response continuation is an explicit `provider_state: server` choice. It sends only new
   function outputs/user items with `previous_response_id`, repeats instructions on every request,
   validates the transcript prefix, and falls back once to stateless full replay if state is stale or
   unsupported.
4. Stable prompt-cache keys are hashes rather than prompt text; cache/state/include/parallel/tool/
   reasoning/output-cap/sampling rejections degrade independently instead of broadly disabling the
   request. Actual cached-input and reasoning-token usage is persisted and emitted to editor clients.
5. Native Ollama uses `/api/chat` and `/api/tags` directly, preserving streamed thinking, correlated
   tool calls, exact continuation fields, options, keep-alive, cancellation, and provider usage. Auto
   mode falls back safely when a proxy does not expose the native route.
6. Primary, fallback, sub-agent, and auxiliary clients resolve transport per endpoint. Credentials
   inherit only on the same endpoint; endpoint changes invalidate matching live, persisted, and
   editor-cached keys. Editor model discovery is correlated through the same provider adapter instead
   of duplicating a hard-coded `/models` request in TypeScript.
7. TUI auto-title and ghost-suggestion generations share one fleet-wide low-priority slot, wait for
   an idle grace period, run sequentially, and are canceled at a foreground barrier before any real
   prompt starts. Queued prompts bypass auxiliary work; clear/close/rename/worktree lifecycle changes
   retire stale jobs. Tiny outputs and prefill stalls are independently capped.
8. Local compaction is now deadline-aware and bounded to a 1,024-token, 120-second, reasoning-off
   auxiliary request with context-sized head/tail input. Repeated compactions merge the prior brief
   once instead of recursively summarizing DGC's wrapper messages. Tool arguments and both ends of
   stale results remain visible. Empty, malformed, tool-calling, canceled, timed-out, or failed
   summaries fall back to a deterministic 12,000-character evidence brief rather than dropping all
   earlier context. Native server-side compaction remains future provider work.
9. Chat Completions, Responses, and native Ollama now share bounded retry-delay parsing (numeric or
   HTTP-date), cancellation-aware waits for both event and deadline-only cancellation views, and
   deterministic response ownership. Error, capability-negotiation, retry, transport-fallback,
   successful-consumption, and parser-failure paths release streamed responses before control moves
   on. Adversarial tests prove a five-second `Retry-After` is interrupted without a second request on
   all three transports.
10. Compatible Chat tool streams now normalize spec fragments, repeated complete IDs/names,
    cumulative argument snapshots, numeric-string or missing indices, and direct argument objects
    into one stable call. Responses applies the same cumulative-argument rule, preserves index zero,
    and keeps out-of-order calls distinct in canonical index order when proxy item IDs are missing.
    Non-object arguments remain a bounded `_unparsed` repair result and are never executed as a
    malformed type. Seven adversarial wire cases cover these variants without contacting a provider.
11. The VS Code/Cursor host now reconciles live multi-root add/remove/reorder events with the
    backend's external-directory grants. Updates are revisioned, acknowledged, coalesced, deferred
    while a turn is active, and retried after a command/turn-start race; the same 32-external-root
    protocol bound is enforced on both sides. The installed-VS-Code smoke opens a real two-folder
    workspace and proves initial propagation, removal, and restoration without a network download.
12. Editor commands are serialized before validation so optional JavaScript `undefined` properties
    are judged as the exact omitted fields received on the JSON wire. This fixes silent rejection of
    partially specified model/settings commands. Legacy plaintext cleanup no longer deadlocks the
    backend handshake when VS Code rewrites settings but its configuration promise never settles;
    cleanup stays live behind a bound, remaining scopes produce a credential-free warning, and a
    completed migration avoids a redundant activation-path keyring read. The installed host proves
    migration, SecretStorage-only backend restart, endpoint invalidation, and no-key restart.
13. The editor's `@file` catalog now separates the user-facing multi-root label from a typed URI,
    canonical filesystem path, root-relative path, and workspace identity. Selecting a file from a
    secondary root no longer hands the model a folder-prefixed label that resolves under the primary
    root. The webview bounds and validates catalog entries, hides absolute host paths from the
    suggestion UI, and regression-tests the exact typed prompt context submitted after selection.

Interaction exit gate: plan feedback survives a full reject/revise/approve cycle; automatic plan
artifacts make no network request and are loopback-only; every advertised command has a tested route;
bare tool-call models still produce correctly ordered progress; and goal status round-trips across
session resume and every supported frontend.

## Non-negotiable release gates

No production release may proceed unless all applicable gates are green:

- **Correctness:** unit/integration/contract suites green; transcript invariants and session recovery
  fuzz tests green.
- **Security:** adversarial permission corpus green; canonical path, SSRF, secret-redaction, and
  sandbox-policy suites green.
- **Concurrency:** no shared-agent concurrent mutation; cancellation and child cleanup proven; write
  isolation tests green.
- **Protocol:** generated schemas unchanged or intentionally versioned; headless/ACP/editor
  conformance green.
- **Quality:** edit corpus has zero wrong-applies; benchmark canary has no unexplained regression.
- **Supply chain:** clean `HEAD`, reproducible build, dependency audit, SBOM, signature/attestation,
  and clean-install smoke pass.
- **Truthfulness:** README, website, package metadata, listings, release notes, and current behavior
  agree.

## First implementation slices

The first code changes should land in this order because later performance work is unsafe without
them:

1. Permission/path adversarial tests and fail-closed fixes.
2. Transcript grouping/compaction invariants and tests.
3. Atomic/scoped sessions plus headless command serialization.
4. Process-group background shell lifecycle.
5. ACP multi-session serialization and real plan gate.
6. Secret redaction/storage boundaries.
7. Benchmark schema/manifest/trace correctness.
8. Provider adapter foundation and OpenAI Responses implementation.
9. Patch/hash edit tool and repository intelligence.
10. Editor protocol parity and integration tests.
11. CI/release replacement and public-history migration.
12. Full same-model benchmark league, followed by optimization based on traces.

This ordering intentionally delays broad new UI features until DGC can execute, resume, benchmark,
and release them safely and reproducibly.
