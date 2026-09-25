# DGC settings, plugins and app connectors — migration handoff

Prepared 24 September 2026. This is the authoritative handoff for the complete
local implementation, including the earlier settings/plugin work and the latest
connector work. Earlier handoff/audit files remain useful history, but their
0.26.3 installation paths, catalog counts and earlier test totals are obsolete.

## Start here

Migrate this implementation into the main agent's current DGC development branch.
Preserve newer mainline work; do not replace the main checkout with this source
snapshot. Keep the current settings save path, permissions and user data. Do not
publish, deploy, edit website source or rewrite user config as part of applying
this handoff.

- Source checkout: `/home/fungigb10/dgc`.
- Source branch: `codex/connectors-044`.
- Exact base: official CLI `v0.44.0`, commit
  `29d9a9746965aeb8fe39fb9f02876b193e59cc1c`.
- Extension base: `0.29.0`; editor protocol remains `14` with capability gates.
- **The implementation is uncommitted, including important untracked files.**
  Cherry-picking the branch tip alone gets the release base, not these features.
- Transfer directory:
  `/home/fungigb10/dgc/output/handoff/settings-plugins-044/`.
- `changes.patch`: complete source delta against that exact base, including new
  files, bundled skills and binary vendor logos. No real Git index was staged.
- `source-files.tar.gz`: only the changed/new repository files, with repository
  relative paths. A review/reference snapshot, not a complete checkout.
- `manifest.json`: every changed file, status, mode, size and SHA-256, plus the
  exact base and local versions. `SHA256SUMS` checks transfer artifacts; it is
  **not a maintainer release signature**.
- `HANDOFF.md`: portable copy of this document. `evidence/`: selected test logs,
  launcher/runtime verification and real-extension screenshots. The local VSIX
  is included for reproduction, not publication.

The existing old branch and migration backups were retained. Local merge
history/evidence lives in `output/migration-044/`. Neither those backups nor any
user configuration, plugin registry, credentials, OAuth cache, private key or
QA home is part of the transfer.

## Product behavior to preserve

### Separate editor settings

The chat gear opens exactly one **DGC Settings** editor tab. Catalog responses
must never open a second Plugins surface in chat. Settings use the real
extension/backend, not a preview webpage.

The shell follows the measured compact editor settings density: 12px nav/body
and controls, 24px page titles, 13px plugin names and 12px summaries. Colors
follow the editor theme. Plugin lists have separators and row navigation;
installed skills use switches, uninstalled packages use Install.

General, Models, Agents and Security retain the existing fields and one Save
action through `panel.ts`'s existing settings writer. A shared edit draft
survives settings navigation/refresh. Preserve the release's **Standard** tool
profile; an unrelated Save must not silently reset it to Adaptive. Existing
model/subscription transports, secrets, fallback/sub-agent configuration,
thinking and sandbox/plan controls remain available.

Token usage uses the rich former chat renderer: headline figures, model table
with share bars, interactive day strips, local-time range, Refresh and empty
state. Do not replace it with a simplified table.

### Plugins and directory

- Installed list, searchable **Browse directory**, marketplace filter, detail
  page and package review before **Install selected plugin**.
- Detail: actual package metadata, bundled/vendor logo, long description, app
  declarations, skills with SKILL.md frontmatter descriptions, per-skill
  switches, developer/category/license/terms/privacy/source/MCP information.
- Add menu: **Create plugin**, **Add marketplace**, **Add MCP server**.
- Create plugin writes original starter content in the personal authored area;
  it does not install or execute it. Review/install from Personal afterwards.
- Public GitHub repository/subtree links and supported local/public marketplaces.
  DGC resolves immutable revisions; users do not supply commit hashes.
- Review snapshots mutable sources, shows commands/requirements/selection,
  requires native consent for publisher terms and local stdio commands, and
  rejects stale/unreviewed installation. Multi-server packages support selection.
- **Uninstall** is separate from disabling skills. Remove owned files, routes,
  unchanged owned MCP definitions and editor-managed credentials. Preserve
  shared/user-edited definitions. Uninstalled first-party defaults stay removed.
- Skill switches work during a turn. That turn keeps its loaded skills; later
  prompts use the saved selection. `set_skill_enabled` is deliberately absent
  from `_BUSY_MUTATIONS`.

DGC imports supported skill/MCP contents, not another host's entire runtime.
`.app.json` is metadata, not a ChatGPT app session or proof of account access.
Unsupported hooks, commands, agents, LSP and output styles are disclosed, not
silently executed. No proprietary OpenAI skill bodies were imported. DGC's own
Apache-2.0 templates and Plugin Management text remain in `dgc/bundled_plugins/`.

### Apps versus manual MCP servers

Apps is the connector entry point. Plugin-owned server controls stay in Apps
and plugin details. **MCP servers lists manual connections only**, including
user-added URL/token and local-command servers. Ownership comes from installed
server identities, never from a vendor-name heuristic. A manual Notion server
must remain visible even though a Notion package exists.

Existing users' servers/accounts are not moved, revoked or deleted by changing
these lists. Disabling/uninstalling DGC access does not revoke provider grants
or erase the remote bridge's OAuth cache; the UI explains provider-side removal.

### Five account/workflow connectors

| Connector | Supported setup in DGC | App/tool selection |
| --- | --- | --- |
| Composio | Existing account OAuth at `https://connect.composio.dev/mcp` | Composio For You → Connect Apps |
| Zapier | Other-client connection token at `https://mcp.zapier.com/api/v1/connect` | Zapier MCP dashboard |
| Make | Browser OAuth at `https://mcp.make.com/` | Make organization/scopes and scenarios |
| n8n | Instance URL ending `/mcp-server/http`; OAuth or personal access token | Explicitly exposed workflows on that instance |
| Arcade | Cloud gateway `https://api.arcade.dev/mcp/<slug>`, using Arcade Auth OAuth | Gateway tools and provider authorizations in Arcade |

All five show their names and real bundled vendor marks. The new providers have
DGC-to-provider setup dialogs, endpoint/auth inputs where needed, consent,
retryable errors, management links and real MCP connection status. No sign-in
page or Connected status is simulated. `openExternal` is triggered by an actual
authorize URL; existing callback forwarding, worker lifetime and cancellation
are reused, including Remote SSH behavior.

**Do not restore per-app Connect/Check buttons for Composio.** The actual user's
server did not implement the previously assumed setup-tool schema. Manage apps
in Composio is the supported workflow. The legacy `composio_connection` command
remains correlated but returns an explanatory error; `composio_connections` is
false. Connector status is not an invented per-Gmail/Figma inventory.

This is a user-owned-account MCP integration. It is not a DGC-operated shared
connector service or an embedded commercial reseller platform. Terms/privacy
links and endpoint rules live in `dgc/connector_catalog.json`; dated official
references and remaining commercial questions are in the supporting documents.

## Catalog policy

Current catalog has **28 internal policy entries: 17 offered, 11 blocked**.

Offered: Default templates, Plugin Management, Composio, Frontend Design,
Superpowers, Build Web Apps, Notion, Linear, Sentry, Supabase, Atlassian Rovo,
GitHub, Stripe, Zapier, Make, n8n and Arcade.

Withdrawn: Feature Dev, Code Review, Commit Commands, Code Simplifier, PR Review
Toolkit, Figma, Context7, Vercel, Canva, Dropbox and Google Workspace. Reasons
include unsupported package components, parsing restrictions and service/client
approval requirements; see `docs/PLUGIN_COMPATIBILITY_AUDIT.md` for the dated
per-package evidence. A received authorize URL was not treated as proof of
supported authenticated use.

Blocked packages are absent from normal offers in both settings and the old
chat renderer. Backend install/reconnect and matching pasted-link paths also
enforce withdrawal. Old installs remain in a collapsed review/removal section.
Do not re-enable direct Figma/Google or restore the old offered Google picker
just because their assets/legacy compatibility code remain. No Codex/Claude
OAuth identity or account session is borrowed. A manual Figma desktop guide
remains distinct from remote canvas capabilities and has Remote SSH caveats.

## Code map and merge order

| Area | Source files and responsibility |
| --- | --- |
| Package implementation | `dgc/plugins.py`: metadata, preview/install/connect/uninstall, license/availability policy, ownership, first-party bootstrap, CLI actions |
| Source imports | `dgc/plugin_sources.py`: bounded local/GitHub snapshots and archives; `dgc/plugin_registry.py`: marketplaces, immutable discovery and personal authoring |
| Catalog/data | `dgc/plugin_catalog.json`, `dgc/connector_catalog.json`, `dgc/bundled_plugins/`; `pyproject.toml` packages these into the wheel |
| New connectors | `dgc/connectors.py`: `validate(name, spec)`, `save(config, name, spec, accept_license='')`, `forget(config, name)`; uses existing Config/MCP/plugin stores |
| Agent/CLI | `dgc/skills.py` discovers plugin skills; `dgc/agent.py` reports installed/disconnected packages and routes live MCP tools; `dgc/cli.py` adds `dgc plugin` |
| Backend | `dgc/headless.py`: correlated package operations, review lifecycle, capabilities, connector ownership/config, runtime credentials and errors |
| MCP | `dgc/mcp.py`: DGC client metadata, bounded/redacted bridge diagnostics, editor-controlled browser opening; pin remains `mcp-remote@0.8.3` |
| Wire contract | `dgc/editor_protocol.py` is authoritative; regenerate both JSON schemas and `editors/vscode/src/protocol.generated.ts` |
| Settings host | `editors/vscode/src/panel.ts`: editor tab, capability gates, review/native confirmations, secrets, save paths, management and removal |
| Settings UI | `settingsView.ts`, `settingsClient.js`, `settings.css`, `settingsFields.js` under `editors/vscode/src/` |
| Usage | `settingsUsage.js`, `settingsUsageMarkup.js`, `settingsUsage.css` under the same directory |
| Connector UI policy | `appConnectors.ts` consumes shared JSON; `composioConnections.ts` supplies the provider management link |
| Chat compatibility | `editors/vscode/media/main.js` and `main.css`: no double-open, current visibility/branding; these tracked files are required source changes |
| Bundling/assets | `editors/vscode/esbuild.js` emits `dist/settings.js`; image loaders and `media/plugin-logos/` bundle marks; `SOURCES.md` records provenance |
| SDK sync | `sdk/python/dgc_sdk/wire/editor_protocol.py` exact copy, `sdk/typescript/src/transport.ts` recognizes new events; `sdk/python/dgc_sdk/policy.py` adds missing `ShowFile` denial parity |
| Small carried fixes | `dgc/llm.py` finite thinking-budget guard; `tests/test_background_agents.py` event-based child cleanup in place of a sleep loop |

Build on the destination's versions/defaults. Merge these behaviors, not wholesale
old copies of `panel.ts`, `agent.py`, `headless.py` or generated schemas. The
earlier branch-only Remote feature was deliberately not reintroduced.

New wire commands: `list_plugins`, `inspect_plugin`, `install_plugin`,
`uninstall_plugin`, `list_plugin_marketplaces`, `add_plugin_marketplace`,
`remove_plugin_marketplace`, `refresh_plugin_marketplace`, `create_plugin` and
legacy `composio_connection`. Existing `upsert_mcp_server` gains optional
connector identity/license context; it remains the MCP save path.

Events: `plugin_catalog`, `plugin_preview`, `plugin_marketplaces`,
`plugin_operation`, legacy `composio_connection`, plus existing MCP/auth events.
Read exact fields from `dgc/editor_protocol.py`; do not implement a parallel
contract from this prose.

**Compatibility is capability-based, not version-only.** The backend advertises
`plugin_management: true` and `app_connectors: true`. `sendPluginCommand()` must
wait for ready/support. Settings refreshes after handshake. Managed connector
secrets/fields must not be replayed into a released CLI missing these features,
even when it also reports 0.44.0. Preserve the guard that avoids the previous
unknown `list_plugins`/`list_plugin_marketplaces` failures and restart loop.

## Persistence and security invariants

- Settings and public MCP config go through existing `Config.set`/settings Save;
  no second MCP config and no direct rewriting of the user's config file.
- Package state is under the existing DGC user home: `plugins/installed.json`,
  `skills/`, `logos/`, source caches, `marketplaces.json` and `authored/`.
  Never ship/copy these actual user directories as migration input.
- Pasted connector tokens are in editor SecretStorage, bound to the exact URL;
  public config stores environment variable names, not values. Runtime injection
  registers redaction. Token startup is deferred until secrets are restored.
  OAuth credentials remain in the bridge's local auth store, not SecretStorage.
- Python and host validate URLs/auth independently: exact published endpoints
  for Zapier/Make; instance MCP path for n8n; Arcade Cloud gateway only. Refuse
  URL credentials, query/fragment, control characters, alternate executables
  or arguments. HTTPS except loopback HTTP for local n8n. Remote SSH loopback
  means the backend host, not the laptop displaying Cursor.
- Require native publisher/command confirmation. Webview-supplied flags cannot
  grant consent. Refuse manual server-name collisions and other plugin ownership.
  Config/registry writes roll back on failures; failed new secret persistence
  compensates the saved connection and ownership.
- Import bounds: 32 MiB archive, 64 MiB expanded/copied tree, 8 MiB/file,
  4,000 selected files; contained paths, no archive/package links or inline MCP
  credentials; reviewed immutable source. Preserve checks and tests.
- Normal deny → ask → allow remains. Installation adds no permission allow
  rules. Source validation is not a sandbox for an approved stdio executable.
- Local/native models and text-tool fallback use the existing MCP schemas and
  result routing. Outer multiplexing-tool approval can cover its nested remote
  app actions; it is not a per-Gmail-action policy. Provider execution is outside
  DGC's local filesystem sandbox.

No new Python runtime dependency. Existing remote MCP requires Node/npm/npx.
Published Python packaging must include both catalogs and bundled skills.

## Suggested migration procedure

1. Inspect the target branch and preserve its work. Read the manifest and patch.
   Use an isolated integration branch/worktree. Do not reset the source checkout.
2. At the exact base, `git apply --check /path/to/changes.patch` then
   `git apply --index /path/to/changes.patch` imports the full delta. On newer
   main, review with `git apply --3way --index /path/to/changes.patch` and resolve
   conflicts deliberately. Those commands modify/stage the destination only.
   If there are overlapping uncommitted target changes, reconcile them first;
   do not force overwrite. The snapshot is a reference for individual files.
3. Preserve latest mainline behavior and merge the source groups above. Bring
   the backend and extension together; UI-only migration is not functional.
4. Regenerate the protocol from its authoritative Python source. Synchronize
   the SDK wire copy/events and preserve any newer SDK protocol additions.
5. Run focused tests, full suites and package-data checks. Resolve the release
   gates below; do not declare green based on a subset or a process exit alone.
6. Build a local extension and launch the real editor extension host. Verify
   the actual CLI launcher outside the repository; editable installs can point
   at another checkout despite the visible executable/version looking correct.
7. With user-owned provider accounts, perform the remaining live acceptance
   checks. Then follow the main agent's normal reviewed release process;
   this handoff grants no publication instruction.

Commands from the repository root, after the target's development environment
has been installed using its locked dependencies:

```sh
.venv/bin/python scripts/generate-editor-protocol.py
.venv/bin/python scripts/generate-editor-protocol.py --check
.venv/bin/python -m unittest tests.test_plugin_settings tests.test_plugin_lifecycle tests.test_plugin_compatibility tests.test_plugin_model_runtime tests.test_composio tests.test_app_connectors tests.test_think_budget_compat tests.test_mcp_browser_auth
npm --prefix editors/vscode run check-types
npm --prefix editors/vscode test
.venv/bin/python tests/run_tests.py
node --experimental-strip-types --test tests/test_dgc_sdk_ts.mjs
npm --prefix sdk/typescript run build
DGC_SELF_HOSTED=true npm --prefix editors/vscode run package
git diff --check
```

SDK conformance requires a supported Node with type stripping and the correctly
installed local DGC CLI. Use the repository's SDK packaging/parity tests too.
Build/package test data in an isolated HOME; do not reuse the user's accounts.

## Verification evidence and remaining work

| Check | Observed result on this source |
| --- | --- |
| Full extension suite | 785 passed; log `full-editor-final.log` |
| Final focused settings/host/connector/compatibility after last UI fixes | 117 passed; `final-focused.log` |
| Focused Python connector/model/startup | 24 passed; `connectors-python-final.log` |
| TypeScript SDK runtime | 61 passed; `sdk-typescript-tests-final.log` |
| Focused Python SDK policy | 10 passed; `sdk-policy-final.log` |
| Targeted SDK/site-helper repair unit suite | 11 passed; `migration-repairs.log` — not the complete website gate |
| Remaining tail of original Python runner | 796 passed; `python-remaining.log` — separate run, not full-suite success |
| Builds/packaging | TypeScript, local VSIX, protocol generation and pip dependency check passed |
| Actual launcher | Outside checkout/private HOME/no PYTHONPATH: 0.44.0, both capabilities, 17 offers, marketplace response and clean exit |
| Real editor | Gear opens settings only; rich usage, Standard default, named loaded vendor marks, branded dialogs and live MCP-state rendering; 402px viewport without horizontal overflow |
| Installed runtime | Both 0.29.0 directories match source `dist`, `media` and manifest byte for byte |

The first full Python run exercised 1,884 unittest cases with 15 optional skips,
reported SDK-copy/site-helper migration issues, then stopped at stale local docs
topics. The code/SDK-copy/helper issues were corrected and checked individually.
**No complete final all-green Python runner result exists.**

Two remaining validation issues must be reported separately:

1. **SDK release signature:** two manifest tests fail because three SDK source
   files changed. No `sdk/.signing/sdk.key` exists here. The public key and signed
   manifest remain unchanged. Published v0.44.0/main manifests are identical to
   the local old manifest and cannot sign new bytes. The release maintainer must
   use the matching private key to run `python3 sdk/scripts/make_sbom.py`, then
   `--verify`, as the final SDK-source step. Do not mint a replacement trust key,
   copy an unrelated signature or weaken the tests. See `sdk-sync.log` and
   `public-manifest-check.json`.
2. **Out-of-scope local website fixture:** three sitemap assertions still fail:
   generated routes count, committed output parity and tampering precondition
   (53 generated URLs versus 51 existing routes). The earlier APP_CONNECTORS
   claim that sitemap/robots passed was incorrect and has been corrected.
   Read-only rerun confirms it (`site-handoff-audit.log`). This checkout retains
   ignored website helpers/outputs absent from the release tree. Small local
   helper repairs were made earlier to exercise the harness; neither those
   helpers nor any website content are part of this patch. The website owner
   must reconcile their own fixtures or verify the official target's gates.
   Do not delete/skip tests or regenerate website pages as part of this migration.

Account acceptance is also pending: the four new connectors have not completed
live authenticated tool calls. The user reported Figma connected in Composio;
that is not independently verified DGC execution. Earlier OAuth probes reached
real handoffs and cancelled. Earlier real `qwen2.5:14b` native/text tests used an
MCP fixture; current offline tests preserve routing/permission coverage. None
of this establishes all-model or all-provider parity with Codex.

Remaining deliberate limits: one connection/provider; n8n instance MCP only;
Arcade Cloud + Arcade Auth only; no private Git/SSH imports, automatic package
upgrades, hosted ChatGPT Apps, copied proprietary bodies or service-wide client
approval. Commercial redistribution/embedded-service terms need release-owner
review; this implementation is not legal clearance.

Manual acceptance after migration: settings-only gear, draft/Save retention,
usage interactions; review/install/uninstall a local skill package; switch skills
during a turn; marketplace add/search/refresh/remove; manual versus owned MCP
visibility; one live connection and permission-controlled tool call per provider;
browser cancellation/retry; reload restores tokens without logging them; old CLI
handshake does not receive new commands/secrets; existing withdrawn installs
remain removable. Use test accounts and a reversible/read-only provider action.

## Current local testing installation

The user's launcher `~/.local/bin/dgc` resolves to
`/home/fungigb10/dgc/.venv/bin/dgc` with editable metadata 0.44.0. Both editor
registries select locally installed extension 0.29.0 at:

- `/home/fungigb10/.cursor-server/extensions/vibedgc.dgc-0.29.0`
- `/home/fungigb10/.vscode/extensions/vibedgc.dgc-0.29.0`

Current VSIX: `output/migration-044/dgc-local-connectors-0.29.0.vsix` (also in the
transfer). Reload Cursor, then DGC gear → Plugins → Apps. A subsequent official
install can overwrite this development build. Do not blindly copy these
machine-specific paths to another user's environment. When updating this machine,
use its extension installer and verify runtime assets/registries, not a folder
copy alone. Do not downgrade the target's version to these historical numbers.

For visual review, launch real VS Code with `--extensionDevelopmentPath` pointing
at the migrated `editors/vscode`, isolated user-data/extensions directories,
`env -u ELECTRON_RUN_AS_NODE -u VSCODE_IPC_HOOK_CLI xvfb-run -a`, and a free remote
debugging port if needed. Existing watcher exhaustion required CDP here; it was
not solved by raising host limits or replacing the extension with a mock page.

Supporting reading: `docs/APP_CONNECTORS.md`, `docs/COMPOSIO_CONNECTOR.md`,
`docs/PLUGIN_COMPATIBILITY_AUDIT.md`, `docs/APP_CONNECTOR_CANDIDATES.md`,
`editors/vscode/SETTINGS_HANDOFF.md` and vendor mark provenance. Prefer this
document and the actual current catalog/protocol when historical notes disagree.
