"""Local Pips commands. No cloud sign-in and no transient background execution."""
from __future__ import annotations

import argparse
import json
import os
import stat
import sqlite3
import sys
from pathlib import Path

from .workspace_registry import RegistryError, WorkspaceRegistry, canonical_directory, identifier, state_directory


def parser():
    value = argparse.ArgumentParser(prog="dgc pips", allow_abbrev=False,
        description="Manage local Pips, reviewed handoffs, bounded execution, schedules and reports.",
        epilog="First: dgc pips enable. In another terminal: dgc pips serve. Then create a Pip and queue a run.")
    value.add_argument("--json", action="store_true", help="print structured JSON")
    commands = value.add_subparsers(dest="command", required=True)

    def command(name, help):
        result = commands.add_parser(name, help=help, allow_abbrev=False)
        result.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        return result

    def workspace(target):
        selection = target.add_mutually_exclusive_group()
        selection.add_argument("--workspace", dest="workspace_id", help="explicit local workspace ID; default is the current directory")
        selection.add_argument("--personal", action="store_true", help="use personal Pips across project directories")

    def job(target):
        target.add_argument("pip_id", help="Pip ID from list")

    command("enable", "enable Pips locally through Config.set")
    command("execution", "inspect this runner’s bounded execution support and limits")
    command("models", "list models on the configured native connection")
    command("connections", "list existing Settings connections and scoped Pip support")
    command("accounts", "list connected account identities without reading app data").add_argument("server")
    command("inspect-connection", "inspect supported read tools on an existing connection").add_argument("server")
    email=command('email-draft','review a model-written email before choosing an account')
    email_commands=email.add_subparsers(dest='email_action',required=True)
    for action in ('list','show','prepare','dismiss'):
        item=email_commands.add_parser(action,allow_abbrev=False)
        item.add_argument('--json',action='store_true',default=argparse.SUPPRESS)
        if action=='list':
            job(item);item.add_argument('--before-id');item.add_argument('--limit',type=int,default=20)
        else:item.add_argument('draft_id')
        if action in ('prepare','dismiss'):item.add_argument('--expected-digest',required=True)
        if action=='prepare':
            for name in ('server','connection-digest','account','schema-digest'):item.add_argument('--'+name,required=True)
            payload=item.add_mutually_exclusive_group()
            payload.add_argument('--message-json',dest='action_json')
            payload.add_argument('--message-file',dest='action_file')
    calendar_draft=command('calendar-draft','review inert calendar drafts before choosing an account and preparing an action')
    calendar_actions=calendar_draft.add_subparsers(dest='calendar_action',required=True)
    for action in ('list','show','prepare','dismiss'):
        item=calendar_actions.add_parser(action,allow_abbrev=False)
        item.add_argument('--json',action='store_true',default=argparse.SUPPRESS)
        if action=='list':
            job(item);item.add_argument('--before-id');item.add_argument('--limit',type=int,default=20)
        else:item.add_argument('draft_id')
        if action in ('prepare','dismiss'):item.add_argument('--expected-digest',required=True)
        if action=='prepare':
            for name in ('server','connection-digest','account','schema-digest'):item.add_argument('--'+name,required=True)
            payload=item.add_mutually_exclusive_group()
            payload.add_argument('--event-json',dest='action_json')
            payload.add_argument('--event-file',dest='action_file')
    connector_draft=command('connector-draft','review model-written connector actions before a separate execution approval')
    connector_commands=connector_draft.add_subparsers(dest='connector_draft_action',required=True)
    for action in ('list','show','prepare','dismiss'):
        item=connector_commands.add_parser(action,allow_abbrev=False)
        item.add_argument('--json',action='store_true',default=argparse.SUPPRESS)
        if action=='list':
            job(item);item.add_argument('--before-id');item.add_argument('--limit',type=int,default=20)
        else:item.add_argument('draft_id')
        if action in ('prepare','dismiss'):item.add_argument('--expected-digest',required=True)
        if action=='prepare':
            payload=item.add_mutually_exclusive_group()
            payload.add_argument('--call-json',dest='action_json')
            payload.add_argument('--call-file',dest='action_file')
    app_action=command('app-action','prepare and separately review an exact email, calendar event or connector call')
    app_actions=app_action.add_subparsers(dest='app_action',required=True)
    for action in ('inspect','propose','show','list','accept','reject'):
        item=app_actions.add_parser(action,allow_abbrev=False)
        item.add_argument('--json',action='store_true',default=argparse.SUPPRESS)
        if action=='inspect':
            item.add_argument('server');item.add_argument('--kind',choices=('gmail_send','calendar_create','connector_call'),default='gmail_send')
        elif action=='propose':
            item.add_argument('--kind',choices=('gmail_send','calendar_create','connector_call'),default='gmail_send')
            item.add_argument('source_run_id');item.add_argument('--server',required=True)
            for name in ('connection-digest','schema-digest','request-key'):item.add_argument('--'+name,required=True)
            item.add_argument('--account',help='required for email/calendar; connector calls use their saved connection')
            payload=item.add_mutually_exclusive_group(required=True)
            payload.add_argument('--message-json','--event-json','--call-json',dest='action_json',help='exact message or calendar event JSON for the selected kind')
            payload.add_argument('--message-file','--event-file','--call-file',dest='action_file',help='bounded UTF-8 JSON file containing the exact action')
        elif action=='list':
            job(item);item.add_argument('--before-id');item.add_argument('--limit',type=int,default=20)
        else:
            item.add_argument('action_id')
            if action in ('accept','reject'):item.add_argument('--expected-digest',required=True)
            if action=='accept':item.add_argument('--yes',action='store_true',help='confirm one attempt for the exact displayed external action')
    command("types", "list Pip characters and the source-only roles available on this runner")
    command("workspaces", "list registered local workspaces")
    identity = command("workspace", "inspect session identity, backfill history, or repair a moved directory")
    identity_actions = identity.add_subparsers(dest="workspace_action", required=True)
    for action in ("show", "sessions", "backfill", "rebind", "migrate-session"):
        item = identity_actions.add_parser(action, allow_abbrev=False)
        item.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        if action in ("show", "sessions"):
            workspace(item)
        if action in ("sessions", "backfill"):
            item.add_argument("--limit", type=int, default=50)
            item.add_argument("--after", default="", help="cursor returned by the previous page")
        if action == "backfill":
            item.add_argument("--apply", action="store_true", help="associate validated saved sessions; default is a read-only preview")
        if action == "rebind":
            item.add_argument("workspace_id")
            item.add_argument("new_root", help="existing directory after the move")
            item.add_argument("--expected-root", required=True, help="previous canonical directory, for conflict detection")
            item.add_argument("--apply", action="store_true", help="apply the reviewed move; default is a preview")
        if action == "migrate-session":
            item.add_argument("workspace_id")
            item.add_argument("session_id")
            item.add_argument("--source-root", required=True, help="previous canonical root, which must no longer exist")
            item.add_argument("--expected-revision", type=int, help="exact saved transcript revision, required with --apply; preview discovers it")
            item.add_argument("--apply", action="store_true", help="move this reviewed private session family; default is a read-only preview")
    workspace(command("list", "list Pips in the current workspace"))
    setup = command("setup", "review conversational setup drafts before saving or running")
    setup_actions = setup.add_subparsers(dest="setup_action", required=True)
    for action in ("list", "show", "accept", "reject"):
        item = setup_actions.add_parser(action, allow_abbrev=False)
        item.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        workspace(item)
        if action != "list":
            item.add_argument("setup_id")
        if action in ("accept", "reject"):
            item.add_argument("--expected-digest", required=True, help="exact digest from setup show")
        if action == "accept":
            item.add_argument("--yes", action="store_true", help="confirm the displayed immutable setup without an interactive prompt")
    create = command("create", "create a Pip; Patch/Pulse require separately reviewed execution")
    create.add_argument("name"); create.add_argument("--goal", required=True)
    create.add_argument("--type", dest="pip_type", default="rook", help="Pip role from types; defaults to rook")
    create.add_argument("--reviewed-execution", action="store_true", help="acknowledge Patch/Pulse use review_required; grants no standing write/test permission")
    create.add_argument("--model", help="explicit model ID from models; omitted inherits DGC default")
    create.add_argument("--source-ref", default="HEAD"); workspace(create)
    job(command("show", "show the complete job and pending proposals"))
    run = command("run", "queue a run for the live foreground supervisor")
    job(run); run.add_argument("--idempotency-key", help="reuse this key only when retrying the same request")
    run.add_argument("--expected-version", type=int, help="reviewed Pulse plan's exact job version")
    run.add_argument("--expected-lifecycle-revision", type=int, help="reviewed Pulse plan's exact lifecycle revision")
    run.add_argument("--expected-plan-digest", help="exact verification_plan_digest from show; provide all three pins for a standing Pulse plan")
    messages = command("messages", "read this Pip's persistent conversation")
    job(messages); messages.add_argument("--before-id"); messages.add_argument("--limit", type=int, default=20)
    send = command("send", "queue a conversational reply from this Pip")
    job(send); send.add_argument("text"); send.add_argument("--idempotency-key")
    send.add_argument("--context-size", type=int, help="reply-only context budget, 2048–1048576; supply with --thinking")
    send.add_argument("--thinking", choices=("off", "low", "medium", "high", "xhigh"),
                      help="reply-only requested reasoning; supply with --context-size; no permission change")
    job(command("runs", "list retained runs of a Pip"))
    command("report", "read a run, findings and limitations").add_argument("run_id")
    command("capacity", "inspect retained capacity across this runner and current workspace; no cleanup")
    export = command("export-run", "write a private projected evidence file; does not export transcripts or reclaim storage")
    export.add_argument("run_id")
    export.add_argument("--output", required=True, help="absolute new file path; existing files and symlinks are refused")
    export.add_argument("--format", choices=("jsonl", "markdown"), default="jsonl", help="evidence JSONL or a completed personal/Quill Markdown document")
    command("cancel", "cancel one queued or running audit").add_argument("run_id")
    checkpoints = command("checkpoints", "page immutable audit checkpoints and finding decisions")
    job(checkpoints); checkpoints.add_argument("--before-id", type=int); checkpoints.add_argument("--limit", type=int, default=20)
    finding = command("review-finding", "record a Pip-local finding decision; does not grant permissions")
    finding.add_argument("run_id"); finding.add_argument("finding_index", type=int, help="zero-based index from the report")
    finding.add_argument("--status", required=True, choices=("accepted", "dismissed", "open"))
    finding.add_argument("--expected-revision", type=int, required=True)
    finding.add_argument("--reason", required=True, help="why you accept, dismiss or reopen this model assessment")
    handoff = command("handoff", "prepare and review a Personal result, finding or accepted Patch artifact handoff")
    handoff_actions = handoff.add_subparsers(dest="handoff_action", required=True)
    for action in ("propose", "propose-artifact", "propose-personal", "review", "accept", "reject", "list"):
        item = handoff_actions.add_parser(action, allow_abbrev=False)
        item.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        if action in ("propose", "propose-artifact"):
            item.add_argument("source_run_id")
            if action == "propose":
                item.add_argument("finding_index", type=int, help="zero-based finding index")
            item.add_argument("target_pip_id")
            item.add_argument("--task", required=True)
            payload = item.add_mutually_exclusive_group(required=True)
            payload.add_argument("--action-json", help="exact JSON action, never a shell command")
            payload.add_argument("--action-file", help="regular UTF-8 JSON file, at most 16 KiB")
            item.add_argument("--idempotency-key", help="reuse only for the exact same draft")
        elif action == "propose-personal":
            item.add_argument("source_run_id")
            item.add_argument("target_pip_id")
            item.add_argument("--shared-text", required=True, help="exact excerpt of the saved Personal result, up to 12,000 UTF-8 bytes")
            item.add_argument("--task", required=True)
            item.add_argument("--idempotency-key")
        elif action == "list":
            job(item); item.add_argument("--before-id"); item.add_argument("--limit", type=int, default=20)
        else:
            item.add_argument("handoff_id")
            if action in ("accept", "reject"):
                item.add_argument("--expected-revision", type=int, required=True)
            if action == "accept":
                item.add_argument("--yes", action="store_true", help="approve the displayed saved envelope without an interactive prompt")
            if action == "reject":
                item.add_argument("--reason", required=True)
    outcome = command("review-execution", "record a local execution outcome decision; never applies or merges changes")
    outcome.add_argument("run_id")
    outcome.add_argument("--status", required=True, choices=("accepted", "dismissed", "open"))
    outcome.add_argument("--expected-revision", type=int, required=True)
    outcome.add_argument("--reason", required=True)
    for action, help_text in (("pause", "pause a job; an active run is cancelled separately"),
                              ("resume-job", "resume an individual paused job")):
        item = command(action, help_text)
        job(item)
        item.add_argument("--expected-lifecycle-revision", type=int,
                          help="current lifecycle revision; required to resume a previously archived Pip")
    for action, help_text in (("archive", "archive an idle Pip while retaining all history"),
                              ("restore", "restore an archived Pip to paused; does not resume it")):
        item = command(action, help_text)
        job(item)
        item.add_argument("--expected-version", type=int, required=True)
        item.add_argument("--expected-lifecycle-revision", type=int, required=True)
        item.add_argument("--request-key", required=True, help="reuse only for this exact lifecycle decision")
        item.add_argument("--reason", required=True)

    propose = command("propose", "propose a versioned job change without applying it")
    job(propose); propose.add_argument("--expected-version", type=int, required=True)
    model_flags = propose.add_mutually_exclusive_group()
    model_flags.add_argument("--model"); model_flags.add_argument("--default-model", action="store_true")
    for flag in ("name", "goal", "source-ref", "reason"):
        propose.add_argument("--" + flag)
    propose.add_argument('--source-policy', choices=('committed_only', 'current_tree'),
                         help='propose a source choice; current_tree also proposes removing schedules and event triggers')
    plan = command("verification-plan", "propose exact Pulse commands for separate review; no model, network or source writes")
    job(plan); plan.add_argument("--expected-version", type=int, required=True)
    payload = plan.add_mutually_exclusive_group(required=True)
    payload.add_argument("--plan-json", help="version 1 plan JSON with exact argv arrays; never a shell command")
    payload.add_argument("--plan-file", help="regular UTF-8 plan JSON file, at most 12 KiB")
    payload.add_argument("--remove", action="store_true", help="propose removing the standing plan AND its calendar; requires separate acceptance")
    plan.add_argument("--reason", default="Pulse verification plan requested by user")
    adaptation = command("adaptation", "propose a human-reviewed adaptation policy; never activates automatically")
    job(adaptation); adaptation.add_argument("--expected-version", type=int, required=True)
    adaptation.add_argument("--mode", required=True, choices=("locked", "context_adaptive", "suggest_changes", "bounded_adaptive", "autonomous"))
    adaptation.add_argument("--allow-field", action="append", default=[], choices=("name", "source_ref"), help="explicit safe fields for bounded_adaptive only")
    adaptation.add_argument("--reason", required=True)
    adaptations = command("adaptations", "page policy-authorized automatic metadata changes")
    job(adaptations); adaptations.add_argument("--before-id"); adaptations.add_argument("--limit", type=int, default=20)
    for name in ("accept", "reject"):
        item = command(name, name + " a specific reviewed job proposal")
        job(item); item.add_argument("proposal_id"); item.add_argument("--expected-version", type=int, required=True)
    schedule = command("schedule", "save a schedule proposal for review; it does not activate yet")
    job(schedule); schedule.add_argument("--expected-version", type=int, required=True)
    choices = schedule.add_mutually_exclusive_group(required=True)
    choices.add_argument("--manual", action="store_true", help="propose removing the schedule")
    choices.add_argument("--every", type=int, metavar="MINUTES", help="interval from 5 to 10080 minutes")
    choices.add_argument("--daily", metavar="HH:MM", help="daily local time; requires --timezone")
    choices.add_argument("--once", metavar="TIMESTAMP", help="one future ISO timestamp with UTC Z or an explicit offset")
    choices.add_argument("--cron", metavar="EXPRESSION", help="five numeric cron fields; requires --timezone")
    schedule.add_argument("--timezone", help="IANA timezone for daily/cron, for example Asia/Kolkata")
    schedule.add_argument("--reason", default="Schedule requested by user")
    trigger = command("trigger", "propose an event trigger for separate review; enabling never replays historical events")
    job(trigger)
    trigger.add_argument("--expected-version", type=int, required=True)
    event_choice = trigger.add_mutually_exclusive_group(required=True)
    event_choice.add_argument("--events", nargs="+", choices=("context_updated", "finding_accepted", "commit_changed", "committed_paths_changed", "session_turn_completed"))
    event_choice.add_argument("--off", action="store_true")
    trigger.add_argument("--minimum-minutes", type=int, default=5)
    trigger.add_argument('--path', action='append', default=[], help='literal committed entry path; repeat with committed_paths_changed')
    trigger.add_argument('--directory', action='append', default=[], help='literal committed directory prefix; repeat with committed_paths_changed')
    trigger.add_argument("--reason", default="Event trigger requested by user")
    reviews = command("approvals", "page saved review decisions, pending requests and expirations")
    job(reviews); reviews.add_argument("--before-id"); reviews.add_argument("--limit", type=int, default=20)
    versions = command("versions", "page immutable job versions")
    job(versions); versions.add_argument("--before-version", type=int); versions.add_argument("--limit", type=int, default=10)
    activity = command("activity", "read workspace activity")
    workspace(activity); activity.add_argument("--after", type=int, default=0)
    context = command("context", "manage explicit workspace reference records")
    actions = context.add_subparsers(dest="context_action", required=True)
    for action in ("list", "record", "archive", "accept-finding", "accept-execution"):
        item = actions.add_parser(action, allow_abbrev=False)
        item.add_argument("--json", action="store_true", default=argparse.SUPPRESS); workspace(item)
        if action != "list":
            item.add_argument("--expected-revision", type=int, required=True)
        if action == "record":
            item.add_argument("kind", choices=("decision", "milestone", "command", "risk", "exception"))
            item.add_argument("--title", required=True); item.add_argument("--content", required=True)
        elif action == "archive":
            item.add_argument("entry_id")
        elif action == "accept-finding":
            item.add_argument("run_id"); item.add_argument("finding_index", type=int, help="zero-based finding index from report")
        elif action == "accept-execution":
            item.add_argument("run_id")
            item.add_argument("--expected-review-revision", type=int, required=True,
                              help="exact currently accepted execution outcome review")
    execution = command("session-execution", "review native command receipts and explicitly record historical facts")
    execution_actions = execution.add_subparsers(dest="execution_action", required=True)
    for action in ("list", "show", "record"):
        item = execution_actions.add_parser(action, allow_abbrev=False)
        item.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        item.add_argument("--workspace", dest="workspace_id", required=True, help="existing local workspace ID")
        if action == "list":
            item.add_argument("--session", dest="session_id")
            item.add_argument("--before-id")
            item.add_argument("--limit", type=int, default=20)
        else:
            item.add_argument("attempt_id")
        if action == "record":
            for name in ("attempt", "final", "view"):
                item.add_argument("--" + name + "-digest", dest="expected_" + name + "_digest", required=True,
                                  help="exact digest returned by show; review before recording")
            item.add_argument("--expected-context-revision", type=int, required=True)
    memory = command("memory", "review source-bound finding exceptions; never hides findings or grants tools")
    memory_actions = memory.add_subparsers(dest="memory_action", required=True)
    for action in ("source", "record", "revoke", "list"):
        item = memory_actions.add_parser(action, allow_abbrev=False)
        item.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        job(item)
        if action in ("source", "record"):
            item.add_argument("run_id")
            item.add_argument("finding_index", type=int)
        if action == "record":
            item.add_argument("--source-digest", dest="expected_source_digest", required=True)
            item.add_argument("--reason", required=True)
            item.add_argument("--expires-at", help="explicit ISO-8601 time with timezone; omitted has no expiry")
            item.add_argument("--request-key", required=True, help="reuse only for the same reviewed exception")
        elif action == "revoke":
            item.add_argument("memory_id")
            item.add_argument("--expected-revision", type=int, required=True)
            item.add_argument("--reason", required=True)
        elif action == "list":
            item.add_argument("--before-id", type=int)
            item.add_argument("--limit", type=int, default=20)
    statements = memory_actions.add_parser("statements", allow_abbrev=False,
        help="review Pip-local claims and advisory preferences; never verified facts or permissions")
    statement_actions = statements.add_subparsers(dest="statement_action", required=True)
    for action in ("anchor", "record", "revoke", "list"):
        item = statement_actions.add_parser(action, allow_abbrev=False)
        item.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        job(item)
        if action in ("anchor", "record"):
            item.add_argument("--source-run", dest="source_run_id", help="optional successful audit of this same Pip; omitted means source not observed")
        if action == "record":
            item.add_argument("--kind", choices=("fact", "preference"), required=True,
                              help="fact is a recorded claim, not a verified fact")
            for name in ("title", "statement", "reason", "request-key"):
                item.add_argument("--" + name, required=True)
            item.add_argument("--anchor-digest", dest="expected_anchor_digest", required=True)
            expiry = item.add_mutually_exclusive_group(required=True)
            expiry.add_argument("--expires-at", help="explicit ISO-8601 timestamp with timezone")
            expiry.add_argument("--no-expiry", action="store_true", help="explicitly record without expiry")
        elif action == "revoke":
            item.add_argument("memory_id")
            item.add_argument("--expected-revision", type=int, required=True)
            item.add_argument("--reason", required=True)
        elif action == "list":
            item.add_argument("--before-id", type=int)
            item.add_argument("--limit", type=int, default=20)
    inbox = command("notifications", "list local notifications or mark one read; never approves or starts work")
    inbox_actions = inbox.add_subparsers(dest="notification_action", required=True)
    for action in ("list", "read"):
        item = inbox_actions.add_parser(action, allow_abbrev=False)
        item.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        workspace(item)
        if action == "list":
            item.add_argument("--before-seq", type=int)
            item.add_argument("--limit", type=int, default=20)
        else:
            item.add_argument("notification_id")
            item.add_argument("--expected-revision", type=int, required=True)
    outcomes = command("session-outcome", "review a session statement for shared context; does not verify execution")
    outcome_actions = outcomes.add_subparsers(dest="outcome_action", required=True)
    for action in ("inspect", "propose", "review", "list", "accept", "reject"):
        item = outcome_actions.add_parser(action, allow_abbrev=False)
        item.add_argument("--json", action="store_true", default=argparse.SUPPRESS); workspace(item)
        if action == "inspect":
            item.add_argument("session_id")
        elif action == "propose":
            item.add_argument("session_id")
            item.add_argument("--title", required=True)
            item.add_argument("--statement", required=True, help="your statement for separate review, not a transcript export")
            item.add_argument("--expected-session-revision", type=int, required=True)
            item.add_argument("--request-key", required=True, help="reuse only for an identical proposal retry")
            source = item.add_mutually_exclusive_group(required=True)
            source.add_argument("--source-commit", help="exact commit selected for the statement; never a moving branch")
            source.add_argument("--source-run", help="completed Pip run whose source is selected for the statement")
        elif action == "list":
            item.add_argument("--before-id", type=int)
            item.add_argument("--limit", type=int, default=20)
        else:
            item.add_argument("proposal_id")
            if action in ("accept", "reject"):
                item.add_argument("--digest", dest="expected_digest", required=True, help="exact digest shown by review")
            if action == "accept":
                item.add_argument("--expected-context-revision", type=int, required=True)
    service = command("service", "manage this DGC home's Linux user service; install, start and login registration are separate")
    service_actions = service.add_subparsers(dest="service_action", required=True)
    for action in ("preview", "install", "status", "start", "stop", "enable", "disable", "uninstall"):
        item = service_actions.add_parser(action, allow_abbrev=False)
        item.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        item.add_argument("--unit-directory", help="explicit owner-private service directory; use preview to review the exact unit first")
    serve = command("serve", "run the foreground supervisor; keep this terminal open")
    serve.add_argument("--enable", action="store_true")
    command("status", "show runner status as JSON")
    stop = command("stop", "emergency stop: pause all jobs and cancel their work")
    stop.add_argument("--yes", action="store_true", help="confirm the global emergency stop without a prompt")
    command("resume", "locally clear emergency stop; jobs stay paused")
    return value


def _require_supervisor():
    from .pip_daemon import runner_status
    from .scheduler import named_process_lock
    directory = state_directory()
    with WorkspaceRegistry(directory) as registry:
        status = runner_status(registry)
    if status["paused"]:
        raise RegistryError("runner_stopped", "Pips are stopped. Run dgc pips resume locally, then resume the individual job.")
    if not status["online"] or status["status"] != "running":
        raise RegistryError("runner_offline", "No foreground Pips supervisor is running. Open another terminal and run dgc pips serve, then retry this run.")
    lease = named_process_lock("pips-supervisor", str(directory))
    if lease.acquire(blocking=False):
        lease.release()
        raise RegistryError("runner_offline", "The Pips supervisor has stopped. Run dgc pips serve in another terminal, then retry.")
    if lease.last_error:
        raise RegistryError("runner_unavailable", "The Pips supervisor lease could not be checked. Resolve local state access before queueing work.")
    # A heartbeat alone can outlive a crashed supervisor. The occupied OS lease is
    # checked too. A later shutdown can still leave this request honestly queued.


MAX_ACTION_JSON_BYTES = 16 * 1024


def _read_action_json(args, *, maximum=MAX_ACTION_JSON_BYTES, label="Action"):
    """Bound bytes before decoding/parsing. Never block on a pipe or device."""
    raw = getattr(args, "action_json", None)
    if raw is not None:
        if len(raw) > maximum:
            raise RegistryError("action_limit", f"{label} JSON exceeds {maximum // 1024} KiB. Nothing was parsed or proposed.")
        try:
            encoded = raw.encode("utf-8")
        except UnicodeError as exc:
            raise RegistryError("invalid_action", f"{label} JSON must be valid UTF-8.") from exc
    else:
        path = Path(args.action_file).expanduser()
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode):
            raise RegistryError("invalid_action", "Action input must be a regular file, not a link, pipe, directory or device.")
        if before.st_size > maximum:
            raise RegistryError("action_limit", f"{label} JSON exceeds {maximum // 1024} KiB. Nothing was read or proposed.")
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
        try:
            current = os.fstat(fd)
            if not stat.S_ISREG(current.st_mode) or (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
                raise RegistryError("invalid_action", "Action file changed while opening it. Review it and retry.")
            if current.st_size > maximum:
                raise RegistryError("action_limit", f"{label} JSON exceeds {maximum // 1024} KiB. Nothing was read or proposed.")
            with os.fdopen(fd, "rb", closefd=False) as source:
                encoded = source.read(maximum + 1)
        finally:
            os.close(fd)
    if len(encoded) > maximum:
        raise RegistryError("action_limit", f"{label} JSON exceeds {maximum // 1024} KiB. Nothing was parsed or proposed.")
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError("Duplicate JSON key: " + key)
            value[key] = item
        return value
    def constant(_):
        raise ValueError("Non-finite JSON number")
    try:
        value = json.loads(encoded.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise RegistryError("invalid_action", f"{label} must be one valid JSON object without duplicate keys or non-finite values.") from exc
    if not isinstance(value, dict):
        raise RegistryError("invalid_action", f"{label} must be a JSON object, not a shell command or array.")
    return value


def _request(args):
    name = args.command
    if getattr(args, 'personal', False):
        with WorkspaceRegistry() as registry:
            args.workspace_id = registry.personal()['id']
    mapping = {"accounts": "list_pip_accounts", "connections": "list_pip_connections", "inspect-connection": "inspect_pip_connection", "execution": "get_pip_execution", "models": "list_pip_models", "messages": "list_pip_messages", "send": "send_pip_message", "types": "list_pip_types", "workspaces": "list_workspaces", "list": "list_pips", "create": "create_pip",
        "show": "get_pip", "run": "run_pip", "runs": "list_pip_runs", "report": "get_pip_run",
        "cancel": "cancel_pip_run", "pause": "pause_pip", "resume-job": "resume_pip",
        "propose": "propose_pip_update", "accept": "accept_pip_update", "reject": "reject_pip_update",
        "versions": "list_pip_versions", "activity": "list_workspace_activity",
        "schedule": "propose_pip_update", "verification-plan": "propose_pip_update", "adaptation": "propose_pip_update", "adaptations": "list_pip_adaptations", "approvals": "list_pip_approvals",
        "checkpoints": "list_pip_checkpoints", "review-finding": "review_pip_finding", "review-execution": "review_pip_execution"}
    request = {"request_id": identifier("cli")}
    if name == 'connector-draft':
        request['type']={'list':'list_pip_connector_drafts','show':'get_pip_connector_draft','prepare':'prepare_pip_connector_draft','dismiss':'dismiss_pip_connector_draft'}[args.connector_draft_action]
        for key in ('draft_id','expected_digest','pip_id','before_id','limit'):
            if getattr(args,key,None) is not None:request[key]=getattr(args,key)
        if args.connector_draft_action=='prepare' and (args.action_json or args.action_file):request['call']=_read_action_json(args)
        return request
    if name == 'email-draft':
        request['type']={'list':'list_pip_message_drafts','show':'get_pip_message_draft','prepare':'prepare_pip_message_draft','dismiss':'dismiss_pip_message_draft'}[args.email_action]
        for key in ('draft_id','expected_digest','server','connection_digest','account','schema_digest','pip_id','before_id','limit'):
            if getattr(args,key,None) is not None:request[key]=getattr(args,key)
        if args.email_action=='prepare' and (getattr(args,'action_json',None) is not None or getattr(args,'action_file',None) is not None):request['message']=_read_action_json(args)
        return request
    if name == 'calendar-draft':
        request['type']={'list':'list_pip_calendar_drafts','show':'get_pip_calendar_draft','prepare':'prepare_pip_calendar_draft','dismiss':'dismiss_pip_calendar_draft'}[args.calendar_action]
        for key in ('draft_id','expected_digest','server','connection_digest','account','schema_digest','pip_id','before_id','limit'):
            if getattr(args,key,None) is not None:request[key]=getattr(args,key)
        if args.calendar_action=='prepare' and (getattr(args,'action_json',None) is not None or getattr(args,'action_file',None) is not None):request['event']=_read_action_json(args)
        return request
    if name == 'app-action':
        request['type']={'inspect':'inspect_pip_send_connection','propose':'propose_pip_app_action','show':'get_pip_app_action',
                         'list':'list_pip_app_actions','accept':'accept_pip_app_action','reject':'reject_pip_app_action'}[args.app_action]
        if getattr(args,'kind',None)=='calendar_create':request['type']={'inspect':'inspect_pip_calendar_connection','propose':'propose_pip_calendar_action'}[args.app_action]
        keys=('server','source_run_id','connection_digest','account','schema_digest','request_key','action_id','expected_digest','pip_id','before_id','limit')
        if getattr(args,'kind',None)=='connector_call':
            if getattr(args,'account',None) is not None:raise ValueError('Connector calls use the provider-managed account; do not pass --account.')
            request['type']={'inspect':'inspect_pip_connector_actions','propose':'propose_pip_connector_action'}[args.app_action]
        if args.app_action=='propose':
            if args.kind!='connector_call' and not args.account:raise ValueError('--account is required for email and calendar actions.')
            request[{'gmail_send':'message','calendar_create':'event','connector_call':'call'}[args.kind]]=_read_action_json(args)
    elif name == "setup":
        request["type"] = {"list": "list_pip_setups", "show": "get_pip_setup",
                           "accept": "accept_pip_setup", "reject": "reject_pip_setup"}[args.setup_action]
        keys = ("workspace_id", "setup_id", "expected_digest")
    elif name in ("archive", "restore"):
        request["type"] = "archive_pip" if name == "archive" else "restore_pip"
        keys = ("pip_id", "expected_version", "expected_lifecycle_revision", "request_key", "reason")
    elif name == "handoff":
        request["type"] = {"propose-personal": "propose_pip_personal_handoff", "propose": "propose_pip_handoff", "propose-artifact": "propose_pip_artifact_handoff", "review": "get_pip_handoff", "accept": "accept_pip_handoff", "reject": "reject_pip_handoff", "list": "list_pip_handoffs"}[args.handoff_action]
        keys = ("source_run_id", "finding_index", "target_pip_id", "shared_text", "task", "handoff_id", "expected_revision", "reason", "pip_id", "before_id", "limit")
    elif name == "memory":
        if args.memory_action == "statements":
            request["type"] = {"anchor": "get_pip_statement_anchor", "record": "record_pip_statement",
                               "revoke": "revoke_pip_statement", "list": "list_pip_statements"}[args.statement_action]
            keys = ("pip_id", "source_run_id", "kind", "title", "statement", "reason", "expires_at",
                    "expected_anchor_digest", "request_key", "memory_id", "expected_revision", "before_id", "limit")
            if args.statement_action == "record":
                request["expires_at"] = args.expires_at
        else:
            request["type"] = {"source": "get_pip_exception_source", "record": "record_pip_exception",
                           "revoke": "revoke_pip_exception", "list": "list_pip_memories"}[args.memory_action]
            keys = ("pip_id", "run_id", "finding_index", "expected_source_digest", "reason", "expires_at",
                "request_key", "memory_id", "expected_revision", "before_id", "limit")
    elif name == "notifications":
        request["type"] = "list_pip_notifications" if args.notification_action == "list" else "mark_pip_notification_read"
        keys = ("workspace_id", "before_seq", "limit", "notification_id", "expected_revision")
    elif name == "session-execution":
        request["type"] = {"list": "list_workspace_execution_receipts", "show": "get_workspace_execution_receipt",
                           "record": "record_workspace_execution_context"}[args.execution_action]
        keys = ("workspace_id", "session_id", "before_id", "limit", "attempt_id", "expected_attempt_digest",
                "expected_final_digest", "expected_view_digest", "expected_context_revision")
    elif name == "session-outcome":
        request["type"] = {"inspect": "inspect_workspace_session_outcome", "propose": "propose_workspace_session_outcome", "review": "get_workspace_session_outcome",
                           "list": "list_workspace_session_outcomes", "accept": "accept_workspace_session_outcome",
                           "reject": "reject_workspace_session_outcome"}[args.outcome_action]
        keys = ("workspace_id", "session_id", "title", "statement", "expected_session_revision", "request_key",
                "proposal_id", "before_id", "limit", "expected_digest", "expected_context_revision")
    elif name == "context":
        mapping = {"list": "get_workspace_context", "record": "record_workspace_context",
                   "archive": "archive_workspace_context", "accept-finding": "accept_pip_finding",
                   "accept-execution": "accept_pip_execution_context"}
        request["type"] = mapping[args.context_action]
        keys = ("workspace_id", "kind", "title", "content", "expected_revision", "entry_id", "run_id", "finding_index", "expected_review_revision")
    else:
        request["type"] = "propose_pip_update" if name == "trigger" else mapping[name]
        keys = ("server", "workspace_id", "pip_id", "run_id", "name", "goal", "source_ref", "pip_type", "expected_version",
                "proposal_id", "text", "before_version", "before_id", "limit", "after",
                "finding_index", "status", "expected_revision", "expected_lifecycle_revision", "expected_plan_digest")
    for key in keys:
        value = getattr(args, key, None)
        if value is not None:
            request[key] = value
    if name == "session-outcome" and args.outcome_action == "propose":
        request["source"] = ({"kind": "commit", "revision": args.source_commit} if args.source_commit
                             else {"kind": "pip_run", "run_id": args.source_run})
    if name == "create" and args.pip_type in ("patch", "pulse") and not args.personal:
        if not args.reviewed_execution:
            raise RegistryError("confirmation_required", "Patch/Pulse chats stay read-only. Creating this Pip grants no standing write/test permission; execution requires an approved handoff or a separately reviewed Pulse verification plan. Repeat with --reviewed-execution to acknowledge that contract.")
    elif name == "create" and args.reviewed_execution:
        raise RegistryError("invalid_request", "--reviewed-execution is only for Patch or Pulse; source-audit Pips remain read-only.")
    if name == "handoff" and args.handoff_action == "propose-personal":
        request['idempotency_key'] = args.idempotency_key or identifier('cli-handoff')
    if name == "handoff" and args.handoff_action in ("propose", "propose-artifact"):
        request["action"] = _read_action_json(args)
        request["idempotency_key"] = args.idempotency_key or identifier("request")
    if name == "create" and args.model:
        request["model_choice"] = {"mode": "model", "model": args.model}
    if name in ("run", "send"):
        request["idempotency_key"] = args.idempotency_key or identifier("request")
        if name == 'send' and (args.context_size is not None or args.thinking is not None):
            if args.context_size is None or args.thinking is None:
                raise RegistryError('invalid_chat_options', 'Provide --context-size and --thinking together for this reply. Scheduled job settings stay unchanged.')
            from .pip_chat_options import validate
            request['chat_options'] = validate({'context_size': args.context_size, 'thinking': args.thinking})
        if name == "run":
            pins = ("expected_version", "expected_lifecycle_revision", "expected_plan_digest")
            if any(key in request for key in pins) and not all(key in request for key in pins):
                raise RegistryError("invalid_request", "A Pulse plan run needs --expected-version, --expected-lifecycle-revision and --expected-plan-digest together. Review show first; no pins are inferred.")
    elif name == "verification-plan":
        from .pip_pulse_plans import MAX_PLAN_BYTES, validate_plan
        if args.remove:
            changes = {"verification_plan": None, "schedule": None}
        else:
            payload = argparse.Namespace(action_json=args.plan_json, action_file=args.plan_file)
            changes = {"verification_plan": validate_plan(_read_action_json(payload, maximum=MAX_PLAN_BYTES, label="Pulse plan"))}
        request.update(changes=changes, reason=args.reason)
    elif name == "trigger":
        if args.off and args.minimum_minutes != 5:
            raise RegistryError("invalid_event_trigger", "--minimum-minutes applies only when enabling event triggers.")
        spec = None if args.off else {"events": args.events, "minimum_minutes": args.minimum_minutes}
        if args.path or args.directory:
            if spec is None or 'committed_paths_changed' not in args.events:
                raise RegistryError('invalid_event_trigger','--path and --directory require --events committed_paths_changed.')
            spec['commit_paths'] = ([{'kind':'exact','path':value} for value in args.path]
                                   + [{'kind':'directory','path':value} for value in args.directory])
        if spec is not None and ('committed_paths_changed' in args.events or 'commit_paths' in spec):
            from .pip_event_triggers import validate_event_trigger
            spec = validate_event_trigger(spec)
        request.update(changes={"event_trigger": spec}, reason=args.reason)
    elif name == "adaptation":
        from .pip_adaptation import policy
        if args.mode != "bounded_adaptive" and args.allow_field:
            raise RegistryError("invalid_adaptation_policy", "--allow-field is only for bounded_adaptive; the other modes have fixed safe-field sets.")
        fields = ["name", "source_ref"] if args.mode == "autonomous" else args.allow_field
        request.update(changes={"adaptation_policy": policy({"mode": args.mode, "allowed_fields": fields})}, reason=args.reason)
    elif name == "schedule":
        if bool(args.daily or args.cron) != bool(args.timezone):
            raise RegistryError("invalid_schedule", "Daily and cron schedules require --timezone; once/interval/manual schedules do not use it.")
        if args.manual:
            spec = None
        elif args.every is not None:
            spec = {"type": "interval", "minutes": args.every}
        elif args.once:
            spec = {"type": "once", "at": args.once}
        elif args.cron:
            spec = {"type": "cron", "cron": args.cron, "timezone": args.timezone}
        else:
            spec = {"type": "daily", "time": args.daily, "timezone": args.timezone}
        request.update(changes={"schedule": spec}, reason=args.reason)
    elif name in ("review-finding", "review-execution"):
        request["reason"] = args.reason
    elif name == "propose":
        changes = {key: request.pop(key) for key in ("name", "goal", "source_ref") if key in request}
        if args.model or args.default_model:
            changes["model_choice"] = {"mode": "model", "model": args.model} if args.model else {"mode": "default"}
        if args.source_policy:
            changes['source_policy'] = {'mode': args.source_policy}
            if args.source_policy == 'current_tree':
                changes['source_policy']['exclusions'] = 'safe_source_v1'
                changes.update(schedule=None, event_trigger=None)
        if not changes:
            raise RegistryError("invalid_request", "Provide --name, --goal or --source-ref for the proposed change.")
        request["changes"] = changes
        if args.reason:
            request["reason"] = args.reason
    return request


def _format(value):
    if "setups" in value:
        return "\n\n".join(_format({"setup": item}) for item in value["setups"]) or (
            "No setup drafts awaiting review. Describe a Pip task and its project in the main DGC chat.")
    if "setup" in value:
        item = value["setup"]
        lines = [f'Pip setup: {item["name"]} · {item["status"]}',
                 f'Project: {item["project_root"]}', f'Task: {item["goal"]}',
                 f'Type: {item["pip_type"]} · work: {item["work_kind"]}',
                 f'Source: committed {item["source_ref"]}',
                 'Schedule: ' + json.dumps(item.get('schedule'), ensure_ascii=False),
                 f'Next scheduled run: {item.get("next_run_at") or "None (manual)"}',
                 'Run once on approval: ' + ('Yes' if item['run_now'] else 'No'),
                 'Saving activates this Pip. It does not start or resume the local runner.',
                 'Permissions: ' + item['scope_notice'],
                 f'Expires: {item["expires_at"]}', f'Digest: {item["digest"]}']
        if item.get('verification_plan'):
            lines.append('Exact reviewed plan: ' + json.dumps(item['verification_plan'], ensure_ascii=False, indent=2))
        if item.get('receipt'):
            lines.append('Receipt: ' + json.dumps(item['receipt'], ensure_ascii=False))
        if item['status'] == 'pending':
            lines += ['Nothing has been saved or run yet.',
                      f'dgc pips setup accept {item["id"]} --expected-digest {item["digest"]}',
                      f'dgc pips setup reject {item["id"]} --expected-digest {item["digest"]}']
        return '\n'.join(lines)
    if "capacity_inspection" in value:
        from .pip_capacity import format_capacity
        return format_capacity(value)
    if "anchor" in value and "digest" in value:
        return ("Review this exact recording anchor before saving a Pip-local claim or preference.\n"
                + json.dumps(value["anchor"], ensure_ascii=False, indent=2)
                + "\nAnchor digest: " + value["digest"]
                + "\nAn anchor records provenance, not truth, execution or permission. No selected audit means source not observed.")
    if "memory" in value and value["memory"].get("kind") in ("fact", "preference"):
        item = value["memory"]
        label = "Recorded claim" if item["kind"] == "fact" else "Recorded preference"
        return (f'{label} · {item["id"]} · {item["status"]} · revision {item["revision"]}\n'
                + json.dumps(item, ensure_ascii=False, indent=2)
                + ("\nOriginal receipt returned; no second record or reactivation." if value.get("replayed") else "")
                + "\nClaims may be wrong; preferences are advisory. Neither grants authority or verifies execution."
                + " Queued references retain their historical state after expiry or revocation.")
    if "entries" in value and "counts" in value and "pip_id" in value and "remaining_records" in value:
        lines = ["Pip-local statement history as of " + value["as_of"],
                 "Statement counts: " + json.dumps(value["counts"], sort_keys=True)]
        for entry in value["entries"]:
            lines.append("Effective status: " + entry["effective_status"] + "\n" + _format({"memory": entry["memory"]}))
        if not value["entries"]:
            lines.append("No recorded claims or preferences. Start with dgc pips memory statements anchor <pip-id>.")
        if value["has_more"]:
            lines.append("Older statements: repeat with --before-id " + str(value["next_before_id"]))
        return "\n\n".join(lines)
    if "receipts" in value:
        lines = ["Historical native command outcomes; zero exit does not establish passing tests."]
        for row in value['receipts']:
            lines.append(f"{row['id']} · {row['state']} · session {row['session_id']}\n"
                         + json.dumps(row['command_preview'], ensure_ascii=True))
        if not value['receipts']:
            lines.append("No configured-verifier receipts in this scope. Ordinary commands and older sessions have none.")
        if value.get('has_more'):
            lines.append("Older receipts: repeat with --before-id " + value['next_before_id'])
        return '\n'.join(lines)
    if "receipt" in value and 'pip' not in value:
        item = value['receipt']
        lines = [f"Command receipt {item['id']} · {item['state']}", item['projection']['notice'],
                 'Configured command (quoted data): ' + json.dumps(item['command']['text'], ensure_ascii=True),
                 'Session: ' + item['session_id']]
        if item['facts'] is None:
            lines.append('No native final was recorded. Whether the command launched or finished is unknown.')
        else:
            lines += ['Native facts: ' + json.dumps(item['facts'], sort_keys=True, ensure_ascii=True),
                      'Captured output (quoted data): ' + json.dumps(item['output_preview']['text'], ensure_ascii=True)]
        lines += ['Source observations (non-atomic): ' + json.dumps({'before': item['source_before'],
            'after': item['source_after'], 'comparison': item['source_comparison']}, ensure_ascii=True, sort_keys=True),
            'Attempt digest: ' + item['attempt_digest'], 'Final digest: ' + str(item['final_digest']),
            'Displayed view digest: ' + item['view_digest']]
        if item['can_record']:
            lines += [f"Review dgc pips context list --workspace {item['workspace_id']} for the current context revision before recording.",
                      f"Record: dgc pips session-execution record {item['id']} --workspace {item['workspace_id']} "
                      f"--attempt-digest {item['attempt_digest']} --final-digest {item['final_digest']} "
                      f"--view-digest {item['view_digest']} --expected-context-revision N"]
        else:
            lines.append('Recording unavailable: ' + str(item['record_blocked_reason']))
        return '\n'.join(lines)
    if "recording" in value and "context" in value:
        return (('Original recording returned; no new context entry.\n' if value.get('replayed') else 'Command outcome recorded.\n')
                + f"{value['recording']['id']} · {value['recording']['status']} · current context revision {value['context']['revision']}\n"
                + 'Historical process facts only. No command was run and no execution permission was granted.')
    if "export" in value:
        evidence = value["export"]
        if evidence.get("format") == "text/markdown":
            return (f'Markdown saved to {evidence["path"]}\n'
                    f'{evidence["bytes"]} bytes · SHA256 {evidence["sha256"]}\n'
                    'Model-authored document. Review before relying on or sharing it.')
        return (f'Evidence exported to {evidence["path"]}\n'
                f'{evidence["records"]} records · {evidence["bytes"]} bytes · SHA256 {evidence["sha256"]}\n'
                + evidence["notice"])
    """Small plain-text views; JSON remains available for complete machine output."""
    if "receipt" in value and "pip" in value and value["receipt"].get("operation") in ("archive", "restore"):
        receipt, pip = value["receipt"], value["pip"]
        return (f'{pip["id"]} · {receipt["operation"]} recorded at lifecycle revision {receipt["lifecycle_revision_after"]}.\n'
                + ("Original decision returned; no new transition was performed.\n" if value.get("replayed") else "")
                + f'Current state: {pip["status"]} · lifecycle revision {pip["lifecycle_revision"]}.\n'
                + "History is retained. Restore returns the Pip to paused; a separate resume is required.")
    if "source" in value and "digest" in value and "pip_id" in value and "finding_index" in value["source"]:
        return ("Review this exact finding source before recording an exception.\n"
                + json.dumps(value["source"], ensure_ascii=False, indent=2)
                + "\nSource digest: " + value["digest"]
                + "\nAn exception is reference only. It does not hide findings, establish correctness or grant tools.")
    if "memory" in value:
        item = value["memory"]
        return (f'{item["id"]} · {item["status"]} · revision {item["revision"]}\n'
                + json.dumps(item, ensure_ascii=False, indent=2)
                + ("\nOriginal receipt returned; no second exception was recorded." if value.get("replayed") else "")
                + "\nThis user-recorded exception is reference only, not verified execution or permission."
                + " Revocation affects new snapshots; queued snapshots retain their historical reference.")
    if "memories" in value:
        lines = [_format({"memory": item}) for item in value["memories"]]
        if value.get("next_before_id"):
            lines.append("Older memories: repeat with --before-id " + str(value["next_before_id"]))
        return "\n\n".join(lines) or "No source-bound exceptions. Review a finding with dgc pips memory source <pip-id> <run-id> <finding-index>."
    if "notifications" in value:
        lines = [f'{value["unread_count"]} unread · {value["retained_count"]} retained on this local runner.']
        for item in value["notifications"]:
            state = "Read" if item["read_at"] else "Unread"
            lines.append(f'{state} · {item["title"]} · {item["source_status"]}\n'
                         f'{item["id"]} · workspace {item["workspace_id"]}\n'
                         + json.dumps(item["reference"], ensure_ascii=False, sort_keys=True))
            if not item["read_at"]:
                lines.append(f'Mark read: dgc pips notifications read {item["id"]} --expected-revision {item["revision"]}')
        if not value["notifications"]:
            lines.append("No local notifications on this page. Pending reviews and failed runs appear here.")
        if value.get("next_before_seq"):
            lines.append("Older notifications: repeat with --before-seq " + str(value["next_before_seq"]))
        if value.get("sync_pending"):
            lines.append("More local events remain to scan; refresh to continue the bounded scan.")
        if value.get("history_may_be_incomplete"):
            lines.append(f'History may be incomplete: {value["evicted_total"]} evicted; {value["unavailable_sources_total"]} unavailable sources.')
        lines.append("Reading a notification does not accept a review or start work. Read state is shared by this runner's controllers.")
        return "\n".join(lines)
    if "notification" in value:
        item = value["notification"]
        return (f'{item["title"]}\nRead by {item["read_by"]} at {item["read_at"]}.\n'
                + ("The original read receipt was returned.\n" if value.get("replayed") else "")
                + "No review was accepted and no work was started.")
    if isinstance(value.get("proposal"), dict) and value["proposal"].get("classification") == "user_reviewed_statement":
        item = value["proposal"]
        lines = [f'Session statement · {item["status"]}', item["title"], item["statement"],
                 "This is a user-reviewed statement, not a verified execution result.",
                 "The source below was selected for this statement; it does not attest where a command ran.",
                 json.dumps(item["source_reference"], ensure_ascii=False, indent=2),
                 f'Session: {item["session"]["id"]} · revision {item["session"]["revision"]}',
                 "Digest: " + item["digest"]]
        if item["status"] in ("pending", "proposed"):
            prefix = f'--workspace {item["workspace_id"]} --digest {item["digest"]}'
            lines.extend(["Review the current context revision with dgc pips context list before accepting.",
                          f'Accept: dgc pips session-outcome accept {item["id"]} {prefix} --expected-context-revision N',
                          f'Reject: dgc pips session-outcome reject {item["id"]} {prefix}'])
        if value.get("replayed"):
            lines.append("Exact retry: the original review was returned without adding another context record.")
        return "\n".join(lines)
    if "proposals" in value:
        lines = [_format({"proposal": item}) for item in value["proposals"]]
        if value.get("next_before_id") is not None:
            lines.append("Older statements: repeat with --before-id " + str(value["next_before_id"]))
        return "\n\n".join(lines) or "No reviewed session statements. Start with dgc pips session-outcome propose --help."
    if "handoff" in value:
        item = value["handoff"]
        lines = ["Saved handoff envelope (no transcript or host credentials):", json.dumps(item, ensure_ascii=False, indent=2)]
        if item["status"] == "pending":
            lines += ["No work has started. Review the exact source, recipient, task and action above.",
                      f'Accept: dgc pips handoff accept {item["id"]} --expected-revision {item["revision"]}',
                      f'Reject: dgc pips handoff reject {item["id"]} --expected-revision {item["revision"]} --reason "Reason"']
        elif item.get("run_id"):
            lines.append("Recipient run: dgc pips report " + item["run_id"])
        return "\n".join(lines)
    if "handoffs" in value:
        lines = [_format({"handoff": item}) for item in value["handoffs"]]
        if value.get("next_before_id"):
            lines.append("Older handoffs: repeat with --before-id " + value["next_before_id"])
        return "\n\n".join(lines) or "No saved handoffs. Start with dgc pips handoff propose from a completed audit finding."
    if "checkpoints" in value:
        lines = []
        for item in value["checkpoints"]:
            lines.append(json.dumps(item, ensure_ascii=False, indent=2))
        if value.get("next_before_id"):
            lines.append("Earlier checkpoints: repeat with --before-id " + str(value["next_before_id"]))
        return "\n\n".join(lines) or "No audit checkpoint yet. Complete a new read-only audit to record one."
    if "messages" in value:
        lines = [f'{item["role"]} · {item["status"]} · {item["model"]}\n{item["text"]}' for item in value["messages"]]
        continuity = value.get('continuity')
        if continuity and continuity.get('summary'):
            lines.append('Conversation continuity · ' + str(continuity['summarized_messages'])
                         + ' messages summarized · ' + continuity['strategy'] + '\n'
                         + continuity['summary'] + '\nOriginal messages remain in the archive. The brief grants no permissions.')
        if value.get("next_before_id"):
            lines.append("Earlier messages: repeat with --before-id " + value["next_before_id"])
        return "\n\n".join(lines) or "No messages yet. Use dgc pips send <pip-id> <message>."
    if "message" in value and "run" in value:
        return (f'Reply {value["run"]["status"]}: {value["run"]["id"]}\n'
                + "Read it with: dgc pips messages " + value["message"]["pip_id"])
    if "models" in value and "default_model" in value:
        lines = ["DGC default: " + str(value["default_model"])]
        lines.extend(item["id"] for item in value["models"])
        if value.get("error"):
            lines.append(value["error"]["message"])
        if value.get("truncated"):
            lines.append("More models exist on this connection; this list is bounded.")
        return "\n".join(lines)
    if "types" in value:
        return "\n".join(f'{item["id"]}  {item["name"]} · {item["role"]}\n  '
                         + (item["description"] if item["available"] else item["unavailable_reason"])
                         for item in value["types"])
    if "proposal" in value:
        item = value["proposal"]
        return "\n".join(["Saved for review; no change is active.", json.dumps(item["definition"], ensure_ascii=False, indent=2),
                          "Reason: " + item["reason"], "Review expires: " + item.get("expires_at", "Not recorded"),
                          f'Accept: dgc pips accept {item["pip_id"]} {item["id"]} --expected-version {item["expected_version"]}',
                          f'Reject: dgc pips reject {item["pip_id"]} {item["id"]} --expected-version {item["expected_version"]}'])
    if "approvals" in value:
        lines = [f'{item["id"]}  {item["status"]}  {item["action_summary"]}\n  Requested by {item["requested_by"]}; expires {item["expires_at"]}; resolved by {item["resolved_by"] or "Not resolved"}' for item in value["approvals"]]
        if value["next_before_id"]:
            lines.append("More remain. Repeat with --before-id " + value["next_before_id"])
        return "\n".join(lines) or "No saved reviews for this Pip."
    if "backfill" in value:
        result = value["backfill"]
        label = "Preview" if result["dry_run"] else "Applied"
        lines = [f'{label}: {result["scanned"]} sessions inspected; {result["associated"]} associated, '
                 f'{result["already"]} already associated, {result["would_associate"]} would associate, '
                 f'{result["skipped"]} skipped, {result["errors"]} errors.']
        for issue in result.get("issues", []):
            lines.append(f'{issue.get("session_id", "session")}: {issue["code"]} — {issue["message"]}')
        if not result["complete"]:
            lines.append("More remain. Repeat with --after " + str(result["next_cursor"]))
        if result["dry_run"]:
            lines.append("Review the result, then repeat with --apply to save associations. Transcripts are never rewritten.")
        return "\n".join(lines)
    if "rebind" in value:
        result = value["rebind"]
        return "\n".join([("Applied" if result["applied"] else "Preview") + ": " + result["workspace_id"],
                          "From: " + result["old_root"], "To: " + result["new_root"],
                          result["transcript_notice"],
                          "" if result["applied"] else "Repeat with --apply to update this binding."]).rstrip()
    if "migration" in value:
        result = value["migration"]
        lines = [("Preview" if result["dry_run"] else result["status"]) + ": " + result["session_id"],
                 "From: " + result["source_root"], "To: " + result["destination_root"],
                 "Transcript revision: " + str(result["source_revision"]) + " → " + str(result["destination_revision"])]
        lines.extend(result.get("warnings", []))
        if result["dry_run"]:
            lines.append("Review the migration, then repeat with --apply. Nothing has moved yet.")
        else:
            lines += ["Original private evidence: " + result["archive_path"],
                      "Resume from the new workspace: " + result["resume"]]
        return "\n".join(lines)
    if "sessions" in value:
        lines = [f'{row["session_id"]}  {row["workspace_id"]}' for row in value["sessions"]]
        if value["has_more"]:
            lines.append("More remain. Repeat with --after " + value["next_cursor"])
        return "\n".join(lines) or "No associated sessions. Preview history with dgc pips workspace backfill."
    if "workspace" in value:
        item = value["workspace"]
        if item is None:
            return "No workspace is associated yet. Start a session with Pips enabled, or preview dgc pips workspace backfill."
        return f'{item["name"]} ({item["id"]})\nDirectory: {value["binding"]["canonical_root"]}\nRunner: {item["runner_id"]}'
    if "pips" in value:
        rows = value["pips"]
        if not rows:
            return 'No Pips in this workspace. Create one with: dgc pips create "Auditor" --goal "Inspect committed source"'
        return "\n".join(f'{row["id"]}  {row["name"]}  {row.get("pip_type", "rook")}  {row["status"]}  v{row["current_version"]}\n  {row["goal"]}' for row in rows)
    if "pip" in value:
        row = value["pip"]
        from .pip_sources import validate_policy as source_policy
        source = source_policy(row.get('source_policy', 'committed_only'))
        source_label = ('Current tree with safe_source_v1 exclusions; manual requests only'
                        if source['mode'] == 'current_tree' else 'Committed ref: ' + row['source_ref'])
        lines = [f'{row["name"]} ({row["id"]})', f'{row["status"]} · version {row["current_version"]} · {row["policy"]} · {row["trigger"]}',
                 "Type: " + row.get("pip_type", "rook"), "Source: " + source_label, "Goal: " + row["goal"]]
        if row.get("verification_plan") is not None:
            lines += ["Reviewed Pulse plan (no model):", json.dumps(row["verification_plan"], ensure_ascii=False, indent=2),
                      "Plan digest: " + str(row.get("verification_plan_digest")),
                      "Lifecycle revision: " + str(row.get("lifecycle_revision")),
                      "Review these commands, source and limits before running. Pass their exact version, lifecycle revision and plan digest to dgc pips run."]
        for proposal in row.get("proposals", []):
            lines += [f'Pending proposal {proposal["id"]} against version {proposal["expected_version"]}',
                      json.dumps(proposal["definition"], ensure_ascii=False), "Reason: " + proposal["reason"]]
        return "\n".join(lines)
    if "run" in value:
        run = value["run"]
        manifest = run["manifest"]
        from .pip_sources import projection as source_projection
        source = source_projection(manifest)
        lines = [f'{run["id"]} · {run["status"]}', f'Pip: {run["pip_id"]}',
                 f'Job version: {manifest["job_version"]} · model: {manifest["model"]}',
                 source['label'] + ': ' + source['identity']]
        if source['source_snapshot'] is not None:
            receipt = source['source_snapshot']
            lines.append(f"Captured {receipt['files']} files / {receipt['bytes']} bytes with safe_source_v1 exclusions; checked non-atomic copy.")
        if run.get("error"):
            lines.append("Error: " + str(run["error"].get("message", run["error"])))
        report = run.get("result")
        if manifest.get("pulse_verification") is not None:
            lines += ["Reviewed Pulse command plan; no model was invoked.",
                      "Plan digest: " + manifest["pulse_verification"]["plan_digest"],
                      "A zero exit code describes that invocation; it does not prove tests ran or the project is correct."]
            if manifest["job"]["verification_plan"]["action"]["network"] == "loopback_http_v1":
                lines.append("Local HTTP status checks only. The live app may differ from the recorded source; rendering and authenticated journeys are not verified.")
            if isinstance(report, dict) and report.get("classification") == "reviewed_command_outcomes":
                lines.append("Stopped: " + str(report.get("terminal_reason") or "still running"))
                approved = manifest["job"]["verification_plan"]["action"]["tests"]
                for entry in report["commands"]:
                    index = entry["index"]
                    state = entry["launch_state"]
                    label = {"not_started": "not started", "launch_reserved": "launch reserved; outcome unknown", "finished": "finished"}[state]
                    lines += [f"Command {index + 1}: {label}",
                              "argv: " + json.dumps(approved[index]["argv"], ensure_ascii=True),
                              "cwd: " + json.dumps(approved[index]["cwd"], ensure_ascii=True)]
                    outcome = entry.get("outcome")
                    if outcome is not None:
                        lines += ["Outcome: " + outcome["status"] + " · exit code: " + str(outcome["exit_code"]),
                                  "Output (quoted data): " + json.dumps(outcome["output"], ensure_ascii=True),
                                  "Output truncated: " + str(outcome["output_truncated"])]
            else:
                lines.append("No command receipt recorded yet. Do not assume a command ran or passed.")
            return "\n".join(lines)
        if isinstance(report, dict) and manifest.get("run_kind", "audit") in ("conversation", "personal_task"):
            return "\n".join(lines + ["", report.get("text", "")])
        if manifest.get("run_kind") == "draft":
            lines.append("Quill documentation draft; not applied to the workspace.")
            if isinstance(report, dict) and isinstance(report.get("draft"), dict):
                body = report["draft"]
                lines += [report.get("verification", "Model-authored draft."), "", report.get("title", ""),
                          report.get("summary", ""), "", body.get("markdown", ""), "", "Checked source citations:"]
                for citation in body.get("citations", []):
                    lines += [f'{citation["path"]}:{citation["line"]}', citation["excerpt"]]
                artifact = body.get("artifact", {})
                lines += ["Private draft artifact: " + str(artifact.get("path", "")),
                          "SHA256: " + str(artifact.get("sha256", "")), "Bytes: " + str(artifact.get("bytes", ""))]
            else:
                lines.append("No completed documentation draft is available yet.")
            return "\n".join(lines)
        if manifest.get("run_kind") in ("patch", "test"):
            lines += ["Reviewed execution; the user working tree was not changed.",
                      "Pinned handoff: " + json.dumps(manifest.get("handoff"), ensure_ascii=False, indent=2)]
            if isinstance(report, dict) and isinstance(report.get("execution"), dict):
                lines += ["Exact diff and test evidence:", json.dumps(report["execution"], ensure_ascii=False, indent=2),
                          "A zero exit code describes that invocation, not proof that every defect is fixed."]
            else:
                lines.append("No completed execution evidence recorded. Do not assume changes or tests succeeded.")
            return "\n".join(lines)
        if isinstance(report, dict):
            lines += ["", report.get("summary", ""), "Tests were not executed by this read-only audit."]
            for index, finding in enumerate(report.get("findings", [])):
                lines += [f'\nFinding {index}: {finding["title"]} [{finding["severity"]}]',
                          f'{finding["path"]}:{finding["line"]}', finding["evidence"],
                          "Source excerpt checked; the finding remains a model assessment."]
            lines += ["Limitation: " + item for item in report.get("limitations", [])]
        elif run["status"] == "queued":
            lines.append("Queued for the foreground supervisor. Read progress with dgc pips report " + run["id"])
        return "\n".join(lines)
    if "runs" in value:
        return "\n".join(f'{row["id"]}  {row["status"]}  {row["created_at"]}' for row in value["runs"]) or "No runs yet. Use dgc pips run PIP_ID while the supervisor is running."
    if "context" in value:
        context = value["context"]
        lines = [f'Workspace {context["workspace_id"]} · context revision {context["revision"]}']
        for entry in context["entries"]:
            lines += [f'\n{entry["id"]} · {entry["kind"]} · {entry["title"]}', entry["content"],
                      "Provenance: " + json.dumps(entry["provenance"], ensure_ascii=False)]
        if not context["entries"]:
            lines.append('No context records. Use dgc pips context record decision --title "Title" --content "Reference" --expected-revision ' + str(context["revision"]))
        return "\n".join(lines)
    return json.dumps(value, ensure_ascii=False, indent=2)


def _workspace_command(config, args):
    """Local-console path handling, deliberately absent from Remote's command allowlist."""
    if config.get("pips_enabled", False) is not True:
        raise RegistryError("disabled", "Pips are disabled in this profile. Run dgc pips enable to turn them on.")
    if args.workspace_action == "migrate-session":
        from .sessions import migrate_workspace_session
        return {"migration": migrate_workspace_session(
            config, args.session_id, workspace_id=args.workspace_id,
            source_root=args.source_root, expected_revision=args.expected_revision,
            dry_run=not args.apply)}
    if args.workspace_action == "backfill":
        from .workspace_sessions import backfill_sessions
        return {"backfill": backfill_sessions(config, dry_run=not args.apply,
                                              limit=args.limit, cursor=args.after or None)}
    with WorkspaceRegistry() as registry:
        if args.workspace_action == "rebind":
            new_root = canonical_directory(args.new_root)
            expected_root = Path(args.expected_root).expanduser().resolve(strict=False)
            workspace = registry.rebind(args.workspace_id, new_root,
                                        expected_root=expected_root, dry_run=not args.apply)
            return {"rebind": {"workspace_id": workspace["id"], "binding_id": workspace["binding_id"],
                              "old_root": str(expected_root),
                              "new_root": str(new_root),
                              "applied": args.apply,
                              "transcript_notice": "Pips and associated session identities are retained. Rebind alone does not migrate transcripts. To move a historical transcript, preview dgc pips workspace migrate-session from the new root with its workspace ID, session ID, old source root and exact transcript revision."}}
        workspace = (registry.get(args.workspace_id) if args.workspace_id else registry.lookup(config.project_root))
        if args.workspace_action == "show":
            return {"workspace": workspace, "binding": registry.binding(workspace["id"]) if workspace else None}
        if type(args.limit) is not int or not 1 <= args.limit <= 100:
            raise RegistryError("invalid_limit", "Session page limit must be between 1 and 100.")
        if not isinstance(args.after, str) or len(args.after) > 256 or "\x00" in args.after:
            raise RegistryError("invalid_cursor", "Session cursor must be a session ID.")
        if workspace is None:
            return {"workspace_id": None, "sessions": [], "next_cursor": args.after, "has_more": False}
        return registry.sessions(workspace["id"], after=args.after, limit=args.limit)


def handle_command(config, argv, *, in_chat=False):
    try:
        args = parser().parse_args(argv or ["list"])
    except SystemExit as exc:
        return int(exc.code or 0)
    from . import pip_daemon, pips
    from .redaction import redact_value, secret_values
    from .style import terminal_safe_text
    try:
        if args.command == "enable":
            config.set("pips_enabled", True)
            result = {"enabled": True, "next": "Run dgc pips serve in another terminal; existing emergency stop is unchanged."}
        elif args.command == "serve":
            if in_chat:
                raise RegistryError("separate_terminal", "Keep the supervisor separate from chat: run dgc pips serve in another terminal.")
            print("Starting the foreground Pips supervisor. Keep this terminal open; Ctrl+C stops its work.", file=sys.stderr, flush=True)
            result = pip_daemon.serve(config, enable=args.enable)
        elif args.command == "stop":
            if not args.yes:
                if not sys.stdin.isatty():
                    raise RegistryError("confirmation_required", "Emergency stop pauses every local Pip and cancels queued/running work. Repeat with --yes to confirm.")
                answer = input("Pause every local Pip and cancel their queued/running work? [y/N] ").strip().lower()
                if answer not in ("y", "yes"):
                    print("Cancelled. Pips were not changed."); return 0
            result = pip_daemon.stop_all(config, "local-console")
        elif args.command == "resume":
            result = pip_daemon.resume_runtime(config, "local-console")
        elif args.command == "status":
            with WorkspaceRegistry() as registry:
                result = pip_daemon.runner_status(registry)
        elif args.command == "workspace":
            result = _workspace_command(config, args)
        elif args.command == "capacity":
            if in_chat:
                raise RegistryError("separate_terminal", "Inspect local capacity from a separate terminal with dgc pips capacity.")
            from .pip_capacity import inspect_capacity
            result = inspect_capacity(config)
        elif args.command == "export-run":
            if in_chat:
                raise RegistryError("separate_terminal", "Export private evidence from a separate terminal with dgc pips export-run.")
            from .pip_export import export_run
            result = export_run(config, args.run_id, args.output, format=args.format)
        elif args.command == "service":
            from . import pip_service
            if in_chat and args.service_action not in ("preview", "status"):
                raise RegistryError("separate_terminal", "Manage the service from a separate terminal with dgc pips service; chat cannot install or control user services.")
            result = getattr(pip_service, args.service_action)(unit_directory=args.unit_directory)
        else:
            request = _request(args)
            if config.get("pips_enabled", False) is not True:
                raise RegistryError("disabled", "Pips are disabled in this profile. Run dgc pips enable to turn them on.")
            if args.command in ("run", "send") or (args.command == "handoff" and args.handoff_action == "accept"):
                _require_supervisor()
            if args.command == 'email-draft' and args.email_action == 'prepare' and 'message' not in request:
                answer=pips.handle_control(config,{'type':'get_pip_message_draft','draft_id':args.draft_id,'request_id':identifier('cli')},'local-console',start_worker=False)
                if not answer['ok']:raise RegistryError(answer['error']['code'],answer['error']['message'])
                saved=answer['result']['draft']
                if saved['digest']!=args.expected_digest:raise RegistryError('conflict','Read the exact draft before preparing its review.')
                request['message']=saved['payload']['message']
            if args.command == 'calendar-draft' and args.calendar_action == 'prepare' and 'event' not in request:
                answer=pips.handle_control(config,{'type':'get_pip_calendar_draft','draft_id':args.draft_id,'request_id':identifier('cli')},'local-console',start_worker=False)
                if not answer['ok']:raise RegistryError(answer['error']['code'],answer['error']['message'])
                saved=answer['result']['draft']
                if saved['digest']!=args.expected_digest:raise RegistryError('conflict','Read the exact draft before preparing its review.')
                request['event']=saved['payload']['event']
            if args.command == 'app-action' and args.app_action == 'accept':
                review=pips.handle_control(config,{'type':'get_pip_app_action','action_id':args.action_id,
                    'request_id':identifier('cli')},'local-console',start_worker=False)
                if not review['ok']:raise RegistryError(review['error']['code'],review['error']['message'])
                saved=review['result']['action']
                if saved['digest']!=args.expected_digest:raise RegistryError('action_conflict','The digest does not match this exact saved action.')
                print(terminal_safe_text(_format(review['result'])),file=sys.stderr,flush=True)
                if not args.yes:
                    if not sys.stdin.isatty():raise RegistryError('confirmation_required','Review the displayed account and exact action, then repeat with --yes to authorize one attempt.')
                    try:answer=input('Run this exact connector action once? [y/N] ' if saved['payload']['kind']=='connector_call' else ('Create this exact event/series and send the listed invitations once? [y/N] ' if saved['payload']['event'].get('send_invitations') else 'Create this exact calendar event/series once? [y/N] ') if saved['payload']['kind']=='calendar_create' else 'Send this exact message once? [y/N] ').strip().lower()
                    except EOFError:answer=''
                    if answer not in ('y','yes'):
                        print('Cancelled. No external action was attempted.');return 0
            if args.command == "setup" and args.setup_action == "accept":
                review = pips.handle_control(config, {"type": "get_pip_setup", "setup_id": args.setup_id,
                                                     "request_id": identifier("cli")}, "local-console", start_worker=False)
                if not review["ok"]:
                    raise RegistryError(review["error"]["code"], review["error"]["message"])
                saved = review["result"]["setup"]
                if saved["digest"] != args.expected_digest:
                    raise RegistryError("setup_conflict", "The setup digest changed. Review the saved card again.")
                print(terminal_safe_text(_format(redact_value(review["result"], secret_values(config)))), file=sys.stderr, flush=True)
                if not args.yes:
                    if not sys.stdin.isatty():
                        raise RegistryError("confirmation_required", "Review the displayed setup, then repeat with --yes to approve this exact card.")
                    try:
                        answer = input("Save this exact setup" + (" and queue one run" if saved['run_now'] else "") + "? [y/N] ").strip().lower()
                    except EOFError:
                        answer = ""
                    if answer not in ("y", "yes"):
                        print("Cancelled. Setup was not changed."); return 0
            if args.command == "handoff" and args.handoff_action == "accept":
                review = pips.handle_control(config, {"type": "get_pip_handoff", "handoff_id": args.handoff_id,
                                                     "request_id": identifier("cli")}, "local-console", start_worker=False)
                if not review["ok"]:
                    raise RegistryError(review["error"]["code"], review["error"]["message"])
                saved = review["result"]["handoff"]
                if saved["revision"] != args.expected_revision and not (saved["status"] == "accepted" and saved["resolved_by"] == "local-console"):
                    raise RegistryError("handoff_conflict", "The saved handoff revision changed. Review it again before approval.")
                shown = redact_value(review["result"], secret_values(config))
                print(terminal_safe_text(_format(shown)), file=sys.stderr, flush=True)
                if not args.yes:
                    if not sys.stdin.isatty():
                        raise RegistryError("confirmation_required", "Review the displayed envelope, then repeat with --yes to approve this exact saved handoff.")
                    try:
                        answer = input("Approve this exact saved handoff and queue one run? [y/N] ").strip().lower()
                    except EOFError:
                        answer = ""
                    if answer not in ("y", "yes"):
                        print("Cancelled. No handoff was accepted or queued."); return 0
            response = pips.handle_control(config, request, "local-console", start_worker=False)
            if not response["ok"]:
                raise RegistryError(response["error"]["code"], response["error"]["message"])
            result = response["result"]
        result = redact_value(result, secret_values(config))
        text = json.dumps(result, ensure_ascii=False, indent=2) if args.json or args.command == "status" else _format(result)
        print(terminal_safe_text(text))
        return 0
    except (RegistryError, OSError, sqlite3.Error, ValueError) as exc:
        error = {"code": getattr(exc, "code", "local_error"), "message": str(exc)}
        error = redact_value(error, secret_values(config))
        text = json.dumps({"error": error}, ensure_ascii=False) if args.json else "dgc pips: " + error["message"]
        print(terminal_safe_text(text), file=sys.stderr)
        return 1
