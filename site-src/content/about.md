---
title: About DGC
description: Why DGC exists, who builds it, and how to help shape the coding-agent harness.
---

# The harness is the product

DGC is a coding agent for the models you choose to run. It works in the terminal and in VS Code or Cursor, and it can connect to a local model, a compatible API, or a supported coding subscription. On native local and API routes, the model proposes while DGC supplies the operating system around it: project context, tool calls, permission checks, edits, test runs, recovery, and the final answer you see.

That distinction is the reason DGC exists. A capable model inside a thin chat wrapper is still missing most of what makes coding work dependable. It needs to find the right files without flooding its context, make exact changes, keep tool results intact, recover from a failed test, and know when the evidence is strong enough to stop. Those behaviors live in the harness. They are also where a smaller local model can gain—or lose—a surprising amount of capability.

DGC is local-first, not local-only. Point it at Ollama, llama.cpp, LM Studio, or vLLM and the working conversation can stay on infrastructure you control. Point it at Anthropic, OpenAI, or another compatible API and DGC keeps its native tool, permission, plan, goal, session, and presentation loop around that provider. A supported subscription is delegated differently: DGC passes your prompt and mapped mode to the vendor’s official CLI, retains its own session record, runs its SessionStart and Stop hooks, and presents the result in the terminal/editor surface, while that vendor CLI owns the model and tool execution for the turn.

The project is built and led by Mohit Kalra. DGC is an OpenPeach project, maintained in the `OpenPeach-ai/dgc` repository as a focused, independently installable coding tool. Its public materials do not claim an outside funding round or institutional backer; development is managed directly by the founder, with commercial licensing available as the path for organizations whose use falls outside the public license.

DGC is source-available under the PolyForm Noncommercial 1.0.0 license. Personal, research, educational, charitable, public-interest, and other qualifying noncommercial uses are permitted under the license terms. Commercial use requires a separate agreement. The full [LICENSE](https://github.com/OpenPeach-ai/dgc/blob/main/LICENSE) file controls; the website summaries are there to make the starting point understandable, not to replace the license.

## Work on this

DGC is developed in public enough for careful outside work to matter. Start with [CONTRIBUTING.md](https://github.com/OpenPeach-ai/dgc/blob/main/CONTRIBUTING.md): it covers the supported Python and Node versions, setup, the preflight gate, and the security expectations for changes. New tools need permission, path-boundary, failure-status, and transcript coverage. Provider changes need wire and streaming tests. Interface work should carry a regression test where practical.

Good first contributions are small, observable improvements: tighten a confusing diagnostic, add a missing cross-platform test, or turn a documented edge case into a reproducible fixture. Check the repository’s [good first issue](https://github.com/OpenPeach-ai/dgc/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22) label for currently scoped work. If it is empty, start with a narrowly scoped draft pull request that explains the evidence and proposed boundary before investing in a large change.

There are no advertised roles today. The commercial form is reserved for licensing enquiries. Use the contribution guide for product changes and the security page for vulnerability reports; neither is a jobs inbox.
