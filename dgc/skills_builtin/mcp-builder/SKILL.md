---
name: mcp-builder
description: Build or extend an MCP server and validate its advertised tools, resources or prompts against a real client. Use for server development, not merely connecting an existing server.
---
Build the MCP capability: $ARGUMENTS

Inspect the project's runtime, SDK, transport and existing tests. Check current primary specification
and the installed SDK documentation for version-specific APIs. Start with the smallest useful tool,
resource or prompt contract; do not advertise capabilities that are not implemented. This skill does
not bundle an SDK, browser, remote account or MCP server.

Define inputs, outputs, errors and authority. Validate tool arguments, bound result size and runtime,
and preserve cancellation. Resource URIs belong to the server's declared namespace; never turn an
arbitrary client URI into unrestricted filesystem or network access. Keep credentials in protected
runtime storage or named environment references, outside results, prompts and logs.

For stdio, reserve stdout for protocol messages and send diagnostics to stderr. Test initialization,
capability negotiation and an actual request/result exchange using the chosen SDK/client. For remote
HTTP, follow the negotiated transport/authentication contract; do not substitute permissive CORS or
an unauthenticated public endpoint for a working sign-in design. Treat client roots as declared context,
not proof that every process or remote caller has filesystem permission.

Exercise malformed arguments, unknown names/URIs, cancellation, oversized output and reconnect in an
isolated fixture. Test only the features exposed by this server. For resources/prompts, verify listing,
pagination where used, exact lookup and text/media representation. Descriptions and annotations help
clients route requests but are not enforcement for destructive behavior.

Connect a local fixture to DGC using its MCP management UI or `/mcp add NAME -- COMMAND ARGS...` when
that configuration change is authorized. Use `/mcp resources NAME` or `/mcp prompts NAME` for the
corresponding capability and a permitted tool call for tools. Keep development registrations separate
from the user's existing servers and remove only registrations created for the test.

Report the implemented capability, actual client/transport tested, failures checked and remaining
compatibility/auth gaps. Example: a document resource server should reject a URI outside its namespace
without interpreting it as a local file path.

Reference: [official MCP server guidance](https://modelcontextprotocol.io/docs/develop/build-server).
