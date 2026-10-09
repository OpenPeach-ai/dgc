"""Always allow: a Pip runs the same kind of action again without asking, only as the user allowed it."""
import hashlib
import json
import os
import unittest
from unittest.mock import patch

from dgc import pip_action_grants as grants, pip_app_actions as actions, pip_app_sends as sends
from dgc import pip_message_drafts as drafts, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pip_app_actions as fixtures

PREPARED = sends.prepared        # the real adapter, driven by the fixture's fake connection


class ActionGrantTests(unittest.TestCase):
    setUp = fixtures.AppActionTests.setUp
    prepare_source = fixtures.AppActionTests.prepare_source
    propose = fixtures.AppActionTests.propose
    prepare = fixtures.AppActionTests.prepare
    sends = fixtures.AppActionTests.sends

    def always(self, action=None, actor="local-console"):
        action = action or self.propose()
        done = actions.accept(self.store, action["id"], action["digest"], actor, self.cfg, prepare=self.prepare)
        return done, grants.grant_from_action(self.store, done["id"], done["digest"], actor)

    def pip_draft(self, message=None, run=None):
        run = run or self.run
        return drafts.save(self.store, run["id"], message or {**self.message, "subject": "Tuesday plan"},
                           "pip-email:" + run["id"], hashlib.sha256(run["id"].encode()).hexdigest())

    def fake_prepared(self, config, payload, authorize):
        return PREPARED(config, payload, authorize, manager_factory=self.factory,
                        servers_reader=lambda c: c.get("mcp_servers"), clock=lambda: 0)

    def dispatch(self, run=None):
        with patch.object(sends, "prepared", self.fake_prepared):
            return grants.dispatch_for_run(self.registry, self.cfg, (run or self.run)["id"])

    def test_always_allow_runs_the_pips_next_draft_of_that_kind_without_asking(self):
        done, grant = self.always()
        self.assertEqual(done["status"], "succeeded")
        self.assertEqual((grant["kind"], grant["account"], grant["tool"]), ("gmail_send", "ca_test", sends.TOOL))
        draft = self.pip_draft()
        [outcome] = self.dispatch()
        self.assertEqual(outcome["status"], "succeeded")
        self.assertEqual(len(self.sends()), 2, "the second email went without a review")
        ran = actions.get(self.store, outcome["action_id"])
        self.assertEqual(ran["resolved_by"], "pip-grant:" + grant["id"], "the record says it ran on the grant")
        self.assertEqual(ran["payload"]["message"]["subject"], "Tuesday plan")
        self.assertEqual(drafts.get(self.store, draft["id"])["status"], "prepared")

    def test_without_a_grant_the_pips_draft_waits_for_the_user(self):
        draft = self.pip_draft()
        self.assertEqual(self.dispatch(), [])
        self.assertEqual(self.sends(), [])
        self.assertEqual(drafts.get(self.store, draft["id"])["status"], "pending")

    def test_a_grant_covers_only_its_own_connection(self):
        self.always()
        self.cfg.data["mcp_servers"]["composio"]["url"] = "https://connect.composio.dev/another"
        draft = self.pip_draft()
        [outcome] = self.dispatch()
        self.assertEqual(outcome["status"], "waiting", "a changed connection is asked about again")
        self.assertEqual(len(self.sends()), 1)
        self.assertEqual(drafts.get(self.store, draft["id"])["status"], "pending")
        skipped = self.registry.db.execute("SELECT count(*) FROM workspace_events WHERE event_type='pip_action_grant_skipped'").fetchone()[0]
        self.assertEqual(skipped, 1, "and the reason is recorded")

    def test_a_grant_never_covers_another_account_or_pip(self):
        _, grant = self.always()
        with self.assertRaises(RegistryError) as raised:
            self.propose(account="ca_other", request_key="other", actor="pip-grant:" + grant["id"])
        self.assertEqual(raised.exception.code, "local_only")
        with self.assertRaises(RegistryError):
            self.propose(request_key="forged", actor="pip-grant:grant_" + "0" * 32)

    def test_only_the_user_grants_rejects_or_revokes(self):
        action = self.propose()
        for actor in ("pip-worker", "chat", "pip-grant:grant_" + "1" * 32):
            with self.subTest(actor=actor), self.assertRaises(RegistryError):
                grants.grant_from_action(self.store, action["id"], action["digest"], actor)
        with self.assertRaises(RegistryError):
            actions.reject(self.store, action["id"], action["digest"], "pip-grant:grant_" + "1" * 32)
        _, grant = self.always(action)
        covered = self.propose(request_key="two", message={**self.message, "subject": "Another"})
        with self.assertRaises(RegistryError) as raised:
            actions.reject(self.store, covered["id"], covered["digest"], "pip-grant:" + grant["id"])
        self.assertEqual(raised.exception.code, "local_only", "even a grant that covers it never rejects")
        with patch("dgc.pip_action_grants.dispatch_for_run", side_effect=RuntimeError("provider down")):
            pips._run_granted_actions(self.registry, self.cfg, self.run["id"])   # never stops the runner
        self.assertEqual(grants.revoke(self.registry, self.source["id"], grant["id"], "editor-user"), [])
        self.pip_draft()
        self.assertEqual(self.dispatch(), [], "a revoked grant runs nothing")
        self.assertEqual(len(self.sends()), 1)

    def test_the_controls_through_the_editor(self):
        self.cfg.data["pips_enabled"] = True
        action = self.propose()

        def control(request, actor="editor-user"):
            with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"), \
                    patch.object(sends, "prepared", self.fake_prepared):
                response = pips.handle_control(self.cfg, {"request_id": "r", **request}, actor, start_worker=False)
            if not response["ok"]:
                raise RegistryError(response["error"]["code"], response["error"]["message"])
            return response["result"]
        result = control({"type": "always_allow_pip_app_action", "action_id": action["id"], "expected_digest": action["digest"]})
        self.assertEqual(result["action"]["status"], "succeeded")
        listed = control({"type": "list_pip_action_grants", "pip_id": self.source["id"]})
        self.assertEqual([g["id"] for g in listed["grants"]], [result["grant"]["id"]])
        self.assertIn("Send email with composio", listed["grants"][0]["label"])
        with self.assertRaises(RegistryError) as raised:
            control({"type": "list_pip_action_grants", "pip_id": self.source["id"]}, actor="pip-grant:" + result["grant"]["id"])
        self.assertEqual(raised.exception.code, "local_only")
        emptied = control({"type": "revoke_pip_action_grant", "pip_id": self.source["id"], "grant_id": result["grant"]["id"]})
        self.assertEqual(emptied["grants"], [])

    def test_an_unattended_task_drafts_and_its_granted_email_goes_after_the_run(self):
        from dgc.llm import ChatResult, LLMClient, ToolCall
        _, grant = self.always()
        self.cfg.data["pips_enabled"] = True
        run = self.store.enqueue(self.source["id"], "scheduled-1", "user", self.cfg)
        self.assertEqual(run["manifest"]["email_draft"], {"schema_version": 1})
        self.assertEqual(run["manifest"]["action_grants"], [{"kind": "gmail_send", "tool": sends.TOOL, "server": "composio"}])
        self.store.claim_next()
        seen = []

        def chat(client, messages, tools=None, **kwargs):
            seen.append(json.dumps(messages))
            if len(seen) == 1:
                return ChatResult(content="", tool_calls=[ToolCall("d1", "draft_email", {**self.message, "subject": "Morning brief"})])
            return ChatResult(content="Here is the brief. I drafted it to review@example.invalid.")
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                patch("requests.sessions.Session.request", side_effect=AssertionError("no network")):
            # Its job names the address, as a real one would ("email it to …"): a guessed one is never drafted.
            manifest = {**run["manifest"], "job": {**run["manifest"]["job"],
                                                   "goal": run["manifest"]["job"]["goal"] + " Email it to review@example.invalid."}}
            result = pips.execute_native(self.cfg, self.root, manifest, lambda event: None)
        self.assertIn("runs a matching draft without asking", seen[0], "the run is told what it may do")
        self.assertEqual(result["message_draft"]["subject"], "Morning brief")
        self.assertEqual(result["tools_called"], 0, "drafting is not an executed tool")
        self.store.finish(run["id"], result=result)
        [outcome] = self.dispatch(run)
        self.assertEqual(outcome["status"], "succeeded")
        self.assertEqual(actions.get(self.store, outcome["action_id"])["resolved_by"], "pip-grant:" + grant["id"])
        self.assertEqual(len(self.sends()), 2)


    def test_the_terminal_lists_allows_and_takes_back(self):
        import contextlib
        import io
        from dgc import pip_cli, sandbox
        self.cfg.data["pips_enabled"] = True
        action = self.propose()

        def cli(*argv, shell=False):
            out, err = io.StringIO(), io.StringIO()
            env = {k: v for k, v in os.environ.items() if k != sandbox.AGENT_SHELL}
            if shell:
                env[sandbox.AGENT_SHELL] = "1"
            with patch.dict(os.environ, env, clear=True), patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), \
                    patch.object(self.registry, "close"), patch.object(sends, "prepared", self.fake_prepared), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), patch("sys.stdin", io.StringIO()):
                code = pip_cli.handle_command(self.cfg, list(argv))
            return code, out.getvalue(), err.getvalue()
        code, text, err = cli("allowed", self.source["id"])
        self.assertEqual(code, 0, err)
        self.assertIn("Nothing runs without asking", text)
        code, text, err = cli("app-action", "accept", action["id"], "--expected-digest", action["digest"], "--always", "--yes", "--json")
        self.assertEqual(code, 0, err)
        grant = json.loads(text)["grant"]
        code, text, err = cli("allowed", self.source["id"], shell=True)
        self.assertEqual(code, 0, "reading is fine from the chat's shell: " + err)
        self.assertIn("Send email with composio", text)
        code, _, err = cli("allowed", self.source["id"], "--revoke", grant["id"], shell=True)
        self.assertEqual(code, 2, "but taking it back is the user's")
        code, text, err = cli("allowed", self.source["id"], "--revoke", grant["id"])
        self.assertEqual((code, "Nothing runs without asking" in text), (0, True), err)


    def test_you_are_told_after_and_waiting_actions_are_counted(self):
        from dgc import pip_desktop
        self.pip_draft()
        self.assertEqual(grants.pending_count(self.registry, self.registry.clock()), 1, "a draft waiting for you counts")
        _, grant = self.always()
        self.dispatch()
        [(action_id, said)] = grants.ran_on_their_own(self.registry)
        self.assertEqual(said, f"{self.store.get(self.source['id'])['name']} sent an email to review@example.invalid, as you always allow.")
        shown = []
        pip_desktop.set_enabled(self.registry, True, "editor-user")
        notifier = pip_desktop.Notifier(self.cfg, clock=lambda: 1000.0, send=lambda title, body: shown.append(body) or True)
        with patch.object(pip_desktop.Notifier, "_alerts", return_value=([], "")):
            notifier.tick(self.registry)
        self.assertEqual(shown, [said], "the desktop says what the Pip did on its own")
        notifier.last = None
        with patch.object(pip_desktop.Notifier, "_alerts", return_value=([], "")):
            self.assertIsNone(notifier.tick(self.registry), "and says it once")



class ConnectorMatchingTests(unittest.TestCase):
    def test_a_connector_grant_matches_only_its_own_connection_schema_and_tool(self):
        grant = {"kind": "connector_call", "server": "zapier", "connection_digest": "a" * 64,
                 "schema_digest": "b" * 64, "tool": "place_order", "account": "connection_managed"}
        draft = {"server": "zapier", "connection_digest": "a" * 64, "schema_digest": "b" * 64,
                 "call": {"tool": "place_order", "arguments": {"symbol": "INFY", "quantity": 1}}}
        self.assertIs(grants._matching([grant], "connector_call", draft), grant)
        for change in ({"server": "make"}, {"connection_digest": "c" * 64}, {"schema_digest": "c" * 64},
                       {"call": {"tool": "cancel_order", "arguments": {}}}):
            with self.subTest(change=list(change)):
                self.assertIsNone(grants._matching([grant], "connector_call", {**draft, **change}))
        self.assertIsNone(grants._matching([grant], "gmail_send", draft), "a grant is for one kind of action")


if __name__ == "__main__":
    unittest.main()
