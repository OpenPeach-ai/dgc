import { appendFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Transport } from "./transport.ts";
import { assertSupported, extractJson, validate as validateSchema } from "./schema.ts";
import type { ToolHub } from "./tools.ts";
import type {
  Artifact, Checkpoint, PermissionAction, QuestionRequest, RunEvent, RunOptions, RunResult,
  RunStatus, SessionInfo, SessionOptions, ToolRecord,
} from "./types.ts";

const LOOPBACK = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/\S+/gi;
const IDLE = new Set([
  "history", "agents", "context", "goal_changed", "monitors", "info", "todos",
  "session", "session_named",
]);

function newId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 12)}`;
}

async function withDeadline<T>(work: Promise<T>, ms: number | undefined, fallback: T): Promise<T> {
  if (!ms || ms <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class Session {
  sessionId: string;
  sessionPath = "";
  readonly transport: Transport;
  private busy = false;
  private closed = false;
  private stopped = false;
  private readonly options: SessionOptions;
  private readonly unhandled: string;
  private readonly instructions: string;
  private readonly toolHub: ToolHub | null;
  private readonly stateDir: string;
  private readonly department: string;

  constructor(
    transport: Transport,
    sessionId: string,
    options: SessionOptions,
    unhandled: string,
    instructions: string,
    toolHub: ToolHub | null = null,
    stateDir = "",
    department = "",
  ) {
    this.transport = transport;
    this.sessionId = sessionId;
    this.options = options;
    this.unhandled = unhandled;
    this.instructions = instructions;
    this.toolHub = toolHub;
    this.stateDir = stateDir;
    this.department = department;
  }

  async run(prompt: string, runOptions?: RunOptions): Promise<RunResult> {
    const handle = this.stream(prompt, runOptions);
    for await (const _event of handle) { /* drain */ }
    return handle.result();
  }

  stream(prompt: string, runOptions?: RunOptions): AsyncIterable<RunEvent> & {
    result: () => Promise<RunResult>;
    cancel: () => void;
  } {
    if (this.closed) throw new Error("this session is closed");
    if (!prompt || !prompt.trim()) throw new Error("prompt must be a non-empty string");
    if (this.busy) throw new Error("this session already has an active run");
    this.stopped = false;
    if (runOptions?.outputSchema) assertSupported(runOptions.outputSchema);
    this.busy = true;
    const runId = newId("run");
    const timeoutMs = runOptions?.timeoutMs ?? 180_000;
    let settled: RunResult | null = null;
    const iterator = this.pump(prompt.trim(), runId, timeoutMs, runOptions);
    const primed = iterator.next();
    const wrapped = {
      async *[Symbol.asyncIterator]() {
        try {
          const first = await primed;
          if (!first.done && first.value) {
            if (first.value.type === "__result") {
              settled = first.value.data as unknown as RunResult;
            } else {
              yield first.value;
            }
          }
          for await (const event of iterator) {
            if (event.type === "__result") {
              settled = event.data as unknown as RunResult;
              continue;
            }
            yield event;
          }
        } finally {
          /* pump clears busy */
        }
      },
      result: async () => {
        if (!settled) {
          for await (const event of wrapped) { void event; }
        }
        if (!settled) throw new Error("run ended without a result");
        return settled;
      },
      cancel: () => {
        try { this.transport.send({ type: "cancel" }); } catch { /* */ }
      },
    };
    return wrapped;
  }

  cancel(): void {
    this.stopped = true;
    try { this.transport.send({ type: "cancel" }); } catch { /* */ }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.toolHub?.close();
    this.transport.close();
  }

  async listSessions(): Promise<SessionInfo[]> {
    const event = await this.transport.request(
      { type: "list_sessions", request_id: newId("sessions") }, "sessions");
    return rowsToSessions(event.items);
  }

  async listCheckpoints(): Promise<Checkpoint[]> {
    const event = await this.transport.request(
      { type: "list_checkpoints", request_id: newId("ck") }, "checkpoints");
    const items: Checkpoint[] = [];
    for (const row of Array.isArray(event.items) ? event.items : []) {
      const item = row as Record<string, unknown>;
      items.push({
        index: Number(item.index || 0),
        preview: String(item.preview || ""),
        files: Number(item.files || 0),
      });
    }
    return items;
  }

  async rewind(index: number): Promise<Record<string, unknown>> {
    const event = await this.transport.request(
      { type: "rewind", index, request_id: newId("rw") }, "rewound");
    await this.discardIdle();
    return event;
  }

  async fork(name?: string): Promise<Record<string, unknown>> {
    const command: Record<string, unknown> = { type: "fork_session", request_id: newId("fork") };
    if (name) command.name = name;
    const event = await this.transport.request(command, "session");
    this.sessionId = String(event.session_id || this.sessionId);
    this.sessionPath = String(event.path || this.sessionPath);
    await this.discardIdle();
    return event;
  }

  async history(): Promise<Record<string, unknown>> {
    return this.transport.request({ type: "get_history", request_id: newId("hist") }, "history");
  }

  async listSkills(): Promise<Array<{ name: string; description: string; source: string; enabled: boolean }>> {
    const event = await this.transport.request(
      { type: "list_skills", request_id: newId("skills") }, "skill_catalog");
    return (Array.isArray(event.items) ? event.items : []).map((row) => {
      const item = row as Record<string, unknown>;
      return {
        name: String(item.name || ""),
        description: String(item.description || ""),
        source: String(item.source || ""),
        enabled: item.enabled !== false,
      };
    });
  }

  async getGoal(): Promise<Record<string, unknown>> {
    return this.transport.request({ type: "get_goal", request_id: newId("goal") }, "goal_changed");
  }

  async setGoal(text: string, status = "active"): Promise<Record<string, unknown>> {
    return this.transport.request(
      { type: "set_goal", text, status, request_id: newId("setgoal") }, "goal_changed");
  }

  async listMonitors(): Promise<unknown[]> {
    const event = await this.transport.request(
      { type: "list_monitors", request_id: newId("mon") }, "monitors");
    return Array.isArray(event.items) ? event.items : [];
  }

  async listHooks(): Promise<Record<string, unknown>> {
    return this.transport.request({ type: "list_hooks", request_id: newId("hooks") }, "hook_catalog");
  }

  async getMemory(): Promise<Record<string, unknown>> {
    return this.transport.request({ type: "get_memory", request_id: newId("mem") }, "memory");
  }

  async addMemory(text: string, scope: "project" | "user" = "project"): Promise<Record<string, unknown>> {
    return this.transport.request(
      { type: "add_memory", text, scope, request_id: newId("addmem") }, "memory");
  }

  async listPermissions(): Promise<Array<{ action: string; rule: string }>> {
    const event = await this.transport.request(
      { type: "list_permissions", request_id: newId("perms") }, "permissions");
    return (Array.isArray(event.items) ? event.items : []).map((row) => {
      const item = row as Record<string, unknown>;
      return { action: String(item.action || ""), rule: String(item.rule || "") };
    });
  }

  async addPermissionRule(action: "allow" | "ask" | "deny", rule: string): Promise<unknown> {
    return this.transport.request(
      { type: "add_permission_rule", action, rule, request_id: newId("addperm") }, "permissions");
  }

  async listMcpServers(): Promise<unknown[]> {
    const event = await this.transport.request(
      { type: "list_mcp_servers", request_id: newId("mcp") }, "mcp_servers");
    return Array.isArray(event.items) ? event.items : [];
  }

  async removePermissionRule(action: "allow" | "ask" | "deny", rule: string): Promise<unknown> {
    return this.transport.request(
      { type: "remove_permission_rule", action, rule, request_id: newId("rmperm") }, "permissions");
  }

  async getSkill(name: string): Promise<Record<string, unknown>> {
    return this.transport.request(
      { type: "get_skill", name, request_id: newId("skill") }, "skill_detail");
  }

  async setSkillEnabled(name: string, enabled: boolean): Promise<unknown> {
    return this.transport.request(
      { type: "set_skill_enabled", name, enabled, request_id: newId("sken") }, "skill_catalog");
  }

  async stopMonitor(id = "all"): Promise<unknown[]> {
    const event = await this.transport.request(
      { type: "stop_monitor", id, request_id: newId("stopmon") }, "monitors");
    return Array.isArray(event.items) ? event.items : [];
  }

  async listArtifacts(): Promise<Artifact[]> {
    const event = await this.transport.request(
      { type: "list_artifacts", request_id: newId("arts") }, "artifacts");
    return (Array.isArray(event.items) ? event.items : []).map((row) => {
      const item = row as Record<string, unknown>;
      return {
        id: String(item.id || ""),
        name: String(item.name || ""),
        url: String(item.url || ""),
        rel: String(item.rel || item.path || ""),
      };
    });
  }

  async listAgents(): Promise<unknown[]> {
    const event = await this.transport.request(
      { type: "list_agents", request_id: newId("agents") }, "agents");
    return Array.isArray(event.items) ? event.items : [];
  }

  async getPlan(): Promise<Record<string, unknown>> {
    return this.transport.request({ type: "get_plan", request_id: newId("plan") }, "saved_plan");
  }

  async getConfig(): Promise<Record<string, unknown>> {
    return this.transport.request({ type: "get_config", request_id: newId("cfgget") }, "config");
  }

  async getUsage(range = "today"): Promise<Record<string, unknown>> {
    return this.transport.request(
      { type: "get_usage", range, request_id: newId("usage") }, "usage_report");
  }

  async newSession(): Promise<Record<string, unknown>> {
    const event = await this.transport.request(
      { type: "new_session", request_id: newId("new") }, "session");
    this.sessionId = String(event.session_id || this.sessionId);
    await this.discardIdle();
    return event;
  }

  async nameSession(name: string): Promise<Record<string, unknown>> {
    return this.transport.request(
      { type: "name_session", name, request_id: newId("name") }, "session_named");
  }

  async deleteSession(path: string): Promise<SessionInfo[]> {
    const event = await this.transport.request(
      { type: "delete_session", path, request_id: newId("del") }, "sessions");
    return rowsToSessions(event.items);
  }

  async generateHandoff(save = false): Promise<Record<string, unknown>> {
    return this.transport.request(
      { type: "generate_handoff", save, request_id: newId("handoff") }, "handoff", 60_000);
  }

  steer(text: string): void {
    if (!text.trim()) throw new Error("steer text must be a non-empty string");
    this.transport.send({
      type: "prompt", text: text.trim(), delivery: "steer", request_id: newId("steer"),
    });
  }

  followup(text: string): void {
    if (!text.trim()) throw new Error("followup text must be a non-empty string");
    this.transport.send({
      type: "prompt", text: text.trim(), delivery: "queue", request_id: newId("follow"),
    });
  }

  async discardIdle(timeoutMs = 250): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const event = await this.transport.next(Math.min(50, deadline - Date.now()));
        if (!IDLE.has(String(event.type || ""))) {
          this.transport.unread(event);
          return;
        }
      } catch {
        return;
      }
    }
  }

  private async *pump(
    prompt: string, runId: string, timeoutMs: number, runOptions?: RunOptions,
  ): AsyncGenerator<RunEvent> {
    const result: RunResult = {
      sessionId: this.sessionId, runId, status: "running", reason: "", finalText: "",
      usage: {}, tools: [], artifacts: [], documents: [],
    };
    try {
      yield* this.runOnce(prompt, result, timeoutMs, runOptions?.maxTurns, false, runOptions);
      const schema = runOptions?.outputSchema;
      if (schema && result.status === "completed") {
        this.applySchema(result, schema);
        let attempts = Math.max(0, runOptions?.repairAttempts ?? 1);
        while (result.output === undefined && attempts > 0 && result.status === "completed") {
          attempts -= 1;
          const previous = result.error || "the last answer was not valid JSON";
          result.status = "running";
          result.error = undefined;
          const repair = (
            "Return only valid JSON matching this schema. Do not call tools. "
            + "Do not edit files.\n"
            + JSON.stringify(schema)
            + `\nPrevious errors: ${previous}`
          );
          yield* this.runOnce(repair, result, timeoutMs, 1, true);
          // runOnce mutates result; re-read the status instead of the narrowed "running".
          if ((result as RunResult).status === "completed") this.applySchema(result, schema);
        }
      }
      this.recordUsage(result);
      yield { type: "__result", data: result as unknown as Record<string, unknown>, runId, sessionId: this.sessionId };
    } finally {
      this.busy = false;
    }
  }

  private applySchema(result: RunResult, schema: Record<string, unknown>): void {
    try {
      const parsed = extractJson(result.finalText);
      const problems = validateSchema(parsed, schema);
      if (problems.length) {
        result.error = "output_schema: " + problems.slice(0, 8).join("; ");
        result.output = undefined;
        return;
      }
      result.output = parsed;
      result.error = undefined;
    } catch (error) {
      result.error = `output_schema: ${error instanceof Error ? error.message : String(error)}`;
      result.output = undefined;
    }
  }

  private async *runOnce(
    prompt: string,
    result: RunResult,
    timeoutMs: number,
    maxTurns: number | undefined,
    repairing: boolean,
    runOptions?: RunOptions,
  ): AsyncGenerator<RunEvent> {
    const requestId = newId("req");
    const chunks: string[] = [];
    const blocks = new Map<string, string>();
    const answerIds: string[] = [];
    const tools = new Map<string, ToolRecord>();
    const artifacts: Artifact[] = [...result.artifacts];
    const documents: Artifact[] = [...result.documents];
    const usage: Record<string, unknown> = { ...result.usage };
    if (typeof maxTurns === "number") {
      this.transport.send({ type: "set_config", values: { max_turns: maxTurns }, request_id: `cfg-${result.runId}` });
    }
    const composed = (!repairing && this.instructions)
      ? `<application-instructions>\n${this.instructions}\n</application-instructions>\n\n${prompt}`
      : prompt;
    const payload: Record<string, unknown> = { type: "prompt", text: composed, request_id: requestId };
    if (!repairing && runOptions?.skills) payload.skills = runOptions.skills;
    if (!repairing && runOptions?.workflow) payload.workflow = runOptions.workflow;
    this.transport.send(payload);
      const deadline = Date.now() + timeoutMs;
      let status: RunStatus = "running";
      let reason = "";
      let error: string | undefined;
      let finalText = "";
      let liveTurnId = "";
      while (Date.now() < deadline) {
        const event = await this.transport.next(Math.max(50, deadline - Date.now()));
        const type = String(event.type || "");
        if (["turn_start", "turn_end", "tool_call", "tool_denied", "permission_request"].includes(type)) {
          this.recordAudit(result.runId, type, event);
        }
        yield { type, data: event, runId: result.runId, sessionId: this.sessionId };
        if (type === "turn_start") {
          const turnId = String(event.turn_id || "");
          const rid = event.request_id;
          if (turnId && (rid === requestId || !liveTurnId)) liveTurnId = turnId;
        }
        if (type === "permission_request") {
          status = "waiting_for_approval";
          let decision: PermissionAction = "deny";
          if (this.stopped || repairing) {
            decision = "deny";
          } else if (this.options.onPermission) {
            try {
              decision = await withDeadline(Promise.resolve(this.options.onPermission({
                id: String(event.id),
                name: String(event.name),
                args: (event.args as Record<string, unknown>) || {},
                summary: event.summary ? String(event.summary) : undefined,
                suggestedRule: event.suggested_rule ? String(event.suggested_rule) : undefined,
                callId: event.call_id ? String(event.call_id) : undefined,
                diff: event.diff ? String(event.diff) : undefined,
              })), this.options.decisionTimeoutMs ?? 30_000, "deny");
            } catch {
              decision = "deny";
            }
          }
          this.transport.send({ type: "permission_response", id: event.id, decision });
          status = "running";
        } else if (type === "plan_proposal") {
          let decision = "reject";
          if (this.options.onPlan) {
            try {
              decision = await this.options.onPlan({
                id: String(event.id),
                plan: String(event.plan || ""),
                choices: Array.isArray(event.choices) ? event.choices.map(String) : [],
              });
            } catch {
              decision = "reject";
            }
          }
          this.transport.send({ type: "plan_response", id: event.id, decision });
        } else if (type === "options_request") {
          if (!this.options.onQuestion) {
            this.transport.send({ type: "options_response", id: event.id, dismissed: true });
          } else {
            const questions = Array.isArray(event.questions) ? event.questions as QuestionRequest["questions"] : [];
            const answer = await this.options.onQuestion({
              id: String(event.id),
              questions,
              callId: event.call_id ? String(event.call_id) : undefined,
            });
            if (answer === "dismiss") {
              this.transport.send({ type: "options_response", id: event.id, dismissed: true });
            } else {
              this.transport.send({ type: "options_response", id: event.id, answers: answer });
            }
          }
        } else if (type === "mcp_input_request") {
          let action = "cancel";
          let content: Record<string, unknown> | undefined;
          if (this.options.onMcpInput) {
            try {
              const response = await this.options.onMcpInput({
                id: String(event.id),
                server: String(event.server || ""),
                kind: String(event.kind || ""),
                payload: (event.payload as Record<string, unknown>) || {},
              });
              action = response.action;
              content = response.content;
            } catch {
              action = "cancel";
            }
          }
          const payload: Record<string, unknown> = {
            type: "mcp_input_response", id: event.id, action,
          };
          if (content) payload.content = content;
          this.transport.send(payload);
        } else if (type === "text_delta") {
          chunks.push(String(event.text || ""));
        } else if (type === "stream_end") {
          const messageId = String(event.message_id || "");
          const block = chunks.join("");
          chunks.length = 0;
          if (messageId) {
            blocks.set(messageId, block);
            if (event.phase === "answer") answerIds.push(messageId);
          }
        } else if (type === "tool_call") {
          const callId = String(event.call_id || "");
          tools.set(callId, { name: String(event.name || ""), callId, summary: String(event.summary || "") });
        } else if (type === "tool_result") {
          const callId = String(event.call_id || "");
          const output = String(event.output || "");
          tools.set(callId, {
            name: String(event.name || tools.get(callId)?.name || ""),
            callId,
            output,
            isError: Boolean(event.is_error),
          });
          if (String(event.name || "") === "present_document") {
            const urls = output.match(LOOPBACK) || [];
            urls.forEach((url, index) => {
              documents.push({ id: `${callId}-${index}`, name: index === 0 ? "document" : "document.md", url });
            });
          }
        } else if (type === "artifact_ready") {
          const art = { id: String(event.id), name: String(event.name || ""), url: String(event.url || ""), rel: String(event.rel || "") };
          artifacts.push(art);
          if (art.url.startsWith("http://127.0.0.1") || art.url.startsWith("http://localhost")) documents.push(art);
        } else if (type === "context") {
          if (typeof event.used === "number") usage.context_used = event.used;
          if (typeof event.size === "number") usage.context_size = event.size;
        } else if (type === "turn_end") {
          const turnId = String(event.turn_id || "");
          if (liveTurnId && turnId && turnId !== liveTurnId) continue;
          if (!liveTurnId) continue;
          reason = String(event.reason || "completed");
          const finalId = typeof event.final_message_id === "string" ? event.final_message_id : "";
          finalText = (finalId && blocks.get(finalId))
            || (answerIds.length ? blocks.get(answerIds[answerIds.length - 1]) : "")
            || [...blocks.values()].join("")
            || chunks.join("");
          if (typeof event.token_estimate === "number") usage.token_estimate = event.token_estimate;
          status = reason === "cancelled" || reason === "interrupted"
            ? "cancelled"
            : reason === "error" || reason === "failed" ? "failed" : "completed";
          break;
        } else if (type === "error" && event.fatal) {
          status = "failed";
          reason = "runtime";
          error = String(event.message || "fatal");
          finalText = chunks.join("");
          break;
        }
      }
      if (!reason) {
        try { this.transport.send({ type: "cancel" }); } catch { /* */ }
        status = "failed";
        reason = "timeout";
        error = "run exceeded timeoutMs";
        finalText = chunks.join("");
      }
      result.status = status;
      result.reason = reason;
      result.finalText = finalText;
      result.partialText = status === "completed" ? undefined : finalText;
      result.usage = usage;
      result.tools = [...tools.values()];
      result.artifacts = artifacts;
      result.documents = documents;
      result.error = error;
  }

  private recordUsage(result: RunResult): void {
    if (!this.stateDir) return;
    const dir = join(this.stateDir, "usage");
    mkdirSync(dir, { recursive: true });
    const estimate = Number(result.usage.token_estimate || 0);
    const row = {
      ts: Date.now() / 1000,
      session_id: result.sessionId || this.sessionId,
      run_id: result.runId,
      department: this.department,
      status: result.status,
      token_estimate: estimate,
      input_tokens: Number(result.usage.input_tokens || estimate || 0),
      output_tokens: Number(result.usage.output_tokens || 0),
    };
    appendFileSync(join(dir, "usage.jsonl"), JSON.stringify(row) + "\n");
  }

  private recordAudit(runId: string, kind: string, event: Record<string, unknown>): void {
    if (!this.stateDir) return;
    const dir = join(this.stateDir, "audit");
    mkdirSync(dir, { recursive: true });
    const stem = (this.sessionId || "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
    const file = join(dir, (stem || "unknown") + ".jsonl");
    const row = {
      ts: Date.now() / 1000,
      session_id: this.sessionId,
      run_id: runId,
      type: kind,
      payload: { name: event.name, id: event.id, reason: event.reason },
    };
    appendFileSync(file, JSON.stringify(row) + "\n");
  }
}

export function rowsToSessions(raw: unknown): SessionInfo[] {
  const items: SessionInfo[] = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    const item = row as Record<string, unknown>;
    const path = String(item.path || "");
    items.push({
      id: path ? basename(path).replace(/\.json$/, "") : "",
      path,
      name: String(item.name || ""),
      preview: String(item.preview || ""),
      messageCount: Number(item.count || 0),
      when: String(item.when || ""),
    });
  }
  return items;
}
