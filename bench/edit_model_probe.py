#!/usr/bin/env python3
"""B1 Layer 2 — the model-in-loop edit probe (minutes, ~12 tasks).

Isolates "can the model emit a MATCHABLE edit_file" from "can it write correct code":
give a real model a file + one specific line change, ask for a single edit_file tool call,
then run its args through `_apply_edit`. Scores whether it matched, whether it produced the
intended file, and which tier caught it — so a new tier shows up as rescuing real model output.

Usage: python3 edit_model_probe.py [model] [base_url]
"""
import json, sys
from collections import Counter
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dgc.llm import LLMClient                                   # noqa: E402
from dgc.tools import TOOL_SCHEMAS, _apply_edit, _Ambiguous     # noqa: E402

MODEL = sys.argv[1] if len(sys.argv) > 1 else "qwen3.8:27b-q4km"
BASE = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:11434/v1"
EDIT_SCHEMA = [s for s in TOOL_SCHEMAS if s["function"]["name"] == "edit_file"]


def tasks(n=12):
    """Pick n single-line change tasks from the frozen corpus's clean ('none') cases."""
    corpus = Path(__file__).resolve().parent / "edit_corpus" / "all.jsonl"
    out, seen = [], set()
    for line in corpus.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        c = json.loads(line)
        if c["perturbation"] != "none" or c["lang"] in seen and len(out) >= n:
            continue
        # the change = old's last non-blank line → that line + "  // edited"
        ol = [l for l in c["old_string"].split("\n") if l.strip()]
        if not ol:
            continue
        target = ol[-1]
        if c["content"].count(target) != 1 or len(target.strip()) < 8:
            continue
        out.append({"lang": c["lang"], "content": c["content"], "target": target,
                    "expected": c["content"].replace(target, target + "  // edited", 1)})
        seen.add(c["lang"])
        if len(out) >= n:
            break
    return out


def main():
    client = LLMClient(BASE, "ollama", MODEL, ollama_keep_alive="30m", max_tokens=2048)
    ts = tasks()
    print(f"# model={MODEL}  tasks={len(ts)}\n")
    matched = correct = 0
    tiers = Counter()
    for i, t in enumerate(ts):
        prompt = (f"Here is a file:\n```\n{t['content']}\n```\n\n"
                  f"Append the text `  // edited` to the end of this exact line:\n`{t['target']}`\n\n"
                  "Make the change with a SINGLE edit_file tool call. Use the smallest old_string "
                  "that uniquely identifies the line.")
        try:
            res = client.chat([{"role": "user", "content": prompt}], tools=EDIT_SCHEMA,
                              reasoning_effort="off")
        except Exception as e:
            print(f"[err ] {t['lang']}: {e}"); continue
        call = next((c for c in res.tool_calls if c.name == "edit_file"), None)
        if not call:
            print(f"[none] {t['lang']}: no edit_file call"); continue
        old = str(call.arguments.get("old_string", ""))
        new = str(call.arguments.get("new_string", ""))
        try:
            r = _apply_edit(t["content"], old, new, bool(call.arguments.get("replace_all")))
        except _Ambiguous:
            print(f"[ambg] {t['lang']}: model's old_string was ambiguous"); continue
        if r is None:
            print(f"[miss] {t['lang']}: old_string didn't match"); continue
        updated, _cnt, how = r
        matched += 1
        tiers[how] += 1
        ok = updated == t["expected"]
        correct += ok
        print(f"[{'OK  ' if ok else 'diff'}] {t['lang']:11s} matched via {how}")
    n = len(ts)
    print(f"\nmatched (old_string applied): {matched}/{n}   produced intended file: {correct}/{n}")
    print("tiers:", dict(tiers))


if __name__ == "__main__":
    main()
