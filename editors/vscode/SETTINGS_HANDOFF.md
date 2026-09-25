# DGC settings, plugins, apps and MCP audit

> Historical implementation record. The current 0.44.0/0.29.0 migration,
> 17 offered plugins, five connectors and validation status are documented in
> [the authoritative migration handoff](../../docs/SETTINGS_PLUGINS_MIGRATION_HANDOFF.md).
> Installation paths and test totals below describe earlier builds.

**Current workflow, 23 September:** In **Plugins → Apps**, connect your own
Composio account, then choose **Manage apps in Composio**. Authorize and manage
Figma, Gmail and other apps in **Composio For You → Connect Apps**, then return
to DGC to use its exposed tools. Individual app shortcuts have been removed:
their assumed setup-tool schemas did not match the user's live server. DGC shows
connector status only. No shared API key, SDK or new runtime dependency is added.
See [implementation and verification](../../docs/COMPOSIO_CONNECTOR.md).

**Connection ownership:** MCP servers lists only user-added URL/credential and
local-command servers. Connections installed by a plugin are managed on its
detail page, with the existing toggle/configure/reconnect paths. This is a UI
change; no existing accounts or server definitions are migrated or deleted.

**Compatibility:** thirteen entries are offered; eleven are withdrawn with
backend enforcement. Previously installed withdrawn packages have a collapsed
review/removal section. Neither directory offers them, including the old chat
surface. The direct Figma/Google packages remain blocked. The user reports Figma
connected in Composio; authenticated DGC tool execution remains unverified.
[Per-plugin audit](../../docs/PLUGIN_COMPATIBILITY_AUDIT.md).

The remaining sections record prior implementation and verification. The current
availability policy supersedes the earlier Google/Figma installation screenshots.

This is the real extension, not a preview. Work is in `/home/fungigb10/dgc`; no site work or publishing is part of this handoff. The user's `~/.dgc/config.json` remains unchanged. Writes exercised during QA use the real backend and existing save path with an isolated configuration under `output/playwright/dgc-test-home`.

## What is implemented

- The chat gear reveals only the **DGC Settings** editor tab. Catalog events do not open an additional chat surface.
- Smaller settings typography measured in the actual installed Codex extension: 12px navigation, body and controls; 24px/28.8px regular page titles; 14px directory titles. DGC plugin list names use 13px and descriptions 12px. Settings retain the rich usage ledger, all saved fields, shared edit draft and existing Save path.
- Plugins opens the installed list. **Browse directory** opens a searchable catalog inside settings, with marketplace filtering and package details. Install first fetches and reviews supported contents, license, exact source revision, commands and requirements. **Install selected plugin** commits that selection. An unreviewed webview message cannot install a new package. Local stdio commands also require native editor confirmation.
- **Uninstall** is distinct from a skill switch. It removes owned package/skill files and unchanged owned MCP configuration, disconnects runtime servers, drops their DGC secrets and editor-managed records, and preserves user-edited or shared servers. Removed first-party defaults stay removed. Vendor-side grants and mcp-remote's vendor authorization cache are not account revocation; the native confirmation explains that vendor permissions must be managed separately.
- **Create plugin** creates an original local manifest and starter skill in `~/.dgc/plugins/authored/`. It neither installs nor executes the package. Edit its skill, then install from Personal. A review snapshots mutable authored content before presenting it, so later edits cannot introduce unreviewed commands.
- **Add marketplace** registers a local or public GitHub Codex/Claude marketplace, fetches an immutable snapshot, and adds its entries to the directory. Refresh affects discovery; installed packages keep their reviewed versions. Removing a marketplace does not uninstall its packages.
- **Add MCP server** opens the existing MCP editor, using the existing DGC config and credential storage. There is no second MCP config file.
- **Install from link** accepts a public GitHub repository or plugin subtree. DGC resolves the revision; the user does not type a commit SHA.
- Multi-server remote and stdio packages are supported. Selection limits installation to chosen servers. Namespaced MCP identities avoid collisions; an existing unrelated server is never overwritten. Connect uses the existing installed package and selected server definitions, not a newly fetched source.
- Skill switches use `set_skill_enabled`, including during a running turn. That turn retains the skills it loaded; the next turn sees the saved selection. Permission rules still apply to every tool call.

## Google picker

The picker follows the supplied Codex composition with **DGC's own mark**: DGC-to-Google graphic, real Google/Gmail/Calendar/Contacts/Drive image assets, one accessible switch per service, and a single primary action. Images are bundled; the webview does not request them from Google. Provenance is in `media/plugin-logos/SOURCES.md`.

The picker says **Setup required**. DGC has no registered Google OAuth client or Workspace MCP preview access. Installation stores the chosen published endpoint definitions with `defer_until_setup`; it does not launch servers, offer a fake sign-in, or grant account access. Selected services are also the only ones listed under Apps. Google Cloud project/APIs, preview access and OAuth client setup are still prerequisites. This is a setup UI and server preset, not a completed Google account integration.

## What parity does not mean

| Capability | DGC status |
| --- | --- |
| Install/remove supported skills and MCP bundles | Implemented, tested with actual files and subprocesses |
| Additional Codex/Claude marketplace discovery | Implemented for local folders and public GitHub sources, including external GitHub and git-subdir entries |
| Browser OAuth | Real authorize URL passed to `vscode.env.openExternal`; callback worker stays alive until completion/cancel |
| Hosted ChatGPT Apps / app account sessions | Not portable. An `.app.json` declaration is metadata, not permission or a session |
| Gmail, Calendar, Contacts, Drive | Selectable setup presets; registration/access prerequisites are not satisfied |
| Figma OAuth | DGC identity retained. Figma's refusal is shown, not an invented sign-in page or Connected state |
| Local model tools | Actual MCP schemas/results reach native and text-tool model paths; permissions remain enforced |
| Host-specific hooks, commands, agents, LSP/outputStyles | Reported as unsupported, not silently executed or claimed to work |
| Automatic plugin upgrades, private Git/SSH sources, arbitrary registries | Not implemented; public GitHub and local sources are the supported import boundary |

Codex's larger directory includes a hosted app catalog and account/consent infrastructure. Claude also discovers packages from additional marketplaces. DGC's initial curated list is a starting source, not a protocol limit. Adding the public Claude marketplace in QA exposed 310 additional listings at its tested revision. This is a discovery count, **not** a claim that all entries work: license, source format, supported contents and service authentication still determine compatibility.

Apps now say Connected, Not connected, Setup required or Unavailable in DGC. “Declared app” meant only that a package mentioned a service in its metadata. It never meant that DGC had access to that service. The new UI states that distinction directly.

## Source handling and trust

No new Python runtime dependency. GitHub sources use bounded stdlib HTTP/archive readers, full commit pins, and contained cache paths rather than machine-specific audit-clone paths. Limits: 32 MiB compressed, 64 MiB expanded/copied, 8 MiB per file, 4,000 selected entries; bounded archive scanning. Traversal, archive links, symbolic links in packages, inline MCP credentials, unsupported variable interpolation and ownership collisions are refused. Local/source snapshots are copied before install; package/skill replacement rolls back on a state-write failure.

MIT/Apache-2.0 imports are supported for additional marketplaces and direct links; unknown/proprietary licenses require explicit review outside this importer. Curated publisher-specific terms retain native acceptance. OpenAI proprietary skill bodies are not copied. DGC's own Apache-2.0 templates and Plugin Management remain its first-party text.

These checks do not sandbox code a user explicitly approves. Installing a stdio server is approval to run that command under DGC's existing tool/host controls. Package prompts written specifically for another host may require adaptation even when their SKILL.md can be read.

## Verification and its limits

The installed Codex extension was opened in real VS Code and its UI/assets inspected read-only. DGC was exercised in a real extension development host, including an isolated real-backend profile. No mock website substitutes for the extension visual check.

Observed in real DGC windows:

- Gear opens only editor settings; Behavior/Save, rich usage ledger and existing field groups remain available.
- Installed list, directory search/filter, Add menu, create/review/install/remove local package and native uninstall confirmation.
- Adding the real public Claude marketplace; reviewing its external Superpowers package at its pinned revision, with actual SKILL.md descriptions and a warning that hooks are not imported.
- Google picker loads all six brand images, exposes four switches and setup requirements. Normal and narrow editor panes have no horizontal overflow.
- Earlier OAuth check: Dropbox raised the native **Do you want Code to open the external website?** dialog. Figma's real connection was refused and explained. Vendor account login was not completed. The pinned mcp-remote bridge's callback/token refresh/cancel behavior passed against a local OAuth/PKCE fixture.

The actual local Ollama `qwen2.5:14b` model called a real MCP fixture subprocess and returned its exact result in **both native tool and text fallback modes**. This is observed evidence for that model/configuration, not a guarantee that every local model follows tool instructions. Separate deterministic tests verify schema serialization, the tool result's next-request placement, deny-rule enforcement and tool removal after uninstall without a model service or network.

Validation logs and screenshots are under `output/playwright/` (ignored artifacts). `google-picker-final.png` and `google-picker-narrow.png` show the picker. `plugins-*.png`, `final-9336-*.png`, `dgc-usage-live.png`, `native-dialog.png` and `native-terms.png` cover the other screens and native prompts.

The entire `dist/` and `media/main.js` are copied after every build into both installed `vibedgc.dgc-0.26.3` directories for Cursor server and VS Code. Reload Cursor to load the new build.

## References

- https://developers.openai.com/plugins/concepts/plugins
- https://developers.openai.com/plugins/build/plugins
- https://code.claude.com/docs/en/discover-plugins
- https://developers.google.com/workspace/guides/configure-mcp-servers

## Validation results

- Full extension suite: **585 tests; 422 passed, 163 skipped, zero failures**.
- Focused settings renderer/host regressions: **89 passed**, including selective install, native command approval, source-link identity, secret cleanup and the Google picker.
- Deterministic Python plugin/lifecycle/model/metadata regressions against the final code: **39 passed**. This final focused run includes the late review-expiry and reconnect-without-refetch checks.
- Broad Python runner: its nested unittest phase passed **1,144 tests, 4 optional bridge skips**. The overall required runner finished **1,799/1,799 checks passed**. This broad run began before the last two focused backend tests were added; the final focused run covers those changes.
- Real bridge optional suite previously enabled explicitly: **4 passed**, including callback/token refresh and cancellation. No later change was made to the MCP bridge implementation.
- Real `qwen2.5:14b` smoke: native and text fallback each called the MCP fixture and returned its exact value.
- Built the Python wheel without network or new dependencies. Verified its catalog, three plugin modules and five bundled skills, then imported the unpacked wheel independently and installed both first-party packages successfully. `pyproject.toml` now includes the plugin runtime data; it was previously missing.
- The eight generated/runtime files match both installed extension directories byte for byte. User config checksum: unchanged. `git diff --check`: clean.

The Google UI was exercised with the keyboard to select only Gmail and Drive. The resulting installed record contained only those two deferred servers, the Apps page showed only those two services, and uninstall removed both definitions. The externally sourced Superpowers package was also installed through the actual directory, exposed 15 skill switches, and was uninstalled again in the isolated profile.

## Local backend repair, 2026-09-23

After restoring the extension, Cursor reported unknown `list_plugins` and `list_plugin_marketplaces` messages. The `~/.local/bin/dgc` symlink resolved to this checkout, but `.venv/bin/dgc` had a shebang pointing into `/tmp/claude-1000/deploy-0415`, and the virtualenv's editable finder imported that temporary checkout (DGC 0.43.4 without this plugin branch). Testing imports from the repository root had masked the mismatch.

Repaired the local virtualenv using an editable wheel built from this checkout with existing system setuptools, then installed with `--no-index --no-deps`. The launcher now uses `/home/fungigb10/dgc/.venv/bin/python` and imports `/home/fungigb10/dgc/dgc` (0.41.3). No runtime dependencies or user config were changed. Prior installation metadata and launcher are backed up under `output/playwright/backend-restore/`.

Verified from **outside the checkout**, without a PYTHONPATH override: the actual `~/.local/bin/dgc serve` launcher emitted protocol 14 ready, a 23-entry plugin catalog and a valid marketplace response, with no errors and a clean exit. The wire probe used a fresh private HOME so it did not change the user's account/configuration. An already running Cursor backend must be restarted to load the repaired installation. Future installation checks must verify the imported module location from outside the repository, not just resolve the launcher symlink or compare version numbers.

## Startup compatibility and Figma connection review, 2026-09-23

The initial launcher repair was verified with a blank private HOME. That did **not** test the user's migrated settings. The real Cursor traceback subsequently identified `int("auto")` in `Agent._new_client`: the newer installed release had saved `think_budget_tokens: "auto"`. The local plugin branch now accepts that value without rewriting the user's config. Its reasoning watchdog resolves a budget for each request level (8k off/low, 16k medium, 32k high, 64k extra high/max); explicit numeric overrides and zero remain supported. Invalid/nonfinite values fall back to the finite automatic schedule. A regression launches the backend with this setting and exercises both plugin commands and status, without network or sleeps. A separate actual-launcher probe used an unmodified private copy of the user's complete config, answered nine sequential requests, and shut down cleanly. The real extension also displayed settings and the catalog with that copied config.

Figma now uses the same DGC-to-service connection graphic as Google, using the bundled DGC mark and real Figma PNG. It appears during package review and when reconnecting an installed plugin, and remains visible through progress, browser handoff, failure, and connection completion. Long skill descriptions are expandable; server selection and the actual package information remain available. The browser action appears only after a real sign-in event. Reconnecting uses the installed selection, without refetching the package. Cancel uses the existing OAuth cancellation path.

The dialog explains the Figma approval requirement before installation and links to Figma's remote/desktop instructions. Figma's current developer documentation says remote clients must be in its approved catalog and provides a client waitlist. Running DGC inside Cursor does not transfer Cursor's OAuth registration to the DGC backend. No Codex/Claude client identity, session or token is reused. A live attempt with the current pinned bridge failed in OAuth registration before returning an authorize URL; the bridge's own diagnostic was `Invalid OAuth error response ... [object Response]`, so we do **not** present a timeout or process exit as proof of a specific HTTP approval response. Backend initialization errors now retain bounded, credential-redacted bridge diagnostics after the readers finish. The old unconditional Figma-specific rewrite of any timeout/exit has been removed.

Remote Figma sign-in is still an external integration prerequisite, not a completed account connection. DGC must obtain its own Figma client approval. The documented desktop server is an alternative connection type; in Remote SSH it must be reachable from the machine running DGC. This change does not silently replace the installed remote endpoint or claim that a desktop connection was tested.

References checked:
- https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/
- https://developers.figma.com/docs/figma-mcp-server/local-server-installation/
- Client waitlist linked by Figma: https://form.asana.com/?d=10497086658021&k=kBG-ejRQTdY8x_H6a4vM3Q

Focused verification: 92 settings renderer/host tests, 42 backend startup/plugin/OAuth tests, and 20 final renderer tests passed. TypeScript and extension build passed. Real-extension screenshots and a private live bridge diagnostic are under `output/playwright/figma-connection-review/`. Updated `dist/` and `media/main.js` were copied to both installed 0.26.3 extension directories. No website changes or publishing were performed.

Visual check: both bundled marks loaded in the actual VS Code extension; the 432px-wide settings pane kept the 398px dialog within its viewport, with no body overflow and the install/cancel footer visible. Screenshots: `figma-install-final.png` and `figma-install-narrow.png`. The live user config was not edited by this work; the user’s own plugin installation changed it between the earlier startup probe and this review.

Final required Python runner: **1,799/1,799 checks passed**, including **1,154 unittest cases (4 optional skips)**, after the startup and MCP error-handling changes. Log: `output/playwright/figma-backend-full-suite.log`. The final renderer tests also passed after distinguishing Hide during connection setup from Cancel during an active browser sign-in. Both installed runtime copies match the final build byte for byte.


## Composio management and connection ownership correction, 24 September

The individual Composio app setup controls were removed after live use exposed a
schema mismatch. **Manage apps in Composio** is now the supported authorization
and account-management path. The MCP tab lists manual connections only; plugin
connections and their existing controls live on their plugin detail pages.
Unavailable packages are removed from offers, with old installs accessible only
for review/removal. No existing user accounts were revoked or uninstalled.

The required Python runner passed **1,799/1,799 checks**. Focused extension
regressions passed **104/104**; the full extension suite passed **436**, with
**163 skipped** and zero failures. TypeScript/build and protocol checks passed.
Real-extension visual checks and the restored actual backend launcher passed;
both installed 0.26.3 runtime copies match the final build. Details and limitations
are recorded in [COMPOSIO_CONNECTOR.md](../../docs/COMPOSIO_CONNECTOR.md).
