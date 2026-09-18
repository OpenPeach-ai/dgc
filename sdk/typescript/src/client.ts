import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { defaultRuntime, isolatedEnv, writeIsolatedConfig } from "./runtime.ts";
import { engineDenyRules, inspectBashForEngine, policyDecision } from "./policy.ts";
import { Transport } from "./transport.ts";
import { Session } from "./session.ts";
import { ToolHub } from "./tools.ts";
import {
  PROTOCOL, REQUIRES_CLI, VERSION,
  type ClientOptions, type ResumeOptions, type SessionOptions,
} from "./types.ts";

const BRIDGE = fileURLToPath(new URL("./mcp-bridge.mjs", import.meta.url));

export class DGC {
  private readonly sessions: Session[] = [];
  private closed = false;
  private readonly options: ClientOptions;

  constructor(options: ClientOptions) {
    this.options = options;
    mkdirSync(options.stateDir, { recursive: true });
  }

  get version(): string {
    return VERSION;
  }

  async session(options: SessionOptions): Promise<Session> {
    if (this.closed) throw new Error("this DGC client is closed");
    const mode = options.permissions?.mode ?? options.mode ?? this.options.mode ?? "default";
    const unhandled = options.permissions?.unhandled ?? "deny";
    const policy = this.options.policy;
    const userPermission = options.onPermission;
    const inspectBash = inspectBashForEngine(userPermission, mode);
    const denyRules = engineDenyRules(policy, { inspectBash });
    if (policy) {
      options = {
        ...options,
        onPermission: async (request) => {
          if (policyDecision(policy, request) === "deny") {
            const named = (policy.denyTools || []).includes(request.name);
            if (named || !userPermission || mode === "auto") return "deny";
          }
          if (!userPermission) return "deny";
          return userPermission(request);
        },
      };
    }
    const extra = { ...this.options.extraEnv };
    const apiKey = options.apiKey ?? this.options.apiKey;
    if (apiKey && !this.options.inheritUserState) extra.DGC_API_KEY = apiKey;
    if (!this.options.inheritUserState) {
      writeIsolatedConfig(this.options.stateDir, {
        model: options.model ?? this.options.model,
        base_url: options.baseUrl ?? this.options.baseUrl,
        mode,
        thinking: options.thinking ?? this.options.thinking ?? "off",
        artifact_autostart: false,
        artifact_in_plan: false,
        suggest: false,
        eta: false,
        notify: "off",
        monitor_wake: false,
        mcp_servers: {},
        hooks: {},
        trusted_dirs: [options.cwd],
        permissions: {
          allow: [],
          ask: [],
          deny: denyRules,
        },
        ...(typeof options.maxTurns === "number" ? { max_turns: options.maxTurns } : {}),
      });
    }
    const env = isolatedEnv(
      this.options.stateDir, extra, this.options.inheritUserState,
      this.options.inheritUserState ? undefined : options.cwd,
      this.options.inheritEnv ?? false,
    );
    const argv = this.options.runtime ?? defaultRuntime();
    const transport = new Transport(argv, options.cwd, env);
    const ready = await waitReady(transport);
    const protocol = Number(ready.protocol_version);
    if (Number.isFinite(protocol) && protocol !== PROTOCOL) {
      transport.close();
      throw new Error(
        `DGC SDK ${VERSION} requires protocol v${PROTOCOL} (CLI ${REQUIRES_CLI}); child reported ${protocol}`,
      );
    }
    if ((mode === "auto" || mode === "acceptEdits") && ready.workspace_trusted !== true) {
      transport.send({
        type: "set_mode", mode, acknowledge_workspace_trust: true,
        request_id: `trust-${randomUUID().slice(0, 8)}`,
      });
    }
    let hub: ToolHub | null = null;
    if (options.tools?.length) {
      // A private 0700 directory from mkdtemp: unpredictable, and short enough for the AF_UNIX
      // path limit (104 bytes on macOS) wherever stateDir lives.
      const slot = mkdtempSync(join(tmpdir(), "dgc-sdk-"));
      hub = new ToolHub(join(slot, "tools.sock"), options.tools);
      try {
        await hub.start();
        const catalog = await transport.request({
          type: "upsert_mcp_server",
          request_id: `mcp-${randomUUID().slice(0, 8)}`,
          name: "app",
          runtime: {
            transport: "stdio",
            command: process.execPath,
            args: [BRIDGE, join(slot, "tools.sock")],
            env: {},
            env_names: [],
            log_level: "warning",
          },
          persisted: {
            transport: "stdio",
            command: process.execPath,
            args: [BRIDGE, join(slot, "tools.sock")],
            env_names: [],
            log_level: "warning",
          },
        }, "mcp_servers", 20_000);
        const items = Array.isArray(catalog.items) ? catalog.items as Array<Record<string, unknown>> : [];
        const app = items.find((item) => item.name === "app");
        const problem = catalog.error
          ? String(catalog.error)
          : !app ? "the app tool server is missing from the catalog"
            : app.state !== "connected" ? `the app tool server is ${String(app.state || "not connected")}`
              + (app.error ? `: ${String(app.error)}` : "")
              : "";
        if (problem) {
          hub.close();
          transport.close();
          throw new Error(`custom tools failed to connect: ${problem}`);
        }
      } catch (error) {
        hub.close();
        transport.close();
        throw error;
      }
    }
    const session = new Session(
      transport,
      String(ready.session_id || ""),
      options,
      unhandled,
      options.instructions ?? this.options.instructions ?? "",
      hub,
      this.options.stateDir,
      this.options.department || "",
    );
    for (const rule of denyRules) {
      try { await session.addPermissionRule("deny", rule); } catch { /* isolated config already has it */ }
    }
    this.sessions.push(session);
    return session;
  }

  async resume(options: ResumeOptions): Promise<Session> {
    const session = await this.session(options);
    const command: Record<string, unknown> = {
      type: "resume_session",
      request_id: `resume-${randomUUID().slice(0, 8)}`,
    };
    if (options.latest || !options.sessionId) {
      command.latest = true;
    } else {
      const sessionId = options.sessionId;
      const looksLikePath = sessionId.endsWith(".json") || sessionId.includes("/") || sessionId.includes("\\");
      if (!looksLikePath) {
        const listed = await session.listSessions();
        const match = listed.find((item) => item.id === sessionId);
        if (!match) {
          session.close();
          throw new Error(`no persisted session ${sessionId}`);
        }
        command.path = match.path;
      } else {
        command.path = sessionId;
      }
    }
    try {
      const event = await session.transport.request(command, "session");
      session.sessionId = String(event.session_id || options.sessionId || session.sessionId);
      session.sessionPath = String(event.path || command.path || session.sessionPath);
      await session.discardIdle();
      return session;
    } catch (error) {
      session.close();
      throw error;
    }
  }

  usageReport(department?: string): { runs: number; rows: Array<Record<string, unknown>> } {
    const path = join(this.options.stateDir, "usage", "usage.jsonl");
    const rows: Array<Record<string, unknown>> = [];
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          if (department && row.department !== department) continue;
          rows.push(row);
        } catch { /* skip */ }
      }
    }
    return { runs: rows.length, rows };
  }

  exportAudit(sessionId?: string): Array<Record<string, unknown>> {
    const dir = join(this.options.stateDir, "audit");
    const rows: Array<Record<string, unknown>> = [];
    if (!existsSync(dir)) return rows;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      if (sessionId && !name.startsWith(sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80))) continue;
      for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line) as Record<string, unknown>); } catch { /* skip */ }
      }
    }
    return rows;
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.sessions.length) {
      const session = this.sessions.pop();
      session?.close();
    }
  }
}

async function waitReady(transport: Transport): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const frame = await transport.next(30_000);
    if (frame.type === "ready") return frame;
  }
  throw new Error("timed out waiting for DGC ready");
}
