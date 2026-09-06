# Extension audit and parity work

This audit is in progress. The target is Codex extension **26.5901.22334**, with DGC branding,
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
| Low | Missing host font tokens invalidated the whole font declaration. | Put fallback font families inside each CSS variable's fallback. |
| Low | Failed webview assertions left timers alive and hung the test process. | Close every JSDOM instance in test cleanup. |

The transcript now groups tool batches into expandable rows, retains visible failures, distinguishes
reasoning phases, and places the work summary before a successful final answer. Native and delegated
routes share concise response and Markdown guidance. Renderer licenses and its exact packaged files
are included in the VSIX validation rules.

The exact reference's compact model menu and reasoning slider are now implemented with DGC's
purple accent. Ultra remains an explicit DGC option. Codex subscription selections omit `max`, which
is not that route's supported wire value; its highest normal effort is `xhigh`.

## Remaining requirements and open findings

- Goals currently store a standing objective and issue one completion nudge. They need a shared,
  durable continuation controller, genuine pause state, reviewed completion, and explicit accounting.
  Native and subscription routes, the CLI, and the extension must all follow the same lifecycle.
- Goal editing currently resets elapsed time; pausing is conflated with a model-reported blocker.
- Changed-file totals are capped at 500 without a completeness indicator. Large or failed scans need
  truthful partial-state reporting; non-Git projects and staged/working-tree differences need review.
- Finish the exact reference comparison of model/reasoning controls, animation, keyboard behavior,
  collapsed history, attachments, and the goal review workflow at wide and narrow sidebar sizes.
- Audit provider tool/result lifecycles and exercise actual local and subscription model routes.
  Add any missing skills only where they support a verified workflow.
- The classic subscription CLI writes provider text directly to stdout, bypassing its native
  terminal-control filtering. Consolidate subscription presentation and lifecycle handling.
- Complete source/history and artifact privacy review, package validation, clean-install tests,
  release notes and versioning, then publish reviewed bytes to GitHub, the website and Marketplace.
  No release from this branch has been published.

## Evidence so far

- Baseline: 1,383 Python checks and 51 extension tests passed.
- Updated backend: 1,386 Python checks passed; the endpoint-free prompt surface remains below
  its existing 2,300-token ceiling after consolidating the shared response guidance.
- Extension: 60 tests passed, covering semantic rendering, unsafe links, file boundaries, tool IDs, cancellation, IME,
  menu races, and initial staged files have automated regression coverage.
- Installed VS Code 1.107.1: activation, 28 commands, handshake, multi-root state, SecretStorage,
  and permission/plan lifecycles passed. Browser-driven editor checks exercised the goal card,
  changes review, native diff, and narrow sidebar.
- The host reported exhausted system file watchers during editor checks. Turn-driven refresh and
  manual review were exercised; watcher-driven refresh needs another check with watcher capacity.
- The initial tracked-file scan found no configured machine-path markers or credential patterns
  outside deliberate test fixtures. This is preliminary evidence, not a complete privacy signoff.

## References

- [Codex IDE documentation](https://learn.chatgpt.com/docs/codex/ide)
- [Codex Marketplace listing](https://marketplace.visualstudio.com/items?itemName=OpenAI.chatgpt)
- [markdown-it documentation](https://markdown-it.github.io/markdown-it/)

Release acceptance requires completion of every remaining requirement, not only passing unit tests.
