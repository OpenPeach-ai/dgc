# DGC Router

Most people who run their own models have more than one computer that can run them: a GPU box under the
desk, a mini PC with lots of unified memory, a Mac, a NAS with a small graphics card. **DGC Router** lets
DGC use all of them. The main model in your chat decides what each helper needs; DGC sends the helper to a
computer that has a free worker and a fitting model.

It is **off** until you turn it on. Off, DGC works exactly as it always has.

## What a "system" is

A system is one model server on your network: Ollama, llama.cpp `llama-server`, vLLM, SGLang, TGI,
LM Studio, or anything that speaks the OpenAI API. Nothing is installed on that computer and DGC never logs
in to it: a helper's tools (reading files, running commands, its own checkout) still run on **this**
computer. Only its model requests go to the other one. Those requests carry the same project text the main
model sees, so add only computers you trust. An `http://` address on another network is not encrypted
unless it uses `https`.

For each system you choose:

- **Jobs**: sub-agents, Pips, or both; and **images** for a computer an image generator uses (a ComfyUI or
  Automatic1111 server is added with the images job only). A generator that names the system holds one of its workers
  while it makes a picture (see Image generation).
- **Workers**: the most requests it works on at once, all models together.
- **Models**: which of its models to use, how many workers each may have, the **context** each always
  runs with, and a short note ("search, small edits").
- **One model at a time**: for a computer with unified memory that holds one big model. While it is working
  DGC never asks it for a different model.

Each model has one fixed context on each system. For Ollama DGC sends that context with every request, so
the model is never reloaded for a different window. When a model is already loaded, DGC suggests the
context it is loaded with.

When you add a system, DGC chooses the model(s) it has loaded right now, never one it would have to load
(that computer may be busy with other work), a cloud model or an embedding model. If nothing is loaded, it
chooses none and you pick: in Settings from its list, with `--models` on the command line, or by telling
the model which.

## A homelab example

Three computers on one home network:

| System | Server | Models | Jobs |
|---|---|---|---|
| `gpu-box.local` | Ollama | `qwen3.8:32b` (2 workers, 64K), `qwen3:8b` (4 workers, 32K) | sub-agents, Pips |
| `nas.local` | Ollama | `qwen3.5:9b` (1 worker, 16K) | Pips |
| `mac.local:1234` | LM Studio | `qwen3.6:35b-a3b` (2 workers, 32K, one model at a time) | sub-agents |

Ask DGC in plain words, and it sets it up with its tools (each change shows you an Allow card with the
exact change first):

> add my GPU box at gpu-box.local for sub-agents and Pips, and the NAS for Pips only

Or from a terminal:

```
dgc router add gpu-box.local --name "GPU box"
dgc router add nas.local --name NAS --jobs pips
dgc router add mac.local:1234 --name Mac --jobs subagents --one-model
dgc router test gpu-box
dgc router on
```

Now when you ask for a review of six files, the main model can send the quick searches to `qwen3:8b` on the
GPU box and the tricky part to `qwen3.8:32b`, and your Pips' routines run on the NAS.

## How a helper is placed

The main model sees one line listing the systems, their models and free workers, and the `task` tool takes
`system`, `model` and `size` (small, medium or large). If it names none, DGC picks: a free worker on an
online system with the sub-agents job, the closest size to what was asked, then the fastest measured model.
An agent definition that sets its own model still uses it.

- **Every worker busy**: the helper waits for one (the default), or with *When busy: use the sub-agent
  model* it runs on your usual sub-agent model. Its result says which.
- **A system stops answering mid-task**: after DGC's usual retries, the helper moves to another system with
  the same model, else another that does sub-agent work, and carries on from where it was. Its result says
  what moved and why. If nowhere can take it, it fails as before, with the reason.
- **Health**: while the Router is on, DGC checks each system once a minute with one small request. A system
  is offline after two missed checks and back after one answer.
- **Several DGC windows** share the same workers: a worker held by another window or terminal counts. A
  window that closes without saying gives its workers back within 30 seconds.
- **Your main model** counts too: if it runs on one of the systems, a turn in progress uses one of its
  workers while the model answers, and gives it back while the turn's own tools run, so a helper or a picture it
  starts on that system doesn't wait for the turn. A cloud model behind the same address (Ollama's `:cloud`
  models) runs elsewhere and uses none.

## How hard a helper thinks

A helper's thinking level is decided in this order, the first that is set winning:

1. **The DGC Router model's own Thinking** (Settings → DGC Router → Edit → a model's Thinking, `dgc router edit ID
   --model NAME --thinking low`, or the model's `router_update set_model thinking`), unless it is *Same as the
   helper*. A small model on a NAS usually runs best Off or Low, even when your main chat is on High.
2. **The agent file's `effort:`** (`.dgc/agents/NAME.md`).
3. **Settings → Models → Sub-agents → Thinking** (`subagent_thinking`, `/subagent thinking low`).
4. **What the model asks for that helper**: the `task` call's own `effort` (off, low, medium, high), low for a quick
   lookup, high for a hard review. Its choice, described in the tool; used only when none of the above is set.
5. **The main chat's level**, as before.

A model whose server says it can't think gets none: its row says "doesn't think", and nothing is chosen for it. The
level used shows where you look: the helper's card and the agent map ("on NAS · qwen3.5:9b · thinking low"), the
terminal's agents list, and `router_status` / `dgc router status` (each model's choice).

## Testing a system

**Test** (or `dgc router test ID`, `/router test ID`) measures what the server can't tell DGC:

- **speed**: time to the first token and tokens a second, on a fixed prompt;
- **parallel**: 1, then 2, then 4 small requests at once; DGC keeps the widest batch that finishes about as
  fast as one, so you know how many it really runs together;
- **tool calls**: one request with one tool. A model that can't call a tool is never given sub-agent work.

It uses a few seconds of that computer's model. The results are kept with the time they were taken.
Test checks only the models the system uses, and never loads one that isn't loaded there now: it says so
instead, and testing that model by name (**Test it** in Settings, `dgc router test ID --model NAME`) loads it.

## In the editor

Settings → **Models** holds every model choice, in blocks: Main model, Fallback, Sub-agents, Pips, Images & video
and **DGC Router**, whose switch reads **Use my other computers**. Switch it on and:

- **Sub-agents** reads "Chosen by DGC Router · 3 systems · 9 workers free"; the usual sub-agent model, used when
  the Router is off (or every worker is busy and you chose so), is one click away.
- **Pips run on** any Pip system, or one system and model (a Pip can still choose its own).
- **Systems** lists each computer, live: online or not, its server and address, jobs, models (use, workers,
  context each, thinking, note), the total context they can hold at once with the server's own check where it reports one
  (llama.cpp's slots, vLLM's and SGLang's room for context), the last test, the hardware line and what it is working
  on. **Test**, **Suggest** (the arithmetic, then **Apply**), **Edit** and **Remove** sit on each.
- **+ Add system** takes an address, finds the server and its models (asking for a key only when the server wants
  one), and lets you choose models, jobs, workers and context, **Test**, then **Save**. Until you save it, the
  new system takes no work. **Look on my network** asks first, then lists what it found, each with **Add**.
- Under **Edit**, **Hardware** takes an exporter's or a `dgc node`'s address and its pairing token, with how to
  set one up.

Every change there is saved at once, apart from the page's Save all. The agent map and each helper's page say where
it ran ("on GPU box · qwen3:8b"), and the status bar shows `Router 9/11` (workers free / total) while the Router is
on; click it for these settings.

Settings → **Token usage** shows what each system did: pick one under **System**, or read the **By system** list
(`dgc usage --system NAS` in the terminal). An Ollama cloud model counts as Ollama Cloud, not as the computer it was
sent through.

## Hardware (optional)

DGC can also show what each computer's GPU and memory are doing: "RTX 4090 · 18 of 24 GB · 34% · 61°C". It
is off until you set it up for a system, and routing never depends on it; it makes **Suggest** exact and
shows up in `/router` and `dgc router status`. DGC reads it itself, at most once a minute with the health
check, and the model never gets a shell on your other computers. Two ways:

- **An exporter you already run.** Prometheus `node_exporter` (`:9100`), NVIDIA's DCGM exporter (`:9400`),
  AMD's device-metrics exporter, Glances (`:61208`, works on a Mac too) or Netdata (`:19999`). Give its
  address and DGC detects which it is:

  ```
  dgc router hardware nas http://nas.local:9100/metrics
  dgc router hardware mac mac.local:61208
  ```

  Whatever an exporter doesn't report is left out (`node_exporter` sees no NVIDIA GPU; DCGM on a GPU that
  shares the computer's memory reports no memory of its own).
- **`dgc node`**, a tiny read-only stats service that comes with DGC. On the other computer:

  ```
  dgc node serve                   # prints a pairing token once
  dgc node install-service         # start it with the computer (a systemd user unit, or a LaunchAgent)
  ```

  On a Mac you reach only over SSH, use `dgc node install-service --system` (a LaunchDaemon that runs as you,
  with nobody logged in). It answers one request, `GET /v1/stats` with the token, on port 8577. It has no
  shell, reads no file of yours and talks to no model: it runs `nvidia-smi`, `amd-smi` or `rocm-smi` (also
  found in `/opt/rocm/bin`), `rocminfo` and reads amdgpu's own counters and `/proc` on Linux, and `sysctl`,
  `vm_stat` and `ioreg` on a Mac (no temperature there: that needs root). Then on this computer:

  ```
  dgc router hardware gpu-box http://gpu-box.local:8577 --token
  ```

  and paste the token. It is kept in `~/.dgc/secrets.json`, bound to that address, like a system's key;
  `/router token ID` and Settings take it too. The model's tools never see it.

On a computer whose GPU shares its memory (an Apple chip, a GB10, an AMD APU) the GPU's memory is the
computer's, and that is what DGC counts.

## Suggest

**Suggest** works out how many workers each model can have at a context, from what DGC knows, and shows
the arithmetic in one line:

```
qwen3:8b: 8.2B Q4 ≈ 4.9 GB + 2 × 32K context ≈ 9 GB → 2 workers fit in 16 GB (1.6 GB kept free)
```

- the model's size (from the server, else its parameters and quantization);
- what a context takes, from the model's layers in Ollama's `/api/show`;
- the memory, from the hardware readout or the system's `memory_gb`, with some kept free for the computer;
- what the server says itself: llama.cpp's slots, vLLM's and SGLang's room for context;
- how many it really runs at once, from **Test**.

When DGC doesn't know the memory it says so and suggests from what Test measured; with nothing to back a
number it suggests none. `dgc router suggest ID [--context 32k]` shows it, `--apply` uses it (showing the
exact change), `/router suggest ID` and Test show it too, and the model applies it with `router_update`
when you ask.

## Pips

A Pip's model can be **DGC Router (any Pip system)**, or one system and model. Its runs take a worker from a
system with the Pips job when they start and give it back when they end; while every such worker is busy,
the run waits in the Pip queue. `pips_parallel_runs` stays the most Pip runs at once. From the terminal:
`dgc pips create NAME --goal ... --router` (or `--router nas/qwen3.5:9b`).

## Keys

A system that needs a key keeps it in `~/.dgc/secrets.json`, bound to that system's address: change the
address and the key is dropped. You paste it in Settings, with `/router key ID`, or with
`dgc router edit ID --key` (read from the terminal or a pipe, never the command line). The model's tools never
read or set a key.

## Commands

- `/router` — status · `/router add ADDRESS [NAME]` · `/router test ID` · `/router on` · `/router off` ·
  `/router key ID` · `/router hardware ID [ADDRESS|off]` · `/router token ID` · `/router suggest ID [CONTEXT]`.
- `dgc router status|add|edit|remove|test|on|off|find|hardware|suggest`, each with `--json` for scripts.
  `find` looks for model servers on this computer's own network (its /24, the known ports only) and only
  when you run it.
- `dgc node serve|token|stats|install-service|uninstall-service`, on the other computer.
- The model's tools: `router_status`, `router_probe`, `router_update` (always asks you, with the exact
  change; Allow once or Deny, never Always) and `router_find` (asks first).

The settings live in `~/.dgc/config.json` under `router`; what DGC measured is in `~/.dgc/router/`.

## What DGC reads from each server

Over the same port DGC already talks to, with a short timeout, never during a turn unless the model asked:

| Server | Models and sizes | Context | Parallel slots | Live load |
|---|---|---|---|---|
| Ollama | `/api/tags`, `/api/show` (size, quant, capabilities: tools, vision, thinking) | `/api/show`, `/api/ps` (loaded context) | measured | DGC's own count |
| llama.cpp `llama-server` | `/v1/models` | `/props` (`n_ctx`) | `/props` (`total_slots`), `/slots` | `/metrics` (with `--metrics`) |
| vLLM | `/v1/models` (`max_model_len`) | same | `/metrics` (`cache_config_info`: KV capacity) | `/metrics` (running, waiting, KV use) |
| SGLang | `/get_model_info` | `/get_server_info` | `max_running_requests`, `max_total_num_tokens` | `/metrics` |
| TGI | `/info` | `max_total_tokens` | `max_concurrent_requests` | `/metrics` |
| LM Studio | `/api/v0/models` (loaded or not, max context, type, quant) | same | measured | DGC's own count |
| OpenAI-compatible | `/v1/models` | — | measured | DGC's own count |

A model that names no size (MLX models on Ollama report none in `/api/tags`) gets the count from `/api/show`,
else an estimate from its file size and quantization.
