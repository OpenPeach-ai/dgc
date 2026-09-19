# DGC CLI changelog

Release notes for the `dgc` command-line tool and `dgc serve`. The VS Code extension has its own
[changelog](editors/vscode/CHANGELOG.md), and so does the SDK ([sdk/CHANGELOG.md](sdk/CHANGELOG.md)).
Earlier releases are listed at <https://vibedgc.com/changelog>.

## Unreleased

- **Extra high and Ultra can reason deeply.** The reasoning watchdog stopped every level after
  8,000 tokens of thinking with no answer, which is less than DGC itself asks Claude to think at
  High (16,384) or Extra high (24,576). `think_budget_tokens` now defaults to `auto`, which scales
  with the level: 8,000 tokens at Off and Low, 16,000 at Medium, 32,000 at High and 64,000 at
  Extra high and Ultra. A number still applies to every level, and `0` still turns it off. A
  stored `8000`, the old default that every config file carried, now reads as `auto`.
- **The output cap makes room for that reasoning.** Providers count reasoning against the
  output cap, so the 16,384-token `max_tokens` ended an Extra high phase long before 64,000. A
  request that asks for reasoning now sends `max_tokens` plus the level's allowance, never more
  than the model's reported output limit or half the context window (a 32K window keeps 16,384).
  Claude's legacy extended thinking gets its full Extra high budget (24,576, was 12,288).
- **Prompt words no longer change a thinking level you chose.** "think", "think hard",
  "think harder" and "ultrathink" in a prompt turn thinking on for that turn only when it is Off.
  Low through Extra high, Ultra and a sub-agent's own effort stay as set. "I think…" still turns
  on Low when thinking is Off.

## 0.41.7 — 2026-09-19

Editor protocol remains v14. Pair with extension 0.26.7 and dgc-sdk 0.5.3.

- **0.41.6, released.** The v0.41.6 tag's macOS test jobs failed (two paths spelled `/var` against
  `/private/var`), so no GitHub Release was made for it and it never reached vibedgc.com. 0.41.7
  is that release with the fix: a screenshot handed to a vision model is named relative to the
  project on macOS too. Everything listed under 0.41.6 below ships in 0.41.7.

## 0.41.6 — 2026-09-19 (tagged, not released)

Editor protocol remains v14. Pair with extension 0.26.7 and dgc-sdk 0.5.3.

### For everyone

- **Ultra delegates where it saves time.** Measured on six realistic multi-part tasks: the parts
  of a task that change different files now go to sub-agents together in one parallel batch, and
  the lead does single-part work itself; a critic runs when you ask for a review or no test can
  check the change. (Splitting everything and always adding a critic was 2-6x slower at the same
  quality.) Sub-agents stay one level deep, briefs carry project-relative paths, the roster lists
  your own named agents, and a `todo` update beside the `task` calls no longer serialises the batch.
- **Sub-agents get their own context window.** `subagent_context_size` (0 uses the main window), a
  named agent's `context_size:` frontmatter, `/subagent context 64k`, and Settings → Agents.
- **The sub-agent route can change mid-turn**, as the main model can: model, host, transport, key
  and window apply from the next sub-agent.
- **Changing the model mid-turn no longer hangs.** A request that had not started answering is sent
  again to the new model at once, instead of waiting out the old one (up to 15 minutes on Ollama
  Cloud, which DGC also mistook for a model still loading).
- **Thinking levels reach the model.** On Ollama, Low, Medium and High are sent as those levels and
  Extra high as `max` (they all used to be plain "think on"); a level changed mid-turn applies from
  the next request; GLM-5's Off no longer leaks its reasoning into the answer.
- **Eyes for a model without vision.** When the chat's model cannot see images, an attached or
  produced image is shown to a vision-capable model (the sub-agent model, or a named agent with
  vision) and its report goes to the chat's model. The card names the model that looked.
- **Parallel sub-agents no longer lose work to shared caches.** `__pycache__`, `*.pyc` and test
  runner caches are not counted as a child's changes.
- **`repo_map` sees plain job folders.** A workspace that is not a git repository and holds only
  notes, CSV or other text files is no longer reported as 0 files. The map is rebuilt from disk on
  every call, so files added during a session show up the next time the agent maps the folder.
- **The sandbox also hides your real home directory.** With the OS sandbox on, shell commands
  could not read `$HOME`; they now also cannot read the account's home directory when `HOME`
  points somewhere else (as it does for SDK sessions), nor the SDK client's whole state directory
  (audit and usage logs, not just its isolated home).
- **The sandbox is checked, not assumed.** DGC now verifies that bubblewrap actually confines
  (unprivileged user namespaces can be disabled, or the binary can be too old) before reporting a
  sandbox available, so a "required" sandbox cannot pass on a host where every `bwrap` invocation
  fails.
- **Provider keys stay out of tool subprocesses.** DGC no longer hands `DGC_API_KEY` (or the
  other `DGC_*_API_KEY` values it consumes) to the environment of a `bash`, `python`, `monitor`
  or hook subprocess, in any mode, so `printf %s "$DGC_API_KEY" | rev` in an unsandboxed shell no
  longer recovers the key. The model client still uses it.
- **Release builds are green again.** The v0.41.4 and v0.41.5 tag builds failed (an SDK socket
  path too long on macOS, and the extension's tests), so those versions have no GitHub Release.
  Both causes are fixed for 0.41.6. Every GitHub Action in the release, CI and CodeQL workflows
  is pinned to a commit.

### For applications that embed DGC (dgc-sdk 0.5.3 needs these)

- **Session policy.** `dgc serve` accepts a per-process policy from the program that starts it,
  in the `DGC_SESSION_POLICY` environment variable: deny and ask rules, auto-mode-only denies, and
  sandbox settings. The rules hold in every permission mode, `auto` included, cannot be removed by
  a command or a mode switch, and are never written to any config file. A policy that does not
  parse denies every tool. The `ready` handshake reports the policy it read
  (`capabilities.session_policy`), so the launcher can confirm it took effect.
- **Unattended shell only in the sandbox.** A session policy can require that, in `auto` mode,
  `bash` and `monitor` run only inside the OS sandbox and that the `python` tool (which is never
  sandboxed) is refused. In the other modes each shell command stays a permission request.
- **Workspace rules cannot pre-approve commands for an SDK policy.** When the launcher's policy
  says so (`project_allow: false`), the workspace's own `.dgc/permissions.json` may add ask and
  deny rules but its allow rules are not loaded — and neither are the user's own stored allow
  rules — so a cloned repository, or an inherited `~/.dgc`, cannot approve its own shell commands.
- **Workspace agent definitions are gated too.** A new `project_agents: false` in the session
  policy stops `dgc serve` from loading a workspace's `.dgc/agents/*.md`, which can choose a model
  endpoint and a credential env var. When the launcher does allow them, a project definition
  contributes only its persona: its `base_url`, `api_key_env`, `api_mode` and `model` are dropped,
  and no agent definition (project or personal) may read a `DGC_*_API_KEY`.
- **Searches respect denied paths.** A session policy's ask on search tools reaches the launcher
  in `plan` mode too, so a search over a tree that contains a denied path can be refused; the
  refusal is attributed to the application's policy, not to the user.
- **A launcher can hand a key through a file.** `dgc serve` reads a provider key from
  `DGC_<NAME>_API_KEY_FILE` (a 0600 file) and deletes the file before any tool runs, so the key
  never sits in the child's environment block.
