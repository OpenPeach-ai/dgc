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
    assert names == ["computer", "connect_app", "read_app", "skill"], names   # its computer, its apps (Grok-style), its skills
    tool_results = [m for m in messages if m.get("role") == "tool"]
    if not tool_results:
        return ChatResult(tool_calls=[ToolCall("c1", "computer", {"op": "open", "url": URL})])
    last = str(tool_results[-1].get("content", ""))
    if len(tool_results) == 1:
        ref = re.search(r'button "Send" \[(e\d+)\]', last).group(1)
        return ChatResult(tool_calls=[ToolCall("c2", "computer", {"op": "click", "ref": ref})])
    assert last.startswith("Held:"), last
    return ChatResult(content="Your order form is filled in and waiting for your approval to send.")
with patch.object(LLMClient, "chat", chat):
    raise SystemExit(_worker_main())
'''


# The same model in the Pip's chat: it has the computer there too, among the chat's own tools.
CHAT_WORKER = WORKER.replace('assert names == ["computer", "connect_app", "read_app", "skill"], names', 'assert "computer" in names, names')


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

    def test_a_download_lands_in_the_computers_files(self):
        from dgc import pip_computer_files as desk
        pip = self.personal()
        host = pip_computer.host_for(self.registry.directory, pip["id"], pip["workspace_id"])
        host.call("open", {"url": self.url + "report.txt"})
        target = desk.files_root(host.root) / "Downloads" / "report.txt"
        for _ in range(100):
            if target.exists() and target.read_text() == "quarterly numbers\n":
                break
            time.sleep(0.1)
        self.assertEqual(target.read_text(), "quarterly numbers\n")
        self.assertIn("report.txt", host.call("files", {"path": "Downloads"}))

    def test_a_submit_held_in_the_pips_chat_continues_in_the_chat(self):
        from dgc import pip_chat
        pip = self.personal()
        sent = pip_chat.send(self.store, pip["id"], "Order the usual", "k1", "editor-user", self.cfg)
        row = self.store.claim_next()
        popen = subprocess.Popen

        def process(argv, *a, **kw):
            if argv[1:] == ["-m", "dgc.pips", "--worker"]:
                argv = [sys.executable, "-c", CHAT_WORKER % self.url]
            return popen(argv, *a, **kw)
        with patch.object(pips.subprocess, "Popen", side_effect=process):
            result = pips._execute_run(self.registry, row, self.cfg)
        finished = self.store.finish(sent["run"]["id"], result=result)
        self.assertEqual(finished["status"], "succeeded", finished.get("error"))
        [action] = pip_computer.list_actions(self.registry, pip["id"])
        self.assertEqual((action["status"], action["run_id"]), ("pending", sent["run"]["id"]))
        self.assertEqual(self.received, [])
        pip_computer.decide(self.registry, action["id"], action["digest"], True, "editor-user")
        self.assertEqual(pip_computer.tick(self.registry, self.cfg)["sent"], 1)
        self.assertEqual(self.received, [("/submit", "name=Ada&password=hunter2")])
        [done] = pip_computer.list_actions(self.registry, pip["id"])
        follow = self.store.run(done["continuation_run_id"])
        self.assertEqual(follow["manifest"]["run_kind"], "conversation", "the Pip carries on in its chat")
        last = pip_chat.list_messages(self.store, pip["id"])["messages"][-1]
        self.assertTrue(last["intro"])

    def test_always_allow_sends_the_same_submit_on_that_site_without_asking(self):
        from dgc import pip_action_grants as grants
        pip = self.personal()
        self.run_worker(pip)
        [first] = pip_computer.list_actions(self.registry, pip["id"])
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            response = pips.handle_control(self.cfg, {"type": "always_allow_pip_computer_action", "request_id": "r",
                                                      "action_id": first["id"], "expected_digest": first["digest"]},
                                           "editor-user", start_worker=False)
        self.assertTrue(response["ok"], response.get("error"))
        grant = response["result"]["grant"]
        self.assertEqual((grant["kind"], grant["server"], grant["tool"], grant["account"]),
                         ("computer_submit", TEST_HOST, "POST /submit", "browser"))
        pip_computer.tick(self.registry, self.cfg)
        self.assertEqual(len(self.received), 1, "the one you allowed is sent")
        [sent] = pip_computer.list_actions(self.registry, pip["id"])
        self.store.cancel(sent["continuation_run_id"], "local-console")      # this test drives the next run itself
        self.run_worker(pip)
        latest = pip_computer.list_actions(self.registry, pip["id"])[0]
        self.assertEqual((latest["status"], latest["resolved_by"]), ("approved", "pip-grant:" + grant["id"]),
                         "the same submit on the same site is approved by the grant, not left for you")
        pip_computer.tick(self.registry, self.cfg)
        self.assertEqual(len(self.received), 2, "and sent without asking")
        said = [text for action_id, text in grants.ran_on_their_own(self.registry) if action_id == latest["id"]]
        self.assertEqual(said, [f"Shopper submitted to {TEST_HOST}/submit in its browser, as you always allow."])

    def test_an_always_allow_that_cannot_be_made_leaves_the_submit_waiting(self):
        from dgc import pip_action_grants as grants
        pip = self.personal()
        self.run_worker(pip)
        [held] = pip_computer.list_actions(self.registry, pip["id"])
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"), \
                patch.object(grants, "MAX_PER_PIP", 0):
            response = pips.handle_control(self.cfg, {"type": "always_allow_pip_computer_action", "request_id": "r",
                                                      "action_id": held["id"], "expected_digest": held["digest"]},
                                           "editor-user", start_worker=False)
        self.assertFalse(response["ok"])
        self.assertEqual(pip_computer.list_actions(self.registry, pip["id"])[0]["status"], "pending",
                         "not sent on half a decision")
        self.assertEqual(grants.list_grants(self.registry, pip["id"]), [])
        pip_computer.tick(self.registry, self.cfg)
        self.assertEqual(self.received, [])

    def test_a_grant_covers_one_site_method_and_path_from_one_pips_computer(self):
        from dgc import pip_action_grants as grants
        pip = self.personal()
        self.run_worker(pip)
        [held] = pip_computer.list_actions(self.registry, pip["id"])
        with self.registry.transaction():
            grants.add_computer_grant(self.registry, held["id"], "editor-user")
        same = {"method": "post", "host": TEST_HOST, "path": "/submit"}
        self.assertIsNotNone(grants.computer_grant_for(self.registry, pip["id"], same))
        for other in ({**same, "path": "/submit/delete"}, {**same, "host": "other.example"}, {**same, "method": "DELETE"}):
            self.assertIsNone(grants.computer_grant_for(self.registry, pip["id"], other), other)
        self.assertIsNone(grants.computer_grant_for(self.registry, "pip_" + "0" * 32, same), "another Pip's computer")
        with self.assertRaises(RegistryError):
            grants.add_computer_grant(self.registry, held["id"], "pip-grant:grant_" + "1" * 32)

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


    def test_the_user_drives_the_browser_and_their_own_submit_is_sent(self):
        pip = self.personal()
        with self.assertRaises(RegistryError):
            pip_computer.request_open(self.registry, pip["id"], "main-chat")
        self.assertFalse(pip_computer.request_open(self.registry, pip["id"], "editor-user")["ready"])
        self.assertEqual(pip_computer.handle_opens(self.registry), 1)            # the supervisor's tick
        first = pip_computer.view_call(self.registry, pip["id"], "frame", {}, "editor-user")
        self.assertTrue(first["ok"], first)
        self.assertTrue(first["image"].startswith("data:image/jpeg;base64,"))
        page = pip_computer.view_call(self.registry, pip["id"], "go", {"url": self.url}, "editor-user")
        self.assertTrue(page["ok"], page)
        host = pip_computer.HOSTS[pip["id"]]
        box_ = host.browser.evaluate_json("(() => { const r=document.getElementById('go').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()")
        clicked = pip_computer.view_call(self.registry, pip["id"], "click", {"x": box_["x"], "y": box_["y"]}, "editor-user")
        self.assertTrue(clicked["ok"], clicked)
        end = time.monotonic() + 10
        while not self.received and time.monotonic() < end:
            pip_computer.view_call(self.registry, pip["id"], "frame", {}, "editor-user")
        self.assertEqual(self.received, [("/submit", "name=Ada&password=hunter2")], "the user's own submit is theirs to send")
        self.assertEqual(pip_computer.list_actions(self.registry, pip["id"]), [], "nothing waits for approval")
        host.run_id = "run_" + "0" * 32                                           # a run is using it now
        watching = pip_computer.view_call(self.registry, pip["id"], "click", {"x": 1, "y": 1}, "editor-user")
        self.assertFalse(watching["ok"])
        self.assertIn("using its computer", watching["error"])
        self.assertTrue(pip_computer.view_call(self.registry, pip["id"], "frame", {}, "editor-user")["watching"])
        host.run_id = None


class ComputerCommandLineTests(unittest.TestCase):
    """One plain step to give or remove a computer; no browser needed."""
    setUp_base = fixtures.LocalPipsTests.setUp

    def setUp(self):
        self.setUp_base()
        self.cfg.data["pips_enabled"] = True

    def cli(self, *argv):
        import contextlib
        import io
        from dgc import pip_cli
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), patch("sys.stdin", io.StringIO()):
            code = pip_cli.handle_command(self.cfg, list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_give_status_and_remove(self):
        code, text, _ = self.cli("create", "Shopper", "--personal", "--goal", "Shop for me", "--json")
        self.assertEqual(code, 0, text)
        pip_id = json.loads(text)["pip"]["id"]
        code, _, err = self.cli("computer", "give", pip_id)
        self.assertNotEqual(code, 0, "without a terminal it asks for --yes")
        self.assertIn("--yes", err)
        code, text, err = self.cli("computer", "give", pip_id, "--yes")
        self.assertEqual(code, 0, err)
        self.assertIn("never sees your passwords", err)
        self.assertIn("Has a computer.", text)
        code, text, _ = self.cli("computer", "pending", pip_id)
        self.assertIn("Nothing is waiting", text)
        code, text, _ = self.cli("computer", "remove", pip_id, "--yes")
        self.assertIn("No computer.", text)


if __name__ == "__main__":
    unittest.main()
