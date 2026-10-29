---
name: mod-author
description: Write or change a DGC mod, a small program that watches what DGC does, may hold or stop a risky step, draws a panel, band, status line or toast, or adds a slash command. Use when the user wants DGC itself to show, track, guard or automate something.
---
Build the requested mod: $ARGUMENTS

A mod is a folder with a `dgc-mod.json` and one entry file. DGC runs it as its own small process in a sandbox:
no network, no home folder, its own folder read-only. Anything else it gets, it asks DGC for, and only what its
manifest declares. A mod can never approve anything. On a step it may only watch, ask the user first, or stop
the step. The user allows exactly what the manifest asks for, so ask for the least the mod needs.

Put the mod where the user says. If they don't say, a new folder in the project such as `mods/NAME/` is a good
default. Read existing mods first (`dgc mods` lists them) and change one rather than writing a second that does
the same thing.

## dgc-mod.json

```json
{"name": "tally", "version": "1.0.0", "entry": "main.py", "title": "Tally",
 "description": "Counts this session's steps.",
 "capabilities": {"events": ["tool.result"], "draws": ["status"], "commands": [{"name": "tally", "description": "Steps so far"}]}}
```

- `name`: 1–40 lower-case letters, digits and dashes, starting with a letter. `version` like `1.0.0`.
- `entry`: a `.py` file (Python), or `.mjs`/`.js` (Node.js, which must be installed), inside the folder.
- `capabilities`, each optional:
  - `events`: any of `session.start`, `session.end`, `prompt.submit`, `tool.call`, `tool.result`, `turn.start`,
    `turn.complete`.
  - `draws`: any of `pane` (a panel beside the chat), `band` (above the prompt), `status` (the status line),
    `toast`.
  - `commands`: at most 8, each `{"name", "description"}`; the user runs it as `/name`, with no model turn.
  - `reads`: any of `usage` (token use), `transcript` (this conversation), `project` (files in the project),
    `git` (the project's git status).
  - `network`: at most 16 host names (`api.example.com`, `*.example.com`); the mod fetches through DGC, only these.
  - `model`: true to ask the session's model a short question. `rewrites_prompt`: true to change what the user
    sends (it needs `prompt.submit`, and DGC always tells the user what was changed).

## The code (Python)

```python
import dgc_mod as dm

mod = dm.Mod()

@mod.on("tool.call")                         # {"tool": "bash", "args": {...}}
def careful(event):
    if "git push --force" in str(event["args"]):
        return dm.ask("This rewrites the remote branch.")   # or dm.deny("…"); return None to only watch

@mod.on("tool.result")
def counted(event):
    steps = mod.state_get("steps", 0) + 1
    mod.state_set("steps", steps)
    mod.set_ui("status", dm.Text(f"{steps} steps"))

@mod.command("tally")
def tally(args):
    return dm.Text(f"{mod.state_get('steps', 0)} steps this session")

mod.run()
```

- `tool.call` must answer within 1.5 s and `prompt.submit` within 2 s; a mod that doesn't has only watched.
  Commands have 10 s. `dm.rewrite(text, note)` answers `prompt.submit`.
- Drawing: `mod.set_ui(slot, tree)` for `pane`, `band` or `status` (None clears it); `mod.toast(text)`. A tree
  is made of `Box`, `Row`, `Column`, `Text`, `Markdown`, `Button`, `Input`, `Select`, `Bar`, `Table` and
  `Sparkline`, at most 400 elements; `tone` is one of muted, strong, accent, ok, warn, bad.
  `@mod.render(slot)` redraws a slot when DGC asks (a new window); `@mod.action` hears a Button, Input or Select.
- Reading: `mod.read_file(path)` (project files, `reads: project`), `mod.git()`, `mod.usage()`,
  `mod.transcript(limit)`, `mod.fetch(url)` (declared hosts only), `mod.ask_model(prompt)` (`model: true`).
- Keeping things: `mod.state_get/state_set` for this session, `mod.store_get/store_set` across sessions.
- `print()` goes to the mod's log. Never write anything else to stdout: that pipe is how DGC and the mod talk.

In JavaScript the same API comes from `@vibedgc/sdk/mods`: `new Mod()`, `mod.on`, `mod.command`, `ask`, `deny`,
`Text`, `mod.setUi`, `mod.toast`, `mod.fetch`, `mod.readFile`, `mod.stateGet`/`stateSet`, `mod.run()`.

## Check it, then hand it over

1. `dgc mods validate FOLDER` checks the manifest against the code (an event handled but not declared, a
   command declared but not handled). Fix every line it prints.
2. `dgc mods test FOLDER` starts the mod in its sandbox and sends it each event it declares. It must say
   "✓ all passed".
3. Tell the user how to try it and keep it. The first mod you write in the project in a session, DGC asks them
   once whether to turn on the mods it writes; allowed, it already runs for this session and reloads as you change
   it (Not now: `/mods` lists it with an Allow). `dgc mods dev FOLDER` runs DGC with the mod for one session and
   reloads it on every change. `dgc mods install FOLDER` then `dgc mods allow NAME` keeps it, and `/mods`
   lists it or turns it off. A plugin can carry mods too: a `dgc-mod.json` at its root or in `mods/NAME/`.

A mod that hears `tool.call` also watches the user's Pips' runs, where nobody is there to answer, so its `ask`
stops the step. Write its reasons so they read well in a Pip's report. `dgc --safe-mode` starts no mods: that is
how the user gets out of a broken one. Never put a key or password in a mod's files.
