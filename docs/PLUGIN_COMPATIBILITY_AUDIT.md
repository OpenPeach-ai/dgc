# Curated plugin compatibility — 23 September 2026

> Dated audit of the original catalog. The four later connector additions bring
> the current total to 28 policy entries / 17 offers. The eleven withdrawals
> below remain. See [the migration handoff](SETTINGS_PLUGINS_MIGRATION_HANDOFF.md)
> for current installation versions and validation limits.

The internal curated policy list contains 24 entries. Thirteen are offered;
eleven are withdrawn from both install directories and plugin search. Installed
withdrawn copies appear only in a collapsed removal section. There is no
Show unavailable directory control. This is an availability decision,
not an assertion that every remaining plugin is fully authenticated or that its
skills behave identically in another host.

## What was actually checked

- Read the pinned package sources with DGC's real package preview/import checks:
  skills, supported components, MCP declarations, archive bounds and metadata.
- Used DGC's `MCPServer` and pinned `mcp-remote@0.8.3` bridge, with fresh private
  OAuth state and client metadata `DGC` / `https://vibedgc.com`. No Codex/Claude
  identity or account tokens were borrowed.
- Cancelled each browser flow immediately after a real authorisation URL was
  supplied. No account consent, account reads/writes or authenticated tool calls
  were performed. A browser URL proves only that the handoff was reached.
- Context7 completed initialization and exposed two tool schemas without
  credentials. No documentation query was needed for the audit.
- Read official vendor documentation to detect restrictions a successful
  registration response alone cannot establish.

Manual evidence is under `output/playwright/curated-audit/`: `packages.json`,
`auth-results.json`, `dropbox-package.json` and `broker-auth-results.json`.
Persisted reports omit OAuth state, client secrets and full authorisation URLs.
These network probes are manual evidence, not CI tests. Regression tests use
private fixtures and mocks and do not use network or sleeps.

## Every curated entry

| Plugin | Package / connection evidence | Decision and remaining requirements |
| --- | --- | --- |
| Default templates | 4 DGC-owned skills | Offered. No external sign-in. |
| Plugin Management | 1 DGC-owned skill | Offered. No external sign-in. |
| Frontend Design | 1 supported skill | Offered. No external sign-in. |
| Superpowers | 14 supported skills | Offered. No external sign-in; instructions may assume host-specific tools. |
| Build Web Apps | 6 supported skills | Offered. Agent definitions are not imported; scripts are not executed at install. |
| Feature Dev | Commands and agents only | Excluded. No component DGC imports. |
| Code Review | Commands only | Excluded. No component DGC imports. |
| Commit Commands | Commands only | Excluded. No component DGC imports. |
| Code Simplifier | Agent definition only | Excluded. No component DGC imports. |
| PR Review Toolkit | Commands and agents only | Excluded. No component DGC imports. |
| Composio | Optional published MCP endpoint; DGC authorization handoff reached | Offered as App connector. User reports Figma connected in Composio; authenticated DGC execution untested. |
| Figma | 12 skills; remote client approval required | Excluded. DGC approval is not established. Desktop MCP is a separate read-oriented connection. |
| Notion | 4 skills; DGC browser handoff reached | Offered. Workspace consent and authenticated tool use remain untested. |
| Linear | MCP-only; DGC browser handoff reached | Offered. Account consent and authenticated tool use remain untested. |
| Sentry | 1 skill; DGC browser handoff reached | Offered. Organisation access and authenticated tool use remain untested. |
| Context7 | Pinned manifest has unsupported `Authorization: ${CONTEXT7_API_KEY:-}` | Excluded as a package. The documented anonymous endpoint initializes and lists two tools; it can be configured separately as an MCP server. The importer has not been widened to accept arbitrary inline headers. |
| Supabase | 2 skills; DGC browser handoff reached | Offered. Organisation consent and authenticated tool use remain untested; review project scope. |
| Vercel | More than 40 skills; documented approved-client policy | Excluded. Both vendor approval and package size need resolution. |
| Atlassian Rovo | MCP-only; DGC browser handoff reached | Offered. Site consent, administrator redirect restrictions and authenticated tool use remain untested. Tested the pinned package's `/v1/mcp/authv2` endpoint, not a silently substituted endpoint. |
| GitHub | MCP-only; explicit `GITHUB_PAT_TOKEN` reference | Offered with token requirement. No token supplied; no authenticated GitHub tool test. DGC does not promise browser OAuth for this package. |
| Canva | 8 skills; documented registration requirement for hosted design tools | Excluded. DGC integration registration is not configured. Canva's developer-documentation MCP is a different service. |
| Stripe | 7 skills; DGC browser handoff reached | Offered with publisher terms and account consent. Organisation policies may block MCP; authenticated tools remain untested. |
| Dropbox | Corrected pin/path; 7 skills; DGC browser handoff reached | Excluded pending resolution. Official docs restrict DCR to trusted clients, and account authorisation was not tested. Receiving a URL does not establish supported access. |
| Google Workspace | Four deferred service presets | Excluded. No configured Google OAuth client or Workspace MCP preview access. Existing selections remain visible/manageable; they do not grant account access. |

All external curated package revisions are now full immutable commit hashes.
Dropbox previously contained a prose placeholder instead of a SHA and a missing
`plugins/dropbox` path. The reviewed source is now
`dropbox/dropbox-ai-plugins@ec1a5264a88081a6161d984d87705ce65535fbe0`, folder `codex`.
Its MCP endpoint is `https://mcp.dropbox.com/chatgpt_app_mcp`. Correcting the
package does not resolve the separate service approval question.

## Runtime and UI changes

- Search/browse never offers withdrawn entries. The full internal policy list
  retains the reasons so stale installs and pasted links cannot bypass refusal.
- Prepare, install and reconnect refuse blocked entries before fetching or
  changing configuration. A stale install review cannot bypass a later catalog
  withdrawal. Pasted links to the curated folders receive the same checks.
- Supported installed plugins can still be toggled or uninstalled. Withdrawn
  installs have review/removal controls only. Existing user MCP settings are not
  deleted or rewritten by this audit. Independently configured
  MCP servers remain the user's responsibility; this is not a global vendor ban.
- Requirements and the limited verification result appear in plugin details and
  install reviews. Upstream metadata cannot overwrite the curated block reason.
- Fresh standard bridge registrations explicitly identify as DGC. Existing
  cached OAuth registrations are not silently replaced.
- Figma details offer **Set up Figma desktop**, which explains prerequisites
  and prefills the existing MCP form. It saves nothing until **Save and connect**.

## Figma desktop

Official setup: open the desktop app and a design file, enter Dev Mode
(`Shift+D`), then enable its MCP server. Configure a separate `figma-desktop`
HTTP server at `http://127.0.0.1:3845/mcp`, without a bearer token. Desktop MCP
requires a Dev or Full seat on a paid Figma plan.

The documentation has an “Other editors” configuration path. This avoids the
remote OAuth registration step; it does not make desktop equivalent to the
hosted MCP. Figma lists `use_figma`, `create_new_file` and other canvas-write
tools as remote-only. Do not install the entire remote skill bundle and imply
those tools exist on desktop.

With Cursor Remote SSH, DGC runs on the SSH host. Its loopback is not the user's
desktop. Forward the desktop's port over SSH to loopback on the DGC host. For a
desktop-initiated SSH connection, the direction is a reverse forward, for example:

```sh
ssh -N -o ExitOnForwardFailure=yes -R 127.0.0.1:3845:127.0.0.1:3845 USER@DGC_HOST
```

Keep both ends bound to loopback. Desktop-generated asset URLs can use the same
port, so forwarding only an unrelated MCP path is insufficient.

Read-only checks on the user-authorised Mac at `192.168.1.10` found neither
`/Applications/Figma.app` nor `~/Applications/Figma.app`, and no listener on port
3845. Therefore no real Figma desktop handshake or tool operation was verified.
The setup UI and settings-save path were tested; that is distinct from a live
Figma desktop test. The next prerequisite is installing/opening the desktop app
on the intended computer and enabling its server with an eligible account.

## Can a third-party service supply the connections?

Yes, if it offers its own authorised service integration to downstream MCP
clients. A catalog alone does not transfer an OAuth client approval or account
session. There are two useful product models:

1. User connects their own broker account in DGC, then authorises each app there.
2. DGC embeds the broker's developer platform with per-user connections, a DGC
   backend integration, billing and explicit third-party data handling.

The final approved direction is **the user's own Composio account as an App
connector inside DGC**. This supersedes the earlier developer-project proposal.
The implementation uses Composio Connect over the existing MCP/OAuth path; it
needs neither a DGC-owned Composio project nor a bundled project API key.

| Service | Published route | Actual DGC probe | Assessment |
| --- | --- | --- | --- |
| Composio Connect | `https://connect.composio.dev/mcp` | DGC received an authorization URL at `connect.composio.dev/oauth/authorize`, then cancelled | Offered as an optional connector. User reports Figma connected in Composio; authenticated DGC tool execution remains unverified. |
| Pipedream consumer MCP | `https://mcp.pipedream.net/v2` | Bridge exited before an authorization URL | Not offered; failure cause unresolved. |
| Pipedream developer platform | Hosted MCP plus a project and credentials | Documentation only | Not implemented. |

## Implemented Composio experience

**Settings → Plugins → Apps → Connect Composio** reviews the published endpoint
and service terms, then starts real browser OAuth. **Manage apps in Composio**
opens Composio For You → Connect Apps for authorization, account selection and
revocation. DGC shows connector status only. The earlier individual app shortcuts
were removed after the user's actual server rejected their assumed setup-tool
contract. No undocumented inventory or per-app state is invented.

The user reports successful Figma authorization in Composio. Authenticated app
tool execution through DGC has not been independently verified. Plugin-owned
connections now live on plugin detail pages; the MCP tab lists manual servers.

The app names stay normal (Figma, Gmail); connection-provider disclosure stays
visible. Composio's Figma capabilities are not equivalent to the official
Figma MCP's canvas editing tools. Account limits, plan availability and app
scopes apply. App requests execute in Composio's cloud even with a local model.

See [implementation and verification](COMPOSIO_CONNECTOR.md) for exact contracts,
permission behavior, recovery paths and evidence limits. No account registration,
app consent or paid plan acceptance was performed during development.

### Commercial terms question — unresolved

Checked 23 September 2026. The developer documentation supports embedding, but
section 3 of the [public terms](https://composio.dev/terms) grants commercial
use and then contains broad commercial-use/resale exclusions. Obtain written
clarification of how these apply to DGC and review the applicable agreement
with counsel before commercial launch. This is an unresolved contractual
question, not a finding that integration is prohibited.

The published [DPA](https://composio.dev/legal/dpa) becomes binding only through
dashboard acceptance and lists Pro/Enterprise Developer eligibility. Confirm
the applicable data-processing agreement and privacy disclosures for DGC's
user-data flow; the public page alone is not an executed agreement.

Draft question for Composio (not sent):

> DGC is a coding application distributed to end users. We intend to embed
> your app catalog, managed account connection flows and tool execution in
> DGC, with isolated user connections and DGC branding. Please confirm which
> agreement and plan permit this commercial embedded use, how section 3's
> commercial-use/resale exclusions apply, and any requirements for managed
> OAuth, app names/logos, attribution and data processing.

No DGC-owned Composio project or project credentials are configured. The user-owned
connector is implemented locally; that is not a claim of commercial legal clearance
or successful authenticated provider operations.

## Primary sources checked

- Figma [remote access](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/), [desktop setup](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/), [tool availability](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/), [desktop seat requirement](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server).
- Canva [registered client verification](https://www.canva.dev/docs/apps/mcp/verify-app/) and [connection troubleshooting](https://www.canva.dev/docs/apps/mcp/troubleshooting/).
- Vercel [approved clients](https://vercel.com/docs/agent-resources/vercel-mcp).
- Dropbox [trusted clients and custom-app setup](https://help.dropbox.com/integrations/connect-dropbox-mcp-server) and [publisher package](https://github.com/dropbox/dropbox-ai-plugins/tree/ec1a5264a88081a6161d984d87705ce65535fbe0/codex).
- Notion [custom MCP client / dynamic registration](https://developers.notion.com/guides/mcp/build-mcp-client).
- Linear [MCP authentication](https://linear.app/docs/mcp).
- Sentry [MCP connection instructions](https://mcp.sentry.dev/).
- Supabase [MCP authentication and scope](https://supabase.com/docs/guides/ai-tools/mcp).
- Atlassian [OAuth configuration](https://developer.atlassian.com/cloud/rovo-mcp/guides/configuring-oauth-2-1/).
- GitHub [remote MCP configuration](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md).
- Stripe [MCP authentication and account policies](https://docs.stripe.com/mcp).
- Context7 [MCP clients and optional credentials](https://context7.com/docs/resources/all-clients).
- Google [Workspace MCP setup and preview access](https://developers.google.com/workspace/guides/configure-mcp-servers).
- Composio [consumer MCP connection](https://docs.composio.dev/docs/composio-connect), [managed Figma OAuth](https://composio.dev/toolkits/figma), [embedded session MCP](https://docs.composio.dev/docs/sessions-via-mcp).
- Pipedream [Figma consumer MCP](https://mcp.pipedream.com/app/figma) and [developer platform requirements](https://mcp.pipedream.com/developers).

Vendor policy and source packages change. These results are dated evidence,
not a permanent certification of every account, network or model combination.

## Verification of this change

- Required `.venv/bin/python tests/run_tests.py`: **1,799/1,799 checks passed**,
  including **1,161 unittest cases with 4 optional skips**. Full log:
  `output/playwright/curated-audit/full-tests.log`.
- 53 focused backend/plugin/OAuth/model-runtime tests passed.
- 94 settings renderer and extension-host logic tests passed; TypeScript and
  extension compilation passed.
- Real extension development host: the gear opened only the editor settings
  tab, the directory showed 12 entries by default and 23 with unavailable
  entries included, blocked Figma had no active Install/Connect action, and the
  desktop guide prefilled the existing MCP form without a save.
- The branded desktop guide was inspected at a 432px settings viewport: its
  398px dialog had no horizontal overflow. Screenshots are in the audit output
  folder (`directory-final.png`, `figma-desktop-final.png`,
  `figma-desktop-narrow.png`).
- Both installed `vibedgc.dgc-0.26.3` copies contain all eight matching runtime
  files from the final build. Cursor must reload to load the new webview code.
- This audit did not edit the user's `~/.dgc/config.json`, the website, or any
  account's app permissions. No publication or repository push was performed.
