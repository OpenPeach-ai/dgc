#!/usr/bin/env python3
"""Regenerate the checked-in editor protocol JSON Schema and TypeScript contract."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dgc.editor_protocol import write_generated  # noqa: E402


if __name__ == "__main__":
    for path in write_generated(ROOT):
        print(path.relative_to(ROOT))
