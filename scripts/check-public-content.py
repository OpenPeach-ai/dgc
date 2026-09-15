#!/usr/bin/env python3
"""Reject private work records in tracked release sources without printing their contents."""
from pathlib import Path
import re
import subprocess
import sys


def check(root: Path) -> list[str]:
    paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
    forbidden = re.compile(r'(?:^|/)(?:\.claude|\.codex|private-evidence|internal-evidence)(?:/|$)'
                           r'|(?:^|/)(?:HANDOFF|TAKEOVER|WORK-LOG|NEXT-STEPS|[^/]*_AUDIT)\.md$'
                           r'|(?:^|/)[^/]*session[^/]*\.jsonl$', re.I)
    # Provider integrations, public comparisons and runtime session code are legitimate source.
    # Personal home paths and conversation-export markers are not release documentation.
    content = re.compile(rb'(?:/home|/Users)/[^/\s]+/\.(?:claude|codex)/projects/'
                         rb'|<send_user_message_' rb'question_reply>'
                         rb'|"(?:parentUuid|isSidechain)"\s*:', re.I)
    errors = []
    for name in filter(None, paths):
        path = root / name
        if not path.is_file():
            continue
        if forbidden.search(name):
            errors.append(name + ': private work-record path')
            continue
        # Stream text so a large export cannot evade the check. Binary archives/media have
        # separate release allowlists and checksum/provenance validators.
        with path.open('rb') as stream:
            data = stream.read(8192)
            if b'\0' in data:
                continue
            while data:
                if content.search(data):
                    errors.append(name + ': conversation-export marker')
                    break
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                data = data[-256:] + chunk
    return errors


if __name__ == '__main__':
    errors = check(Path(__file__).resolve().parent.parent)
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        raise SystemExit(1)
    print('Public source content: no private work records found.')
