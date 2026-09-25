# Local connector build — CLI 0.44.0 / extension 0.29.0

For the complete migration package, file map and all release gates, start with
[SETTINGS_PLUGINS_MIGRATION_HANDOFF.md](SETTINGS_PLUGINS_MIGRATION_HANDOFF.md).

This is a local development build, based on the official `v0.44.0` tag
`29d9a9746965aeb8fe39fb9f02876b193e59cc1c`, with the existing plugin/settings
work migrated onto it. Nothing was published. Source branch:
`codex/connectors-044`. The old branch and the pre-migration work were retained;
backup/merge evidence is under `output/migration-044/`.

## Try it

Reload the Cursor window, open the DGC gear, then **Plugins → Apps**. Both local
Cursor Server and VS Code installations use `vibedgc.dgc-0.29.0`. The installed
CLI launcher points to this checkout's `.venv/bin/dgc`, with 0.44.0 editable
metadata. The version numbers alone do not identify this development build.
Installing a later official CLI or extension could replace the added features.

| Connector | DGC setup | Where to select apps/tools |
| --- | --- | --- |
| Composio | Existing browser sign-in | Composio For You → Connect Apps |
| Zapier | Create an Other server in Zapier MCP, generate a connection token, paste the token into DGC | Zapier MCP dashboard |
| Make | Browser sign-in; choose organization and scopes | Make scenarios and app connections |
| n8n | Enable instance MCP; paste its `/mcp-server/http` URL; choose browser sign-in or personal access token | Your n8n instance, including explicit workflow exposure |
| Arcade | Create a gateway with Arcade Auth, select its tools, paste its `https://api.arcade.dev/mcp/...` URL, then sign in | Your Arcade gateway and provider authorization |

For Remote SSH, loopback addresses belong to the machine running DGC, not the
computer displaying Cursor. n8n supports loopback HTTP for local instances;
other remote endpoints require HTTPS. Copy token values separately from URLs.
URLs containing credentials, query parameters or fragments are refused.

Official setup references, checked 24 September 2026:

- [Zapier generic MCP clients](https://docs.zapier.com/mcp/get-started/connect/other)
- [Make OAuth](https://developers.make.com/mcp-server/connect-using-oauth)
- [n8n instance MCP](https://docs.n8n.io/connect/connect-to-n8n-mcp-server)
- [Arcade gateways and client setup](https://docs.arcade.dev/en/get-started/quickstarts/call-tool-client)
- [Arcade gateway URL format](https://docs.arcade.dev/en/operate/governance/mcp-gateways)

## Implementation

`dgc/connector_catalog.json` shares provider setup text and endpoint/auth policy
between Python and the extension bundle. `dgc/connectors.py` validates endpoint,
bridge command, authentication mode and ownership before using `Config.set` and
the existing plugin registry. It adds no Python dependency or second config.

The editor uses the existing MCP connection command and `mcp-remote@0.8.3`
bridge. Node.js and `npx` must be available on the machine running DGC, as
for existing remote MCP servers. It does not impersonate Codex/Claude. The bridge identifies its OAuth
client as DGC. Actual authorize URLs use the existing editor `openExternal`
path, callback forwarding for Remote SSH, cancellation, and connection events.
No synthetic sign-in page, token, app status or tool result is generated.

Pasted tokens stay in editor SecretStorage and are bound to the exact URL.
Only environment variable names and secret-free bridge arguments are persisted
in public configuration. Tokens are injected into the worker at runtime, with
redaction registered before connection. Token connections are deferred during
backend startup until the editor restores the secret. OAuth tokens are managed
by the bridge's local auth store, not editor SecretStorage.

Provider terms require a native host confirmation. A webview cannot supply its
own acceptance flag. A failed editor credential write compensates the newly
saved MCP connection and connector ownership. Uninstall clears the owned,
unchanged MCP record, live routes and editor-managed credentials. As with other
plugins, manually modified or shared server definitions are retained.
Disconnecting does **not** revoke provider-side grants or delete the bridge's
OAuth cache. Revoke access in the provider dashboard when that is the intent.

New presets are registered as connector-owned plugins. Their connections stay
on their detail pages and under Apps. The manual MCP tab continues to list only
independently configured servers. Installed packages still support uninstall;
skill-only packages still install without browser sign-in.

Models receive tools through the existing discovery and invocation path. Native
tool calling and DGC's text fallback are exercised by the offline model-runtime
fixtures. Normal DGC permission checks remain in effect. This does not guarantee
that every local model will select tools correctly. Services perform app/workflow
requests outside the local model process, according to the account's setup.

## Migration fixes and compatibility

The published release's new work remains in place (including its default
thinking behavior, SDK and protocol). The General page includes the release’s
`standard` tool profile; an unrelated Save cannot silently change it back to
`adaptive`. Legacy branch-only Remote code was not
reintroduced. A finite-number check was retained in the thinking-budget adapter
because the merged suite exposed infinity/overflow errors there. The SDK parity
check also exposed a release inconsistency: TypeScript denied `ShowFile` under
forbidden path prefixes, but Python did not. Python now includes the same denial;
no permission rule was relaxed.

Plugin commands now require `ready.capabilities.plugin_management`; connector
setup requires `app_connectors`. An official CLI with the same version number
therefore receives no unknown plugin commands. Settings tells the user to select
the local build. Saved connector secrets are not replayed during startup to a CLI that lacks
connector support. An already open settings page refreshes after the backend
handshake. The compatibility test now compares individual command objects via
TypeScript parsing: new event fields no longer falsely mark every old command's
`request_id`/`items` incompatible. Runtime tests prove the new sender's gate.

Website source and generated pages were excluded from the migration. The local
QA server was restored after the release removed it; its SDK redirect and the
docs generator’s topic list were aligned with 0.44.0 solely to run the existing
local test harness. Neither `site-src/` nor generated pages were changed. The three pre-existing modified
website files match their backups byte for byte. No actual user config file was
written directly. All test mutations use temporary homes or the isolated real
extension QA profile.

## Limits and verification

This implementation supports one connection per provider. n8n uses instance MCP,
not the workflow-specific MCP Server Trigger node. Arcade supports Cloud gateways
with Arcade Auth; custom domains, self-hosted Arcade, API-key-plus-user-ID mode
and DGC-operated multi-tenant gateways are outside this change.

The UI does not attempt to reproduce each provider's app catalog. Apps, scopes,
credentials and workflow exposure are managed by the provider. Arcade may ask
for a separate app authorization when a tool is first used. The user completes
that authorization; DGC must not invent an individual app's connected status.

Deterministic new tests use unittest/Node's test runner, fake transports and
private filesystem fixtures, with no sleeps or network. They cover URL/credential
injection, auth modes, ownership, consent, compensation, uninstall, protocol,
secret replay, UI errors and cancellation. The full release suites additionally
exercise the pre-existing plugin/model/MCP paths.

A real VS Code extension host (not a mock page) is used for visual checks, with
CDP because this host's existing file-watcher exhaustion prevents the Playwright
CLI wrapper from starting. No host watcher limits were changed. Screenshots and
logs are under `output/playwright/connectors-044-*` and
`output/migration-044/`.

**Account sign-in and successful live tool calls for the four new providers have
not been verified.** No user token, n8n instance or Arcade gateway was supplied;
no authenticated account actions were taken. Those are the remaining acceptance
checks in the user's own accounts, not results inferred from mocked tests.

### Completed checks in this build

- Full extension suite: **785/785 passed** (`full-editor-final.log`).
- Final host/CLI-compatibility suite after the last startup guard: **83/83 passed**
  (`compat-final.log`). Earlier combined settings/host/URL checks: **115/115**.
- Focused Python connector/model/compatibility suite: **24 passed**
  (`connectors-python-final.log`). New connector tests are in
  `tests/test_app_connectors.py`; frontend/host cases accompany the existing suites.
- Full TypeScript SDK runtime suite: **61/61 passed**
  (`sdk-typescript-tests-final.log`). Focused Python SDK policy suite: **10/10
  passed** (`sdk-policy-final.log`), including the `ShowFile` parity correction.
- Production TypeScript build and local VSIX packaging passed; `pip check` and
  generated-protocol consistency passed. npm dependencies match the release lockfile.
- The actual installed CLI, from outside the checkout with a private HOME and no
  PYTHONPATH override, reported 0.44.0, both new capabilities, 17 offered entries,
  and answered both plugin catalog commands before exiting cleanly.
- Both editor registries select 0.29.0, pinned as local VSIX installs. Installed
  `dist`, `media/main.js`, `media/main.css` and manifest match this build byte for
  byte; build flavor is `selfhost`. The VSIX is
  `output/migration-044/dgc-local-connectors-0.29.0.vsix`.
- Real extension: all five named connectors and loaded vendor marks; branded
  dialogs; n8n's two auth choices; General behavior settings; rich usage empty
  state with local-time range; gear opens only the editor settings tab. At a
  402px editor width, document scroll width is 402px and dialog width/scroll width
  are both 368px. No connector was reported authenticated by these checks.

### Python suite and remaining release gate

The full runner exercised 1884 unittest cases (15 optional skips). It first
reported four SDK protocol parity assertions and one missing local website QA
helper. Both migration issues are repaired: Python SDK protocol is now an exact
copy of the CLI's, TypeScript retains the new events, and the local harness
recognizes the SDK route and new docs topics. The targeted SDK/site repair suite
passes **11/11**, and the TypeScript SDK builds. This does not cover the complete
sitemap gate: three assertions still fail against the untouched local website
outputs (53 generated URLs versus 51 routes, output parity and tampering
precondition). A read-only rerun confirms these in `site-handoff-audit.log`.
An earlier version of these notes incorrectly described that gate as passing.
Website files are outside this change and have not been regenerated.
The remainder of the original runner is exercised separately in
`python-remaining.log`, because its first run stopped at the stale local docs
helper after completing the unit phase.

The complete suite is **not green**: the synchronized SDK sources no longer
match the previously signed release manifest. The two manifest checks fail
(`sdk-sync.log`). The checkout has no `sdk/.signing/sdk.key`; the existing
public key and signed manifest have deliberately not been replaced. The release
agent must run `python3 sdk/scripts/make_sbom.py` using the matching maintainer
key, then `--verify`, and re-run the full suite before publishing any release.
This does not stop the installed local extension or CLI from running.

The published SDK page and GitHub were checked at the user's request. Both the
`v0.44.0` and `main` public `sdk/sbom/SHA256SUMS` files are byte-identical to this
checkout's existing signed manifest. Neither covers the modified Python protocol
copy, TypeScript transport or Python policy. Downloading those public artifacts
cannot sign new source bytes; the private maintainer key is required. Public
comparison evidence is in `public-manifest-check.json`. No signing key was
downloaded or replaced, and signing is left to the release maintainer.

The previously unexecuted tail of the Python runner now passes **796/796** checks,
including its mock-server native tool, text fallback and Ollama end-to-end cases.
After preserving the new Standard tool profile in the editor, the final combined
settings/host/connector/CLI-compatibility suite passes **117/117**
(`final-focused.log`). SDK release-manifest signing and the separate local
website-fixture mismatch remain; this is not a complete all-green runner result.
