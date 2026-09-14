"""Model-viewed images: vision availability, the image-rejection downgrade, the private image store,
view_image, MCP images, headless frames, get_image and history replay."""
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from dgc.agent import Agent
from dgc.config import Config, DEFAULTS
from dgc.llm import LLMClient
from dgc.tools import _vision_available


def fixture_config(root: Path) -> Config:
    config = object.__new__(Config)
    config.project_root, config.project_dir, config._persist = root, root / ".dgc", False
    config.data = copy.deepcopy(DEFAULTS)
    config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="default",
                       hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False)
    config._stored_secrets, config._env_secret_keys, config._explicit_keys = {}, set(), set()
    config.credential_warnings = ()
    config.permissions = {"allow": [], "ask": [], "deny": []}
    return config


class QuietUI:
    def __getattr__(self, name):
        return lambda *args, **kwargs: None


def fake_client(vision: bool) -> LLMClient:
    """A real client object whose vision answer is pinned (no network is ever touched)."""
    class _Client(LLMClient):
        vision_supported = vision
    return _Client("http://localhost.invalid/v1", "", "fixture")


class VisionAtInitTests(unittest.TestCase):
    def test_vision_is_available_right_after_init(self):
        with tempfile.TemporaryDirectory(prefix="dgc-images-init-") as directory:
            with patch.object(Agent, "_new_client", lambda self, *args, **kwargs: fake_client(True)):
                agent = Agent(fixture_config(Path(directory)), QuietUI())
            try:
                self.assertTrue(_vision_available(agent.ctx))
            finally:
                agent.mcp.stop_all()


if __name__ == "__main__":
    unittest.main()
