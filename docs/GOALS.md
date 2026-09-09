# Goals and selected context

`/goal <objective>` starts work and keeps the objective attached to the conversation. DGC continues
through work cycles until it completes the goal, pauses, or reports a blocker. The editor also
accepts `objective /goal`; choosing `/goal` from the inline picker starts the prepared draft.

A native work cycle that reaches its configured time limit pauses the goal without accepting a
completion report. Cancellation and time limits return a nonzero one-shot CLI exit status; the editor
reports cancellation or error rather than completed work. Saved partial work remains available for
review and an explicit resume.

## Attach instructions and references

In the editor, select skills, prompt templates, files, images or MCP snapshots before starting the
goal. The same attachments are retained when you pause, close the editor and resume the goal.
The goal's **Review** action lists its selected skills/templates and attachment counts. A rejected
start retains the draft and its attachments. If delivery was interrupted before acknowledgement,
DGC offers the saved message for review instead of automatically sending it again.

In the classic CLI and TUI, use explicit skill mentions and file attachments in the objective:

```text
/goal Verify @spec.md @screen.png with $verify
```

Select a custom prompt template at either end of the objective:

```text
/goal Verify the API /check-api
/goal /check-api Verify the API
```

These examples require a `check-api.md` prompt template in a discovered commands directory.
Template text is resolved from the current project/user catalog when work starts or resumes.
The saved objective remains your request; expanded file contents are kept as separate reference
data. Image attachments require a native model route with vision support. DGC currently rejects
image attachments for subscription CLI delegation before starting a goal.

Terminal MCP reads and prompts stage reference text for the next request. Starting a goal captures
that staged context with it:

```text
/mcp read docs docs://release-checklist
/goal Verify the release with $verify
```

Replace the server and URI with entries from your own MCP catalog. The saved reference is a
snapshot. Resuming a goal reuses MCP snapshots and terminal `@file` snapshots; it does not silently
refresh those attachments. To use a new snapshot, prepare a replacement goal. Editor file mentions
without captured text remain path references: DGC reads those files through its ordinary tools and
permissions as needed while working.

## Pause, resume and review

- `/goal pause` stops active work and saves its state.
- `/goal resume` resumes the saved objective and its selections.
- `/goal review` shows status, work time, usage, attachments and completion evidence.
- `/goal clear` removes the current goal and its retained attachments. Existing conversation
  messages remain part of the chat history.

The editor card offers these actions, plus editing the objective and token budget. Editing the
objective preserves its attachments. Reopened active goals are paused; reopening a chat does not
start a model or tool process. Missing/disabled skills, missing templates or damaged saved inputs
prevent resumption and produce a specific error.

`/goal --tokens 50000 <objective>` sets an optional token budget. Work time excludes time spent
offline or paused. Budgets are checked between model requests or delegated turns, so an in-flight
request can exceed the remaining allowance. A route that does not report usage cannot continue
under an enforceable token budget. Three consecutive cycles without distinct tool progress block
the goal for review; successful process exit alone does not mark a goal complete.

## Storage and limits

Goal inputs are stored with the local session and pass through DGC's credential redaction. Status
events contain only attachment names/counts, not image bytes or reference bodies. Skills/templates
are selected by catalog name; attachments do not grant additional filesystem, shell or MCP
permissions. Explicit terminal `@path` reads use the same bounded, no-symlink attachment rules as
ordinary terminal prompts.

A goal supports up to eight skill/template selections, four images totaling 2 MiB, and a 64,000-byte
encoded reference frame. Oversized selected file/MCP context rejects the start instead of silently
dropping a snapshot. Goal objectives are limited to 4,000 characters. The extension negotiates
attachment support with the CLI; an older backend asks for an update and retains the draft.
