# Composio account connector — 23 September 2026

> The account-management behavior below remains current. For the migrated
> CLI 0.44.0 / extension 0.29.0 installation, five-connector catalog and final
> validation status, use [the migration handoff](SETTINGS_PLUGINS_MIGRATION_HANDOFF.md).
> Build counts and 0.26.3 installation paths below are historical.

## User flow

1. Open **Settings → Plugins → Apps → Connect Composio**. Review the endpoint,
   service terms and cloud-execution notice, then connect your own account using
   the existing browser OAuth flow. No DGC-owned project API key is embedded.
2. Choose **Manage apps in Composio**. In **Composio For You → Connect Apps**, select
   Figma, Gmail, Calendar or another available app and complete its consent there.
   Account selection, permissions and revocation also belong in Composio/provider
   settings. This link is available before and after connecting the DGC account.
3. Return to DGC and ask the model to use the connected app. DGC discovers and
   invokes the tools the Composio server actually exposes, through its existing
   MCP routing and permission checks.

DGC shows the **connector's** connection status, not an invented per-app inventory
or app connection status. Settings no longer offers individual Connect/Check
buttons. The previous implementation assumed specific setup-tool schemas;
fixtures passed, but the user's actual server rejected that assumption. A
provider-owned authorization flow removes that unsupported contract. The user
reported successful Figma authorization in Composio; that is distinct from an
independently verified authenticated Figma tool call through DGC.

An account, any applicable plan, provider eligibility and consent are required.
Some apps may require additional credentials. The existing remote MCP bridge
requires Node.js/npm. Composio's Figma tools do not promise parity with Figma's
own remote canvas-editing tools.

## Implementation and ownership

- The curated `composio` preset uses `https://connect.composio.dev/mcp` through
  existing `plugins.install`, `register_mcp`, `Config.set` and `plugins.connect`.
  No new runtime dependency, SDK, CLI or separate config is introduced.
- The management button opens only the fixed provider dashboard URL through
  `vscode.env.openExternal`. Browser cancellation/failure displays a retryable
  message. Settings does not call provider setup/search tools or retain consent
  URLs for individual apps.
- The legacy `composio_connection` wire command remains accepted for older
  webviews, but returns a correlated error directing users to Connect Apps. The
  `composio_connections` capability is false. Stale host controls cannot start
  setup, cancel a chat turn, or open an arbitrary returned URL. The old Python
  setup adapter has been removed.
- Already-installed Composio presets receive the current explanatory catalog
  text, so stale package metadata cannot advertise the removed shortcuts.
- Plugin-owned MCP connections live on their plugin detail pages. **MCP servers**
  lists only manually added URL/credential or local-command connections. Plugin
  details retain the existing toggle, configure, save and reconnect paths.
  Incoming refreshes preserve edits in the connection form. Server ownership is
  determined from installed package server identities, not vendor names.
- Unsupported direct packages are absent from both install directories, Apps,
  and normal installed lists. Previously installed copies remain in a collapsed
  **Unavailable installed plugins** section for review/removal. They are not
  silently uninstalled; the internal catalog still rejects stale/pasted installs.
- Disabling or uninstalling removes DGC access through the existing controls.
  Uninstall does not revoke upstream consent or erase the bridge OAuth cache;
  manage those grants in Composio/provider settings.

## Models and permissions

Composio is an ordinary MCP server to the agent. Its live tools reach local/native
models and the text-tool fallback through the same routing. Model quality and
schema support still matter; this is not a guarantee for every model or app.
Installing adds no allow rules. Existing deny → ask → allow ordering, modes and
approval handling remain unchanged.

Persistent MCP rules name the **outer tool**. Allowing a multi-execution tool
therefore covers its nested app actions; it is not a per-Gmail-action policy.
Approval cards retain the submitted arguments. Provider scopes and Composio's
controls also apply. Cloud workbench/bash tools, if exposed, execute in Composio,
outside DGC's local filesystem sandbox. Local models do not make these requests
local. Live Enhanced Control interoperability remains unverified.

## Verification and limits

Deterministic tests cover preset review/install/uninstall, legacy command
correlation with no tool or configuration calls, browser opening and failure,
absence of per-app setup controls, withdrawn catalog filtering, old-install
cleanup, manual-only MCP listing and plugin connection controls. Renderer tests
exercise actual settings/chat code, not a mock implementation.

An actual local stdio MCP fixture runs through the Agent and native/text model
adapters, with model HTTP intercepted and network forbidden. Results reach the
model, deny rules and declined approval prevent execution, and uninstall removes
routes. New tests use no sleeps or network calls.

Visual checks use the real VS Code extension and backend in an isolated profile.
The user's existing connections are not changed during QA. Current build results
are recorded below. Earlier external probes reached the actual Composio account
OAuth handoff and then cancelled. The user's successful Figma connection is
reported evidence. Authenticated DGC tool execution, production rate/plan limits,
provider scope completeness and Enhanced Control are not independently verified.

## References and assets

Official [Connect documentation](https://docs.composio.dev/docs/composio-connect)
and [For You navigation](https://docs.composio.dev/kb/guide/dashboard-for-you-navigation)
describe the provider workflow. The fixed management URL is
`https://dashboard.composio.dev/~/org/connect`; select For You → Connect Apps if
provider navigation changes.

Composio's bundled mark is unchanged from
`https://composio.dev/logos/composio-white.svg`, for service identification.
Service terms/privacy remain linked in install review. No endorsement is implied.
The earlier audit's commercial-terms question remains unresolved; this account
connector is not legal clearance for an embedded/resold commercial service.

## Current build verification

- Focused renderer/host/chat tests: **104 passed**, zero skips/failures.
- Complete extension suite: **599 tests; 436 passed, 163 skipped, zero failures**.
  The focused suite additionally covers the final ownership-identity regression.
- Focused Python connector/compatibility/model suite: **13 passed**.
- TypeScript/build, generated protocol check and whitespace checks passed.
- Real extension: Apps contains the dashboard link and no individual app setup
  buttons; directory shows 13 offers and no withdrawn Figma entry. Gear leaves
  chat visible. The 402px editor pane has no horizontal overflow (293px main).
  Screenshots: `output/playwright/composio-managed-apps.png`,
  `composio-managed-narrow.png`, `plugins-available-only.png`,
  `mcp-manual-only.png`. The QA profile has five manually configured servers,
  including old vendor entries: these correctly remain manual. Plugin ownership
  filtering and detail controls are separately covered by renderer tests.
- Read-only inspection of the user's installed registry confirms Linear,
  Notion, Supabase, Figma and Composio have owned server identities. None of
  their servers will appear as manual servers with the new renderer.
- The real visual check caught the local editable install pointing back at
  `/tmp/claude-1000/deploy-0415` (release 0.44.0), producing unknown plugin-command
  errors. The launcher and editable metadata were backed up under
  `output/playwright/backend-restore/`, then restored to this checkout using an
  offline editable wheel with no dependency changes. An actual launcher probe,
  outside the repository with a fresh private HOME and no PYTHONPATH override,
  answered both catalog commands, exposed 13 offers, and exited cleanly.
- Runtime files are copied into both requested 0.26.3 installations. Reload
  Cursor to restart the backend and load the new settings. A future installer
  repointing this local environment at another checkout would undo that match.
- The machine's existing watcher exhaustion blocked the Playwright CLI wrapper.
  Real-window inspection used CDP instead. No host watcher limits were changed.

Required final Python runner: **1,799/1,799 checks passed**. Its unittest phase
ran **1165 tests, with 4 optional skips and no failures**. Log:
`output/composio-managed-full-tests.log`.
