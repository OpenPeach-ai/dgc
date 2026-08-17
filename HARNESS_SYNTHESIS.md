# DGC ← Best-of-breed harness synthesis (2026-08-17)

Deep reads of **grok-build** (xAI), **opencode**, **goose**, **qwen-code**, **pi**, plus a
goose-docs.ai design study. North star for look + feel = **Grok Build**. Palette = **mono
black/white + one purple accent** (`#7C5CFF`; Grok's exact is OscuraMidnight `#9B7ECE`/lavender
`#C4A7E7`). Two themes recur across every repo: **local-endpoint robustness** and **UX polish** —
that's where DGC is most exposed.

Site redesign: **DONE + deployed** (mono+purple, Grok/goose-docs reference).

---

## PHASE 1 — The Grok look & feel (highest visible impact)

Make the CLI *feel* like Grok Build. All portable to `rich` + `prompt_toolkit`.

1. **Semantic-slot theme system.** Turn `dgc/style.py` into a full `Theme` (no hardcoded colors
   anywhere; every color → a named slot; defined RGB, quantized to terminal capability;
   `NO_COLOR` → mono). Adopt Grok's **OscuraMidnight** slots (bg `#030304`, surface `#0F1216`,
   text `#E4E4E4`, gray `#81868F`, purple `#9B7ECE`, lavender `#C4A7E7`, +diff/md groups). Ship a
   couple of themes (`/theme`). Ref: grok `theme/oscura.rs`.
2. **Animated shimmer logo.** Diagonal shine-sweep across the DGC mark at 12fps via `rich.Live`,
   TTY-gated; gray base → lavender glint. Recipe: raised-cosine band, `CYCLE=4s`, `SWEEP_FRAC=.32`.
   Ref: grok `welcome/logo.rs`.
3. **Composer redesign.** Rounded box, `❯` prefix, left accent rail `┃`, a `model · mode` info
   line, plan-mode colored border; Shift+Tab cycles mode; `@` file picker, `/` slash menu.
   Ref: grok `prompt_widget/mod.rs`.
4. **Turn-status line.** `⠧ Thinking… 0.2s … 1m20s ⇣12k [stop]` — spinner + activity state machine
   (Thinking/Responding/Verifying/Compacting/Retrying) + phase timer + turn timer + token count +
   stop hint; tick-divisor animation; a shared pulsing "your turn" cue on prompts; animated `sin²`
   accent-rail wave on running blocks. (Extends the spinner + `· done` marker already shipped.)
   Ref: grok `turn_status.rs`.
5. **Diff renderer.** Pygments two-sided unified diff (old/new highlighters independent),
   `… N unchanged lines` hunk separators, content-only +/− bands, line-number gutter.
   Ref: grok `blocks/tool/edit.rs`, opencode width>120 split rule.
6. **Per-tool display registry.** One icon vocabulary + consistent header per tool
   (`→` read, `$` bash, `←` edit, `⏺`…), inline vs block, 10-line collapse w/ expand hint.
   Ref: opencode `run/tool.ts`, goose `output.rs:533`, pi `renderResult`.
7. **Context/token bar** with usage gradient (green→yellow→red by %), hover-morph to a progress bar
   at identical width. Ref: grok `context_bar.rs`, pi/goose footers.
8. **Glyph set with 1-col ASCII fallbacks** everywhere; degrade on legacy console / `NO_COLOR` /
   non-TTY. Ref: grok `glyphs.rs`.

## PHASE 2 — Local-endpoint robustness (biggest correctness gap; every study flagged it)

This is why local models feel flaky in DGC today.

9. **Edit-tool overhaul** (the #1 recurring theme). Layer, cheapest first:
   - Unicode-confusables + whitespace normalization fallback (`NFKC`, smart-quotes, dashes, exotic
     spaces) with byte-for-byte preservation of untouched lines. Ref: pi `edit-diff.ts`, grok
     `search_replace`.
   - Fuzzy-replacer cascade (Simple→LineTrimmed→BlockAnchor→…). Ref: opencode `edit.ts`.
   - **Grok hashline anchored edits** — `read_file`/`grep` emit `LINE:hash` anchors the model edits
     against without re-reading; validate + self-heal drift; `AmbiguousAnchor` on >1. *Highest-value
     correctness idea in the whole study set.* Ref: grok `grok_build_hashline/`.
   - Multi-edit atomicity + overlap detection + arg coercion (edits-as-JSON-string, single-object).
10. **Streaming tool-call parser** that tolerates broken local deltas (index collisions,
    args-before-id, truncation the server lies about, JSON repair). Ref: qwen
    `streamingToolCallParser.ts` (~600 lines, pure logic).
11. **Text/XML tool-call recovery** (`<invoke>`-as-text) with fence-awareness + entity decode; and
    an **inline `<think>` splitter** for DeepSeek/Qwen3-style reasoning. Ref: qwen
    `xml-tool-call-fallback.ts`, `taggedThinkingParser.ts`.
12. **Retry classifier.** `Retry-After` honoring + exponential backoff + jitter + a regex catalog of
    retryable vs terminal (never retry quota/billing/context-overflow); interruptible by cancel;
    publish a live countdown to the status line. Ref: pi `retry.ts`, opencode `retry.ts`.
13. **Loop / doom-loop detection.** Action-stationarity: hash `(tool, args)`; nudge at ~8 identical,
    hard-stop at ~16 (tighter for no-op bash); surface reason + "disable for session". Ref: grok
    action-stationarity, qwen `loopDetectionService.ts`, opencode/goose.
14. **Output clamp + truncation recovery.** Enforce `prompt + max_tokens ≤ window` (kills local
    `400 exceeds context`); on `finish_reason=length` escalate once, then resume from the partial.
    Ref: qwen `tokenLimits.ts`.
15. **Truncated-tool-call safety.** When a completion stops on `length` *and* carried tool calls,
    fail them all ("re-issue with complete arguments") — don't execute salvaged/truncated JSON.
    Ref: pi `agent-loop.ts`.
16. **Self-documenting truncation.** Dual line/byte caps, head for reads / tail for bash, and append
    the exact next action (`offset=N to continue`, `Full output: <tmpfile>`, `sed -n` fallback);
    document the policy in each tool's description. Ref: pi `read.ts`/`bash.ts`/`truncate.ts`.

## PHASE 3 — Context, tools, agent-loop hardening

17. **Two-field tool result** `{output, prompt_text}` + a **`<system-reminder>` reminder pipeline**
    (per-tool + cross-cutting like TaskCompletion/SkillDiscovery). Small refactor; unlocks clean
    context shaping + attribution. Ref: grok `turn.rs`.
18. **TodoGate** — refuse to end a turn with open todos (inject a reminder, loop, bounded). Ref: grok.
19. **Two-tier context management** — a continuous mechanical prune (cap stale tool-output bodies
    ~2k chars, protect recent ~25% + skill outputs) *before* LLM compaction; dual-visibility messages
    (`user_visible`/`agent_visible` — hide without deleting); proactive-at-80% + reactive-on-overflow,
    structured summary, carried file-op list. Ref: goose `context_mgmt`, opencode `compaction.ts`,
    pi `compaction.ts`, qwen microcompaction.
20. **Providers-as-data + model catalog.** One OpenAI-compatible client + `providers/*.json`
    (bundled + user dir) each with `base_url`, `api_key_env`, per-model `context/max_tokens/cost`,
    `request_params`, `thinking_format`; + a small model catalog (context/cost/tool_call/reasoning,
    128k default). Adding a provider = drop a file. Ref: goose `declarative/`, opencode `models-dev.ts`.
21. **Per-file mutation locks** (realpath-keyed) so parallel edits/writes to one file serialize;
    sequential-prepare / parallel-dispatch. Ref: pi `file-mutation-queue.ts`, grok.
22. **Reject-with-feedback** permission reply (deny *and* steer in one step); scoped-grant width
    (←/→ over the command words) with a **live-preview glob editor** that reuses the real matcher.
    Ref: grok `permission_view.rs`, opencode.

## PHASE 4 — Extension: webview ACP client (match Grok's editor model)

23. Rebuild the VS Code/Cursor extension as a **webview ACP client** driving `dgc acp`: stream
    `session/update` into the panel, render permission prompts as webview UI answered over the
    reverse-request channel, inject editor context via `ResourceLink` `_meta` (focused/open files +
    cursor) — plus a **DGC-specific `diagnostics` field Grok lacks**. Match the composer / streaming /
    diff / status look (mono+purple) in the webview. Ref: grok `xai-acp-lib`, A9.

## PHASE 5 — Onboarding, config, safety

24. **Config/onboarding polish** — intro/outro/spinner/log vocabulary; fuzzy provider search +
    recommended-first models + free-text escape; **live provider ping after config**; rotating input
    placeholders; no-provider → auto-open connect; exit splash prints the resume command. Ref: goose
    `configure.rs`, opencode, pi startup.
25. **OS sandboxing** (Landlock/Seatbelt via a helper or `bwrap`) with profiles; **sandbox-active →
    auto-approve bash** (confinement lowers friction). Ref: grok `xai-grok-sandbox`.
26. **Supply-chain guards** — OSV `MAL-*` check (fail-open) + a 31-key env-hijack blocklist before
    spawning `npx`/`uvx` MCP servers. Ref: goose `extension_malware_check.rs`.

## Also worth a look (lower priority)
Recipes (goose) as a typed/parameterized skill+subagent+slash-command+cron unit; `delegate`/`load`
async subagent handles; MCP Elicitation (schema→form); `@file` imports in DGC.md + AGENTS.md interop;
structured `ask_user_question` tool; `--output-format json/stream-json`.

## Explicitly skip
Full TUI-framework rewrites (Ratatui/OpenTUI/pi-tui — rich+prompt_toolkit suffice); pi's no-permission
model (DGC is ahead); AI-SDK legacy runtimes.

---

## Recommended order
- **Phase 1 first** — it's what makes DGC *feel* like Grok, is highly visible, and is mostly `rich`
  formatting + one animation. Start: theme system → animated logo → composer → turn-status → diff.
- Then **Phase 2** (robustness) — the invisible half; it's why local models flake today.
- Phases 3–5 as follow-on tracks.
