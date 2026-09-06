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

DGC executes the reviewed `mcp-remote@0.8.3` bridge for standard remote configurations. Node.js and
`npx` must be available on the machine running DGC. Existing logical `mcp-remote` configuration
entries remain compatible. The bridge uses the initialize-era stdio handshake; DGC does not run
the disposable modern-protocol probe against it, which previously interrupted slow startup and
browser authentication.

Explicit connection operations allow up to 150 seconds, including the bridge's 120-second OAuth
callback window, and can be cancelled. When browser authorization is required, DGC displays a
transient sign-in link. Declining it stops the connection. The bridge can also launch its local
browser helper. Authorization links are excluded from DGC's regular bridge diagnostics; they are
not resource attachments or model instructions. The bridge stores OAuth tokens in its user cache
(`~/.mcp-auth` by default); the verified POSIX token files have owner-only permissions.

Cold startup remains bounded and does not wait for interactive sign-in. If a first installation or
expired login fails at startup, use **Reconnect** after the client is ready. An SSH/remote extension
host runs the bridge remotely: its loopback OAuth callback port must be reachable from the browser
that completes sign-in. Before opening the authorization page, the extension now requests forwarding
for the bridge's validated callback through the editor's `asExternalUri` API. Generic server-provided
URL requests cannot request port forwarding. Duplicate acceptance, cancellation, expiration and
backend replacement cannot acknowledge a pending launch or open its browser page afterward.

The pinned bridge's registered callback must retain its HTTP loopback address, port and path. If the
editor maps it to another port or a web-hosted address, DGC cancels the attempt and explains how to
forward the remote callback port to the same local port in the desktop editor's Ports panel, then
reconnect. DGC does not rewrite an OAuth redirect after registration. Browser-only remote editors
that require a different callback origin are not supported by this bridge flow. A terminal-only SSH
session needs equivalent forwarding configured by its user. Provider-specific device-code flows
remain provider-owned; this check does not claim device-code support for every MCP server.

Forwarding and late-response behavior have extension regression coverage; the actual bridge tests
exercise HTTP and OAuth locally. Neither establishes that every remote-host/identity-provider
combination works. The editor API's forwarding contract is described in the
[official remote-extension guide](https://code.visualstudio.com/api/advanced-topics/remote-extensions#forwarding-localhost).

The real-bridge fixture verifies public HTTP, bearer auth, OAuth authorization-code/PKCE, reuse of a
cached login, refresh after an expired-token `401`, slow startup without duplicate processes,
cancellation, and declining sign-in. It also exposed an upstream 0.8.3 limitation: proactive refresh
can reject a path-specific resource identifier when it compares it with the issuer origin. Refresh
after the server rejects the expired token succeeded in the fixture. DGC does not claim proactive
refresh is verified for every provider.

## Reproduce the isolated bridge checks

Install the reference bridge separately; it is not vendored or a new Python runtime dependency:

```bash
npm install --prefix /tmp/dgc-mcp-reference --ignore-scripts --no-audit --no-fund mcp-remote@0.8.3
DGC_TEST_MCP_REMOTE=/tmp/dgc-mcp-reference/node_modules/mcp-remote/dist/proxy.js \
  python -m unittest discover -s tests -p test_mcp_remote.py -v
```

These tests use temporary loopback servers, synthetic credentials, a separate temporary token
cache, and a suppressed browser helper. Normal Python test discovery skips them unless the
reference bridge path is selected explicitly. The modern and legacy stdio context tests run in
the normal suite.
