# DGC CLI changelog

Release notes for the `dgc` command-line tool and `dgc serve`. The VS Code extension has its own
[changelog](editors/vscode/CHANGELOG.md), and so does the SDK ([sdk/CHANGELOG.md](sdk/CHANGELOG.md)).
Earlier releases are listed at <https://vibedgc.com/changelog>.

## 0.41.6 — 2026-09-19

Editor protocol remains v14. Pair with extension 0.26.7 and dgc-sdk 0.5.3.

### For everyone

- **`repo_map` sees plain job folders.** A workspace that is not a git repository and holds only
  notes, CSV or other text files is no longer reported as 0 files. The map is rebuilt from disk on
  every call, so files added during a session show up the next time the agent maps the folder.
- **The sandbox also hides your real home directory.** With the OS sandbox on, shell commands
  could not read `$HOME`; they now also cannot read the account's home directory when `HOME`
  points somewhere else (as it does for SDK sessions).
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
  says so, the workspace's own `.dgc/permissions.json` may add ask and deny rules but its allow
  rules are not loaded, so a cloned repository cannot approve its own shell commands.
- **Searches respect denied paths.** A session policy's ask on search tools reaches the launcher
  in `plan` mode too, so a search over a tree that contains a denied path can be refused.
