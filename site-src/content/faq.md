---
title: Frequently asked questions
description: Eight practical answers about licensing, data, offline use, platforms, removal, exports, telemetry, and benchmarks.
---

# Frequently asked questions

## Can I use DGC commercially?

The public release is licensed under PolyForm Noncommercial 1.0.0. Qualifying personal, research, educational, charitable, public-interest, and other noncommercial uses are permitted under the license terms. Commercial use requires a separate written agreement. The repository’s [LICENSE](https://github.com/OpenPeach-ai/dgc/blob/main/LICENSE) file controls; if your use supports a business or paid service, send the commercial-use form with your company, expected seats, and use case. We aim to reply within two business days.

## What leaves my machine?

DGC sends conversation context to the model route you select. With a model on the same machine, prompts, relevant code excerpts, and tool results can stay there. With a model on another host, a cloud API, or a subscription, that service receives the context needed to answer under its own terms. Optional web search, fetch, MCP, and other configured integrations receive the queries or tool arguments you direct to them. A configured language server receives workspace metadata and the full text of documents queried through code intelligence. Interactive DGC may also make a small version check that contains no prompt, code, or session content; a successful check is cached for a day, while a failed check may retry on a later launch.

## Can DGC run fully offline?

Yes, the coding loop works without internet access when DGC is already installed and its model, toolchains, and any integrations you need are reachable locally. Cloud providers, subscription routes, web search, remote MCP servers, updates, and downloads naturally require a connection. The background CLI version check fails quietly when the site is unreachable and does not block the agent.

## Which operating systems does DGC support?

DGC requires Python 3.10 or newer. The one-line Bash installer supports Linux and macOS. On Windows, use WSL for the CLI; the VS Code or Cursor extension can connect to that workspace. OS confinement currently has truthful backends on Linux and macOS. A requested sandbox fails closed on an unsupported platform rather than pretending to isolate commands.

## How do I uninstall DGC?

The standard installer puts the application in `~/dgc` and a symlink at `~/.local/bin/dgc`; it does not require root. Remove those two paths to remove the installed program. CLI-managed configuration, credentials, sessions, plans, checkpoints, and other private state live separately under `~/.dgc`; remove that directory only if you also want to erase that CLI state. Delete the DGC extension through your editor’s Extensions view. Credentials saved by the extension live in the editor's SecretStorage, while extension settings and update metadata live in editor-managed storage; use the editor or operating system's credential and profile controls if you also want those records removed.

## What is included in a training export?

Each selected session becomes one JSONL record with an OpenAI-style `messages` array, portable assistant tool calls and tool results, plus small metadata such as model, project basename, turn and tool counts, edit counts, and an outcome flag. Reasoning traces, provider continuation blobs, images, and internal bookkeeping are omitted. Every emitted field is deep-scrubbed for configured secrets and high-confidence credential patterns. Export is read-only and local; DGC never uploads the file.

## Does DGC collect telemetry?

No product-usage telemetry is sent by the CLI or editor. DGC keeps sessions and operating metrics locally so features such as resume, rewind, and benchmark accounting can work. Interactive CLI launches may check `vibedgc.com/version.json`; successful checks are cached for a day and failed checks may retry later. A self-hosted VSIX checks `/vscode/version.json` at most daily by default, while Marketplace/Open VSX builds skip that request and the setting can be disabled. Neither request contains prompts, code, tool arguments, or credentials. Website measurement is separate and described in the Privacy notice, including Do Not Track handling.

## How was the benchmark run?

The current {{BENCH_PUBLICATION_LABEL}} records the same model alias, caller-declared digest, endpoint URL, and task set for every agent; the saved runner verified the {{BENCH_CONTEXT_TOKENS_FORMATTED}}-token context size but {{BENCH_WEIGHTS_CLAUSE}}. Each exercise starts in an isolated workspace and is graded by its official test suite. The first round asks the harness to implement and test the stub; only a failure continues the same session for the final recovery round with a bounded failure tail whose paths are normalized to the live workspace. The result is {{BENCH_METRIC}}. DGC’s stricter publication gate also requires complete engines, tasks, runner provenance, transport, and usage accounting; this {{BENCH_PROBLEMS}}-task slice is disclosed separately because it does not clear that gate.
