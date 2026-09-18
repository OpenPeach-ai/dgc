"""Authoritative DGC editor/headless protocol contract and code generation.

The Python backend imports this module directly.  The VS Code/Cursor client and the reviewable
JSON Schema are generated from the same data by ``scripts/generate-editor-protocol.py``; tests fail
when either checked-in artifact drifts from this source.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

PROTOCOL_VERSION = 14
MAX_EVENT_BYTES = 4 * 1024 * 1024
MAX_COMMAND_BYTES = 4 * 1024 * 1024
MAX_PENDING_BYTES = 4 * 1024 * 1024
MAX_PENDING_COMMANDS = 256
MAX_SAFE_INTEGER = (1 << 53) - 1

# v14: one list names every model_retry run kind and every error.cause.kind. dgc/model_errors.py
# imports it from here, never the reverse: this module imports only json, math and pathlib.
MODEL_FAILURE_KINDS = ("connect", "dns", "tls", "proxy", "reset", "connect_timeout", "http",
                       "rate_limited", "overloaded", "stream_cut", "stall", "loading", "auth",
                       "model_not_found", "engine", "other")
# v14: thinking provenance. "raw" is the model's own reasoning text, "summarized" a provider's
# summary of it, "narration" short provider progress text, "withheld" a block the provider did not
# return, "unknown" when DGC cannot tell. A private or loopback host is never summarized,
# narration or withheld.
REASONING_SOURCES = ("raw", "summarized", "narration", "withheld", "unknown")
REASONING_PROVIDERS = ("anthropic", "openai")
# v14: why get_image answered with no bytes.
IMAGE_UNAVAILABLE_REASONS = ("invalid_ref", "not_found", "changed", "too_large", "unreadable", "busy")


def _f(*kinds: str, required: bool = True, enum: tuple | None = None) -> dict:
    field = {"types": list(kinds), "required": required}
    if enum is not None:
        field["enum"] = list(enum)
    return field


_S = lambda required=True: _f("string", required=required)
_I = lambda required=True: _f("integer", required=required)
_B = lambda required=True: _f("boolean", required=required)
_O = lambda required=True: _f("object", required=required)
_A = lambda required=True: _f("array", required=required)
_N = lambda required=True: _f("number", required=required)
_NS = lambda required=True: _f("null", "string", required=required)
_NA = lambda required=True: _f("null", "array", required=required)


# ``required`` marks the minimum contract each consumer may rely on. Optional top-level fields are
# still declared and type-checked; undeclared fields fail closed so a mismatched or compromised
# backend cannot smuggle arbitrary data into the editor webview.
EVENT_FIELDS: dict[str, dict[str, dict]] = {
    "chat_changes": {"roots": _A(), "session_id": _S(), "request_id": _S()},
    "chat_change": {"root": _S(), "path": _S(), "before": _S(), "after": _S(), "kind": _S(),
                    "session_id": _S(), "request_id": _S()},
    "workspace_changes": {"roots": _A(), "request_id": _S()},
    "workspace_change": {"root": _S(), "path": _S(), "before": _S(), "after": _S(), "kind": _S(),
                         "request_id": _S()},
    "ready": {
        "version": _S(), "protocol_version": _I(), "capabilities": _O(),
        "model": _S(),
        "mode": _f("string", enum=("default", "acceptEdits", "plan", "auto")),
        "think": _f("string", enum=("off", "low", "medium", "high", "xhigh")),
        "ultra_mode": _B(False),
        "base_url": _S(), "subagent_base_url": _S(False), "fallback_base_url": _S(False),
        "project_root": _S(False),
        "workspace_trusted": _B(), "commands": _A(), "custom_commands": _A(),
        "session_id": _NS(False), "tools_supported": _B(False), "provider": _S(False),
        "provider_capabilities": _O(False), "tools": _A(False), "skills": _A(False),
        "goal": _O(), "context_size": _I(),
        "session_name": _S(False),
    },
    # ``kind`` lets the panel show a resumed goal as what it is instead of replaying the
    # objective as though the user had just typed it. v13: "continue" is the turn the editor's
    # Continue card starts after DGC's backend stopped in the middle of an ordinary turn -- a DGC
    # continuation marker, never words the user typed. v13: ``request_id`` names the prompt this
    # turn runs when the prompt carried one, so the panel removes exactly that message from its
    # queue -- a queued custom slash command (no id) must not consume the user's queued words.
    # v13: "monitor" is a turn DGC started on its own because a background monitor printed
    # something while the session was idle; ``prompt`` is then a short label, never user text.
    "turn_start": {"turn_id": _S(), "prompt": _S(),
                   "kind": _f("string", required=False,
                              enum=("prompt", "resume", "continue", "monitor", "wake")),
                   "request_id": _S(False)},
    # ``final_message_id`` names the prose block this turn designates as its answer, so the panel
    # stops guessing from position. Rule: the last ``stream_end`` of the turn
    # whose phase was "answer"; else -- only because turn_end is terminal -- the last one whose
    # phase was absent; else null. Reported for every reason, not just "completed": a stopped turn
    # still has an answer block, and the panel decides what chrome a partial one earns.
    "turn_end": {
        "turn_id": _S(), "reason": _f("string", enum=("completed", "cancelled", "error")),
        "token_estimate": _I(),
        "final_message_id": _NS(False),
    },
    # A calibrated range for the running turn; emitted only while it changes, never as a promise.
    "turn_eta": {
        "turn_id": _S(), "elapsed_seconds": _N(), "remaining_low_seconds": _N(),
        "remaining_high_seconds": _N(), "confidence": _N(), "label": _S(),
        "tasks_done": _I(False), "tasks_total": _I(False),
    },
    # What the turn is doing right now, stated by the backend instead of guessed by the panel.
    # A turn that is between model rounds because a gate continued it says so, rather than showing
    # a static spinner verb that is structurally incapable of changing. Emitted only when the
    # (state, label, detail) key changes, so a 500-chunk answer costs exactly one frame.
    "turn_activity": {
        "turn_id": _S(),
        "state": _f("string", enum=("thinking", "responding", "tool", "verifying",
                                    "compacting", "hook", "continuing", "waiting")),
        "label": _S(),
        "detail": _S(False),
    },
    "text_delta": {"text": _S()},
    # v14: a reasoning chunk names its block ("{turn_id}:think{n}" live, "h{N}:think{k}" on replay),
    # where the text came from, and -- for a sub-agent -- the innermost child's id (sub-<12 hex>).
    "thinking_delta": {"text": _S(), "block": _S(),
                       "source": _f("string", enum=REASONING_SOURCES),
                       "provider": _f("string", required=False, enum=REASONING_PROVIDERS),
                       "agent": _S(False)},
    # v14: a reasoning block closed. ``placement`` "inline" is only ever a summarized or narration
    # block of the main agent; ``seconds`` is finite 0..86400 with one decimal; ``truncated`` means
    # a persistence or replay bound cut the text.
    "thinking_end": {"block": _S(), "source": _f("string", enum=REASONING_SOURCES),
                     "provider": _f("string", required=False, enum=REASONING_PROVIDERS),
                     "agent": _S(False),
                     "placement": _f("string", enum=("collapsed", "inline")),
                     "seconds": _N(False), "truncated": _B(False)},
    # A prose block's identity and what the backend knows about it the moment it closes.
    # ``phase`` absent means "undetermined": the front-end must keep its legacy behaviour, exactly
    # as a null MessagePhase instructs. "commentary" is stated when the model round that produced
    # this prose ALSO produced tool calls -- the harness knows that for certain, so it says so
    # instead of letting the panel infer it from a tool card arriving afterwards. "answer" is a
    # CANDIDATE answer: at stream_end the loop has not reached its gates and cannot honestly claim
    # finality. ``message_id`` is absent when no prose was streamed, or outside a turn.
    "stream_end": {
        "message_id": _S(False),
        "phase": _f("string", required=False, enum=("commentary", "answer")),
    },
    "tool_call": {"call_id": _NS(False), "name": _S(), "args": _O(), "summary": _S()},
    "tool_progress": {
        "call_id": _NS(False), "name": _S(), "message": _S(),
        "progress": _N(False), "total": _N(False),
        "level": _f("string", required=False,
                    enum=("debug", "info", "notice", "warning", "error", "critical", "alert", "emergency")),
    },
    "tool_result": {
        "call_id": _NS(False), "name": _S(), "output": _S(), "is_error": _B(),
        "is_diff": _B(), "diff": _S(False),
    },
    # A tool result is text. A browser screenshot is not, so it rides its own event, correlated by
    # call_id, and the panel renders it under the step that produced it.
    # v14: images the model viewed. ``items[i]`` = {ref "img_"+32 hex, name, mime, width, height,
    # bytes, source browser|view_image|read_file|mcp, host} (never a path) describes ``images[i]``; an entry
    # over the frame budget is "" with its item kept and fetched later with get_image. ``omitted``
    # counts images past the per-step cap of 8.
    "tool_images": {
        "call_id": _NS(False), "images": _A(), "caption": _S(False),
        "items": _A(False), "omitted": _I(False),
    },
    # v14: the answer to get_image -- exactly one per request. ``image`` is a data URI, or "" with
    # ``reason`` when no bytes are available.
    "image": {
        "request_id": _S(), "ref": _S(), "image": _S(), "mime": _S(False),
        "width": _I(False), "height": _I(False), "path": _S(False),
        "reason": _f("string", required=False, enum=IMAGE_UNAVAILABLE_REASONS),
    },
    "tool_denied": {
        "call_id": _NS(False), "name": _S(), "args": _O(), "reason": _S(),
    },
    "todos": {"todos": _A()},
    "artifact_ready": {"id": _S(), "name": _S(), "url": _S(), "rel": _S()},
    "goal_changed": {
        "goal": _S(),
        "status": _f("string", enum=("none", "active", "paused", "completed", "blocked")),
        "elapsed_seconds": _I(False),
        "details": _O(False),
        "request_id": _S(False),
    },
    "info": {"message": _S()},
    # v14: ``cause`` says what failed when a model request gave up: {kind (MODEL_FAILURE_KINDS),
    # summary, endpoint?, model?, api_mode?, http_status?, attempts?, retry_id?, detail?, hint?}.
    # No credentials and no secret-bearing URLs: endpoint is scheme://host[:port]/path only.
    "error": {"message": _S(), "request_id": _S(False), "cause": _O(False)},
    # v14: one retry run of a model request, from the first lost attempt to its outcome. Frames of a
    # run share ``retry_id`` ("{turn_id}:retry{n}", a sub-agent's "{turn_id}:{agent}:retry{n}",
    # outside a turn "{backend_epoch}:retry{n}", on replay "h{N}:retry{k}"); terminal states repeat
    # attempt, kind, summary and endpoint. ``agent`` is the innermost sub-agent id.
    "model_retry": {
        "retry_id": _S(),
        "state": _f("string", enum=("retrying", "recovered", "gave_up", "cancelled")),
        "kind": _f("string", enum=MODEL_FAILURE_KINDS),
        "layer": _f("string", enum=("request", "continuation")),
        "attempt": _I(), "max_attempts": _I(False), "summary": _S(),
        "endpoint": _S(False), "turn_id": _S(False), "model": _S(False), "api_mode": _S(False),
        "detail": _S(False), "hint": _S(False), "http_status": _I(False), "delay_ms": _I(False),
        "origin": _f("string", required=False, enum=("agent", "subagent", "engine")),
        "agent": _S(False), "engine": _S(False),
    },
    "request_expired": {"id": _S()},
    "permission_request": {
        "id": _S(), "call_id": _NS(False), "name": _S(), "args": _O(),
        "command": _NS(False), "suggested_rule": _S(), "choices": _A(),
        # v7: what the step would do, so an editor can approve against a summary and a diff
        # instead of raw JSON, and say why it denied.
        "summary": _S(False), "diff": _NS(False),
    },
    # Additive v14 history fragment. It has no request id and can never accept a response.
    "permission_decision": {
        "call_id": _NS(False), "name": _S(), "args": _O(),
        "decision": _f("string", enum=("once", "always", "no")), "message": _S(),
    },
    "rule_added": {"rule": _S()},
    "plan_proposal": {"id": _S(), "plan": _S(), "choices": _A()},
    # v14: ``questions`` = [{id, header, question, multi_select, options: [{label, description,
    # recommended}]}], 1-4 questions of 2-6 options; ``call_id`` is the propose_options step. The
    # nested shape is validated by dgc/questions.py; the flattened question/options pair is gone.
    "options_request": {"id": _S(), "call_id": _NS(False), "questions": _A()},
    # v14: how a question request ended. ``id`` is null on replay; ``answers`` =
    # {question_id: {selected: [0-based index...], other: string}} when answered.
    "options_resolved": {
        "id": _NS(), "call_id": _NS(False),
        "outcome": _f("string", enum=("answered", "dismissed", "cancelled", "unavailable")),
        "questions": _A(), "answers": _O(False),
    },
    "mcp_input_request": {
        "id": _S(), "server": _S(),
        "kind": _f("string", enum=("elicitation", "sampling_request", "sampling_response")),
        "payload": _O(),
    },
    "context": {
        "request_id": _S(False),
        "used": _I(), "size": _I(), "compact_threshold": _N(False),
        "compact_at": _I(False), "input_tokens": _I(False),
        "output_tokens": _I(False), "cached_input_tokens": _I(False),
        "reasoning_tokens": _I(False), "requests": _I(False),
    },
    "compacted": {
        "request_id": _S(False),
        "status": _f("string", enum=("compacted", "pruned", "unchanged")),
        "strategy": _f("string", enum=(
            "provider_native", "model_summary", "mechanical", "tool_prune", "none")),
        "trigger": _f("string", enum=("automatic", "manual", "overflow", "resume")),
        "before_tokens": _I(), "after_tokens": _I(), "context_size": _I(),
        "freed_tokens": _I(), "fallback_reason": _S(False),
    },
    "artifacts": {"items": _A(), "request_id": _S(False)},
    "config": {
        "request_id": _S(False),
        "model": _S(),
        "mode": _f("string", enum=("default", "acceptEdits", "plan", "auto")),
        "think": _f("string", enum=("off", "low", "medium", "high", "xhigh")),
        "base_url": _S(), "api_mode": _S(False), "provider_state": _S(False),
        "prompt_cache": _B(False), "capability_cache_ttl_s": _I(False),
        "provider_capabilities": _O(False), "project_root": _S(), "search": _NS(False),
        "subagent_model": _S(False), "subagent_base_url": _S(False),
        "subagent_api_mode": _S(False), "subagent_api_key_set": _B(False),
        "fallback_model": _S(False), "fallback_base_url": _S(False),
        "fallback_api_mode": _S(False), "fallback_api_key_set": _B(False),
        "context_size": _I(False), "goal": _O(),
        "sandbox": _B(False), "sandbox_network": _B(False),
        "show_reasoning": _B(False), "preserve_thinking": _B(False),
        "ultra_mode": _B(False),
        "code_action": _B(False), "suggest": _B(False),
        "plan_artifact": _B(False), "artifact_autostart": _B(False),
        "artifact_in_plan": _B(False), "tool_profile": _S(False),
        "max_parallel_tasks": _I(False),
        "subscription_engine": _S(False), "subscription_engines": _A(False),
        "subscription_model": _S(False), "subscription_effort": _S(False),
        "monitor_wake": _B(False),
        # v14: short summarized/narration thinking shown inline, and its length cap (0..1000).
        "thinking_inline": _B(False), "thinking_inline_max_chars": _I(False),
    },
    "status": {
        "request_id": _S(False),
        "model": _S(),
        "mode": _f("string", enum=("default", "acceptEdits", "plan", "auto")),
        "think": _f("string", enum=("off", "low", "medium", "high", "xhigh", "max")),
        "base_url": _S(),
        "subscription_engine": _S(False),
        "ultra_mode": _B(False),
        "goal": _O(), "context_used": _I(), "context_size": _I(),
        # v13: a turn is running, queued to run, or a foreground operation (handoff, compaction)
        # holds the backend. The panel asks before a deferred restart, because turn_end alone does
        # not say whether the worker already has the next queued turn in hand.
        "busy": _B(False),
    },
    "model_changed": {"model": _S(), "base_url": _S(), "request_id": _S(False)},
    "mode_changed": {
        "request_id": _S(False),
        "message": _S(False),
        "mode": _f("string", enum=("default", "acceptEdits", "plan", "auto")),
        "workspace_trusted": _B(False),
    },
    "think_changed": {
        "think": _f("string", enum=("off", "low", "medium", "high", "xhigh", "max")),
        "request_id": _S(False),
    },
    "models": {
        "request_id": _S(), "ids": _A(), "base_url": _S(),
        "api_mode": _S(False), "error": _S(False),
    },
    "mcp_tools": {
        "request_id": _S(), "servers": _A(), "tools": _A(), "total": _I(),
        "offset": _I(), "next_offset": _f("null", "integer"), "error": _S(False),
    },
    "mcp_call_complete": {
        "request_id": _S(), "call_id": _S(), "name": _S(),
        "status": _f("string", enum=("completed", "denied", "cancelled", "error")),
        "output": _S(),
    },
    "skill_catalog": {"request_id": _S(), "items": _A(), "total": _I()},
    "skill_detail": {
        "request_id": _S(), "found": _B(), "name": _S(), "description": _S(),
        "source": _S(), "markdown": _S(),
    },
    "docs_catalog": {"request_id": _S(), "items": _A(), "total": _I()},
    "doc": {
        "request_id": _S(), "found": _B(), "id": _S(), "title": _S(),
        "description": _S(), "markdown": _S(),
    },
    "mcp_servers": {
        "request_id": _S(), "items": _A(), "total": _I(), "error": _S(False),
    },
    "permissions": {"request_id": _S(), "items": _A(), "total": _I()},
    "memory": {
        "request_id": _S(), "project": _S(), "user": _S(), "message": _S(False),
    },
    "session_named": {"request_id": _S(False), "name": _S()},
    "hook_catalog": {
        "request_id": _S(), "items": _A(), "total": _I(), "invalid": _I(),
    },
    "hook_activity": {
        "event": _f("string", enum=("SessionStart", "UserPromptSubmit", "PreToolUse",
                                     "PostToolUse", "PreCompact", "Stop")),
        "status": _f("string", enum=("started", "completed", "blocked",
                                      "cancelled", "error")),
        "configured": _I(), "duration_ms": _I(), "message": _NS(False),
    },
    "handoff_started": {"request_id": _S()},
    "skill_package": {"request_id": _S(), "name": _S(), "path": _S(), "operation": _S(), "files": _I()},
    "mcp_context_catalog": {"request_id": _S(), "server": _S(), "kind": _S(), "items": _A(), "error": _S(False)},
    "mcp_context": {"request_id": _S(), "server": _S(), "kind": _S(), "identifier": _S(),
                    "text": _S(), "omitted": _A(), "error": _S(False)},
    "mcp_command_result": {"request_id": _S(), "output": _S(), "context": _O(False),
                           "catalog": _O(False), "error": _S(False)},
    "handoff": {
        "request_id": _S(),
        "status": _f("string", enum=("completed", "cancelled", "error")),
        "markdown": _S(), "path": _NS(False), "error": _NS(False),
    },
    "queued": {"count": _I(), "text": _S()},
    "prompt_accepted": {"request_id": _S(), "state": _f("string", enum=("started", "queued", "steered")),
                        "message": _S(False)},
    "steering_update": {"request_id": _S(), "state": _f("string", enum=("applied", "queued", "returned")),
                        "message": _S(False)},
    "permission_resolved": {"id": _S(), "decision": _f("string", enum=("once", "no")), "message": _S()},
    "command_rejected": {
        "message": _S(), "command": _S(False), "reason": _S(False), "count": _I(False),
        "request_id": _S(False),
    },
    "workspace_roots": {"roots": _A(), "request_id": _S(False)},
    "saved_plan": {"plan": _S(), "exists": _B(), "request_id": _S(False)},
    "session": {
        "kind": _f("string", enum=("new", "cleared", "resumed", "forked")),
        "message_count": _I(), "session_id": _S(False), "path": _S(False),
        "name": _S(False),
        "request_id": _S(False),
    },
    "history": {"items": _A(), "request_id": _S(False), "todos": _A(False), "complete": _B(False)},
    "recall": {"items": _A(), "before": _I(), "more": _B(), "total": _I(),
               "request_id": _S(False)},
    "sessions": {"items": _A(), "deleted": _B(False), "request_id": _S(False)},
    "checkpoints": {"items": _A(), "request_id": _S(False)},
    "rewound": {"ok": _B(), "files_restored": _I(), "request_id": _S(False)},
    "retained_tasks": {
        "items": _A(), "errors": _A(False), "total": _I(False), "request_id": _S(False),
    },
    # ---- v13: background monitors (TUI + editor) ----------------------------------------------
    # A monitor is a command whose stdout lines reach the model as events: between tool calls
    # during a turn ("inline"), or by starting a turn on an idle session ("wake", turn_start kind
    # "monitor"). ``event_index`` counts one monitor's events from 1; it is deliberately not named
    # ``seq``, which every frame carries as the stream's own ordering.
    "monitor_started": {"id": _S(), "description": _S(), "command": _S(), "persistent": _B(),
                        "timeout_ms": _I(), "sandboxed": _B(False), "turn_id": _S(False)},
    "monitor_event": {"id": _S(), "description": _S(), "event_index": _I(), "lines": _A(),
                      "omitted_lines": _I(False),
                      "kind": _f("string", enum=("output", "ended", "background_exit")),
                      "delivery": _f("string", enum=("inline", "wake")), "turn_id": _S(False)},
    "monitor_ended": {"id": _S(), "description": _S(),
                      "reason": _f("string", enum=("exited", "stopped", "timeout", "flood",
                                                    "error", "shutdown")),
                      "exit_code": _f("null", "integer"), "events": _I(), "message": _S(False)},
    # items: {id, description, command, state: running|stopping|ended, events, pending_events,
    # persistent, timeout_ms, started_at (epoch s), end_reason?, exit_code?}
    "monitors": {"items": _A(), "wake_paused": _B(), "pending_events": _I(),
                 "request_id": _S(False)},
    # ---- v13 token usage (local ledger) -------------------------------------------------------
    # The answer to get_usage: what ~/.dgc/usage.sqlite holds for one range, aggregated on this
    # machine from what each provider reported. Nothing is fetched from a provider. Nested shapes:
    #   totals   {input_tokens, output_tokens, cached_input_tokens, requests, unmetered_requests}
    #   by_model [{model, provider, host, requests, unmetered_requests, input_tokens,
    #              output_tokens, cached_input_tokens}]  sorted by input+output tokens, at most 100
    #   by_day   [{date "YYYY-MM-DD" (local), input_tokens, output_tokens, cached_input_tokens,
    #              requests}]  every local day of the range, oldest first, zero days included
    # ``timezone`` names the local time the day boundaries follow; ``error`` is set (with zero
    # totals) when the ledger could not be read. ``host`` is an endpoint host[:port], never a URL.
    "usage_report": {
        "request_id": _S(),
        "range": _f("string", enum=("today", "7d", "30d", "month", "all")),
        "generated_at": _S(), "timezone": _S(False),
        "totals": _O(), "by_model": _A(), "by_day": _A(),
        "error": _S(False),
    },
    # ---- end v13 token usage -------------------------------------------------------------------
    # ---- v14: sub-agents (the agents indicator) -----------------------------------------------
    # Every task sub-agent started in this chat, at any depth. ``id`` is sub-<12 hex>, the same id
    # every ``agent`` field carries; ``parent_id`` is null for a child of the main agent;
    # ``call_id`` is the task step that started it (null for a restored record). Never replayed.
    "agent_started": {
        "id": _S(), "parent_id": _NS(), "call_id": _NS(), "description": _S(), "depth": _I(),
        "state": _f("string", enum=("queued", "running")), "started_at": _N(),
        "isolated": _B(), "parallel": _B(),
        "agent_type": _S(False), "model": _S(False), "turn_id": _S(False),
        "background": _B(False),
    },
    "agent_updated": {
        "id": _S(), "state": _f("string", enum=("queued", "running", "waiting")),
        "waiting_for": _f("string", required=False, enum=("permission", "answer")),
        "activity": _S(False), "model": _S(False), "tool_calls": _I(False), "tokens": _I(False),
    },
    "agent_ended": {
        "id": _S(), "state": _f("string", enum=("finished", "failed", "stopped")),
        "duration_ms": _I(), "tool_calls": _I(), "tokens": _I(False), "message": _S(False),
    },
    # The answer to list_agents, and the snapshot after a chat changes. ``items`` <= 64 (active
    # first, then the most recent ended); ``total`` and ``active`` are always exact.
    "agents": {"items": _A(), "total": _I(), "active": _I(), "request_id": _S(False)},
    # ---- end v14 sub-agents --------------------------------------------------------------------
}


COMMAND_FIELDS: dict[str, dict[str, dict]] = {
    "get_chat_changes": {"request_id": _S()},
    "get_chat_change": {"root": _S(), "path": _S(), "session_id": _S(), "request_id": _S()},
    "get_workspace_changes": {"request_id": _S()},
    "get_workspace_change": {"root": _S(), "path": _S(), "request_id": _S()},
    "prompt": {"text": _S(), "images": _NA(False), "context": _NA(False), "request_id": _S(False),
               "delivery": _f("string", required=False, enum=("steer", "queue")),
               "skills": _A(False), "templates": _A(False),
               "workflow": _f("string", required=False, enum=("plan", "review", "init"))},
    "slash_command": {"text": _S()},
    # v14: ``question_forms`` is still accepted and ignored (every v14 client takes question
    # forms); it is removed in v15.
    "set_workspace_roots": {"roots": _A(), "request_id": _S(False), "question_forms": _B(False)},
    "permission_response": {
        "id": _S(), "decision": _f("string", enum=("once", "always", "deny", "no")),
        "rule": _S(False), "reason": _S(False),
    },
    "plan_response": {
        "id": _S(),
        "decision": _f("string", enum=("auto", "acceptEdits", "default", "reject")),
        "feedback": _S(False),
    },
    # v14: exactly one of a non-empty ``answers`` ({question_id: {selected: [0-based index...],
    # other: string}}) or ``dismissed: true``. An invalid response leaves the request pending and is
    # answered by command_rejected. ``choice`` (v6) is removed.
    "options_response": {"id": _S(), "answers": _O(False), "dismissed": _B(False)},
    "mcp_input_response": {
        "id": _S(), "action": _f("string", enum=("accept", "decline", "cancel")),
        "content": _O(False),
    },
    "cancel": {},
    "interrupt": {},
    "set_mode": {
        "mode": _f("string", enum=("default", "acceptEdits", "plan", "auto")),
        "live": _B(False),
        "acknowledge_workspace_trust": _B(False), "request_id": _S(False),
    },
    "set_model": {
        "model": _S(False), "base_url": _S(False), "api_key": _S(False),
        "route": _f("string", required=False, enum=("native", "subscription")),
        "clear_stored_api_key": _B(False), "request_id": _S(False),
    },
    "list_models": {"request_id": _S(False)},
    "list_mcp_tools": {
        "request_id": _S(), "offset": _I(False), "limit": _I(False),
    },
    "call_mcp_tool": {
        "request_id": _S(), "call_id": _S(False), "name": _S(), "arguments": _O(),
    },
    "list_skills": {"request_id": _S()},
    "reload_skills": {"request_id": _S()},
    "get_skill": {"request_id": _S(), "name": _S()},
    "set_skill_enabled": {"request_id": _S(), "name": _S(), "enabled": _B()},
    "create_skill": {"request_id": _S(), "name": _S(), "description": _S(False), "scope": _S(False)},
    "install_skill": {"request_id": _S(), "source": _S(), "scope": _S(False), "allow_external": _B(False)},
    "list_mcp_context": {"request_id": _S(), "server": _S(), "kind": _S()},
    "get_history": {"request_id": _S()},
    "start_goal": {"request_id": _S(), "text": _S(), "token_budget": _I(False),
                   "skills": _A(False), "templates": _A(False), "images": _A(False), "context": _A(False)},
    "mcp_command": {"request_id": _S(), "arguments": _S()},
    "get_mcp_context": {"request_id": _S(), "server": _S(), "kind": _S(), "identifier": _S(), "arguments": _O(False)},
    "set_mcp_enabled": {"request_id": _S(), "name": _S(), "enabled": _B()},
    "reconnect_mcp_server": {"request_id": _S(), "name": _S()},
    "list_docs": {"request_id": _S()},
    "get_doc": {"request_id": _S(), "id": _S()},
    "list_mcp_servers": {"request_id": _S()},
    "upsert_mcp_server": {
        "request_id": _S(), "name": _S(), "runtime": _O(), "persisted": _O(),
        "interactive": _B(False),
    },
    "remove_mcp_server": {"request_id": _S(), "name": _S()},
    "reload_mcp_servers": {"request_id": _S()},
    "list_permissions": {"request_id": _S()},
    "add_permission_rule": {
        "request_id": _S(),
        "action": _f("string", enum=("allow", "ask", "deny")), "rule": _S(),
    },
    "remove_permission_rule": {
        "request_id": _S(),
        "action": _f("string", enum=("allow", "ask", "deny")), "rule": _S(),
    },
    "get_memory": {"request_id": _S()},
    "add_memory": {
        "request_id": _S(), "scope": _f("string", enum=("project", "user")), "text": _S(),
    },
    "list_hooks": {"request_id": _S()},
    "generate_handoff": {"request_id": _S(), "save": _B(False)},
    "set_think": {
        "level": _f("string", enum=("off", "low", "medium", "high", "xhigh", "max")),
        "request_id": _S(False),
    },
    "set_goal": {
        "text": _S(False),
        "status": _f("string", required=False,
                     enum=("none", "active", "paused", "completed", "blocked")),
        "token_budget": _I(False),
        "replace": _B(False),
        "request_id": _S(False),
    },
    "get_goal": {"request_id": _S(False)},
    "get_plan": {"request_id": _S(False)},
    "new_session": {"request_id": _S(False)},
    "fork_session": {"name": _S(False), "request_id": _S(False)},
    "resume_goal": {"request_id": _S(False)},
    # v13: continue an ordinary turn DGC's backend stopped in the middle of. The backend queues its
    # own continuation instruction (turn_start kind "continue"), answers a correlated request with
    # prompt_accepted, and advertises the command as ready.capabilities.resume_turn.
    "resume_turn": {"request_id": _S(False)},
    # Turns compaction folded away are archived beside the session. The panel pages back into
    # that archive so "Show earlier messages" keeps working past the summary marker, instead of
    # stopping at it with the rest of the conversation sitting unread on disk.
    "get_recall": {"before": _I(False), "limit": _I(False), "request_id": _S(False)},
    "name_session": {"name": _S(), "request_id": _S(False)},
    "clear_session": {"request_id": _S(False)},
    "resume_session": {"path": _NS(False), "latest": _B(False), "request_id": _S(False)},
    "list_sessions": {"request_id": _S(False)},
    "delete_session": {"path": _S(), "request_id": _S(False)},
    "list_checkpoints": {"request_id": _S(False)},
    "rewind": {"index": _I(), "request_id": _S(False)},
    # v12: the checklist is session state the user can drop without starting a new chat. The
    # backend answers with the existing `todos` event carrying an empty list.
    "clear_todos": {"request_id": _S(False)},
    "list_retained_tasks": {"request_id": _S(False)},
    "resolve_retained_task": {
        "id": _S(), "action": _f("string", enum=("apply", "drop")), "confirm": _B(False),
        "request_id": _S(False),
    },
    "compact": {"request_id": _S(False)},
    "list_artifacts": {"request_id": _S(False)},
    "stop_artifact": {"id": _S(), "request_id": _S(False)},
    # v14: ``values`` may carry thinking_inline (bool) and thinking_inline_max_chars (int 0..1000).
    "set_config": {"values": _O(), "request_id": _S(False)},
    "get_config": {"request_id": _S(False)},
    "status": {"request_id": _S(False)},
    "shutdown": {},
    # ---- v13: background monitors ------------------------------------------------------------
    # Both answer with `monitors`. stop_monitor is allowed while a turn runs; id "all" stops every
    # running monitor. Wake settings travel in set_config (monitor_wake and three bounded integers).
    "list_monitors": {"request_id": _S(False)},
    "stop_monitor": {"id": _S(), "request_id": _S(False)},
    # ---- v13 token usage (local ledger) -------------------------------------------------------
    # Read-only and allowed while a turn runs; answered by one usage_report with this request_id.
    "get_usage": {
        "request_id": _S(),
        "range": _f("string", enum=("today", "7d", "30d", "month", "all")),
    },
    # ---- end v13 token usage -------------------------------------------------------------------
    # ---- v14 --------------------------------------------------------------------------------------
    # Read-only and allowed while a turn runs. list_agents is answered by `agents`; get_image by
    # exactly one `image` event carrying this request_id (``ref`` is "img_" + 32 hex).
    "list_agents": {"request_id": _S(False)},
    "get_image": {"request_id": _S(), "ref": _S()},
    # ---- end v14 ----------------------------------------------------------------------------------
}

# Names the envelope owns. A payload field with either name would overwrite it on the wire
# (Emitter.emit builds {"type", "seq"} and then applies the fields), so none may be declared.
RESERVED_FIELD_NAMES = frozenset({"type", "seq"})
for _specs in (EVENT_FIELDS, COMMAND_FIELDS):
    for _name, _fields in _specs.items():
        _clash = RESERVED_FIELD_NAMES & set(_fields)
        if _clash:
            raise AssertionError(f"{_name} declares reserved protocol field {sorted(_clash)[0]!r}")


def _type_ok(value, kind: str) -> bool:
    if kind == "null":
        return value is None
    if kind == "string":
        return isinstance(value, str)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "integer":
        return (isinstance(value, int) and not isinstance(value, bool)
                and -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER)
    if kind == "number":
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return False
        try:
            return math.isfinite(value) and -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER
        except OverflowError:
            return False
    if kind == "array":
        return isinstance(value, list)
    if kind == "object":
        return isinstance(value, dict)
    return False


def _shown(value) -> str:
    if isinstance(value, str):
        return repr(value[:128] + ("…" if len(value) > 128 else ""))
    if value is None or isinstance(value, (int, float, bool)):
        return repr(value)
    return f"<{type(value).__name__}>"


def _message_error(value, specs: dict[str, dict[str, dict]], *, sequence: bool) -> str | None:
    if not isinstance(value, dict):
        return "message must be an object"
    name = value.get("type")
    if not isinstance(name, str) or name not in specs:
        return f"unknown message type {_shown(name)}"
    if sequence and (not _type_ok(value.get("seq"), "integer") or value["seq"] < 0):
        return "event seq must be a non-negative integer"
    allowed = {"type", *specs[name]}
    if sequence:
        allowed.add("seq")
    extra = sorted(set(value) - allowed)
    if extra:
        return f"{name} has undeclared field {_shown(extra[0])}"
    for key, field in specs[name].items():
        if key not in value:
            if field["required"]:
                return f"{name}.{key} is required"
            continue
        if not any(_type_ok(value[key], kind) for kind in field["types"]):
            return f"{name}.{key} has the wrong type"
        if "enum" in field and value[key] not in field["enum"]:
            return f"{name}.{key} has an unsupported value"
    return None


def event_error(value) -> str | None:
    return _message_error(value, EVENT_FIELDS, sequence=True)


def command_error(value) -> str | None:
    return _message_error(value, COMMAND_FIELDS, sequence=False)


def _json_type(field: dict) -> dict:
    kinds = field["types"]
    def branch(kind: str) -> dict:
        value = {"type": kind}
        if kind in ("integer", "number"):
            value.update(minimum=-MAX_SAFE_INTEGER, maximum=MAX_SAFE_INTEGER)
        return value
    # JSON Schema permits ``type: [..]``, but strict AJV requires a consumer-specific
    # ``allowUnionTypes`` option for it.  Explicit branches keep the generated public contract
    # portable across default draft-2020 validators.
    schema: dict = (branch(kinds[0]) if len(kinds) == 1 else {
        "anyOf": [branch(kind) for kind in kinds]
    })
    if "enum" in field:
        schema["enum"] = field["enum"]
    return schema


def _message_schema(name: str, fields: dict[str, dict], *, sequence: bool) -> dict:
    properties = {"type": {"const": name}}
    required = ["type"]
    if sequence:
        properties["seq"] = {"type": "integer", "minimum": 0,
                             "maximum": MAX_SAFE_INTEGER}
        required.append("seq")
    for key, field in fields.items():
        properties[key] = _json_type(field)
        if field["required"]:
            required.append(key)
    return {"type": "object", "properties": properties,
            "required": required, "additionalProperties": False}


def schema_document() -> dict:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": f"urn:vibedgc:editor-protocol:v{PROTOCOL_VERSION}",
        "title": f"DGC editor protocol v{PROTOCOL_VERSION}",
        "description": "A DGC editor command or backend event frame.",
        "oneOf": [{"$ref": "#/$defs/event"}, {"$ref": "#/$defs/command"}],
        "$defs": {
            "event": {"oneOf": [_message_schema(k, v, sequence=True)
                                  for k, v in EVENT_FIELDS.items()]},
            "command": {"oneOf": [_message_schema(k, v, sequence=False)
                                    for k, v in COMMAND_FIELDS.items()]},
        },
    }


def schema_text() -> str:
    return json.dumps(schema_document(), indent=2, ensure_ascii=False) + "\n"


def typescript_source() -> str:
    event_specs = json.dumps(EVENT_FIELDS, indent=2, ensure_ascii=False)
    command_specs = json.dumps(COMMAND_FIELDS, indent=2, ensure_ascii=False)
    event_names = " | ".join(json.dumps(name) for name in EVENT_FIELDS)
    command_names = " | ".join(json.dumps(name) for name in COMMAND_FIELDS)
    return f'''// GENERATED by scripts/generate-editor-protocol.py from dgc/editor_protocol.py.
// Do not edit this file directly.

export const DGC_PROTOCOL_VERSION = {PROTOCOL_VERSION} as const;
export const MAX_EVENT_BYTES = {MAX_EVENT_BYTES};
export const MAX_COMMAND_BYTES = {MAX_COMMAND_BYTES};
export const MAX_PENDING_BYTES = {MAX_PENDING_BYTES};
export const MAX_PENDING_COMMANDS = {MAX_PENDING_COMMANDS};

export type DgcEventType = {event_names};
export type DgcCommandType = {command_names};
export interface DgcEvent {{ type: DgcEventType; seq: number; [key: string]: any; }}
export interface DgcCommand {{ type: DgcCommandType; [key: string]: any; }}

type FieldSpec = {{ types: string[]; required: boolean; enum?: unknown[] }};
const EVENT_FIELDS: Record<string, Record<string, FieldSpec>> = {event_specs};
const COMMAND_FIELDS: Record<string, Record<string, FieldSpec>> = {command_specs};

function isObject(value: unknown): value is Record<string, unknown> {{
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}}

function typeOk(value: unknown, kind: string): boolean {{
  if (kind === "null") return value === null;
  if (kind === "string") return typeof value === "string";
  if (kind === "boolean") return typeof value === "boolean";
  if (kind === "integer") return Number.isSafeInteger(value);
  if (kind === "number") return typeof value === "number" && Number.isFinite(value)
    && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  if (kind === "array") return Array.isArray(value);
  if (kind === "object") return isObject(value);
  return false;
}}

function shown(value: unknown): string {{
  if (typeof value === "string") {{
    const short = value.slice(0, 128) + (value.length > 128 ? "…" : "");
    return JSON.stringify(short);
  }}
  if (value === null || ["number", "boolean", "undefined"].includes(typeof value)) {{
    return String(value);
  }}
  return `<${{Array.isArray(value) ? "array" : typeof value}}>`;
}}

function messageError(value: unknown, specs: Record<string, Record<string, FieldSpec>>,
                      sequence: boolean): string | undefined {{
  if (!isObject(value)) return "message must be an object";
  const name = value.type;
  if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(specs, name)) {{
    return `unknown message type ${{shown(name)}}`;
  }}
  if (sequence && (!Number.isSafeInteger(value.seq) || Number(value.seq) < 0)) {{
    return "event seq must be a non-negative integer";
  }}
  const allowed = new Set(["type", ...(sequence ? ["seq"] : []), ...Object.keys(specs[name])]);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) return `${{name}} has undeclared field ${{shown(extra)}}`;
  for (const [key, field] of Object.entries(specs[name])) {{
    if (!Object.prototype.hasOwnProperty.call(value, key)) {{
      if (field.required) return `${{name}}.${{key}} is required`;
      continue;
    }}
    if (!field.types.some((kind) => typeOk(value[key], kind))) {{
      return `${{name}}.${{key}} has the wrong type`;
    }}
    if (field.enum && !field.enum.includes(value[key])) {{
      return `${{name}}.${{key}} has an unsupported value`;
    }}
  }}
  return undefined;
}}

export function dgcEventError(value: unknown): string | undefined {{
  return messageError(value, EVENT_FIELDS, true);
}}

export function dgcCommandError(value: unknown): string | undefined {{
  return messageError(value, COMMAND_FIELDS, false);
}}
'''


def generated_artifacts(root: Path) -> dict[Path, str]:
    """Every checked-in artifact derived from this module, with the text it must hold."""
    generated_schema = schema_text()
    return {
        root / "schemas" / f"editor-protocol-v{PROTOCOL_VERSION}.schema.json": generated_schema,
        root / "dgc" / "schemas" / f"editor-protocol-v{PROTOCOL_VERSION}.schema.json": generated_schema,
        root / "editors" / "vscode" / "src" / "protocol.generated.ts": typescript_source(),
    }


def write_generated(root: Path) -> tuple[Path, Path, Path]:
    artifacts = generated_artifacts(root)
    for path, text in artifacts.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    schema_path, package_schema_path, ts_path = artifacts
    return schema_path, package_schema_path, ts_path
