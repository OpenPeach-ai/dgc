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
# v14: why a user's message did not reach a background sub-agent. CLOSED here and total at the
# emitter: Emitter.emit RAISES on a validator failure (dgc/protocol.py:41), from the thread that
# reads stdin, so an undeclared reason does not degrade one frame -- it throws inside the command
# loop. Backend._AGENT_MESSAGE_WIRE_REASON maps every reason Agent.message_detached can return
# into this tuple and defaults to "unknown", so a reason added to the Agent later stays harmless.
AGENT_MESSAGE_REASONS = ("unknown", "starting", "finished", "stopping", "queue_full")
# v14: how many identity faces a sub-agent can wear. `agent_started.face_slot` and
# `agents.items[].face_slot` are 0..AGENT_FACE_SLOTS-1 and a client reduces a slot modulo its own
# face count; there is no enum, so a later CLI can widen the range without failing an older client.
AGENT_FACE_SLOTS = 8


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
    "prompt_pips": {"request_id": _S(), "workspace_id": _S(), "pips": _A(), "next_cursor": _NS()},
    # Local editor Pips controls. Only sent in response to a capability-gated command.
    "pips_result": {"request_id": _S(), "command": _S(), "ok": _B(),
                    "result": _O(False), "error": _O(False)},
    "pips_status": {"enabled": _B(), "api_version": _I(), "restart_required": _B(),
                    "message": _S(), "request_id": _S(False)},
    # A finished Pip run that reports to this chat (capability pip_reports): a card in the
    # transcript, never a turn. `report` is {run_id, pip_id, name, pip_type, kind (audit|checks),
    # outcome (findings|clear|failed|checks_failed|checks_passed), finished_at, earlier, total?,
    # counts?, findings? [{title, severity, path?, line?}], checks?, failed_checks?, reason?, detail?};
    # an open object, so it can grow. History replays the same card as {role: "pip_report", report}.
    "pip_report": {"report": _O()},
    # The screen's bytes for the viewer (base64), and the end of a stream with its reason.
    "pip_desktop_data": {"pip_id": _S(), "data": _S()},
    "pip_desktop_closed": {"pip_id": _S(), "reason": _S()},
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
                              enum=("prompt", "resume", "continue", "monitor", "wake", "pip_setup")),
                   "request_id": _S(False)},
    # ``final_message_id`` names the prose block this turn designates as its answer, so the panel
    # stops guessing from position. Rule: the last ``stream_end`` of the turn
    # whose phase was "answer"; else -- only because turn_end is terminal -- the last one whose
    # phase was absent; else null. Reported for every reason, not just "completed": a stopped turn
    # still has an answer block, and the panel decides what chrome a partial one earns.
    "turn_end": {
        "turn_id": _S(), "reason": _f("string", enum=("completed", "cancelled", "error", "paused")),
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
    # v14: files the model produced and asked to show, as chips under the step that made them.
    # A PATH, never bytes -- a screen recording is orders of magnitude past the 4 MiB frame
    # ceiling, and the editor already knows how to open a file. ``items[i]`` = {name, rel, bytes,
    # caption}; ``rel`` is workspace-relative and the panel re-validates it before opening.
    "files_ready": {"call_id": _NS(False), "items": _A(), "caption": _S(False)},
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
    "request_expired": {"id": _S(), "message": _S(False)},
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
    # An open question the model asked mid-turn. This is NOT a request/response pair: the turn did
    # not stop for it, `ask_id` is the answer's identity, and the answer arrives later as an
    # ordinary steering prompt tagged with `answers`.
    # ``options`` turns the open question into a picker WITHOUT making the turn wait for it: the
    # card still sits in the transcript, still folds to a line you can answer later, and the answer
    # still arrives as an ordinary tagged prompt. Only sent to a client that declared
    # capabilities.ask_options, because a field an older peer has not declared fails the whole
    # session (the SDK raises DGCProtocolError; the extension disposes the backend) -- it would
    # show no card at all, and no chat either.
    "ask_request": {"call_id": _NS(False), "ask_id": _S(), "question": _S(),
                    "context": _S(False), "suggestions": _A(False), "options": _A(False)},
    # How an open question ended -- for every client drawing its card, and for replay.
    "ask_resolved": {"call_id": _NS(False), "ask_id": _S(),
                     "outcome": _f("string", enum=("answered", "skipped", "expired", "unavailable")),
                     "question": _S(), "answer": _S(False)},
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
        "context_size": _I(False), "subagent_context_size": _I(False), "goal": _O(),
        # Opt-in (get_config `fields`): the shared web search's address, and whether its key is saved.
        "search_url": _S(False), "search_api_key_set": _B(False),
        # Opt-in too: ChatDGC's custom instructions and personality.
        "chatdgc_about": _S(False), "chatdgc_style": _S(False), "chatdgc_personality": _S(False),
        "chatdgc_window": _S(False),
        # Opt-in too: whether DGC keeps one memory about the user (Settings -> Memory), and whether ChatDGC may
        # search the web at all (Settings -> Web search; on, it searches when an answer depends on it).
        "memory": _B(False), "chatdgc_web": _B(False), "chatdgc_followups": _B(False),
        # Opt-in too: tokens one turn may spend, sub-agents included; 0 is no cap (Settings -> General).
        "turn_token_budget": _I(False),
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
    # 0.48: the prompt-cache settings, for Settings -> Models. Sent before `config` to a client whose
    # get_config `fields` named "cache_settings" (an older client never asks, so never sees it).
    # prompt_cache_ttl is the Anthropic cache-entry lifetime; ollama_keep_alive is how long a local
    # Ollama keeps the model loaded after the last reply ("" sends none: Ollama's own default).
    "cache_settings": {
        "request_id": _S(False), "prompt_cache": _B(),
        "prompt_cache_ttl": _f("string", enum=("5m", "1h")), "ollama_keep_alive": _S(),
    },
    # 0.48: the Pips-wide settings, for Settings -> Agents. Sent before `config` to a client whose get_config
    # `fields` named "pips_settings" (an older client never asks, so never sees it). `model` is the model every
    # Pip on Default uses, on DGC's own connection (set_config `pips_model`); "" follows DGC: its model, or its
    # subscription CLI.
    "pips_settings": {"request_id": _S(False), "model": _S()},
    # 0.48: how long DGC waits on a model, for Settings -> Models -> Advanced. Sent before `config` to a client whose
    # get_config `fields` named "model_wait_settings" (an older client never asks, so never sees it). `first_token` is
    # model_first_token_timeout_s: "auto" (no limit for a model on this computer or network, which DGC asks whether it
    # is still working; 300 s for a remote one) or a whole number of seconds, "0" for no limit. `between_words_s` is
    # model_idle_timeout_s, seconds of silence mid-answer, 0 for no limit.
    "model_wait_settings": {"request_id": _S(False), "first_token": _S(), "between_words_s": _I()},
    # 0.48: the prompt cache's clock for this chat, only where DGC knows it from the provider itself:
    # Anthropic (the reply's own cache read/write and the TTL it wrote) and a local Ollama (its own
    # /api/ps unload time). "unknown": no minutes (every other provider). "warm": the cache lasts
    # until expires_ms (epoch ms; the client turns it cold once that passes). "cold": gone, with
    # `reason` compacted (the conversation was summarised past it) or unloaded (Ollama let the model
    # go); a warm clock that runs out is "expired" on the client. anchor_ms is the send time of the
    # request the clock runs from; tokens is the prompt a next message re-caches; resumed marks the
    # state sent as a saved chat is reopened.
    "cache_clock": {
        "state": _f("string", enum=("unknown", "warm", "cold")),
        "source": _f("string", required=False, enum=("anthropic", "ollama")),
        "anchor_ms": _I(False), "expires_ms": _I(False), "ttl_s": _I(False),
        "reason": _f("string", required=False, enum=("expired", "compacted", "unloaded")),
        "tokens": _I(False), "resumed": _B(False), "session_id": _S(False),
    },
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
    "plugin_catalog": {"request_id": _S(False), "items": _A(), "installed": _S(False)},
    "composio_connection": {"request_id": _S(), "toolkit": _S(), "status": _S(), "message": _S(), "url": _S(False)},
    "plugin_preview": {"request_id": _S(), "item": _O()},
    "plugin_marketplaces": {"request_id": _S(), "items": _A()},
    "plugin_operation": {"request_id": _S(), "action": _S(), "name": _S(False), "path": _S(False), "message": _S(), "removed_servers": _A(False)},
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
    # The /learn draft, shown with Save, Edit and Cancel: `ok` false says why in `message`. `scope` is where Save
    # would put it and `folder` that place.
    "skill_draft": {"request_id": _S(), "ok": _B(), "name": _S(False), "description": _S(False),
                    "markdown": _S(False), "scope": _S(False), "folder": _S(False), "message": _S(False)},
    "skill_saved": {"request_id": _S(), "ok": _B(), "name": _S(False), "path": _S(False), "scope": _S(False),
                    "message": _S(False)},
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
    # The answer to get_outline: every prompt of the session, oldest first, however little of it the panel has
    # drawn. `prompts`: {id, text (its first words, or "Image"), at? (when it was sent, seconds since 1970),
    # archived? (folded away by compaction: id "a<n>", the archive's n-th prompt)}; a prompt still in the
    # session has the id of the turn it opens in the history snapshot ("h3", or a running turn's own id).
    "outline": {"request_id": _S(), "session_id": _S(), "prompts": _A()},
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
    # ready.capabilities.monitor_restart: a reopened chat (resume_session) starts again, once, each
    # monitor that was running when DGC stopped, and sends one of these per monitor after the
    # resume's other events: `restarted` (its monitor_started follows), `stopped` (the permissions
    # in force now do not allow it: `restart` offers restart_monitor {key}), `expired` (its time
    # ran out while DGC was closed) or `failed`. `message` is the line to show; `stopped_at` is
    # when it stopped watching (epoch s). Also the answer to restart_monitor (`by_user`, request_id).
    # History replays it as {role: "monitor_restart", key, id, state, description, message, at}.
    "monitor_restart": {"key": _S(), "id": _S(), "description": _S(), "command": _S(),
                        "state": _f("string", enum=("restarted", "stopped", "expired", "failed")),
                        "message": _S(), "stopped_at": _f("null", "integer"), "at": _I(),
                        "restart": _B(), "by_user": _B(False), "request_id": _S(False)},
    # ready.capabilities.task_interrupted: after the resume's monitor_restart lines, one per background
    # command (`shell`), sub-agent (`agent`) or troupe the restart stopped. A command or sub-agent is
    # `stopped` and never run again on its own: `actions` offers run_again (and resume, for a
    # sub-agent) through rerun_task {key, how}. A troupe is `resumed` from its journal, or `stopped`
    # with resume when the permissions in force now would not start it. Also the answer to rerun_task
    # (`started`, `resumed`, `stopped` when a deny wins, `failed`). History replays it as
    # {role: "task_interrupted", kind, key, id, state, description, message, at}. The agent map's
    # background_shells then lists a stopped command as {id: "was-<id>", state: "stopped", rerun: key}.
    "task_interrupted": {"key": _S(), "kind": _f("string", enum=("shell", "agent", "troupe")),
                         "id": _S(), "description": _S(), "command": _S(),
                         "state": _f("string", enum=("stopped", "started", "resumed", "failed")),
                         "message": _S(), "stopped_at": _f("null", "integer"), "at": _I(),
                         "actions": _A(), "by_user": _B(False), "request_id": _S(False)},
    # ---- background tasks (the Agent map; ready.capabilities.background_tasks = {version: 1}) ----
    # Every background shell (`bash` with background: true) of this chat, the whole list each time:
    # items {id "bg<n>", command (the redacted label, never the raw command), state running|exited|
    # killed, started_at, ended_at (epoch s, null while running or while a killed one is reaped),
    # exit_code (null until reaped), agent_id (the sub-agent that started it, null for the main
    # agent)}. Oldest first; ended shells stay until the chat is reset. Pushed when one starts, is
    # killed or ends -- but only to a client that has sent one of the three commands below, so a
    # client that cannot send them never receives this -- and in answer to list_background_shells
    # and stop_background_shell, with their request_id.
    "background_shells": {"items": _A(), "request_id": _S(False)},
    # Only ever the answer to get_background_output. `output` is the tail of what DGC kept of the
    # shell's or monitor's output, redacted, at most max_bytes; `total_bytes` is all it printed;
    # `truncated` says `output` is not the whole of it.
    "background_output": {"request_id": _S(), "id": _S(), "output": _S(), "total_bytes": _I(),
                          "truncated": _B()},
    # ---- troupes (dgc/troupe.py): many sub-agents on one work order, in the background --------
    # Sent only to a client whose ready.capabilities has `troupe`. Each carries the run's snapshot:
    # state running|done|stopped|failed, reason (why it stopped), stages [{name, total, done, failed,
    # kept, dropped?}], agents_planned (an estimate), reused (results kept from an earlier attempt),
    # journal (the folder holding its work order and results). `troupes` answers list_troupes.
    "troupe_started": {"run_id": _S(), "title": _S(), "state": _S(), "reason": _S(), "stages": _A(),
                       "agents_planned": _I(), "reused": _I(), "journal": _S()},
    "troupe_progress": {"run_id": _S(), "title": _S(), "state": _S(), "reason": _S(), "stages": _A(),
                        "agents_planned": _I(), "reused": _I(), "journal": _S()},
    "troupe_finished": {"run_id": _S(), "title": _S(), "state": _S(), "reason": _S(), "stages": _A(),
                        "agents_planned": _I(), "reused": _I(), "journal": _S()},
    "troupes": {"runs": _A(), "request_id": _S(False)},
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
    # The answer to get_pip_usage_report (capability pip_usage_report): the Pips tab of Token
    # Usage. A breakdown of the same range's totals, never added to them: ``all_tokens`` is the
    # whole range (input + output), ``totals`` {input_tokens, output_tokens, runs} the Pips' part.
    #   by_pip [{pip_id, name, pip_type, scope "personal"|"project", project, status, input_tokens,
    #            output_tokens, runs, daily_cap (int|null), models [{model, provider, host,
    #            input_tokens, output_tokens, requests}] (its top 5; [] before runs recorded them)}]
    #            most tokens first, at most 200
    #   by_model [{model, provider, host, requests, unmetered_requests, input_tokens, output_tokens,
    #             cached_input_tokens}]  the Pips' requests in the range by model, most tokens first
    # ``omitted`` counts Pips past that; ``error`` is set when the registry or ledger was unreadable.
    "pip_usage_report": {
        "request_id": _S(),
        "range": _f("string", enum=("today", "7d", "30d", "month", "all")),
        "generated_at": _S(), "timezone": _S(False),
        "all_tokens": _I(), "totals": _O(), "by_pip": _A(), "by_model": _A(), "omitted": _I(),
        "error": _S(False),
    },
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
        # The lowest face slot no working agent of this chat held when it started, kept for the
        # agent's life and saved with the session (0..AGENT_FACE_SLOTS-1). Sent only to a client
        # that sent set_workspace_roots.agent_faces: an undeclared field fails an older client's
        # session. agents.items[].face_slot follows the same gate.
        "face_slot": _I(False),
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
    # One step of a PARALLEL child's work, live, while it is still working.
    #
    # A parallel child buffers its trace so the parent transcript replays each one atomically
    # instead of interleaving four children into an unreadable stream. That is right for the
    # parent's transcript and wrong for the child's OWN page, which is a single-agent view where
    # interleaving cannot happen -- so that page sat empty behind a running timer for as long as
    # the child worked (27 minutes, reported 2026-09-24). This carries the step to that page and
    # nowhere else. `step` is a small record: {type: tool_call|tool_result|text, name, call_id,
    # args, output, is_error, text}, already redacted by the child's own UI.
    "agent_step": {"agent_id": _S(), "step": _O(), "seq_in_agent": _I(False)},
    # Only ever the answer to `background_now` (capabilities.background_now), so a client that cannot
    # send that command never receives it. What the person moved to the background: a sub-agent
    # (`kind` "agent", `agent_id` its sub-<12 hex>) or a `bash` command (`kind` "command"); `call_id`
    # is the tool row the turn was waiting on. The waiting call's tool_result follows with the words
    # the model gets; a sub-agent's `agents` snapshot now lists it with `background: true`, and a
    # command is in `background_shells` as the bg<n> it became.
    "moved_to_background": {"request_id": _S(), "kind": _f("string", enum=("agent", "command")),
                            "agent_id": _S(False), "call_id": _S(False)},
    # A message the USER sent to ONE running background sub-agent, and whether the child took it.
    #
    # Only ever a REPLY to `agent_control`, which is why `request_id` is REQUIRED and not optional:
    # a client that cannot send that command can never receive this event, so nothing has to be
    # echoed back on the handshake to gate it. (An unknown event TYPE is survivable -- the
    # extension skips it, editors/vscode/src/backend.ts:273 -- but it shows the user "skipped a
    # backend event it does not handle yet" once per type, so silence is better than tolerance.)
    # A model's own `message_task` call draws as an ordinary tool card and emits nothing here.
    #
    # `delivered: false` is the load-bearing field. Agent.steer refuses when the child is not
    # accepting steering, when it is cancelled, and past _MAX_STEER_MESSAGES/_MAX_STEER_CHARS, and
    # a user's words must never be dropped in silence. `reason` is present only when it is false.
    # `text` is the message as sent, redacted, so a SECOND window on this session can draw it.
    "agent_message": {"agent_id": _S(), "text": _S(), "delivered": _B(), "request_id": _S(),
                      "reason": _f("string", required=False, enum=AGENT_MESSAGE_REASONS)},
    # ---- end v14 sub-agents --------------------------------------------------------------------
}


COMMAND_FIELDS: dict[str, dict[str, dict]] = {
    "list_prompt_pips": {"request_id": _S(), "query": _S(False), "after": _S(False), "limit": _I(False)},
    # The nested request uses the existing bounded Pip control API. Authorization,
    # its per-command field allowlist and 16KiB limit are checked by the backend.
    "pips_control": {"request": _O()},
    "pips_enable": {"enabled": _B(), "request_id": _S(False)},
    # A client that draws Pip reports asks for them (capability pip_reports): until it does, this chat
    # is sent no pip_report and none is taken from the registry, so an older client misses nothing.
    "watch_pip_reports": {"request_id": _S(False)},
    # Dismiss a Pip report's card in this chat (capability pip_reports). Saved with the transcript.
    "pip_report_dismiss": {"run_id": _S(), "request_id": _S(False)},
    "pips_runtime": {"action": _f("string", enum=("start", "resume")), "request_id": _S()},
    # A Pip computer's screen (capability pips_desktop): open a stream, send the viewer's bytes
    # (base64), close it. The editor never gets a socket or a path.
    "pip_desktop": {"pip_id": _S(), "op": _f("string", enum=("open", "send", "close")), "data": _S(False)},
    "get_chat_changes": {"request_id": _S()},
    "get_chat_change": {"root": _S(), "path": _S(), "session_id": _S(), "request_id": _S()},
    "get_workspace_changes": {"request_id": _S()},
    "get_workspace_change": {"root": _S(), "path": _S(), "request_id": _S()},
    # ``answers`` marks a prompt as the reply to open questions: [{"ask_id", "question"}]. Without
    # it a message steered while a question is open is just a message -- a follow-up on another
    # subject must never be recorded as an answer.
    "prompt": {"text": _S(), "images": _NA(False), "context": _NA(False), "request_id": _S(False),
               "answers": _NA(False), "pip_references": _A(False),
               # Images handed over as files in the backend's spool rather than inlined as base64.
               # Only sent by a client that saw capabilities.image_spool, so an older backend is
               # never offered a field it would reject as undeclared.
               "spooled_images": _NA(False),
               "delivery": _f("string", required=False, enum=("steer", "queue")),
               "skills": _A(False), "templates": _A(False),
               "workflow": _f("string", required=False, enum=("plan", "review", "init"))},
    "slash_command": {"text": _S()},
    # Move queued prompts (by their request_id) into the running turn as steering: "Steer now" / "Steer all".
    # Each that moves is announced as prompt_accepted "steered"; none moving is command_rejected
    # "not_steerable". Sent only to a CLI whose ready.capabilities has steer_queued.
    "steer_queued": {"request_ids": _A(), "request_id": _S(False)},
    # v14: ``question_forms`` is still accepted and ignored (every v14 client takes question
    # forms); it is removed in v15.
    # ``open_asks`` is how a client says it can show a question the turn did not stop for. The
    # backend never emits ask_request/ask_resolved to a client that did not ask for them, and the
    # model is not offered the tool when no frontend can show one.
    # ``ask_options`` is the same promise one step further: this client can draw the OPTIONS on an
    # open question, not just its text box. A client that says open_asks but not ask_options still
    # gets the question, without them.
    # ``agent_faces``: this client draws the backend's face slots. Sent only to a CLI that
    # advertised capabilities.agent_faces, for the same reason as open_asks.
    "set_workspace_roots": {"roots": _A(), "request_id": _S(False), "question_forms": _B(False),
                            "open_asks": _B(False), "ask_options": _B(False),
                            "agent_faces": _B(False)},
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
    # The user waved the question away. The model is told, at the next context boundary, so it
    # decides and says what it assumed rather than waiting for an answer that is not coming.
    "ask_skip": {"ask_id": _S(), "request_id": _S(False)},
    # The editor says it is still there. Additive and capability-gated ("editor_liveness"),
    # so a newer editor talking to an older backend just collects one command_rejected and
    # carries on -- no protocol version bump, and no fixture/capture churn.
    "ping": {},
    # What is actually ON SCREEN, and who saw it. Additive and capability-gated ("editor_state"),
    # like `ping` above: an older backend answers one command_rejected, no version bump, no
    # fixture churn. ``source`` is the field that carries the weight. Only "renderer" is evidence
    # that a window exists, because an extension host left behind by a window reload keeps running
    # its own timers and no API tells it that it was orphaned -- so a host may report that its view
    # was disposed, but it can never prove that its window is still there.
    "editor_state": {"source": _f("string", enum=("renderer", "host")),
                     "view": _f("string", enum=("open", "closed"))},
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
    "list_plugins": {"request_id": _S()},
    "install_plugin": {"request_id": _S(), "name": _S(), "accept_license": _S(False), "selected_servers": _A(False)},
    "composio_connection": {"request_id": _S(), "action": _f("string", enum=("connect", "check")), "toolkit": _f("string", enum=("gmail", "googlecalendar", "googledrive", "figma"))},
    "inspect_plugin": {"request_id": _S(), "name": _S()},
    "uninstall_plugin": {"request_id": _S(), "name": _S()},
    # A plugin's own key (GitHub's personal access token, Brevo's MCP key), from the field on its page; offered when
    # ready.capabilities.plugin_keys. The key goes to the system keychain and never comes back to the editor.
    "set_plugin_key": {"request_id": _S(), "name": _S(), "key": _S(), "server": _S(False), "env": _S(False)},
    "remove_plugin_key": {"request_id": _S(), "name": _S(), "server": _S(False), "env": _S(False)},
    # What a plugin's sign-in may do (GitHub's checklist "What DGC may do on GitHub"): ``scopes`` names the optional
    # permissions turned on, by the ids in plugin_catalog keys[].sign_in_scopes (the always-on ones are implied). It
    # takes effect at the next sign-in, answered with plugin_operation and plugin_catalog. ``sign_in_again`` sets the
    # current sign-in aside and signs in with the choice at once, answered like a Connect: plugin_catalog, and
    # command_rejected if it didn't connect. Offered when ready.capabilities.plugin_sign_in_scopes.
    "set_plugin_sign_in_scopes": {"request_id": _S(), "name": _S(), "scopes": _A(), "sign_in_again": _B(False)},
    "list_plugin_marketplaces": {"request_id": _S()},
    "add_plugin_marketplace": {"request_id": _S(), "source": _S()},
    "remove_plugin_marketplace": {"request_id": _S(), "name": _S()},
    "refresh_plugin_marketplace": {"request_id": _S(), "name": _S()},
    "create_plugin": {"request_id": _S(), "name": _S(), "display_name": _S(), "description": _S()},
    "reload_skills": {"request_id": _S()},
    "get_skill": {"request_id": _S(), "name": _S()},
    "set_skill_enabled": {"request_id": _S(), "name": _S(), "enabled": _B()},
    "create_skill": {"request_id": _S(), "name": _S(), "description": _S(False), "scope": _S(False)},
    "install_skill": {"request_id": _S(), "source": _S(), "scope": _S(False), "allow_external": _B(False)},
    "list_mcp_context": {"request_id": _S(), "server": _S(), "kind": _S()},
    "get_history": {"request_id": _S()},
    "start_goal": {"request_id": _S(), "text": _S(), "token_budget": _I(False), "expected_goal_id": _S(False),
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
        "interactive": _B(False), "connector": _S(False), "accept_license": _S(False),
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
    # /learn (ready.capabilities.learn): draft a skill from this session, or (`pip_id`) from that Personal Pip's
    # chat, about `request` when given. Answered by `skill_draft`; nothing is written. save_skill writes the shown,
    # maybe edited, SKILL.md (`scope` project: this folder's .dgc/skills, only when trusted; user: ~/.dgc/skills),
    # never over another skill, and journals it so Undo on the Memory page deletes it. Answered by `skill_saved`.
    "learn_skill": {"request_id": _S(), "request": _S(False), "pip_id": _S(False)},
    "save_skill": {"request_id": _S(), "markdown": _S(), "scope": _f("string", enum=("project", "user")),
                   "pip_id": _S(False)},
    "set_think": {
        "level": _f("string", enum=("off", "low", "medium", "high", "xhigh", "max")),
        "request_id": _S(False),
    },
    "set_goal": {
        "expected_goal_id": _S(False),
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
    # Every prompt of the session, for the editor's prompt rail (offered as ready.capabilities.outline): a
    # long chat opens on its latest pages. Answered by `outline`.
    "get_outline": {"request_id": _S()},
    "name_session": {"name": _S(), "request_id": _S(False)},
    "clear_session": {"request_id": _S(False)},
    "resume_session": {"path": _NS(False), "latest": _B(False), "request_id": _S(False)},
    "list_sessions": {"request_id": _S(False), "limit": _I(False), "offset": _I(False), "query": _S(False)},
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
    # What fills this session's context window, part by part (offered as ready.capabilities.context_breakdown):
    # answered by `context_breakdown` (with no conversation_id: that's a ChatDGC chat's).
    "context_breakdown": {"request_id": _S(False)},
    "list_artifacts": {"request_id": _S(False)},
    "stop_artifact": {"id": _S(), "request_id": _S(False)},
    # v14: ``values`` may carry thinking_inline (bool) and thinking_inline_max_chars (int 0..1000).
    "set_config": {"values": _O(), "request_id": _S(False)},
    # `fields`: config fields added after v14 first shipped that this client understands (see
    # Backend._config_fields); an editor that lists none never receives them.
    "get_config": {"request_id": _S(False), "fields": _A(False)},
    "status": {"request_id": _S(False)},
    "shutdown": {},
    # ---- v13: background monitors ------------------------------------------------------------
    # Both answer with `monitors`. stop_monitor is allowed while a turn runs; id "all" stops every
    # running monitor. Wake settings travel in set_config (monitor_wake and three bounded integers).
    "list_monitors": {"request_id": _S(False)},
    "stop_monitor": {"id": _S(), "request_id": _S(False)},
    # capabilities.monitor_restart: the Restart on a monitor_restart note with `restart`. Answered
    # with monitor_restart, or command_rejected (turn_in_progress, unknown_monitor).
    "restart_monitor": {"key": _S(), "request_id": _S(False)},
    # capabilities.task_interrupted: Run again (`how` again, the default) or Resume on a
    # task_interrupted line. Answered with task_interrupted, or command_rejected (turn_in_progress,
    # unknown_task).
    "rerun_task": {"key": _S(), "how": _f("string", required=False, enum=("again", "resume")),
                   "request_id": _S(False)},
    # Background tasks (capabilities.background_tasks): read and stop only, allowed while a turn runs.
    # list_ and stop_background_shell answer with `background_shells`; an id this chat does not have
    # is command_rejected (reason unknown_task). get_background_output answers with exactly one
    # `background_output`; `id` is a background shell's or a monitor's, and max_bytes (default 65536)
    # is capped at 1 MiB.
    "list_background_shells": {"request_id": _S(False)},
    "stop_background_shell": {"id": _S(), "request_id": _S(False)},
    "get_background_output": {"id": _S(), "request_id": _S(), "max_bytes": _I(False)},
    # Troupes: both answer with `troupes`; stop_troupe stops one run (its agents stop, its report says what it
    # finished) and is allowed while a turn runs.
    "list_troupes": {"request_id": _S(False)},
    "stop_troupe": {"run_id": _S(), "request_id": _S(False)},
    # ---- v13 token usage (local ledger) -------------------------------------------------------
    # Read-only and allowed while a turn runs; answered by one usage_report with this request_id.
    "get_usage": {
        "request_id": _S(),
        "range": _f("string", enum=("today", "7d", "30d", "month", "all")),
    },
    # Read-only and allowed while a turn runs; answered by one pip_usage_report.
    "get_pip_usage_report": {
        "request_id": _S(),
        "range": _f("string", enum=("today", "7d", "30d", "month", "all")),
    },
    # ---- end v13 token usage -------------------------------------------------------------------
    # ---- v14 --------------------------------------------------------------------------------------
    # Read-only and allowed while a turn runs. list_agents is answered by `agents`; get_image by
    # exactly one `image` event carrying this request_id (``ref`` is "img_" + 32 hex).
    "list_agents": {"request_id": _S(False)},
    "get_image": {"request_id": _S(), "ref": _S()},
    # Steer or stop ONE background sub-agent, for the USER. `id` is the child's `sub-<12 hex>`, as
    # `agent_started.id` and `agents.items[].id` carry it. With capabilities.agent_control_foreground,
    # "close" also stops one FOREGROUND sub-agent at any depth without ending the turn.
    #
    # The `action` enum is declared HERE on purpose: _dispatch validates with command_error(cmd)
    # before any arm runs, so an action the CLI does not implement is rejected as invalid_command
    # and the handler's two-way branch is exhaustive with no third arm to keep in step.
    # `text` cannot be "required when action is message" in this table, so the handler rejects that
    # case itself as invalid_message.
    # `request_id` is required because both actions are correlated: "message" is answered by
    # exactly one `agent_message` carrying it, "close" by the refreshed `agents` snapshot.
    "agent_control": {"action": _f("string", enum=("message", "close")), "id": _S(),
                      "request_id": _S(), "text": _S(False)},
    # capabilities.background_now = {version: 1}: Run in background. The person moves what the
    # running turn is waiting on to the background: a foreground sub-agent of the main agent
    # (`agent_id`) or a foreground `bash` command of the main agent (`call_id`, its tool_call's id;
    # a `task` row's call_id names its sub-agent). Exactly one of the two. The waiting call returns
    # at once, the work goes on untouched as a background sub-agent or background shell, and its
    # end wakes the chat. Allowed while a turn runs -- that is when there is something to move.
    # Answered with `moved_to_background`, or command_rejected (invalid_command, not_waiting: the
    # turn is no longer waiting on it, usually because it has just finished).
    "background_now": {"request_id": _S(), "agent_id": _S(False), "call_id": _S(False)},
    # ---- end v14 ----------------------------------------------------------------------------------
}

# ---- chats: several sessions, each in its own directory, in one backend -------------------------
# `open_chat` starts one in `cwd` (resolved to its project root as `dgc serve` resolves its own).
# The reply is `chat_opened`, ready's per-chat half, or a `command_rejected` naming why. From the
# first open_chat on, every chat-scoped event and command carries the envelope's `chat_id`; an
# event without one belongs to the default chat. A client that never sends open_chat never sees
# the field. Advertised as ready.capabilities.chats = {version, max, default}.
COMMAND_FIELDS["open_chat"] = {"request_id": _S(), "cwd": _S()}
COMMAND_FIELDS["close_chat"] = {"request_id": _S()}
EVENT_FIELDS["chat_opened"] = {"request_id": _S(), **{
    key: field for key, field in EVENT_FIELDS["ready"].items()
    if key not in ("version", "protocol_version", "capabilities")}}
EVENT_FIELDS["chat_closed"] = {"request_id": _S(False),
                                "reason": _f("string", enum=("closed", "handed_over"))}

# ---- a session that keeps running with no window (dgc/serve_detach.py) ---------------------------
# Advertised as ready.capabilities.detach = {version, idle_exit_s, waiting_exit_s, max_windowless_s,
# elsewhere?}. `set_detach {keep_running}` opts in (sent right after ready); `detach` says "this
# window is going: keep running while there is work" and is sent INSTEAD of shutdown on a window's
# teardown. A client that never sends set_detach -- an older editor, the SDK, ACP -- is unchanged:
# end of input or shutdown ends the process. A window that reattaches gets a `ready` whose
# capabilities.attached = {chats: [{chat_id, session_id, cwd, turn, queued, waiting}], windowless_s,
# work, pid}, then `chat_opened` (request_id "attached") for each other chat, then one
# `session_live` per chat. `turn` is {turn_id, kind, prompt, started_at} or null; `queued` is
# [{request_id, text}] and `waiting` the ids of the open approvals and questions, which get_history
# announces again. The window it displaced hears `session_moved` and is closed.
# `list_live_sessions` is answered by `live_sessions`: every DGC process on this computer
# ({pid, kind, instance, version, attached, detachable, windowless_s, uptime_s, work, status,
# liveness, here, sessions: [{session_id, name, cwd, status}]}); `stop_live_session` asks one to save
# and stop, and is answered by `live_sessions` again (with a `message`).
COMMAND_FIELDS["set_detach"] = {"keep_running": _B(False)}
# The Sessions home's backend (it carries ChatDGC) opts in with `set_detach_chatdgc {keep_running}` instead, offered
# as ready.capabilities.detach.chatdgc = 1: the same rules, but only a ChatDGC reply is work that keeps it running with
# no window. A reattached window's `chatdgc_open` of a chat mid-reply carries the reply so far in `messages`.
# list_live_sessions' items then say `scope` ("chatdgc" for such a backend) and `chats` [{conversation_id, title}],
# the chats it is answering.
COMMAND_FIELDS["set_detach_chatdgc"] = {"keep_running": _B(False)}
# Open here for a ChatDGC chat, offered as ready.capabilities.detach.chatdgc_open_here = 1 by such a backend: one window
# writes to a chat at a time, and Open here moves one chat, never the process. `chatdgc_shown` says which chats this
# window's tabs show (all of them, whenever that changes); until it is sent nothing is held, as before. A chat another
# window's DGC holds then opens as last saved (`chatdgc_opened`), followed by `chatdgc_held` {state "elsewhere", pid}:
# read-only, and a change to it is refused. `chatdgc_open_here` takes it: answered by `chatdgc_held` {state "here",
# request_id} and `chatdgc_opened` (request_id), while the window it came from hears `chatdgc_held` {state "moved"}.
# Taken mid-reply, the reply goes on in the process writing it and its events come through this one, the reply so far
# in that `chatdgc_opened` (busy); a change meanwhile waits. Once the reply ends the chat is this process's for good,
# said by `chatdgc_held` {state "here"} with no request_id, which is also how a chat its holder lets go becomes this
# window's by itself: open it again to show it as it is now.
COMMAND_FIELDS["chatdgc_shown"] = {"conversation_ids": _A()}
COMMAND_FIELDS["chatdgc_open_here"] = {"request_id": _S(), "conversation_id": _S()}
EVENT_FIELDS["chatdgc_held"] = {"conversation_id": _S(), "state": _f("string", enum=("here", "elsewhere", "moved")),
                                "pid": _I(False), "request_id": _S(False)}
COMMAND_FIELDS["detach"] = {}
COMMAND_FIELDS["list_live_sessions"] = {"request_id": _S()}
COMMAND_FIELDS["stop_live_session"] = {"pid": _I(), "instance": _S(), "request_id": _S()}
EVENT_FIELDS["session_live"] = {"session_id": _S(), "cwd": _S(), "turn": _f("object", "null"),
                                 "queued": _A(), "waiting": _A()}
EVENT_FIELDS["session_moved"] = {"reason": _S()}
EVENT_FIELDS["live_sessions"] = {"items": _A(), "request_id": _S(False), "message": _S(False)}
# After a resume's replay, to a client that opted in: a turn of this session was stopped while no
# window was attached (an hour waiting on an answer, the twelve-hour limit, `dgc stop`), so nobody saw
# it end. The editor offers Continue (`resume_turn`). The session's next turn clears it.
EVENT_FIELDS["turn_interrupted"] = {"session_id": _S(), "cause": _S(), "at": _N()}
# Where a chat another window holds is open, and what runs there (0.48): the line beside Open here.
# Advertised as ready.capabilities.session_holder = 1 (only a Host). `editor_app {name}` says which
# editor this window is ("Cursor", "VS Code": at most 40 characters); nothing answers it, and the
# process's note says it until another window takes the wire. `session_holder {request_id,
# session_id}` asks about a session another DGC process holds, read from that process's note, and is
# answered by the `session_holder` event: `found` false when no process says (an older DGC, or none
# holds it), else `editor` (the holding window's, "" when it hasn't said), `windowless` (kept running
# by DGC with no window open), `folder` (the chat's folder, "~/..." under the home folder, else only
# its last name), `working` (a turn runs there), `idle_s` (seconds since the session last changed,
# when not working) and how many of each run or wait there: `monitors`, `helpers` (background
# helpers), `commands` (background commands), `queued` (queued prompts), `waiting` (approvals and
# questions waiting for an answer).
COMMAND_FIELDS["editor_app"] = {"name": _S()}
COMMAND_FIELDS["session_holder"] = {"request_id": _S(), "session_id": _S()}
_HOLDER_FIELDS = {"found": _B(), "editor": _S(False), "windowless": _B(False), "folder": _S(False),
                  "working": _B(False), "idle_s": _I(False)}
EVENT_FIELDS["session_holder"] = {"request_id": _S(), "session_id": _S(), **_HOLDER_FIELDS,
                                  "monitors": _I(False), "helpers": _I(False), "commands": _I(False),
                                  "queued": _I(False), "waiting": _I(False)}
# The same for a ChatDGC chat, offered as ready.capabilities.chatdgc.holder = 1: `chatdgc_holder
# {request_id, conversation_id}`, answered by `chatdgc_holder` with the same facts (`working`: a reply
# is being written there; `idle_s`: since the chat last changed).
COMMAND_FIELDS["chatdgc_holder"] = {"request_id": _S(), "conversation_id": _S()}
# One process writes to a session at a time, for as long as it has it open, idle or not (0.48, dgc/session_owner.py):
# an editor window, a terminal, a DGC kept running with no window, an SDK program. Advertised as
# ready.capabilities.session_owner = 1. `watch_session_owner` says this client shows a session another process has
# open read-only, with Open here: from then on resume_session of such a session loads it to be read, followed by
# `session_held {session_id}`, and nothing is written to it; `session_held` also says when this chat let its session
# go to Open here elsewhere (a terminal, or a window that couldn't take this process). Without it, resume_session of a
# session another process has open is refused with command_rejected reason "session_held", its message naming where it
# is open, and nothing changes. Open here from a window (DGC_ATTACH=steal) asks a terminal (or a DGC it can't attach
# to) to let the session go; one that keeps it, because something runs in it, leaves ready.capabilities.detach
# .elsewhere with reason "busy".
COMMAND_FIELDS["watch_session_owner"] = {"request_id": _S(False)}
EVENT_FIELDS["session_held"] = {"session_id": _S()}
EVENT_FIELDS["chatdgc_holder"] = {"request_id": _S(), "conversation_id": _S(), **_HOLDER_FIELDS}

# ---- Ask DGC to fix: a Pip report fixed in the background of its chat (dgc/pip_fix.py) ----------
# Advertised as ready.capabilities.pip_fix = 1. `start_pip_fix {run_id}` starts a background
# sub-agent in this chat's session for the report of that run (one the chat was shown, or one of its
# project's Pips' runs: a card is then shown for it as for any report): no turn, the chat stays free.
# The fix's record goes out as `pip_fix {fix}` when it starts and every time it changes (state,
# step), a reply to start_pip_fix or undo_pip_fix carrying its request_id. `fix` is an open object
# (a client reads the keys it knows): {fix_id, run_id, pip_id, name, pip_type, agent_id, state
# (queued | preparing | running | applying | applied | partial | unchanged | not_applied | failed |
# stopped | interrupted | undone), step?, queued_behind?, created_at, started_at?, ended_at?,
# files?: [{path, kind, additions, deletions, counted}], held?: [{path, why}], merged?: [path],
# tests?: {state: passed | failed | not_run, command?, note?}, summary?, message?, deps?: [{command,
# state, note?}], undo?: {state: available | done | partial, restored?, kept?: [{path, why}]}}.
# `agent_id` is the sub-agent's, as agent_started has it: its Watch is that agent's page, its Stop
# `agent_control close`, and a permission it asks for carries a call_id starting with it. A report
# card replayed by get_history carries its latest fix as `report.fix`. `list_pip_fixes` answers
# `pip_fixes {items}` (this chat's fixes, newest first). `undo_pip_fix {fix_id}` puts back every file
# the fix wrote that still holds what it left. `get_pip_fix_change {fix_id, path}` answers
# `pip_fix_change` with what the file held before and after the fix (kind added | deleted | edited),
# or, for a file it held back, the project's file and the fix's version (kind held). A refusal of any
# of them is command_rejected with a reason and a message to show.
COMMAND_FIELDS["start_pip_fix"] = {"run_id": _S(), "request_id": _S(False)}
COMMAND_FIELDS["undo_pip_fix"] = {"fix_id": _S(), "request_id": _S(False)}
COMMAND_FIELDS["list_pip_fixes"] = {"request_id": _S(False)}
COMMAND_FIELDS["get_pip_fix_change"] = {"fix_id": _S(), "path": _S(), "request_id": _S()}
EVENT_FIELDS["pip_fix"] = {"fix": _O(), "request_id": _S(False)}
EVENT_FIELDS["pip_fixes"] = {"items": _A(), "request_id": _S(False)}
EVENT_FIELDS["pip_fix_change"] = {"request_id": _S(), "fix_id": _S(), "path": _S(), "before": _S(),
                                  "after": _S(), "kind": _S()}

# ---- Which of this chat's Pips are running now (dgc/pip_report_delivery.py running) -----------------
# Advertised as ready.capabilities.pip_runs_running = 1. `watch_pip_runs` asks; the answer is a
# `pip_runs_running` event naming its request, and from then on one is sent, unasked, whenever the
# list changes (a run starts or ends, or the chat becomes another session). `items` are the runs going
# now whose card comes to this chat (the Pips attached to it or set up in it, and the runs it started
# with run_pip_now; source reviews, Pulse checks and live-data runs only), oldest first, each an open
# object (a client reads the keys it knows): {run_id, pip_id, name, pip_type, started_at,
# trigger (schedule | event | you | chat | handoff | setup)}. An empty list: none is running. A client
# that never asks never gets one.
COMMAND_FIELDS["watch_pip_runs"] = {"request_id": _S(False)}
EVENT_FIELDS["pip_runs_running"] = {"items": _A(), "request_id": _S(False)}

# ---- A finished background agent's report in the chat (0.48, dgc/agent_reports.py) ---------------
# Advertised as ready.capabilities.agent_reports = 1. `watch_agent_reports` says this client draws
# them; nothing answers it. From then on a turn a finished background sub-agent started (turn_start
# kind "wake") is followed by one `agent_report` per agent it delivers, and get_history replays the
# same event after a saved wake turn's turn_start (before the watch, a saved wake replays as it always
# did). `id` is the agent's id as agent_started had it (a reopened chat's records are renumbered:
# match on the spawn's result, which names it); `description` what it was asked to do; `report` its
# whole outcome as the model got it, redacted and bounded (what became of its changes, then
# "Summary:" and what it said); `integrated` whether any of its changes reached the checkout. A
# client that never asks never gets one, so an older editor keeps its "Woke on agent" note.
COMMAND_FIELDS["watch_agent_reports"] = {"request_id": _S(False)}
EVENT_FIELDS["agent_report"] = {"id": _S(), "description": _S(), "report": _S(), "integrated": _B(),
                                "turn_id": _S(False)}

# ---- A finished helper continued with its memory (0.48, dgc/helper_memory.py) -------------------
# Advertised as ready.capabilities.continue_agent = 1. `watch_agent_runs` says this client draws a helper's runs; it is
# answered by an `agent_runs` naming its request, and from then on one follows every `agents` snapshot and comes
# whenever a helper's runs change (a run ends and its conversation is kept, or a helper is continued, or a continuation
# could not start). `items` are open objects (a client reads the keys it knows), one per helper of this chat that can
# be continued or has been: {id, runs, continuable, history: [{run, by ("you" | "model"), at?, request?, note?,
# report?, held}]}. `id` is the agent's, as agent_started has it; `runs` how many runs it has had (the one under way
# included); `continuable` whether "Ask it to do more" may be offered now (it has ended and its conversation is kept);
# `history` its runs, oldest first, at most 20: `at` when a continued run started, `request` what it was asked then
# (run 1's prompt is the spawn's), `note` what became of that run's changes and `report` what it said, both bounded,
# `held` whether that run's work was held back. A continued helper keeps its row: agent_started is never sent again,
# and its record goes back to running in the next `agents` snapshot (and its steps' call ids carry the run,
# "sub-…:r2-…", so a page can divide its runs). `continue_agent {id, text, request_id}` is the person's "Ask it to do
# more": the helper continues in the background with its memory, in a fresh copy of the project, and reports back like
# a background helper (a wake turn and its agent_report). Answered by `agent_runs` carrying the request_id, or
# `command_rejected` (command continue_agent) with a reason -- unknown_agent, still_running, not_kept, busy,
# plan_mode, denied, invalid_text, too_large, chat_changed, unavailable, failed -- and a message to show. A client
# that never asks is sent nothing new, and an older CLI has no continue_agent: no box.
COMMAND_FIELDS["watch_agent_runs"] = {"request_id": _S(False)}
COMMAND_FIELDS["continue_agent"] = {"id": _S(), "text": _S(), "request_id": _S()}
EVENT_FIELDS["agent_runs"] = {"items": _A(), "request_id": _S(False)}

# ---- the window a server was started with (0.48) -------------------------------------------------
# vLLM (--max-model-len), SGLang (--context-length) and llama.cpp (-c) size the context window when
# they start; DGC reads it from the server and can't change it (a window of its own below it only
# decides when to compact). Advertised as ready.capabilities.server_window = 1. `server_window` asks;
# the answer is a `server_window` event, and from then on one is sent, unasked, whenever it changes
# (another model or server, the server restarted with another size). `window` is the server's
# window in tokens, 0 when DGC sizes the window (Ollama, a cloud API, a server that doesn't say);
# `server` names the server ("vllm", "sglang", "llamacpp", or what it calls itself: any string);
# `trained` is what the model was trained for, when the server says (llama.cpp). A client that never
# asks never gets one.
COMMAND_FIELDS["server_window"] = {"request_id": _S(False)}
EVENT_FIELDS["server_window"] = {"request_id": _S(False), "model": _S(), "window": _I(),
                                  "server": _S(False), "trained": _I(False)}

# ---- what a turn's Edited card lists (0.48) -------------------------------------------------------
# The files the turn's recovery point will restore, with line counts the CLI makes from each file's
# saved before-state and what is on disk now: DGC's own edits and a helper's integrated files alike,
# however they were changed. Advertised as ready.capabilities.turn_files = 1. `watch_turn_files`
# asks; from then on a `turn_files` is sent once a turn's work is final, just before its `turn_end`,
# and again for an earlier turn whose recovery point grew after it ended (a background helper that
# integrated while the chat was idle, a monitor turn's edits), naming that turn. `files` are
# {path, additions, deletions, counted, status (new | modified | deleted)} in the order the files
# were first changed, at most 500; `total` counts them all. A file edited and then put back exactly
# as it was is not listed. `counted` false: no line count (a new, deleted, binary or very large
# file, or a permissions-only change). `checkpoint_index` and `checkpoint_preview` name the recovery
# point Undo rewinds to (list_checkpoints' index and preview); both are absent, and `files` is
# empty, for a turn that opened none (its changes are on the card of the turn whose point holds
# them). A turn DGC cannot say this for (a subscription engine's) gets none, and the client counts
# edit-tool diffs as before. get_history replays the same event, just before each turn's
# `turn_end`. A client that never asks is never sent one live.
COMMAND_FIELDS["watch_turn_files"] = {"request_id": _S(False)}
EVENT_FIELDS["turn_files"] = {"turn_id": _S(), "files": _A(), "total": _I(),
                              "checkpoint_index": _I(False), "checkpoint_preview": _S(False),
                              "git_moved": _B(False)}
# A file row may also carry `outside: true` (outside the project: its before-state lives only in the
# process that changed it) and, replayed by get_history in a later process, `undoable: false` (Undo can
# no longer put it back, and the Undo question leaves it out of its count). A row with `command: true` is
# a file one of the turn's own commands (a shell or code action, a tool hook) changed that Undo can't put
# back -- it had uncommitted changes, it is untracked, or Git converts it -- listed after the others with
# `counted: false`; `total` counts it, and the Undo question leaves it out of its count. A file a command
# changed that Undo CAN put back (Git's exact copy of a clean file, or a file the command created) is an
# ordinary row.
#
# Undo on an older turn's card rewinds that turn and every turn after it. Advertised as
# ready.capabilities.rewind_preview = 1. `rewind_preview {index}` (list_checkpoints' index) is answered by
# one `rewind_preview` naming the request: `files`, how many files a rewind to that point restores now
# across all of those turns -- the number `rewound.files_restored` reports once it has run (0 for an
# index that is not a recovery point).
#
# Undo merges the person's edits (0.48). Advertised as ready.capabilities.undo_merge = 1. A file somebody
# changed after DGC wrote it is merged three ways (what DGC left, what is there now, the state before):
# their edits stay and DGC's are taken out. `rewind_preview` then also names, as the Edited card names
# them: `merged`, the files merged so; `held` [{path, reason}], the ones it can't merge -- reason overlap
# (their edits overlap DGC's: left as it is when the Undo goes ahead with it in `keep`, or put back by
# Undo anyway with it in `overwrite`), or binary, large, link, deleted, mode, changed (the Undo stops and
# names it, as before); and `commands`, the files it puts back because they changed while one of the
# turns' commands ran and no editor said the person saved them. `undo_to` takes `keep`: files left
# exactly as they are (the held ones, or the ones a command changed that the person says they edited
# themselves). `undo_result` then also carries `merged` (counted in files_restored) and `kept`.
COMMAND_FIELDS["rewind_preview"] = {"index": _I(), "request_id": _S()}
EVENT_FIELDS["rewind_preview"] = {"request_id": _S(), "index": _I(), "files": _I(),
                                  "merged": _A(False), "held": _A(False), "commands": _A(False)}

# ---- Undo that says why it stopped, and Undo anyway (0.48) -----------------------------------------
# Advertised as ready.capabilities.undo_to = 1. `undo_to {index, overwrite?, request_id}` rewinds to
# list_checkpoints' `index` exactly as `rewind` does, and is answered by one `undo_result` naming the
# request, then the `rewound` a `rewind` gets. `undo_result`: `ok`, `files_restored`; when somebody else's
# changes stopped it, `conflicts` [{path, reason}], the files the person or another program changed after
# DGC wrote them, named as the Edited card names them (reason: changed -- since DGC last wrote it;
# between -- after DGC wrote it and before DGC wrote it again; mode -- its permissions; unreadable); when
# anything else stopped it, `error`, a sentence saying why; after an Undo, `left`, the files the rewound
# turns' commands changed that Undo can't put back, and `stopped`, how many background helpers from those
# turns were stopped. `overwrite`: files a refusal named whose changes the person agreed to lose (Undo
# anyway, asked only after that refusal); the rewind goes ahead when those are its only conflicts, and
# stops and names them all again when there is another.
#
# The person's own saves (0.48). Advertised as ready.capabilities.user_saved = 1. `user_saved {paths, at?}`
# says the person saved these files (absolute paths, at most 256) in the editor, `at` seconds since the
# epoch (now when absent); the editor sends it from onWillSaveTextDocument and onDidSaveTextDocument for
# files in the chat's folders. Nothing answers it. The backend passes each save on to every other live DGC
# working in a folder that holds the file -- a terminal `dgc` too -- through that process's inbox under
# the DGC home (dgc/save_inbox.py: an owner-only directory and a per-process token; nothing listens). A file saved while one of the chat's commands ran is
# the person's change, never the command's: it is not put in the recovery point and not listed on the
# Edited card as the command's, and a save reported after the command was looked at takes that back.
#
# A turn_files row may also carry `by_command: true`: a file one of the turn's commands changed that Undo
# DOES put back (Git's copy of a clean file, the copy DGC made of a file with uncommitted changes before
# the command, or a file the command created); Undo's question names them. A `command: true` row may carry
# `limit` (size: over 5 MB; count: past 500 files in one command; budget: the session's copies used up),
# the limit that kept DGC from copying it first. `git_moved: true` on the event (both fields new in 0.48,
# as the event is): one of those turns' commands moved HEAD, changed the index or a stash, which Undo
# leaves as they are; `undo_result` then carries `git: true` after an Undo of such a turn.
COMMAND_FIELDS["user_saved"] = {"paths": _A(), "at": _N(False)}
COMMAND_FIELDS["undo_to"] = {"index": _I(), "overwrite": _A(False), "keep": _A(False), "request_id": _S()}
EVENT_FIELDS["undo_result"] = {"request_id": _S(), "index": _I(), "ok": _B(), "files_restored": _I(),
                               "conflicts": _A(), "left": _A(), "stopped": _I(), "error": _S(False),
                               "git": _B(False), "merged": _A(False), "kept": _A(False)}

# ---- the models at a host as Settings has it typed (0.48) -----------------------------------------
# Each Model box in the editor's Settings lists the models at its own card's host, before anything is
# saved. Advertised as ready.capabilities.list_models_at = 1. `role` says whose saved key may go with
# the request, and a saved key goes only to the host it is bound to: `api_key` to `base_url`,
# `subagent_api_key` to `subagent_base_url`, `fallback_api_key` to `fallback_base_url` (a blank one
# being the main host), and for a sub-agent or the fallback with no key of its own, the main key to the
# main host, as the route itself would send it. Any other host is asked with no key, or with `api_key`
# when the command carries one (a key typed in the form, never kept). `base_url` "" is the main host
# for "subagent" and "fallback"; `api_mode` "" inherits as the route does. Redirects are not followed.
# The answer is one `models_at` naming the request: `ids`, the transport that listed them (`api_mode`),
# or `error`, a short reason that holds no URL, key or response body. A client that never asks never
# gets one.
LIST_MODELS_AT_ROLES = ("main", "subagent", "fallback")
COMMAND_FIELDS["list_models_at"] = {
    "request_id": _S(), "role": _f("string", enum=LIST_MODELS_AT_ROLES), "base_url": _S(),
    "api_mode": _f("string", required=False,
                   enum=("", "auto", "ollama", "anthropic", "chat_completions", "responses")),
    "api_key": _S(False),
}
EVENT_FIELDS["models_at"] = {"request_id": _S(), "role": _f("string", enum=LIST_MODELS_AT_ROLES),
                             "ids": _A(), "api_mode": _S(False), "error": _S(False)}

# ---- ChatDGC: chats of their own, the same in every folder ----------------------------------------
# The process's, never a session's: the router answers every chatdgc_* command itself and none of
# their events carries the envelope's chat_id (that name is the session router's), so a conversation
# is named by `conversation_id` ("chat_" + 32 hex). Advertised as ready.capabilities.chatdgc =
# {version: 1}.
#
# A turn is chatdgc_send (or chatdgc_continue, for a reply the model stopped at its limit or that was
# stopped): `chatdgc_turn` started, the user's message as `chatdgc_message`, the reply streamed as
# `chatdgc_delta` parts, the finished reply as `chatdgc_message`, then `chatdgc_turn` ended -- always,
# even when the model never answered (a `chatdgc_error` says why). One turn per conversation at a
# time; turns in different conversations run side by side. `message` objects are the store's own
# (id, role, text, thinking, created_at, model, finish, usage, error); a client reads the keys it
# knows.
CHATDGC_THINKING = ("off", "low", "medium", "high", "xhigh")
CHATDGC_FINISHES = ("stop", "length", "cancelled", "error")
# Web search in a reply: off; auto (the model decides); on (the user asked for it).
CHATDGC_SEARCH = ("off", "auto", "on")
COMMAND_FIELDS.update({
    # The Chat list: pinned first, then the newest. Answered by `chatdgc_chats`.
    "chatdgc_list": {"request_id": _S(), "query": _S(False), "archived": _B(False),
                     "limit": _I(False), "offset": _I(False), "project": _S(False)},
    # One conversation, or a new one when conversation_id is left out (temporary: never written or
    # listed). Answered by `chatdgc_opened` with its latest messages; `chatdgc_earlier` pages back.
    # `widget_reports` (only to a backend offering ready.capabilities.chatdgc.widget_report): this screen tells what a
    # widget shows once it's open, in any chat, with `chatdgc_widget_report`, so a reply waits a moment for it.
    "chatdgc_open": {"request_id": _S(), "conversation_id": _S(False), "temporary": _B(False), "project": _S(False),
                     "widget_reports": _B(False)},
    # Projects, as ChatGPT has them: chats, files and instructions together. `chatdgc_projects` lists them (each
    # {id, name, color, instructions, memory: shared|project, files: [{id, kind, name, size, ...}], chats,
    # created_at, updated_at}); `chatdgc_project` creates, changes, deletes (its chats too unless keep_chats) or
    # adds and removes a project's files (attachments as chatdgc_send's), answered by `chatdgc_project`, and
    # every change is broadcast as `chatdgc_projects`. `chatdgc_move` puts a chat in a project ("" takes it out).
    # A chat list with `project` is that project's chats; without, the chats in none (a search covers all).
    "chatdgc_projects": {"request_id": _S()},
    "chatdgc_project": {"request_id": _S(),
                        "op": _f("string", enum=("create", "update", "delete", "add_files", "remove_file")),
                        "project_id": _S(False), "name": _S(False), "color": _S(False), "instructions": _S(False),
                        "memory": _f("string", required=False, enum=("shared", "project")), "keep_chats": _B(False),
                        "attachments": _A(False), "file_id": _S(False)},
    "chatdgc_move": {"request_id": _S(), "conversation_id": _S(), "project_id": _S()},
    # The Library (ChatGPT's): every file you attached, in every chat and project, newest first; `kind` one of
    # image, pdf, document, spreadsheet, presentation, code, text; `query` part of a name. Answered by
    # `chatdgc_library` {files: [{source: chat|project, id, name, kind, type, mime, size, chars, created_at,
    # chat_id?, chat_title?, message_id?, project_id?, project_name?}], total, next_offset, counts}.
    # `chatdgc_library_file` saves one where the user chose, removes it, or copies it into a project; a send takes
    # {kind: "library", conversation_id | project_id, attachment_id} to attach a copy of one.
    "chatdgc_library": {"request_id": _S(), "query": _S(False), "kind": _S(False), "limit": _I(False), "offset": _I(False),
                        "origin": _f("string", required=False, enum=("", "made", "uploaded"))},
    # Plugins in chat: a reply's card (an action in one of the user's plugins) is decided with `chatdgc_action`: "run"
    # sends it now (with `arguments` as the user edited them), "dismiss" doesn't, "hand" sends it to the Personal
    # Pip `pip_id` (`chatdgc_pips` lists them). Answered by `chatdgc_action` with the card as it is now.
    # Writing blocks: a draft in a reply (an ```email or ```draft block) the user edited in place. `original` is the
    # block's words as shown; `text` replaces them. Answered by `chatdgc_message` with the reply as it is now.
    "chatdgc_draft": {"request_id": _S(), "conversation_id": _S(), "message_id": _S(), "original": _S(), "text": _S()},
    # Canvas: `get` (its file, versions and text), `restore` a `version`, or `export` it to `path` the user chose
    # (`format`: docx, pdf or md for a document; file for the canvas as it is). Answered by `chatdgc_canvas`, or
    # `chatdgc_exported` for export.
    "chatdgc_canvas": {"request_id": _S(), "conversation_id": _S(), "canvas_id": _S(),
                       "op": _f("string", enum=("get", "restore", "export")), "version": _I(False),
                       "format": _f("string", required=False, enum=("docx", "pdf", "md", "file")), "path": _S(False)},
    # Interactive answers: what a widget shows once its tab opened (its page's text, up to 4,000 characters, and up
    # to 3 errors its code threw), or shown: false when no tab shows the chat. The model checks its figures with it,
    # in the same reply. Nothing answers it.
    "chatdgc_widget_report": {"request_id": _S(), "conversation_id": _S(), "widget_id": _S(), "shown": _B(),
                              "text": _S(False), "errors": _A(False)},
    # Widgets in the Library (offered as ready.capabilities.chatdgc.widget_library): `list` every widget a reply made,
    # newest first (`query` part of its name); `get` one with its page (`conversation_id`, `widget_id`), to open it
    # again; `remove` deletes one (its page goes, the reply keeps its name, marked removed, and is sent again as
    # `chatdgc_message`). Answered by `chatdgc_widgets`.
    # The context window's meter again, for a chat (after its window preset changed): answered by `chatdgc_context`.
    # Offered with ready.capabilities.chatdgc.windows.
    "chatdgc_context": {"request_id": _S(), "conversation_id": _S()},
    # What fills a chat's window, part by part (offered as ready.capabilities.chatdgc.context_breakdown): answered by
    # `context_breakdown` with the conversation's id.
    "chatdgc_context_breakdown": {"request_id": _S(), "conversation_id": _S()},
    "chatdgc_widgets": {"request_id": _S(), "op": _f("string", enum=("list", "get", "remove")), "query": _S(False),
                        "limit": _I(False), "offset": _I(False), "conversation_id": _S(False), "widget_id": _S(False)},
    "chatdgc_action": {"request_id": _S(), "conversation_id": _S(), "message_id": _S(), "action_id": _S(),
                       "op": _f("string", enum=("run", "dismiss", "hand")), "arguments": _O(False), "pip_id": _S(False)},
    "chatdgc_pips": {"request_id": _S()},
    "chatdgc_library_file": {"request_id": _S(), "op": _f("string", enum=("save", "remove", "to_project")),
                             "conversation_id": _S(False), "project_id": _S(False), "attachment_id": _S(),
                             "path": _S(False), "target_project": _S(False)},
    "chatdgc_earlier": {"request_id": _S(), "conversation_id": _S(), "before": _S()},
    # Every prompt of a chat as shown, however much of it the screen has paged in: the prompt rail and the chat's
    # Widgets list read it (offered as ready.capabilities.chatdgc.outline). Answered by `chatdgc_outline`.
    "chatdgc_outline": {"request_id": _S(), "conversation_id": _S()},
    "chatdgc_send": {"request_id": _S(), "conversation_id": _S(), "text": _S(), "model": _S(False),
                     # Spoken in voice mode: the reply will be read aloud, so it is asked to sound like speech.
                     "voice": _B(False),
                     "thinking": _f("string", required=False, enum=CHATDGC_THINKING),
                     "search": _f("string", required=False, enum=CHATDGC_SEARCH),
                     # Up to 10: {kind: "file", path} (a file the user picked: the backend reads it, so a frame
                     # never carries it), {kind: "image", data, name?} (a pasted image as a data: URI, small
                     # enough for the frame) or {kind: "text", text, name?} (a long paste). The chat keeps a copy.
                     "attachments": _A(False),
                     # A part of a canvas the message is about (Ask ChatDGC on a selection): {canvas_id,
                     # start_line, end_line, text}. The user's message keeps it as `canvas`.
                     "canvas_selection": _O(False),
                     # Study mode (ChatGPT's "Study and learn"): true turns it on for the chat from this message,
                     # false turns it off; left out, the chat stays as it is. The conversation carries `study`.
                     "study": _B(False)},
    "chatdgc_continue": {"request_id": _S(), "conversation_id": _S(), "message_id": _S()},
    # Versions. Edit a message you sent, or try a reply again (another model or thinking level if named): a new
    # version from that point, answered by `chatdgc_opened` (the conversation from then on), then a turn. Switch
    # to another version at a point (`parent_id`: the message before it, or "root"): answered by `chatdgc_opened`.
    # A message with other versions carries `versions: {parent, index, count}`.
    "chatdgc_edit": {"request_id": _S(), "conversation_id": _S(), "message_id": _S(), "text": _S(),
                     "model": _S(False), "thinking": _f("string", required=False, enum=CHATDGC_THINKING),
                     "search": _f("string", required=False, enum=CHATDGC_SEARCH)},
    "chatdgc_regenerate": {"request_id": _S(), "conversation_id": _S(), "message_id": _S(), "model": _S(False),
                           "thinking": _f("string", required=False, enum=CHATDGC_THINKING),
                           "search": _f("string", required=False, enum=CHATDGC_SEARCH)},
    "chatdgc_version": {"request_id": _S(), "conversation_id": _S(), "parent_id": _S(), "index": _I()},
    # Answer the question a reply asked (`question`: its index in the reply's `questions`) with `choice` (one of
    # its options, or the user's own words): the message the model wrote for it is sent as the user's, carrying
    # `answers: {message, question, choice}`, and a turn follows. Only while that reply is the last message.
    # A card of several questions (ready.capabilities.chatdgc.question_forms) is answered with `choices`, one for
    # each question in order; `choice` is the first.
    "chatdgc_answer": {"request_id": _S(), "conversation_id": _S(), "message_id": _S(), "question": _I(),
                       "choice": _S(), "choices": _A(False), "model": _S(False),
                       "thinking": _f("string", required=False, enum=CHATDGC_THINKING),
                       "search": _f("string", required=False, enum=CHATDGC_SEARCH)},
    # Write the chat to `path` (an absolute path the user chose): Markdown, the conversation as shown; or JSON, the
    # whole chat. Answered by `chatdgc_exported`.
    "chatdgc_export": {"request_id": _S(), "conversation_id": _S(), "path": _S(),
                       "format": _f("string", enum=("markdown", "json", "report")), "message_id": _S(False)},
    # Deep research. `chatdgc_research` makes a plan: a turn whose reply carries `research` {status "planned",
    # question, plan: {title, steps, sites}}. `chatdgc_research_start` runs it (with `plan` as edited), or carries on
    # one that stopped (`write`: the report from what's found): a turn on that reply, which becomes the report.
    # `chatdgc_research_steer` adds to research while it runs. Progress is `chatdgc_research`.
    "chatdgc_research": {"request_id": _S(), "conversation_id": _S(), "text": _S(), "model": _S(False),
                         "thinking": _f("string", required=False, enum=CHATDGC_THINKING)},
    "chatdgc_research_start": {"request_id": _S(), "conversation_id": _S(), "message_id": _S(), "plan": _O(False),
                               "write": _B(False)},
    "chatdgc_research_steer": {"request_id": _S(), "conversation_id": _S(), "message_id": _S(), "text": _S()},
    # One memory about the user, shared by ChatDGC, Work sessions and Pips (dgc/shared_memory.py): Settings ->
    # Memory, and the Forget under a reply that saved a fact. Each is answered by `memory_state`.
    # Voice (dgc/voice): Settings -> Voice models, answered by `voice_state`; an install reports `voice_progress` as it
    # goes and `voice_state` when it ends (or `voice_error`, with the model's `id`). Dictation is 16-bit mono PCM at
    # 16 kHz, base64, in chunks numbered from 0 (`done` on the last), answered by `voice_text`; reading aloud is
    # answered by `voice_audio` chunks the same way, until one with `done`. `voice_stop` stops reading aloud.
    "voice_models": {"request_id": _S()},
    "voice_install": {"request_id": _S(), "id": _S()},
    "voice_cancel": {"request_id": _S(), "id": _S()},
    "voice_remove": {"request_id": _S(), "id": _S()},
    "voice_use": {"request_id": _S(), "role": _f("string", enum=("dictation", "read_aloud")), "id": _S()},
    "voice_transcribe": {"request_id": _S(), "part": _I(), "audio": _S(), "done": _B(), "language": _S(False)},
    "voice_speak": {"request_id": _S(), "text": _S()},
    "voice_stop": {"request_id": _S()},
    "memory_list": {"request_id": _S()},
    "memory_add": {"request_id": _S(), "text": _S()},
    "memory_edit": {"request_id": _S(), "id": _S(), "text": _S()},
    "memory_forget": {"request_id": _S(), "id": _S()},
    "memory_clear": {"request_id": _S()},
    "memory_project": {"request_id": _S(), "folder": _S(), "remember": _B()},
    # Memory that learns (ready.capabilities.memory.history): the history of every change (memory_*, a look back
    # after a conversation, a skill /learn saved), newest first, answered by `memory_history`; once asked, it is
    # sent again, unasked, after each change. memory_undo takes one change back (`id`: memj_…), answered by
    # `memory_history` (with `error` when it can't) after an unasked `memory_state`.
    "memory_history": {"request_id": _S(), "limit": _I(False)},
    "memory_undo": {"request_id": _S(), "id": _S()},
    # ready.capabilities.memory.learned: this screen shows the line a Work session's look back adds, so send it
    # `memory_learned` (an editor that never sends this never gets one). Answered by `memory_state`.
    "memory_watch": {"request_id": _S()},
    # The context window. Compact now (everything before the last exchange becomes the summary) and editing
    # the summary are answered by `chatdgc_compacted`; Continue in a new chat (a summary of this one goes with
    # it) by `chatdgc_opened` for the new chat. After every turn, and when a chat opens, `chatdgc_context` says
    # what the chat takes of its window.
    "chatdgc_compact": {"request_id": _S(), "conversation_id": _S()},
    "chatdgc_summary": {"request_id": _S(), "conversation_id": _S(), "text": _S()},
    "chatdgc_carry": {"request_id": _S(), "conversation_id": _S()},
    # Branch in new chat: a new chat with the conversation up to and including that reply (answered by the new
    # chat's chatdgc_opened; its conversation's `branched` says {from, title, at, created_at}).
    "chatdgc_branch": {"request_id": _S(), "conversation_id": _S(), "message_id": _S()},
    "chatdgc_cancel": {"conversation_id": _S(), "request_id": _S(False)},
    # An image the chat keeps, to show (answered by `chatdgc_file`: a data: URI, or why not).
    "chatdgc_file": {"request_id": _S(), "conversation_id": _S(), "attachment_id": _S()},
    # Rename, pin, archive or delete. Answered by `chatdgc_changed`.
    "chatdgc_update": {"request_id": _S(), "conversation_id": _S(), "title": _S(False),
                       "pinned": _B(False), "archived": _B(False), "delete": _B(False)},
})
EVENT_FIELDS.update({
    "chatdgc_chats": {"request_id": _S(), "chats": _A(), "total": _I(), "next_offset": _f("integer", "null")},
    # `earlier` counts the messages before the first one sent (0: this is the whole conversation);
    # `busy` is true while a turn runs in it, from this or another client of this process.
    "chatdgc_opened": {"request_id": _S(), "conversation": _O(), "messages": _A(), "earlier": _I(),
                       "busy": _B(), "reply_id": _S(False), "project": _O(False)},
    "chatdgc_projects": {"request_id": _S(False), "projects": _A()},
    "chatdgc_library": {"request_id": _S(), "files": _A(), "total": _I(), "next_offset": _f("integer", "null"), "counts": _O(),
                        "origins": _O(False)},
    # A card under a reply: {id, plugin, plugin_name, money, server, tool, arguments, recurring, status: waiting |
    # done | failed | dismissed | handed, at, answer?, error?, pip?, sent_arguments?}; sent as a reply puts it there
    # and after each choice. The finished reply carries them in `actions`.
    "chatdgc_action": {"conversation_id": _S(), "message_id": _S(), "action": _O(), "request_id": _S(False)},
    "chatdgc_pips": {"request_id": _S(), "pips": _A(), "error": _S(False)},
    # Suggested next messages under a reply (ChatGPT's follow-ups), after it ended; the reply carries them in
    # `followups` too. Only the chat's last reply has any worth showing.
    "chatdgc_followups": {"conversation_id": _S(), "message_id": _S(), "followups": _A()},
    "chatdgc_library_file": {"request_id": _S(), "op": _S(), "path": _S(False), "bytes": _I(False)},
    "chatdgc_project": {"request_id": _S(), "project": _f("object", "null"), "deleted": _A(False)},
    "chatdgc_earlier": {"request_id": _S(), "conversation_id": _S(), "messages": _A(), "earlier": _I()},
    # The answer to chatdgc_outline: `prompts`, oldest first, each {id, text (its first words, or what it attached),
    # created_at, widgets?: [{id, message_id, title, created_at, removed?}]}, the widgets the replies to it made.
    "chatdgc_outline": {"request_id": _S(), "conversation_id": _S(), "prompts": _A()},
    "chatdgc_turn": {"conversation_id": _S(), "state": _f("string", enum=("started", "ended")),
                     "reply_id": _S(), "request_id": _S(False)},
    "chatdgc_delta": {"conversation_id": _S(), "message_id": _S(), "text": _S(False), "thinking": _S(False)},
    # What the reply is doing besides writing: `text` is the query while it searches the web.
    "chatdgc_activity": {"conversation_id": _S(), "message_id": _S(),
                         "kind": _f("string", enum=("searching", "looking", "compacting", "plugin", "making", "canvas", "analyzing")), "text": _S()},
    "chatdgc_message": {"conversation_id": _S(), "message": _O(), "request_id": _S(False)},
    # A question the reply put to the user, as it's asked (the reply goes on): {at, question, options, prompt},
    # `at` being where in the reply's text it sits. The finished reply carries it in `questions` too.
    "chatdgc_question": {"conversation_id": _S(), "message_id": _S(), "question": _O()},
    # Pictures from the web shown above a reply, as soon as they're kept (the reply goes on): {query, items: [{id,
    # kind "image", mime, title, url (the page it's on), site, image, width?, height?}]}; each one's bytes are asked
    # for by id with `chatdgc_file`. The finished reply carries them in `images` too.
    "chatdgc_images": {"conversation_id": _S(), "message_id": _S(), "images": _O()},
    # A file the reply made (ChatGPT's report.docx), as the reply puts it there: {id, name, kind "document", mime, size,
    # chars, format (docx, pdf, xlsx, pptx, csv, md), made: true, at, created_at, pages?, note?}. It's opened or saved
    # with `chatdgc_library_file`, as a Library file is; the finished reply carries them in `files`.
    "chatdgc_made": {"conversation_id": _S(), "message_id": _S(), "file": _O()},
    # A canvas made or changed by a reply (`message_id`), or asked for with `chatdgc_canvas` (`request_id`): {id,
    # title, kind (document or code), language, created_at, path (the file the editor opens), version, versions:
    # [{n, at, by (model or user), note, chars, path}], text?}. The finished reply carries a card per canvas it
    # touched in `canvases`: {id, title, kind, language, version, op (created or edited), at}.
    "chatdgc_canvas": {"conversation_id": _S(), "message_id": _S(False), "canvas": _O(), "request_id": _S(False)},
    # An interactive answer a reply shows (show_widget): {id, title, html, at, created_at}. The screen frames the page
    # in a sandbox with no network; the finished reply carries them in `widgets`.
    "chatdgc_widget": {"conversation_id": _S(), "message_id": _S(), "widget": _O()},
    # The answer to chatdgc_widgets: for list, {widgets: [{chat_id, chat_title, project_id?, project_name?, id,
    # message_id, title, created_at}], total, next_offset}; for get, the widget {id, title, html, at, created_at,
    # message_id}; for remove, the conversation and widget it removed.
    # What fills a context window, part by part, as Claude's Usage sheet shows it (dgc/context_breakdown.py): the
    # window, what's used (`source`: reported by the model, or estimated), where it compacts, `categories` biggest
    # first ([{id, label, tokens, items?: [{name, tokens}]}]: messages, files, system prompt, instructions, memory,
    # tools one by one...), the `buffer` kept before compaction and what's `free`; `deferred` lists what isn't sent
    # until it's needed. A chat's carries `conversation_id` (and its window's `limit` and `preset`).
    "context_breakdown": {"request_id": _S(False), "conversation_id": _S(False), "window": _I(), "used": _I(),
                          "source": _f("string", enum=("reported", "estimated")), "compact_at": _I(), "categories": _A(),
                          "buffer": _I(), "free": _I(), "deferred": _A(False), "limit": _I(False), "preset": _S(False)},
    "chatdgc_widgets": {"request_id": _S(), "op": _S(), "widgets": _A(False), "total": _I(False),
                        "next_offset": _f("integer", "null", required=False), "conversation_id": _S(False),
                        "widget_id": _S(False), "widget": _O(False)},
    # Deep research as it goes: the reply's `research` now (status planning, planned, running, writing, checking,
    # done, stopped or failed; plan; notes by number, title and address; the latest activity; steers; check).
    "chatdgc_research": {"conversation_id": _S(), "message_id": _S(), "research": _O()},
    # What DGC remembers: `enabled` (the config's `memory`), the facts ({id, text, created_at, updated_at, edited?,
    # source: {surface, where}}), the projects from Work sessions ({folder, name, when, recent, remember}), and
    # `error` when the command that asked couldn't be done. Also sent, unasked, after a reply saved or forgot one.
    "memory_state": {"request_id": _S(False), "enabled": _B(), "facts": _A(), "projects": _A(), "error": _S(False)},
    # The history: [{id, at, op: add | edit | forget | clear | learn | undo, by: you | review | tool, surface, where,
    # text, before? (an edit's), kind?, until?, scope? and path? (a learned skill's), what? (what an undo undid),
    # undone, undoable}], newest first.
    "memory_history": {"request_id": _S(False), "entries": _A(), "error": _S(False)},
    # A Work session's look back kept these ({id, text, kind?, until?}): the chat shows them once, as a quiet
    # "Remembered: … · Forget" line. Only after memory_watch.
    "memory_learned": {"facts": _A(), "surface": _S()},
    # Voice: the models ({id, role, name, summary, languages, licence, size, installed, in_use, installing}), whether
    # the engine is installed, and which model dictates and which reads aloud ("" for none).
    "voice_state": {"request_id": _S(False), "runtime": _O(), "models": _A(), "dictation": _S(), "read_aloud": _S()},
    "voice_progress": {"id": _S(), "stage": _S(), "done": _I(), "total": _I()},
    "voice_text": {"request_id": _S(), "text": _S()},
    "voice_audio": {"request_id": _S(), "part": _I(), "audio": _S(), "sample_rate": _I(), "done": _B()},
    # code: no_model (nothing installed for that: the screen opens Settings -> Voice models), install_failed,
    # cancelled; id: the model an install error is about.
    "voice_error": {"message": _S(), "request_id": _S(False), "code": _S(False), "id": _S(False)},
    # A conversation's list entry changed (a turn, a rename, a pin), or it was deleted (summary null).
    "chatdgc_changed": {"conversation_id": _S(), "summary": _f("object", "null"), "request_id": _S(False)},
    "chatdgc_error": {"message": _S(), "request_id": _S(False), "conversation_id": _S(False)},
    "chatdgc_file": {"request_id": _S(), "conversation_id": _S(), "attachment_id": _S(), "data": _S(False),
                     "error": _S(False)},
    "chatdgc_exported": {"request_id": _S(), "conversation_id": _S(), "path": _S(), "bytes": _I()},
    # `used` of `window` tokens (`limit`: the model's own maximum, 0 unknown), counted by the model (`source`
    # "reported") or estimated; `parts` splits it: instructions, summary, files, conversation; `compactable`:
    # Compact now has more than the last exchange to summarize.
    "chatdgc_context": {"conversation_id": _S(), "window": _I(), "limit": _I(), "used": _I(), "preset": _S(),
                        "source": _f("string", enum=("reported", "estimated")), "parts": _O(),
                        "compactable": _B()},
    # The summary of earlier messages, new or changed (null: none).
    "chatdgc_compacted": {"conversation_id": _S(), "summary": _f("object", "null"), "request_id": _S(False)},
})

# Names the envelope owns. A payload field with any of these names would overwrite it on the wire
# (Emitter.emit builds {"type", "seq"} and then applies the fields), so none may be declared.
RESERVED_FIELD_NAMES = frozenset({"type", "seq", "chat_id"})
_MAX_CHAT_ID = 64
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
    allowed = {"type", "chat_id", *specs[name]}
    if sequence:
        allowed.add("seq")
    extra = sorted(set(value) - allowed)
    if extra:
        return f"{name} has undeclared field {_shown(extra[0])}"
    chat = value.get("chat_id")
    if "chat_id" in value and not (isinstance(chat, str) and 0 < len(chat) <= _MAX_CHAT_ID):
        return f"{name}.chat_id must be a short non-empty string"
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
        value: dict = {"type": kind}
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
    properties: dict = {"type": {"const": name}}
    required = ["type"]
    if sequence:
        properties["seq"] = {"type": "integer", "minimum": 0,
                             "maximum": MAX_SAFE_INTEGER}
        required.append("seq")
    properties["chat_id"] = {"type": "string", "minLength": 1, "maxLength": _MAX_CHAT_ID}
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
  const allowed = new Set(["type", "chat_id", ...(sequence ? ["seq"] : []), ...Object.keys(specs[name])]);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) return `${{name}} has undeclared field ${{shown(extra)}}`;
  if (Object.prototype.hasOwnProperty.call(value, "chat_id")
      && !(typeof value.chat_id === "string" && value.chat_id.length > 0
           && value.chat_id.length <= {_MAX_CHAT_ID})) {{
    return `${{name}}.chat_id must be a short non-empty string`;
  }}
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
