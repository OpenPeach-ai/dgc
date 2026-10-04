"""Pip computers end to end: grant, a real run that browses and is held, the user's decision."""
import json
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

from dgc import pip_computer, pip_computer_box as box, pips
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures
from tests.test_pip_computer_box import TEST_HOST, serve

REAL_CHROME = box.find_chrome()          # before the fixture moves HOME
PLAN = {"schema_version": 1}

# The model in the worker: open the shop, read it, press Send, then report.
WORKER = r'''
import json, re
from unittest.mock import patch
from dgc.llm import LLMClient, ChatResult, ToolCall
from dgc.pips import _worker_main
URL = %r
def chat(self, messages, tools=None, on_text=None, **kwargs):
    names = [t["function"]["name"] for t in (tools or [])]
    assert names == ["computer"], names
    tool_results = [m for m in messages if m.get("role") == "tool"]
    if not tool_results:
        return ChatResult(tool_calls=[ToolCall("c1", "computer", {"op": "open", "url": URL})])
    last = str(tool_results[-1].get("content", ""))
    if len(tool_results) == 1:
        ref = re.search(r'button "Send" \[(e\d+)\]', last).group(1)
        return ChatResult(tool_calls=[ToolCall("c2", "computer", {"op": "click", "ref": ref})])
    assert "Held for the user's approval" in last, last
    return ChatResult(content="Your order form is filled in and waiting for your approval to send.")
with patch.object(LLMClient, "chat", chat):
    raise SystemExit(_worker_main())
'''


@unittest.skipUnless(REAL_CHROME and box.capability().get("available"), "needs Linux, bubblewrap and a Chromium build")
class PipComputerTests(unittest.TestCase):
    setUp_base = fixtures.LocalPipsTests.setUp

    def setUp(self):
        self.setUp_base()
        self.server, self.received = serve()
        self.addCleanup(self.server.shutdown)
        port = self.server.server_address[1]
        self.url = f"http://{TEST_HOST}:{port}/"
        policy = lambda host, p, **kw: ["127.0.0.1"] if host == TEST_HOST and p == port else []
        for target, value in (("public_addresses", policy), ("find_chrome", lambda home=None: REAL_CHROME)):
            p = patch.object(box, target, value)
            p.start(); self.addCleanup(p.stop)
        p = patch.object(box, "capability", lambda home=None: {"available": True, "reason": "", "chrome": str(REAL_CHROME)})
        p.start(); self.addCleanup(p.stop)
        self.addCleanup(pip_computer.stop_all)
        self.cfg.data["pips_enabled"] = True

    def personal(self, **plan):
        pip = self.store.create(self.registry.personal()["id"], "Shopper", "Fill in the order form", "local-console")
        proposal = self.store.propose(pip["id"], 1, {"computer_plan": PLAN, **plan}, "local-console")
        self.store.accept(pip["id"], proposal["id"], 1, "local-console")
        return self.store.get(pip["id"])

    def run_worker(self, pip):
        queued = self.store.enqueue(pip["id"], "task-" + str(time.monotonic_ns()), "local-console", self.cfg)
        self.assertEqual(queued["manifest"]["computer"], PLAN)
        row = self.store.claim_next()
        popen = subprocess.Popen

        def process(argv, *a, **kw):
            if argv[1:] == ["-m", "dgc.pips", "--worker"]:
                argv = [sys.executable, "-c", WORKER % self.url]
            return popen(argv, *a, **kw)
        with patch.object(pips.subprocess, "Popen", side_effect=process):
            result = pips._execute_run(self.registry, row, self.cfg)
        return queued, self.store.finish(queued["id"], result=result)

    def test_the_grant_is_a_reviewed_change_and_keeps_private_app_data_out(self):
        pip = self.store.create(self.registry.personal()["id"], "Shopper", "Shop", "local-console")
        proposal = self.store.propose(pip["id"], 1, {"computer_plan": PLAN}, "local-console")
        self.assertIsNone(self.store.get(pip["id"]).get("computer_plan"), "a proposal grants nothing")
        with self.assertRaises(RegistryError):
            self.store.propose(pip["id"], 1, {"computer_plan": PLAN}, "main-chat", origin_session_id="chat-one")
        project = self.store.create(self.workspace["id"], "Reviewer", "Review", "local-console")
        with self.assertRaises(RegistryError) as raised:
            self.store.propose(project["id"], 1, {"computer_plan": PLAN}, "local-console")
        self.assertEqual(raised.exception.code, "unsupported_computer_plan")
        self.store.accept(pip["id"], proposal["id"], 1, "local-console")
        self.assertEqual(self.store.get(pip["id"])["computer_plan"], PLAN)

    def test_a_submit_waits_for_the_user_and_approval_sends_exactly_that_request(self):
        pip = self.personal()
        queued, finished = self.run_worker(pip)
        self.assertEqual(finished["status"], "succeeded", finished.get("error"))
        result = finished["result"]
        self.assertIn("waiting for your approval", result["text"])
        self.assertEqual(result["computer"]["calls"], 2)
        [action_id] = result["computer"]["held"]
        self.assertEqual(self.received, [], "nothing was sent during the run")
        [action] = pip_computer.list_actions(self.registry, pip["id"])
        self.assertEqual((action["id"], action["status"]), (action_id, "pending"))
        self.assertEqual(action["summary"]["fields"], [{"name": "name", "value": "Ada"}, {"name": "password", "value": "•••"}])
        shot = pip_computer.frame(self.registry.directory, queued["id"], action["frame"])
        self.assertTrue(shot["image"].startswith("data:image/jpeg;base64,"))
        self.assertTrue(pip_computer.frames(self.registry.directory, queued["id"]))
        with self.assertRaises(RegistryError):
            pip_computer.decide(self.registry, action_id, "0" * 64, True, "editor-user")
        with self.assertRaises(RegistryError):
            pip_computer.decide(self.registry, action_id, action["digest"], True, "main-chat")
        pip_computer.decide(self.registry, action_id, action["digest"], True, "editor-user")
        self.assertEqual(self.received, [], "deciding is not sending; the supervisor carries it out")
        outcome = pip_computer.tick(self.registry, self.cfg)
        self.assertEqual(outcome["sent"], 1)
        self.assertEqual(self.received, [("/submit", "name=Ada&password=hunter2")], "exactly the held request, once")
        [sent] = pip_computer.list_actions(self.registry, pip["id"])
        self.assertEqual(sent["status"], "sent")
        follow = self.store.run(sent["continuation_run_id"])
        self.assertEqual(follow["manifest"]["computer_continuation"]["action_id"], action_id)
        pip_computer.tick(self.registry, self.cfg)
        self.assertEqual(len(self.received), 1, "never sent twice")

    def test_rejecting_drops_the_request_and_the_kill_switch_loses_what_is_held(self):
        pip = self.personal()
        self.run_worker(pip)
        [action] = pip_computer.list_actions(self.registry, pip["id"])
        pip_computer.decide(self.registry, action["id"], action["digest"], False, "editor-user")
        self.assertEqual(pip_computer.tick(self.registry, self.cfg)["rejected"], 1)
        self.assertEqual(self.received, [])
        self.assertFalse(pip_computer.HOSTS[pip["id"]].browser.held)
        self.run_worker(pip)                           # a second hold, then the kill switch
        pending = [a for a in pip_computer.list_actions(self.registry, pip["id"]) if a["status"] == "pending"]
        self.assertEqual(len(pending), 1)
        pip_computer.request_stop(self.registry, pip["id"], "editor-user")
        self.assertEqual(pip_computer.handle_stops(self.registry), 1)
        self.assertNotIn(pip["id"], pip_computer.HOSTS)
        self.assertEqual(pip_computer.list_actions(self.registry, pip["id"])[0]["status"], "lost")
        self.assertEqual(self.received, [])


if __name__ == "__main__":
    unittest.main()
