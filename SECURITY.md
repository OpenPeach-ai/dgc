# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose files, credentials, model
traffic, or command execution. Use GitHub's private vulnerability reporting for
`OpenPeach-ai/dgc`. Include the DGC version, operating system, permission mode, reproduction steps,
and whether a local or cloud model endpoint was used.

## Security model

DGC is a local coding agent, so its intended capabilities include reading a workspace, modifying
files after policy approval, and executing approved commands. Its safety boundaries are:

- canonical workspace confinement for structured filesystem tools;
- a separate approval for paths outside the workspace;
- every arbitrary shell command asks in `default` and `acceptEdits`, and is denied in `plan`;
- deny rules take precedence in every mode, including `auto`;
- private/link-local/loopback web fetches are blocked and redirects are revalidated;
- untrusted workspaces cannot start unattended one-shot automation without explicit `--trust`;
- API credentials are separated from normal configuration and editor secrets use SecretStorage.

`auto` deliberately approves model-requested actions. Use it only in a trusted workspace and with a
model/provider you trust. OS sandboxing is defense in depth, not a substitute for permission review.

Supported security fixes target the latest release. Release artifacts and checksums are published on
vibedgc.com; tagged GitHub builds include provenance attestations.
