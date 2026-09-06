# Extension audit and parity work

Implementation and source review are complete; release validation and publication are in progress. The target is Codex extension **26.5901.22334**, with DGC branding,
purple accents, and equivalent CLI behavior. The inspected baseline is CLI **0.27.0** and extension
**0.14.1**. Downloaded reference binaries and private screenshots are excluded from release sources.

## Findings addressed in the working branch

| Severity | Finding | Change and evidence |
| --- | --- | --- |
| High | A model-provided file path could open outside the workspace, and Windows paths were treated as relative. | Canonical workspace resolution on every click, including symlink and removed-root checks; navigation regression tests. |
| High | The backend acknowledged an idle turn before releasing its worker slot. Immediate goal controls could be rejected as busy. | Atomic terminal-event handoff under the prompt queue lock; regression observes the slot at acknowledgement. |
| Medium | The formatter stripped links and used incomplete line-based Markdown parsing. | Bundled CommonMark parser; semantic lists, headings, quotes, tables, fenced code and user-activated file/source links. Raw HTML and automatic image requests remain disabled. |
| Medium | Cancelled/error turns and commentary preceding tools could be presented as a final answer. | Terminal reason and commentary determine final styling; exact-source response copy and work-summary separation. |
| Medium | Tool identifiers such as `__proto__` collided with JavaScript object properties. Denial details were lost. | Prototype-free correlation maps; visible denial evidence and regressions. |
| Medium | Initial staged files disappeared from the changed-file rail before the first commit. | Include the unborn repository's index and scope Git queries literally; real-repository regression. |
| Medium | Diff read errors were shown as empty files, and stale folder grants remained usable. | Recheck current roots and distinguish missing blobs from failed reads. |
| Medium | Model discovery could reopen a dismissed menu; Escape did not close a loading menu. | Ignore late results while closed and handle Escape before enumerating options. |
| Medium | Enter could submit a prompt while an input method was still composing text. | Respect composition state; regression for IME confirmation. |
| High | Standing goals stopped after one turn and were omitted from subscription requests. | Shared durable continuation for native and delegated turns, bounded no-progress handling, explicit evidence reports, and cycle/accounting review. |
| High | Goal completion could survive a later failed/cancelled work cycle. | Stage the model report; commit completion only after successful cycle termination. |
| High | Bundled loop/refactor instructions could stage unrelated files or discard existing user edits. | Require exact ownership of changes, deliberate staging, and narrowly scoped correction; add a dedicated UI review skill. |
| Medium | Pause was represented as a blocker, editing reset elapsed time, and reopened goals counted offline time. | Distinct pause state, preserved identity and work clock, and paused session restoration. |
| Medium | Subscription output bypassed terminal filtering, dropped terminal-only answers after commentary, and retained unbounded text/tool arguments. | Shared streaming redaction, terminal-control filtering, final-answer recovery, resource cleanup, and bounded output retention. |
| Medium | Reopened chats dropped tool arguments/results, large histories could exceed the wire limit, and every token reparsed the full response. | Bounded history projection, 50-message pages, lazy tool disclosure, batched streaming renders and bundled syntax highlighting. |
| Medium | Rejected prompts discarded their drafts and attachments and could leave the editor marked busy. | Correlated acceptance/rejection events, explicit draft restoration and confirmed worker-state tracking. |
| Medium | Large or failed Git scans presented incomplete totals without disclosure. | Full file counts with a 500-row display bound, partial-scan notices and unavailable-repository state. |
| Low | Legacy Codex subscription settings could pass unsupported `max` effort. | Map the legacy strongest-effort choice to `xhigh` at the vendor invocation boundary. |
| Low | Missing host font tokens invalidated the whole font declaration. | Put fallback font families inside each CSS variable's fallback. |
| Low | Failed webview assertions left timers alive and hung the test process. | Close every JSDOM instance in test cleanup. |

The transcript now groups tool batches into expandable rows, retains visible failures, distinguishes
reasoning phases, and places the work summary before a successful final answer. Native and delegated
routes share concise response and Markdown guidance. Renderer licenses and its exact packaged files
are included in the VSIX validation rules.

The exact reference's compact model menu and reasoning slider are now implemented with DGC's
purple accent. Ultra remains an explicit DGC option. Codex subscription selections omit `max`, which
is not that route's supported wire value; its highest normal effort is `xhigh`.

## Release work remaining

- Build and validate the versioned runtime archive and VSIX, review the final artifact contents,
  refresh public captures and documentation, run release CI and clean-install checks, then publish
  the reviewed bytes to GitHub, the website and Marketplace. Nothing from this branch is published yet.

## Scope and known limits

- The change rail represents workspace Git changes against HEAD, including pre-existing user edits.
  It does not claim that every displayed change belongs to this conversation. Non-Git folders report
  unavailable review; scans above 500 files report their display limit.
- Restored history reflects saved model context, including prior compaction. Tool details are loaded
  on expansion; very large saved context and messages have explicit display limits. Historical native
  tool results do not carry a reliable success field, so they are labelled saved results rather than
  assigned an invented success status.
- Subscription budgets are checked between vendor turns and can overshoot in one turn. Unknown usage
  pauses a budgeted goal. Vendor CLIs own authentication, tool permissions and their internal execution;
  DGC's optional native shell sandbox does not confine them.
- DGC image attachments work on native vision routes. Vendor CLI delegation currently rejects DGC
  image attachments explicitly, preserving the existing documented limitation.
- Editor validation ran on Linux ARM64 in VS Code 1.107.1, including the matching webview surface used
  by Cursor. Windows CLI use is through WSL; native Windows execution is not a supported promise.

## Evidence so far

- Baseline: 1,383 Python checks and 51 extension tests passed.
- Goal checkpoint: 1,387 Python checks passed, including 23 goal lifecycle, editor-state and delegated-stream
  regressions. The offline prompt estimate remains 2,283 tokens with no automatically loaded skill.
- Extension: 66 tests passed, covering semantic rendering, unsafe links, file boundaries, tool IDs, cancellation, IME,
  menu races, and initial staged files have automated regression coverage.
- Installed VS Code 1.107.1: activation, 28 commands, handshake, multi-root state, SecretStorage,
  and permission/plan lifecycles passed. Browser-driven editor checks exercised the goal card,
  changes review, native diff, and narrow sidebar.
- Goal review, pause/resume, edited-goal continuation, and protocol v6 passed the installed-host
  checks. Browser captures at 560px and 300px sidebar widths show no overflow or webview errors.
- The host reported exhausted system file watchers during editor checks. Turn-driven refresh and
  manual review were exercised; watcher-driven refresh needs another check with watcher capacity.
- Actual local Qwen validation completed in two work cycles (65 seconds), and the Codex subscription
  completed in one (25 seconds). Both wrote the requested code, passed two independently rerun tests,
  and restored the completed goal identity and evidence from disk.
- Source/history privacy review scanned 300 current text files and 1,970 text objects/archive members
  across 59 reachable commits, including 16 historical runtime/extension archives. No credential,
  configured release-secret or machine-path matches were found outside deliberate test fixtures.
- `npm audit` and `pip-audit` found no reported vulnerabilities in the extension dependency graph and
  11-package locked Python closure. Bandit reported no high-severity findings. Reviewed medium findings
  concern explicit opt-in LAN preview binding, private sandbox temporary paths, and the permission-gated
  persistent Python interpreter's intentional code execution. These are not exposed unauthenticated
  code-evaluation endpoints.

## References

- [Codex IDE documentation](https://learn.chatgpt.com/docs/codex/ide)
- [Codex Marketplace listing](https://marketplace.visualstudio.com/items?itemName=OpenAI.chatgpt)
- [markdown-it documentation](https://markdown-it.github.io/markdown-it/)

Release acceptance still requires verified artifacts, CI and production-channel checks.

- [Highlight.js source and usage](https://github.com/highlightjs/highlight.js)
