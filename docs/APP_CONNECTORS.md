# App connectors

DGC can connect to five services that broker your apps and workflows: Composio,
Zapier, Make, n8n and Arcade. Each one is an MCP server that you connect once in
DGC's settings. After that the agent discovers and calls the tools the service
actually exposes, through DGC's normal MCP routing and permission checks.

Open **Settings → Plugins → Apps** to connect one.

## Setting up each connector

| Connector | How DGC signs in | Where you choose apps and tools |
| --- | --- | --- |
| Composio | Browser sign-in with your own Composio account | Composio **For You → Connect Apps** (the **Manage apps in Composio** button opens it) |
| Zapier | A connection token: in Zapier MCP, add a server for **Other**, open **Connect**, generate a token and paste the token into DGC | Zapier MCP |
| Make | Browser sign-in; choose the organization and scopes | Your Make scenarios and app connections |
| n8n | Paste your instance MCP URL (it ends in `/mcp-server/http`), then choose browser sign-in or a personal access token | Your n8n instance: enable **Settings → Instance-level MCP** and expose the workflows you want |
| Arcade | Create an MCP gateway with Arcade Auth, select its tools, paste its `https://api.arcade.dev/mcp/…` URL, then sign in | Your Arcade gateway and its provider authorizations |

DGC checks the address before it saves a connection:

- Composio, Zapier and Make must use their published endpoints.
- Arcade must be an Arcade Cloud gateway URL on `api.arcade.dev/mcp/`.
- Every connector needs HTTPS. The one exception is n8n, which may use plain HTTP
  on a loopback address (`localhost`, `127.0.0.1` or `::1`) for a local instance.
- URLs that carry credentials, query strings or fragments are refused. Paste a
  token in the token field, never inside the URL.

When the editor runs DGC on another machine over SSH, loopback addresses refer to
the machine that runs DGC, not the one showing the editor.

## The vendors' own plugins

**Settings → Plugins** also offers 41 plugins published by the services themselves: their
hosted MCP server, and where the vendor publishes them under an open licence, their skills. Each
is pinned to a reviewed version of the vendor's own package. Nothing runs on your computer
except DGC's standard MCP bridge: there is no app to download.

| Plugin | Category | Connecting |
| --- | --- | --- |
| Adobe Developer App Builder | Productivity | none needed |
| Airtable | Productivity | browser sign-in |
| Coda (Superhuman Docs) | Documents and Files | browser sign-in |
| Craft | Documents and Files | browser sign-in |
| Granola | Documents and Files | browser sign-in |
| Read AI | Documents and Files | browser sign-in |
| Mobbin | Design | browser sign-in |
| Mural | Design | browser sign-in |
| Refero | Design | browser sign-in |
| Intercom | Customer Support | browser sign-in |
| Plain | Customer Support | browser sign-in |
| ActiveCampaign | Inbox and Collaboration | browser sign-in |
| AgentMail | Inbox and Collaboration | browser sign-in |
| Ando | Inbox and Collaboration | browser sign-in |
| Brevo | Inbox and Collaboration | your key (MCP server token) |
| Adspirer | Sales | browser sign-in |
| Amplemarket | Sales | browser sign-in |
| Apollo.io | Sales | browser sign-in |
| Attio | Sales | browser sign-in |
| Amplitude | Data Analytics | browser sign-in |
| Antimetal | Data Analytics | browser sign-in |
| Apify | Data Analytics | browser sign-in |
| Astronomer | Data Analytics | browser sign-in |
| Ahrefs | Research | browser sign-in |
| Context.dev | Research | browser sign-in |
| Crustdata | Research | browser sign-in |
| Harmonic | Research | browser sign-in |
| Agent Compatibility | MCP | none needed |
| Aleph | MCP | browser sign-in |
| Algolia | MCP | browser sign-in |
| Amazon Location Service | Infrastructure | browser sign-in |
| Appwrite | Infrastructure | browser sign-in |
| AWS Amplify | Infrastructure | browser sign-in |
| AWS Core | Infrastructure | browser sign-in |
| Arize AX | Agent Orchestration | your key (MCP server token) |
| Artie | Agent Orchestration | browser sign-in |
| Atlan | Agent Orchestration | browser sign-in |
| 1inch | Payments | no account for reading |
| Aave | Payments | none needed |
| Airwallex AgentOS | Payments | browser sign-in |
| Airwallex Developer | Payments | browser sign-in |

Every one was checked on 2026-10-07: DGC registered with the service and its sign-in link opened
the service's own login page (Aave and 1inch listed their tools with no account; Brevo and Arize
refused without a key, as they should). Signing in and the tools need your own account, and the
plugin's page in Settings says exactly what was checked and what each service requires (some need
a paid plan or an admin).

DGC reads all four plugin formats vendors publish: Claude (`.claude-plugin`), Codex
(`.codex-plugin`), Cursor (`.cursor-plugin`, with `mcp.json`) and the open Agent Plugins standard
(`plugin.json` at the root). Skills are imported; host-specific parts (Cursor rules, commands,
agents, hooks) are listed in the review and not imported.

**Payments.** 1inch, Aave and Airwallex AgentOS can move real money (swaps, orders, payees and
company cards). Treat every write as a real transaction; DGC asks before each one.

Some services only let approved apps connect. Asana, Docusign and Zoom are offered with a guided
setup for an app you create for DGC in your own account (Zoom's needs no secret). Figma, Google
Workspace, Microsoft 365, Vercel, Canva and Dropbox are not offered here yet; Composio reaches several
of them through its own approved apps.

## Requirements

- Your own account with the service, any plan it requires, and consent for each
  app inside the service.
- Node.js and `npx` on the machine that runs DGC, for the standard MCP bridge that
  connects DGC to these services.

## Where credentials live

- A pasted connection token is kept in the editor's secret storage, tied to that
  connection. DGC's saved configuration holds only the name of the variable that
  carries it.
- Browser sign-in tokens are kept by the local MCP bridge.
- App credentials and per-app permissions stay with the service. Composio, Zapier,
  Make and Arcade run app requests in their own cloud, even when your model runs
  locally.

## What DGC shows and what it doesn't

DGC shows the connector's own connection status. It does not list a service's
app catalog or report whether an individual app inside the service is connected:
check that in the service. Arcade may ask you to authorize an app the first time
one of its tools is used.

## Permissions

A connector adds no allow rules. DGC's usual deny → ask → allow ordering and the
current mode decide each tool call, and approval cards show the exact arguments.
Permission rules name the outer MCP tool, so allowing a tool that runs several app
actions allows all of them. Connecting a service does not guarantee that every
model chooses its tools well.

## Disconnecting

Disabling or uninstalling a connector removes DGC's access through the normal
plugin controls. It does not revoke the grants you gave inside the service, and it
does not clear the bridge's sign-in cache. Revoke access in the service itself when
that is what you want.

## Limits

- One connection per service.
- n8n uses instance-level MCP, not the workflow-specific MCP Server Trigger node.
- Arcade supports Arcade Cloud gateways with Arcade Auth. Custom domains and
  self-hosted Arcade are not supported.

## Personal Pips

Personal Pips can use these same saved connections, but only through reviewed
steps: bounded Composio reads that you approve as part of the Pip's job, and
single external actions that you approve one at a time. See
[Pips](PIPS.md#personal-pips-apps-and-the-web).
