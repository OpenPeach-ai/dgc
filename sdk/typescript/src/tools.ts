import { existsSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import net from "node:net";
import { VERSION } from "./types.ts";

export type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
};

export function defineTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: ToolHandler,
): ToolSpec {
  if (!name || !/^[\w-]+$/.test(name) || !/[A-Za-z0-9]/.test(name.replace(/[_-]/g, ""))) {
    throw new Error("tool name must be a non-empty identifier");
  }
  if (!description) throw new Error("tool description is required");
  if (!inputSchema || typeof inputSchema !== "object") throw new Error("tool inputSchema must be an object");
  if (typeof handler !== "function") throw new Error("tool handler must be callable");
  return { name, description, inputSchema, handler };
}

export class ToolHub {
  private server: net.Server | null = null;
  private readonly tools: Map<string, ToolSpec>;
  readonly socketPath: string;

  constructor(socketPath: string, tools: ToolSpec[]) {
    this.socketPath = socketPath;
    this.tools = new Map(tools.map((item) => [item.name, item]));
  }

  start(): Promise<void> {
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.serve(socket));
      server.on("error", reject);
      server.listen(this.socketPath, () => {
        this.server = server;
        resolve();
      });
    });
  }

  close(): void {
    try { this.server?.close(); } catch { /* */ }
    this.server = null;
    try { if (existsSync(this.socketPath)) unlinkSync(this.socketPath); } catch { /* */ }
    // The socket lives alone in a private mkdtemp directory; remove it once it is empty.
    try { rmdirSync(dirname(this.socketPath)); } catch { /* not empty or already gone */ }
  }

  private serve(socket: net.Socket): void {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; }
        catch { continue; }
        void this.handle(message).then((reply) => {
          if (reply) socket.write(JSON.stringify(reply) + "\n");
        });
      }
    });
  }

  private async handle(message: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const method = String(message.method || "");
    const id = message.id;
    if (method === "initialize") {
      return {
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "dgc-sdk", version: VERSION },
        },
      };
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") {
      const tools = [...this.tools.values()].map((spec) => ({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema?.type ? spec.inputSchema : { type: "object", properties: {} },
      }));
      return { jsonrpc: "2.0", id, result: { tools } };
    }
    if (method === "tools/call") {
      const params = (message.params && typeof message.params === "object")
        ? message.params as Record<string, unknown> : {};
      const name = String(params.name || "");
      const args = (params.arguments && typeof params.arguments === "object")
        ? params.arguments as Record<string, unknown> : {};
      const spec = this.tools.get(name);
      if (!spec) {
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${name}` } };
      }
      try {
        const result = await spec.handler(args);
        const text = typeof result === "string" ? result : JSON.stringify(result);
        return {
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: String(text).slice(0, 120_000) }], isError: false },
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return {
          jsonrpc: "2.0", id,
          result: {
            content: [{ type: "text", text: `tool error: ${err.name}: ${err.message}` }],
            isError: true,
          },
        };
      }
    }
    if (id !== undefined) {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported method ${method}` } };
    }
    return null;
  }
}
