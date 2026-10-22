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
# Codex calls these "preamble messages" (its newest templates: start with a commentary message, never
# leave the user without one for more than 60 seconds, and a final answer that stands on its own
# because commentary is collapsed after it); Claude Code asks for a sentence before the first tool
# call and brief updates when something is found or the direction changes. Measured 2026-10-19: the
# old "before EACH group of tool calls, one short line" was skipped at the start of 6 of 20 turns,
# this rule's opening sentence at none. "In the same message as the call" matters: a text-only
# message ends the turn, so an update sent on its own would stop the work. The editor folds a turn's
# one-line updates and tool rows into its "Worked for" row once the answer arrives (detailed messages
# stay), so the last line says why the answer must stand alone; "may" because the terminal keeps them.
PROGRESS_UPDATES = (
    "- The user follows your work through short lines in your reply text, not your thinking. "
    "Before your first tool call, say in one sentence what you will do, in the same message as the "
    "call.",
    "- Then add a one-line update, with your next tool call, when you find something that matters, "
    "change approach, hit a blocker or start editing, and never leave the user more than about a "
    "minute without one. One line covers a batch of related calls.",
    "- When the user should read something in full before you go on, such as a diagnosis or your "
    "plan for substantial work, write it out with formatting in the message with your next tool "
    "call, then keep working. Only this kind of update runs past a sentence or two.",
    "- Do not narrate each call or trivial reads, or repeat the plan, the prompt or the tool cards. "
    "Make the final answer stand on its own: once it arrives, the one-line updates and tool calls may "
    "fold away out of sight, and the user may not have read them.",
)

# An open model cannot see a clock, so "about a minute" needs help: when a tool round ends and the
# user has read nothing from the model for this long, DGC adds quiet_note() to that round's reminders
# (Agent._quiet_note). Once per silence; never for a sub-agent or a Pip, whose text nobody sees live.
# Measured 2026-10-20 (48 turns, deepseek-v4.1-flash and glm-5.3): with the time-based wording the
# longest a tool round ended into a silence fell from 67.6s to 32.9s, so the note was not needed there;
# in a recorded turn whose test run takes 65s it fired after each run and the next message carried
# an update 3 times of 4. A single reply spent thinking (up to 149s) is out of its reach.
QUIET_NOTE_AFTER_S = 60


def quiet_note(seconds: float) -> str:
    return (f"It has been {int(seconds)}s since the user last heard from you. Add a one-line update "
            "with your next tool call.")


# A sub-agent's text between tool calls is never shown (its UI keeps only the final message, which
# becomes the task result), so narrating there only spends tokens.
SUBAGENT_UPDATES = (
    "- Nobody sees the text between your tool calls: only your final message comes back, as your "
    "result. Skip progress updates and phase reports; put what matters in that final message.",
)


def delegated_presentation(prompt: str) -> str:
    """Add client presentation guidance on the wire; preserve the persisted user message."""
    return f"<dgc-response-guidance>\n{RESPONSE_GUIDANCE}\n</dgc-response-guidance>\n\n{prompt}"
