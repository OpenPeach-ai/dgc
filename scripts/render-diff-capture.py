#!/usr/bin/env python3
"""Record the real /diff focus pane during a real local-model turn (FIG.7 on vibedgc.com).

Runs the same isolated, allowlisted fixture turn as ``render-real-cli-capture.py`` — same prompt,
same one-line edit, same verification — and, while the model works, drives ``/diff`` with real
keystrokes through tmux: open the panel before anything has changed, watch the model's edit appear
in the list as it lands, open that diff, select the two changed lines, attach them to the next
prompt, and return to DGC. Nothing is composited; the recording is the terminal.

The driver reacts to the real screen (``tmux capture-pane``) rather than to a fixed clock: it
presses Enter only once the edited file is listed, and counts the rows to the removed line before
walking the cursor there. Every key it sends is recorded for the manifest, and the capture refuses
to publish unless every stage was observed on screen.

The base script's own outputs (the FIG.1 CLI capture and its manifest entry) are never touched:
media is staged in a scratch output directory, then published as ``diff-capture.*`` with its own
``captures.diff`` manifest entry.
"""
from __future__ import annotations

import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE_PATH = ROOT / "scripts" / "render-real-cli-capture.py"

_spec = importlib.util.spec_from_file_location("render_real_cli_capture", BASE_PATH)
base = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(base)

# The driver needs the turn's edit to land, then a few legible seconds per step. Publishing is
# uncompressed real time, so a longer floor only ever lengthens the recording; the site gate's
# minimum stays 46 s.
base.MIN_CAPTURE_SECONDS = 60.0

PROVENANCE = (
    "Actual DGC {version} full-screen TUI · real local Ollama run · {model} · the same disposable "
    "controlled fixture and one-line code edit as the CLI capture · /diff opened and driven by real "
    "keystrokes while the turn ran: the panel opened before anything had changed, the model's edit "
    "appeared in the list as it landed, its two changed lines were selected and attached to the next "
    "prompt · python3 -m unittest -v passed 3/3 · {timing} · the in-page animation replays the "
    "terminal's actual cells captured live from the same session; the controls dialog holds its "
    "screen recording · no user config or session persisted."
)
CAPTURE_FACTOR = {"value": 1.0}
KEYSTROKES: list[list[str]] = []
STAGES: dict[str, bool] = {
    "opened_before_change": False, "edit_listed": False, "diff_opened": False,
    "lines_selected": False, "attached_to_prompt": False, "returned": False,
}


def _screen(socket: str) -> list[str]:
    result = subprocess.run(["tmux", "-L", socket, "capture-pane", "-t", "capture", "-p"],
                            capture_output=True, timeout=2)
    if result.returncode != 0:
        return []
    return result.stdout.decode("utf-8", "replace").split("\n")


def _send(socket: str, keys: list[str]) -> None:
    KEYSTROKES.append(list(keys))
    for key in keys:
        if len(key) > 1 and key[0].isupper():          # tmux key name (Enter, Escape, Space …)
            base.tmux(socket, "send-keys", "-t", "capture", key, check=False)
        else:
            base.tmux(socket, "send-keys", "-t", "capture", "-l", "--", key, check=False)
        time.sleep(0.14)


def _pane_rows(rows: list[str]) -> list[str]:
    """Only the focus pane's rows. The transcript above it shows the model's own edit diff, whose
    `-     return min(...)` line otherwise matches first and makes the row arithmetic negative."""
    top = next((i for i, x in enumerate(rows) if "╭─ DIFF" in x), None)
    if top is None:
        return []
    bottom = next((i for i, x in enumerate(rows) if i > top and x.lstrip().startswith("╰─")), None)
    return rows[top:bottom + 1] if bottom is not None else rows[top:]


def _until(socket: str, predicate, timeout: float, *, every: float = 0.25) -> list[str]:
    deadline = time.monotonic() + timeout
    rows: list[str] = []
    while time.monotonic() < deadline:
        rows = _screen(socket)
        if rows and predicate(rows):
            return rows
        time.sleep(every)
    return []


DRIVE_DONE = threading.Event()


def _drive(socket: str) -> None:
    try:
        _drive_steps(socket)
    finally:
        DRIVE_DONE.set()


def _drive_steps(socket: str) -> None:
    try:
        time.sleep(1.6)                                  # let the prompt finish typing first
        _send(socket, ["/diff", "Enter"])
        rows = _until(socket, lambda r: any("DIFF" in x for x in r), 8)
        if not rows:
            return
        # The first read of git runs off-thread; wait for its verdict before judging the state.
        rows = _until(socket, lambda r: any("no changes against HEAD" in x or "changed files" in x
                                            and not any("reading git" in y for y in r) for x in r), 6)
        STAGES["opened_before_change"] = any("no changes against HEAD" in x for x in rows)
        time.sleep(0.4)
        # The model reads two files first; the edit lands some seconds later and the list re-reads
        # git every two seconds, so wait for clamp.py to appear rather than guessing the moment.
        rows = _until(socket, lambda r: any(re.search(r"\bclamp\.py\s+\+1\s+[−-]1", x) for x in _pane_rows(r)), 120)
        if not rows:
            return
        STAGES["edit_listed"] = True
        time.sleep(2.2)                                  # let the viewer see the change arrive
        _send(socket, ["Enter"])
        rows = _until(socket, lambda r: any("@@ -1,3 +1,3 @@" in x for x in _pane_rows(r))
                      and any("-     return min(lower, max(upper, value))" in x for x in _pane_rows(r)), 6)
        if not rows:
            return
        STAGES["diff_opened"] = True
        pane = _pane_rows(rows)
        hunk = next(i for i, x in enumerate(pane) if "@@ -1,3 +1,3 @@" in x)
        removed = next(i for i, x in enumerate(pane) if "-     return min(lower, max(upper, value))" in x)
        if removed <= hunk:
            return                                       # the pane is not laid out as expected; do not guess
        time.sleep(1.6)
        for _ in range(max(0, removed - hunk)):          # the cursor opens on the hunk header
            _send(socket, ["j"])
            time.sleep(0.32)
        time.sleep(0.8)
        _send(socket, ["Space"])                         # anchor on the removed line
        time.sleep(0.6)
        _send(socket, ["j"])                             # extend over the added line
        rows = _until(socket, lambda r: any("2 selected" in x for x in r), 4)
        if not rows:
            return
        STAGES["lines_selected"] = True
        time.sleep(1.8)
        _send(socket, ["Enter"])                         # attach both lines to the composer
        rows = _until(socket, lambda r: any("```diff" in x for x in r)
                      and any("attached 2 lines" in x for x in r), 4)
        if not rows:
            return
        STAGES["attached_to_prompt"] = True
        time.sleep(3.2)
        _send(socket, ["q"])                             # back to DGC; the draft stays in the composer
        rows = _until(socket, lambda r: not any("DIFF" in x for x in r)
                      and any("```diff" in x for x in r), 4)
        STAGES["returned"] = bool(rows)
    except Exception:
        return


FRAME_INTERVAL_S = 0.125          # 8 fps of terminal cells; the video keeps the 30 fps pixels
FRAME_CAP_S = 150.0
COLUMNS, ROWS = 126, 32           # the recorded tmux window (see render(): new-session -x 126 -y 32)


class _FrameRecorder(threading.Thread):
    """Snapshot the real pane's cells (with SGR colour) so the site can replay them as text."""

    def __init__(self, socket: str):
        super().__init__(name="diff-capture-frames", daemon=True)
        self.socket = socket
        self.frames: list[tuple[float, list[str]]] = []
        self.started = time.monotonic()
        self._stop = threading.Event()

    def stop(self) -> None:
        self._stop.set()

    def run(self) -> None:
        while not self._stop.is_set() and time.monotonic() - self.started < FRAME_CAP_S:
            moment = time.monotonic() - self.started
            try:
                result = subprocess.run(
                    ["tmux", "-L", self.socket, "capture-pane", "-t", "capture", "-p", "-e"],
                    capture_output=True, timeout=2)
            except (OSError, subprocess.SubprocessError):
                break
            if result.returncode != 0:
                if self.frames:          # the session ended: the recording is over
                    break
                time.sleep(FRAME_INTERVAL_S)
                continue
            rows = result.stdout.decode("utf-8", "replace").split("\n")
            rows = [row.rstrip() for row in rows[:ROWS]] + [""] * max(0, ROWS - len(rows))
            if not self.frames or rows != self.frames[-1][1]:
                self.frames.append((round(moment, 3), rows))
            time.sleep(FRAME_INTERVAL_S)

    def encoded(self) -> dict:
        """Delta-encode: a full first frame, then only the rows that changed."""
        frames: list[dict] = []
        previous: list[str] | None = None
        for moment, rows in self.frames:
            if previous is None:
                frames.append({"t": moment, "full": rows})
            else:
                delta = {str(i): row for i, (row, old) in enumerate(zip(rows, previous)) if row != old}
                if delta:
                    frames.append({"t": moment, "d": delta})
            previous = rows
        duration = (self.frames[-1][0] - self.frames[0][0]) if len(self.frames) > 1 else 0.0
        return {"schema_version": 1, "cols": COLUMNS, "rows": ROWS, "duration_seconds": round(duration, 3),
                "frames": frames}


RECORDER: dict[str, _FrameRecorder | None] = {"value": None}
_original_type_prompt = base.type_prompt
_original_tmux = base.tmux
_EXTRA_CANCEL_SENT = {"value": False}
_original_wait_for = base.wait_for


def _wait_for_turn_then_drive(predicate, message: str, timeout: float) -> None:
    """After the fixture turn finishes, hold the recording until the /diff drive has finished
    too (bounded). Without this the base script stopped ffmpeg and quit the TUI about 1.5 s
    after the turn passed, cutting a drive that was still selecting lines on a slow turn."""
    _original_wait_for(predicate, message, timeout)
    if message == "the real DGC turn did not finish in time":
        DRIVE_DONE.wait(45)
        time.sleep(1.0)


base.wait_for = _wait_for_turn_then_drive


def _tmux_draft_aware(socket: str, *arguments: str, check: bool = True, env=None):
    """The drive deliberately leaves the attached lines in the composer, so the base script's
    two Ctrl+C presses (clear the draft, arm quitting) stop one short of quitting. Send one more
    press with the first, so the sequence becomes: clear draft, arm, quit."""
    result = _original_tmux(socket, *arguments, check=check, env=env)
    if tuple(arguments[:4]) == ("send-keys", "-t", "capture", "C-c") and not _EXTRA_CANCEL_SENT["value"]:
        _EXTRA_CANCEL_SENT["value"] = True
        time.sleep(0.3)
        _original_tmux(socket, *arguments, check=False, env=env)
    return result


base.tmux = _tmux_draft_aware


def _type_prompt_and_drive(socket: str, text: str) -> None:
    recorder = _FrameRecorder(socket)
    RECORDER["value"] = recorder
    recorder.start()
    _original_type_prompt(socket, text)
    threading.Thread(target=_drive, args=(socket,), name="diff-capture-keys", daemon=True).start()


base.type_prompt = _type_prompt_and_drive


def _remember_factor(output_dir: Path, *, model: str, dgc_version: str, factor: float) -> None:
    CAPTURE_FACTOR["value"] = float(factor)


base.update_cli_manifest = _remember_factor


def publish(staged_dir: Path, model: str) -> None:
    missing = [name for name, seen in STAGES.items() if not seen]
    if missing:
        recorder = RECORDER["value"]
        if recorder is not None:
            recorder.stop()
            debug = Path(tempfile.gettempdir()) / "diff-capture-debug-frames.json"
            debug.write_text(json.dumps({"stages": STAGES, "keystrokes": KEYSTROKES,
                                         "frames": recorder.encoded()}, ensure_ascii=False))
        raise RuntimeError("the /diff drive did not complete on screen; refusing to publish: "
                           + ", ".join(missing))
    assets = ROOT / "site" / "assets"
    names = {"webm": ("cli-capture.webm", "diff-capture.webm"),
             "mp4": ("cli-capture.mp4", "diff-capture.mp4"),
             "poster": ("cli-capture-poster.jpg", "diff-capture-poster.jpg")}
    for _kind, (source, target) in names.items():
        shutil.copy2(staged_dir / source, assets / target)
    records = {kind: base.media_manifest_record(assets, target) for kind, (_s, target) in names.items()}
    recorder = RECORDER["value"]
    if recorder is None or len(recorder.frames) < 40:
        raise RuntimeError("the terminal-cell replay was not captured; refusing to publish a video-only set")
    recorder.stop()
    replay = recorder.encoded()
    replay_path = assets / "diff-replay.json"
    replay_path.write_text(json.dumps(replay, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    records["replay"] = {
        "path": "assets/diff-replay.json", "sha256": base.file_sha256(replay_path),
        "bytes": replay_path.stat().st_size, "frames": len(replay["frames"]),
        "cols": COLUMNS, "rows": ROWS, "duration_seconds": replay["duration_seconds"],
    }
    duration = float(records["webm"]["duration_seconds"])
    rounded = int(duration + 0.5)
    version = re.search(r'^__version__ = "([^"]+)"', (ROOT / "dgc" / "__init__.py").read_text(), re.M).group(1)
    manifest_path = ROOT / "site-src" / "data" / "capture-media.json"
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    factor = CAPTURE_FACTOR["value"]
    real_time = abs(factor - 1.0) < 0.0001
    timing = "real time, no speed adjustment" if real_time else f"{factor:.2f}× time-compressed"
    payload["captures"]["diff"] = {
        "kind": "real_cli_local_model_focus_pane",
        "live_model": True,
        "controlled_fixture": True,
        "real_time": real_time,
        "keystrokes": [list(keys) for keys in KEYSTROKES],
        "duration_seconds": round(duration, 3),
        "duration_label": f"{rounded // 60}:{rounded % 60:02d}",
        "provenance": PROVENANCE.format(version=version, model=model, timing=timing),
        "model_route": f"local Ollama · {model}",
        "time_compression": round(factor, 4),
        "dgc_version": version,
        "files": records,
    }
    manifest_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"published diff-capture ({duration:.1f}s) and the captures.diff manifest entry")


def main() -> int:
    args = base.parse_args()
    if args.fixture_run:
        return base.run_fixture_child(args)
    staged = Path(tempfile.mkdtemp(prefix="dgc-diff-capture-out-"))
    args.output_dir = staged
    code = base.render(args)
    if code != 0:
        return code
    publish(staged, args.model)
    shutil.rmtree(staged, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
