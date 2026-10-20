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
export type PipSeverity = "low" | "medium" | "high" | "critical";
export type PipReadParams = {
  list_pip_logins: { pip_id?: string };
  get_pip_computer_apps: Record<string, never>;
  get_pip_eyes: { pip_id: string };
  list_pip_shared: { pip_id: string; kind: "links" | "media" | "files" };
  get_pip_computers: Record<string, never>;
  list_pip_apps: Record<string, never>;
  list_pip_plugins: { pip_id: string };
  list_pip_plugin_uses: Record<string, never>;
  list_pip_attention: { limit?: number };
  list_pip_notes: { pip_id: string; shared?: true };
  list_pip_sites: { pip_id: string };
  get_pip_chat_context: { pip_id: string; context_size?: number };
  check_pip_source: { pip_id: string; source_policy?: Record<string, unknown> };
  get_pip_run_source: { run_id: string };
  list_pip_run_posts: { pip_id: string; before_id?: string; limit?: number };
  get_pips_limit: Record<string, never>;
  list_pip_reply_stats: { pip_id: string; run_ids: string[] };
  list_pip_routines: { pip_id: string };
  list_pip_app_links: { pip_id: string };
  list_pip_computer_files: { pip_id: string; path?: string };
  read_pip_computer_file: { pip_id: string; path: string };
  list_pip_computer_terminal: { pip_id: string };
  get_pip_computer_desktop: { pip_id: string };
  get_pip_computer: { pip_id: string };
  list_pip_computer_actions: { pip_id: string; limit?: number };
  get_pip_computer_frame: { run_id: string; frame: string };
  get_pip_message_image: { pip_id: string; message_id: string; index: number; as_file?: boolean };
  list_pip_computer_frames: { run_id: string; pointers?: boolean };
  list_pip_action_grants: { pip_id: string };
  list_pip_feedback: { pip_id: string };
  export_pip: { pip_id: string };
  get_pip_usage: { pip_id: string };
  get_pips_desktop_notifications: Record<string, never>;
  get_pips_keep_running: Record<string, never>;
  get_pip_digest: Record<string, never>;
  get_pip_notify_settings: { pip_id: string };
  get_pip_outcomes: { pip_id: string };
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
  list_pips: { workspace_id: string; limit?: number; offset?: number; query?: string; order?: "created" | "recent" };
  list_workspace_activity: { after?: number; workspace_id: string };
  list_workspaces: { [key: string]: never };
};
export type PipMutationParams = {
  save_pip_login: { pip_id: string; username: string; password: string; totp?: string; pips?: "only" | "all" }
    & ({ site: string } | { action_id: string; expected_digest: string });
  remove_pip_login: { login_id: string };
  grant_pip_login: { login_id: string; pips: "all" | string[] };
  set_pip_computer_apps: { choice: "download" | "not_now" };
  set_pip_profile: { pip_id: string; changes: { title?: string; body?: string | null; color?: string | null; notify?: boolean } };
  update_pip_computers: Record<string, never>;
  reset_pip_computer: { pip_id: string };
  add_pip_routine: { pip_id: string; title: string; prompt: string; trigger: Record<string, PipJson> };
  update_pip_routine: { pip_id: string; routine_id: string; changes: Record<string, PipJson> };
  delete_pip_routine: { pip_id: string; routine_id: string };
  decide_pip_routine: { pip_id: string; routine_id: string; add: boolean };
  start_pip_app_link: { pip_id: string; link_id: string };
  check_pip_app_link: { pip_id: string; link_id: string };
  decline_pip_app_link: { pip_id: string; link_id: string };
  disconnect_pip_app_link: { pip_id: string; link_id: string };
  finish_pip_computer_check: { pip_id: string };
  allow_pip_plugin: { pip_id: string; grant_id: string };
  add_pip_note: { pip_id: string; text: string; shared?: true };
  forget_pip_note: { pip_id: string; note_id?: string; all?: true; shared?: true };
  set_pip_careful: { pip_id: string; on: boolean };
  set_pip_chat_options: { pip_id: string; chat_options: PipChatOptions };
  set_pip_eyes: { pip_id: string; choice: "ask" | "relay" | "off" };
  set_plugin_permission: { plugin: string; level: "always_ask" | "any_changes" | "important" | "never_ask" };
  forget_pip_site: { pip_id: string; site: string };
  set_pips_limit: { max_pips: number };
  decline_pip_plugin: { pip_id: string; grant_id: string };
  add_pip_computer_file: { pip_id: string; path?: string; name: string; data: string };
  remove_pip_computer_file: { pip_id: string; path: string };
  run_pip_computer_command: { pip_id: string; command: string };
  always_allow_pip_computer_action: { action_id: string; expected_digest: string };
  decide_pip_computer_action: { action_id: string; expected_digest: string; approve: boolean };
  stop_pip_computer: { pip_id: string };
  open_pip_computer: { pip_id: string };
  use_pip_computer_view: { pip_id: string; op: string; x?: number; y?: number; text?: string; key?: string; dy?: number; url?: string };
  always_allow_pip_app_action: { action_id: string; expected_digest: string };
  revoke_pip_action_grant: { pip_id: string; grant_id: string };
  set_pip_feedback: { run_id: string; rating: "up" | "down" | null; note: string };
  set_pip_daily_cap: { pip_id: string; daily_tokens: number | null };
  set_pips_desktop_notifications: { enabled: boolean };
  set_pips_keep_running: { enabled: boolean };
  mark_pip_digest_seen: { until: string };
  mark_pip_news_seen: { pip_ids: string[]; until: string };
  set_pip_notify_settings: { pip_id: string; min_severity: PipSeverity; alert_severity: PipSeverity | null; expected_revision: number };
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
  revise_pip_setup: { setup_id: string; expected_digest: string; model_choice: { mode: "default" } | { mode: "model"; model: string } | { mode: "subscription"; engine: "claude" | "codex" } };
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
  send_pip_message: { idempotency_key: string; pip_id: string; text: string; chat_options?: PipChatOptions; images?: string[]; files?: { name: string; data: string }[];
    spooled_images?: { name: string; media_type: string }[]; spooled_files?: { name: string; spool: string }[] };
  introduce_pip: { pip_id: string };
  stop_pips: { [key: string]: never };
};
export type PipReadCommand = keyof PipReadParams;
export type PipMutationCommand = keyof PipMutationParams;
export const COMMAND_FIELDS: Readonly<Record<string, readonly string[]>> = {
  list_pip_logins: ["pip_id"],
  save_pip_login: ["pip_id", "site", "username", "password", "totp", "pips", "action_id", "expected_digest"],
  remove_pip_login: ["login_id"],
  grant_pip_login: ["login_id", "pips"],
  set_pip_profile: ["pip_id", "changes"],
  list_pip_shared: ["pip_id", "kind"],
  get_pip_computers: [],
  update_pip_computers: [],
  reset_pip_computer: ["pip_id"],
  list_pip_apps: [],
  get_pip_computer_apps: [],
  set_pip_computer_apps: ["choice"],
  get_pip_eyes: ["pip_id"],
  set_pip_eyes: ["choice", "pip_id"],
  list_pip_plugins: ["pip_id"],
  allow_pip_plugin: ["pip_id", "grant_id"],
  decline_pip_plugin: ["pip_id", "grant_id"],
  list_pip_plugin_uses: [],
  list_pip_attention: ["limit"],
  list_pip_notes: ["pip_id", "shared"],
  add_pip_note: ["pip_id", "text", "shared"],
  forget_pip_note: ["pip_id", "note_id", "all", "shared"],
  list_pip_sites: ["pip_id"],
  set_pip_careful: ["pip_id", "on"],
  set_plugin_permission: ["level", "plugin"],
  forget_pip_site: ["pip_id", "site"],
  get_pip_chat_context: ["pip_id", "context_size"],
  set_pip_chat_options: ["pip_id", "chat_options"],
  check_pip_source: ["pip_id", "source_policy"],
  get_pip_run_source: ["run_id"],
  list_pip_run_posts: ["pip_id", "before_id", "limit"],
  list_pip_reply_stats: ["pip_id", "run_ids"],
  get_pips_limit: [],
  set_pips_limit: ["max_pips"],
  list_pip_routines: ["pip_id"],
  add_pip_routine: ["pip_id", "title", "prompt", "trigger"],
  update_pip_routine: ["pip_id", "routine_id", "changes"],
  delete_pip_routine: ["pip_id", "routine_id"],
  decide_pip_routine: ["pip_id", "routine_id", "add"],
  list_pip_app_links: ["pip_id"],
  start_pip_app_link: ["pip_id", "link_id"],
  check_pip_app_link: ["pip_id", "link_id"],
  decline_pip_app_link: ["pip_id", "link_id"],
  disconnect_pip_app_link: ["pip_id", "link_id"],
  finish_pip_computer_check: ["pip_id"],
  list_pip_computer_files: ["pip_id", "path"],
  read_pip_computer_file: ["pip_id", "path"],
  add_pip_computer_file: ["pip_id", "path", "name", "data"],
  remove_pip_computer_file: ["pip_id", "path"],
  run_pip_computer_command: ["pip_id", "command"],
  list_pip_computer_terminal: ["pip_id"],
  get_pip_computer_desktop: ["pip_id"],
  always_allow_pip_computer_action: ["action_id", "expected_digest"],
  get_pip_computer: ["pip_id"],
  list_pip_computer_actions: ["pip_id", "limit"],
  get_pip_computer_frame: ["run_id", "frame"],
  list_pip_computer_frames: ["pointers", "run_id"],
  decide_pip_computer_action: ["action_id", "expected_digest", "approve"],
  stop_pip_computer: ["pip_id"],
  open_pip_computer: ["pip_id"],
  use_pip_computer_view: ["pip_id", "op", "x", "y", "text", "key", "dy", "url"],
  list_pip_action_grants: ["pip_id"],
  always_allow_pip_app_action: ["action_id", "expected_digest"],
  revoke_pip_action_grant: ["pip_id", "grant_id"],
  list_pip_feedback: ["pip_id"],
  set_pip_feedback: ["run_id", "rating", "note"],
  export_pip: ["pip_id"],
  get_pip_usage: ["pip_id"],
  set_pip_daily_cap: ["pip_id", "daily_tokens"],
  get_pips_desktop_notifications: [],
  set_pips_desktop_notifications: ["enabled"],
  get_pips_keep_running: [],
  set_pips_keep_running: ["enabled"],
  get_pip_digest: [],
  mark_pip_digest_seen: ["until"],
  mark_pip_news_seen: ["pip_ids", "until"],
  get_pip_notify_settings: ["pip_id"],
  set_pip_notify_settings: ["pip_id", "min_severity", "alert_severity", "expected_revision"],
  get_pip_outcomes: ["pip_id"],
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
    "workspace_id", "limit", "offset", "query", "order"
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
    "files",
    "idempotency_key",
    "images",
    "pip_id",
    "spooled_files",
    "spooled_images",
    "text"
  ],
  "get_pip_message_image": [
    "as_file",
    "index",
    "message_id",
    "pip_id"
  ],
  "introduce_pip": [
    "pip_id"
  ],
  "create_pip": [
    "computer",
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
// API 41: the daily digest, per-Pip notification settings and finding outcomes (display state only).
const API41_READS = new Set(["list_pip_action_grants", "list_pip_feedback", "export_pip", "get_pip_usage", "get_pips_desktop_notifications", "get_pips_keep_running", "get_pip_digest", "get_pip_notify_settings", "get_pip_outcomes"]);
const API41_MUTATIONS = new Set(["always_allow_pip_app_action", "revoke_pip_action_grant", "set_pip_feedback", "set_pip_daily_cap", "set_pips_desktop_notifications", "set_pips_keep_running", "mark_pip_digest_seen", "set_pip_notify_settings"]);
for (const command of API41_READS) READS.add(command);
for (const command of API41_MUTATIONS) MUTATIONS.add(command);
// API 42: Pip computers; a decision releases or drops one held browser write (local only).
const API42_READS = new Set(["get_pip_computer", "list_pip_computer_actions", "get_pip_computer_frame", "list_pip_computer_frames"]);
const API42_MUTATIONS = new Set(["always_allow_pip_computer_action", "decide_pip_computer_action", "stop_pip_computer", "open_pip_computer", "use_pip_computer_view"]);
for (const command of API42_READS) READS.add(command);
for (const command of API42_MUTATIONS) MUTATIONS.add(command);
// API 43: a new Personal Pip speaks first.
const API43_MUTATIONS = new Set(["introduce_pip"]);
for (const command of API43_MUTATIONS) MUTATIONS.add(command);
// API 43: the images sent in a Pip's chat, one at a time.
const API43_READS = new Set(["get_pip_message_image"]);
// API 43: a Pip computer's Files and Terminal (its browser is API 42).
for (const command of ["list_pip_computer_files", "read_pip_computer_file", "list_pip_computer_terminal", "get_pip_computer_desktop"]) API43_READS.add(command);
for (const command of ["add_pip_computer_file", "remove_pip_computer_file", "run_pip_computer_command"]) API43_MUTATIONS.add(command);
// API 43: a Personal Pip's own apps, connected from its chat, and a robot check finished on its computer.
API43_READS.add("list_pip_app_links");
for (const command of ["start_pip_app_link", "check_pip_app_link", "decline_pip_app_link", "disconnect_pip_app_link", "finish_pip_computer_check"]) API43_MUTATIONS.add(command);
// API 43: a Personal Pip's routines: timed, or on new email or an upcoming calendar event; local only.
API43_READS.add("list_pip_routines");
for (const command of ["add_pip_routine", "update_pip_routine", "delete_pip_routine", "decide_pip_routine"]) API43_MUTATIONS.add(command);
// API 43: a Personal Pip's page (look, title, notifications; what its chat shared), its computer's
// settings, and every app your Pips use; local only.
for (const command of ["list_pip_shared", "get_pip_computers", "list_pip_apps"]) API43_READS.add(command);
for (const command of ["set_pip_profile", "update_pip_computers", "reset_pip_computer"]) API43_MUTATIONS.add(command);
for (const command of API43_READS) READS.add(command);
for (const command of API43_MUTATIONS) MUTATIONS.add(command);
// API 44: a Personal Pip's plugins. It asks to use one; you allow it, or not, on its card; local only.
const API44_READS = new Set(["list_pip_plugins", "list_pip_plugin_uses", "list_pip_attention", "list_pip_notes", "list_pip_sites", "get_pip_chat_context", "list_pip_reply_stats", "get_pips_limit"]);
const API44_MUTATIONS = new Set(["allow_pip_plugin", "decline_pip_plugin", "set_pips_limit", "add_pip_note", "forget_pip_note", "set_pip_careful", "forget_pip_site"]);
for (const command of API44_READS) READS.add(command);
for (const command of API44_MUTATIONS) MUTATIONS.add(command);
// API 45: what each plugin may do without asking (ChatGPT's four levels), for every Pip; local only.
const API45_MUTATIONS = new Set(["set_plugin_permission"]);
for (const command of API45_MUTATIONS) MUTATIONS.add(command);
// API 47: a Pip's context window and thinking are its own (its prompt box), for all its runs; local only.
const API47_MUTATIONS = new Set(["set_pip_chat_options"]);
for (const command of API47_MUTATIONS) MUTATIONS.add(command);
// API 48: a Pip's news (failed runs, new findings) dismissed until it does something new; local only.
const API48_MUTATIONS = new Set(["mark_pip_news_seen"]);
for (const command of API48_MUTATIONS) MUTATIONS.add(command);
// API 50: whether a Pip's source fits a run, and what one run's copy left out (safe_source_v2); local only.
const API50_READS = new Set(["check_pip_source", "get_pip_run_source"]);
for (const command of API50_READS) READS.add(command);
// API 51: a finished run posts its result in its Pip's own chat; list_pip_run_posts reads them, a page at a time.
const API51_READS = new Set(["list_pip_run_posts"]);
for (const command of API51_READS) READS.add(command);
// API 52: photos and files handed over through the backend's spool (ready.capabilities.image_spool_dir), as the
// Work chat's prompt does: send_pip_message's spooled_images [{name, media_type}] and spooled_files [{name, spool}];
// get_pip_message_image's as_file answers with the kept file's path. Fields, not commands.
const API52_FIELDS: Readonly<Record<string, readonly string[]>> = {
  send_pip_message: ["spooled_images", "spooled_files"], get_pip_message_image: ["as_file"] };
const SPOOLED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/heic", "image/heif"]);
const spoolName = (value: unknown): boolean => typeof value === "string" && value.length >= 1 && value.length <= 255
  && value !== "." && value !== ".." && !/[\/\\\u0000-\u001f\u007f]/.test(value);
function checkApi52Fields(values: Record<string, unknown>): void {
  if (Object.hasOwn(values, "spooled_images")) {
    const images = values.spooled_images;
    if (!Array.isArray(images) || images.length < 1 || images.length > 64 || !images.every((i: any) => i && typeof i === "object"
      && !Array.isArray(i) && Object.keys(i).sort().join() === "media_type,name" && spoolName(i.name) && SPOOLED_IMAGE_TYPES.has(i.media_type))) {
      throw new DGCConfigError("spooled_images must be 1 to 64 {name, media_type} entries naming files in the image spool");
    }
  }
  if (Object.hasOwn(values, "spooled_files")) {
    const files = values.spooled_files;
    if (!Array.isArray(files) || files.length < 1 || files.length > 16 || !files.every((f: any) => f && typeof f === "object"
      && !Array.isArray(f) && Object.keys(f).sort().join() === "name,spool" && typeof f.name === "string" && f.name.trim() !== ""
      && f.name.length <= 255 && !/[\/\\"\u0000-\u001f]/.test(f.name) && spoolName(f.spool))) {
      throw new DGCConfigError("spooled_files must be 1 to 16 {name, spool} entries naming files in the image spool");
    }
  }
  if (Object.hasOwn(values, "as_file") && typeof values.as_file !== "boolean") throw new DGCConfigError("as_file must be true or false");
}
// API 53: a Pip's eyes and cursor. get_pip_eyes / set_pip_eyes: how a Personal Pip whose model reads text only sees
// (choice ask, relay or off); list_pip_computer_frames' pointers (each step that acted by position says where);
// use_pip_computer_view's op "pointer" (where the Pip last acted, without a frame). Local only.
const API53_READS = new Set(["get_pip_eyes"]);
const API53_MUTATIONS = new Set(["set_pip_eyes"]);
for (const command of API53_READS) READS.add(command);
for (const command of API53_MUTATIONS) MUTATIONS.add(command);
const API53_FIELDS: Readonly<Record<string, readonly string[]>> = { list_pip_computer_frames: ["pointers"] };
const EYES_CHOICES = new Set(["ask", "relay", "off"]);
// API 55: the subscription CLIs a Personal Pip can run on (pip_brain).
const SUBSCRIPTION_ENGINES = new Set(["claude", "codex"]);
// API 54: Pips use the whole desktop. get_pip_computer_apps reads which of its apps (an image editor, a document editor,
// a PDF viewer) this computer has and the one offer to download the ones it lacks; set_pip_computer_apps answers it
// (choice download or not_now). Local only.
const API54_READS = new Set(["get_pip_computer_apps"]);
const API54_MUTATIONS = new Set(["set_pip_computer_apps"]);
for (const command of API54_READS) READS.add(command);
for (const command of API54_MUTATIONS) MUTATIONS.add(command);
const APPS_CHOICES = new Set(["download", "not_now"]);
// API 56: saved logins. list_pip_logins reads where each saved login fills, its username, whether it has a code and
// which Pips may use it (never a password or a key); save_pip_login keeps one (from a Pip's "login" computer action,
// action_id + expected_digest, or for a site), remove_pip_login forgets one, grant_pip_login sets which Pips may use it.
// A save carries the password and the authenticator key in that one request only: no SDK error repeats them.
const API56_READS = new Set(["list_pip_logins"]);
const API56_MUTATIONS = new Set(["save_pip_login", "remove_pip_login", "grant_pip_login"]);
for (const command of API56_READS) READS.add(command);
for (const command of API56_MUTATIONS) MUTATIONS.add(command);
function checkLoginSave(values: Record<string, unknown>): void {
  for (const key of ["pip_id", "username", "password"]) {
    if (typeof values[key] !== "string") throw new DGCConfigError("save_pip_login takes pip_id, username and password as strings");
  }
  const password = values.password as string, username = values.username as string;
  if (!password || password.length > 512 || username.length > 512) throw new DGCConfigError("The password is 1 to 512 characters and the username up to 512");
  if (Object.hasOwn(values, "action_id") === Object.hasOwn(values, "site")) {
    throw new DGCConfigError("save_pip_login takes site, or action_id with expected_digest (a \"login\" computer action)");
  }
  if (Object.hasOwn(values, "action_id") && (typeof values.action_id !== "string" || typeof values.expected_digest !== "string")) {
    throw new DGCConfigError("action_id and expected_digest are strings");
  }
  if (Object.hasOwn(values, "site") && typeof values.site !== "string") throw new DGCConfigError("site is the site's address, as a string");
  if (Object.hasOwn(values, "totp") && typeof values.totp !== "string") throw new DGCConfigError("totp is a base32 key or an otpauth://totp/ link, as a string");
  if (Object.hasOwn(values, "pips") && !["only", "all"].includes(values.pips as string)) throw new DGCConfigError("pips is \"only\" (this Pip) or \"all\"");
}
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
/** Images sent with a Pip message travel outside that budget: 4 data URIs, 2 MiB of image in all. */
const MAX_IMAGE_URI_CHARS = 2_800_000;

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
    const minimum = API56_READS.has(command) || API56_MUTATIONS.has(command) ? 56 : API54_READS.has(command) || API54_MUTATIONS.has(command) ? 54 : API53_READS.has(command) || API53_MUTATIONS.has(command) ? 53 : API51_READS.has(command) ? 51 : API50_READS.has(command) ? 50 : API48_MUTATIONS.has(command) ? 48 : API47_MUTATIONS.has(command) ? 47 :API45_MUTATIONS.has(command) ? 45 : API44_MUTATIONS.has(command) || API44_READS.has(command) ? 44 : API43_MUTATIONS.has(command) || API43_READS.has(command) ? 43 : API42_READS.has(command) || API42_MUTATIONS.has(command) ? 42 : API41_READS.has(command) || API41_MUTATIONS.has(command) ? 41 : API37_READS.has(command) || API37_MUTATIONS.has(command) ? 37 : API36_READS.has(command) || API36_MUTATIONS.has(command) ? 36 : API35_READS.has(command) || API35_MUTATIONS.has(command) ? 35 : API34_READS.has(command) || API34_MUTATIONS.has(command) ? 34 : API32_READS.has(command) || API32_MUTATIONS.has(command) ? 32 : API31_READS.has(command) || API31_MUTATIONS.has(command) ? 31 : command === "propose_pip_personal_handoff" ? 30 : command === "list_pip_accounts" ? 29 : API28_READS.has(command) ? 28 : API25_MUTATIONS.has(command) ? 25 : API23_COMMANDS.has(command) ? 23 : API19_COMMANDS.has(command) ? 19 : API17_COMMANDS.has(command) ? 17 : API16_COMMANDS.has(command) ? 16 : API14_COMMANDS.has(command) ? 14 : API13_COMMANDS.has(command) ? 13 : API12_COMMANDS.has(command) ? 12 : ["get_pip_proposal", "list_workspace_overviews", "list_pending_pip_reviews", "list_recent_workspace_activity", "list_pip_adaptations"].includes(command) ? 10 : (command === "accept_pip_execution_context" ? 9 : 8);
    if (this.caps.pips_supported !== true || !Number.isSafeInteger(this.caps.pips_api_version)
      || (this.caps.pips_api_version as number) < minimum) {
      throw new DGCUnsupportedError(`This control requires a runtime advertising Pips API ${minimum} or newer`);
    }
    if (this.caps.pips_enabled !== true) throw new DGCUnsupportedError("Enable Pips locally and open a new control session; the SDK does not enable it");
    let images: string[] | undefined;
    if (command === "send_pip_message" && params && typeof params === "object" && Object.hasOwn(params, "images")) {
      if ((this.caps.pips_api_version as number) < 43) {
        throw new DGCUnsupportedError("Images in a Pip chat require a runtime advertising Pips API 43 or newer");
      }
      const given = (params as Record<string, unknown>).images;
      if (!Array.isArray(given) || given.length < 1 || given.length > 4
        || given.some((i: unknown) => typeof i !== "string" || !i.startsWith("data:image/") || !/^[\x00-\x7f]*$/.test(i))
        || given.reduce((n: number, i: string) => n + i.length, 0) > MAX_IMAGE_URI_CHARS) {
        throw new DGCConfigError("images must be 1 to 4 image data URIs, 2 MB in all");
      }
      images = [...given];
      const { images: _sent, ...rest } = params as Record<string, unknown>;
      params = rest;
    }
    let files: { name: string; data: string }[] | undefined;
    if (command === "send_pip_message" && params && typeof params === "object" && Object.hasOwn(params, "files")) {
      // Files sent with a message travel with its images, outside the 32 KiB budget: 4, 2 MB in all.
      if ((this.caps.pips_api_version as number) < 43) {
        throw new DGCUnsupportedError("Files in a Pip chat require a runtime advertising Pips API 43 or newer");
      }
      const given = (params as Record<string, unknown>).files;
      const ok = (f: any) => f && typeof f === "object" && !Array.isArray(f) && Object.keys(f).sort().join() === "data,name"
        && typeof f.name === "string" && f.name.trim() !== "" && f.name.length <= 255 && !/[\/\\"\u0000-\u001f]/.test(f.name)
        && typeof f.data === "string" && f.data.startsWith("data:") && f.data.slice(0, 200).includes(";base64,") && /^[\x00-\x7f]*$/.test(f.data);
      if (!Array.isArray(given) || given.length < 1 || given.length > 4 || !given.every(ok)
        || given.reduce((n: number, f: any) => n + f.data.length, 0) + (images || []).reduce((n, i) => n + i.length, 0) > MAX_IMAGE_URI_CHARS) {
        throw new DGCConfigError("files must be 1 to 4 {name, data} entries, 2 MB in all with any images");
      }
      files = given.map((f: any) => ({ name: f.name, data: f.data }));
      const { files: _sent, ...rest } = params as Record<string, unknown>;
      params = rest;
    }
    let fileData: string | undefined;
    if (command === "add_pip_computer_file" && params && typeof params === "object" && Object.hasOwn(params, "data")) {
      // A file added to a Pip's computer also travels outside the 32 KiB budget: one data URI, 2 MB.
      const given = (params as Record<string, unknown>).data;
      if (typeof given !== "string" || !given.startsWith("data:") || !given.slice(0, 200).includes(";base64,")
        || !/^[\x00-\x7f]*$/.test(given) || given.length > MAX_IMAGE_URI_CHARS) {
        throw new DGCConfigError("data must be one data URI of 2 MB or less");
      }
      fileData = given;
      const { data: _sent, ...rest } = params as Record<string, unknown>;
      params = rest;
    }
    const values = detach(params);
    const calendarEvent = values.event;
    if (["propose_pip_calendar_action", "prepare_pip_calendar_draft"].includes(command) && calendarEvent && typeof calendarEvent === "object"
      && ["attendees", "repeat", "send_invitations"].some(key => Object.hasOwn(calendarEvent, key)) && (this.caps.pips_api_version as number) < 38)
      throw new DGCUnsupportedError("Calendar invitations and finite series require Pips API 38 or newer");
    if (["pause_pip", "resume_pip"].includes(command) && Object.hasOwn(values, "expected_lifecycle_revision")
      && (this.caps.pips_api_version as number) < 16) {
      throw new DGCUnsupportedError("Reviewed lifecycle revisions require a runtime advertising Pips API 16 or newer");
    }
    if ((API52_FIELDS[command] || []).some((key) => Object.hasOwn(values, key))) {
      if ((this.caps.pips_api_version as number) < 52) {
        throw new DGCUnsupportedError("Photos and files through the spool, and as_file, require a runtime advertising Pips API 52 or newer");
      }
      checkApi52Fields(values);
    }
    if ((API53_FIELDS[command] || []).some((key) => Object.hasOwn(values, key)) || command === "use_pip_computer_view" && values.op === "pointer") {
      if ((this.caps.pips_api_version as number) < 53) {
        throw new DGCUnsupportedError("Where a Pip acted by position (pointers, the view's pointer) requires a runtime advertising Pips API 53 or newer");
      }
      if (Object.hasOwn(values, "pointers") && typeof values.pointers !== "boolean") throw new DGCConfigError("pointers must be true or false");
    }
    const choices = [values.model_choice, (values.changes as Record<string, unknown> | undefined)?.model_choice] as unknown[];
    const subscription = (choice: unknown): choice is Record<string, unknown> => !!choice && typeof choice === "object" && (choice as Record<string, unknown>).mode === "subscription";
    if (choices.some(subscription)) {
      if ((this.caps.pips_api_version as number) < 55) {
        throw new DGCUnsupportedError("A Pip on your own Claude Code or Codex requires a runtime advertising Pips API 55 or newer");
      }
      if (choices.filter(subscription).some((choice) => Object.keys(choice).sort().join() !== "engine,mode" || !SUBSCRIPTION_ENGINES.has(choice.engine as string))) {
        throw new DGCConfigError('A subscription model_choice is {mode: "subscription", engine: "claude" | "codex"}');
      }
    }
    if (command === "set_pip_eyes" && !EYES_CHOICES.has(values.choice as string)) throw new DGCConfigError("choice must be ask, relay or off");
    if (command === "set_pip_computer_apps" && !APPS_CHOICES.has(values.choice as string)) throw new DGCConfigError("choice must be download or not_now");
    if (command === "save_pip_login") checkLoginSave(values);
    if (command === "grant_pip_login" && !(values.pips === "all" || Array.isArray(values.pips) && values.pips.length <= 64 && values.pips.every((p) => typeof p === "string"))) {
      throw new DGCConfigError("pips is \"all\" or a list of Pip ids");
    }
    if (Object.keys(values).some((key) => !COMMAND_FIELDS[command].includes(key))) throw new DGCConfigError("Unknown or reserved Pip parameter");
    if (["list_pip_notes", "add_pip_note", "forget_pip_note"].includes(command) && Object.hasOwn(values, "shared")
      && (this.caps.pips_api_version as number) < 46)
      throw new DGCUnsupportedError("A Pip's notes in the one shared memory require Pips API 46 or newer");
    if (command === "propose_pip_update" && values.changes && typeof values.changes === "object"
      && Object.hasOwn(values.changes, "app_plan") && (this.caps.pips_api_version as number) < 28) {
      throw new DGCUnsupportedError("Reviewed personal app reads require Pips API 28 or newer");
    }
    if (command === "propose_pip_update" && values.changes && typeof values.changes === "object"
      && Object.hasOwn(values.changes, "web_plan") && (this.caps.pips_api_version as number) < 40) {
      throw new DGCUnsupportedError("Reviewed personal web reads require Pips API 40 or newer");
    }
    if (command === "propose_pip_update" && values.changes && typeof values.changes === "object"
      && Object.hasOwn(values.changes, "github_plan") && (this.caps.pips_api_version as number) < 41) {
      throw new DGCUnsupportedError("Reviewed GitHub reads require Pips API 41 or newer");
    }
    if (command === "propose_pip_update" && values.changes && typeof values.changes === "object"
      && Object.hasOwn(values.changes, "computer_plan") && (this.caps.pips_api_version as number) < 42) {
      throw new DGCUnsupportedError("Pip computers require Pips API 42 or newer");
    }
    const calendarPlan = (values.changes as Record<string, unknown> | undefined)?.app_plan as Record<string, unknown> | undefined;
    if (command === "propose_pip_update" && calendarPlan?.schema_version === 3 && (this.caps.pips_api_version as number) < 39) {
      throw new DGCUnsupportedError("Additional app searches require Pips API 39 or newer");
    }
    if (command === "propose_pip_update" && calendarPlan?.schema_version === 2 && (this.caps.pips_api_version as number) < 33) {
      throw new DGCUnsupportedError("Recurring calendar windows require Pips API 33 or newer");
    }
    if (command === "set_pip_chat_options" && !Object.hasOwn(values, "chat_options")) {
      throw new DGCConfigError("set_pip_chat_options requires chat_options");
    }
    if ((command === "send_pip_message" || command === "set_pip_chat_options") && Object.hasOwn(values, "chat_options")) {
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
    const sourcePolicy = command === "propose_pip_update" && values.changes && typeof values.changes === "object"
      && !Array.isArray(values.changes) ? (values.changes as Record<string, unknown>).source_policy : undefined;
    if (sourcePolicy && typeof sourcePolicy === "object" && (sourcePolicy as Record<string, unknown>).exclusions === "safe_source_v2"
      && (this.caps.pips_api_version as number) < 50) {
      throw new DGCUnsupportedError("The safe_source_v2 source rules and Excluded folders require a runtime advertising Pips API 50 or newer");
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
    const sent = { ...request, ...(images === undefined ? {} : { images }), ...(files === undefined ? {} : { files }), ...(fileData === undefined ? {} : { data: fileData }) };
    const event = await this.send({ type: "pips_control", request: sent }, "pips_result", requestId);
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
  /** What this Pip's runs posted in its own chat, oldest first (Pips API 51). */
  runPosts(pipId: string, options: { beforeId?: string; limit?: number } = {}): Promise<PipResult> {
    return this.read("list_pip_run_posts", { pip_id: pipId,
      ...(options.beforeId !== undefined ? { before_id: options.beforeId } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}) });
  }
  /** Hand a photo or file to the runtime through its spool (Pips API 52); resolves to the name to send in
   *  send_pip_message's spooled_images ({name, media_type}) or spooled_files ({name: your file's name, spool}).
   *  The runtime reads it and removes it. */
  async spool(data: Uint8Array, options: { suffix?: string } = {}): Promise<string> {
    const folder = this.caps.image_spool === true && typeof this.caps.image_spool_dir === "string" ? this.caps.image_spool_dir : "";
    if (!folder) throw new DGCUnsupportedError("This runtime has no image spool to hand files over through");
    if (!Number.isSafeInteger(this.caps.pips_api_version) || (this.caps.pips_api_version as number) < 52) {
      throw new DGCUnsupportedError("Photos and files through the spool require a runtime advertising Pips API 52 or newer");
    }
    if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new DGCConfigError("spool takes the file's bytes");
    const suffix = options.suffix ?? "";
    if (!/^(\.[A-Za-z0-9]{1,10})?$/.test(suffix)) throw new DGCConfigError("suffix is empty or one extension, such as .jpg");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const name = randomUUID().replace(/-/g, "") + suffix;
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(join(folder, name), data, { mode: 0o600, flag: "wx" });
    return name;
  }
}
