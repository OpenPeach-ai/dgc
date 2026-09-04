#!/usr/bin/env python3
"""Create deterministic, public-safe benchmark evidence archives.

The measured league results are maintainer data and intentionally gitignored.
This exporter normalizes machine-local paths, scans for credential shapes, and
emits one reviewable archive per harness for the public website.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import re
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT / "bench" / "results-orig"
DEFAULT_OUTPUT = ROOT / "site" / "evidence"
RUN_SUFFIX = "qwen3.8_27b-orig-orig_native_32k"
HARNESSES = ("goose", "dgc", "pi", "opencode", "codex")
SECRET = re.compile(r"(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{24,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)")
TMP_PATH = re.compile(r"/tmp/dgcb-[^/\s\"'\\]+")
HOME_PATH = re.compile(r"/home/[^/\s\"']+/")
ROOT_HOME_PATH = re.compile(r"/root/")
REPO_PATH = re.compile(r"/workspace/dgc/")
WORKSPACE_PATH = re.compile(r"/workspace/")
GENERIC_TMP_PATH = re.compile(r"/tmp(?:/[^\s\"'\\]*)?")
INTERNAL = re.compile(r"(?:/root/|/workspace/|/home/|/tmp/|\.vast_api_key|vast-agents-guide|results-orig|CLAUDE\.md)", re.I)


def scrub_string(value: str) -> str:
    value = TMP_PATH.sub("<workspace>", value)
    value = HOME_PATH.sub("<home>/", value)
    value = ROOT_HOME_PATH.sub("<home>/", value)
    value = REPO_PATH.sub("<repo>/", value)
    value = WORKSPACE_PATH.sub("<workspace>/", value)
    value = GENERIC_TMP_PATH.sub("<tmp>", value)
    return SECRET.sub("<redacted>", value)


def scrub(value):
    if isinstance(value, str): return scrub_string(value)
    if isinstance(value, list): return [scrub(item) for item in value]
    if isinstance(value, dict): return {key: scrub(item) for key, item in value.items()}
    return value


def public_result(row: dict) -> dict:
    """Retain scoring/provenance fields, never arbitrary harness stdout."""
    rounds = []
    for item in row.get("rounds", []):
        agent = item.get("agent") or item.get("dgc") or {}
        rounds.append({
            "round": item.get("round"),
            "agent": {key: scrub(agent.get(key)) for key in ("rc", "time", "timeout", "exit_reason", "usage")},
            "stats": scrub(item.get("stats", {})),
            "grader_isolated": item.get("grader_isolated"),
            "solution_sha256": item.get("solution_sha256"),
            "tests_sha256": item.get("tests_sha256"),
            "test_pass": item.get("test_pass"),
            "test_time": item.get("test_time"),
        })
    return {
        key: scrub(row.get(key))
        for key in ("schema_version", "run_id", "engine", "lang", "ex", "model", "input_sha256", "sol", "test")
    } | {"rounds": rounds, "solved_round": row.get("solved_round"), "solved": row.get("solved")}


def public_manifest(value: dict) -> dict:
    environment = value.get("environment", {})
    preflight = value.get("preflight", {})
    tools = {}
    for name, details in preflight.get("tools", {}).items():
        tools[name] = {key: scrub(details.get(key)) for key in ("version", "sha256")}
    engine = preflight.get("engine", {})
    return {
        key: scrub(value.get(key))
        for key in ("schema_version", "run_id", "created_at", "settings", "provider_transport", "runner", "dataset")
    } | {
        "environment": {key: scrub(environment.get(key)) for key in ("python", "platform", "machine", "processor", "cpu_count", "memory_bytes", "hardware_label", "accelerator")},
        "preflight": {
            "status": preflight.get("status"), "tasks": scrub(preflight.get("tasks", {})), "tools": tools,
            "engine": {key: scrub(engine.get(key)) for key in ("version", "sha256")},
            "boost_date_time": preflight.get("boost_date_time"),
            "provider_context": scrub(preflight.get("provider_context", {})),
        },
    }


def normalized_jsonl(path: Path) -> bytes:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip(): rows.append(json.dumps(public_result(json.loads(line)), ensure_ascii=False, separators=(",", ":")))
    return ("\n".join(rows) + "\n").encode()


def normalized_json(path: Path, *, manifest: bool = False) -> bytes:
    value = json.loads(path.read_text(encoding="utf-8"))
    value = public_manifest(value) if manifest else scrub(value)
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()


def archive(harness: str, source: Path) -> bytes:
    names = {
        "results.jsonl": source / f"results-{harness}-{RUN_SUFFIX}.jsonl",
        "summary.json": source / f"summary-{harness}-{RUN_SUFFIX}.json",
        "manifest.json": source / f"manifest-{harness}-{RUN_SUFFIX}.json",
    }
    missing = [str(path) for path in names.values() if not path.is_file()]
    if missing: raise FileNotFoundError("missing benchmark evidence: " + ", ".join(missing))
    files = {
        name: normalized_jsonl(path) if name.endswith(".jsonl") else normalized_json(path, manifest=name == "manifest.json")
        for name, path in names.items()
    }
    source_hashes = "\n".join(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  source/{path.name}' for path in names.values()) + "\n"
    files["SOURCE_SHA256SUMS"] = source_hashes.encode()
    files["README.txt"] = (
        "DGC harness comparison evidence\n\n"
        f"Harness: {harness}\n"
        "Run: 90-task Aider polyglot slice, up to two rounds; round two resumes after a first-round failure. Each round has a 600-second allowance.\n"
        "Machine-local repository, workspace, home, and temporary paths are normalized.\n"
        "Task IDs, input hashes, timings, test results, usage totals, summary, and manifest remain.\n"
        "Arbitrary harness stdout/stderr and test tails are intentionally omitted from the public bundle.\n"
        "The manifests did not record the runner Git revision; see vibedgc.com/benchmark for limitations.\n"
    ).encode()
    for name, data in files.items():
        text = data.decode("utf-8", errors="ignore")
        if SECRET.search(text):
            raise ValueError(f"credential-shaped value survived in {harness}/{name}")
        if INTERNAL.search(text):
            raise ValueError(f"machine-internal detail survived in {harness}/{name}")
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for name, data in sorted(files.items()):
            info = tarfile.TarInfo(name); info.size = len(data); info.mtime = 0; info.mode = 0o644; info.uid = info.gid = 0; info.uname = info.gname = ""
            tar.addfile(info, io.BytesIO(data))
    output = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0, compresslevel=9) as zipped:
        zipped.write(raw.getvalue())
    blob = output.getvalue()
    return blob


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(); args.out.mkdir(parents=True, exist_ok=True)
    stale = []
    for harness in HARNESSES:
        blob = archive(harness, args.source)
        target = args.out / f"{harness}-0.24.0.tar.gz"
        checksum = f"{hashlib.sha256(blob).hexdigest()}  {target.name}\n".encode()
        for path, data in [(target, blob), (Path(str(target) + ".sha256"), checksum)]:
            if args.check:
                if not path.exists() or path.read_bytes() != data: stale.append(path.name)
            else: path.write_bytes(data)
    if stale:
        print("benchmark evidence is stale: " + ", ".join(stale)); return 1
    print(("verified" if args.check else "wrote") + " 5 scrubbed benchmark evidence archives")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
