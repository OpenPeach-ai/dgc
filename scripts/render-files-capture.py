#!/usr/bin/env python3
"""Record the real /files focus pane during a real local-model turn (FIG.6 on vibedgc.com).

Runs the same isolated, allowlisted fixture turn as ``render-real-cli-capture.py`` — same prompt,
same one-line edit, same verification — and, while the model works, drives ``/files`` with real
keystrokes through tmux: open the explorer, inspect the file being edited, watch the change mark
land, and return to DGC. Nothing is composited; the recording is the terminal.

The base script's own outputs (the FIG.1 CLI capture and its manifest entry) are never touched:
media is staged in a scratch output directory, then published as ``files-capture.*`` with its own
``captures.files`` manifest entry.
"""
from __future__ import annotations

import importlib.util
import json
import re
import shutil
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

# (seconds after the prompt is sent, keys)  — literal text is typed; names are tmux key names.
SCENARIO = [
    (1.6, ["/files", "Enter"]),      # open the explorer before the model's first tool call
    (16.0, ["i"]),                   # inspect clamp.py (size · modified · mode · git · ✎ changed by DGC)
    (22.0, ["i"]),                   # back to the text preview
    (27.0, ["j"]),                   # test_clamp.py
    (31.0, ["k"]),                   # clamp.py again
    (36.0, ["?"]),                   # the key reference
    (40.0, ["?"]),                   # close it
    (45.0, ["q"]),                   # return to DGC for the verified ending
]

PROVENANCE = (
    "Actual DGC {version} full-screen TUI · real local Ollama run · {model} · the same disposable "
    "controlled fixture and one-line code edit as the CLI capture · /files opened and driven by real "
    "keystrokes while the turn ran · python3 -m unittest -v passed 3/3 · {timing} · the in-page "
    "animation replays the terminal's actual cells captured live from the same session; the controls "
    "dialog holds its screen recording · no user config or session persisted."
)
CAPTURE_FACTOR = {"value": 1.0}


def _drive(socket: str) -> None:
    t0 = time.monotonic()
    for offset, keys in SCENARIO:
        delay = offset - (time.monotonic() - t0)
        if delay > 0:
            time.sleep(delay)
        for key in keys:
            try:
                if len(key) > 1 and key[0].isupper():          # tmux key name (Enter, Escape, …)
                    base.tmux(socket, "send-keys", "-t", "capture", key, check=False)
                else:
                    base.tmux(socket, "send-keys", "-t", "capture", "-l", "--", key, check=False)
            except Exception:
                return
            time.sleep(0.12)


FRAME_INTERVAL_S = 0.125          # 8 fps of terminal cells; the video keeps the 30 fps pixels
FRAME_CAP_S = 150.0
COLUMNS, ROWS = 126, 32           # the recorded tmux window (see render(): new-session -x 126 -y 32)


class _FrameRecorder(threading.Thread):
    """Snapshot the real pane's cells (with SGR colour) so the site can replay them as text."""

    def __init__(self, socket: str):
        super().__init__(name="files-capture-frames", daemon=True)
        self.socket = socket
        self.frames: list[tuple[float, list[str]]] = []
        self.started = time.monotonic()
        self._stop = threading.Event()

    def stop(self) -> None:
        self._stop.set()

    def run(self) -> None:
        import subprocess
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


def _type_prompt_and_drive(socket: str, text: str) -> None:
    recorder = _FrameRecorder(socket)
    RECORDER["value"] = recorder
    recorder.start()
    _original_type_prompt(socket, text)
    threading.Thread(target=_drive, args=(socket,), name="files-capture-keys", daemon=True).start()


base.type_prompt = _type_prompt_and_drive


def _remember_factor(output_dir: Path, *, model: str, dgc_version: str, factor: float) -> None:
    CAPTURE_FACTOR["value"] = float(factor)


base.update_cli_manifest = _remember_factor


def publish(staged_dir: Path, model: str) -> None:
    assets = ROOT / "site" / "assets"
    names = {"webm": ("cli-capture.webm", "files-capture.webm"),
             "mp4": ("cli-capture.mp4", "files-capture.mp4"),
             "poster": ("cli-capture-poster.jpg", "files-capture-poster.jpg")}
    for _kind, (source, target) in names.items():
        shutil.copy2(staged_dir / source, assets / target)
    records = {kind: base.media_manifest_record(assets, target) for kind, (_s, target) in names.items()}
    recorder = RECORDER["value"]
    if recorder is None or len(recorder.frames) < 40:
        raise RuntimeError("the terminal-cell replay was not captured; refusing to publish a video-only set")
    recorder.stop()
    replay = recorder.encoded()
    replay_path = assets / "files-replay.json"
    replay_path.write_text(json.dumps(replay, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    records["replay"] = {
        "path": "assets/files-replay.json", "sha256": base.file_sha256(replay_path),
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
    payload["captures"]["files"] = {
        "kind": "real_cli_local_model_focus_pane",
        "live_model": True,
        "controlled_fixture": True,
        "real_time": real_time,
        "keystrokes": [keys for _offset, keys in SCENARIO],
        "duration_seconds": round(duration, 3),
        "duration_label": f"{rounded // 60}:{rounded % 60:02d}",
        "provenance": PROVENANCE.format(version=version, model=model, timing=timing),
        "model_route": f"local Ollama · {model}",
        "time_compression": round(factor, 4),
        "dgc_version": version,
        "files": records,
    }
    manifest_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"published files-capture ({duration:.1f}s) and the captures.files manifest entry")


def main() -> int:
    args = base.parse_args()
    if args.fixture_run:
        return base.run_fixture_child(args)
    staged = Path(tempfile.mkdtemp(prefix="dgc-files-capture-out-"))
    args.output_dir = staged
    code = base.render(args)
    if code != 0:
        return code
    publish(staged, args.model)
    shutil.rmtree(staged, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
