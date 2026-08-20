#!/usr/bin/env python3
"""Generate a FROZEN edit-primitive corpus for edit_micro.py (B1, Layer 1).

Each case is a realistic single edit taken from a polyglot reference solution:
`content` = the real file, `old_string` = a verbatim window of it, `new_string`
= that window with one line changed, `expected_after` = content with the window
replaced. Then `old_string` is PERTURBED one way (mirroring how a weak model
gets it slightly wrong) while content/expected_after stay fixed — so a correct
`_apply_edit` must still locate the window and produce `expected_after`.

`expect`:
  apply     — the primitive SHOULD apply and yield expected_after
  ambiguous — the window occurs twice → must raise _Ambiguous (never guess)
  miss      — old_string is garbled beyond recognition → must return None

Run once and commit the output:  python3 gen_edit_corpus.py > edit_corpus/all.jsonl
"""
from __future__ import annotations
import json, sys
from pathlib import Path

REPO = Path(__file__).resolve().parent
DATA = REPO / "data" / "polyglot-benchmark"
LANGS = ["python", "go", "rust", "javascript", "cpp", "java"]

CONF = {"'": "’", '"': "“", "-": "–"}     # ascii → curly/en-dash confusables


def example_files():
    for lang in LANGS:
        practice = DATA / lang / "exercises" / "practice"
        if not practice.exists():
            continue
        for ex in sorted(p.name for p in practice.iterdir() if p.is_dir()):
            cfg = practice / ex / ".meta" / "config.json"
            if not cfg.exists():
                continue
            try:
                meta = json.loads(cfg.read_text())
            except Exception:
                continue
            for rel in meta.get("files", {}).get("example", []):
                f = practice / ex / rel
                if f.exists():
                    try:
                        yield lang, ex, f.read_text()
                    except Exception:
                        pass


def windows(content: str):
    """Deterministic 4–6 line windows that are UNIQUE in content and have ≥3 non-blank lines."""
    lines = content.split("\n")
    for start in range(0, len(lines) - 6, 7):           # spaced starts → variety, bounded count
        for size in (5, 4, 6):
            block = lines[start:start + size]
            if sum(1 for l in block if l.strip()) < 3:
                continue
            w = "\n".join(block)
            if len(w) < 40 or content.count(w) != 1:
                continue
            yield w
            break


def make_new(old: str) -> str:
    """A deterministic real-looking edit: append a marker to the last non-blank line."""
    ls = old.split("\n")
    for i in range(len(ls) - 1, -1, -1):
        if ls[i].strip():
            ls[i] = ls[i] + "  // edited" if not ls[i].rstrip().endswith("edited") else ls[i]
            break
    return "\n".join(ls)


def perturb(old: str, kind: str):
    """Return a perturbed old_string, or None if not applicable."""
    ls = old.split("\n")
    nb = [i for i, l in enumerate(ls) if l.strip()]
    if kind == "reindent":                              # add indent (old MORE-indented than file → extra="")
        return "\n".join(("    " + l) if l.strip() else l for l in ls)
    if kind == "trailing_ws":
        return "\n".join((l + "   ") if l.strip() else l for l in ls)
    if kind == "confusable":
        out = old
        for a, b in CONF.items():
            out = out.replace(a, b)
        return out if out != old else None
    if kind == "interior_line_changed":                 # reword ONE middle line (B2 block-anchor target)
        if len(nb) < 3:
            return None
        mid = nb[len(nb) // 2]
        ls[mid] = (ls[mid][:len(ls[mid]) - len(ls[mid].lstrip())]) + "/* drifted interior line */"
        return "\n".join(ls)
    if kind == "elide":                                 # replace the middle with an elision (B3 target)
        if len(nb) < 4:
            return None
        keep_lo, keep_hi = nb[0], nb[-1]
        return ls[keep_lo] + "\n... existing code ...\n" + ls[keep_hi]
    if kind == "drop_leading_blank":
        return "\n" + old
    return None


def emit(case):
    print(json.dumps(case))


def main():
    n = 0
    prev = None
    for lang, ex, content in example_files():
        for w in windows(content):
            new = make_new(w)
            if new == w:
                continue
            expected = content.replace(w, new, 1)
            base = {"lang": lang, "ex": ex, "content": content, "new_string": new,
                    "expected_after": expected, "replace_all": False}
            emit({**base, "id": f"{lang}/{ex}/{n}/none", "old_string": w,
                  "perturbation": "none", "expect": "apply"}); n += 1
            for kind in ("reindent", "trailing_ws", "confusable", "interior_line_changed",
                         "elide"):
                po = perturb(w, kind)
                if po is None or po == w:
                    continue
                emit({**base, "id": f"{lang}/{ex}/{n}/{kind}", "old_string": po,
                      "perturbation": kind, "expect": "apply"}); n += 1
            # negative: duplicate the window → ambiguous
            dup_content = content.replace(w, w + "\n" + w, 1)
            emit({"lang": lang, "ex": ex, "content": dup_content, "old_string": w,
                  "new_string": new, "expected_after": None, "replace_all": False,
                  "id": f"{lang}/{ex}/{n}/dup", "perturbation": "duplicate", "expect": "ambiguous"}); n += 1
            # negative: garble → must miss
            garble = "".join(c for c in ("XZQ" + w[::-1]))[:len(w)]
            emit({"lang": lang, "ex": ex, "content": content, "old_string": garble,
                  "new_string": new, "expected_after": None, "replace_all": False,
                  "id": f"{lang}/{ex}/{n}/garble", "perturbation": "garble", "expect": "miss"}); n += 1
            if lang != prev:
                prev = lang
    print(f"# {n} cases", file=sys.stderr)


if __name__ == "__main__":
    main()
