"""ChatDGC: a ChatGPT-style chat in DGC, with an engine of its own (founder, 2026-10-09).

It shares only the lowest layer with Work and Pips: the connection to the user's models (llm.LLMClient), the usage
ledger and, in later phases, web search and document reading. Its prompt, answer formatting, reply limits and
store are its own, so the coding chat and ChatDGC can change independently.
"""
