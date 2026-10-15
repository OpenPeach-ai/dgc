# MCP servers, resources, and prompts

Use `/mcp` in the editor or terminal to open the server catalog. Commands also work after opening
the slash picker inside an existing draft. Opening the catalog, previewing context, and cancelling
the picker preserve the draft.

## Configure a server

The CLI, terminal UI, and editor share DGC's server configuration. Examples:

```text
/mcp add docs --url https://mcp.example.com/mcp
/mcp add private-docs --url https://mcp.example.com/mcp --auth-env DOCS_TOKEN
/mcp add local-docs --env DOCS_TOKEN -- python /path/to/server.py
/mcp edit local-docs -- python /path/to/replacement.py
/mcp disable docs
/mcp enable docs
/mcp reconnect docs
/mcp remove docs
```

Use `dgc mcp ...` for the same operations outside an interactive chat. The editor also has forms
for adding and editing servers. Its token fields use VS Code SecretStorage. Terminal configuration
accepts environment variable **names**, not literal tokens in server arguments or configuration.
Remote URLs must use HTTPS, with HTTP permitted for loopback development servers.

Disablement preserves the server definition and its credential binding. Reconnect targets one
server; `/mcp reconnect` reconnects all enabled configured servers. Add never replaces an existing
name: use edit to change it. Removing a server forgets its DGC configuration and runtime credential
binding. OAuth tokens maintained by the remote bridge have their own cache lifecycle.

## Attach context

In the editor, choose **Resources**, **Resource templates**, or **Prompts** on a connected server.
Resources can be previewed immediately. Templates display the server's URI template and ask for
a concrete URI. Prompts ask for the arguments declared by the server. **Attach to draft** adds the
fetched text as a removable snapshot. Choosing the same server and URI again updates that snapshot.

Terminal equivalents:

```text
/mcp resources docs
/mcp templates docs
/mcp prompts docs
/mcp read docs docs://api/reference
/mcp prompt docs inspect topic="request validation"
/mcp context
/mcp clear-context
```

`read` and `prompt` attach a snapshot to the next terminal prompt. With `dgc mcp read ...` or
`dgc mcp prompt ...`, the result is printed instead. The editor previews those commands' results
before attachment. `/mcp context` and `/mcp clear-context` manage terminal staging; editor snapshots
are managed using the draft's attachment chips.

Resource URIs belong to the selected MCP server. A server's `file://` URI is sent to that server;
DGC does not open a local file merely because the URI uses that scheme. Fetches go through DGC's
normal MCP permissions, hooks, cancellation, and credential redaction. Deny rules take precedence.
Prompt invocation is user controlled. Native models can discover and read resources through
host-provided MCP routes, subject to the same permissions.

Fetched content is untrusted reference data. It cannot grant filesystem access, override permissions,
or activate a DGC skill through a `$name` appearing in the resource. Links are not fetched
automatically. Text is supported; binary and media blocks produce explicit omission notices.
Catalogs are paginated with bounded size and time. Oversized selected context is rejected, and the
editor keeps the draft so that attachments can be reduced before retrying.

## Remote authentication and recovery

DGC connects to remote MCP servers with its own client (`dgc/mcp_remote.py`); nothing is started and
Node.js is not needed. A saved remote entry keeps its logical `npx -y mcp-remote <url>` shape, so
existing configurations and older editors stay compatible; DGC reads those arguments (the URL, a
callback port, `--header`, `--static-oauth-client-info`, `--static-oauth-client-metadata`,
`--auth-timeout`, `--resource`, `--transport`) and runs nothing.

- **Transports:** Streamable HTTP first: one POST per message, answered as JSON or an SSE stream, with
  the `Mcp-Session-Id` kept and returned, `MCP-Protocol-Version` after initialize, a GET stream for
  what the server says unprompted, and `DELETE` to end the session. A `404` for a session starts a new
  one. A server that answers the first POST with `400`, `404` or `405` is reached over the older
  HTTP+SSE transport (an `endpoint` event, then POSTs answered on the stream), as `mcp-remote`'s
  `http-first` did. The handshake is `initialize`; the stateless 2026 probe is not sent to remote
  servers.
- **Sign-in:** OAuth 2.1 with PKCE (S256). A `401` names the server's protected-resource metadata
  (RFC 9728), checked to describe this server, which names its authorization server (RFC 8414 or
  OpenID discovery, path-aware). How DGC identifies itself follows MCP's order: your own app when the
  entry names one; else DGC's client metadata document (`https://vibedgc.com/oauth/dgc-client.json`)
  where the service advertises `client_id_metadata_document_supported` and accepts public clients, and
  only once that document is published and says what DGC expects; else it registers itself as "DGC"
  (RFC 7591). With the document, the callback is `http://127.0.0.1:29167/oauth/callback` (any port where
  29167 is busy, under RFC 8252's loopback exception). DGC sends the resource indicator (RFC 8707), asks
  for the scope the challenge or metadata names, and checks the `iss` the service returns (RFC 9207). A
  service that answers a request without a token with `403` and no challenge (Docusign) is signed in to
  the same way as one that answers `401`. Tokens refresh before they expire and after a `401`. A `403 insufficient_scope` signs in
  again for the larger scope while you are connecting; in the middle of a conversation the call says
  so, and the next Connect asks for it.
- **Where sign-ins live:** the system keychain (macOS Keychain through the Security framework; the
  Linux desktop keyring through `secret-tool`, with the secret on its standard input), one entry per
  server and DGC home. Without a usable keychain, an owner-only file under
  `~/.dgc/plugin-auth/<server>/`. `plugin_credentials_store` is `auto`, `keyring` or `file`. Several
  DGC windows and Pips share a sign-in; a lock makes one of them sign in or refresh at a time.
- **Your own app's secret** stays in the owner-only file the editor writes; the keychain entry
  keeps only its client id and where that file is.

Explicit connection operations allow up to 150 seconds, including a 120-second sign-in window, and
can be cancelled. Declining stops the connection. Authorization links are kept out of diagnostics;
they are not resource attachments or model instructions. Cold startup does not wait for sign-in:
a server that needs it is reported as needing sign-in at once, and **Reconnect** signs in.

An SSH/remote extension host runs DGC remotely: its loopback callback port must be reachable from
the browser that completes sign-in. Before opening the authorization page, the extension requests
forwarding for DGC's validated callback through the editor's `asExternalUri` API. Generic
server-provided URL requests cannot request port forwarding. Duplicate acceptance, cancellation,
expiration and backend replacement cannot acknowledge a pending launch or open its page afterward.
If the editor maps the callback to another port or a web-hosted address, DGC cancels the attempt
and explains how to forward the remote callback port to the same local port in the Ports panel.
DGC never rewrites an OAuth redirect after registration. Browser-only remote editors that require
a different callback origin are not supported. A terminal-only SSH session needs equivalent
forwarding configured by its user. Provider-specific device-code flows remain provider-owned. The
editor API's forwarding contract is described in the
[official remote-extension guide](https://code.visualstudio.com/api/advanced-topics/remote-extensions#forwarding-localhost).

## Tests

`tests/test_mcp_remote.py` runs in the normal suite against a real local vendor on loopback (HTTP,
OAuth and revocation) with a temporary DGC home and a stand-in keychain: public and bearer servers,
SSE answers, sessions and a forgotten session, the older SSE transport, cancellation, sign-in with
PKCE and the resource indicator, reuse of a kept sign-in, refresh before expiry and after a `401`,
step-up at the next Connect, declining, startup with nobody to ask, your own app's secret (never
stored), two windows signing in at once (one browser), revocation on removal, the client metadata
document (and registering instead when it isn't published), a `403` without a challenge, and a sign-in
that comes back naming another issuer. The macOS Keychain calls were also run on a real Mac against a
temporary keychain file, and the Linux path against a real gnome-keyring (Secret Service) through
`secret-tool`, signing in, reusing the sign-in, revoking and deleting it.
