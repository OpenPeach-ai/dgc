# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose files, credentials, model
traffic, or command execution. Use GitHub's private vulnerability reporting for
`OpenPeach-ai/dgc`. Include the DGC version, operating system, permission mode, reproduction steps,
and whether a local or cloud model endpoint was used.

## Security model

DGC is a local coding agent, so its intended capabilities include reading a workspace, modifying
files after policy approval, and executing approved commands. In its native local/API tool loop,
its safety boundaries are:

- canonical workspace confinement for structured filesystem tools;
- a separate approval for paths outside the workspace in `default` and `acceptEdits`; choosing
  "always allow" persists a scoped external-directory rule, while `plan` denies external paths and
  `auto` permits model-requested external structured paths unless a deny rule blocks them;
- by baseline, model-requested arbitrary shell commands ask in `default` and `acceptEdits` and are
  denied in `plan`; a matching explicit deny/ask/allow rule can change the default/acceptEdits
  decision, while direct user `!cmd` commands do not prompt again;
- deny rules take precedence in every native-loop mode, including `auto`;
- private/link-local/loopback web fetches are blocked and redirects are revalidated;
- untrusted workspaces cannot start unattended one-shot automation without explicit `--trust`;
- API credentials are separated from normal configuration and editor secrets use SecretStorage.

`auto` deliberately approves model-requested actions. Use it only in a trusted workspace and with a
model/provider you trust. OS sandboxing wraps native-loop spawned shell commands and hooks; it does
not confine parent-process structured file tools or delegated vendor-CLI processes and is not a
substitute for permission review.
Delegated subscription turns map the selected mode to the official vendor CLI; DGC's fine-grained
tool rules do not wrap that vendor's internal tool calls. The vendor CLI runs unsandboxed in the
workspace and inherits DGC's ambient process environment, including any unrelated credentials it
contains. Use a trusted vendor CLI and launch DGC with only the environment secrets that turn needs.
Configured MCP and language-server commands are also trusted executables: they start unsandboxed in
the workspace, and their own process-level filesystem and network activity is not mediated by DGC's
tool permissions, shell sandbox, or workspace mutation lease.

Supported security fixes target the latest release. Release artifacts and checksums are published on
vibedgc.com. The current GitHub release has provenance attestations, and the tagged-release workflow
is configured to produce them for future builds.
