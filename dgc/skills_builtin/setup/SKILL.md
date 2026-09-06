---
name: setup
description: Connect or troubleshoot DGC's model provider, subscription CLI, editor backend, or permission configuration. Use for DGC setup problems, not generic project installation.
---
Diagnose the DGC setup problem: $ARGUMENTS

Start with the actual route and symptom. Native DGC supports Ollama, Anthropic, OpenAI Responses and
compatible Chat Completions endpoints. Subscription routes delegate to an installed vendor CLI,
which owns login and its tool permissions. Do not diagnose every route as /v1/chat/completions.

Run `dgc doctor` and inspect only relevant status, endpoint, model, version and transport fields.
Use `dgc --help` or the installed command documentation when syntax is uncertain. An editor
protocol mismatch is an extension/backend version problem: verify the executable selected by
`dgc.command`, `dgc protocol describe`, and the installed extension version before changing models.
Global editor auto-update does not prove a particular extension is unpinned or its catalog is fresh.

For native setup, use `dgc setup` or the client's Connect Provider control; use `/model` to inspect
served model IDs. An empty list can mean unavailable discovery, authentication failure or a server
problem, not necessarily an unreachable endpoint. Confirm generation as well as model discovery.
For subscription setup, inspect the selected vendor's installed version and login status; follow
its supported login flow. Never substitute a DGC API key for subscription authentication.

Credentials belong in masked provider prompts, SecretStorage, protected secret storage or named
environment variables. Check presence without printing values. Do not dump configuration, credential
files or the environment. Do not put keys in URLs, shell arguments, logs, screenshots or model input.
Keep fallback/subagent endpoints and credentials independently scoped when changing routes.

Permission rules use deny → ask → allow. Prefer native read/search/git_diff tools for inspection.
Shell commands, Git operations and build/test scripts can execute repository code; a familiar name
is not a safety guarantee. Explain the actual command and the scope of any proposed persistent rule.
Do not recommend blanket/prefix shell permissions as a routine connection fix or weaken a denial.
Honor already authorized configuration changes using supported controls and preserve other settings.

Recheck the affected route after a change. Report the observed cause, changed settings by name,
verification result and remaining limitation. Example: a remote editor needs its own reachable model
endpoint; changing the local browser's localhost URL does not fix the remote backend connection.
