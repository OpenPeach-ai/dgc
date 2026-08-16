<div align="center">

```
██████╗   ██████╗   ██████╗
██╔══██╗ ██╔════╝  ██╔════╝
██║  ██║ ██║  ███╗ ██║
██║  ██║ ██║   ██║ ██║
██████╔╝ ╚██████╔╝ ╚██████╗
╚═════╝   ╚═════╝   ╚═════╝
```

**A coding-agent CLI for the models *you* run.**
Built by Mohit Kalra.

</div>

---

DGC is an interactive coding agent that lives in your terminal — in the spirit of Claude Code, Codex CLI and Kimi Code, but pointed at **your own model, on your own machine**: Ollama, llama.cpp, LM Studio, vLLM, or any OpenAI-compatible cloud endpoint (OpenAI, OpenRouter, Groq, DeepSeek, Together, Mistral…).

![DGC landing — dagucchicode.com](docs/screenshot.png)

Pure Python 3.10+, three dependencies (`rich`, `prompt_toolkit`, `requests`). Your code and your prompts never leave your machine unless the model you pick is a cloud one.

## Install

One line — nothing needs root:

```bash
curl -fsSL https://dagucchicode.com/install.sh | bash
```

Then point it at a model and go:

```bash
dgc setup     # pick a provider + model, interactively
dgc doctor    # check it can reach your model
dgc           # start the interactive agent
```

<sub>Prefer to do it by hand? See [Manual install](#manual-install). Want your own coding agent to set it up? See [Let your agent install it](#let-your-agent-install-it).</sub>

## Connect any model in one command

`dgc setup` walks you through these; you can also switch any time inside the REPL with `/connect <preset>`:

| Preset | Endpoint | Notes |
|---|---|---|
| `ollama` | `localhost:11434/v1` | local, default |
| `llamacpp` | `localhost:8080/v1` | `llama-server` from llama.cpp |
| `lmstudio` | `localhost:1234/v1` | LM Studio |
| `vllm` | `localhost:8000/v1` | vLLM |
| `openai` | `api.openai.com` | prompts for API key |
| `openrouter` | `openrouter.ai` | 100s of models, one key |
| `groq` · `deepseek` · `together` · `mistral` | — | cloud, prompt for key |

```
/connect ollama
/connect openrouter sk-or-...
/models                 # list what the endpoint serves
/model qwen3.6:27b-q8_0
```

## Permission modes

Switch live with `/mode` (cycles) or `/mode <name>`, or launch with `--mode`:

| Mode | Behavior |
|---|---|
| `default` | reads & known-safe commands auto-run; **writes and other commands ask** |
| `acceptEdits` | **file edits auto-approved**; shell commands still ask |
| `plan` | **read-only** — the agent researches and proposes a plan you approve |
| `auto` | **full-auto** — everything approved, the agent works unattended until done |

Fine-grained rules on top (Claude Code syntax, evaluated deny → ask → allow):

```
/permissions allow Bash(npm run *)
/permissions allow Edit(src/**)
/permissions deny  Bash(rm -rf *)
/permissions deny  Read(**/.env)
```

Approval prompts always offer **allow once / always allow (saves a rule) / deny**.

## What's in the box

- **Interactive REPL** — streaming output, live tool-call display, diffs, todos.
- **Plan mode** — read-only research → `present_plan` → approve into auto/acceptEdits/default (like ExitPlanMode).
- **Runs tiny local models** — if the endpoint has no native tool-calling, DGC auto-switches to a text tool-call protocol and parses it.
- **Auto context compaction** — near ~70% of your model's context window, older turns are summarized so long sessions don't overflow. `/compact` forces it.
- **Thinking modes** — `/think off|low|medium|high`; `think` / `think hard` / `ultrathink` in a prompt bump it for that turn. `<think>` streams dim.
- **Memory** — `DGC.md` in your project (and `~/.dgc/DGC.md` personal) load into every session; `#a fact` quick-adds; `/init` writes a project guide.
- **Skills** — drop a `SKILL.md` in `.dgc/skills/<name>/`; the model invokes it when the description matches.
- **Tools** — `read_file` · `write_file` · `edit_file` · `bash` · `glob` · `grep` · `web_fetch` · `todo` · `skill` · `save_memory` · `present_plan`.

## REPL conveniences

```
just type            ask DGC — it uses tools to act on your project
#fact                quick-add a memory to DGC.md
!cmd                 run a shell command directly
@path/to/file        attach a file's contents to your message
/help                every command
```

## Commands

```
dgc                  interactive REPL
dgc setup            configure provider / model / context
dgc doctor           verify the endpoint + model
dgc -p "fix the bug in auth.py" --mode auto    one-shot, non-interactive
dgc --model NAME --base-url URL --api-key KEY   override + persist
```

## Manual install

```bash
git clone <your-repo-or-tarball> dgc && cd dgc
python3 -m venv .venv && .venv/bin/pip install -e .
.venv/bin/dgc setup
# optional: ln -sf "$PWD/.venv/bin/dgc" ~/.local/bin/dgc
```

## Let your agent install it

Paste this to your Claude Code / Codex / any coding agent:

> Install DGC for me: run `curl -fsSL https://dagucchicode.com/install.sh | bash`, then run `dgc setup` and connect it to my local Ollama (or ask me which provider). Verify with `dgc doctor`.

## Configuration

`~/.dgc/config.json` (created on first change):

```json
{
  "base_url": "http://localhost:11434/v1",
  "api_key": "ollama",
  "model": "qwen3:8b",
  "mode": "default",
  "thinking": "off",
  "context_size": 32768,
  "max_turns": 40,
  "bash_timeout": 120,
  "permissions": {"allow": ["Bash(git status:*)"], "ask": [], "deny": ["Bash(rm -rf *)"]}
}
```

Set `context_size` to your model's real context window — compaction timing depends on it.

## Development

```bash
.venv/bin/python tests/run_tests.py   # units + end-to-end against a mock LLM server
```

See [AGENTS.md](AGENTS.md) for the layout and conventions.

## License

MIT © 2026 Mohit Kalra.
