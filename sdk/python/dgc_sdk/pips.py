"""Explicit, capability-gated Pips controls; no implicit enable or runner startup.

Pip workers have independent policies. A foreground RuntimePolicy or sandbox is
not inherited by them; these accessors therefore refuse policy-bound sessions.
"""
from __future__ import annotations

import asyncio
import json
import math
import uuid
from collections.abc import Mapping
from typing import Any, Literal, TYPE_CHECKING

from .errors import DGCCommandRejectedError, DGCConfigError, DGCProtocolError, DGCUnsupportedError
if TYPE_CHECKING:
    from .session import Session

PipReadCommand = Literal[
    "list_pip_plugins", "list_pip_plugin_uses",
    "list_pip_routines", "list_pip_shared", "get_pip_computers", "list_pip_apps",
    "list_pip_computer_files", "read_pip_computer_file", "list_pip_computer_terminal", "get_pip_computer_desktop",
    "get_pip_message_image", "get_pip_computer", "list_pip_computer_actions", "get_pip_computer_frame", "list_pip_computer_frames",
    "list_pip_action_grants", "list_pip_feedback", "export_pip", "get_pip_usage", "get_pips_desktop_notifications", "get_pips_keep_running", "get_pip_digest", "get_pip_notify_settings", "get_pip_outcomes",
    "get_pip_connector_draft", "list_pip_connector_drafts", "inspect_pip_connector_actions", "inspect_pip_calendar_connection", "get_pip_calendar_draft", "list_pip_calendar_drafts",
    "get_pip_message_draft", "list_pip_message_drafts",
    'inspect_pip_send_connection', 'get_pip_app_action', 'list_pip_app_actions',
    'list_pip_accounts', 'list_pip_connections', 'inspect_pip_connection',
    'list_pip_setups', 'get_pip_setup',
    'get_pip_statement_anchor', 'list_pip_statements',
    'get_pip_exception_source', 'list_pip_memories',
    'list_pip_notifications',
    'list_workspace_sessions',
    'inspect_workspace_session_outcome',
    'get_workspace_session_outcome',
    'list_workspace_session_outcomes',
    'list_workspace_execution_receipts',
    'get_workspace_execution_receipt',
    'get_pip_proposal',
    'list_workspace_overviews',
    'list_pending_pip_reviews',
    'list_recent_workspace_activity',
    'list_pip_adaptations',

    'get_pip',
    'get_pip_execution',
    'get_pip_handoff',
    'get_pip_run',
    'get_pip_runner',
    'get_workspace_context',
    'list_pip_approvals',
    'list_pip_app_links',
    'list_pip_routines',
    'list_pip_shared',
    'list_pip_apps',
    'get_pip_computers',
    'list_pip_checkpoints',
    'list_pip_handoffs',
    'list_pip_messages',
    'list_pip_models',
    'list_pip_run_activity',
    'list_pip_runs',
    'list_pip_types',
    'list_pip_versions',
    'list_pips',
    'list_workspace_activity',
    'list_workspaces',
]
PipMutationCommand = Literal[
    "allow_pip_plugin", "decline_pip_plugin",
    "set_pip_profile", "update_pip_computers", "reset_pip_computer",
    "add_pip_routine", "update_pip_routine", "delete_pip_routine", "decide_pip_routine",
    "start_pip_app_link", "check_pip_app_link", "decline_pip_app_link", "disconnect_pip_app_link", "finish_pip_computer_check",
    "add_pip_computer_file", "remove_pip_computer_file", "run_pip_computer_command",
    "always_allow_pip_computer_action", "decide_pip_computer_action", "stop_pip_computer", "open_pip_computer", "use_pip_computer_view",
    "always_allow_pip_app_action", "revoke_pip_action_grant", "set_pip_feedback", "set_pip_daily_cap", "set_pips_desktop_notifications", "set_pips_keep_running", "mark_pip_digest_seen", "set_pip_notify_settings",
    "prepare_pip_connector_draft", "dismiss_pip_connector_draft", "propose_pip_connector_action", "propose_pip_calendar_action", "prepare_pip_calendar_draft", "dismiss_pip_calendar_draft",
    "prepare_pip_message_draft", "dismiss_pip_message_draft",
    'propose_pip_app_action', 'accept_pip_app_action', 'reject_pip_app_action',
    'revise_pip_setup',
    'accept_pip_setup', 'reject_pip_setup',
    'record_pip_statement', 'revoke_pip_statement',
    'archive_pip', 'restore_pip',
    'record_pip_exception', 'revoke_pip_exception',
    'mark_pip_notification_read',
    'propose_workspace_session_outcome',
    'accept_workspace_session_outcome',
    'record_workspace_execution_context',
    'reject_workspace_session_outcome',
    'accept_pip_execution_context',
    'accept_pip_finding',
    'accept_pip_handoff',
    'accept_pip_update',
    'archive_workspace_context',
    'cancel_pip_run',
    'create_pip',
    'pause_pip',
    'propose_pip_personal_handoff',
    'propose_pip_artifact_handoff',
    'propose_pip_handoff',
    'propose_pip_update',
    'record_workspace_context',
    'reject_pip_handoff',
    'reject_pip_update',
    'resume_pip',
    'review_pip_execution',
    'review_pip_finding',
    'run_pip',
    'send_pip_message',
    'introduce_pip',
    'stop_pips',
]
READ_COMMANDS = frozenset(['get_pip_proposal', 'list_workspace_overviews', 'list_pending_pip_reviews', 'list_recent_workspace_activity', 'list_pip_adaptations', 'get_pip', 'get_pip_execution', 'get_pip_handoff', 'get_pip_run', 'get_pip_runner', 'get_workspace_context', 'list_pip_approvals', 'list_pip_checkpoints', 'list_pip_handoffs', 'list_pip_messages', 'list_pip_models', 'list_pip_run_activity', 'list_pip_runs', 'list_pip_types', 'list_pip_versions', 'list_pips', 'list_workspace_activity', 'list_workspaces'])
MUTATION_COMMANDS = frozenset(['propose_pip_personal_handoff', 'accept_pip_execution_context', 'accept_pip_finding', 'accept_pip_handoff', 'accept_pip_update', 'archive_workspace_context', 'cancel_pip_run', 'create_pip', 'pause_pip', 'propose_pip_artifact_handoff', 'propose_pip_handoff', 'propose_pip_update', 'record_workspace_context', 'reject_pip_handoff', 'reject_pip_update', 'resume_pip', 'review_pip_execution', 'review_pip_finding', 'run_pip', 'send_pip_message', 'stop_pips'])
API12_READS = frozenset({'list_workspace_sessions', 'inspect_workspace_session_outcome', 'get_workspace_session_outcome', 'list_workspace_session_outcomes'})
API12_MUTATIONS = frozenset({'propose_workspace_session_outcome', 'accept_workspace_session_outcome', 'reject_workspace_session_outcome'})
API12_COMMANDS = API12_READS | API12_MUTATIONS
READ_COMMANDS |= API12_READS
MUTATION_COMMANDS |= API12_MUTATIONS
API13_READS = frozenset({'list_pip_notifications'})
API13_MUTATIONS = frozenset({'mark_pip_notification_read'})
API13_COMMANDS = API13_READS | API13_MUTATIONS
READ_COMMANDS |= API13_READS
MUTATION_COMMANDS |= API13_MUTATIONS
API14_READS = frozenset({'get_pip_exception_source', 'list_pip_memories'})
API14_MUTATIONS = frozenset({'record_pip_exception', 'revoke_pip_exception'})
API14_COMMANDS = API14_READS | API14_MUTATIONS
READ_COMMANDS |= API14_READS
MUTATION_COMMANDS |= API14_MUTATIONS
API16_COMMANDS = frozenset({'archive_pip', 'restore_pip'})
MUTATION_COMMANDS |= API16_COMMANDS
API17_READS = frozenset({'list_workspace_execution_receipts', 'get_workspace_execution_receipt'})
API17_MUTATIONS = frozenset({'record_workspace_execution_context'})
API17_COMMANDS = API17_READS | API17_MUTATIONS
READ_COMMANDS |= API17_READS
MUTATION_COMMANDS |= API17_MUTATIONS
API19_READS = frozenset({'get_pip_statement_anchor', 'list_pip_statements'})
API19_MUTATIONS = frozenset({'record_pip_statement', 'revoke_pip_statement'})
API19_COMMANDS = API19_READS | API19_MUTATIONS
READ_COMMANDS |= API19_READS
MUTATION_COMMANDS |= API19_MUTATIONS
API23_READS = frozenset({'list_pip_setups', 'get_pip_setup'})
API23_MUTATIONS = frozenset({'accept_pip_setup', 'reject_pip_setup'})
API23_COMMANDS = API23_READS | API23_MUTATIONS
READ_COMMANDS |= API23_READS
MUTATION_COMMANDS |= API23_MUTATIONS
API25_MUTATIONS = frozenset({'revise_pip_setup'})
MUTATION_COMMANDS |= API25_MUTATIONS
API28_READS = frozenset({'list_pip_connections', 'inspect_pip_connection'})
READ_COMMANDS |= API28_READS | frozenset({'list_pip_accounts'})
API31_READS = frozenset({'inspect_pip_send_connection','get_pip_app_action','list_pip_app_actions'})
API31_MUTATIONS = frozenset({'propose_pip_app_action','accept_pip_app_action','reject_pip_app_action'})
READ_COMMANDS |= API31_READS
MUTATION_COMMANDS |= API31_MUTATIONS
API32_READS = frozenset({"get_pip_message_draft","list_pip_message_drafts"})
API32_MUTATIONS = frozenset({"prepare_pip_message_draft","dismiss_pip_message_draft"})
READ_COMMANDS |= API32_READS
MUTATION_COMMANDS |= API32_MUTATIONS
API34_READS = frozenset({'inspect_pip_calendar_connection'})
API34_MUTATIONS = frozenset({'propose_pip_calendar_action'})
READ_COMMANDS |= API34_READS
MUTATION_COMMANDS |= API34_MUTATIONS
API35_READS = frozenset({'get_pip_calendar_draft','list_pip_calendar_drafts'})
API35_MUTATIONS = frozenset({'prepare_pip_calendar_draft','dismiss_pip_calendar_draft'})
READ_COMMANDS |= API35_READS
MUTATION_COMMANDS |= API35_MUTATIONS
API36_READS = frozenset({'inspect_pip_connector_actions'})
API36_MUTATIONS = frozenset({'propose_pip_connector_action'})
READ_COMMANDS |= API36_READS
MUTATION_COMMANDS |= API36_MUTATIONS
API37_READS = frozenset({'get_pip_connector_draft','list_pip_connector_drafts'})
API37_MUTATIONS = frozenset({'prepare_pip_connector_draft','dismiss_pip_connector_draft'})
READ_COMMANDS |= API37_READS
MUTATION_COMMANDS |= API37_MUTATIONS
# API 41: the daily digest, per-Pip notification settings and finding outcomes. Local
# display state only; setting a threshold changes no job and grants nothing.
API41_READS = frozenset({'list_pip_action_grants', 'list_pip_feedback', 'export_pip', 'get_pip_usage', 'get_pips_desktop_notifications', 'get_pips_keep_running', 'get_pip_digest', 'get_pip_notify_settings', 'get_pip_outcomes'})
API41_MUTATIONS = frozenset({'always_allow_pip_app_action', 'revoke_pip_action_grant', 'set_pip_feedback', 'set_pip_daily_cap', 'set_pips_desktop_notifications', 'set_pips_keep_running', 'mark_pip_digest_seen', 'set_pip_notify_settings'})
READ_COMMANDS |= API41_READS
MUTATION_COMMANDS |= API41_MUTATIONS
# API 42: Pip computers. Decisions release or drop one held browser write; local only.
API42_READS = frozenset({'get_pip_computer', 'list_pip_computer_actions', 'get_pip_computer_frame', 'list_pip_computer_frames'})
API42_MUTATIONS = frozenset({'always_allow_pip_computer_action', 'decide_pip_computer_action', 'stop_pip_computer', 'open_pip_computer', 'use_pip_computer_view'})
READ_COMMANDS |= API42_READS
MUTATION_COMMANDS |= API42_MUTATIONS
# API 43: a new Personal Pip speaks first.
API43_MUTATIONS = frozenset({'introduce_pip'})
MUTATION_COMMANDS |= API43_MUTATIONS
# API 43: the images sent in a Pip's chat, one at a time.
API43_READS = frozenset({'get_pip_message_image'})
READ_COMMANDS |= API43_READS
# API 43: a Pip computer's Files and Terminal (its browser is API 42).
API43_READS |= {'list_pip_computer_files', 'read_pip_computer_file', 'list_pip_computer_terminal', 'get_pip_computer_desktop'}
API43_MUTATIONS |= {'add_pip_computer_file', 'remove_pip_computer_file', 'run_pip_computer_command'}
# API 43: a Personal Pip's own apps, connected from its chat, and a robot check finished on its computer.
API43_READS |= {'list_pip_app_links'}
API43_MUTATIONS |= {'start_pip_app_link', 'check_pip_app_link', 'decline_pip_app_link', 'disconnect_pip_app_link', 'finish_pip_computer_check'}
# API 43: a Personal Pip's routines: timed, or on new email or an upcoming calendar event; local only.
API43_READS |= {'list_pip_routines'}
API43_MUTATIONS |= {'add_pip_routine', 'update_pip_routine', 'delete_pip_routine', 'decide_pip_routine'}
# API 43: a Personal Pip's page (look, title, notifications; what its chat shared), its computer's
# settings, and every app your Pips use; local only.
API43_READS |= {'list_pip_shared', 'get_pip_computers', 'list_pip_apps'}
API43_MUTATIONS |= {'set_pip_profile', 'update_pip_computers', 'reset_pip_computer'}
READ_COMMANDS |= API43_READS
MUTATION_COMMANDS |= API43_MUTATIONS
# API 44: a Personal Pip's plugins. It asks to use one; you allow it, or not, on its card; local only.
API44_READS = frozenset({'list_pip_plugins', 'list_pip_plugin_uses'})
API44_MUTATIONS = frozenset({'allow_pip_plugin', 'decline_pip_plugin'})
READ_COMMANDS |= API44_READS
MUTATION_COMMANDS |= API44_MUTATIONS
COMMAND_FIELDS = {
    'list_pip_plugins': frozenset({'pip_id'}),
    'allow_pip_plugin': frozenset({'pip_id', 'grant_id'}),
    'decline_pip_plugin': frozenset({'pip_id', 'grant_id'}),
    'list_pip_plugin_uses': frozenset(),
    'set_pip_profile': frozenset({'pip_id', 'changes'}),
    'list_pip_shared': frozenset({'pip_id', 'kind'}),
    'get_pip_computers': frozenset(),
    'update_pip_computers': frozenset(),
    'reset_pip_computer': frozenset({'pip_id'}),
    'list_pip_apps': frozenset(),
    'list_pip_routines': frozenset({'pip_id'}),
    'add_pip_routine': frozenset({'pip_id', 'title', 'prompt', 'trigger'}),
    'update_pip_routine': frozenset({'pip_id', 'routine_id', 'changes'}),
    'delete_pip_routine': frozenset({'pip_id', 'routine_id'}),
    'decide_pip_routine': frozenset({'pip_id', 'routine_id', 'add'}),
    'list_pip_app_links': frozenset({'pip_id'}),
    'start_pip_app_link': frozenset({'pip_id', 'link_id'}),
    'check_pip_app_link': frozenset({'pip_id', 'link_id'}),
    'decline_pip_app_link': frozenset({'pip_id', 'link_id'}),
    'disconnect_pip_app_link': frozenset({'pip_id', 'link_id'}),
    'finish_pip_computer_check': frozenset({'pip_id'}),
    'always_allow_pip_computer_action': frozenset({'action_id', 'expected_digest'}),
    'list_pip_computer_files': frozenset({'pip_id', 'path'}),
    'read_pip_computer_file': frozenset({'pip_id', 'path'}),
    'add_pip_computer_file': frozenset({'pip_id', 'path', 'name', 'data'}),
    'remove_pip_computer_file': frozenset({'pip_id', 'path'}),
    'run_pip_computer_command': frozenset({'pip_id', 'command'}),
    'list_pip_computer_terminal': frozenset({'pip_id'}),
    'get_pip_computer_desktop': frozenset({'pip_id'}),
    'get_pip_computer': frozenset({'pip_id'}),
    'list_pip_computer_actions': frozenset({'pip_id', 'limit'}),
    'get_pip_computer_frame': frozenset({'run_id', 'frame'}),
    'list_pip_computer_frames': frozenset({'run_id'}),
    'decide_pip_computer_action': frozenset({'action_id', 'expected_digest', 'approve'}),
    'stop_pip_computer': frozenset({'pip_id'}),
    'open_pip_computer': frozenset({'pip_id'}),
    'use_pip_computer_view': frozenset({'pip_id', 'op', 'x', 'y', 'text', 'key', 'dy', 'url'}),
    'list_pip_action_grants': frozenset({'pip_id'}),
    'always_allow_pip_app_action': frozenset({'action_id', 'expected_digest'}),
    'revoke_pip_action_grant': frozenset({'pip_id', 'grant_id'}),
    'list_pip_feedback': frozenset({'pip_id'}),
    'set_pip_feedback': frozenset({'run_id', 'rating', 'note'}),
    'export_pip': frozenset({'pip_id'}),
    'get_pip_usage': frozenset({'pip_id'}),
    'set_pip_daily_cap': frozenset({'pip_id', 'daily_tokens'}),
    'get_pips_desktop_notifications': frozenset(),
    'set_pips_desktop_notifications': frozenset({'enabled'}),
    'get_pips_keep_running': frozenset(),
    'set_pips_keep_running': frozenset({'enabled'}),
    'get_pip_digest': frozenset(),
    'mark_pip_digest_seen': frozenset({'until'}),
    'get_pip_notify_settings': frozenset({'pip_id'}),
    'set_pip_notify_settings': frozenset({'pip_id', 'min_severity', 'alert_severity', 'expected_revision'}),
    'get_pip_outcomes': frozenset({'pip_id'}),
    'get_pip_connector_draft': frozenset({'draft_id'}),
    'list_pip_connector_drafts': frozenset({'pip_id','before_id','limit'}),
    'prepare_pip_connector_draft': frozenset({'draft_id','expected_digest','call'}),
    'dismiss_pip_connector_draft': frozenset({'draft_id','expected_digest'}),
    'inspect_pip_connector_actions': frozenset({'server'}),
    'propose_pip_connector_action': frozenset({'source_run_id','server','connection_digest','schema_digest','call','request_key'}),
    'get_pip_calendar_draft': frozenset({'draft_id'}),
    'list_pip_calendar_drafts': frozenset({'pip_id','before_id','limit'}),
    'prepare_pip_calendar_draft': frozenset({'draft_id','expected_digest','server','connection_digest','account','schema_digest','event'}),
    'dismiss_pip_calendar_draft': frozenset({'draft_id','expected_digest'}),
    'inspect_pip_calendar_connection': frozenset({'server'}),
    'propose_pip_calendar_action': frozenset({'source_run_id','server','connection_digest','account','schema_digest','event','request_key'}),
    'get_pip_message_draft': frozenset({'draft_id'}),
    'list_pip_message_drafts': frozenset({'pip_id','before_id','limit'}),
    'prepare_pip_message_draft': frozenset({'draft_id','expected_digest','server','connection_digest','account','schema_digest','message'}),
    'dismiss_pip_message_draft': frozenset({'draft_id','expected_digest'}),
    'inspect_pip_send_connection': frozenset({'server'}),
    'propose_pip_app_action': frozenset({'source_run_id','server','connection_digest','account','schema_digest','message','request_key'}),
    'get_pip_app_action': frozenset({'action_id'}),
    'list_pip_app_actions': frozenset({'pip_id','before_id','limit'}),
    'accept_pip_app_action': frozenset({'action_id','expected_digest'}),
    'reject_pip_app_action': frozenset({'action_id','expected_digest'}),
    'list_pip_connections': frozenset(),
    'inspect_pip_connection': frozenset({'server'}),
    'propose_pip_personal_handoff': frozenset({'source_run_id','target_pip_id','shared_text','task','idempotency_key'}),
    'list_pip_accounts': frozenset({'server'}),
    'revise_pip_setup': frozenset({'setup_id', 'expected_digest', 'model_choice'}),
    'list_pip_setups': frozenset({'workspace_id'}),
    'get_pip_setup': frozenset({'setup_id'}),
    'accept_pip_setup': frozenset({'setup_id', 'expected_digest'}),
    'reject_pip_setup': frozenset({'setup_id', 'expected_digest'}),
    'get_pip_statement_anchor': frozenset({'pip_id', 'source_run_id'}),
    'list_pip_statements': frozenset({'pip_id', 'before_id', 'limit'}),
    'record_pip_statement': frozenset({'pip_id', 'kind', 'title', 'statement', 'reason', 'expires_at', 'expected_anchor_digest', 'request_key', 'source_run_id'}),
    'revoke_pip_statement': frozenset({'pip_id', 'memory_id', 'expected_revision', 'reason'}),
    'list_workspace_execution_receipts': frozenset({'workspace_id', 'session_id', 'before_id', 'limit'}),
    'get_workspace_execution_receipt': frozenset({'workspace_id', 'attempt_id'}),
    'record_workspace_execution_context': frozenset({'workspace_id', 'attempt_id', 'expected_attempt_digest', 'expected_final_digest', 'expected_view_digest', 'expected_context_revision'}),
    'archive_pip': frozenset({'pip_id', 'expected_version', 'expected_lifecycle_revision', 'request_key', 'reason'}),
    'restore_pip': frozenset({'pip_id', 'expected_version', 'expected_lifecycle_revision', 'request_key', 'reason'}),
    'get_pip_exception_source': frozenset({'pip_id', 'run_id', 'finding_index'}),
    'list_pip_memories': frozenset({'pip_id', 'before_id', 'limit'}),
    'record_pip_exception': frozenset({'pip_id', 'run_id', 'finding_index', 'expected_source_digest', 'reason', 'expires_at', 'request_key'}),
    'revoke_pip_exception': frozenset({'pip_id', 'memory_id', 'expected_revision', 'reason'}),
    'list_pip_notifications': frozenset({'workspace_id', 'before_seq', 'limit'}),
    'mark_pip_notification_read': frozenset({'workspace_id', 'notification_id', 'expected_revision'}),
    'list_workspace_sessions': frozenset({'workspace_id', 'after', 'limit'}),
    'inspect_workspace_session_outcome': frozenset({'workspace_id', 'session_id'}),
    'propose_workspace_session_outcome': frozenset({'workspace_id', 'session_id', 'title', 'statement', 'source', 'expected_session_revision', 'request_key'}),
    'get_workspace_session_outcome': frozenset({'workspace_id', 'proposal_id'}),
    'list_workspace_session_outcomes': frozenset({'workspace_id', 'before_id', 'limit'}),
    'accept_workspace_session_outcome': frozenset({'workspace_id', 'proposal_id', 'expected_digest', 'expected_context_revision'}),
    'reject_workspace_session_outcome': frozenset({'workspace_id', 'proposal_id', 'expected_digest'}),
    'get_pip_proposal': frozenset(['pip_id', 'proposal_id']),
    'list_workspace_overviews': frozenset(['after_id', 'limit']),
    'list_pending_pip_reviews': frozenset(['before_id', 'limit', 'workspace_id']),
    'list_recent_workspace_activity': frozenset(['before_seq', 'limit', 'workspace_id']),
    'list_pip_adaptations': frozenset(['before_id', 'limit', 'pip_id']),

    'accept_pip_execution_context': frozenset(['expected_review_revision', 'expected_revision', 'run_id', 'workspace_id']),
    'accept_pip_finding': frozenset(['expected_revision', 'finding_index', 'run_id', 'workspace_id']),
    'accept_pip_handoff': frozenset(['expected_revision', 'handoff_id']),
    'accept_pip_update': frozenset(['expected_version', 'pip_id', 'proposal_id']),
    'archive_workspace_context': frozenset(['entry_id', 'expected_revision', 'workspace_id']),
    'cancel_pip_run': frozenset(['run_id']),
    'create_pip': frozenset(['goal', 'model_choice', 'name', 'pip_type', 'source_ref', 'workspace_id']),
    'get_pip': frozenset(['pip_id']),
    'get_pip_execution': frozenset([]),
    'get_pip_handoff': frozenset(['handoff_id']),
    'get_pip_run': frozenset(['run_id']),
    'get_pip_runner': frozenset([]),
    'get_workspace_context': frozenset(['workspace_id']),
    'list_pip_approvals': frozenset(['before_id', 'limit', 'pip_id']),
    'list_pip_checkpoints': frozenset(['before_id', 'limit', 'pip_id']),
    'list_pip_handoffs': frozenset(['before_id', 'limit', 'pip_id']),
    'list_pip_messages': frozenset(['before_id', 'limit', 'pip_id']),
    'list_pip_models': frozenset([]),
    'list_pip_run_activity': frozenset(['after', 'run_id']),
    'list_pip_runs': frozenset(['pip_id']),
    'list_pip_types': frozenset([]),
    'list_pip_versions': frozenset(['before_version', 'limit', 'pip_id']),
    'list_pips': frozenset(['workspace_id']),
    'list_workspace_activity': frozenset(['after', 'workspace_id']),
    'list_workspaces': frozenset([]),
    'pause_pip': frozenset(['pip_id', 'expected_lifecycle_revision']),
    'propose_pip_artifact_handoff': frozenset(['action', 'idempotency_key', 'source_run_id', 'target_pip_id', 'task']),
    'propose_pip_handoff': frozenset(['action', 'finding_index', 'idempotency_key', 'source_run_id', 'target_pip_id', 'task']),
    'propose_pip_update': frozenset(['changes', 'expected_version', 'pip_id', 'reason']),
    'record_workspace_context': frozenset(['content', 'expected_revision', 'kind', 'title', 'workspace_id']),
    'reject_pip_handoff': frozenset(['expected_revision', 'handoff_id', 'reason']),
    'reject_pip_update': frozenset(['expected_version', 'pip_id', 'proposal_id']),
    'resume_pip': frozenset(['pip_id', 'expected_lifecycle_revision']),
    'review_pip_execution': frozenset(['expected_revision', 'reason', 'run_id', 'status']),
    'review_pip_finding': frozenset(['expected_revision', 'finding_index', 'reason', 'run_id', 'status']),
    'run_pip': frozenset(['idempotency_key', 'pip_id', 'expected_version', 'expected_lifecycle_revision', 'expected_plan_digest']),
    'send_pip_message': frozenset(['chat_options', 'files', 'idempotency_key', 'images', 'pip_id', 'text']),
    'get_pip_message_image': frozenset(['index', 'message_id', 'pip_id']),
    'introduce_pip': frozenset(['pip_id']),
    'stop_pips': frozenset([]),
}

MAX_REQUEST_BYTES = 32768
# Images sent with a Pip message travel outside that budget: 4 data URIs, 2 MiB of image in all.
MAX_IMAGE_URI_CHARS = 2_800_000


def _detach(params: Mapping[str, Any]) -> dict[str, Any]:
    # Reject excess depth/nodes/bytes before JSON encoding or copying. JSON only:
    # no custom encoders, coercion, cycles or caller-controlled toJSON hooks.
    nodes = 0
    budget = MAX_REQUEST_BYTES
    def visit(value: Any, depth: int = 0) -> None:
        nonlocal nodes, budget
        nodes += 1
        if nodes > 2048 or depth > 12:
            raise DGCConfigError("Pip parameters exceed the nesting or item limit")
        if isinstance(value, str):
            if len(value) > MAX_REQUEST_BYTES:
                raise DGCConfigError("Pip parameters exceed 32 KiB")
            try:
                budget -= len(value.encode("utf-8"))
            except UnicodeError as exc:
                raise DGCConfigError("Pip parameters must contain valid Unicode") from exc
        elif value is None or type(value) is bool:
            budget -= 5
        elif type(value) is int:
            if not -(2**53 - 1) <= value <= 2**53 - 1:
                raise DGCConfigError("Pip integers must be safe JSON integers")
            budget -= 20
        elif type(value) is float and math.isfinite(value):
            budget -= 24
        elif type(value) is list:
            if len(value) > 2048:
                raise DGCConfigError("Pip parameters exceed the item limit")
            budget -= len(value) + 2
            for item in value:
                visit(item, depth + 1)
        elif type(value) is dict:
            if len(value) > 128:
                raise DGCConfigError("Pip parameters contain too many fields")
            budget -= len(value) * 3 + 2
            for key, item in value.items():
                if not isinstance(key, str) or len(key) > 128:
                    raise DGCConfigError("Pip parameter keys must be short strings")
                visit(key, depth + 1)
                visit(item, depth + 1)
        else:
            raise DGCConfigError("Pip parameters must contain only JSON values")
        if budget < 0:
            raise DGCConfigError("Pip parameters exceed 32 KiB")
    if type(params) is not dict:
        raise DGCConfigError("Pip parameters must be a plain object")
    visit(params)
    return json.loads(json.dumps(params, ensure_ascii=False, allow_nan=False))


class Pips:
    """Controls for an already enabled Pips installation.

    ``approved=True`` is a host application's deliberate decision for exactly one
    mutation, not a model tool grant. Never expose ``mutate`` as an unattended tool.
    Backend scope, review revisions, permissions and runner checks remain authoritative.
    """

    def __init__(self, session: "Session"):
        self._session = session

    def read(self, command: PipReadCommand, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Read one known capability-gated control, returning its result object."""
        return self._call(command, {} if params is None else params, mutation=False, approved=False)

    def mutate(self, command: PipMutationCommand, params: Mapping[str, Any], *,
               approved: bool = False) -> dict[str, Any]:
        """Perform a named mutation only with explicit per-call host approval."""
        return self._call(command, params, mutation=True, approved=approved)

    def _call(self, command: str, params: Mapping[str, Any], *, mutation: bool,
              approved: bool) -> dict[str, Any]:
        session = self._session
        if not isinstance(command, str) or command not in (MUTATION_COMMANDS if mutation else READ_COMMANDS):
            raise DGCConfigError("Unknown or incorrectly classified Pip command")
        if mutation and approved is not True:
            raise DGCConfigError("Pip mutations require explicit approved=True for this request")
        if session._isolated:
            raise DGCUnsupportedError("Pips controls use an existing local profile; create an explicitly authorized controller with inherit_user_state=True")
        if session._policy is not None or session.sandbox.requirement != "off" or session.sandbox.active:
            raise DGCUnsupportedError("Pips cannot inherit this session's RuntimePolicy or sandbox; use a separate unrestricted, explicitly authorized control session")
        if mutation and session._permission_mode == "plan":
            raise DGCUnsupportedError("Pip mutations are unavailable in plan mode")
        caps = session._ready.get("capabilities", {})
        version = caps.get("pips_api_version") if isinstance(caps, dict) else None
        minimum = 10 if command in ('get_pip_proposal', 'list_workspace_overviews', 'list_pending_pip_reviews', 'list_recent_workspace_activity', 'list_pip_adaptations') else (9 if command == "accept_pip_execution_context" else 8)
        if command in API44_MUTATIONS | API44_READS:
            minimum = 44
        elif command in API43_MUTATIONS | API43_READS:
            minimum = 43
        elif command in API42_READS | API42_MUTATIONS:
            minimum = 42
        elif command in API41_READS | API41_MUTATIONS:
            minimum = 41
        elif command in API37_READS | API37_MUTATIONS:
            minimum = 37
        elif command in API36_READS | API36_MUTATIONS:
            minimum = 36
        elif command in API35_READS | API35_MUTATIONS:
            minimum = 35
        elif command in API34_READS | API34_MUTATIONS:
            minimum = 34
        elif command in API32_READS | API32_MUTATIONS:
            minimum = 32
        elif command in API31_READS | API31_MUTATIONS:
            minimum = 31
        elif command == 'propose_pip_personal_handoff':
            minimum = 30
        elif command == 'list_pip_accounts':
            minimum = 29
        elif command in API28_READS:
            minimum = 28
        elif command in API12_COMMANDS:
            minimum = 12
        elif command in API13_COMMANDS:
            minimum = 13
        elif command in API14_COMMANDS:
            minimum = 14
        elif command in API16_COMMANDS:
            minimum = 16
        elif command in API17_COMMANDS:
            minimum = 17
        elif command in API19_COMMANDS:
            minimum = 19
        elif command in API23_COMMANDS:
            minimum = 23
        elif command in API25_MUTATIONS:
            minimum = 25
        if not isinstance(caps, dict) or caps.get("pips_supported") is not True or type(version) is not int or version < minimum:
            raise DGCUnsupportedError(f"This control requires a runtime advertising Pips API {minimum} or newer")
        if caps.get("pips_enabled") is not True:
            raise DGCUnsupportedError("Enable Pips locally and open a new control session; the SDK does not enable it")
        images = None
        if command == 'send_pip_message' and type(params) is dict and 'images' in params:
            if version < 43:
                raise DGCUnsupportedError('Images in a Pip chat require a runtime advertising Pips API 43 or newer')
            images = params['images']
            if (type(images) is not list or not 1 <= len(images) <= 4
                    or any(type(i) is not str or not i.startswith('data:image/') or not i.isascii() for i in images)
                    or sum(len(i) for i in images) > MAX_IMAGE_URI_CHARS):
                raise DGCConfigError('images must be 1 to 4 image data URIs, 2 MB in all')
            images, params = list(images), {key: value for key, value in params.items() if key != 'images'}
        files = None
        if command == 'send_pip_message' and type(params) is dict and 'files' in params:
            # Files sent with a message travel with its images, outside the 32 KiB budget: 4, 2 MB in all.
            if version < 43:
                raise DGCUnsupportedError('Files in a Pip chat require a runtime advertising Pips API 43 or newer')
            files = params['files']
            if (type(files) is not list or not 1 <= len(files) <= 4
                    or any(type(f) is not dict or set(f) != {'name', 'data'} or type(f['name']) is not str
                           or not f['name'].strip() or len(f['name']) > 255 or any(c in f['name'] for c in '/\\"')
                           or any(ord(c) < 32 for c in f['name']) or type(f['data']) is not str
                           or not f['data'].startswith('data:') or ';base64,' not in f['data'][:200]
                           or not f['data'].isascii() for f in files)
                    or sum(len(f['data']) for f in files) + sum(len(i) for i in images or []) > MAX_IMAGE_URI_CHARS):
                raise DGCConfigError('files must be 1 to 4 {name, data} entries, 2 MB in all with any images')
            files, params = [dict(f) for f in files], {key: value for key, value in params.items() if key != 'files'}
        file_data = None
        if command == 'add_pip_computer_file' and type(params) is dict and 'data' in params:
            # A file added to a Pip's computer also travels outside the 32 KiB budget: one data URI, 2 MB.
            file_data = params['data']
            if (type(file_data) is not str or not file_data.startswith('data:') or ';base64,' not in file_data[:200]
                    or not file_data.isascii() or len(file_data) > MAX_IMAGE_URI_CHARS):
                raise DGCConfigError('data must be one data URI of 2 MB or less')
            params = {key: value for key, value in params.items() if key != 'data'}
        values = _detach(params)
        if (command in ('propose_pip_calendar_action','prepare_pip_calendar_draft')
                and isinstance(values.get('event'),dict)
                and {'attendees','repeat','send_invitations'}.intersection(values['event']) and version < 38):
            raise DGCUnsupportedError('Calendar invitations and finite series require Pips API 38 or newer')
        if command in ("pause_pip", "resume_pip") and "expected_lifecycle_revision" in values and version < 16:
            raise DGCUnsupportedError("Reviewed lifecycle revisions require a runtime advertising Pips API 16 or newer")
        if set(values) - COMMAND_FIELDS[command]:
            raise DGCConfigError("Unknown or reserved Pip parameter")
        if (command == 'propose_pip_update' and isinstance(values.get('changes'), dict)
                and 'app_plan' in values['changes'] and version < 28):
            raise DGCUnsupportedError('Reviewed personal app reads require Pips API 28 or newer')
        if (command == 'propose_pip_update' and isinstance(values.get('changes'), dict)
                and 'web_plan' in values['changes'] and version < 40):
            raise DGCUnsupportedError('Reviewed personal web reads require Pips API 40 or newer')
        if (command == 'propose_pip_update' and isinstance(values.get('changes'), dict)
                and 'github_plan' in values['changes'] and version < 41):
            raise DGCUnsupportedError('Reviewed GitHub reads require Pips API 41 or newer')
        if (command == 'propose_pip_update' and isinstance(values.get('changes'), dict)
                and 'computer_plan' in values['changes'] and version < 42):
            raise DGCUnsupportedError('Pip computers require Pips API 42 or newer')
        plan = values.get('changes', {}).get('app_plan') if isinstance(values.get('changes'), dict) else None
        if command == 'propose_pip_update' and isinstance(plan, dict) and plan.get('schema_version') == 3 and version < 39:
            raise DGCUnsupportedError('Additional app searches require Pips API 39 or newer')
        if command == 'propose_pip_update' and isinstance(plan, dict) and plan.get('schema_version') == 2 and version < 33:
            raise DGCUnsupportedError('Recurring calendar windows require Pips API 33 or newer')
        if command == 'send_pip_message' and 'chat_options' in values:
            if version < 24:
                raise DGCUnsupportedError('Per-message reply controls require a runtime advertising Pips API 24 or newer')
            options = values['chat_options']
            if (type(options) is not dict or set(options) != {'context_size', 'thinking'}
                    or type(options['context_size']) is not int
                    or not 2048 <= options['context_size'] <= 1048576
                    or type(options['thinking']) is not str
                    or options['thinking'] not in ('off', 'low', 'medium', 'high', 'xhigh')):
                raise DGCConfigError('chat_options requires only context_size (integer 2048–1048576) and thinking (off, low, medium, high, xhigh)')
            if options['context_size'] > 32768 and version < 25:
                raise DGCUnsupportedError('Reply contexts above 32768 require a runtime advertising Pips API 25 or newer')
        if (command == 'propose_pip_update' and isinstance(values.get('changes'), dict)
                and 'source_policy' in values['changes'] and version < 11):
            raise DGCUnsupportedError('Reviewed source policies require a runtime advertising Pips API 11 or newer')
        changes = values.get('changes')
        if version < 21 and (
                (command == 'propose_pip_update' and isinstance(changes, dict) and 'verification_plan' in changes)
                or (command == 'run_pip' and {'expected_version', 'expected_lifecycle_revision', 'expected_plan_digest'} & values.keys())):
            raise DGCUnsupportedError('Reviewed standalone Pulse plans require a runtime advertising Pips API 21 or newer')
        trigger = changes.get('event_trigger') if isinstance(changes, dict) else None
        if (command == 'propose_pip_update' and isinstance(trigger, dict) and version < 22
                and ('commit_paths' in trigger or (isinstance(trigger.get('events'), list)
                     and 'committed_paths_changed' in trigger['events']))):
            raise DGCUnsupportedError('Reviewed committed-path triggers require a runtime advertising Pips API 22 or newer')
        if (command == 'propose_pip_update' and isinstance(trigger, dict)
                and isinstance(trigger.get('events'), list)
                and 'session_turn_completed' in trigger['events'] and version < 18):
            raise DGCUnsupportedError('Saved foreground turn triggers require a runtime advertising Pips API 18 or newer')
        if (command in ('propose_pip_handoff', 'propose_pip_artifact_handoff')
                and isinstance(values.get('action'), dict) and 'specialists' in values['action'] and version < 15):
            raise DGCUnsupportedError('Reviewed specialist delegation requires a runtime advertising Pips API 15 or newer')
        rid = "sdk-pips-" + uuid.uuid4().hex
        request = {"type": command, "request_id": rid, **values}
        if len(json.dumps(request, ensure_ascii=False, allow_nan=False).encode("utf-8")) > MAX_REQUEST_BYTES:
            raise DGCConfigError("Pip request exceeds 32 KiB")
        if images is not None:
            request["images"] = images
        if files is not None:
            request["files"] = files
        if file_data is not None:
            request["data"] = file_data
        event = session._request({"type": "pips_control", "request": request}, "pips_result", request_id=rid)
        if event.get("request_id") != rid or event.get("command") != command or type(event.get("ok")) is not bool:
            raise DGCProtocolError("Mismatched or malformed Pip response")
        if event["ok"]:
            if type(event.get("result")) is not dict:
                raise DGCProtocolError("Pip response has no result object")
            return event["result"]
        error = event.get("error")
        if not isinstance(error, dict) or not isinstance(error.get("code"), str) or not isinstance(error.get("message"), str):
            raise DGCProtocolError("Pip failure has no structured error")
        raise DGCCommandRejectedError(error["message"], reason=error["code"], command=command)

    def list(self, workspace_id: str) -> dict[str, Any]:
        return self.read("list_pips", {"workspace_id": workspace_id})

    def get(self, pip_id: str) -> dict[str, Any]:
        return self.read("get_pip", {"pip_id": pip_id})

    def runs(self, pip_id: str) -> dict[str, Any]:
        return self.read("list_pip_runs", {"pip_id": pip_id})

    def get_run(self, run_id: str) -> dict[str, Any]:
        """Read a run; this does not enqueue work."""
        return self.read("get_pip_run", {"run_id": run_id})


class AsyncPips:
    """Async parity; control waits run on a worker thread like AsyncSession."""

    def __init__(self, sync: Pips):
        self._sync = sync

    async def read(self, command: PipReadCommand, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.read, command, params)

    async def mutate(self, command: PipMutationCommand, params: Mapping[str, Any], *, approved: bool = False) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.mutate, command, params, approved=approved)

    async def list(self, workspace_id: str) -> dict[str, Any]:
        return await self.read("list_pips", {"workspace_id": workspace_id})

    async def get(self, pip_id: str) -> dict[str, Any]:
        return await self.read("get_pip", {"pip_id": pip_id})

    async def runs(self, pip_id: str) -> dict[str, Any]:
        return await self.read("list_pip_runs", {"pip_id": pip_id})

    async def get_run(self, run_id: str) -> dict[str, Any]:
        return await self.read("get_pip_run", {"run_id": run_id})
