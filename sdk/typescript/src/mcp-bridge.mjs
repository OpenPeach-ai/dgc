#!/usr/bin/env node
/** stdio ↔ Unix-socket relay. Spawned by DGC as the MCP child; the SDK host owns the tools. */
import net from "node:net";
import process from "node:process";

const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write("usage: node mcp-bridge.mjs SOCKET\n");
  process.exit(2);
}

const sock = net.createConnection(socketPath);
sock.on("error", (error) => {
  process.stderr.write(String(error.message || error) + "\n");
  process.exit(1);
});
process.stdin.pipe(sock);
sock.pipe(process.stdout);
sock.on("end", () => process.exit(0));
