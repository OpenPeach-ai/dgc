/**
 * Application tools the agent calls as MCP server `app`, served from this process. Mirrors
 * sdk/python/dgc_sdk/_mcp_bridge.py.
 *
 * DGC runs `node mcp-bridge.mjs SOCKET` with this session's secret in DGC_SDK_TOOL_TOKEN. The
 * socket lives in a fresh 0700 directory under a random name (never under stateDir, never a
 * predictable path), and a connection is served only after its first line carries the secret,
 * so other users, and processes that do not hold the secret, cannot call the tools. One relay
 * connection is served at a time.
 */
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { DGCConfigError, DGCRuntimeError, DGCUnsupportedError } from "./errors.ts";
import type { Frame, Transport } from "./transport.ts";
import { VERSION } from "./types.ts";

export type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
  /** How long the handler may run (default 30 000 ms; null for no limit). */
  timeoutMs?: number | null;
};

export const TOKEN_ENV = "DGC_SDK_TOOL_TOKEN";
export const SERVER_NAME = "app";
const HELLO_KEY = "dgc_sdk_bridge";
const HELLO_TIMEOUT_MS = 10_000;
const HELLO_MAX = 4096;
// sun_path holds 104 bytes on macOS and 108 on Linux, terminator included.
const SOCKET_PATH_MAX = 100;
export const BRIDGE = fileURLToPath(new URL("./mcp-bridge.mjs", import.meta.url));

/**
 * Describe a tool the agent can call (as `mcp__app__<name>`) and this process runs. When the
 * handler runs past `timeoutMs` the agent is told the call failed, but the handler is not
 * stopped: make handlers idempotent or bound their own work. Refuse or allow the tool with
 * `RuntimePolicy.denyTools: ["mcp__app__<name>"]` or `allowTools`.
 */
export function defineTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: ToolHandler,
  options: { timeoutMs?: number | null } = {},
): ToolSpec {
  if (!name || typeof name !== "string" || !/^[\w-]+$/.test(name) || !/[A-Za-z0-9]/.test(name.replace(/[_-]/g, ""))) {
    throw new DGCConfigError("tool name must be a non-empty identifier");
  }
  if (!description || typeof description !== "string") throw new DGCConfigError("tool description is required");
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    throw new DGCConfigError("tool inputSchema must be an object");
  }
  if (typeof handler !== "function") throw new DGCConfigError("tool handler must be callable");
  const timeoutMs = options.timeoutMs === undefined ? 30_000 : options.timeoutMs;
  if (timeoutMs !== null && (typeof timeoutMs !== "number" || !(timeoutMs > 0) || !Number.isFinite(timeoutMs))) {
    throw new DGCConfigError("tool timeoutMs must be a positive number of milliseconds, or null");
  }
  return { name, description, inputSchema, handler, timeoutMs };
}

/** A fresh 0700 directory with a random socket name, short enough for sun_path. */
function privateSocketPath(): { directory: string; path: string } {
  const bases: string[] = [];
  for (const base of [process.env.XDG_RUNTIME_DIR || "", tmpdir(), "/tmp"]) {
    try {
      if (base && !bases.includes(base) && statSync(base).isDirectory()) bases.push(base);
    } catch { /* not there */ }
  }
  for (const base of bases) {
    let directory: string;
    try {
      directory = mkdtempSync(join(base, "dgc-"));
      chmodSync(directory, 0o700);
    } catch {
      continue;
    }
    const path = join(directory, randomBytes(4).toString("hex") + ".sock");
    if (Buffer.byteLength(path) <= SOCKET_PATH_MAX) return { directory, path };
    rmSync(directory, { recursive: true, force: true });
  }
  throw new DGCConfigError("custom tools need a Unix socket path under 100 bytes; none of "
    + `${bases.join(", ") || "the temporary directories"} is short enough (set TMPDIR to a short directory)`);
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export class ToolHub {
  readonly token = randomBytes(32).toString("base64url");
  socketPath = "";
  private directory = "";
  private server: net.Server | null = null;
  private readonly tools: Map<string, ToolSpec>;
  private live: net.Socket | null = null;
  /** True once the relay proved it holds the secret. */
  authenticated = false;
  /** Connections refused for a missing or wrong secret. */
  rejected = 0;

  constructor(tools: readonly ToolSpec[], socketPath?: string) {
    this.tools = new Map(tools.map((item) => [item.name, item]));
    if (socketPath) this.socketPath = socketPath;
  }

  get toolCount(): number {
    return this.tools.size;
  }

  async start(): Promise<void> {
    if (process.platform === "win32") {
      throw new DGCUnsupportedError("custom tools need Unix domain sockets, which this SDK does not use on Windows");
    }
    if (!this.socketPath) ({ directory: this.directory, path: this.socketPath } = privateSocketPath());
    const server = net.createServer((socket) => this.accept(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      chmodSync(this.socketPath, 0o600);
    } catch (error) {
      server.close();
      this.removeFiles();
      throw new DGCConfigError(`custom tools could not open their socket: ${String(error)}`);
    }
    server.on("error", () => { /* keep serving the live connection */ });
    this.server = server;
  }

  close(): void {
    try { this.server?.close(); } catch { /* */ }
    this.server = null;
    try { this.live?.destroy(); } catch { /* */ }
    this.live = null;
    this.removeFiles();
  }

  private removeFiles(): void {
    try { if (this.socketPath && existsSync(this.socketPath)) rmSync(this.socketPath, { force: true }); } catch { /* */ }
    if (this.directory) {
      rmSync(this.directory, { recursive: true, force: true });
      this.directory = "";
    }
  }

  /** (runtime, persisted) MCP server specs; the secret rides only in the runtime spec's env. */
  serverSpec(): { runtime: Frame; persisted: Frame } {
    const persisted = {
      transport: "stdio", command: process.execPath, args: [BRIDGE, this.socketPath],
      env_names: [TOKEN_ENV], log_level: "warning",
    };
    return { runtime: { ...persisted, env: { [TOKEN_ENV]: this.token } }, persisted };
  }

  private accept(socket: net.Socket): void {
    let buf = Buffer.alloc(0);
    let ready = false;
    const timer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    timer.unref();
    const refuse = () => {
      clearTimeout(timer);
      this.rejected += 1;
      socket.destroy();
    };
    socket.on("error", () => { /* peer went away */ });
    socket.on("close", () => {
      clearTimeout(timer);
      if (this.live === socket) this.live = null;
    });
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!ready) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) {
          if (buf.length > HELLO_MAX) refuse();
          return;
        }
        let hello: unknown;
        try { hello = JSON.parse(buf.subarray(0, nl).toString("utf8")); } catch { refuse(); return; }
        const token = hello && typeof hello === "object" ? (hello as Record<string, unknown>).token : undefined;
        // One relay at a time: while one is connected, nobody else is served, even with the secret.
        if (typeof token !== "string" || !same(token, this.token) || (this.live && !this.live.destroyed)) {
          refuse();
          return;
        }
        clearTimeout(timer);
        ready = true;
        this.live = socket;
        this.authenticated = true;
        buf = buf.subarray(nl + 1);
      }
      let nl: number;
      while ((nl = buf.indexOf(0x0a)) !== -1) {
        const line = buf.subarray(0, nl).toString("utf8").trim();
        buf = buf.subarray(nl + 1);
        if (!line) continue;
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        void this.handle(message).then((reply) => {
          if (reply && !socket.destroyed) socket.write(JSON.stringify(reply) + "\n");
        });
      }
    });
  }

  private async callHandler(spec: ToolSpec, args: Record<string, unknown>): Promise<unknown> {
    const work = Promise.resolve().then(() => spec.handler(args));
    const limit = spec.timeoutMs === undefined ? 30_000 : spec.timeoutMs;
    if (limit === null) return work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error("handler exceeded timeout"), { name: "TimeoutError" })), limit);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
        inputSchema: spec.inputSchema && Object.keys(spec.inputSchema).length
          ? spec.inputSchema : { type: "object", properties: {} },
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
      if (!spec) return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${name}` } };
      try {
        const result = await this.callHandler(spec, args);
        const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
        return {
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: String(text).slice(0, 120_000) }], isError: false },
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return {
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: `tool error: ${err.name}: ${err.message}` }], isError: true },
        };
      }
    }
    if (id !== undefined) {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported method ${method}` } };
    }
    return null;
  }
}

function catalogProblem(catalog: Frame, expected: number): string {
  if (catalog.error) return String(catalog.error);
  const items = Array.isArray(catalog.items) ? catalog.items as Array<Record<string, unknown>> : [];
  const entry = items.find((item) => item && typeof item === "object" && item.name === SERVER_NAME);
  if (!entry) return "the runtime did not register the tool server";
  const state = String(entry.state || "");
  if (entry.error || state !== "connected") return String(entry.error || `the tool server is ${state || "not connected"}`);
  const offered = Number(entry.tool_count || 0);
  if (offered < expected) return `the tool server offered ${offered} of ${expected} tools`;
  return "";
}

/**
 * Start the host tool server, register it with DGC as MCP server `app`, and confirm it
 * connected, authenticated and offered every tool. Throws DGCRuntimeError otherwise, rather than
 * leaving a session whose model silently lacks the tools.
 */
export async function installTools(transport: Transport, tools: readonly ToolSpec[], options: {
  requestId: string; timeoutMs: number;
}): Promise<ToolHub> {
  const hub = new ToolHub(tools);
  await hub.start();
  try {
    const { runtime, persisted } = hub.serverSpec();
    const catalog = await transport.request({
      type: "upsert_mcp_server", request_id: options.requestId, name: SERVER_NAME, runtime, persisted,
    }, "mcp_servers", { timeoutMs: options.timeoutMs });
    let problem = catalogProblem(catalog, hub.toolCount);
    if (!problem && !hub.authenticated) problem = "the tool bridge never authenticated to the application";
    if (problem) throw new DGCRuntimeError(`custom tools failed to start: ${problem}`);
  } catch (error) {
    hub.close();
    throw error;
  }
  return hub;
}
