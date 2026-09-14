"""Writes tests/fixtures/reasoning/*.json: the provider wire scripts for the thinking-provenance
fixture rows (design section 11.1). Regenerate with: python3 tests/fixtures/reasoning/build_fixtures.py tests/fixtures/reasoning"""
import json
import sys
from pathlib import Path

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)

LONG = ("I compared the two gate implementations line by line. The first one compares with a strict "
        "greater-than, which drops the boundary value; the second uses greater-or-equal but also "
        "reads the threshold from a stale cache. The failing test covers exactly the boundary, so the "
        "first change is the real fix, and the cache is a separate issue worth a follow-up note.")
assert len(LONG) > 280


def sse(events):
    return ["data: " + json.dumps(e) if isinstance(e, dict) and "advance" not in e else e for e in events]


def anthropic_sse(events):
    lines = []
    for e in events:
        if isinstance(e, dict) and "advance" in e:
            lines.append(e)
            continue
        lines.append(f"event: {e['type']}")
        lines.append("data: " + json.dumps(e))
        lines.append("")
    return lines


def ndjson(frames):
    return [json.dumps(f) if "advance" not in f else f for f in frames]


def ollama_msg(**message):
    done = message.pop("done", False)
    frame = {"model": "m", "message": {"role": "assistant", **message}, "done": done}
    if done:
        frame["done_reason"] = "stop"
    return frame


def chat_chunk(delta=None, finish=None):
    return {"choices": [{"index": 0, "delta": delta or {}, "finish_reason": finish}]}


def anthropic_message(blocks, stop_reason, msg_id="msg_1"):
    events = [{"type": "message_start", "message": {"id": msg_id, "usage": {"input_tokens": 3}}}]
    for index, block in enumerate(blocks):
        kind = block["type"]
        if kind == "thinking":
            events.append({"type": "content_block_start", "index": index,
                           "content_block": {"type": "thinking", "thinking": ""}})
            events.append({"advance": block.get("delay", 0.5)})
            for chunk in block.get("chunks", []):
                events.append({"type": "content_block_delta", "index": index,
                               "delta": {"type": "thinking_delta", "thinking": chunk}})
                events.append({"advance": block.get("step", 0.5)})
            events.append({"type": "content_block_delta", "index": index,
                           "delta": {"type": "signature_delta", "signature": "sig-" + str(index)}})
            if not block.get("unterminated"):
                events.append({"type": "content_block_stop", "index": index})
        elif kind == "redacted_thinking":
            events.append({"type": "content_block_start", "index": index,
                           "content_block": {"type": "redacted_thinking", "data": "opaque"}})
            events.append({"advance": block.get("delay", 6.0)})
            events.append({"type": "content_block_stop", "index": index})
        elif kind == "text":
            events.append({"type": "content_block_start", "index": index,
                           "content_block": {"type": "text", "text": ""}})
            events.append({"type": "content_block_delta", "index": index,
                           "delta": {"type": "text_delta", "text": block["text"]}})
            events.append({"type": "content_block_stop", "index": index})
        elif kind == "tool_use":
            events.append({"type": "content_block_start", "index": index,
                           "content_block": {"type": "tool_use", "id": block["id"], "name": "glob",
                                             "input": {}}})
            events.append({"type": "content_block_delta", "index": index,
                           "delta": {"type": "input_json_delta", "partial_json": '{"pattern": "*"}'}})
            events.append({"type": "content_block_stop", "index": index})
        elif kind == "error":
            events.append({"type": "error", "error": {"type": "invalid_request_error", "message": "Stream rejected"}})
            return anthropic_sse(events)
    events.append({"type": "message_delta", "delta": {"stop_reason": stop_reason},
                   "usage": {"output_tokens": 9}})
    events.append({"type": "message_stop"})
    return anthropic_sse(events)


def responses_stream(items, resp_id="resp_1"):
    """items: list of ("reasoning", key, [parts], extra) | ("reasoning_text", key, [parts]) |
    ("call", call_id, delay_args) | ("text", text) | ("summary_only", [parts])."""
    events, output = [{"type": "response.created", "response": {"id": resp_id}}], []
    for index, item in enumerate(items):
        kind = item[0]
        if kind in ("reasoning", "reasoning_text"):
            key, parts = item[1], item[2]
            extra = item[3] if len(item) > 3 else {}
            events.append({"type": "response.output_item.added", "output_index": index,
                           "item": {"type": "reasoning", "id": key, "summary": []}})
            events.append({"advance": 0.5})
            done = {"type": "reasoning", "id": key, "summary": [], **extra}
            for p, text in enumerate(parts):
                if kind == "reasoning":
                    events.append({"type": "response.reasoning_summary_part.added", "item_id": key,
                                   "output_index": index, "summary_index": p})
                    events.append({"type": "response.reasoning_summary_text.delta", "item_id": key,
                                   "output_index": index, "summary_index": p, "delta": text})
                    events.append({"advance": 1.0})
                    events.append({"type": "response.reasoning_summary_part.done", "item_id": key,
                                   "output_index": index, "summary_index": p})
                    done["summary"].append({"type": "summary_text", "text": text})
                else:
                    events.append({"type": "response.reasoning_text.delta", "item_id": key,
                                   "output_index": index, "content_index": p, "delta": text})
                    events.append({"advance": 1.0})
                    events.append({"type": "response.reasoning_text.done", "item_id": key,
                                   "output_index": index, "content_index": p})
                    done.setdefault("content", []).append({"type": "reasoning_text", "text": text})
            events.append({"type": "response.output_item.done", "output_index": index, "item": done})
            output.append(done)
        elif kind == "summary_only":
            # Ollama's Responses compat (F1): summary-event deltas, no output_item framing.
            for p, text in enumerate(item[1]):
                events.append({"type": "response.reasoning_summary_text.delta", "item_id": "rs_local",
                               "output_index": index, "summary_index": 0, "delta": text})
                events.append({"advance": 0.5})
        elif kind == "call":
            call_id, arg_seconds = item[1], item[2]
            events.append({"type": "response.output_item.added", "output_index": index,
                           "item": {"type": "function_call", "id": "fc_" + call_id, "call_id": call_id,
                                    "name": "glob", "arguments": ""}})
            for _ in range(int(arg_seconds)):
                events.append({"type": "response.function_call_arguments.delta",
                               "item_id": "fc_" + call_id, "output_index": index, "delta": ""})
                events.append({"advance": 1.0})
            events.append({"type": "response.function_call_arguments.delta", "item_id": "fc_" + call_id,
                           "output_index": index, "delta": '{"pattern": "*"}'})
            done = {"type": "function_call", "id": "fc_" + call_id, "call_id": call_id, "name": "glob",
                    "arguments": '{"pattern": "*"}', "status": "completed"}
            events.append({"type": "response.output_item.done", "output_index": index, "item": done})
            output.append(done)
        elif kind == "text":
            message = {"type": "message", "id": "msg_" + resp_id, "role": "assistant", "status": "completed",
                       "content": [{"type": "output_text", "text": item[1]}]}
            events.append({"type": "response.output_item.added", "output_index": index,
                           "item": {**message, "content": []}})
            events.append({"type": "response.output_text.delta", "item_id": message["id"],
                           "output_index": index, "content_index": 0, "delta": item[1]})
            events.append({"type": "response.output_item.done", "output_index": index, "item": message})
            output.append(message)
    if any(i[0] == "summary_only" for i in items):
        output = [o for o in output]
    events.append({"type": "response.completed",
                   "response": {"id": resp_id, "status": "completed", "usage": {}, "output": output}})
    return sse(events)


def req(match, lines=None, *, body=None, ctype="text/event-stream", repeat=False, status=200):
    entry = {"match": match, "status": status, "content_type": ctype}
    if body is not None:
        entry["body"] = body
        entry["content_type"] = "application/json"
    else:
        entry["lines"] = lines
    if repeat:
        entry["repeat"] = True
    return entry


OLLAMA = "http://127.0.0.1:11434"
fixtures = {}

fixtures["01-ollama-native-thinking"] = {
    "row": "1", "api_mode": "ollama", "base_url": OLLAMA, "model": "qwen3.8:27b", "private": True,
    "requests": [
        req("/api/chat", ndjson([ollama_msg(thinking="Let me look"), {"advance": 2.0},
                                 ollama_msg(thinking=" at the files first."), {"advance": 1.0},
                                 ollama_msg(content="Listing now."),
                                 ollama_msg(content="", tool_calls=[{"function": {"name": "glob", "arguments": {"pattern": "*"}}}]),
                                 {"advance": 3.0},
                                 ollama_msg(content="", done=True)]), ctype="application/x-ndjson"),
        req("/api/chat", ndjson([ollama_msg(thinking="The listing is short."), {"advance": 1.0},
                                 ollama_msg(content="Two files."), ollama_msg(content="", done=True)]),
            ctype="application/x-ndjson"),
    ],
    "expect": {"blocks": [["raw", "", "collapsed"], ["raw", "", "collapsed"]],
               "seconds": [2.0, 0.0], "end_before_first_text": True},
}
fixtures["02-ollama-split-tags"] = {
    "row": "2", "api_mode": "ollama", "base_url": OLLAMA, "model": "qwen3.8:27b", "private": True,
    "requests": [req("/api/chat", ndjson([ollama_msg(content="<thi"), ollama_msg(content="nk>Plan the reply"),
                                          {"advance": 1.5}, ollama_msg(content=" briefly.</think>Hello there."),
                                          ollama_msg(content="", done=True)]), ctype="application/x-ndjson")],
    "expect": {"blocks": [["raw", "", "collapsed"]]},
}
fixtures["03-ollama-closed-model"] = {
    "row": "3", "api_mode": "ollama", "base_url": OLLAMA, "model": "claude-sonnet-5", "private": True,
    "requests": [req("/api/chat", ndjson([ollama_msg(thinking="Proxy thinking"), ollama_msg(content="Hi."),
                                          ollama_msg(content="", done=True)]), ctype="application/x-ndjson")],
    "expect": {"blocks": [["unknown", "", "collapsed"]]},
}


def chat_fixture(row, base, model, field, expect, private, extra=None):
    deltas = [chat_chunk({"role": "assistant"}), chat_chunk({field: "Considering the question"}),
              {"advance": 1.0}, chat_chunk({field: " carefully."})]
    if extra:
        deltas.append(chat_chunk(extra))
    deltas += [chat_chunk({"content": "Here is the answer."}), chat_chunk({}, "stop")]
    lines = sse(deltas) + ["data: [DONE]"]
    return {"row": row, "api_mode": "chat_completions", "base_url": base, "model": model,
            "private": private, "requests": [req("/chat/completions", lines)],
            "expect": {"blocks": [[expect, "", "collapsed"]]}}


fixtures["04-chat-ollama-reasoning"] = {**chat_fixture("4", OLLAMA + "/v1", "qwen3", "reasoning", "raw", True),
                                        "config": {"preserve_thinking": True},
                                        }
fixtures["04-chat-ollama-reasoning"]["expect"]["no_think_in_history"] = True
fixtures["05-chat-vllm-reasoning-content"] = chat_fixture(
    "5", "http://127.0.0.1:8000/v1", "qwen3", "reasoning_content", "raw", True)
fixtures["06-chat-unknown-local-proxy"] = chat_fixture(
    "6", "http://127.0.0.1:4000/v1", "qwen3", "reasoning_content", "unknown", True)
fixtures["07-chat-ollama-closed-model"] = chat_fixture(
    "7", OLLAMA + "/v1", "gpt-5", "reasoning", "unknown", True)
fixtures["08-chat-openrouter"] = chat_fixture(
    "8", "https://openrouter.ai/api/v1", "anthropic/claude-sonnet-5", "reasoning", "unknown", False,
    extra={"reasoning_details": [{"type": "reasoning.text", "text": "x"}]})

SHORT_SUMMARY = "Check the failing boundary test before editing the gate."
fixtures["09-responses-openai-summaries"] = {
    "row": "9", "api_mode": "responses", "base_url": "https://api.openai.com/v1", "model": "gpt-5",
    "private": False, "config": {"preserve_thinking": True},
    "requests": [
        req("/responses", responses_stream([("reasoning", "rs_1", [SHORT_SUMMARY, LONG]), ("call", "call_1", 0)])),
        req("/responses", responses_stream([("text", "The listing has two files.")], resp_id="resp_2")),
    ],
    "expect": {"blocks": [["summarized", "openai", "inline"], ["summarized", "openai", "collapsed"]],
               "no_think_in_history": True, "thinking_join": [SHORT_SUMMARY, LONG]},
}
fixtures["10-responses-openai-encrypted-withheld"] = {
    "row": "10", "api_mode": "responses", "base_url": "https://api.openai.com/v1", "model": "gpt-5",
    "private": False,
    "requests": [req("/responses", responses_stream(
        [("reasoning", "rs_w", [], {"encrypted_content": "gAAAA-opaque"}), ("text", "Done.")]))],
    "expect": {"blocks": [["withheld", "openai", "collapsed"]], "withheld_before_text": True},
}
fixtures["10b-responses-openai-stateful-withheld"] = {
    "row": "10b", "api_mode": "responses", "base_url": "https://api.openai.com/v1", "model": "gpt-5",
    "private": False, "config": {"provider_state": "server"},
    "requests": [req("/responses", responses_stream([("reasoning", "rs_w", []), ("text", "Done.")]))],
    "expect": {"blocks": [["withheld", "openai", "collapsed"]], "withheld_before_text": True},
}
fixtures["11-responses-ollama-summary-events"] = {
    "row": "11", "api_mode": "responses", "base_url": OLLAMA + "/v1", "model": "gpt-oss:20b", "private": True,
    "requests": [req("/responses", responses_stream(
        [("summary_only", ["The user wants a greeting", " so keep it short."]), ("text", "Hello!")]))],
    "expect": {"blocks": [["raw", "", "collapsed"]]},
}
fixtures["11b-responses-ollama-json-summary"] = {
    "row": "11b", "api_mode": "responses", "base_url": OLLAMA + "/v1", "model": "gpt-oss:20b", "private": True,
    "requests": [req("/responses", body={
        "id": "resp_j", "status": "completed", "usage": {},
        "output": [{"type": "reasoning", "id": "rs_j", "summary": [{"type": "summary_text", "text": "Short plan."}]},
                   {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Hello!"}]}]})],
    "expect": {"blocks": [["raw", "", "collapsed"]]},
}
fixtures["12-responses-vllm-reasoning-text"] = {
    "row": "12", "api_mode": "responses", "base_url": "http://127.0.0.1:8000/v1", "model": "gpt-oss-120b",
    "private": True,
    "requests": [req("/responses", responses_stream([("reasoning_text", "rs_t", ["Raw chain of thought."]),
                                                     ("text", "Answer.")]))],
    "expect": {"blocks": [["raw", "", "collapsed"]]},
}
fixtures["13-responses-vllm-json-reasoning-text"] = {
    "row": "13", "api_mode": "responses", "base_url": "http://127.0.0.1:8000/v1", "model": "gpt-oss-120b",
    "private": True,
    "requests": [req("/responses", body={
        "id": "resp_k", "status": "completed", "usage": {},
        "output": [{"type": "reasoning", "id": "rs_k", "summary": [],
                    "content": [{"type": "reasoning_text", "text": "Raw chain of thought."}]},
                   {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Answer."}]}]})],
    "expect": {"blocks": [["raw", "", "collapsed"]]},
}
ANTHROPIC = "https://api.anthropic.com/v1"
fixtures["14-anthropic-summarized"] = {
    "row": "14", "api_mode": "anthropic", "base_url": ANTHROPIC, "model": "claude-opus-4-8", "private": False,
    "config": {"thinking": "high"},
    "requests": [
        req("/messages", anthropic_message([{"type": "thinking", "chunks": ["The first run fails ", "on the boundary."]},
                                            {"type": "tool_use", "id": "toolu_1"}], "tool_use")),
        req("/messages", anthropic_message([{"type": "thinking", "chunks": [LONG[:150], LONG[150:]]},
                                            {"type": "text", "text": "Fixed the comparison."}], "end_turn",
                                           msg_id="msg_2")),
    ],
    "expect": {"blocks": [["summarized", "anthropic", "inline"], ["summarized", "anthropic", "collapsed"]],
               "display": "summarized"},
}
fixtures["14b-anthropic-sonnet-4-5-unknown"] = {
    "row": "14b", "api_mode": "anthropic", "base_url": ANTHROPIC, "model": "claude-sonnet-4-5", "private": False,
    "config": {"thinking": "high"},
    "requests": [req("/messages", anthropic_message([{"type": "thinking", "chunks": ["Legacy thinking."]},
                                                     {"type": "text", "text": "Hi."}], "end_turn"))],
    "expect": {"blocks": [["unknown", "", "collapsed"]]},
}
fixtures["15-anthropic-redacted"] = {
    "row": "15", "api_mode": "anthropic", "base_url": ANTHROPIC, "model": "claude-opus-4-8", "private": False,
    "config": {"thinking": "high"},
    "requests": [req("/messages", anthropic_message([{"type": "thinking", "chunks": []},
                                                     {"type": "redacted_thinking", "delay": 6.0},
                                                     {"type": "text", "text": "Here is the plan."}], "end_turn"))],
    "expect": {"blocks": [["withheld", "anthropic", "collapsed"]], "withheld_before_text": True,
               "seconds": [6.0]},
}
fixtures["18-anthropic-shape-on-ollama"] = {
    "row": "18", "api_mode": "anthropic", "base_url": OLLAMA, "model": "qwen3", "private": True,
    "config": {"thinking": "high"},
    "requests": [req("/messages", anthropic_message([{"type": "thinking", "chunks": ["Local thinking."]},
                                                     {"type": "text", "text": "Hi."}], "end_turn"))],
    "expect": {"blocks": [["raw", "", "collapsed"]]},
}
fixtures["19-anthropic-localhost-proxy"] = {
    "row": "19", "api_mode": "anthropic", "base_url": "http://localhost:4000/anthropic", "model": "claude-opus-4-8",
    "private": True, "config": {"thinking": "high"},
    "requests": [req("/messages", anthropic_message([{"type": "thinking", "chunks": ["Proxied."]},
                                                     {"type": "text", "text": "Hi."}], "end_turn"))],
    "expect": {"blocks": [["unknown", "", "collapsed"]]},
}
fixtures["20-anthropic-lookalike-host"] = {
    "row": "20", "api_mode": "anthropic", "base_url": "https://api.anthropic.com.evil.test/v1",
    "model": "claude-opus-4-8", "private": False, "config": {"thinking": "high"},
    "requests": [req("/messages", anthropic_message([{"type": "thinking", "chunks": ["Lookalike."]},
                                                     {"type": "text", "text": "Hi."}], "end_turn"))],
    "expect": {"blocks": [["unknown", "", "collapsed"]]},
}
fixtures["21-anthropic-retired-3-7"] = {
    "row": "21", "api_mode": "anthropic", "base_url": ANTHROPIC, "model": "claude-3-7-sonnet-20250219",
    "private": False, "config": {"thinking": "high"},
    "requests": [req("/messages", anthropic_message([{"type": "thinking", "chunks": ["Old model."]},
                                                     {"type": "text", "text": "Hi."}], "end_turn"))],
    "expect": {"blocks": [["unknown", "", "collapsed"]]},
}
fixtures["24-anthropic-overthink-repost"] = {
    "row": "24", "api_mode": "anthropic", "base_url": ANTHROPIC, "model": "claude-opus-4-8", "private": False,
    "config": {"thinking": "high", "think_budget_tokens": 10},
    "requests": [
        req("/messages", anthropic_message([{"type": "thinking", "unterminated": True,
                                             "chunks": ["Weighing every option at length ", "and then again and again."]},
                                            {"type": "text", "text": "never reached"}], "end_turn")),
        req("/messages", anthropic_message([{"type": "thinking", "chunks": ["Short."]},
                                            {"type": "text", "text": "Done."}], "end_turn", msg_id="msg_2")),
    ],
    "expect": {"blocks": [["summarized", "anthropic", "collapsed"], ["summarized", "anthropic", "collapsed"]]},
}
fixtures["25-fallback-anthropic-then-ollama"] = {
    "row": "25", "api_mode": "anthropic", "base_url": ANTHROPIC, "model": "claude-opus-4-8", "private": False,
    "config": {"thinking": "high", "fallback_model": "qwen3.8:27b", "fallback_base_url": OLLAMA,
               "fallback_api_mode": "ollama"},
    "requests": [
        req("/messages", anthropic_message([{"type": "thinking", "chunks": ["Starting on Claude."]},
                                            {"type": "error"}], "end_turn")),
        req("/api/chat", ndjson([ollama_msg(thinking="Continuing locally."), ollama_msg(content="Done."),
                                 ollama_msg(content="", done=True)]), ctype="application/x-ndjson"),
    ],
    "expect": {"blocks": [["summarized", "anthropic", "collapsed"], ["raw", "", "collapsed"]]},
}
fixtures["26-anthropic-pause-turn"] = {
    "row": "26", "api_mode": "anthropic", "base_url": ANTHROPIC, "model": "claude-opus-4-8", "private": False,
    "config": {"thinking": "high"},
    "requests": [
        req("/messages", anthropic_message([{"type": "thinking", "chunks": ["Searching the docs."]},
                                            {"type": "text", "text": "Looking it up."}], "pause_turn")),
        req("/messages", anthropic_message([{"type": "thinking", "chunks": ["Found the answer."]},
                                            {"type": "text", "text": " Here it is."}], "end_turn",
                                           msg_id="msg_2")),
    ],
    "expect": {"blocks": [["summarized", "anthropic", "collapsed"], ["summarized", "anthropic", "collapsed"]],
               "one_assistant": True},
}
rounds = []
for n, pattern in enumerate(["*", "*.md", "**/*"]):
    rounds.append(req("/api/chat", ndjson([ollama_msg(thinking=f"Round {n + 1} thinking."),
                                           ollama_msg(content="", tool_calls=[{"function": {"name": "glob", "arguments": {"pattern": pattern}}}]),
                                           ollama_msg(content="", done=True)]), ctype="application/x-ndjson"))
rounds.append(req("/api/chat", ndjson([ollama_msg(content="All three rounds done."), ollama_msg(content="", done=True)]),
                  ctype="application/x-ndjson"))
fixtures["27-multi-round-turn"] = {
    "row": "27", "api_mode": "ollama", "base_url": OLLAMA, "model": "qwen3.8:27b", "private": True,
    "requests": rounds,
    "expect": {"blocks": [["raw", "", "collapsed"]] * 3, "live_ids": ["t1:think1", "t1:think2", "t1:think3"],
               "history_ids": ["h1:think1", "h1:think2", "h1:think3"]},
}
fixtures["seconds-responses-arguments"] = {
    "row": "seconds", "api_mode": "responses", "base_url": "https://api.openai.com/v1", "model": "gpt-5",
    "private": False,
    "requests": [
        req("/responses", responses_stream([("reasoning", "rs_s", [LONG]), ("call", "call_s", 5)])),
        req("/responses", responses_stream([("text", "Done.")], resp_id="resp_s2")),
    ],
    "expect": {"blocks": [["summarized", "openai", "collapsed"]], "seconds": [1.5]},
}

for name, fixture in fixtures.items():
    (OUT / f"{name}.json").write_text(json.dumps(fixture, indent=1) + "\n")
print(len(fixtures), "fixtures")
