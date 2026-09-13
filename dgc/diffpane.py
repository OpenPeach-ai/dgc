"""The ``/diff`` pane occupant: every changed file, its line counts, and the diff, live.

Sits in the focus pane under the transcript, so the agent keeps streaming above it while you read
what it changed. The data is Git's: the working tree against HEAD (plus staged and untracked
files), exactly what ``git status`` would call changed. Select lines in a diff and press Enter and
they land in the composer as a fenced snippet for your next prompt -- no shell, no writes, and
nothing enters the model's context unless you insert it.

The occupant owns no terminal, process or model resource (see :mod:`dgc.pane`). Git runs on a
worker thread so opening the pane on a large repository never stalls the transcript; the pulse
picks the result up on the next redraw through :meth:`DiffPane.advance`.
"""
from __future__ import annotations

import difflib
import threading
import time
from pathlib import Path

from .pane import PaneFrame, Segment

REFRESH_S = 2.0          # how often an idle pane re-reads git; edits by the agent show up quickly
MAX_DIFF_ROWS = 4000     # a diff longer than this is clipped; the composer snippet cap is separate
MAX_SNIPPET_LINES = 120  # what one Enter may insert into the prompt
HELP_ROWS = (
    ("j / k · ↑ ↓", "next / previous file · line"),
    ("Enter · l · →", "open the diff under the cursor"),
    ("h · ← · Esc", "back to the file list"),
    ("Space · v", "start / drop a line selection"),
    ("Enter", "with a selection: attach it to your prompt"),
    ("a", "attach the whole hunk"),
    ("J / K", "next / previous file inside the diff"),
    ("g / G · Home End", "top / bottom"),
    ("PgUp / PgDn", "page · Ctrl+D / Ctrl+U half a page"),
    ("Tab", "list ⇄ diff when the pane is narrow"),
    ("r", "re-read git now"),
    ("?", "this reference"),
    ("q", "return to DGC · Ctrl+C still stops the agent"),
)


def _clip(text: str, width: int) -> str:
    if width <= 0:
        return ""
    if len(text) <= width:
        return text
    return text[: max(0, width - 1)] + "…"


def _pad(text: str, width: int) -> str:
    return _clip(text, width).ljust(width)


def _counts_label(row: dict) -> tuple[str, str]:
    if row.get("binary"):
        return ("bin", "")
    if not row.get("counted", True):
        return ("—", "")
    return (f"+{int(row.get('additions', 0))}", f"−{int(row.get('deletions', 0))}")


def _unified(before: str, after: str, path: str) -> list[tuple[str, str, int | None]]:
    """Rows of (kind, text, new_line_number) for a unified diff; kind is hunk/add/del/ctx."""
    rows: list[tuple[str, str, int | None]] = []
    new_line = 0
    lines = difflib.unified_diff(before.splitlines(), after.splitlines(),
                                 fromfile=f"a/{path}", tofile=f"b/{path}", lineterm="", n=3)
    for raw in lines:
        if raw.startswith("+++") or raw.startswith("---"):
            continue
        if raw.startswith("@@"):
            # @@ -a,b +c,d @@  -> the new side starts at c
            try:
                plus = raw.split("+", 1)[1].split(" ", 1)[0]
                new_line = int(plus.split(",", 1)[0])
            except (IndexError, ValueError):
                new_line = 0
            rows.append(("hunk", raw, None))
            continue
        if raw.startswith("+"):
            rows.append(("add", raw[1:], new_line))
            new_line += 1
        elif raw.startswith("-"):
            rows.append(("del", raw[1:], None))
        else:
            rows.append(("ctx", raw[1:] if raw.startswith(" ") else raw, new_line))
            new_line += 1
        if len(rows) >= MAX_DIFF_ROWS:
            rows.append(("hunk", f"… diff clipped at {MAX_DIFF_ROWS} rows", None))
            break
    return rows


class GitLoader:
    """The real data source: ``git`` through the same read-only review the editor uses."""

    def __init__(self, root: Path):
        self.root = Path(root)

    def changes(self, cancel=None) -> dict:
        from .workspace_changes import collect_changes
        return collect_changes(self.root, cancel, deadline=time.monotonic() + 20)

    def diff(self, path: str, cancel=None) -> dict:
        from .workspace_changes import read_change
        return read_change(self.root, path, cancel)


class DiffPane:
    kind = "diff"
    key = "diff"
    text_input = False
    raw_text_input = False
    paused = False
    redraw_interval = 0.5

    def __init__(self, root, *, host, start: str | None = None, loader=None, now: float | None = None,
                 threaded: bool = True):
        self.root = Path(root).resolve(strict=False)
        self.host = host
        self.loader = loader or GitLoader(self.root)
        self.threaded = threaded
        self._lock = threading.RLock()
        self._revision = 0
        self.files: list[dict] = []
        self.notices: list[str] = []
        self.complete = True
        self.total = 0
        self.cursor = 0                # file index
        self.mode = "list"             # list | diff | help
        self.view = "auto"             # auto | list | diff  (Tab, for narrow panes)
        self.diff_rows: list[tuple[str, str, int | None]] = []
        self.diff_path = ""
        self.diff_error = ""
        self.line = 0                  # cursor row inside the diff
        self.scroll = 0
        self.anchor: int | None = None # visual-selection anchor row
        self.status = ""
        self._status_until = 0.0
        self.loading = True
        self._last_refresh = 0.0
        self._pending_start = (start or "").strip()
        self._cancel = threading.Event()
        self.refresh(now=now)

    # ------------------------------------------------------------------ occupant protocol ----
    @property
    def revision(self) -> int:
        return self._revision

    def _bump(self) -> None:
        self._revision += 1

    def pause(self, reason: str = "PAUSED") -> bool:
        return False

    def resume(self, now: float | None = None) -> bool:
        return False

    def close(self) -> None:
        self._cancel.set()

    def handle_text(self, text: str) -> bool:
        return False

    def hint_chips(self) -> list[tuple[str, str]]:
        if self.mode == "help":
            return [("?", "close"), ("Q/Esc", "return")]
        if self.mode == "diff":
            return [("↑↓", "move"), ("Space", "select"), ("Enter", "attach"),
                    ("h/Esc", "files"), ("?", "keys"), ("Q", "return")]
        return [("↑↓", "move"), ("Enter", "open diff"), ("r", "refresh"), ("?", "keys"),
                ("Q/Esc", "return")]

    def advance(self, *, now: float | None = None) -> int:
        moment = time.monotonic() if now is None else now
        if self.status and moment >= self._status_until:
            self.status = ""
            self._bump()
        if not self.loading and moment - self._last_refresh >= REFRESH_S:
            self.refresh(now=moment)
        return self._revision

    # ---------------------------------------------------------------------------- data ----
    def refresh(self, *, now: float | None = None) -> None:
        moment = time.monotonic() if now is None else now
        self._last_refresh = moment
        self.loading = True
        if self.threaded:
            thread = threading.Thread(target=self._load, name="dgc-diff-pane", daemon=True)
            thread.start()
        else:
            self._load()

    def _load(self) -> None:
        try:
            report = self.loader.changes(self._cancel)
        except Exception as exc:  # the loader must never take the pane down
            report = {"files": [], "total": 0, "complete": False,
                      "notices": [f"could not read changes: {str(exc)[:200]}"]}
        if self._cancel.is_set():
            return
        with self._lock:
            keep = self.files[self.cursor]["path"] if self.files and self.cursor < len(self.files) else ""
            self.files = list(report.get("files") or [])
            self.total = int(report.get("total") or len(self.files))
            self.complete = bool(report.get("complete", True))
            self.notices = [str(n) for n in (report.get("notices") or [])]
            self.cursor = next((i for i, row in enumerate(self.files) if row["path"] == keep), 0)
            if self._pending_start:
                wanted = self._pending_start
                self._pending_start = ""
                hit = next((i for i, row in enumerate(self.files)
                            if row["path"] == wanted or row["path"].endswith("/" + wanted)), None)
                if hit is not None:
                    self.cursor = hit
                    self._open_diff()
            elif self.mode == "diff" and self.diff_path:
                self._open_diff(keep_position=True)
            self.loading = False
            self._bump()

    def _open_diff(self, *, keep_position: bool = False) -> None:
        if not self.files:
            return
        row = self.files[self.cursor]
        path = row["path"]
        try:
            change = self.loader.diff(path, self._cancel)
            rows = _unified(str(change.get("before", "")), str(change.get("after", "")), path)
            error = ""
        except Exception as exc:
            rows, error = [], str(exc)[:300]
        if row.get("error") and not rows and not error:
            error = str(row["error"])
        old_line, old_scroll = self.line, self.scroll
        self.diff_rows, self.diff_path, self.diff_error = rows, path, error
        self.mode = "diff"
        if keep_position and rows:
            self.line = min(old_line, len(rows) - 1)
            self.scroll = min(old_scroll, max(0, len(rows) - 1))
        else:
            self.line = self.scroll = 0
            self.anchor = None

    # --------------------------------------------------------------------------- keys ----
    def handle_key(self, key: str, *, now: float | None = None) -> str:
        moment = time.monotonic() if now is None else now
        token = str(key or "")
        with self._lock:
            if self.mode == "help":
                if token in ("?", "escape", "q", "Q"):
                    self.mode = self._before_help
                    self._bump()
                    return "changed"
                return "ignored"
            result = self._diff_key(token, moment) if self.mode == "diff" else self._list_key(token, moment)
        if result == "changed":
            self._bump()
        return result

    def _say(self, message: str, now: float) -> None:
        self.status = message
        self._status_until = now + 3.5

    def _list_key(self, key: str, now: float) -> str:
        n = len(self.files)
        if key in ("q", "Q"):
            return "exit"
        if key == "escape":
            return "exit"
        if key == "?":
            self._before_help, self.mode = "list", "help"
            return "changed"
        if key == "r":
            self.refresh(now=now)
            self._say("re-reading git", now)
            return "changed"
        if key == "tab":
            self.view = {"auto": "diff", "diff": "list", "list": "auto"}[self.view]
            return "changed"
        if n == 0:
            return "ignored"
        if key in ("j", "down"):
            self.cursor = min(n - 1, self.cursor + 1)
        elif key in ("k", "up"):
            self.cursor = max(0, self.cursor - 1)
        elif key in ("g", "home"):
            self.cursor = 0
        elif key in ("G", "end"):
            self.cursor = n - 1
        elif key in ("pagedown", "c-f", "c-d"):
            self.cursor = min(n - 1, self.cursor + 8)
        elif key in ("pageup", "c-b", "c-u"):
            self.cursor = max(0, self.cursor - 8)
        elif key in ("enter", "l", "right", "o"):
            self._open_diff()
        else:
            return "ignored"
        return "changed"

    def _diff_key(self, key: str, now: float) -> str:
        rows = len(self.diff_rows)
        if key in ("q", "Q"):
            return "exit"
        if key in ("h", "left", "escape", "backspace"):
            if self.anchor is not None and key == "escape":
                self.anchor = None
                return "changed"
            self.mode = "list"
            self.anchor = None
            return "changed"
        if key == "?":
            self._before_help, self.mode = "diff", "help"
            return "changed"
        if key == "r":
            self.refresh(now=now)
            self._say("re-reading git", now)
            return "changed"
        if key == "tab":
            self.view = {"auto": "diff", "diff": "list", "list": "auto"}[self.view]
            return "changed"
        if key in ("J",):                      # next file without leaving the diff
            if self.cursor < len(self.files) - 1:
                self.cursor += 1
                self._open_diff()
            return "changed"
        if key in ("K",):
            if self.cursor > 0:
                self.cursor -= 1
                self._open_diff()
            return "changed"
        if rows == 0:
            return "ignored"
        if key in ("j", "down"):
            self.line = min(rows - 1, self.line + 1)
        elif key in ("k", "up"):
            self.line = max(0, self.line - 1)
        elif key in ("g", "home"):
            self.line = 0
        elif key in ("G", "end"):
            self.line = rows - 1
        elif key in ("pagedown", "c-f"):
            self.line = min(rows - 1, self.line + 12)
        elif key in ("pageup", "c-b"):
            self.line = max(0, self.line - 12)
        elif key == "c-d":
            self.line = min(rows - 1, self.line + 6)
        elif key == "c-u":
            self.line = max(0, self.line - 6)
        elif key in ("space", "v"):
            self.anchor = self.line if self.anchor is None else None
        elif key == "a":
            self._attach(self._hunk_bounds(self.line), now)
        elif key == "enter":
            if self.anchor is None:
                self._say("Space selects lines first · a attaches the hunk", now)
            else:
                lo, hi = sorted((self.anchor, self.line))
                self._attach((lo, hi), now)
        else:
            return "ignored"
        return "changed"

    def _hunk_bounds(self, at: int) -> tuple[int, int]:
        lo = at
        while lo > 0 and self.diff_rows[lo][0] != "hunk":
            lo -= 1
        hi = at
        while hi + 1 < len(self.diff_rows) and self.diff_rows[hi + 1][0] != "hunk":
            hi += 1
        return (lo, hi)

    def _attach(self, bounds: tuple[int, int], now: float) -> None:
        lo, hi = bounds
        chosen = [r for r in self.diff_rows[lo:hi + 1] if r[0] != "hunk"]
        if not chosen:
            self._say("nothing selected", now)
            return
        clipped = len(chosen) > MAX_SNIPPET_LINES
        chosen = chosen[:MAX_SNIPPET_LINES]
        numbered = [r[2] for r in chosen if r[2] is not None]
        span = f", new lines {min(numbered)}–{max(numbered)}" if numbered else ""
        marker = {"add": "+", "del": "-", "ctx": " "}
        body = "\n".join(marker[k] + t for k, t, _ in chosen)
        header = f"From the /diff panel · {self.diff_path} · working tree vs HEAD{span}"
        if clipped:
            header += f" · first {MAX_SNIPPET_LINES} lines"
        snippet = f"{header}\n```diff\n{body}\n```\n"
        insert = getattr(self.host, "insert_reference", None)
        if callable(insert):
            insert(snippet)
        self.anchor = None
        self._say(f"attached {len(chosen)} line{'s' if len(chosen) != 1 else ''} to your prompt", now)

    # ------------------------------------------------------------------------- snapshot ----
    def _layout(self, width: int) -> tuple[int, int]:
        """(list_width, diff_width); a zero means that column is hidden."""
        if self.view == "list":
            return (width, 0)
        if self.view == "diff":
            return (0, width)
        if width >= 100:
            return (36, width - 37)
        if width >= 64:
            return (28, width - 29)
        return (width, 0) if self.mode == "list" else (0, width)

    def snapshot(self, width: int, height: int) -> PaneFrame:
        width, height = max(20, int(width)), max(2, int(height))
        with self._lock:
            if self.mode == "help":
                rows = self._help_rows(width, height)
                return PaneFrame(title="DIFF", score="keys", lines=tuple(rows[:height]),
                                 footer="? or Esc closes this", status=self.status)
            list_w, diff_w = self._layout(width)
            rows: list[tuple[Segment, ...]] = []
            blank_left = (Segment(" " * list_w, "diff-meta"),)
            for i in range(height):
                left = self._list_row(i, list_w, height) if list_w else ()
                right = self._diff_row(i, diff_w, height) if diff_w else ()
                if list_w and diff_w:
                    rows.append((*(left or blank_left), Segment("│", "diff-rule"), *right))
                else:
                    rows.append(left or right)
            changed = len(self.files)
            adds = sum(int(f.get("additions", 0)) for f in self.files)
            dels = sum(int(f.get("deletions", 0)) for f in self.files)
            score = ("reading git…" if self.loading and not self.files
                     else f"{changed} file{'s' if changed != 1 else ''} · +{adds} −{dels}")
            if self.total > changed:
                score += f" · {self.total} total"
            if self.mode == "diff":
                sel = ""
                if self.anchor is not None:
                    lo, hi = sorted((self.anchor, self.line))
                    sel = f"{hi - lo + 1} selected · "
                footer = sel + "j/k move · Space select · Enter attach · a hunk · J/K file · h back · ? keys · q return"
            else:
                footer = "j/k move · Enter open diff · r refresh · Tab layout · ? keys · q return"
            return PaneFrame(title="DIFF", score=score, lines=tuple(rows[:height]),
                             footer=footer, status=self.status)

    def _list_row(self, i: int, width: int, height: int) -> tuple[Segment, ...]:
        if i == 0:
            head = " changed files" if width < 44 else " changed files · working tree vs HEAD"
            return (Segment(_pad(head, width), "diff-meta"),)
        idx = i - 1
        if not self.files:
            if idx == 0:
                msg = " reading git…" if self.loading else " no changes against HEAD"
                if self.notices and not self.loading:
                    msg = " " + self.notices[0]
                return (Segment(_pad(msg, width), "diff-meta"),)
            return ()
        # scroll the list so the cursor is always on screen
        visible = max(1, height - 1)
        first = max(0, min(self.cursor - visible + 1, len(self.files) - visible))
        first = max(0, min(first, self.cursor))
        real = idx + first
        if real >= len(self.files):
            return ()
        row = self.files[real]
        adds, dels = _counts_label(row)
        flag = "?" if row.get("untracked") else "D" if row.get("deleted") else "S" if row.get("staged") else " "
        counts_w = 13   # " +9999 −9999 "
        name_w = max(4, width - counts_w - 3)
        name = _clip(row["path"], name_w)
        is_cur = real == self.cursor
        role_path = "diff-cursor" if is_cur else ("diff-untracked" if row.get("untracked") else "diff-path")
        return (Segment(f" {flag} ", "diff-cursor" if is_cur else "diff-meta"),
                Segment(_pad(name, name_w), role_path),
                Segment(f" {adds:>5}", "diff-cursor" if is_cur else "diff-add-count"),
                Segment(f" {dels:>5} ", "diff-cursor" if is_cur else "diff-del-count"))

    def _diff_row(self, i: int, width: int, height: int) -> tuple[Segment, ...]:
        if i == 0:
            if self.mode != "diff":
                hint = " working tree vs HEAD · Enter opens the diff under the cursor"
                return (Segment(_pad(hint, width), "diff-meta"),)
            title = f" {self.diff_path}"
            if self.diff_error:
                title += " · " + self.diff_error
            return (Segment(_pad(title, width), "diff-meta"),)
        if self.mode != "diff":
            return ()
        body = height - 1
        # keep the cursor row on screen
        if self.line < self.scroll:
            self.scroll = self.line
        elif self.line >= self.scroll + body:
            self.scroll = self.line - body + 1
        idx = self.scroll + (i - 1)
        if idx >= len(self.diff_rows):
            if idx == 0 and self.diff_error:
                return (Segment(_pad(" " + self.diff_error, width), "diff-meta"),)
            if idx == 0:
                return (Segment(_pad(" no textual difference", width), "diff-meta"),)
            return ()
        kind, text, lineno = self.diff_rows[idx]
        selected = False
        if self.anchor is not None:
            lo, hi = sorted((self.anchor, self.line))
            selected = lo <= idx <= hi
        cursor = idx == self.line
        gutter = f"{lineno:>5} " if lineno is not None else "      "
        if kind == "hunk":
            return (Segment(_pad(" " + text, width), "diff-hunk"),)
        marker = {"add": "+", "del": "-", "ctx": " "}[kind]
        content_w = max(1, width - len(gutter) - 2)
        content = _pad(text.replace("\t", "    "), content_w)
        role = {"add": "diff-add", "del": "diff-del", "ctx": "diff-ctx"}[kind]
        if selected:
            role = {"add": "diff-sel-add", "del": "diff-sel-del", "ctx": "diff-sel"}[kind]
        gutter_role = "diff-cursor" if cursor else "diff-lineno"
        return (Segment(gutter, gutter_role), Segment(marker + " ", role), Segment(content, role))

    def _help_rows(self, width: int, height: int) -> list[tuple[Segment, ...]]:
        rows: list[tuple[Segment, ...]] = [(Segment(_pad(" /diff · keys", width), "diff-meta"),)]
        two_up = width >= 104
        if two_up:
            half = (width - 2) // 2
            key_w = 18
            desc_w = max(8, half - key_w - 1)
            pairs = list(HELP_ROWS)
            split = (len(pairs) + 1) // 2
            for left, right in zip(pairs[:split], pairs[split:] + [("", "")]):
                rows.append((Segment(" " + _pad(left[0], key_w), "diff-hunk"), Segment(_pad(left[1], desc_w), "diff-ctx"),
                             Segment(" " + _pad(right[0], key_w), "diff-hunk"), Segment(_pad(right[1], desc_w), "diff-ctx")))
        else:
            key_w = 18
            desc_w = max(8, width - key_w - 2)
            for key, desc in HELP_ROWS:
                rows.append((Segment(" " + _pad(key, key_w), "diff-hunk"), Segment(_pad(desc, desc_w), "diff-ctx")))
        return rows[:height]
