# DGC for VS Code & Cursor

Run the **DGC** coding agent inside your editor — a docked chat panel, native menus, streaming tool calls and diffs — driven by **your own model**: Ollama, llama.cpp, LM Studio, vLLM, or any OpenAI-compatible endpoint. Your code stays on your machine.

> Requires the DGC CLI **v0.4.0+** on your PATH. Install it with
> `curl -fsSL https://daguccicode.com/install.sh | bash`, then `dgc setup`.

## What it does

- **Chat panel** in the activity bar — streaming responses, a live *thinking* indicator, collapsible tool cards, and inline diffs.
- **Native menus** (no JSON editing): pick your **model**, **provider**, **permission mode** (`default` / `acceptEdits` / `plan` / `auto`) and **thinking level** from the header pills or the command palette.
- **Permission prompts** inline — allow once / always-allow (saves a rule) / deny.
- **Your model, your machine** — the extension spawns `dgc serve` locally and talks to it over stdio. Nothing leaves your machine unless you point DGC at a cloud model.

## Commands

- **DGC: Focus Chat** — `Ctrl/Cmd+Escape`
- **DGC: Add Selection to DGC** — `Ctrl/Cmd+I`
- **DGC: Cycle Permission Mode** — `Ctrl/Cmd+Shift+M`
- **DGC: Select Model · Connect Provider · Set Mode · Set Thinking · New Session**

## Settings

- `dgc.command` — path to the `dgc` executable (default `dgc`).

Built by Mohit Kalra · [daguccicode.com](https://daguccicode.com) · MIT.
