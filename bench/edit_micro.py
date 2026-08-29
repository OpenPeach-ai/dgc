#!/usr/bin/env python3
"""B1 Layer 1 — the deterministic edit-primitive micro-benchmark (no model).

Runs a frozen corpus through dgc's `_apply_edit` and scores per perturbation:
  ok    — behaved correctly (applied→expected, or safely refused an ambiguous/miss)
  miss  — safe no-op on a case that SHOULD have applied (model would just retry)
  WRONG — the danger number: applied when it must not, or applied the wrong text.

It then duplicates the canonical target behind every positive case and requires every exact/fuzzy
tier to refuse the resulting ambiguity. These transformations are generated in memory.

**WRONG must stay 0** as tiers are loosened — that's the release gate. Also prints
which tier (`how`) won each apply, so a new tier shows up as e.g. "block anchor".

Usage:  python3 edit_micro.py [corpus.jsonl]
"""
import json, sys
from collections import defaultdict
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dgc.tools import _apply_edit, _Ambiguous   # noqa: E402


def outcome(case):
    try:
        res = _apply_edit(case["content"], case["old_string"], case["new_string"], case["replace_all"])
    except _Ambiguous:
        return "ambiguous", None
    if res is None:
        return "clean_miss", None
    updated, _count, how = res
    return ("apply_success" if updated == case["expected_after"] else "wrong_apply"), how


def verdict(expect, out):
    if expect == "apply":
        return {"apply_success": "ok", "clean_miss": "miss",
                "ambiguous": "miss", "wrong_apply": "WRONG"}[out]
    # expect in (ambiguous, miss): applying is the danger; refusing is safe
    return "WRONG" if out in {"apply_success", "wrong_apply"} else "ok"


def duplicate_target_gate(cases):
    """Duplicate every positive case's canonical target and require a safe refusal.

    The frozen corpus stores one unperturbed (`none`) case beside each set of positive fuzzy
    perturbations.  Reusing that canonical old_string lets this gate exercise ambiguity in every
    tolerant tier without enlarging the already-125 MB corpus.  Returns per-perturbation counts and
    the IDs of any dangerous applications; malformed corpus groups fail loudly.
    """
    def group_key(case):
        return (case["lang"], case["ex"], case["content"], case["new_string"],
                case["expected_after"])

    bases = {group_key(case): case["old_string"] for case in cases
             if case["expect"] == "apply" and case["perturbation"] == "none"}
    byp = defaultdict(lambda: {"n": 0, "ambiguous": 0, "refused": 0, "APPLIED": 0})
    applied = []
    for case in cases:
        if case["expect"] != "apply":
            continue
        actual = bases.get(group_key(case))
        if actual is None or case["content"].count(actual) != 1:
            raise ValueError(f"case {case['id']} has no unique canonical target")
        duplicated = case["content"].replace(actual, actual + "\n" + actual, 1)
        try:
            result = _apply_edit(duplicated, case["old_string"], case["new_string"], False)
        except _Ambiguous:
            outcome = "ambiguous"
        else:
            outcome = "refused" if result is None else "APPLIED"
        byp[case["perturbation"]]["n"] += 1
        byp[case["perturbation"]][outcome] += 1
        if outcome == "APPLIED":
            applied.append((case["id"], result[2]))
    return byp, applied


def main():
    path = (Path(sys.argv[1]) if len(sys.argv) > 1
            else Path(__file__).resolve().parent / "edit_corpus" / "all.jsonl")
    cases = [json.loads(l) for l in path.read_text().splitlines() if l and not l.startswith("#")]
    byp = defaultdict(lambda: {"n": 0, "ok": 0, "miss": 0, "WRONG": 0})
    tiers = defaultdict(int)
    wrong_ids = []
    for c in cases:
        out, how = outcome(c)
        v = verdict(c["expect"], out)
        p = byp[c["perturbation"]]
        p["n"] += 1
        p[v] += 1
        if out == "apply_success" and how and verdict(c["expect"], out) == "ok":
            tiers[how] += 1
        if v == "WRONG":
            wrong_ids.append((c["id"], c["expect"], out))

    order = ["none", "reindent", "trailing_ws", "confusable", "interior_line_changed",
             "elide", "drop_leading_blank", "duplicate", "garble"]
    print(f"\n== edit-primitive micro-benchmark ({len(cases)} cases) ==")
    print(f"{'perturbation':22} {'n':>4} {'ok':>5} {'miss':>5} {'WRONG':>6}      ok%")
    tot = {"n": 0, "ok": 0, "miss": 0, "WRONG": 0}
    for k in order + [k for k in byp if k not in order]:
        p = byp.get(k)
        if not p:
            continue
        for f in tot:
            tot[f] += p[f]
        print(f"{k:22} {p['n']:>4} {p['ok']:>5} {p['miss']:>5} {p['WRONG']:>6}   "
              f"{100*p['ok']/p['n']:6.2f}%")
    print(f"{'TOTAL':22} {tot['n']:>4} {tot['ok']:>5} {tot['miss']:>5} {tot['WRONG']:>6}   "
          f"{100*tot['ok']/tot['n']:6.2f}%")
    print("\ntier that won each apply:", dict(sorted(tiers.items(), key=lambda x: -x[1])))
    print("WRONG (must be 0):", tot["WRONG"])
    for wid, exp, out in wrong_ids[:15]:
        print(f"   WRONG {wid}  expect={exp} got={out}")

    dup, duplicate_applies = duplicate_target_gate(cases)
    duplicate_count = sum(p["n"] for p in dup.values())
    print(f"\n== duplicate-target metamorphic safety gate ({duplicate_count} cases) ==")
    print(f"{'perturbation':22} {'n':>5} {'ambiguous':>10} {'refused':>8} {'APPLIED':>8}")
    dtot = {"n": 0, "ambiguous": 0, "refused": 0, "APPLIED": 0}
    for kind in order + [kind for kind in dup if kind not in order]:
        p = dup.get(kind)
        if not p:
            continue
        for field in dtot:
            dtot[field] += p[field]
        print(f"{kind:22} {p['n']:>5} {p['ambiguous']:>10} {p['refused']:>8} "
              f"{p['APPLIED']:>8}")
    print(f"{'TOTAL':22} {dtot['n']:>5} {dtot['ambiguous']:>10} {dtot['refused']:>8} "
          f"{dtot['APPLIED']:>8}")
    print("DUPLICATE APPLIED (must be 0):", dtot["APPLIED"])
    for case_id, how in duplicate_applies[:15]:
        print(f"   APPLIED {case_id} via {how}")
    sys.exit(1 if tot["WRONG"] or dtot["APPLIED"] else 0)


if __name__ == "__main__":
    main()
