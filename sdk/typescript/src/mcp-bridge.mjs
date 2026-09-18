#!/usr/bin/env node
/**
 * stdio <-> Unix-socket relay. DGC spawns it as the `app` MCP server; the SDK host owns the tools.
 *
 * The session's secret arrives in DGC_SDK_TOOL_TOKEN. The relay drops it from its own
 * environment, proves it knows it with a first `{"dgc_sdk_bridge":1,"token":...}` line, then
 * copies NDJSON in both directions. Standard library only.
 */
import net from "node:net";
import process from "node:process";

const TOKEN_ENV = "DGC_SDK_TOOL_TOKEN";
const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write("usage: node mcp-bridge.mjs SOCKET  (with DGC_SDK_TOOL_TOKEN set)\n");
  process.exit(2);
}
const token = process.env[TOKEN_ENV] || "";
delete process.env[TOKEN_ENV];
if (!token) {
  process.stderr.write(`dgc-sdk tool bridge: ${TOKEN_ENV} is not set\n`);
  process.exit(2);
}

const sock = net.createConnection(socketPath);
sock.on("error", (error) => {
  process.stderr.write(`dgc-sdk tool bridge: cannot reach the application: ${error.message || error}\n`);
  process.exit(1);
});
sock.on("connect", () => {
  sock.write(JSON.stringify({ dgc_sdk_bridge: 1, token }) + "\n");
  process.stdin.pipe(sock);
  sock.pipe(process.stdout);
});
sock.on("end", () => process.exit(0));
sock.on("close", () => process.exit(0));
