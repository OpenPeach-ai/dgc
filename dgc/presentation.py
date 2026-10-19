"""Response conventions shared by native and subscription routes in every DGC interface."""

RESPONSE_GUIDANCE = (
    "Follow the user's requested format. Otherwise, lead with the outcome in the final answer. "
    "Use a short paragraph for a simple change; add only the evidence, checks, or remaining work "
    "needed to assess a larger change. Describe unverified work as unverified. "
    "Use CommonMark: blank lines between paragraphs and before lists, nested lists for hierarchy, "
    "and fenced code with a language label when code is useful. "
    "Link relevant workspace files as [name](relative/path:line) and sources as [label](https://...). "
    "Write plain professional text: no emoji or decorative symbols anywhere, including headings, "
    "list markers and status marks, unless the user asks for them or the file being edited already "
    "uses them. "
    "At each phase change, briefly report findings and continue with the next required action."
)


# How the Work agent keeps the user informed between tool calls (the "# Response cadence" section).
# Native routes only: a subscription engine (Claude Code, Codex) brings its own preamble rules.
# Codex calls these "preamble messages" and Claude Code asks for a sentence before the first tool
# call and brief updates when something is found or the direction changes. The line this replaced
# ("before EACH group of tool calls, one short line") was skipped at the start of 6 of 20 measured
# turns; with concrete triggers and a cap on quiet stretches, 0 of 20 (2026-10-19). "In the same
# message as the call" matters: a text-only message ends the turn, so an update sent on its own
# would stop the work.
PROGRESS_UPDATES = (
    "- The user follows your work through short lines in your reply text, not your thinking. "
    "Before your first tool call, say in one sentence what you will do, in the same message as the "
    "call.",
    "- Then add a one-line update, with your next tool call, when you find something that matters, "
    "change approach, hit a blocker or start editing, and at least every five or so calls. One line "
    "covers a batch of related calls.",
    "- Do not narrate each call or trivial reads, or repeat the plan, the prompt or the tool cards.",
)

# A sub-agent's text between tool calls is never shown (its UI keeps only the final message, which
# becomes the task result), so narrating there only spends tokens.
SUBAGENT_UPDATES = (
    "- Nobody sees the text between your tool calls: only your final message comes back, as your "
    "result. Skip progress updates and phase reports; put what matters in that final message.",
)


def delegated_presentation(prompt: str) -> str:
    """Add client presentation guidance on the wire; preserve the persisted user message."""
    return f"<dgc-response-guidance>\n{RESPONSE_GUIDANCE}\n</dgc-response-guidance>\n\n{prompt}"
