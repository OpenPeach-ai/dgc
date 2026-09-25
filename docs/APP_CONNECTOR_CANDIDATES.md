# Additional account connectors — research, 24 September 2026

Update: the first four candidates now have local setup flows in the 0.44.0 /
0.29.0 development build. See [APP_CONNECTORS.md](APP_CONNECTORS.md) for the
implementation and verification limits. The research below records the earlier
recommendation; it is not evidence of live account authentication.

At the time of this research, these were candidates, not authenticated integrations. No
accounts, subscriptions or vendor grants were created during this review.

## Recommended order

1. **Zapier MCP:** strongest next candidate for a user-owned app-action account.
   Current official generic-client instructions require a user-created server
   and connection token. Use the documented endpoint with a Bearer header and
   DGC's existing secret storage; do not persist the token in the URL or promise
   browser OAuth for an unlisted client. App connections/tools are managed in
   Zapier. Validate authentication, discovery, one user-approved tool call,
   reconnect and token revocation before offering it as supported.
   https://docs.zapier.com/mcp/get-started/connect/other
   https://docs.zapier.com/mcp/get-started/quickstart

2. **Make:** workflow connector. Users connect their Make account using the
   documented MCP OAuth endpoint and scopes, then run the scenarios they have
   configured. This does not automatically expose every action in Make's app
   catalog. DGC client authorization and execution are untested. Prefer narrowly
   scoped scenario execution initially; Make also exposes account-management
   tools under additional scopes.
   https://developers.make.com/mcp-server
   https://developers.make.com/mcp-server/connect-using-oauth

3. **n8n:** workflow connector for Cloud and self-hosted instances. Users enable
   instance MCP, expose workflows and provide their instance URL plus OAuth or
   a personal bearer token. Current versions also offer workflow creation/editing;
   scope/version differences must be reflected in tool discovery. No live n8n
   instance was tested with DGC in this review.
   https://docs.n8n.io/connect/connect-to-n8n-mcp-server

4. **Arcade:** a user or team can create a gateway, select the tools it exposes,
   and connect its URL using Arcade OAuth. This is more setup than Composio's
   shared endpoint. A production gateway operated by DGC on behalf of external
   users has a different identity/infrastructure design; do not conflate that
   with connecting a user's own gateway. No DGC auth/execution test yet.
   https://docs.arcade.dev/en/get-started/quickstarts/call-tool-client
   https://docs.arcade.dev/en/operate/identity/user-sources

5. **Pipedream:** a consumer account endpoint is documented separately from the
   developer platform. The earlier DGC bridge probe exited before providing a
   sign-in URL; its cause remains unresolved. Keep it out of the offered list
   until that failure is diagnosed and a real account/tool flow passes. Developer
   embedding instead requires a project and API credentials.
   https://mcp.pipedream.com/app/figma
   https://mcp.pipedream.com/developers
   Prior probe: docs/PLUGIN_COMPATIBILITY_AUDIT.md

## Developer infrastructure

**Nango** exposes integration tools and managed authorization, but is a larger
integration project with per-user connection scoping and provider OAuth setup.
Its docs distinguish shared developer credentials from production credentials;
providers without shared apps need our own registration. It is not a blanket
solution to provider approval requirements.
https://nango.dev/platform/mcp
https://nango.dev/blog/how-to-build-ai-agent-integrations-using-the-nango-management-mcp

## DGC UI recommendation

Keep app-service authorization and provider settings in the provider dashboard.
An Apps card should show the actual provider name and logo, connector status,
Connect/Disconnect (when supported), and Manage apps/workflows. Model tools are
still discovered from the live server and go through normal DGC approvals.
Connector-owned connections should remain on that connector's page, with the
MCP tab reserved for independently configured servers. Additional presets have
not been added by this research. Provider account limits and terms apply.

The existing Composio Apps card now reads **Composio** beside its logo, with
**App connector** in the description. TypeScript/build and 28 existing renderer
tests passed; the real extension showed the new heading. Both installed 0.26.3
runtime copies were updated and compared byte for byte. No backend behavior or
user configuration was changed in this label-only build.
