#!/usr/bin/env python3
"""Regenerate the checked-in editor protocol JSON Schema and TypeScript contract.

`--check` regenerates nothing: it exits 1 naming every checked-in artifact that no longer
matches what dgc/editor_protocol.py would generate (the CI/pre-release gate).
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dgc.editor_protocol import generated_artifacts, write_generated  # noqa: E402


def check() -> int:
    stale = []
    for path, expected in generated_artifacts(ROOT).items():
        try:
            current = path.read_text()
        except OSError:
            current = None
        if current != expected:
            stale.append(path)
    for path in stale:
        print(f"stale: {path.relative_to(ROOT)}", file=sys.stderr)
    if stale:
        print("run scripts/generate-editor-protocol.py to regenerate", file=sys.stderr)
        return 1
    print(f"editor protocol artifacts are current ({len(generated_artifacts(ROOT))} files)")
    return 0


if __name__ == "__main__":
    if "--check" in sys.argv[1:]:
        sys.exit(check())
    for path in write_generated(ROOT):
        print(path.relative_to(ROOT))
