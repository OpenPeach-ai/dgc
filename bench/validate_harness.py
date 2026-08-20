#!/usr/bin/env python3
"""Grading self-test: drop each exercise's REFERENCE solution (.meta/example.*)
in as the answer and run our test command. A correct grader → every reference
solution PASSES. Any FAIL here is a harness/toolchain bug, not a model failure.
"""
import json, shutil, sys, tempfile, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_bench import (practice_dir, list_exercises, prep_workdir, make_workdir,
                       test_cmd_str, run_tests, bench_env, LANGS)

def examples(exdir: Path):
    cfg = json.loads((exdir / ".meta" / "config.json").read_text())
    f = cfg.get("files", {})
    return f.get("solution", []), f.get("example", [])

def main():
    langs = LANGS if (len(sys.argv) < 2 or sys.argv[1] == "all") else sys.argv[1].split(",")
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    env = bench_env()
    ok_all = True
    for lang in langs:
        for ex in list_exercises(lang)[:n]:
            exdir = practice_dir(lang) / ex
            sol, exmpl = examples(exdir)
            work = make_workdir(lang, ex)
            prep_workdir(exdir, work)
            # copy reference example file(s) over the solution stub(s), by index
            for i, s in enumerate(sol):
                src = exdir / exmpl[i] if i < len(exmpl) else None
                if src and src.exists():
                    (work / s).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy(src, work / s)
            t0 = time.time()
            passed, out, ttime = run_tests(lang, ex, work, env, 400)
            mark = "PASS" if passed else "FAIL"
            if not passed:
                ok_all = False
            print(f"[{mark}] {lang}/{ex}  ({ttime}s)")
            if not passed:
                print("      last output:\n" + "\n".join("      " + l for l in out.splitlines()[-15:]))
            shutil.rmtree(work, ignore_errors=True)
    print("\nHARNESS " + ("OK — all reference solutions passed." if ok_all
                          else "HAS FAILURES — fix test cmds/toolchains above."))
    sys.exit(0 if ok_all else 1)

if __name__ == "__main__":
    main()
