/** Public DGC client. Mirrors sdk/python/dgc_sdk/client.py. */
import {
  closeSync, constants as fsConstants, openSync, realpathSync, rmSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AuditLog, rememberSecret } from "./audit.ts";
import {
  DGCCommandRejectedError, DGCConfigError, DGCError, DGCProtocolError, DGCRuntimeError, publicError,
} from "./errors.ts";
import {
  Policy, compileSession, permissionSettings, sandboxPrecheck, sandboxRequirement, toPolicy,
} from "./policy.ts";
import { defaultRuntime, isolatedEnv } from "./runtime.ts";
import { Session } from "./session.ts";
import { configDrift, prepareStateDir, stateLock, writeSessionConfig } from "./state.ts";
import { installTools, type ToolHub } from "./tools.ts";
import { Transport, type Frame } from "./transport.ts";
import { UsageLog, type UsageReport } from "./usage.ts";
import {
  PROTOCOL, REQUIRES_CLI, VERSION,
  type ClientOptions, type Env, type PermissionMode, type ResumeOptions, type SandboxRequirement, type SessionOptions,
} from "./types.ts";

const CONFIG_ATTEMPTS = 3;

function newId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function milliseconds(value: unknown, name: string, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new DGCConfigError(`${name} must be more than 0 and at most ${maximum} milliseconds`);
  }
  return value;
}

/**
 * Write a provider key to a private (0600) file inside the 0700 stateDir. The runtime is handed
 * the path (DGC_API_KEY_FILE), not the key, so the key never sits in the child's initial
 * environment block, which stays readable in /proc/<pid>/environ. The CLI reads the file and
 * deletes it at config load, before any tool runs.
 */
function writeKeyFile(path: string, value: string): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, 0o600);
  try {
    writeSync(fd, value);
  } finally {
    closeSync(fd);
  }
}

function runtimeArgv(runtime: unknown): string[] {
  if (!Array.isArray(runtime)) throw new DGCConfigError("runtime must be an argv array such as ['dgc', 'serve']");
  if (!runtime.length || runtime.some((item) => typeof item !== "string" || !item || item.includes("\u0000"))) {
    throw new DGCConfigError("runtime must be a non-empty array of non-empty strings");
  }
  return [...runtime] as string[];
}

function existingDirs(items: readonly string[]): string[] {
  const found: string[] = [];
  for (const item of items) {
    try {
      const path = realpathSync(item.startsWith("~/") ? join(homedir(), item.slice(2)) : item);
      if (statSync(path).isDirectory()) found.push(path);
    } catch { /* not there */ }
  }
  return found;
}

/** With inheritUserState these would have to be saved into your own ~/.dgc. */
function rejectInherited(options: Record<string, unknown>): void {
  const given = Object.entries(options)
    .filter(([name, value]) => value !== undefined && value !== null
      && !(typeof value === "object" && !Array.isArray(value) && !Object.keys(value as object).length)
      && !(name === "thinking" && value === "off"))
    .map(([name]) => name).sort();
  if (given.length) {
    throw new DGCConfigError(`inheritUserState runs with your own DGC settings, and DGC would save ${given.join(", ")} `
      + "into ~/.dgc/config.json; set them with the dgc CLI, or use an isolated stateDir (inheritUserState: false)");
  }
}

/** Refuse an inherited session whose settings differ from what the caller asked for. */
function checkInherited(ready: Frame, requested: Record<string, string | undefined>): void {
  const actual: Record<string, string> = {
    model: String(ready.model || ""),
    baseUrl: String(ready.base_url || "").replace(/\/+$/, ""),
    mode: String(ready.mode || ""),
    thinking: String(ready.think || ""),
  };
  const wrong: string[] = [];
  for (const [name, value] of Object.entries(requested)) {
    if (value === undefined) continue;
    const want = name === "baseUrl" ? value.replace(/\/+$/, "") : value;
    if (want !== actual[name]) wrong.push(`${name}=${JSON.stringify(value)} (your DGC uses ${JSON.stringify(actual[name])})`);
  }
  if (wrong.length) {
    throw new DGCConfigError("inheritUserState uses your own DGC settings and cannot change them without saving into "
      + `~/.dgc: ${wrong.join("; ")}. Change them with the dgc CLI, or use an isolated stateDir`);
  }
}

/**
 * Own zero or more isolated DGC sessions. Does not talk to a provider on construction.
 *
 * `stateDir` holds this client's isolated HOME, audit and usage logs; it must be private, and
 * left unset a fresh private temporary directory is used ({@link stateDir}). `inheritEnv` picks
 * which host environment variables reach the runtime: false (default) passes only basic ones, a
 * list of names adds those, true passes everything. `startTimeoutMs` bounds the runtime's startup
 * handshake and `requestTimeoutMs` each control request.
 */
export class DGC {
  private readonly sessions: Session[] = [];
  private closed = false;
  private readonly options: ClientOptions;
  private readonly policy: Policy | null;
  private readonly sandbox: SandboxRequirement;
  private readonly runtime: string[];
  private readonly startTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly usageLog: UsageLog;
  private readonly auditLog: AuditLog;
  /** This client's private state directory (created when it was not given). */
  readonly stateDir: string;
  private ownsStateDir: boolean;
  private readonly trustWorkspace: boolean;

  constructor(options: ClientOptions = {}) {
    this.options = { ...options };
    this.policy = toPolicy(options.policy);
    if (options.inheritUserState) {
      rejectInherited({
        model: options.model, baseUrl: options.baseUrl, thinking: options.thinking, extraConfig: options.extraConfig,
      });
    }
    if (options.inheritEnv !== undefined && typeof options.inheritEnv !== "boolean") {
      if (!Array.isArray(options.inheritEnv)) throw new DGCConfigError("inheritEnv must be true, false, or a list of variable names");
      for (const name of options.inheritEnv) {
        if (typeof name !== "string" || !name || name.includes("=") || name.includes("\u0000")) {
          throw new DGCConfigError(`inheritEnv has an invalid variable name: ${JSON.stringify(name)}`);
        }
      }
    }
    this.startTimeoutMs = milliseconds(options.startTimeoutMs, "startTimeoutMs", 3_600_000, 30_000);
    this.requestTimeoutMs = milliseconds(options.requestTimeoutMs, "requestTimeoutMs", 86_400_000, 15_000);
    this.runtime = options.runtime !== undefined ? runtimeArgv(options.runtime) : defaultRuntime();
    this.sandbox = sandboxRequirement(options.sandbox);
    sandboxPrecheck(this.sandbox);
    this.stateDir = prepareStateDir(options.stateDir);
    // Only a directory the SDK created for this client is removed on close; an explicit stateDir
    // (the application's own directory) is always left alone.
    this.ownsStateDir = options.stateDir === undefined && !options.keepStateDir;
    this.trustWorkspace = Boolean(options.trustWorkspace);
    if (options.apiKey) rememberSecret(options.apiKey);
    this.usageLog = new UsageLog(join(this.stateDir, "usage"));
    this.auditLog = new AuditLog(join(this.stateDir, "audit"));
  }

  get version(): string {
    return VERSION;
  }

  /** The `dgc serve` argv this client starts. */
  get rawRuntime(): string[] {
    return [...this.runtime];
  }

  async session(options: SessionOptions): Promise<Session> {
    if (this.closed) throw new DGCRuntimeError("this DGC client is closed");
    if (!options || typeof options.cwd !== "string" || !options.cwd) throw new DGCConfigError("cwd must be an existing directory");
    let workspace: string;
    try {
      workspace = realpathSync(options.cwd);
      if (!statSync(workspace).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new DGCConfigError("cwd must be an existing directory");
    }
    const inherit = Boolean(this.options.inheritUserState);
    const [mode, unhandled] = permissionSettings(options.permissions, options.mode,
      this.options.mode ?? "default", options.onPermission);
    const requestedMode: PermissionMode | undefined = options.mode || options.permissions?.mode
      || (this.options.mode && this.options.mode !== "default" ? this.options.mode : undefined);
    if (inherit) {
      rejectInherited({
        maxTurns: options.maxTurns, verifyCommand: options.verifyCommand, turnBudgetS: options.turnBudgetS,
        maxTokens: options.maxTokens,
      });
    }
    const requirement = options.sandbox !== undefined ? sandboxRequirement(options.sandbox) : this.sandbox;
    sandboxPrecheck(requirement);
    const tools = options.tools ?? [];
    // The RuntimePolicy and sandbox reach this session's runtime only through its environment
    // (DGC_SESSION_POLICY); nothing is written to any config.json.
    const plan = compileSession(this.policy, {
      cwd: workspace, mode, sandbox: requirement, tools: tools.map((t) => t.name),
      trustWorkspace: this.trustWorkspace, isolated: !inherit,
    });
    const key = options.apiKey ?? this.options.apiKey;
    const extra: Record<string, string> = { ...(this.options.extraEnv || {}) };
    let keyFile: string | null = null;
    if (key) {
      rememberSecret(key);
      if (inherit) {
        // inheritUserState runs as the user's own DGC on their own machine; the key goes in the
        // environment as before (DGC never saves it into ~/.dgc).
        extra.DGC_API_KEY = String(key);
      } else {
        // An isolated child's environment block stays readable in /proc/<pid>/environ, so the key
        // travels in a 0600 file inside the 0700 stateDir that the CLI reads and deletes.
        keyFile = join(this.stateDir, `.apikey-${newId("key")}`);
        extra.DGC_API_KEY_FILE = keyFile;
      }
    }
    Object.assign(extra, plan.env);
    let values: Record<string, unknown> | null = null;
    if (!inherit) {
      values = {
        model: options.model || this.options.model,
        base_url: options.baseUrl || this.options.baseUrl,
        mode,
        thinking: options.thinking || this.options.thinking || "off",
        artifact_autostart: false,
        artifact_in_plan: false,
        suggest: false,
        eta: false,
        notify: "off",
        monitor_wake: false,
        mcp_servers: {},
        hooks: {},
        trusted_dirs: [workspace, ...existingDirs(this.policy?.extraReadDirs ?? [])],
        sandbox: false,
        sandbox_network: Boolean(this.policy && this.policy.network === "allow"),
        ...(this.options.extraConfig || {}),
      };
      if (options.maxTurns !== undefined) values.max_turns = Math.trunc(options.maxTurns);
      if (options.turnBudgetS !== undefined) values.turn_budget_s = Math.trunc(options.turnBudgetS);
      if (options.maxTokens !== undefined) values.max_tokens = Math.trunc(options.maxTokens);
      if (options.verifyCommand) {
        values.verify_command = options.verifyCommand;
        values.verify_before_done = true;
      }
    }
    let env: Env;
    try {
      env = isolatedEnv(this.stateDir, extra, inherit, inherit ? undefined : workspace, this.options.inheritEnv ?? false);
    } catch (error) {
      if (error instanceof DGCError) throw error;
      throw new DGCConfigError(`could not prepare the isolated runtime home: ${String(error)}`);
    }
    const lock = stateLock(this.stateDir);
    // Config write, child startup and every save the SDK itself triggers happen under one lock,
    // so concurrent sessions never read each other's options.
    const session = await lock.hold(async () => {
      let started: { transport: Transport; ready: Frame };
      try {
        started = await this.start(workspace, env, values, key, keyFile);
      } finally {
        // The CLI deletes the key file as it starts; remove any leftover (a failed or skipped
        // start) so the key never lingers in the stateDir.
        if (keyFile) {
          try { unlinkSync(keyFile); } catch { /* already gone */ }
        }
      }
      const { transport, ready } = started;
      let hub: ToolHub | null = null;
      try {
        const sandboxStatus = plan.confirm(ready);
        if (inherit) {
          checkInherited(ready, {
            model: options.model || this.options.model,
            baseUrl: options.baseUrl || this.options.baseUrl,
            mode: requestedMode,
            thinking: options.thinking || (this.options.thinking && this.options.thinking !== "off" ? this.options.thinking : undefined),
          });
        }
        if (tools.length) {
          hub = await installTools(transport, tools, {
            requestId: newId("mcp"), timeoutMs: Math.max(20_000, this.requestTimeoutMs),
          });
        }
        if ((mode === "acceptEdits" || mode === "auto") && ready.workspace_trusted !== true) {
          try {
            transport.send({ type: "set_mode", mode, acknowledge_workspace_trust: true, request_id: newId("trust") });
          } catch { /* the run reports a dead backend */ }
        }
        return new Session(transport, ready, {
          options,
          unhandled,
          instructions: options.instructions ?? this.options.instructions ?? "",
          toolHub: hub,
          cwd: workspace,
          policy: this.policy,
          pricing: this.options.pricing,
          department: this.options.department || "",
          usageLog: this.usageLog,
          auditLog: this.auditLog,
          model: String(options.model || this.options.model || ""),
          permissionMode: inherit ? String(ready.mode || mode) : mode,
          isolated: !inherit,
          maxTurns: options.maxTurns,
          verifyCommand: options.verifyCommand || "",
          stateLock: lock,
          excludePaths: inherit ? [join(homedir(), ".dgc"), this.stateDir] : [this.stateDir],
          requestTimeoutMs: this.requestTimeoutMs,
          sandbox: sandboxStatus,
        });
      } catch (error) {
        // Nothing may outlive a failed setup: not the tool socket, not the dgc serve child.
        hub?.close();
        await transport.close();
        throw error instanceof DGCError && !(error instanceof DGCCommandRejectedError)
          ? error : publicError(error, "session setup failed");
      }
    });
    try { await session.bindIdentity(); } catch { /* its transcript appears after the first run */ }
    this.sessions.push(session);
    return session;
  }

  /**
   * Write this session's config from scratch, then start `dgc serve` on it. A DGC child saves its
   * whole config when it persists anything; if another session's child did that between our write
   * and our child's startup, start again.
   */
  private async start(workspace: string, env: Env, values: Record<string, unknown> | null,
    key: unknown, keyFile: string | null = null): Promise<{ transport: Transport; ready: Frame }> {
    const drifts: string[][] = [];
    const attempts = values !== null ? CONFIG_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let written: Record<string, unknown> | null = null;
      try {
        // The CLI reads and deletes the key file at startup, so write it before every (re)start.
        if (keyFile && key) writeKeyFile(keyFile, String(key));
        written = values !== null ? writeSessionConfig(this.stateDir, values) : null;
      } catch (error) {
        throw new DGCConfigError(`could not prepare the isolated runtime home: ${String(error)}`);
      }
      const transport = new Transport(this.runtime, workspace, env);
      let ready: Frame;
      try {
        ready = await transport.start(this.startTimeoutMs);
      } catch (error) {
        await transport.close();
        if (error instanceof DGCProtocolError) throw this.protocolError(error);
        throw new DGCRuntimeError(this.startFailure(error, transport, key), { cause: error });
      }
      const drift = written !== null ? configDrift(this.stateDir, written) : [];
      const last = drifts[drifts.length - 1];
      if (!drift.length || (last && last.join() === drift.join() && attempt === attempts - 1)) {
        // The same difference every time is DGC normalizing its own file, not a race.
        return { transport, ready };
      }
      drifts.push(drift);
      process.emitWarning(`dgc sdk: isolated config changed while the session started (${drift.slice(0, 5).join(", ")}); `
        + "starting again", { code: "DGC_SDK" });
      await transport.close();
    }
    throw new DGCRuntimeError("another DGC process kept rewriting this stateDir's config while the session started; "
      + "use a separate stateDir per process");
  }

  private protocolError(error: DGCProtocolError): DGCProtocolError {
    const offered = error.offeredProtocol;
    const runtime = this.runtime.join(" ");
    if (offered === undefined) {
      return new DGCProtocolError(`the DGC runtime broke protocol v${PROTOCOL}: ${error.message} (runtime: ${runtime})`,
        { cause: error });
    }
    const cli = error.backendVersion || "unknown";
    const advice = typeof offered === "number" && offered > PROTOCOL
      ? "Upgrade the SDK (@vibedgc/sdk) to drive this CLI."
      : `Update the CLI (dgc update), or point DGC_PYTHON or runtime at a DGC that is ${REQUIRES_CLI} or newer.`;
    return new DGCProtocolError(
      `DGC SDK ${VERSION} speaks protocol v${PROTOCOL} and needs CLI ${REQUIRES_CLI} or newer; the runtime is CLI `
      + `${cli} with protocol v${String(offered)} (${runtime}). ${advice}`,
      { offeredProtocol: offered, backendVersion: error.backendVersion, cause: error });
  }

  private startFailure(error: unknown, transport: Transport, key: unknown): string {
    let message = `the DGC runtime did not start: ${error instanceof Error ? error.message : String(error)} `
      + `(runtime: ${this.runtime.join(" ")})`;
    const tail = transport.stderrTail.trim();
    if (tail) message += "\nruntime stderr (last lines):\n" + tail.split("\n").slice(-12).join("\n").slice(-2000);
    for (const secret of new Set([String(key || ""), String(this.options.apiKey || "")])) {
      if (secret.length >= 4) message = message.split(secret).join("[redacted]");
    }
    return message;
  }

  /** Open a session on a persisted transcript (`sessionId`, or `latest: true`). */
  async resume(options: ResumeOptions): Promise<Session> {
    const session = await this.session(options);
    const command: Frame = { type: "resume_session", request_id: newId("resume") };
    let path = options.sessionId;
    const target = options.latest || !options.sessionId ? "the latest session" : JSON.stringify(options.sessionId);
    let event: Frame;
    try {
      if (options.latest || !options.sessionId) {
        command.latest = true;
      } else {
        const sessionId = options.sessionId;
        const looksLikePath = sessionId.endsWith(".json") || sessionId.includes("/") || sessionId.includes("\\");
        if (!looksLikePath) {
          const match = (await session.listSessions()).find((item) => item.id === sessionId);
          if (!match) throw new DGCConfigError(`no persisted session ${JSON.stringify(sessionId)}`);
          path = match.path;
        }
        command.path = path;
      }
      event = await session.transport.request(command, "session", { timeoutMs: this.requestTimeoutMs });
    } catch (error) {
      await session.close();
      const index = this.sessions.indexOf(session);
      if (index >= 0) this.sessions.splice(index, 1);
      if (error instanceof DGCCommandRejectedError) {
        throw new DGCConfigError(`could not resume ${target}: ${error.message}`, { cause: error });
      }
      if (error instanceof DGCError) throw error;
      throw publicError(error, `could not resume ${target}`);
    }
    session.sessionId = String(event.session_id || options.sessionId || session.sessionId);
    session.sessionPath = String(event.path || path || session.sessionPath);
    await session.discardIdle();
    try { await session.bindIdentity(); } catch { /* keeps the path DGC reported */ }
    return session;
  }

  /**
   * Usage recorded under this client's stateDir (never the host ~/.dgc): runs, token totals over
   * runs whose provider reported usage, `unknownUsageRuns` for the rest, cost, per department.
   */
  usageReport(department?: string): UsageReport {
    return this.usageLog.query({ department });
  }

  /** Audit rows (redacted unless `redact: false`), for one session or all. */
  exportAudit(sessionId?: string, options: { redact?: boolean } = {}): Array<Record<string, unknown>> {
    return this.auditLog.export(sessionId, options.redact ?? true);
  }

  async close(): Promise<void> {
    this.closed = true;
    const closing: Array<Promise<void>> = [];
    while (this.sessions.length) {
      const session = this.sessions.pop();
      if (session) closing.push(session.close());
    }
    await Promise.all(closing);
    if (this.ownsStateDir) {
      // A stateDir the SDK created holds only this client's throwaway HOME, usage and audit logs;
      // remove it so nothing (the audit rows included) is left on disk.
      this.ownsStateDir = false;
      try { rmSync(this.stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}
