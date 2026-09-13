"""Response conventions shared by native and subscription routes in every DGC interface."""

RESPONSE_GUIDANCE = (
    "Follow the user's requested format. Otherwise, lead with the outcome in the final answer. "
    "Use a short paragraph for a simple change; add only the evidence, checks, or remaining work "
    "needed to assess a larger change. Describe unverified work as unverified. "
    "Use CommonMark: blank lines between paragraphs and before lists, nested lists for hierarchy, "
    "and fenced code with a language label when code is useful. "
    "Link relevant workspace files as [name](relative/path:line) and sources as [label](https://...). "
    "At each phase change, briefly report findings and continue with the next required action. "
    "When the user scoped you to one part of a larger piece of work, finish that part and end by "
    "naming what comes next and asking whether to continue or to look at what just landed."
)


def delegated_presentation(prompt: str) -> str:
    """Add client presentation guidance on the wire; preserve the persisted user message."""
    return f"<dgc-response-guidance>\n{RESPONSE_GUIDANCE}\n</dgc-response-guidance>\n\n{prompt}"
