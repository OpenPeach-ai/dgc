"""Settings -> Models: the prompt-cache lifetime and how long a local Ollama keeps the model loaded.

`prompt_cache_ttl` (0.48) is how long an Anthropic cache entry lives: "5m" or "1h". `ollama_keep_alive`
was config/TUI only. Both now round-trip through the editor: the backend sends them in a NEW event,
`cache_settings`, to an editor whose get_config `fields` named it (a published SDK refuses a new
field on an existing event, so they never ride on `config`), and set_config takes and validates them.
"""
import io
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


def _real_account_home() -> Path:
    try:
        import pwd
        return Path(pwd.getpwuid(os.getuid()).pw_dir).resolve(strict=False)
    except (ImportError, KeyError, AttributeError):
        return Path(os.path.expanduser("~")).resolve(strict=False)


if "dgc.config" in sys.modules:
    _user_home = Path(sys.modules["dgc.config"].USER_HOME).resolve(strict=False)
    _account_home = _real_account_home()
    if _user_home == _account_home or _account_home in _user_home.parents:
        raise RuntimeError("tests/test_cache_settings.py needs HOME redirected before dgc is imported")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-cache-settings-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import config as config_module  # noqa: E402
from dgc import editor_protocol as ep  # noqa: E402
from dgc import headless, sessions  # noqa: E402
from dgc.config import DEFAULTS, Config  # noqa: E402
from dgc.llm import LLMClient  # noqa: E402
from fake_providers import FakeProviders  # noqa: E402


class PagesFromOtherDevices(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-cache-settings-")).resolve()
        self.user = tmp / "user-dgc"
        self.user.mkdir()
        for name, value in (("USER_HOME", self.user), ("USER_CONFIG", self.user / "config.json"),
                            ("USER_SECRETS", self.user / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        (self.user / "config.json").write_text(json.dumps({
            "model": "qwen3.8:27b", "base_url": "http://localhost.invalid:11434/v1", "suggest": False,
            "artifact_autostart": False, "mcp_servers": {}}))
        scoped = patch.object(sessions, "SESSIONS_DIR", tmp / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        (tmp / "a" / ".git").mkdir(parents=True)
        self.wire = io.StringIO()
        self.host = headless.Host(Config(project_root=tmp / "a"))
        self.host.core.fp = self.wire
        self.addCleanup(lambda: [chat.agent.mcp.stop_all() for chat in list(self.host.chats.values())])

    def frames(self):
        return [json.loads(line) for line in self.wire.getvalue().splitlines()]

    def last(self, kind, timeout=10.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            found = [f for f in self.frames() if f["type"] == kind]
            if found:
                return found[-1]
            time.sleep(0.02)
        self.fail(f"no {kind} frame: {self.frames()[-3:]}")

    """Settings -> Security -> Previews: whether pages open from other devices (your network and Tailscale) and the
    address links use (his 21 Nov question: the CLI had it, the extension didn't)."""

    def test_settings_reads_and_saves_where_pages_open_from(self):
        self.host.dispatch({"type": "get_config", "request_id": "c0"})
        self.assertNotIn("artifact_bind", self.last("config"), "an editor that didn't ask never sees them")
        self.host.dispatch({"type": "get_config", "request_id": "c1", "fields": ["artifact_bind", "artifact_hostname"]})
        got = self.last("config")
        self.assertEqual((got["artifact_bind"], got["artifact_hostname"]), ("localhost", ""))
        self.assertIsNone(ep.event_error(got))
        self.host.dispatch({"type": "set_config", "request_id": "s1",
                            "values": {"artifact_bind": "lan", "artifact_hostname": "gb10.tail1234.ts.net"}})
        self.assertEqual([f for f in self.frames() if f["type"] == "command_rejected"], [])
        saved = json.loads((self.user / "config.json").read_text())
        self.assertEqual((saved["artifact_bind"], saved["artifact_hostname"]), ("lan", "gb10.tail1234.ts.net"))
        self.host.dispatch({"type": "set_config", "request_id": "s2", "values": {"artifact_bind": "everywhere"}})
        self.assertTrue([f for f in self.frames() if f["type"] == "command_rejected" and f.get("request_id") == "s2"])


if __name__ == "__main__":
    unittest.main()
