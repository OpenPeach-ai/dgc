# Plan, review, and initialize a project guide

These commands work in the interactive CLI, full-screen TUI, and VS Code/Cursor extension.
In the extension, type `/` anywhere at a word boundary to find them. Choosing a workflow prepares
the draft and keeps the text around the caret, skills, templates, files, images, and MCP snapshots.
Press Send when the request is ready. The terminal palette also preserves the draft. Management
commands such as `/model`, `/skills`, and `/mcp` open their controls independently of the draft.

## Plan

```text
/plan
/plan Add retry backoff without changing the public API
Add retry backoff without changing the public API /plan
```

Bare `/plan` enters read-only plan mode without starting a model request. `/plan TASK` enters that
mode and asks the agent to inspect the project and propose concrete steps and validation. The saved
plan remains available through `/view-plan`. Execution uses DGC's existing plan-approval controls.

`/plan` no longer toggles back into an execution mode. Use `/mode default` or the permission-mode
selector to leave plan mode deliberately. Selecting a workflow in the composer does not change
permissions until its complete prompt has passed validation and can start.

## Review

```text
/review
/review --staged Focus on retry behavior
/review --working
/review --base main
/review --commit HEAD~1 Check the compatibility impact
Check the error handling /review
```

Review enters read-only mode and asks for concrete bugs and regressions, ordered by severity, with
file/line references, triggers, and impact. If no bugs are found, the answer should say so and identify
material coverage gaps. It does not request edits or automatically start an implementation plan.
Skills such as `$security-review` can add a focus without changing the permission boundary.

The default comparison includes staged, working, and non-ignored untracked changes. `--base REF`
compares the branch's merge base with HEAD; `--commit REF` compares one commit with its first parent.
Neither includes uncommitted work. References must be available locally; review does not fetch them.
Native models use the [bounded Git inspection tool](GIT_REVIEW.md) and read surrounding files/tests.
Plan mode does not permit arbitrary shell or test execution. Attached MCP snapshots remain available
as reference text, while live MCP tool execution remains unavailable in native plan mode.

Subscription CLIs receive the same review instructions through their own read-only execution mode
and tools. A route that cannot enforce that mode, such as the current Kimi prompt route, rejects the
workflow and retains the draft. This does not add unsupported native tools to a subscription CLI.

## Initialize or update DGC.md

```text
/init
/init Include the project's release and migration conventions
```

The agent inspects existing instructions, manifests, source, and developer documentation, then
prepares a concise DGC.md guide. It preserves useful existing guidance and includes only commands
and conventions supported by the repository. Credentials, personal details, private absolute paths,
and unrelated internal data do not belong in the guide.

`/init` uses the current permission mode and ordinary file-edit tools. It does not create a placeholder
or overwrite DGC.md before inspection. In plan mode, it proposes the guide and uses the normal plan
approval process before writing. The final response should distinguish a proposal from a saved file
and describe the verification actually performed.

## Drafts and goals

These workflows start when the current turn is idle. Pause an active goal before starting a separate
workflow; its objective and saved attachments remain available for `/goal resume`. Paused goals do
not contribute their skill selections to the new task.

The editor validates the workflow, skill/template selections, context, and supported image inputs
before changing mode or acknowledging the prompt. Rejected requests recover their draft using the
same mechanism as a normal message. A CLI without the additive protocol-v6 `workflows` capability
receives an update message instead of an unsupported command.

Live and restored transcripts show the user's workflow command. The expanded execution instructions
remain in the private session context so future model turns retain the review or planning intent.
Terminal file mentions expand once in the execution body and leave the displayed command intact.
