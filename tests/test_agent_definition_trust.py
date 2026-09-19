"""Project agent definitions must not route requests or credentials before directory trust."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from dgc import agents
from dgc.agent import Agent
from dgc.config import Config
from dgc.trust import mark_trusted, revoke_trust
from test_subagents import Harness, clone_fixture


class AgentDefinitionTrustTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-agent-trust-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.project = self.root / "project"
        self.definitions = self.project / ".dgc" / "agents"
        self.definitions.mkdir(parents=True)
        self.personal = self.root / "personal"
        self.personal.mkdir()
        patcher = patch.object(agents, "USER_AGENTS", self.personal)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_definition(self, directory, body, *, endpoint="", key=""):
        (directory / "reviewer.md").write_text(
            "---\nname: reviewer\nmodel: fixture\napi_mode: chat_completions\n"
            f"base_url: {endpoint}\napi_key_env: {key}\n---\n{body}\n")

    def test_untrusted_project_cannot_shadow_personal_or_load_without_config(self):
        self.write_definition(self.personal, "Personal reviewer")
        self.write_definition(self.definitions, "Project reviewer", endpoint="https://example.invalid")
        config = SimpleNamespace(data={"trusted_dirs": []})
        for kwargs in ({}, {"config": config}):
            self.assertEqual(agents.discover_agents(self.project, **kwargs)["reviewer"].body,
                             "Personal reviewer")
        config.data["trusted_dirs"] = [str(self.project)]
        self.assertEqual(agents.discover_agents(self.project, config=config)["reviewer"].body,
                         "Project reviewer")

    def test_trust_is_canonical_and_does_not_cover_a_similarly_named_sibling(self):
        self.write_definition(self.definitions, "Project reviewer")
        config = SimpleNamespace(data={"trusted_dirs": [str(self.root / "pro")]})
        self.assertNotIn("reviewer", agents.discover_agents(self.project, config=config))
        alias = self.root / "alias"
        alias.symlink_to(self.project, target_is_directory=True)
        config.data["trusted_dirs"] = [str(alias)]
        self.assertIn("reviewer", agents.discover_agents(self.project, config=config))

    def test_existing_agent_refreshes_when_trust_is_granted_or_revoked(self):
        self.write_definition(self.definitions, "Project reviewer")
        h = Harness(self.project)
        self.addCleanup(h.close)
        self.assertNotIn("reviewer", h.agent.agent_defs)
        mark_trusted(h.config, self.project)
        self.assertIn("reviewer", h.agent.agent_defs)
        revoke_trust(h.config, self.project)
        self.assertNotIn("reviewer", h.agent.agent_defs)

    def endpoint(self, label):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                payload = json.dumps({"data": [{"id": "fixture"}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                requests.append((self.headers.get("Authorization", ""), json.loads(body)))
                chunk = {"id": "fixture", "object": "chat.completion.chunk", "model": "fixture",
                         "choices": [{"index": 0, "delta": {"content": label}, "finish_reason": "stop"}]}
                payload = ("data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n").encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()

        def close():
            server.shutdown()
            server.server_close()
            worker.join(5)
        self.addCleanup(close)
        return f"http://127.0.0.1:{server.server_port}/v1", requests

    def test_real_subagent_http_cannot_use_project_route_or_env_key_before_trust(self):
        main_url, main_requests = self.endpoint("Main route replied.")
        project_url, project_requests = self.endpoint("Project route replied.")
        self.write_definition(self.definitions, "Project-only persona", endpoint=project_url,
                              key="DGC_AGENT_TRUST_TEST_KEY")
        h = Harness(self.project, base_url=main_url, api_mode="chat_completions", mode="default")
        self.addCleanup(h.close)
        with patch.object(Config, "clone_for_root", clone_fixture), \
                patch.dict("os.environ", {"DGC_AGENT_TRUST_TEST_KEY": "synthetic-agent-key"}):
            result = h.agent._run_subagent("reply", "Reply with a brief greeting.", "reviewer", "first")
            self.assertIn("Main route replied", result)
            self.assertTrue(main_requests)
            self.assertEqual(project_requests, [])
            self.assertNotIn("synthetic-agent-key", json.dumps(main_requests))
            self.assertNotIn("Project-only persona", json.dumps(main_requests))

            mark_trusted(h.config, self.project)
            result = h.agent._run_subagent("reply", "Reply with a brief greeting.", "reviewer", "second")
            self.assertIn("Project route replied", result)
            self.assertTrue(project_requests)
            self.assertEqual(project_requests[-1][0], "Bearer synthetic-agent-key")
            self.assertIn("Project-only persona", json.dumps(project_requests[-1][1]))

    def test_session_policy_strips_project_agent_route_even_after_trust(self):
        # An SDK session (a DGC_SESSION_POLICY is present) never lets a workspace agent definition
        # choose an endpoint or credential, even a trusted one that shadows a built-in.
        from dgc import permissions as perms_mod
        main_url, main_requests = self.endpoint("Main route replied.")
        project_url, project_requests = self.endpoint("Project route replied.")
        self.write_definition(self.definitions, "Project-only persona", endpoint=project_url,
                              key="DGC_AGENT_TRUST_TEST_KEY")
        h = Harness(self.project, base_url=main_url, api_mode="chat_completions", mode="default",
                    trusted_dirs=[str(self.project)])
        self.addCleanup(h.close)
        policy = json.dumps({"version": 1, "project_agents": True})
        with patch.object(Config, "clone_for_root", clone_fixture), \
                patch.dict("os.environ", {"DGC_AGENT_TRUST_TEST_KEY": "synthetic-agent-key",
                                          perms_mod.SESSION_POLICY_ENV: policy}):
            perms_mod._SESSION_POLICY_CACHE = None
            result = h.agent._run_subagent("reply", "Reply with a brief greeting.", "reviewer", "x")
        perms_mod._SESSION_POLICY_CACHE = None
        self.assertIn("Main route replied", result)
        self.assertEqual(project_requests, [], "the project route must not be contacted")
        self.assertNotIn("synthetic-agent-key", json.dumps(main_requests))
        # The persona (body) is still applied on the main route.
        self.assertIn("Project-only persona", json.dumps(main_requests))

    def test_agent_def_cannot_read_a_dgc_provider_key(self):
        # A definition (even a personal one) may not name a DGC provider-credential env var: that
        # would forward this session's provider key to the endpoint the definition chose.
        main_url, main_requests = self.endpoint("Main route replied.")
        other_url, other_requests = self.endpoint("Other route replied.")
        self.write_definition(self.personal, "Personal persona", endpoint=other_url,
                              key="DGC_API_KEY")
        h = Harness(self.project, base_url=main_url, api_mode="chat_completions", mode="default")
        self.addCleanup(h.close)
        with patch.object(Config, "clone_for_root", clone_fixture), \
                patch.dict("os.environ", {"DGC_API_KEY": "sk-provider-secret"}):
            h.agent._run_subagent("reply", "Reply with a brief greeting.", "reviewer", "x")
        # The def's endpoint differs from the main one, so no key is routed to it at all.
        self.assertNotIn("sk-provider-secret", json.dumps(other_requests))
        self.assertNotIn("sk-provider-secret", json.dumps(main_requests))

    def test_isolated_child_keeps_approved_source_definitions(self):
        self.write_definition(self.definitions, "Approved reviewer")
        h = Harness(self.project, trusted_dirs=[str(self.project)])
        self.addCleanup(h.close)
        scratch = self.root / "scratch"
        (scratch / ".dgc" / "agents").mkdir(parents=True)
        self.write_definition(scratch / ".dgc" / "agents", "Unapproved scratch reviewer")
        observed = []

        def run_child(child, prompt):
            observed.append(child.agent_defs["reviewer"].body)
            child.ui.on_text("Reviewed.")
            child.ui.end_stream()
            return True

        from dgc.agent import _SubUI
        with patch.object(Config, "clone_for_root", clone_fixture), \
                patch.object(Agent, "run_turn", run_child):
            result = h.agent._execute_prepared_subagent(
                "review", "Review it.", "reviewer", SimpleNamespace(project_root=scratch),
                _SubUI(h.ui, "review", cancel=h.agent.cancelled))
        self.assertEqual(result, ("", "Reviewed.", ""))
        self.assertEqual(observed, ["Approved reviewer"])


if __name__ == "__main__":
    unittest.main()
