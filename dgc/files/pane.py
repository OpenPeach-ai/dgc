"""The ``/files`` pane occupant: Miller columns, yazi-style keys, no shell, policy-gated writes."""
from __future__ import annotations

import os
import stat
import time
from pathlib import Path

from ..pane import PaneFrame, Segment
from ..workspace import is_within
from .model import SORTS, Entry, Listing, directory_version, human_size, matches_filter, scan
from .ops import FileOps, OpError, Trash
from .preview import GitStatus, directory_preview, text_preview

POLL_S = 1.0
STATUS_S = 3.5
HELP_ROWS = (
    ("j / k · ↑ ↓", "move", "h / l · ← →", "parent / enter"),
    ("gg / G · Home End", "top / bottom", "H / L · -", "back / forward · previous"),
    ("Space · v · Ctrl+A", "select · visual · all", "Esc", "clear selection · filter · help"),
    ("y · x · p · P", "copy · cut · paste · overwrite", "Y / X", "cancel the clipboard"),
    ("a", "new (end with / for a folder)", "r", "rename"),
    ("d · D", "trash · delete permanently", "u", "undo the last change"),
    (". · s · S", "hidden · sort · reverse", "f · / · n N", "filter · find · next / previous"),
    ("Enter · o", "insert @path into the prompt", "c", "insert the plain path"),
    ("i · Tab · J K", "inspect · scroll the preview", "~ · gr · gh", "home · project root · home"),
    ("q", "return to DGC", "Ctrl+C", "still stops the agent"),
)


class FilesPaneError(Exception):
    pass


def _tilde(path: Path) -> str:
    home = Path.home()
    text = str(path)
    if text == str(home):
        return "~"
    if text.startswith(str(home) + os.sep):
        return "~" + text[len(str(home)):]
    return text


class FilesPane:
    kind = "files"
    key = "files"
    text_input = False       # letters are commands; raw text is only taken in a prompt
    redraw_interval = 0.5

    def __init__(self, root, *, host, start: str | None = None, ops: FileOps | None = None,
                 git: GitStatus | None = None, now: float | None = None):
        self.root = Path(root).resolve(strict=False)
        self.host = host
        config = getattr(host, "config", None)
        trash_mode = "dgc"
        if config is not None:
            try:
                trash_mode = str(config.get("trash_mode", "dgc") or "dgc")
            except Exception:
                trash_mode = "dgc"
        self.ops = ops or FileOps(Trash(trash_mode))
        self.git = git or GitStatus()
        self.paused = False
        self.cwd = self.root
        self.listing: Listing = Listing(self.root, [], 0, False)
        self.cursor = 0
        self.scroll = 0
        self.selected: set[Path] = set()
        self.visual: int | None = None
        self.history: list[Path] = []
        self.future: list[Path] = []
        self.previous: Path | None = None
        self.show_hidden = False
        self.sort = "name"
        self.reverse = False
        self.pattern = ""
        self.find_query = ""
        self.clipboard: tuple[list[Path], bool] | None = None
        self.mode = "normal"          # normal | text | confirm
        self.prompt: dict | None = None
        self.confirm: dict | None = None
        self.status = ""
        self.status_until = 0.0
        self.pending = ""             # g-chord prefix
        self.preview_scroll = 0
        self.inspect = False
        self.help = False
        self._revision = 0
        self._last_poll = 0.0
        self._changed: set[str] = set()
        self._changed_at = -1.0
        moment = time.monotonic() if now is None else now
        target = self.root
        focus_name = ""
        if start:
            candidate = Path(start).expanduser()
            if not candidate.is_absolute():
                candidate = (self.root / candidate)
            candidate = candidate.resolve(strict=False)
            if candidate.is_dir():
                target = candidate
            elif candidate.exists():
                target, focus_name = candidate.parent, candidate.name
            else:
                raise FilesPaneError(f"no such path: {start}")
        self._enter(target, remember=False, now=moment)
        if focus_name:
            self._focus_name(focus_name)

    # ---------------------------------------------------------------- occupant protocol ----
    @property
    def raw_text_input(self) -> bool:
        return self.mode == "text"

    @property
    def revision(self) -> int:
        return self._revision

    def pause(self, reason: str = "PAUSED") -> bool:
        return False                  # nothing here runs on a clock; there is nothing to pause

    def resume(self, now: float | None = None) -> bool:
        return False

    def close(self) -> None:
        return None

    def hint_chips(self) -> list[tuple[str, str]]:
        if self.mode == "text":
            return [("Enter", "confirm"), ("Esc", "cancel")]
        if self.mode == "confirm":
            return [("y", "yes"), ("n", "no")]
        return [("↑↓ ←→", "move"), ("Space", "select"), ("y/x/p", "copy·cut·paste"),
                ("a·r·d", "new·rename·trash"), ("Enter", "@path"), ("?", "keys"),
                ("Q/Esc", "return")]

    # ---------------------------------------------------------------------- navigation ----
    def _rescan(self, keep: str | None = None) -> None:
        current = self.listing.entries[self.cursor].name if self._entry() else None
        self.listing = scan(self.cwd, show_hidden=self.show_hidden, sort=self.sort,
                            reverse=self.reverse, pattern=self.pattern)
        present = {e.path for e in self.listing.entries}
        self.selected = {p for p in self.selected if p in present}
        name = keep or current
        if name:
            self._focus_name(name)
        self._clamp()

    def _focus_name(self, name: str) -> None:
        for index, entry in enumerate(self.listing.entries):
            if entry.name == name:
                self.cursor = index
                return

    def _clamp(self) -> None:
        count = len(self.listing.entries)
        self.cursor = 0 if count == 0 else max(0, min(self.cursor, count - 1))
        self.preview_scroll = 0 if not self.listing.entries else self.preview_scroll

    def _entry(self) -> Entry | None:
        if 0 <= self.cursor < len(self.listing.entries):
            return self.listing.entries[self.cursor]
        return None

    def _enter(self, path: Path, *, remember: bool = True, now: float | None = None) -> None:
        if remember and path != self.cwd:
            self.history.append(self.cwd)
            del self.history[:-64]
            self.future.clear()
            self.previous = self.cwd
        self.cwd = path
        self.cursor = 0
        self.scroll = 0
        self.selected.clear()
        self.visual = None
        self.pattern = ""
        self.preview_scroll = 0
        self._rescan()
        self._last_poll = time.monotonic() if now is None else now

    def go(self, target: str) -> None:
        candidate = Path(target).expanduser()
        if not candidate.is_absolute():
            local = self.cwd / candidate
            candidate = local if local.exists() else self.root / candidate
        candidate = candidate.resolve(strict=False)
        if candidate.is_dir():
            self._enter(candidate)
        elif candidate.exists():
            self._enter(candidate.parent)
            self._focus_name(candidate.name)
        else:
            raise FilesPaneError(f"no such path: {target}")
        self._revision += 1

    def _move(self, delta: int) -> None:
        if not self.listing.entries:
            return
        self.cursor = max(0, min(len(self.listing.entries) - 1, self.cursor + delta))
        self.preview_scroll = 0
        if self.visual is not None:
            self._apply_visual()

    def _apply_visual(self) -> None:
        low, high = sorted((self.visual, self.cursor))
        for index, entry in enumerate(self.listing.entries):
            if low <= index <= high:
                self.selected.add(entry.path)

    # ---------------------------------------------------------------------- selection -----
    def _targets(self) -> list[Path]:
        """The selected entries, or the entry under the cursor."""
        if self.selected:
            return [e.path for e in self.listing.entries if e.path in self.selected]
        entry = self._entry()
        return [entry.path] if entry else []

    # ---------------------------------------------------------------------- policy --------
    def _mode(self) -> str:
        try:
            return str(getattr(self.host, "mode", "default") or "default")
        except Exception:
            return "default"

    def _policy(self, action: str, paths: list[Path], dest: Path | None = None) -> tuple[str, str]:
        mode = self._mode()
        if mode == "plan":
            return "deny", "read-only in plan mode · /mode to change"
        targets = list(paths) + ([dest] if dest is not None else [])
        outside = [p for p in targets if not is_within(p, self.root)]
        count = len(paths)
        noun = f"{count} item{'s' if count != 1 else ''}"
        if outside:
            if mode != "auto":
                return "deny", "writes stay inside the project (auto mode may confirm)"
            return "confirm", f"outside the project · {action} {noun}?"
        if action == "delete":
            return "confirm", f"delete {noun} permanently?"
        if action in ("trash", "move", "overwrite") and mode == "default":
            return "confirm", f"{action} {noun}?"
        return "ok", ""

    def _guarded(self, action: str, paths: list[Path], run, dest: Path | None = None) -> None:
        verdict, message = self._policy(action, paths, dest)
        if verdict == "deny":
            self._say(message)
            return
        if verdict == "confirm":
            self.mode = "confirm"
            self.confirm = {"message": message, "on_yes": run}
            return
        self._perform(run)

    def _perform(self, run) -> None:
        try:
            result = run()
        except OpError as exc:
            self._say(str(exc))
            return
        if result is not None:
            self._say(result.message)
        self._rescan()

    # ---------------------------------------------------------------------- messages ------
    def _say(self, message: str, now: float | None = None) -> None:
        self.status = str(message)[:120]
        self.status_until = (time.monotonic() if now is None else now) + STATUS_S

    # ---------------------------------------------------------------------- prompts -------
    def _ask(self, label: str, on_submit, *, value: str = "", cursor: int | None = None,
             live=None) -> None:
        self.mode = "text"
        self.prompt = {"label": label, "value": value,
                       "cursor": len(value) if cursor is None else cursor,
                       "on_submit": on_submit, "live": live}

    def handle_text(self, text: str) -> bool:
        if self.mode != "text" or not self.prompt:
            return False
        clean = "".join(ch for ch in text if ch.isprintable() and ch not in "\r\n")
        if not clean:
            return False
        p = self.prompt
        p["value"] = p["value"][:p["cursor"]] + clean + p["value"][p["cursor"]:]
        p["cursor"] += len(clean)
        if callable(p.get("live")):
            p["live"](p["value"])
        self._revision += 1
        return True

    def _prompt_key(self, key: str) -> str:
        p = self.prompt
        if p is None:
            self.mode = "normal"
            return "changed"
        if key == "escape":
            live = p.get("live")
            self.mode, self.prompt = "normal", None
            if callable(live):
                live("")
            self._say("cancelled")
            return "changed"
        if key == "enter":
            self.mode, self.prompt = "normal", None
            on_submit = p["on_submit"]
            on_submit(p["value"])
            return "changed"
        if key == "backspace":
            if p["cursor"] > 0:
                p["value"] = p["value"][:p["cursor"] - 1] + p["value"][p["cursor"]:]
                p["cursor"] -= 1
        elif key == "delete":
            p["value"] = p["value"][:p["cursor"]] + p["value"][p["cursor"] + 1:]
        elif key == "left":
            p["cursor"] = max(0, p["cursor"] - 1)
        elif key == "right":
            p["cursor"] = min(len(p["value"]), p["cursor"] + 1)
        elif key == "home":
            p["cursor"] = 0
        elif key == "end":
            p["cursor"] = len(p["value"])
        elif key == "space":
            return "changed" if self.handle_text(" ") else "ignored"
        elif len(key) == 1:
            return "changed" if self.handle_text(key) else "ignored"
        else:
            return "ignored"
        if key in ("backspace", "delete") and callable(p.get("live")):
            p["live"](p["value"])
        return "changed"

    def _confirm_key(self, key: str) -> str:
        c = self.confirm
        self.mode, self.confirm = "normal", None
        if c and key in ("y", "Y", "enter"):
            self._perform(c["on_yes"])
        else:
            self._say("cancelled")
        return "changed"

    # ---------------------------------------------------------------------- keys ----------
    def handle_key(self, key: str, *, now: float | None = None) -> str:
        moment = time.monotonic() if now is None else now
        token = str(key or "")
        if self.mode == "text":
            result = self._prompt_key(token)
        elif self.mode == "confirm":
            result = self._confirm_key(token)
        else:
            result = self._normal_key(token, moment)
        if result == "changed":
            self._revision += 1
        return result

    def _normal_key(self, key: str, now: float) -> str:
        if self.pending:
            prefix, self.pending = self.pending, ""
            if prefix == "g":
                if key == "g":
                    self.cursor = 0; self.preview_scroll = 0
                elif key == "h":
                    self._enter(Path.home())
                elif key == "r":
                    self._enter(self.root)
                else:
                    return "ignored"
                return "changed"
        if self.help:
            if key in ("?", "escape", "q"):
                self.help = False
                return "changed"
            return "ignored"
        page = 8
        if key in ("j", "down"):
            self._move(1)
        elif key in ("k", "up"):
            self._move(-1)
        elif key in ("G", "end"):
            self._move(len(self.listing.entries))
        elif key == "home":
            self._move(-len(self.listing.entries))
        elif key in ("pagedown", "c-f"):
            self._move(page)
        elif key in ("pageup", "c-b"):
            self._move(-page)
        elif key == "c-d":
            self._move(page // 2)
        elif key == "c-u":
            self._move(-(page // 2))
        elif key == "g":
            self.pending = "g"
        elif key in ("h", "left", "backspace"):
            parent = self.cwd.parent
            if parent != self.cwd:
                name = self.cwd.name
                self._enter(parent)
                self._focus_name(name)
        elif key in ("l", "right"):
            entry = self._entry()
            if entry and entry.is_dir:
                self._enter(entry.path)
            elif entry:
                self.inspect = True
        elif key in ("enter", "o"):
            entry = self._entry()
            if entry and entry.is_dir:
                self._enter(entry.path)
            elif entry:
                self._insert_reference(entry.path, mention=True)
        elif key == "c":
            entry = self._entry()
            if entry:
                self._insert_reference(entry.path, mention=False)
        elif key == "H":
            if self.history:
                self.future.append(self.cwd)
                self._enter(self.history.pop(), remember=False)
        elif key == "L":
            if self.future:
                self.history.append(self.cwd)
                self._enter(self.future.pop(), remember=False)
        elif key == "-":
            if self.previous and self.previous != self.cwd:
                self._enter(self.previous)
        elif key == "~":
            self._enter(Path.home())
        elif key == "space":
            entry = self._entry()
            if entry:
                if entry.path in self.selected:
                    self.selected.discard(entry.path)
                else:
                    self.selected.add(entry.path)
                self._move(1)
        elif key == "v":
            if self.visual is None:
                self.visual = self.cursor
                self._apply_visual()
            else:
                self.visual = None
        elif key == "c-a":
            self.selected = {e.path for e in self.listing.entries}
        elif key == "escape":
            if self.selected or self.visual is not None:
                self.selected.clear(); self.visual = None
            elif self.pattern:
                self.pattern = ""; self._rescan()
            elif self.inspect:
                self.inspect = False
            else:
                return "exit"
        elif key == "q":
            return "exit"
        elif key == "?":
            self.help = True
        elif key == "y":
            targets = self._targets()
            if targets:
                self.clipboard = (targets, False)
                self._say(f"copied {len(targets)} · p pastes here", now)
        elif key == "x":
            targets = self._targets()
            if targets:
                self.clipboard = (targets, True)
                self._say(f"cut {len(targets)} · p moves here", now)
        elif key in ("Y", "X"):
            self.clipboard = None
            self._say("clipboard cleared", now)
        elif key in ("p", "P"):
            self._paste(overwrite=(key == "P"))
        elif key == "a":
            self._ask("new (end with / for a folder)", self._create)
        elif key == "r":
            entry = self._entry()
            if entry:
                cursor = len(entry.name) - len(entry.path.suffix) if not entry.is_dir and entry.path.suffix else len(entry.name)
                self._ask("rename", lambda value, src=entry.path: self._rename(src, value),
                          value=entry.name, cursor=cursor)
        elif key == "d":
            targets = self._targets()
            if targets:
                self._guarded("trash", targets, lambda: self.ops.send_to_trash(targets))
        elif key == "D":
            targets = self._targets()
            if targets:
                self._guarded("delete", targets, lambda: self.ops.delete(targets))
        elif key == "u":
            if self._mode() == "plan":
                self._say("read-only in plan mode · /mode to change", now)
            else:
                self._perform(self.ops.undo)
        elif key == ".":
            self.show_hidden = not self.show_hidden
            self._rescan()
        elif key == "s":
            self.sort = SORTS[(SORTS.index(self.sort) + 1) % len(SORTS)]
            self._rescan()
        elif key == "S":
            self.reverse = not self.reverse
            self._rescan()
        elif key == "f":
            def live(value):
                self.pattern = value
                self._rescan()
                self.cursor = 0
            self._ask("filter", lambda value: None, value=self.pattern, live=live)
        elif key == "/":
            self._ask("find", self._find)
        elif key == "n":
            self._find_step(1)
        elif key == "N":
            self._find_step(-1)
        elif key in ("i", "tab"):
            self.inspect = not self.inspect
        elif key == "J":
            self.preview_scroll += 5
        elif key == "K":
            self.preview_scroll = max(0, self.preview_scroll - 5)
        else:
            return "ignored"
        return "changed"

    # ---------------------------------------------------------------------- actions -------
    def _insert_reference(self, path: Path, *, mention: bool) -> None:
        try:
            text = str(path.relative_to(self.root)) if is_within(path, self.root) else str(path)
        except ValueError:
            text = str(path)
        if mention:
            text = f'@"{text}"' if any(ch.isspace() for ch in text) else f"@{text}"
        insert = getattr(self.host, "insert_reference", None)
        if callable(insert):
            insert(text + " ")
            self._say(f"inserted {text}")

    def _create(self, value: str) -> None:
        if not value.strip():
            return
        self._guarded("create", [self.cwd / value.strip().rstrip("/")], lambda: self.ops.create(self.cwd, value))
        if self.mode == "normal":
            self._focus_name(value.strip().rstrip("/").split("/")[0])

    def _rename(self, src: Path, value: str) -> None:
        if not value.strip() or value.strip() == src.name:
            return
        self._guarded("rename", [src, src.with_name(value.strip())], lambda: self.ops.rename(src, value))
        if self.mode == "normal":
            self._focus_name(value.strip())

    def _paste(self, *, overwrite: bool) -> None:
        if not self.clipboard:
            self._say("nothing to paste · y copies, x cuts")
            return
        paths, cut = self.clipboard
        existing = [p for p in paths if p.exists() or p.is_symlink()]
        if not existing:
            self.clipboard = None
            self._say("clipboard items are gone")
            return
        collisions = [p for p in existing if (self.cwd / p.name).exists() and (self.cwd / p.name) != p]
        action = "overwrite" if (overwrite and collisions) else ("move" if cut else "copy")

        def run():
            if cut:
                result = self.ops.move(existing, self.cwd, overwrite=overwrite)
                self.clipboard = None
                return result
            return self.ops.copy(existing, self.cwd, overwrite=overwrite)
        self._guarded(action, existing, run, dest=self.cwd)

    def _find(self, value: str) -> None:
        self.find_query = value.strip()
        if self.find_query:
            self._find_step(1, include_current=True)

    def _find_step(self, direction: int, *, include_current: bool = False) -> None:
        if not self.find_query or not self.listing.entries:
            return
        count = len(self.listing.entries)
        start = self.cursor if include_current else self.cursor + direction
        for offset in range(count):
            index = (start + direction * offset) % count
            if matches_filter(self.listing.entries[index].name, self.find_query):
                self.cursor = index
                self.preview_scroll = 0
                return
        self._say(f"no match for {self.find_query}")

    # ---------------------------------------------------------------------- clock ---------
    def advance(self, *, now: float | None = None) -> int:
        moment = time.monotonic() if now is None else now
        changed = False
        if self.status and moment >= self.status_until:
            self.status = ""
            changed = True
        if moment - self._last_poll >= POLL_S:
            self._last_poll = moment
            version = directory_version(self.cwd)
            if version and self.listing.version[:2] != version:
                self._rescan()
                changed = True
            fresh = self._changed_paths()
            if fresh != self._changed:
                self._changed = fresh
                changed = True
        if changed:
            self._revision += 1
        return self._revision

    def _changed_paths(self) -> set[str]:
        provider = getattr(self.host, "changed_paths", None)
        if not callable(provider):
            return set()
        try:
            return {str(p) for p in provider()}
        except Exception:
            return set()

    # ---------------------------------------------------------------------- frame ---------
    def snapshot(self, width: int, height: int) -> PaneFrame:
        width, height = max(20, int(width)), max(2, int(height))
        rows: list[tuple[Segment, ...]] = [self._crumb_row(width)]
        body_height = height - 1 - (1 if self.mode in ("text", "confirm") else 0)
        if self.help:
            rows.extend(self._help_rows(width, body_height))
        else:
            rows.extend(self._column_rows(width, body_height))
        if self.mode == "text" and self.prompt:
            p = self.prompt
            value = p["value"]
            shown = value[:p["cursor"]] + "▏" + value[p["cursor"]:]
            rows.append((Segment(f" {p['label']}: ", "file-prompt-label"), Segment(shown, "file-prompt")))
        elif self.mode == "confirm" and self.confirm:
            rows.append((Segment(f" {self.confirm['message']}  y / N", "file-confirm"),))
        count = len(self.listing.entries)
        score = f"{count} item{'s' if count != 1 else ''}"
        if self.selected:
            score += f" · {len(self.selected)} sel"
        if self.clipboard:
            score += f" · {'cut' if self.clipboard[1] else 'copy'} {len(self.clipboard[0])}"
        if self.mode == "text":
            footer = "Enter confirm · Esc cancel"
        elif self.mode == "confirm":
            footer = "y yes · n no"
        elif self.help:
            footer = "? or Esc closes this"
        else:
            footer = ("j/k move · h/l dirs · Space select · y/x/p copy·cut·paste · a new · r rename"
                      " · d trash · u undo · Enter @path · ? keys · q return")
        return PaneFrame(title="FILES", score=score, lines=tuple(rows[:height]),
                         footer=footer, status=self.status)

    def _crumb_row(self, width: int) -> tuple[Segment, ...]:
        crumb = " " + _tilde(self.cwd)
        meta_parts = [self.sort + ("↓" if self.reverse else "")]
        if self.show_hidden:
            meta_parts.append("hidden")
        if self.pattern:
            meta_parts.append(f"filter {self.pattern}")
        if self.listing.truncated:
            meta_parts.append("truncated")
        if self.listing.error:
            meta_parts.append(self.listing.error)
        if not is_within(self.cwd, self.root):
            meta_parts.append("outside project · read-only" if self._mode() != "auto" else "outside project")
        meta = " · ".join(meta_parts) + " "
        room = max(0, width - len(meta))
        if len(crumb) > room:
            crumb = "…" + crumb[-(room - 1):] if room > 1 else ""
        gap = " " * max(0, width - len(crumb) - len(meta))
        return (Segment(crumb, "file-crumb"), Segment(gap, "text"), Segment(meta, "file-crumb-dim"))

    def _layout(self, width: int) -> tuple[int, int, int]:
        """Column widths (parent, current, preview); zero means the column is hidden."""
        if width >= 72:
            parent = max(12, min(28, width * 22 // 100))
            preview = max(20, width * 42 // 100)
            current = width - parent - preview - 2
            return parent, current, preview
        if width >= 48:
            preview = max(18, width * 45 // 100)
            return 0, width - preview - 1, preview
        return 0, width, 0

    def _column_rows(self, width: int, height: int) -> list[tuple[Segment, ...]]:
        parent_w, current_w, preview_w = self._layout(width)
        rows: list[tuple[Segment, ...]] = []
        parent_rows = self._parent_rows(parent_w, height) if parent_w else []
        current_rows = self._current_rows(current_w, height)
        preview_rows = self._preview_rows(preview_w, height) if preview_w else []
        for index in range(height):
            segments: list[Segment] = []
            if parent_w:
                segments.extend(parent_rows[index] if index < len(parent_rows) else (Segment(" " * parent_w, "text"),))
                segments.append(Segment("│", "file-rule"))
            segments.extend(current_rows[index] if index < len(current_rows) else (Segment(" " * current_w, "text"),))
            if preview_w:
                segments.append(Segment("│", "file-rule"))
                segments.extend(preview_rows[index] if index < len(preview_rows) else ())
            rows.append(tuple(segments))
        return rows

    def _parent_rows(self, width: int, height: int) -> list[tuple[Segment, ...]]:
        parent = self.cwd.parent
        if parent == self.cwd:
            return [(Segment(" /".ljust(width), "file-crumb-dim"),)]
        listing = scan(parent, show_hidden=self.show_hidden, sort=self.sort, reverse=self.reverse, maximum=800)
        names = listing.entries
        focus = next((i for i, e in enumerate(names) if e.name == self.cwd.name), 0)
        start = max(0, min(focus - height // 2, len(names) - height))
        rows = []
        for entry in names[start:start + height]:
            label = (" " + entry.name + ("/" if entry.is_dir else ""))[:width].ljust(width)
            role = "file-selected" if entry.name == self.cwd.name else ("file-dir" if entry.is_dir else "file-dim")
            rows.append((Segment(label, role),))
        return rows

    def _current_rows(self, width: int, height: int) -> list[tuple[Segment, ...]]:
        entries = self.listing.entries
        if not entries:
            message = self.listing.error or ("no matches" if self.pattern else "empty folder")
            return [(Segment((" " + message)[:width].ljust(width), "file-dim"),)]
        if self.cursor < self.scroll:
            self.scroll = self.cursor
        elif self.cursor >= self.scroll + height:
            self.scroll = self.cursor - height + 1
        self.scroll = max(0, min(self.scroll, max(0, len(entries) - height)))
        statuses = self.git.statuses(self.cwd)
        rows = []
        for index in range(self.scroll, min(len(entries), self.scroll + height)):
            entry = entries[index]
            is_cursor = index == self.cursor
            is_selected = entry.path in self.selected
            changed = str(entry.path) in self._changed
            git = statuses.get(entry.name, "")
            tail = ""
            if git:
                tail += {"m": "M", "a": "A", "d": "D", "u": "?"}.get(git, "") + " "
            tail += ("/" if entry.is_dir else human_size(entry.size) if entry.kind == "file"
                     else "→" if entry.kind == "link" else "")
            mark = "✎ " if changed else "  "
            room = max(1, width - len(mark) - len(tail) - 1)
            name = entry.name
            if len(name) > room:
                name = name[:max(1, room - 1)] + "…"
            body = f"{mark}{name.ljust(room)}{tail} "
            if is_cursor and is_selected:
                role = "file-cursor-selected"
            elif is_cursor:
                role = "file-cursor-dir" if entry.is_dir else "file-cursor"
            elif is_selected:
                role = "file-selected"
            elif entry.is_dir:
                role = "file-dir"
            elif entry.kind == "link":
                role = "file-link"
            elif entry.hidden:
                role = "file-dim"
            else:
                role = "file-name"
            if is_cursor or is_selected or not (changed or git):
                rows.append((Segment(body[:width].ljust(width), role),))
            else:
                rows.append((Segment(mark, "file-mark" if changed else role),
                             Segment(name.ljust(room), role),
                             Segment(tail + " ", f"file-git-{git}" if git else "file-meta")))
        return rows

    def _preview_rows(self, width: int, height: int) -> list[tuple[Segment, ...]]:
        entry = self._entry()
        if entry is None:
            return []
        inner = max(1, width - 1)
        if self.inspect:
            pairs = self._inspect_rows(entry)
            return [(Segment((" " + text)[:inner].ljust(inner), role),) for role, text in pairs[:height]]
        if entry.is_dir:
            listing = scan(entry.path, show_hidden=self.show_hidden, sort=self.sort, maximum=400)
            pairs = directory_preview(listing.entries, height, count=listing.total)
        elif entry.kind == "file":
            pairs = text_preview(entry.path, inner - 1, height + self.preview_scroll)[self.preview_scroll:]
        elif entry.kind == "link":
            try:
                target = os.readlink(entry.path)
            except OSError:
                target = "?"
            pairs = [("file-preview-dim", f"→ {target}")]
        else:
            pairs = [("file-preview-dim", "special file")]
        return [(Segment((" " + text)[:inner].ljust(inner), role),) for role, text in pairs[:height]]

    def _inspect_rows(self, entry: Entry) -> list[tuple[str, str]]:
        rows = [("file-crumb", entry.name)]
        try:
            info = os.lstat(entry.path)
            rows.append(("file-meta", f"kind    {entry.kind}"))
            if entry.kind == "file":
                rows.append(("file-meta", f"size    {human_size(info.st_size)} ({info.st_size:,} B)"))
            rows.append(("file-meta", "modified " + time.strftime("%Y-%m-%d %H:%M", time.localtime(info.st_mtime))))
            rows.append(("file-meta", f"mode    {stat.filemode(info.st_mode)}"))
            if entry.kind == "link":
                rows.append(("file-meta", f"target  {os.readlink(entry.path)}"))
        except OSError as exc:
            rows.append(("file-preview-dim", f"cannot stat: {exc.strerror or exc}"))
        git = self.git.statuses(self.cwd).get(entry.name)
        if git:
            rows.append(("file-meta", "git     " + {"m": "modified", "a": "added", "d": "deleted", "u": "untracked"}.get(git, git)))
        if str(entry.path) in self._changed:
            rows.append(("file-mark", "✎ changed by DGC this turn"))
        rows.append(("file-preview-dim", "Tab returns to the preview"))
        return rows

    def _help_rows(self, width: int, height: int) -> list[tuple[Segment, ...]]:
        half = max(10, width // 2)
        rows = []
        for left_key, left_desc, right_key, right_desc in HELP_ROWS[:height]:
            left = f" {left_key:<20} {left_desc}"[:half].ljust(half)
            right = f" {right_key:<14} {right_desc}"[:max(0, width - half)].ljust(max(0, width - half))
            rows.append((Segment(left, "file-meta"), Segment(right, "file-meta")))
        return rows
