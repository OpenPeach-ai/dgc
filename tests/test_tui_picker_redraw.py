"""The full-screen terminal keeps the conversation drawn around a picker, with no key pressed in between.

A picker or modal above the composer (/resume, the Open here choices of a session another DGC holds) makes the
transcript shorter. The transcript scrolled with the height of the frame before, so in the frame the picker opened
it scrolled to its own empty last line and drew nothing, and it stayed blank until a key drew another frame.

These run the real `python -m dgc` in a pseudo-terminal, with a fresh HOME and saved sessions, and read the screen
it draws through a small terminal emulator: the rows above the picker must hold the conversation in the frames the
picker opens and closes in.
"""
import codecs
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COLS, ROWS = 100, 30
LAST_GST = "GST-QUOTE-MARKER"              # the last answer of the newest saved session
LAST_INVOICE = "INVOICE-TOTALS-MARKER"     # ...and of the older one


class _Screen:
    """Enough of a VT100 for what prompt_toolkit's full-screen renderer writes: cursor moves, erases, text."""

    def __init__(self, cols: int, rows: int, answer=None):
        self.cols, self.rows = cols, rows
        self.grid = [[" "] * cols for _ in range(rows)]
        self.r = self.c = 0
        self.saved = (0, 0)
        self.answer = answer                 # writes a reply to the program (a cursor position report)
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.state, self.seq = "text", ""
        from prompt_toolkit.utils import get_cwidth
        self.width = get_cwidth

    def lines(self) -> list[str]:
        return ["".join(row) for row in self.grid]

    def text(self) -> str:
        return "\n".join(self.lines())

    def feed(self, data: bytes) -> None:
        for ch in self.decoder.decode(data):
            self._char(ch)

    def _clear(self, r0, c0, r1, c1) -> None:
        for r in range(r0, r1 + 1):
            for c in range(c0 if r == r0 else 0, (c1 if r == r1 else self.cols - 1) + 1):
                self.grid[r][c] = " "

    def _newline(self) -> None:
        if self.r == self.rows - 1:
            self.grid.pop(0)
            self.grid.append([" "] * self.cols)
        else:
            self.r += 1

    def _char(self, ch: str) -> None:
        if self.state == "esc":
            self.state = "text"
            if ch == "[":
                self.state, self.seq = "csi", ""
            elif ch in "]P_^":
                self.state = "string"
            elif ch in "()*+":
                self.state = "charset"
            elif ch == "7":
                self.saved = (self.r, self.c)
            elif ch == "8":
                self.r, self.c = self.saved
            elif ch == "M":
                self.r = max(0, self.r - 1)
            return
        if self.state == "charset":
            self.state = "text"
            return
        if self.state == "string":                   # OSC/DCS: up to BEL or ESC \
            if ch == "\x07":
                self.state = "text"
            elif ch == "\x1b":
                self.state = "string-esc"
            return
        if self.state == "string-esc":
            self.state = "text" if ch == "\\" else "string"
            return
        if self.state == "csi":
            if "\x40" <= ch <= "\x7e":
                self.state = "text"
                self._csi(self.seq, ch)
            else:
                self.seq += ch
            return
        if ch == "\x1b":
            self.state = "esc"
        elif ch == "\r":
            self.c = 0
        elif ch == "\n":
            self._newline()
        elif ch == "\b":
            self.c = max(0, self.c - 1)
        elif ch == "\t":
            self.c = min(self.cols - 1, (self.c // 8 + 1) * 8)
        elif ch < " " or ch == "\x7f":
            return
        else:
            w = self.width(ch)
            if w <= 0:
                return
            if self.c + w > self.cols:
                self.c = self.cols - w
            self.grid[self.r][self.c] = ch
            if w == 2:
                self.grid[self.r][self.c + 1] = ""
            self.c = min(self.cols - 1, self.c + w)     # the renderer turns autowrap off: no wrap

    def _csi(self, seq: str, final: str) -> None:
        if seq.startswith("?"):
            if seq[1:] in ("1049", "47", "1047") and final in "hl":
                self.grid = [[" "] * self.cols for _ in range(self.rows)]
            return
        if seq and not seq[0].isdigit() and seq[0] != ";":
            return                                   # other private forms (">", "=", " q" cursor shape)
        try:
            nums = [int(p) if p else 0 for p in seq.rstrip(" ").split(";")] if seq.strip(" ") else []
        except ValueError:
            return
        n = (nums[0] if nums else 0) or 1
        if final == "A":
            self.r = max(0, self.r - n)
        elif final == "B":
            self.r = min(self.rows - 1, self.r + n)
        elif final == "C":
            self.c = min(self.cols - 1, self.c + n)
        elif final == "D":
            self.c = max(0, self.c - n)
        elif final == "E":
            self.r, self.c = min(self.rows - 1, self.r + n), 0
        elif final == "F":
            self.r, self.c = max(0, self.r - n), 0
        elif final == "G":
            self.c = min(self.cols - 1, n - 1)
        elif final == "d":
            self.r = min(self.rows - 1, n - 1)
        elif final in "Hf":
            row = (nums[0] if nums else 1) or 1
            col = (nums[1] if len(nums) > 1 else 1) or 1
            self.r, self.c = min(self.rows - 1, row - 1), min(self.cols - 1, col - 1)
        elif final == "J":
            mode = nums[0] if nums else 0
            if mode == 0:
                self._clear(self.r, self.c, self.rows - 1, self.cols - 1)
            elif mode == 1:
                self._clear(0, 0, self.r, self.c)
            else:
                self._clear(0, 0, self.rows - 1, self.cols - 1)
        elif final == "K":
            mode = nums[0] if nums else 0
            start, end = {0: (self.c, self.cols - 1), 1: (0, self.c)}.get(mode, (0, self.cols - 1))
            for c in range(start, end + 1):
                self.grid[self.r][c] = " "
        elif final == "n" and nums[:1] == [6] and self.answer:
            self.answer(f"\x1b[{self.r + 1};{self.c + 1}R".encode())


class _Dgc:
    """A real `python -m dgc` in a pseudo-terminal of its own, and the screen it draws."""

    def __init__(self, test, home: Path, project: Path, *args: str):
        import fcntl
        import pty
        import struct
        import termios
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        env = {"HOME": str(home), "PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
               "PYTHONUTF8": "1", "TERM": "xterm-256color", "COLORTERM": "truecolor", "PYTHONPATH": str(ROOT),
               "PYTHONUNBUFFERED": "1"}
        self.proc = subprocess.Popen([sys.executable, "-m", "dgc", *args], stdin=slave, stdout=slave, stderr=slave,
                                     cwd=project, env=env, start_new_session=True)
        os.close(slave)
        self.fd = master
        self.screen = _Screen(COLS, ROWS, answer=lambda b: os.write(self.fd, b))
        self.open = True
        self.others: list[_Dgc] = []         # other DGCs of the test, read too so none blocks on a full terminal
        test.addCleanup(self.close)

    def pump(self, secs: float) -> None:
        import select
        end = time.monotonic() + secs
        while True:
            left = end - time.monotonic()
            if left <= 0:
                return
            terms = {t.fd: t for t in [self, *self.others] if t.open}
            if not terms:
                return
            for fd in select.select(list(terms), [], [], min(left, 0.05))[0]:
                term = terms[fd]
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    term.open = False
                    continue
                term.screen.feed(chunk)

    def wait_for(self, check, secs: float, what: str):
        end = time.monotonic() + secs
        while time.monotonic() < end:
            self.pump(0.1)
            if check(self.screen):
                return
        raise AssertionError(f"timed out waiting for {what}; the screen was:\n{self.screen.text()}")

    def keys(self, data: str, settle: float = 0.3) -> None:
        os.write(self.fd, data.encode())
        self.pump(settle)

    def close(self) -> None:
        self.open = False
        if self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                self.proc.wait(timeout=10)
        try:
            os.close(self.fd)
        except OSError:
            pass


def _row_of(screen: _Screen, text: str) -> int:
    for i, line in enumerate(screen.lines()):
        if text in line:
            return i
    return -1


def _above(marker: str, title: str):
    """The marker is on screen, on a row above the picker's title (the transcript, not the picker)."""
    def check(screen: _Screen) -> bool:
        m, t = _row_of(screen, marker), _row_of(screen, title)
        return 0 <= m < t
    return check


def _shown(marker: str, gone: str = ""):
    def check(screen: _Screen) -> bool:
        return _row_of(screen, marker) >= 0 and (not gone or _row_of(screen, gone) < 0)
    return check


SEED = r"""
import json, sys
from pathlib import Path
from dgc import sessions
root = Path(sys.argv[1])

def chat(topic, last):
    messages = [{"role": "system", "content": "sys"}]
    for i in range(1, 13):
        messages.append({"role": "user", "content": f"{topic}: step {i}"})
        messages.append({"role": "assistant", "content": f"Step {i} of {topic} is done.\n\n- checked the totals\n- ran the tests"})
    messages += [{"role": "user", "content": topic}, {"role": "assistant", "content": last}]
    return messages

sessions.save(sessions.new_path(root), chat("Rename the invoice totals column",
              "Renamed the INVOICE-TOTALS-MARKER column in reports/invoices.py."), root, name="invoice column")
sessions.save(sessions.new_path(root), chat("Add a GST line to the quote PDF",
              "Added the GST-QUOTE-MARKER line under the subtotal in quotes/pdf.py."), root, name="gst on quotes")
"""


@unittest.skipUnless(os.name == "posix", "drives the real terminal through a POSIX pseudo-terminal")
class PickerKeepsTheTranscriptDrawnTests(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        home = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-picker-redraw-")))
        self.addCleanup(shutil.rmtree, home, True)
        project = home / "toni-erp"
        (home / ".dgc").mkdir(parents=True)
        project.mkdir()
        (project / "README.md").write_text("# Toni ERP\n")
        (home / ".gitconfig").write_text("[user]\n\tname = DGC Tests\n\temail = tests@dgc.invalid\n")
        genv = {"HOME": str(home), "PATH": os.environ.get("PATH", "/usr/bin:/bin")}
        for args in (["init", "-q"], ["add", "-A"], ["commit", "-qm", "baseline"]):
            subprocess.run(["git", *args], cwd=project, env=genv, check=True, capture_output=True)
        (home / ".dgc" / "config.json").write_text(json.dumps({
            "model": "fixture-model", "base_url": "http://127.0.0.1:9/v1", "mode": "auto", "thinking": "off",
            "context_size": 32768, "trusted_dirs": [str(project)], "suggest": False, "notes": False,
            "logo_animation": False}))
        subprocess.run([sys.executable, "-c", SEED, str(project)], cwd=project, check=True, capture_output=True,
                       env={**genv, "PYTHONPATH": str(ROOT)})
        self.home, self.project = home, project

    def dgc(self, *args: str) -> _Dgc:
        return _Dgc(self, self.home, self.project, *args)

    def test_resume_picker_keeps_the_conversation_drawn_when_it_opens_and_closes(self):
        t = self.dgc("-c")
        t.wait_for(_shown(LAST_GST), 60, "the continued conversation")
        t.pump(1.0)
        t.keys("/", 0.6)
        t.keys("resume", 0.6)
        t.keys("\r", 0.05)
        t.wait_for(_shown("Resume a session"), 30, "the /resume picker")
        # No key from here: the frame the picker opened in holds the conversation above it.
        t.wait_for(_above(LAST_GST, "Resume a session"), 3, "the conversation above the open picker")
        t.keys("\x1b[B", 0.4)
        t.keys("\r", 0.05)                                  # the other session, chosen
        t.wait_for(_shown(LAST_INVOICE, gone="Resume a session"), 15, "the chosen conversation, drawn")
        t.keys("/", 0.6)
        t.keys("resume", 0.6)
        t.keys("\r", 0.05)
        t.wait_for(_above(LAST_INVOICE, "Resume a session"), 30, "the picker again, over the conversation")
        t.keys("\x1b", 0.05)                                # cancelled
        t.wait_for(_shown(LAST_INVOICE, gone="Resume a session"), 15, "the conversation after Esc")

    def test_closing_a_modal_into_the_menu_it_came_from_keeps_the_conversation_drawn(self):
        t = self.dgc("-c")
        t.wait_for(_shown(LAST_GST), 60, "the continued conversation")
        t.pump(1.0)
        t.keys("/", 0.6)
        t.keys("settings", 0.6)
        t.keys("\r", 0.05)
        t.wait_for(_shown("Model & sampling"), 30, "Settings")
        t.keys("\x1b[B", 0.4)                               # a key: Settings drawn a second time
        t.wait_for(_above(LAST_GST, "Model & sampling"), 3, "the conversation above Settings")
        t.keys("\x1b", 0.05)                                # closed: Esc steps back to the taller / menu
        t.wait_for(_shown("list available commands", gone="Model & sampling"), 15, "the / menu again")
        t.wait_for(_above(LAST_GST, "list available commands"), 3, "the conversation above the / menu")
        t.keys("\x1b", 0.05)
        t.wait_for(_shown(LAST_GST, gone="list available commands"), 15, "the conversation, the menu closed")

    def test_open_here_choices_keep_the_conversation_drawn(self):
        holder = self.dgc("-c")
        holder.wait_for(_shown("resumed here"), 60, "the DGC that holds the session")
        holder.pump(1.0)
        t = self.dgc("-c")
        t.others.append(holder)
        title = "This session is open elsewhere"
        t.wait_for(_shown(title), 60, "the Open here choices")
        t.wait_for(_above(LAST_GST, title), 3, "the conversation above the choices")
        t.keys("\x1b", 0.05)
        t.wait_for(_shown(LAST_GST, gone=title), 15, "the conversation after Esc")
        t.pump(0.5)
        t.keys("Add the GST line to the quote PDF as well, under the subtotal, and make the invoice totals agree",
               0.6)
        t.keys("\r", 0.05)                                  # a prompt for a session another DGC holds
        t.wait_for(_shown(title), 30, "the choices again")
        t.wait_for(_above(LAST_GST, title), 3, "the conversation above the choices a prompt brought back")
        t.keys("\x1b[A", 0.4)
        t.keys("\r", 0.05)                                  # Open here
        t.wait_for(lambda s: "this session is in this terminal now" in s.text(), 45, "Open here to take it")
        t.wait_for(_shown(LAST_GST, gone=title), 5, "the conversation after Open here")


if __name__ == "__main__":
    unittest.main()
