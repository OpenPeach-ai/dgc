#!/usr/bin/env python3
"""DGC polyglot benchmark runner.

Runs DGC *headless* (`dgc -p ... --mode auto`) over the Aider "polyglot"
benchmark (225 Exercism problems across C++, Go, Java, JavaScript, Python,
Rust) and scores each by running the exercise's REAL test suite.

Protocol (mirrors Aider's two-attempt structure):
  round 1  — a fresh DGC session implements the stub (it may read/edit/run
             tests itself, max_turns budget). Then we run the official tests.
  round 2  — only if round 1's official tests fail: continue the session
             (`dgc -c`) fed the exact failing test output, then re-test.
  solved@1 = passed after round 1;  solved@2 = passed by end of round 2.

Isolation: every DGC call runs under a throwaway $HOME, so the benchmark never
reads or writes your real ~/.dgc (config, sessions, skills, memory).

Usage:
  python3 run_bench.py --model qwen3.8:27b-q4km --out results/ --langs python --limit 3
  python3 run_bench.py --model qwen122b-code:latest --base-url http://localhost:11434/v1 --out results/
"""
from __future__ import annotations
import argparse, json, os, re, shutil, signal, subprocess, sys, tempfile, time
from pathlib import Path


def _dec(x):        # subprocess bytes → str (TimeoutExpired.stdout is bytes even under text=True)
    return x.decode("utf-8", "replace") if isinstance(x, (bytes, bytearray)) else (x or "")


def _run_capture(argv, cwd, env, timeout, merge=False):
    """Run a command in its OWN process group and, on timeout, SIGKILL the whole tree — so a
    hung cmake/compiler (or a dgc-spawned build) can't survive as a CPU-eating orphan.
    Returns (returncode_or_None, stdout_str, stderr_str, timed_out)."""
    proc = subprocess.Popen(
        argv, cwd=cwd, env=env, text=True, start_new_session=True,
        stdout=subprocess.PIPE,
        stderr=(subprocess.STDOUT if merge else subprocess.PIPE))
    try:
        out, err = proc.communicate(timeout=timeout)
        return proc.returncode, _dec(out), _dec(err), False
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            try: proc.kill()
            except Exception: pass
        try:
            out, err = proc.communicate(timeout=10)
        except Exception:
            out, err = "", ""
        return None, _dec(out), _dec(err), True

REPO = Path(__file__).resolve().parent
DATA = REPO / "data" / "polyglot-benchmark"
TOOLS = Path(os.environ.get("BENCH_TOOLS", "/home/fungigb10/bench-tools"))
DGC = os.environ.get("DGC_BIN", "/home/fungigb10/.local/bin/dgc")

GO_BIN   = TOOLS / "go" / "bin"
JDK_HOME = TOOLS / "jdk21"
CARGO    = TOOLS / "cargo"
PYTEST   = TOOLS / "pyvenv" / "bin" / "pytest"

LANGS = ["cpp", "go", "java", "javascript", "python", "rust"]


# ---------------------------------------------------------------- exercises ---
def practice_dir(lang: str) -> Path:
    return DATA / lang / "exercises" / "practice"


def list_exercises(lang: str) -> list[str]:
    d = practice_dir(lang)
    return sorted(p.name for p in d.iterdir() if p.is_dir()) if d.exists() else []


def read_meta(exdir: Path) -> tuple[list[str], list[str]]:
    cfg = json.loads((exdir / ".meta" / "config.json").read_text())
    files = cfg.get("files", {})
    return files.get("solution", []), files.get("test", [])


def read_instructions(exdir: Path) -> str:
    parts = []
    for name in ("introduction.md", "instructions.md", "instructions.append.md"):
        f = exdir / ".docs" / name
        if f.exists():
            parts.append(f.read_text())
    return "\n\n".join(parts).strip()


def make_workdir(lang: str, ex: str) -> Path:
    """A unique temp parent with the leaf dir named EXACTLY after the exercise.
    Exercism's C++ CMakeLists derives the source filenames from the directory
    name, so the leaf must be `<exercise>`, not a random tempfile name."""
    parent = tempfile.mkdtemp(prefix=f"dgcb-{lang}-")
    return Path(parent) / ex


def prep_workdir(exdir: Path, dest: Path) -> Path:
    """Copy the exercise into a fresh dir, WITHOUT .meta (holds the reference
    solution) or .approaches (holds hints). Anchor DGC's project root here."""
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(exdir, dest, ignore=shutil.ignore_patterns(".meta", ".approaches"))
    (dest / ".dgc").mkdir(exist_ok=True)   # makes find_project_root() stop here
    return dest


# ------------------------------------------------------------------ prompts ---
PROMPT = """You are completing a programming exercise in the current directory.

Implement the solution by editing ONLY this/these file(s): {sol}
Do NOT modify the test file(s): {test}

Read the stub and the test file(s), then write a correct, complete
implementation that makes the ENTIRE test suite pass. You can compile and run
the tests yourself with:

    {testcmd}

Iterate until every test passes. Do not stop until the implementation is done.

=== EXERCISE ===
{instr}
"""

FIX_PROMPT = """The tests still fail. Here is the exact output of `{testcmd}`:

--- test output ---
{output}
--- end ---

Fix the implementation in {sol} so the whole suite passes. Do not modify the tests."""


# -------------------------------------------------------------- environment ---
def bench_env() -> dict:
    """Env for running the *tests* — real toolchains on PATH. Uses the real
    HOME so gradle/npm/cargo build caches persist across exercises."""
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join([str(GO_BIN), str(CARGO / "bin"),
                                   str(JDK_HOME / "bin"), env.get("PATH", "")])
    env["JAVA_HOME"] = str(JDK_HOME)
    env["CARGO_HOME"] = str(CARGO)
    env["RUSTUP_HOME"] = str(TOOLS / "rustup")
    env["GOTOOLCHAIN"] = "local"
    return env


def test_cmd_str(lang: str, ex: str) -> str:
    return {
        "python":     f"'{PYTEST}' -q",
        "go":         "go test ./...",
        "rust":       "cargo test -- --include-ignored",
        "javascript": "npm install --no-audit --no-fund --silent && npx jest",
        "cpp":        (f"cmake -B build -S . -DEXERCISM_RUN_ALL_TESTS=1 -DCMAKE_BUILD_TYPE=Debug >/dev/null "
                       f"&& cmake --build build -j 2>&1 | tail -40 && ./build/'{ex}'"),
        "java":       "./gradlew test --console=plain --offline || ./gradlew test --console=plain",
    }[lang]


def run_tests(lang: str, ex: str, workdir: Path, env: dict, timeout: int):
    cmd = test_cmd_str(lang, ex)
    t0 = time.time()
    rc, out, _err, timed_out = _run_capture(["bash", "-lc", cmd], workdir, env, timeout, merge=True)
    if timed_out:
        ok, out = False, f"[TEST TIMEOUT after {timeout}s]\n{out}"
    else:
        ok = (rc == 0)
    return ok, out[-6000:].strip(), round(time.time() - t0, 1)


# ---------------------------------------------------------------------- DGC ---
def seed_home(home: Path, model: str, base_url: str, api_key: str, max_turns: int = 40) -> None:
    d = home / ".dgc"
    d.mkdir(parents=True, exist_ok=True)
    cfg = {
        "base_url": base_url, "api_key": api_key, "model": model, "mode": "auto",
        "thinking": "off", "suggest": False, "logo_animation": False,
        "artifact_autostart": False, "background": "inherit",
        "show_reasoning": False, "max_turns": max_turns, "context_size": 32768,
    }
    (d / "config.json").write_text(json.dumps(cfg, indent=2))


def dgc_run(prompt: str, workdir: Path, model: str, base_url: str, api_key: str,
            home: Path, cont: bool, timeout: int, env: dict) -> dict:
    args = [DGC]
    if cont:
        args += ["-c"]
    args += ["-p", prompt, "--model", model, "--base-url", base_url,
             "--api-key", api_key, "--mode", "auto"]
    e = dict(env)
    e["HOME"] = str(home)          # <-- isolation: DGC reads/writes this ~/.dgc only
    t0 = time.time()
    rc, _out, err, timed_out = _run_capture(args, workdir, e, timeout, merge=False)
    if timed_out:                  # SIGKILLs dgc AND every build it spawned (no orphans)
        return {"rc": None, "time": round(time.time() - t0, 1), "timeout": True,
                "stderr_tail": "[DGC TIMEOUT]"}
    return {"rc": rc, "time": round(time.time() - t0, 1), "timeout": False,
            "stderr_tail": err[-1200:]}


def session_stats(home: Path) -> dict:
    """Parse the newest DGC session under the throwaway HOME for turn / tool /
    edit-failure counts. Best-effort — never raises."""
    try:
        sess_root = home / ".dgc" / "sessions"
        files = list(sess_root.rglob("*.json"))
        if not files:
            return {}
        newest = max(files, key=lambda p: p.stat().st_mtime)
        msgs = json.loads(newest.read_text())
        if isinstance(msgs, dict):
            msgs = msgs.get("messages", [])
        tool_calls = edits = edit_fail = 0
        for m in msgs:
            if m.get("role") == "assistant":
                for c in (m.get("tool_calls") or []):
                    tool_calls += 1
                    fn = (c.get("function") or {}).get("name", "")
                    if fn == "edit_file":
                        edits += 1
            if m.get("role") == "tool":
                txt = str(m.get("content", ""))
                if re.search(r"not found|no exact match|appears \d+ times|ambiguous|match.*exactly", txt, re.I):
                    edit_fail += 1
        return {"tool_calls": tool_calls, "edits": edits, "edit_fails": edit_fail,
                "messages": len(msgs)}
    except Exception as e:      # noqa
        return {"stats_error": str(e)[:200]}


# ---------------------------------------------------------------- one run -----
def run_one(lang: str, ex: str, a, home: Path, env: dict) -> dict:
    exdir = practice_dir(lang) / ex
    sol, test = read_meta(exdir)
    instr = read_instructions(exdir)
    tcmd = test_cmd_str(lang, ex)
    prompt = PROMPT.format(sol=", ".join(sol) or "(the solution file)",
                           test=", ".join(test) or "(the test file)",
                           testcmd=tcmd, instr=instr)
    rec = {"lang": lang, "ex": ex, "model": a.model, "sol": sol, "test": test, "rounds": []}

    if a.dry_run:
        rec["dry_run"] = {"testcmd": tcmd, "prompt_head": prompt[:600]}
        return rec

    work = make_workdir(lang, ex)
    prep_workdir(exdir, work)
    solved = False
    last_out = ""
    for r in range(1, a.rounds + 1):
        if r == 1:
            run = dgc_run(prompt, work, a.model, a.base_url, a.api_key, home, False, a.dgc_timeout, env)
        else:
            fp = FIX_PROMPT.format(testcmd=tcmd, output=last_out[-3500:], sol=", ".join(sol))
            run = dgc_run(fp, work, a.model, a.base_url, a.api_key, home, True, a.dgc_timeout, env)
        ok, out, ttime = run_tests(lang, ex, work, env, a.test_timeout)
        last_out = out
        rec["rounds"].append({"round": r, "dgc": run, "stats": session_stats(home),
                              "test_pass": ok, "test_time": ttime, "test_tail": out[-1200:]})
        if ok:
            solved = True
            rec["solved_round"] = r
            break
    rec["solved"] = solved
    if not a.keep_work:
        shutil.rmtree(work, ignore_errors=True)
    else:
        rec["workdir"] = str(work)
    return rec


def aggregate(jsonl_path: Path) -> dict:
    """Read a results jsonl and compute per-language + overall pass@1/pass@2,
    plus timing and edit-failure stats. The source of truth for publishing."""
    per: dict[str, dict] = {}
    for line in Path(jsonl_path).read_text().splitlines():
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("dry_run"):
            continue
        p = per.setdefault(r["lang"], {"n": 0, "p1": 0, "p2": 0, "dgc_s": 0.0,
                                       "edit_fails": 0, "timeouts": 0})
        p["n"] += 1
        if r.get("solved") and r.get("solved_round") == 1:
            p["p1"] += 1
        if r.get("solved"):
            p["p2"] += 1
        for rd in r.get("rounds", []):
            p["dgc_s"] += rd.get("dgc", {}).get("time", 0) or 0
            if rd.get("dgc", {}).get("timeout"):
                p["timeouts"] += 1
            p["edit_fails"] += (rd.get("stats") or {}).get("edit_fails", 0) or 0
    return per


def print_report(jsonl_path: Path, langs: list[str] | None = None) -> None:
    per = aggregate(jsonl_path)
    order = langs or sorted(per)
    tot = {"n": 0, "p1": 0, "p2": 0, "dgc_s": 0.0, "edit_fails": 0, "timeouts": 0}
    print(f"\n==== {Path(jsonl_path).name} ====")
    print(f"{'lang':11s} {'n':>4} {'pass@1':>14} {'pass@2':>14} {'avg_s':>7} {'editfail':>8} {'t/o':>4}")
    for lang in order:
        p = per.get(lang)
        if not p:
            continue
        for k in tot:
            tot[k] += p[k]
        avg = p["dgc_s"] / p["n"] if p["n"] else 0
        print(f"{lang:11s} {p['n']:4d} {p['p1']:4d} ({100*p['p1']/p['n']:5.1f}%) "
              f"{p['p2']:4d} ({100*p['p2']/p['n']:5.1f}%) {avg:7.0f} {p['edit_fails']:8d} {p['timeouts']:4d}")
    if tot["n"]:
        avg = tot["dgc_s"] / tot["n"]
        print(f"{'TOTAL':11s} {tot['n']:4d} {tot['p1']:4d} ({100*tot['p1']/tot['n']:5.1f}%) "
              f"{tot['p2']:4d} ({100*tot['p2']/tot['n']:5.1f}%) {avg:7.0f} {tot['edit_fails']:8d} {tot['timeouts']:4d}")


def summary_line(rec: dict) -> str:
    if rec.get("dry_run"):
        return f"[dry] {rec['lang']}/{rec['ex']}  test: {rec['dry_run']['testcmd'][:70]}"
    mark = "✅" if rec["solved"] else "❌"
    rnd = rec.get("solved_round", "-")
    t = sum(x["dgc"]["time"] for x in rec["rounds"])
    st = rec["rounds"][-1].get("stats", {}) if rec["rounds"] else {}
    ef = st.get("edit_fails", "?")
    return f"{mark} {rec['lang']}/{rec['ex']}  solved@{rnd}  {t:.0f}s  editfail={ef}"


# ------------------------------------------------------------------- main -----
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--base-url", default="http://localhost:11434/v1")
    ap.add_argument("--api-key", default="ollama")
    ap.add_argument("--langs", default="all", help="'all' or comma list of: " + ",".join(LANGS))
    ap.add_argument("-n", "--limit", type=int, default=0, help="cap exercises per language (0=all)")
    ap.add_argument("--exercises", default="", help="explicit comma list (use with a single --langs)")
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--max-turns", type=int, default=40, help="DGC tool-use iterations per session")
    ap.add_argument("--dgc-timeout", type=int, default=600)
    ap.add_argument("--test-timeout", type=int, default=300)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tag", default="")
    ap.add_argument("--dry-run", action="store_true", help="print prompt+test cmd, don't call DGC")
    ap.add_argument("--keep-work", action="store_true", help="keep per-exercise workdirs")
    ap.add_argument("--redo", action="store_true", help="re-run exercises already in the results jsonl")
    a = ap.parse_args()

    langs = LANGS if a.langs == "all" else [l.strip() for l in a.langs.split(",") if l.strip()]
    outdir = Path(a.out)
    outdir.mkdir(parents=True, exist_ok=True)
    safe_model = re.sub(r"[^A-Za-z0-9._-]", "_", a.model)
    stem = f"{safe_model}{('-' + a.tag) if a.tag else ''}"
    jsonl_path = outdir / f"results-{stem}.jsonl"
    done: set[tuple[str, str]] = set()
    if jsonl_path.exists() and not a.redo:
        for line in jsonl_path.read_text().splitlines():
            try:
                r = json.loads(line)
                done.add((r["lang"], r["ex"]))
            except Exception:
                pass
        if done:
            print(f"# resuming: {len(done)} exercises already done, will skip them\n")
    jf = open(jsonl_path, "a")

    home = Path(tempfile.mkdtemp(prefix="dgc-bench-home-"))
    seed_home(home, a.model, a.base_url, a.api_key, a.max_turns)
    env = bench_env()

    print(f"# model={a.model}  base={a.base_url}")
    print(f"# HOME(isolated)={home}\n# results -> {jsonl_path}\n")

    started = time.time()
    for lang in langs:
        exs = ([e.strip() for e in a.exercises.split(",") if e.strip()]
               if a.exercises else list_exercises(lang))
        if a.limit:
            exs = exs[:a.limit]
        for ex in exs:
            if (lang, ex) in done:
                continue
            try:
                rec = run_one(lang, ex, a, home, env)
            except Exception as e:                       # never let one exercise kill the whole run
                import traceback
                rec = {"lang": lang, "ex": ex, "model": a.model, "solved": False, "rounds": [],
                       "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-1500:]}
                print(f"‼ {lang}/{ex} errored: {e}", flush=True)
            jf.write(json.dumps(rec) + "\n"); jf.flush()
            print(summary_line(rec), flush=True)
    jf.close()

    if not a.dry_run:
        print_report(jsonl_path, langs)                      # aggregates the FULL jsonl
        print(f"wall this run: {(time.time()-started)/60:.1f} min")
        (outdir / f"summary-{stem}.json").write_text(
            json.dumps({"model": a.model, "aggregate": aggregate(jsonl_path)}, indent=2))


if __name__ == "__main__":
    main()
