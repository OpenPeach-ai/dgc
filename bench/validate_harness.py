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
    solutions = [str(p) for p in f.get("solution", [])]
    references = [str(p) for p in f.get("example", [])]
    pairs = []
    used_solutions: set[str] = set()
    used_references: set[str] = set()

    # Prefer an exact filename match. This matters for Java exercises whose canonical solution has
    # extra helper classes: a positional zip would copy Card.java over Poker.java.
    for reference in references:
        same_name = next((solution for solution in solutions
                          if Path(solution).name == Path(reference).name), None)
        if same_name:
            pairs.append((same_name, reference))
            used_solutions.add(same_name); used_references.add(reference)

    # Most tracks call the canonical file `example.<ext>`; match it to the sole remaining solution
    # with that extension (for example example.py -> affine_cipher.py, example.h -> meetup.h).
    for reference in references:
        if reference in used_references:
            continue
        candidates = [solution for solution in solutions if solution not in used_solutions
                      and Path(solution).suffix == Path(reference).suffix]
        if len(candidates) == 1:
            pairs.append((candidates[0], reference))
            used_solutions.add(candidates[0]); used_references.add(reference)

    # Canonical Java references may contain helper classes not declared as student solution files.
    # Put them beside the primary source so the *official tests* can validate the canonical answer.
    source_parent = Path(pairs[0][0] if pairs else solutions[0]).parent if solutions else Path()
    for reference in references:
        if reference not in used_references:
            pairs.append((str(source_parent / Path(reference).name), reference))

    # Exercism's Rust track keeps dependencies used by the canonical answer in a separate manifest.
    # `Cargo.toml` is itself a solution file, but `.meta/config.json` lists only `example.rs`, so a
    # positional zip silently left the stub manifest in place and made valid references look broken.
    cargo_example = exdir / ".meta" / "Cargo-example.toml"
    if "Cargo.toml" in solutions and cargo_example.is_file():
        pairs.append(("Cargo.toml", ".meta/Cargo-example.toml"))
    return pairs

def main():
    langs = LANGS if (len(sys.argv) < 2 or sys.argv[1] == "all") else sys.argv[1].split(",")
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    env = bench_env()
    ok_all = True
    for lang in langs:
        for ex in list_exercises(lang)[:n]:
            exdir = practice_dir(lang) / ex
            pairs = examples(exdir)
            work = make_workdir(lang, ex)
            prep_workdir(exdir, work)
            # Copy the exact reference source/build inputs over their solution-file counterparts.
            for s, example in pairs:
                src = exdir / example
                if src.exists():
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
