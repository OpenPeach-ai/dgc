/** Explicit Pips controls. Independent workers never inherit a foreground policy. */
import { randomUUID } from "node:crypto";
import { DGCCommandRejectedError, DGCConfigError, DGCProtocolError, DGCUnsupportedError } from "./errors.ts";
import type { Frame } from "./transport.ts";

export type PipCalendarEvent = { summary: string; description: string; start_datetime: string; end_datetime: string; timezone: string } & (
  { attendees?: never; repeat?: never; send_invitations?: never } |
  { attendees: string[]; repeat: null | { frequency: "daily" | "weekly" | "monthly"; interval: number; count: number }; send_invitations: boolean }
);

export type PipJson = null | boolean | number | string | PipJson[] | { [key: string]: PipJson };
export type PipResult = Record<string, PipJson>;
/** One read-only reply's inference choices; does not change the job or permissions. Requires API24; contexts above32768 require API25. */
export type PipChatOptions = { context_size: number; thinking: "off" | "low" | "medium" | "high" | "xhigh" };
export type SessionOutcomeSource = { kind: "commit"; revision: string } | { kind: "pip_run"; run_id: string };
export type PipReadParams = {
  get_pip_connector_draft: { draft_id: string };
  list_pip_connector_drafts: { pip_id: string; before_id?: string; limit?: number };
  get_pip_calendar_draft: { draft_id: string };
  list_pip_calendar_drafts: { pip_id: string; before_id?: string; limit?: number };
  get_pip_message_draft: { draft_id: string };
  list_pip_message_drafts: { pip_id: string; before_id?: string; limit?: number };
  inspect_pip_connector_actions: { server: string };
  inspect_pip_calendar_connection: { server: string };
  inspect_pip_send_connection: { server: string };
  get_pip_app_action: { action_id: string };
  list_pip_app_actions: { pip_id: string; before_id?: string; limit?: number };
  list_pip_connections: { [key: string]: never };
  inspect_pip_connection: { server: string };
  list_pip_accounts: { server: string };
  list_pip_setups: { workspace_id: string };
  get_pip_setup: { setup_id: string };
  get_pip_statement_anchor: { pip_id: string; source_run_id?: string };
  list_pip_statements: { pip_id: string; before_id?: number; limit?: number };
  get_pip_exception_source: { pip_id: string; run_id: string; finding_index: number };
  list_pip_memories: { pip_id: string; before_id?: number; limit?: number };
  list_pip_notifications: { workspace_id?: string; before_seq?: number; limit?: number };
  list_workspace_sessions: { workspace_id: string; after?: string; limit?: number };
  inspect_workspace_session_outcome: { workspace_id: string; session_id: string };
  get_workspace_session_outcome: { workspace_id: string; proposal_id: string };
  list_workspace_session_outcomes: { workspace_id: string; before_id?: number; limit?: number };
  list_workspace_execution_receipts: { workspace_id: string; session_id?: string; before_id?: string; limit?: number };
  get_workspace_execution_receipt: { workspace_id: string; attempt_id: string };
  get_pip_proposal: { pip_id: string; proposal_id: string };
  list_workspace_overviews: { after_id?: string; limit?: number };
  list_pending_pip_reviews: { workspace_id?: string; before_id?: string; limit?: number };
  list_recent_workspace_activity: { workspace_id?: string; before_seq?: number; limit?: number };
  list_pip_adaptations: { pip_id: string; before_id?: string; limit?: number };
  get_pip: { pip_id: string };
  get_pip_execution: { [key: string]: never };
  get_pip_handoff: { handoff_id: string };
  get_pip_run: { run_id: string };
  get_pip_runner: { [key: string]: never };
  get_workspace_context: { workspace_id: string };
  list_pip_approvals: { before_id?: string; limit?: number; pip_id: string };
  list_pip_checkpoints: { before_id?: number; limit?: number; pip_id: string };
  list_pip_handoffs: { before_id?: string; limit?: number; pip_id: string };
  list_pip_messages: { before_id?: string; limit?: number; pip_id: string };
  list_pip_models: { [key: string]: never };
  list_pip_run_activity: { after?: number; run_id: string };
  list_pip_runs: { pip_id: string };
  list_pip_types: { [key: string]: never };
  list_pip_versions: { before_version?: number; limit?: number; pip_id: string };
  list_pips: { workspace_id: string };
  list_workspace_activity: { after?: number; workspace_id: string };
  list_workspaces: { [key: string]: never };
};
export type PipMutationParams = {
  prepare_pip_calendar_draft: { draft_id: string; expected_digest: string; server: string; connection_digest: string; account: string; schema_digest: string; event: PipCalendarEvent };
  prepare_pip_connector_draft: { draft_id: string; expected_digest: string; call?: { tool: string; arguments: Record<string, unknown> } };
  dismiss_pip_connector_draft: { draft_id: string; expected_digest: string };
  dismiss_pip_calendar_draft: { draft_id: string; expected_digest: string };
  prepare_pip_message_draft: { draft_id: string; expected_digest: string; server: string; connection_digest: string; account: string; schema_digest: string; message: { recipient_email: string; subject: string; body: string } };
  dismiss_pip_message_draft: { draft_id: string; expected_digest: string };
  propose_pip_connector_action: { source_run_id: string; server: string; connection_digest: string; schema_digest: string; call: { tool: string; arguments: Record<string, unknown> }; request_key: string };
  propose_pip_calendar_action: { source_run_id: string; server: string; connection_digest: string; account: string; schema_digest: string; event: PipCalendarEvent; request_key: string };
  propose_pip_app_action: { source_run_id: string; server: string; connection_digest: string; account: string; schema_digest: string; message: { recipient_email: string; subject: string; body: string }; request_key: string };
  accept_pip_app_action: { action_id: string; expected_digest: string };
  reject_pip_app_action: { action_id: string; expected_digest: string };
  revise_pip_setup: { setup_id: string; expected_digest: string; model_choice: { mode: "default" } | { mode: "model"; model: string } };
  accept_pip_setup: { setup_id: string; expected_digest: string };
  reject_pip_setup: { setup_id: string; expected_digest: string };
  record_pip_statement: { pip_id: string; kind: "fact" | "preference"; title: string; statement: string; reason: string; expires_at: string | null; expected_anchor_digest: string; request_key: string; source_run_id?: string };
  revoke_pip_statement: { pip_id: string; memory_id: string; expected_revision: number; reason: string };
  archive_pip: { pip_id: string; expected_version: number; expected_lifecycle_revision: number; request_key: string; reason: string };
  restore_pip: { pip_id: string; expected_version: number; expected_lifecycle_revision: number; request_key: string; reason: string };
  record_pip_exception: { pip_id: string; run_id: string; finding_index: number; expected_source_digest: string; reason: string; expires_at?: string | null; request_key: string };
  revoke_pip_exception: { pip_id: string; memory_id: string; expected_revision: number; reason: string };
  mark_pip_notification_read: { workspace_id?: string; notification_id: string; expected_revision: number };
  propose_workspace_session_outcome: { workspace_id: string; session_id: string; title: string; statement: string; source: SessionOutcomeSource; expected_session_revision: number; request_key: string };
  accept_workspace_session_outcome: { workspace_id: string; proposal_id: string; expected_digest: string; expected_context_revision: number };
  record_workspace_execution_context: { workspace_id: string; attempt_id: string; expected_attempt_digest: string; expected_final_digest: string; expected_view_digest: string; expected_context_revision: number };
  reject_workspace_session_outcome: { workspace_id: string; proposal_id: string; expected_digest: string };
  accept_pip_execution_context: { expected_review_revision: number; expected_revision: number; run_id: string; workspace_id: string };
  accept_pip_finding: { expected_revision: number; finding_index: number; run_id: string; workspace_id: string };
  accept_pip_handoff: { expected_revision: number; handoff_id: string };
  accept_pip_update: { expected_version: number; pip_id: string; proposal_id: string };
  archive_workspace_context: { entry_id: string; expected_revision: number; workspace_id: string };
  cancel_pip_run: { run_id: string };
  create_pip: { goal: string; model_choice?: Record<string, PipJson>; name: string; pip_type?: string; source_ref?: string; workspace_id: string };
  pause_pip: { pip_id: string; expected_lifecycle_revision?: number };
  propose_pip_personal_handoff: { source_run_id: string; target_pip_id: string; shared_text: string; task: string; idempotency_key: string };
  propose_pip_artifact_handoff: { action: Record<string, PipJson>; idempotency_key: string; source_run_id: string; target_pip_id: string; task: string };
  propose_pip_handoff: { action: Record<string, PipJson>; finding_index: number; idempotency_key: string; source_run_id: string; target_pip_id: string; task: string };
  propose_pip_update: { changes: Record<string, PipJson>; expected_version: number; pip_id: string; reason: string };
  record_workspace_context: { content: string; expected_revision: number; kind: string; title: string; workspace_id: string };
  reject_pip_handoff: { expected_revision: number; handoff_id: string; reason: string };
  reject_pip_update: { expected_version: number; pip_id: string; proposal_id: string };
  resume_pip: { pip_id: string; expected_lifecycle_revision?: number };
  review_pip_execution: { expected_revision: number; reason: string; run_id: string; status: string };
  review_pip_finding: { expected_revision: number; finding_index: number; reason: string; run_id: string; status: string };
  run_pip: { idempotency_key: string; pip_id: string; expected_version?: number; expected_lifecycle_revision?: number; expected_plan_digest?: string };
  send_pip_message: { idempotency_key: string; pip_id: string; text: string; chat_options?: PipChatOptions };
  stop_pips: { [key: string]: never };
};
export type PipReadCommand = keyof PipReadParams;
export type PipMutationCommand = keyof PipMutationParams;
export const COMMAND_FIELDS: Readonly<Record<string, readonly string[]>> = {
  get_pip_connector_draft: ["draft_id"],
  list_pip_connector_drafts: ["pip_id", "before_id", "limit"],
  prepare_pip_connector_draft: ["draft_id", "expected_digest", "call"],
  dismiss_pip_connector_draft: ["draft_id", "expected_digest"],
  get_pip_calendar_draft: ["draft_id"],
  list_pip_calendar_drafts: ["pip_id", "before_id", "limit"],
  prepare_pip_calendar_draft: ["draft_id", "expected_digest", "server", "connection_digest", "account", "schema_digest", "event"],
  dismiss_pip_calendar_draft: ["draft_id", "expected_digest"],
  get_pip_message_draft: ["draft_id"],
  list_pip_message_drafts: ["pip_id", "before_id", "limit"],
  prepare_pip_message_draft: ["draft_id", "expected_digest", "server", "connection_digest", "account", "schema_digest", "message"],
  dismiss_pip_message_draft: ["draft_id", "expected_digest"],
  inspect_pip_connector_actions: ["server"],
  propose_pip_connector_action: ["source_run_id", "server", "connection_digest", "schema_digest", "call", "request_key"],
  inspect_pip_calendar_connection: ["server"],
  propose_pip_calendar_action: ["source_run_id", "server", "connection_digest", "account", "schema_digest", "event", "request_key"],
  inspect_pip_send_connection: ["server"],
  propose_pip_app_action: ["source_run_id", "server", "connection_digest", "account", "schema_digest", "message", "request_key"],
  get_pip_app_action: ["action_id"],
  list_pip_app_actions: ["pip_id", "before_id", "limit"],
  accept_pip_app_action: ["action_id", "expected_digest"],
  reject_pip_app_action: ["action_id", "expected_digest"],
  list_pip_connections: [],
  inspect_pip_connection: ["server"],
  propose_pip_personal_handoff: ["source_run_id", "target_pip_id", "shared_text", "task", "idempotency_key"],
  list_pip_accounts: ["server"],
  "revise_pip_setup": ["setup_id", "expected_digest", "model_choice"],
  "list_pip_setups": ["workspace_id"],
  "get_pip_setup": ["setup_id"],
  "accept_pip_setup": ["setup_id", "expected_digest"],
  "reject_pip_setup": ["setup_id", "expected_digest"],
  "get_pip_statement_anchor": ["pip_id", "source_run_id"],
  "list_pip_statements": ["pip_id", "before_id", "limit"],
  "record_pip_statement": ["pip_id", "kind", "title", "statement", "reason", "expires_at", "expected_anchor_digest", "request_key", "source_run_id"],
  "revoke_pip_statement": ["pip_id", "memory_id", "expected_revision", "reason"],
  "archive_pip": ["pip_id", "expected_version", "expected_lifecycle_revision", "request_key", "reason"],
  "restore_pip": ["pip_id", "expected_version", "expected_lifecycle_revision", "request_key", "reason"],
  "get_pip_exception_source": ["pip_id", "run_id", "finding_index"],
  "list_pip_memories": ["pip_id", "before_id", "limit"],
  "record_pip_exception": ["pip_id", "run_id", "finding_index", "expected_source_digest", "reason", "expires_at", "request_key"],
  "revoke_pip_exception": ["pip_id", "memory_id", "expected_revision", "reason"],
  "list_pip_notifications": ["workspace_id", "before_seq", "limit"],
  "mark_pip_notification_read": ["workspace_id", "notification_id", "expected_revision"],
  "list_workspace_sessions": ["workspace_id", "after", "limit"],
  "inspect_workspace_session_outcome": ["workspace_id", "session_id"],
  "propose_workspace_session_outcome": ["workspace_id", "session_id", "title", "statement", "source", "expected_session_revision", "request_key"],
  "get_workspace_session_outcome": ["workspace_id", "proposal_id"],
  "list_workspace_session_outcomes": ["workspace_id", "before_id", "limit"],
  "list_workspace_execution_receipts": ["workspace_id", "session_id", "before_id", "limit"],
  "get_workspace_execution_receipt": ["workspace_id", "attempt_id"],
  "record_workspace_execution_context": ["workspace_id", "attempt_id", "expected_attempt_digest", "expected_final_digest", "expected_view_digest", "expected_context_revision"],
  "accept_workspace_session_outcome": ["workspace_id", "proposal_id", "expected_digest", "expected_context_revision"],
  "reject_workspace_session_outcome": ["workspace_id", "proposal_id", "expected_digest"],
  "get_pip_proposal": ["pip_id", "proposal_id"],
  "list_workspace_overviews": ["after_id", "limit"],
  "list_pending_pip_reviews": ["before_id", "limit", "workspace_id"],
  "list_recent_workspace_activity": ["before_seq", "limit", "workspace_id"],
  "list_pip_adaptations": ["before_id", "limit", "pip_id"],

  "list_workspaces": [],
  "list_pips": [
    "workspace_id"
  ],
  "list_pip_types": [],
  "list_pip_models": [],
  "list_pip_messages": [
    "before_id",
    "limit",
    "pip_id"
  ],
  "send_pip_message": [
    "chat_options",
    "idempotency_key",
    "pip_id",
    "text"
  ],
  "create_pip": [
    "goal",
    "model_choice",
    "name",
    "pip_type",
    "source_ref",
    "workspace_id"
  ],
  "get_pip": [
    "pip_id"
  ],
  "propose_pip_update": [
    "changes",
    "expected_version",
    "pip_id",
    "reason"
  ],
  "accept_pip_update": [
    "expected_version",
    "pip_id",
    "proposal_id"
  ],
  "pause_pip": [
    "pip_id", "expected_lifecycle_revision"
  ],
  "resume_pip": [
    "pip_id", "expected_lifecycle_revision"
  ],
  "run_pip": [
    "idempotency_key",
    "pip_id", "expected_version", "expected_lifecycle_revision", "expected_plan_digest"
  ],
  "list_pip_runs": [
    "pip_id"
  ],
  "get_pip_run": [
    "run_id"
  ],
  "cancel_pip_run": [
    "run_id"
  ],
  "list_workspace_activity": [
    "after",
    "workspace_id"
  ],
  "list_pip_run_activity": [
    "after",
    "run_id"
  ],
  "reject_pip_update": [
    "expected_version",
    "pip_id",
    "proposal_id"
  ],
  "list_pip_versions": [
    "before_version",
    "limit",
    "pip_id"
  ],
  "get_workspace_context": [
    "workspace_id"
  ],
  "record_workspace_context": [
    "content",
    "expected_revision",
    "kind",
    "title",
    "workspace_id"
  ],
  "archive_workspace_context": [
    "entry_id",
    "expected_revision",
    "workspace_id"
  ],
  "accept_pip_finding": [
    "expected_revision",
    "finding_index",
    "run_id",
    "workspace_id"
  ],
  "get_pip_runner": [],
  "stop_pips": [],
  "list_pip_approvals": [
    "before_id",
    "limit",
    "pip_id"
  ],
  "list_pip_checkpoints": [
    "before_id",
    "limit",
    "pip_id"
  ],
  "review_pip_finding": [
    "expected_revision",
    "finding_index",
    "reason",
    "run_id",
    "status"
  ],
  "review_pip_execution": [
    "expected_revision",
    "reason",
    "run_id",
    "status"
  ],
  "get_pip_execution": [],
  "propose_pip_handoff": [
    "action",
    "finding_index",
    "idempotency_key",
    "source_run_id",
    "target_pip_id",
    "task"
  ],
  "propose_pip_artifact_handoff": [
    "action",
    "idempotency_key",
    "source_run_id",
    "target_pip_id",
    "task"
  ],
  "get_pip_handoff": [
    "handoff_id"
  ],
  "list_pip_handoffs": [
    "before_id",
    "limit",
    "pip_id"
  ],
  "accept_pip_handoff": [
    "expected_revision",
    "handoff_id"
  ],
  "reject_pip_handoff": [
    "expected_revision",
    "handoff_id",
    "reason"
  ],
  "accept_pip_execution_context": [
    "expected_review_revision",
    "expected_revision",
    "run_id",
    "workspace_id"
  ]
};
const READS = new Set<string>(["get_pip_proposal", "list_workspace_overviews", "list_pending_pip_reviews", "list_recent_workspace_activity", "list_pip_adaptations", "get_pip", "get_pip_execution", "get_pip_handoff", "get_pip_run", "get_pip_runner", "get_workspace_context", "list_pip_approvals", "list_pip_checkpoints", "list_pip_handoffs", "list_pip_messages", "list_pip_models", "list_pip_run_activity", "list_pip_runs", "list_pip_types", "list_pip_versions", "list_pips", "list_workspace_activity", "list_workspaces"]);
const MUTATIONS = new Set<string>(["propose_pip_personal_handoff", "accept_pip_execution_context", "accept_pip_finding", "accept_pip_handoff", "accept_pip_update", "archive_workspace_context", "cancel_pip_run", "create_pip", "pause_pip", "propose_pip_artifact_handoff", "propose_pip_handoff", "propose_pip_update", "record_workspace_context", "reject_pip_handoff", "reject_pip_update", "resume_pip", "review_pip_execution", "review_pip_finding", "run_pip", "send_pip_message", "stop_pips"]);
const API12_READS = ["list_workspace_sessions", "inspect_workspace_session_outcome", "get_workspace_session_outcome", "list_workspace_session_outcomes"];
const API12_MUTATIONS = ["propose_workspace_session_outcome", "accept_workspace_session_outcome", "reject_workspace_session_outcome"];
const API12_COMMANDS = new Set([...API12_READS, ...API12_MUTATIONS]);
for (const command of API12_READS) READS.add(command);
for (const command of API12_MUTATIONS) MUTATIONS.add(command);
const API13_COMMANDS = new Set(["list_pip_notifications", "mark_pip_notification_read"]);
READS.add("list_pip_notifications");
MUTATIONS.add("mark_pip_notification_read");
const API14_READS = ["get_pip_exception_source", "list_pip_memories"];
const API14_MUTATIONS = ["record_pip_exception", "revoke_pip_exception"];
const API14_COMMANDS = new Set([...API14_READS, ...API14_MUTATIONS]);
for (const command of API14_READS) READS.add(command);
for (const command of API14_MUTATIONS) MUTATIONS.add(command);
const API16_COMMANDS = new Set(["archive_pip", "restore_pip"]);
for (const command of API16_COMMANDS) MUTATIONS.add(command);
const API17_READS = ["list_workspace_execution_receipts", "get_workspace_execution_receipt"];
const API17_COMMANDS = new Set([...API17_READS, "record_workspace_execution_context"]);
for (const command of API17_READS) READS.add(command);
MUTATIONS.add("record_workspace_execution_context");
const API19_READS = ["get_pip_statement_anchor", "list_pip_statements"];
const API19_MUTATIONS = ["record_pip_statement", "revoke_pip_statement"];
const API19_COMMANDS = new Set([...API19_READS, ...API19_MUTATIONS]);
for (const command of API19_READS) READS.add(command);
for (const command of API19_MUTATIONS) MUTATIONS.add(command);
const API23_READS = ["list_pip_setups", "get_pip_setup"];
const API23_MUTATIONS = ["accept_pip_setup", "reject_pip_setup"];
const API23_COMMANDS = new Set([...API23_READS, ...API23_MUTATIONS]);
for (const command of API23_READS) READS.add(command);
for (const command of API23_MUTATIONS) MUTATIONS.add(command);
const API25_MUTATIONS = new Set(["revise_pip_setup"]);
for (const command of API25_MUTATIONS) MUTATIONS.add(command);
const API28_READS = new Set(["list_pip_connections", "inspect_pip_connection"]);
for (const command of API28_READS) READS.add(command);
READS.add("list_pip_accounts");
const API37_READS = new Set(["get_pip_connector_draft","list_pip_connector_drafts"]);
const API37_MUTATIONS = new Set(["prepare_pip_connector_draft","dismiss_pip_connector_draft"]);
for (const command of API37_READS) READS.add(command);
for (const command of API37_MUTATIONS) MUTATIONS.add(command);
const API36_READS = new Set(["inspect_pip_connector_actions"]);
const API36_MUTATIONS = new Set(["propose_pip_connector_action"]);
for (const command of API36_READS) READS.add(command);
for (const command of API36_MUTATIONS) MUTATIONS.add(command);
const API35_READS = new Set(["get_pip_calendar_draft","list_pip_calendar_drafts"]);
const API35_MUTATIONS = new Set(["prepare_pip_calendar_draft","dismiss_pip_calendar_draft"]);
for (const command of API35_READS) READS.add(command);
for (const command of API35_MUTATIONS) MUTATIONS.add(command);
const API34_READS = new Set(["inspect_pip_calendar_connection"]);
const API34_MUTATIONS = new Set(["propose_pip_calendar_action"]);
for (const command of API34_READS) READS.add(command);
for (const command of API34_MUTATIONS) MUTATIONS.add(command);
const API32_READS = new Set(["get_pip_message_draft","list_pip_message_drafts"]);
const API32_MUTATIONS = new Set(["prepare_pip_message_draft","dismiss_pip_message_draft"]);
for (const command of API32_READS) READS.add(command);
for (const command of API32_MUTATIONS) MUTATIONS.add(command);
const API31_READS = new Set(["inspect_pip_send_connection", "get_pip_app_action", "list_pip_app_actions"]);
const API31_MUTATIONS = new Set(["propose_pip_app_action", "accept_pip_app_action", "reject_pip_app_action"]);
for (const command of API31_READS) READS.add(command);
for (const command of API31_MUTATIONS) MUTATIONS.add(command);
const MAX_BYTES = 32768;

function detach(input: unknown): Record<string, PipJson> {
  let nodes = 0, budget = MAX_BYTES;
  const visit = (value: unknown, depth = 0): void => {
    if (++nodes > 2048 || depth > 12) throw new DGCConfigError("Pip parameters exceed the nesting or item limit");
    if (typeof value === "string") {
      if (value.length > MAX_BYTES || Buffer.from(value, "utf8").toString("utf8") !== value) throw new DGCConfigError("Pip strings exceed limits or contain invalid Unicode");
      budget -= Buffer.byteLength(value, "utf8");
    } else if (value === null || typeof value === "boolean") budget -= 5;
    else if (typeof value === "number" && Number.isFinite(value)) {
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new DGCConfigError("Pip integers must be safe JSON integers");
      budget -= 24;
    } else if (Array.isArray(value)) {
      if (value.length > 2048) throw new DGCConfigError("Pip parameters exceed the item limit");
      budget -= value.length + 2;
      for (const item of value) visit(item, depth + 1);
    } else if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      const keys = Reflect.ownKeys(value);
      if (keys.length > 128) throw new DGCConfigError("Pip parameters contain too many fields");
      budget -= keys.length * 3 + 2;
      for (const key of keys) {
        if (typeof key !== "string" || key.length > 128) throw new DGCConfigError("Pip parameter keys must be short strings");
        const prop = Object.getOwnPropertyDescriptor(value, key)!;
        if (!Object.hasOwn(prop, "value") || !prop.enumerable) throw new DGCConfigError("Pip parameters must contain plain JSON properties");
        visit(key, depth + 1); visit(prop.value, depth + 1);
      }
    } else throw new DGCConfigError("Pip parameters must contain only JSON values");
    if (budget < 0) throw new DGCConfigError("Pip parameters exceed 32 KiB");
  };
  if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new DGCConfigError("Pip parameters must be a plain object");
  }
  visit(input);
  return JSON.parse(JSON.stringify(input)) as Record<string, PipJson>;
}

export class Pips {
  private readonly caps: Record<string, unknown>;
  private readonly restricted: boolean;
  private readonly plan: boolean;
  private readonly isolated: boolean;
  private readonly send: (payload: Frame, response: string, requestId: string) => Promise<Frame>;

  /** @internal Obtain this accessor from Session.pips. */
  constructor(caps: Record<string, unknown>, restricted: boolean, plan: boolean,
    send: (payload: Frame, response: string, requestId: string) => Promise<Frame>, isolated = true) {
    this.caps = { ...caps }; this.restricted = restricted; this.plan = plan; this.send = send; this.isolated = isolated;
  }

  read<K extends PipReadCommand>(command: K, params: PipReadParams[K]): Promise<PipResult> {
    return this.call(command, params, false, false);
  }

  /** Host approval for exactly one mutation; never expose as an unattended model tool. */
  mutate<K extends PipMutationCommand>(command: K, params: PipMutationParams[K],
    options: { approved: boolean } = { approved: false }): Promise<PipResult> {
    return this.call(command, params, true, options.approved === true);
  }

  private async call(command: string, params: unknown, mutation: boolean, approved: boolean): Promise<PipResult> {
    if (!(mutation ? MUTATIONS : READS).has(command)) throw new DGCConfigError("Unknown or incorrectly classified Pip command");
    if (mutation && approved !== true) throw new DGCConfigError("Pip mutations require explicit approved: true for this request");
    if (this.isolated) throw new DGCUnsupportedError("Pips controls use an existing local profile; create an explicitly authorized controller with inheritUserState: true");
    if (this.restricted) throw new DGCUnsupportedError("Pips cannot inherit this session's RuntimePolicy or sandbox; use a separate unrestricted, explicitly authorized control session");
    if (mutation && this.plan) throw new DGCUnsupportedError("Pip mutations are unavailable in plan mode");
    const minimum = API37_READS.has(command) || API37_MUTATIONS.has(command) ? 37 : API36_READS.has(command) || API36_MUTATIONS.has(command) ? 36 : API35_READS.has(command) || API35_MUTATIONS.has(command) ? 35 : API34_READS.has(command) || API34_MUTATIONS.has(command) ? 34 : API32_READS.has(command) || API32_MUTATIONS.has(command) ? 32 : API31_READS.has(command) || API31_MUTATIONS.has(command) ? 31 : command === "propose_pip_personal_handoff" ? 30 : command === "list_pip_accounts" ? 29 : API28_READS.has(command) ? 28 : API25_MUTATIONS.has(command) ? 25 : API23_COMMANDS.has(command) ? 23 : API19_COMMANDS.has(command) ? 19 : API17_COMMANDS.has(command) ? 17 : API16_COMMANDS.has(command) ? 16 : API14_COMMANDS.has(command) ? 14 : API13_COMMANDS.has(command) ? 13 : API12_COMMANDS.has(command) ? 12 : ["get_pip_proposal", "list_workspace_overviews", "list_pending_pip_reviews", "list_recent_workspace_activity", "list_pip_adaptations"].includes(command) ? 10 : (command === "accept_pip_execution_context" ? 9 : 8);
    if (this.caps.pips_supported !== true || !Number.isSafeInteger(this.caps.pips_api_version)
      || (this.caps.pips_api_version as number) < minimum) {
      throw new DGCUnsupportedError(`This control requires a runtime advertising Pips API ${minimum} or newer`);
    }
    if (this.caps.pips_enabled !== true) throw new DGCUnsupportedError("Enable Pips locally and open a new control session; the SDK does not enable it");
    const values = detach(params);
    const calendarEvent = values.event;
    if (["propose_pip_calendar_action", "prepare_pip_calendar_draft"].includes(command) && calendarEvent && typeof calendarEvent === "object"
      && ["attendees", "repeat", "send_invitations"].some(key => Object.hasOwn(calendarEvent, key)) && (this.caps.pips_api_version as number) < 38)
      throw new DGCUnsupportedError("Calendar invitations and finite series require Pips API 38 or newer");
    if (["pause_pip", "resume_pip"].includes(command) && Object.hasOwn(values, "expected_lifecycle_revision")
      && (this.caps.pips_api_version as number) < 16) {
      throw new DGCUnsupportedError("Reviewed lifecycle revisions require a runtime advertising Pips API 16 or newer");
    }
    if (Object.keys(values).some((key) => !COMMAND_FIELDS[command].includes(key))) throw new DGCConfigError("Unknown or reserved Pip parameter");
    if (command === "propose_pip_update" && values.changes && typeof values.changes === "object"
      && Object.hasOwn(values.changes, "app_plan") && (this.caps.pips_api_version as number) < 28) {
      throw new DGCUnsupportedError("Reviewed personal app reads require Pips API 28 or newer");
    }
    if (command === "propose_pip_update" && values.changes && typeof values.changes === "object"
      && Object.hasOwn(values.changes, "web_plan") && (this.caps.pips_api_version as number) < 40) {
      throw new DGCUnsupportedError("Reviewed personal web reads require Pips API 40 or newer");
    }
    const calendarPlan = (values.changes as Record<string, unknown> | undefined)?.app_plan as Record<string, unknown> | undefined;
    if (command === "propose_pip_update" && calendarPlan?.schema_version === 3 && (this.caps.pips_api_version as number) < 39) {
      throw new DGCUnsupportedError("Additional app searches require Pips API 39 or newer");
    }
    if (command === "propose_pip_update" && calendarPlan?.schema_version === 2 && (this.caps.pips_api_version as number) < 33) {
      throw new DGCUnsupportedError("Recurring calendar windows require Pips API 33 or newer");
    }
    if (command === "send_pip_message" && Object.hasOwn(values, "chat_options")) {
      if ((this.caps.pips_api_version as number) < 24) {
        throw new DGCUnsupportedError("Per-message reply controls require a runtime advertising Pips API 24 or newer");
      }
      const options = values.chat_options;
      if (!options || typeof options !== "object" || Array.isArray(options)
        || Object.keys(options).length !== 2 || !Object.hasOwn(options, "context_size") || !Object.hasOwn(options, "thinking")
        || typeof options.context_size !== "number" || !Number.isInteger(options.context_size)
        || options.context_size < 2048 || options.context_size > 1048576
        || typeof options.thinking !== "string" || !["off", "low", "medium", "high", "xhigh"].includes(options.thinking)) {
        throw new DGCConfigError("chat_options requires only context_size (integer 2048–1048576) and thinking (off, low, medium, high, xhigh)");
      }
      if (options.context_size > 32768 && (this.caps.pips_api_version as number) < 25) {
        throw new DGCUnsupportedError("Reply contexts above 32768 require a runtime advertising Pips API 25 or newer");
      }
    }
    if (command === "propose_pip_update" && values.changes && typeof values.changes === "object"
      && !Array.isArray(values.changes) && Object.hasOwn(values.changes, "source_policy")
      && (this.caps.pips_api_version as number) < 11) {
      throw new DGCUnsupportedError("Reviewed source policies require a runtime advertising Pips API 11 or newer");
    }
    const changes = values.changes;
    if ((this.caps.pips_api_version as number) < 21 && (
      (command === "propose_pip_update" && changes && typeof changes === "object" && !Array.isArray(changes)
        && Object.hasOwn(changes, "verification_plan"))
      || (command === "run_pip" && ["expected_version", "expected_lifecycle_revision", "expected_plan_digest"]
        .some((key) => Object.hasOwn(values, key))))) {
      throw new DGCUnsupportedError("Reviewed standalone Pulse plans require a runtime advertising Pips API 21 or newer");
    }
    const trigger = changes && typeof changes === "object" && !Array.isArray(changes) ? changes.event_trigger : null;
    if (command === "propose_pip_update" && trigger && typeof trigger === "object" && !Array.isArray(trigger)
      && (this.caps.pips_api_version as number) < 22 && (Object.hasOwn(trigger, "commit_paths")
        || (Array.isArray(trigger.events) && trigger.events.includes("committed_paths_changed")))) {
      throw new DGCUnsupportedError("Reviewed committed-path triggers require a runtime advertising Pips API 22 or newer");
    }
    if (command === "propose_pip_update" && trigger && typeof trigger === "object" && !Array.isArray(trigger)
      && Array.isArray(trigger.events) && trigger.events.includes("session_turn_completed")
      && (this.caps.pips_api_version as number) < 18) {
      throw new DGCUnsupportedError("Saved foreground turn triggers require a runtime advertising Pips API 18 or newer");
    }
    if (["propose_pip_handoff", "propose_pip_artifact_handoff"].includes(command)
      && values.action && typeof values.action === "object" && !Array.isArray(values.action)
      && Object.hasOwn(values.action, "specialists") && (this.caps.pips_api_version as number) < 15) {
      throw new DGCUnsupportedError("Reviewed specialist delegation requires a runtime advertising Pips API 15 or newer");
    }
    const requestId = `sdk-pips-${randomUUID()}`;
    const request = { type: command, request_id: requestId, ...values };
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_BYTES) throw new DGCConfigError("Pip request exceeds 32 KiB");
    const event = await this.send({ type: "pips_control", request }, "pips_result", requestId);
    if (event.request_id !== requestId || event.command !== command || typeof event.ok !== "boolean") throw new DGCProtocolError("Mismatched or malformed Pip response");
    if (event.ok) {
      if (!event.result || typeof event.result !== "object" || Array.isArray(event.result)) throw new DGCProtocolError("Pip response has no result object");
      return event.result as PipResult;
    }
    const error = event.error as Record<string, unknown> | undefined;
    if (!error || typeof error.code !== "string" || typeof error.message !== "string") throw new DGCProtocolError("Pip failure has no structured error");
    throw new DGCCommandRejectedError(error.message, { reason: error.code, command });
  }

  list(workspaceId: string): Promise<PipResult> { return this.read("list_pips", { workspace_id: workspaceId }); }
  get(pipId: string): Promise<PipResult> { return this.read("get_pip", { pip_id: pipId }); }
  runs(pipId: string): Promise<PipResult> { return this.read("list_pip_runs", { pip_id: pipId }); }
  /** Read a run; never enqueue work. */
  getRun(runId: string): Promise<PipResult> { return this.read("get_pip_run", { run_id: runId }); }
}
