"""Local editor Pips bridge: deterministic, isolated, no models/network/sleeps."""
from __future__ import annotations

import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from dgc import editor_protocol as ep, headless
from dgc.config import Config, DEFAULTS
from dgc.headless import Backend
from dgc.pip_daemon import is_runtime_paused, stop_all
from dgc.pips import PipStore
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests.pip_test_profile import pips_in_use


class LocalPipsBridgeTests(unittest.TestCase):
    def setUp(self):
        pips_in_use(self)
        temp = tempfile.TemporaryDirectory(prefix="headless-pips-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        home = patch.dict(os.environ, {"DGC_HOME": str(self.base / "home")})
        home.start()
        self.addCleanup(home.stop)
        root = self.base / "project"
        root.mkdir()
        config = object.__new__(Config)
        config.project_root, config.project_dir, config._persist = root, root / ".dgc", False
        config.data = copy.deepcopy(DEFAULTS)
        config.data.update(model="fixture", base_url="http://unused.invalid/v1", pips_enabled=False)
        for field in ("_stored_secrets", "_stored_provider_identity", "_provider_secret_identity",
                      "_stored_mcp_env", "_stored_mcp_identity"):
            setattr(config, field, {})
        config._env_secret_keys, config._explicit_keys = set(), set()
        config.credential_warnings = ()
        config.permissions = {"allow": [], "ask": [], "deny": []}
        self.config = config
        self.backend = Backend.__new__(Backend)
        self.backend.config = config
        self.backend._busy = Mock(return_value=True)
        self.backend._yield_wake_turn = Mock(side_effect=AssertionError("Pips must not interrupt chat"))
        self.backend.agent = Mock()
        self.events = []
        def emit(kind, **fields):
            event = {"type": kind, **fields}
            self.assertIsNone(ep.event_error({"seq": len(self.events), **event}))
            self.events.append(event)
        self.backend.em = SimpleNamespace(emit=emit)

    def send(self, command, *, drain=True):
        # Hold scheduling deterministically; explicitly drain the same worker.
        with patch.object(headless.threading, "Thread"):
            self.backend._dispatch(command)
        if drain and getattr(self.backend, "_pips_commands", None):
            self.backend._drain_pips_commands()
        return self.events[-1] if self.events else None

    def control(self, kind="list_workspaces", **fields):
        return self.send({"type": "pips_control", "request": {"type": kind, "request_id": "request-one", **fields}})

    def test_account_discovery_uses_local_controller_without_interrupting_chat(self):
        self.config.data['pips_enabled'] = True
        with patch('dgc.pip_app_accounts.discover', return_value={'accounts': [], 'server': 'composio'}) as discover:
            event = self.control('list_pip_accounts', server='composio')
        self.assertTrue(event['ok'], event)
        discover.assert_called_once()
        self.assertEqual(discover.call_args.args[1], 'composio')
        self.assertEqual(discover.call_args.args[0].project_root, self.config.project_root)
        self.backend._yield_wake_turn.assert_not_called()

    def test_protocol_declares_strict_top_level_shapes(self):
        for command in ({"type": "pips_control", "request": {}},
                        {"type": "pips_enable", "enabled": True},
                        {"type": "pips_runtime", "action": "resume", "request_id": "r"}):
            self.assertIsNone(ep.command_error(command))
        for command in ({"type": "pips_control", "request": []},
                        {"type": "pips_control", "request": {}, "model": "other"},
                        {"type": "pips_enable", "enabled": 1},
                        {"type": "pips_runtime", "action": "restart", "request_id": "r"},
                        {"type": "pips_runtime", "action": "start"}):
            self.assertIsNotNone(ep.command_error(command))
        self.assertFalse({"pips_control", "pips_enable", "pips_runtime"} & headless._BUSY_MUTATIONS)

    def test_ready_capabilities_are_additive_and_show_disabled_default(self):
        self.backend.agent = SimpleNamespace(mode="default", session_file=None, session_name="", skills={},
            client=SimpleNamespace(tools_supported=True, family="fixture", capability_snapshot=lambda: {}))
        self.backend.workspace_trusted = True
        self.backend._image_spool = lambda: self.base / "spool"
        self.backend._session_policy_capability = lambda: {}
        self.backend._goal_snapshot = lambda: {}
        self.backend._context_window_size = lambda: 4096
        value = self.backend._ready_payload()
        self.assertIsNone(ep.event_error({"type": "ready", "seq": 0, **value}))
        self.assertTrue(value["capabilities"]["pips_supported"])
        self.assertEqual(value["capabilities"]["pips_api_version"], 66)
        self.assertFalse(value["capabilities"]["pips_enabled"])
        self.assertNotIn("pips_enabled", value)
        self.assertEqual(value["capabilities"]["workspace_identity"], {})

    def test_ready_workspace_identity_is_registry_owned_additive_capability(self):
        self.backend.agent = SimpleNamespace(mode="default", session_file=self.config.project_root / "fixture.json",
            session_root=self.config.project_root, session_name="", skills={},
            client=SimpleNamespace(tools_supported=True, family="fixture", capability_snapshot=lambda: {}))
        self.backend.workspace_trusted = True
        self.backend._image_spool = lambda: self.base / "images"
        self.backend._goal_snapshot = lambda: {}
        self.backend._context_window_size = lambda: 32000
        self.config.data["pips_enabled"] = True
        with patch.object(self.backend, "_session_policy_capability", return_value={}):
            value = self.backend._ready_payload()
        self.assertIsNone(ep.event_error({"type": "ready", "seq": 0, **value}))
        identity = value["capabilities"]["workspace_identity"]
        self.assertEqual(set(identity), {"workspace_id", "workspace_binding_id", "runner_id"})
        self.assertNotIn("workspace_id", value, "Strict older SDK event schemas must keep accepting ready")
        self.assertNotIn(str(self.config.project_root), json.dumps(identity))
        with WorkspaceRegistry() as registry:
            self.assertEqual(identity, registry.session_identity("fixture"))

    def test_disabled_controls_are_correlated_and_do_not_create_registry(self):
        with patch("dgc.pips.WorkspaceRegistry", side_effect=AssertionError("disabled means no state")):
            event = self.control()
        self.assertEqual((event["type"], event["request_id"], event["error"]["code"]),
                         ("pips_result", "request-one", "disabled"))

    def test_workspace_handshake_does_not_reuse_a_rebound_path_identity(self):
        self.config.data["pips_enabled"] = True
        root = self.config.project_root
        self.backend.agent = SimpleNamespace(session_root=root, session_file=root / "fixture.json")
        first = self.backend._workspace_identity_meta()
        moved = self.base / "moved"
        root.rename(moved)
        with WorkspaceRegistry() as registry:
            registry.rebind(first["workspace_id"], moved, expected_root=root)
        root.mkdir()  # A different checkout now occupies the old path.
        self.assertEqual(self.backend._workspace_identity_meta(), {})
        with WorkspaceRegistry() as registry:
            self.assertEqual(registry.session_identity("fixture"), first)
            self.assertEqual(len(registry.list()), 1)

    def test_control_runs_during_chat_and_binds_current_workspace_without_paths(self):
        self.config.data["pips_enabled"] = True
        event = self.control()
        self.assertTrue(event["ok"])
        result = event["result"]
        # Listed in the order they were made, to the millisecond: the editor's own personal workspace is made in the
        # same call, so either can come first (a tie falls to their random ids). The current one is this project's.
        listed = {w["id"]: w for w in result["workspaces"]}
        self.assertIn(result["current_workspace_id"], listed)
        self.assertNotEqual(listed[result["current_workspace_id"]]["kind"], "personal")
        with WorkspaceRegistry() as registry:
            binding = registry.binding(result["current_workspace_id"])
        self.assertEqual(binding["canonical_root"], str(self.config.project_root))
        self.assertEqual(self.backend.agent.mock_calls, [])
        self.backend._yield_wake_turn.assert_not_called()

    def test_workspace_session_picker_is_bounded_scoped_metadata_only(self):
        self.config.data['pips_enabled'] = True
        with WorkspaceRegistry() as registry:
            root = self.config.project_root
            workspace = registry.resolve(root)
            for name in ('session-a', 'session-b', 'session-c'):
                registry.associate_session(name, root)
            other = self.base / 'other'; other.mkdir()
            registry.associate_session('other-private-session', other)
        with patch('dgc.pips.start_queued', side_effect=AssertionError('Picker reads must never start work')):
            first = self.control('list_workspace_sessions', workspace_id=workspace['id'], limit=2)
            self.assertTrue(first['ok'])
            page = first['result']
            self.assertEqual([row['session_id'] for row in page['sessions']], ['session-a', 'session-b'])
            self.assertTrue(page['has_more'])
            second = self.control('list_workspace_sessions', workspace_id=workspace['id'], after=page['next_cursor'], limit=2)
            self.assertEqual([row['session_id'] for row in second['result']['sessions']], ['session-c'])
            self.assertFalse(second['result']['has_more'])
            for row in page['sessions'] + second['result']['sessions']:
                self.assertEqual(set(row), {'session_id', 'workspace_id', 'workspace_binding_id', 'updated_at', 'runner_id'})
                self.assertEqual(row['workspace_id'], workspace['id'])
            self.assertNotIn(str(root), json.dumps(page))
            for limit in (None, True, 0, 21):
                error = self.control('list_workspace_sessions', workspace_id=workspace['id'], limit=limit)
                self.assertEqual(error['error']['code'], 'invalid_limit')

    def test_controls_reject_model_path_permission_and_actor_fields(self):
        self.config.data["pips_enabled"] = True
        for field in ("project_root", "model", "base_url", "permissions", "actor", "trust"):
            with self.subTest(field=field):
                event = self.control(**{field: "forged"})
                self.assertFalse(event["ok"])
                self.assertEqual(event["error"]["code"], "invalid_request")

    def test_notifications_acknowledge_once_without_accepting_or_starting_work(self):
        self.config.data['pips_enabled'] = True
        from dgc import pip_notifications
        from dgc.workspace_registry import _execute_schema
        with WorkspaceRegistry() as registry:
            # Before schema13 activation, keep the fixture migration explicit.
            if not registry.db.execute("SELECT 1 FROM sqlite_master WHERE name='pip_notifications'").fetchone():
                with registry.transaction():
                    _execute_schema(registry.db, pip_notifications.SCHEMA)
            workspace = registry.resolve(self.config.project_root)
            store = PipStore(registry)
            pip = store.create(workspace['id'], 'Private name', 'Private goal', 'local-test')
            proposal = store.propose(pip['id'], 1, {'goal': 'Private changed goal'}, 'local-test', 'Private reason')
            before = {table: [tuple(row) for row in registry.db.execute('SELECT * FROM ' + table)]
                      for table in ('pips', 'pip_versions', 'pip_proposals', 'pip_approvals', 'pip_runs', 'workspace_events')}
        with patch('dgc.pips.start_queued', side_effect=AssertionError('Notifications never start work')):
            page = self.control('list_pip_notifications', workspace_id=workspace['id'])
            self.assertTrue(page['ok'], page)
            notice = page['result']['notifications'][0]
            self.assertEqual(notice['source_status'], 'pending')
            self.assertEqual(notice['reference']['proposal_id'], proposal['id'])
            self.assertNotIn('Private', json.dumps(page))
            acknowledged = self.control('mark_pip_notification_read', notification_id=notice['id'], expected_revision=0)
            self.assertTrue(acknowledged['ok'], acknowledged)
            self.assertFalse(acknowledged['result']['replayed'])
            self.assertEqual(acknowledged['result']['notification']['source_status'], 'pending')
            retry = self.control('mark_pip_notification_read', notification_id=notice['id'], expected_revision=0)
            self.assertTrue(retry['result']['replayed'])
            self.assertEqual(retry['result']['notification'], acknowledged['result']['notification'])
            for fields in ({'workspace_id': None}, {'limit': None}, {'before_seq': True}, {'actor': 'forged'}):
                self.assertFalse(self.control('list_pip_notifications', **fields)['ok'])
        with WorkspaceRegistry() as registry:
            after = {table: [tuple(row) for row in registry.db.execute('SELECT * FROM ' + table)] for table in before}
        self.assertEqual(before, after)

    def test_nested_requests_are_bounded_before_queue_and_handler(self):
        cycle = {}; cycle["self"] = cycle
        invalid = [
            {"type": "create_pip", "request_id": "r", "goal": "x" * 17000},
            {"type": "create_pip", "request_id": "r", "goal": "é" * 9000},
            {"type": "list_pips", "request_id": ""},
            {"type": "list_pips", "request_id": "r", "bad": float("nan")},
            {"type": "list_pips", "request_id": "r", "bad": 10 ** 100},
            {"type": "list_pips", "request_id": "r", "bad": cycle},
            {"type": "list_pips", "request_id": "r", "bad": [0] * 65},
        ]
        with patch("dgc.pips.handle_control", side_effect=AssertionError("must reject before handler")):
            for request in invalid:
                with self.subTest(request_keys=list(request)):
                    self.assertFalse(self.send({"type": "pips_control", "request": request})["ok"])
        self.assertFalse(getattr(self.backend, "_pips_commands", []))

    def test_reader_enqueues_without_blocking_and_detaches_input(self):
        self.config.data["pips_enabled"] = True
        command = {"type": "pips_control", "request": {"type": "list_workspaces", "request_id": "original"}}
        self.assertIsNone(self.send(command, drain=False))
        command["request"]["request_id"] = "mutated"
        self.backend._drain_pips_commands()
        self.assertEqual(self.events[-1]["request_id"], "original")

    def test_async_queue_has_fixed_budget(self):
        for number in range(headless._MAX_PIPS_PENDING):
            self.send({"type": "pips_control", "request": {"type": "list_workspaces", "request_id": str(number)}}, drain=False)
        event = self.send({"type": "pips_control", "request": {"type": "list_workspaces", "request_id": "overflow"}}, drain=False)
        self.assertEqual(event["error"]["code"], "busy")
        self.assertEqual(len(self.backend._pips_commands), headless._MAX_PIPS_PENDING)

    def test_enable_uses_existing_save_path_and_never_starts_worker(self):
        with patch.object(self.config, "save", wraps=self.config.save) as save, \
             patch("dgc.pips.start_queued", side_effect=AssertionError("enable is not a run")):
            event = self.send({"type": "pips_enable", "enabled": True, "request_id": "enable"})
        save.assert_called_once_with()
        self.assertTrue(self.config.get("pips_enabled"))
        self.assertEqual((event["type"], event["enabled"], event["restart_required"]), ("pips_status", True, False))
        self.assertEqual(event["api_version"], 66)

    def test_disable_persists_global_stop_before_save_and_reenable_keeps_it(self):
        self.config.data["pips_enabled"] = True
        with WorkspaceRegistry() as registry:
            workspace = registry.resolve(self.config.project_root)
            pip = PipStore(registry).create(workspace["id"], "Audit", "Inspect source correctness", "fixture")
        def save():
            with WorkspaceRegistry() as registry:
                self.assertTrue(is_runtime_paused(registry), "stop must persist before flag save")
                self.assertEqual(PipStore(registry).get(pip["id"])["status"], "paused")
        with patch.object(self.config, "save", side_effect=save):
            event = self.send({"type": "pips_enable", "enabled": False})
        self.assertFalse(event["enabled"])
        self.assertFalse(self.config.get("pips_enabled"))
        enabled = self.send({"type": "pips_enable", "enabled": True})
        self.assertTrue(enabled["restart_required"])
        with WorkspaceRegistry() as registry:
            self.assertTrue(is_runtime_paused(registry))
            self.assertEqual(PipStore(registry).get(pip["id"])["status"], "paused")

    def test_stop_failure_does_not_disable_flag(self):
        self.config.data["pips_enabled"] = True
        with patch("dgc.pip_daemon.stop_all", side_effect=OSError("storage unavailable")):
            event = self.send({"type": "pips_enable", "enabled": False, "request_id": "disable"})
        self.assertTrue(self.config.get("pips_enabled"))
        self.assertEqual(event["type"], "command_rejected")
        self.assertEqual(event["request_id"], "disable")

    def test_save_failure_restores_effective_enable_flag(self):
        with patch.object(self.config, "save", side_effect=OSError("cannot save config")):
            event = self.send({"type": "pips_enable", "enabled": True})
        self.assertFalse(self.config.get("pips_enabled"))
        self.assertEqual(event["type"], "command_rejected")

    def test_runtime_start_and_resume_use_local_seam(self):
        self.config.data["pips_enabled"] = True
        for action in ("start", "resume"):
            with patch("dgc.pip_runtime.start_runtime", return_value={"online": True}) as start:
                event = self.send({"type": "pips_runtime", "action": action, "request_id": action})
            self.assertEqual(event["command"], "pips_runtime")
            self.assertTrue(event["ok"])
            self.assertEqual(start.call_args.kwargs, {"resume": action == "resume"})
            self.assertIsNot(start.call_args.args[0], self.config)

    def test_run_requires_live_supervisor_before_queueing(self):
        self.config.data["pips_enabled"] = True
        with patch("dgc.pip_runtime.require_supervisor", side_effect=RegistryError("runner_offline", "Start the runner")), \
             patch("dgc.pips.handle_control", side_effect=AssertionError("must not enqueue")):
            event = self.control("run_pip", pip_id="pip-one", idempotency_key="one")
        self.assertEqual(event["error"]["code"], "runner_offline")

    def test_all_controls_disable_editor_owned_worker_start(self):
        self.config.data["pips_enabled"] = True
        for command in ("run_pip", "send_pip_message", "accept_pip_handoff", "resume_pip", "list_workspaces"):
            response = {"type": "pips_result", "request_id": "request-one", "command": command, "ok": True, "result": {}}
            with patch("dgc.pip_runtime.require_supervisor") as require, \
                 patch("dgc.pips.handle_control", return_value=response) as handle:
                self.assertTrue(self.control(command)["ok"])
            self.assertEqual(handle.call_args.args[2], "editor-user")
            self.assertEqual(handle.call_args.kwargs, {"start_worker": False})
            self.assertEqual(require.call_count, int(command in ("run_pip", "send_pip_message", "accept_pip_handoff")))


if __name__ == "__main__":
    unittest.main()
