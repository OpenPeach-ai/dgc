"""A Pulse or Patch on a computer whose command sandbox can't start (stock Ubuntu 23.10+ AppArmor).

ERP session review (2026-10-18): a heartbeat Pulse of two local page checks was accepted on Ubuntu 24.04, where
bubblewrap may not make user namespaces, then put off every 30 seconds (43 times in 21 minutes) with no word to the
user, while the model said it was working. Here the real capability() code runs with its probe made to fail the way
that machine's did; everything else is real: the registry, the setup card, the scheduler, the digest, the desktop
notifier, the model's Pip status, a local HTTP server for the page checks.
"""
import http.server
import io
import json
import threading
import unittest
from unittest.mock import patch

from dgc import pip_context_tool, pip_digest, pip_execution, pip_schedules as schedules, pip_setup, pips
from dgc import pip_desktop as desktop
from dgc.pip_computer_box import UBUNTU_BWRAP_PROFILE
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pip_setup as setup_fixture


def command_plan():
    return {'schema_version': 1, 'action': {'kind': 'test', 'network': False,
            'tests': [{'argv': ['/usr/bin/python3', '-c', 'print("smoke")'], 'cwd': '.'}]}}


def http_plan(port, checks=(('/auth/me', '401'), ('/', '200'))):
    return {'schema_version': 1, 'action': {'kind': 'test', 'network': 'loopback_http_v1',
            'tests': [{'argv': ['dgc-http-check', f'http://127.0.0.1:{port}{path}', status], 'cwd': '.'}
                      for path, status in checks]}}


class ERPApp(http.server.BaseHTTPRequestHandler):
    """The ERP heartbeat's two checks: /auth/me answers 401 (the backend answered), / answers 200."""
    def do_GET(self):
        code = 401 if self.path == '/auth/me' else 200
        body = b'{"detail":"Not authenticated"}' if code == 401 else b'<html>app</html>'
        self.send_response(code)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class UbuntuAppArmor:
    """capability() as it ran on that machine: bubblewrap installed, its namespace probe refused, and the kernel's
    apparmor_restrict_unprivileged_userns switch on. The real capability() and machine_fix() run."""
    def __init__(self, case):
        for target in (patch.object(pip_execution, '_probe_bwrap', return_value=False),
                       patch('dgc.browser_setup.userns_restricted', return_value=True)):
            target.start()
            case.addCleanup(target.stop)
        pip_execution._PROBE_CACHE.clear()
        case.addCleanup(pip_execution._PROBE_CACHE.clear)


@unittest.skipUnless(pip_execution._backend() == 'bwrap', 'the Linux sandbox path')
class CapabilityTests(unittest.TestCase):
    def setUp(self):
        UbuntuAppArmor(self)

    def test_the_reason_names_the_apparmor_cause_and_its_one_time_fix(self):
        found = pip_execution.capability()
        self.assertFalse(found['available'])
        for words in ('Ubuntu 23.10 and later', 'AppArmor', 'bubblewrap', 'dgc pips execution --fix',
                      'local page checks (dgc-http-check) need no sandbox'):
            self.assertIn(words, found['reason'])
        self.assertEqual(found['fix'], {'command': 'dgc pips execution --fix', 'runs': UBUNTU_BWRAP_PROFILE},
                         'the same fix DGC already gives for a Pip computer')
        self.assertTrue(found['local_http_checks'])

    def test_a_failed_probe_is_tried_again_after_a_minute(self):
        # The supervisor lives for days: a machine fixed with --fix must not need it restarted.
        clock = [1000.0]
        with patch.object(pip_execution.time, 'monotonic', lambda: clock[0]):
            self.assertFalse(pip_execution.capability()['available'])
            with patch.object(pip_execution, '_probe_bwrap', return_value=True):
                self.assertFalse(pip_execution.capability()['available'], 'within the minute: the cached answer')
                clock[0] += pip_execution.FAILED_PROBE_SECONDS
                self.assertTrue(pip_execution.capability()['available'])

    def test_only_dgcs_own_page_checks_skip_the_sandbox(self):
        self.assertFalse(pip_execution.sandbox_required(http_plan(3090)['action']))
        self.assertTrue(pip_execution.sandbox_required(command_plan()['action']))
        self.assertTrue(pip_execution.sandbox_required({'kind': 'patch', 'write_paths': ['a.py'], 'tests': []}))
        self.assertTrue(pip_execution.sandbox_required({'kind': 'test', 'network': 'loopback_http_v1',
                                                        'tests': [{'argv': ['python3', '-c', 'x'], 'cwd': '.'}]}),
                        'anything the HTTP validator refuses is not a page check')
        with self.assertRaisesRegex(RegistryError, 'Ubuntu 23.10'):
            pip_execution.require_capability()

    def test_fix_shows_the_commands_and_runs_them_only_when_the_user_says_yes(self):
        said, ran = [], []
        with patch.object(pip_execution.sys.stdin, 'isatty', return_value=False):
            self.assertEqual(pip_execution.fix_machine(out=said.append, run=ran.append), 1)
        self.assertEqual(ran, [], 'no terminal: nothing is run')
        self.assertIn('  sudo apt install apparmor-profiles', said)
        self.assertIn('Run those commands in a terminal', said[-1])
        said.clear()
        self.assertEqual(pip_execution.fix_machine(out=said.append, run=lambda argv: ran.append(argv) or 0,
                                                   ask=lambda prompt: 'n'), 1)
        self.assertEqual(ran, [])
        self.assertIn('Nothing was changed.', said)
        fixed = {'yes': False}

        def run(argv):
            ran.append(argv)
            if argv[1] == 'apparmor_parser':
                fixed['yes'] = True
            return 0
        with patch.object(pip_execution, '_probe_bwrap', side_effect=lambda *a: fixed['yes']):
            self.assertEqual(pip_execution.fix_machine(out=said.append, run=run, ask=lambda prompt: 'y'), 0)
        self.assertEqual([' '.join(step) for step in ran], UBUNTU_BWRAP_PROFILE.split(' && '))
        self.assertIn('Pulse and Patch commands can run on this computer now.', said)
        said.clear()
        with patch.object(pip_execution, '_probe_bwrap', return_value=True):
            pip_execution._PROBE_CACHE.clear()
            self.assertEqual(pip_execution.fix_machine(out=said.append, run=ran.append), 0)
        self.assertIn('Nothing to fix.', said[0])

    def test_the_model_shell_and_a_chat_never_run_the_fix(self):
        from dgc import pip_cli
        args = pip_cli.parser().parse_args(['execution', '--fix'])
        self.assertFalse(pip_cli.agent_shell_allows(args))
        self.assertTrue(pip_cli.agent_shell_allows(pip_cli.parser().parse_args(['execution'])))

    def test_doctor_and_setup_say_it_once(self):
        from dgc.cli import pips_sandbox_note
        note = pips_sandbox_note()
        self.assertIn("Ubuntu's AppArmor blocks bubblewrap's user namespaces", note)
        self.assertIn('dgc pips execution --fix', note)
        with patch('dgc.browser_setup.userns_restricted', return_value=False):
            self.assertEqual(pips_sandbox_note(), '', 'no known cause: no line')


@unittest.skipUnless(pip_execution._backend() == 'bwrap', 'the Linux sandbox path')
class PulseOnThisMachineTests(unittest.TestCase):
    """Setup, schedule and status for Pulses on a machine whose sandbox can't start."""
    git = setup_fixture.PipSetupTests.git
    commit = setup_fixture.PipSetupTests.commit
    draft = setup_fixture.PipSetupTests.draft
    review = setup_fixture.PipSetupTests.review
    tool = setup_fixture.PipSetupTests.tool

    def setUp(self):
        setup_fixture.PipSetupTests.setUp(self)
        UbuntuAppArmor(self)

    def request(self, **changes):
        return setup_fixture.PipSetupTests.request(self, **{
            'pip_type': 'pulse', 'work_kind': 'command_verification', 'verification_plan': command_plan(),
            'schedule': {'type': 'interval', 'minutes': 30}, 'run_now': False, 'name': 'ERP smoke test', **changes})

    def server(self):
        app = http.server.ThreadingHTTPServer(('127.0.0.1', 0), ERPApp)
        threading.Thread(target=app.serve_forever, daemon=True).start()
        self.addCleanup(app.server_close)
        self.addCleanup(app.shutdown)
        return app.server_address[1]

    def at(self, stamp):
        self.now = stamp
        return stamp

    def test_the_setup_card_and_the_model_are_told_it_cant_run_here(self):
        result = self.tool(self.request())
        card = result['setup']
        self.assertTrue(card['runner_notice'].startswith('It can’t run on this computer yet: Ubuntu 23.10'))
        self.assertIn('dgc pips execution --fix', card['runner_notice'])
        self.assertLessEqual(len(card['runner_notice']), 2000, 'the editor card shows at most 2000 characters')
        self.assertIn('Ubuntu 23.10', result['cannot_run_here'])
        self.assertIn("never say it is working", result['message'])
        accepted = self.review(pip_setup.get(self.registry, card['id'], self.workspace['id']))
        self.assertEqual(accepted['status'], 'accepted', 'accepting is still the user’s choice')
        self.assertIn('It can’t run on this computer yet', accepted['runner_notice'])

    def test_a_card_of_local_page_checks_says_nothing_of_the_kind(self):
        card = self.tool(self.request(work_kind='app_smoke_test', verification_plan=http_plan(3090)))['setup']
        self.assertNotIn('can’t run', card['runner_notice'])

    def test_a_page_check_heartbeat_runs_with_no_sandbox_and_no_copy_of_the_code(self):
        port = self.server()
        card = self.draft(self.request(work_kind='app_smoke_test', verification_plan=http_plan(port), run_now=True))
        accepted = self.review(card)          # run_now: the sandbox gate used to refuse this outright
        run_id = accepted['receipt']['run_id']
        row = self.store.claim_next()
        self.assertEqual(row['id'], run_id)
        result = pips._execute_run(self.registry, row, self.cfg)
        finished = self.store.finish(run_id, result=result)
        self.assertEqual(finished['status'], 'succeeded')
        self.assertEqual([c['outcome']['status'] for c in finished['result']['commands']], ['passed', 'passed'])
        self.assertIn('PASS: HTTP 401', finished['result']['commands'][0]['outcome']['output'])
        self.assertEqual((finished['result']['snapshot']['files'], finished['result']['snapshot']['bytes']), (0, 0))
        self.assertFalse((self.registry.directory / 'runs' / run_id / 'source').exists(), 'no copy of the code')

    def test_a_scheduled_page_check_is_queued_not_put_off(self):
        port = self.server()
        self.review(self.draft(self.request(work_kind='app_smoke_test', verification_plan=http_plan(port))))
        self.at('2026-10-02T06:05:00.000Z')
        self.assertEqual(schedules.tick(self.registry, self.cfg)['enqueued'], 1)
        self.assertEqual(self.deferred(), [])

    def deferred(self):
        return [json.loads(row[0]) for row in self.registry.db.execute(
            "SELECT payload FROM workspace_events WHERE event_type='pip_schedule_deferred' ORDER BY seq")]

    def test_a_command_pulse_backs_off_alerts_once_and_says_why_in_its_status(self):
        pip_id = self.review(self.draft(self.request()))['receipt']['pip_id']
        notifier_clock = [1000.0]
        shown = []
        notifier = desktop.Notifier(self.cfg, clock=lambda: notifier_clock[0],
                                    send=lambda title, body: shown.append(body) or True)
        from datetime import datetime, timedelta, timezone
        start = datetime(2026, 10, 2, 6, 0, 30, tzinfo=timezone.utc)

        def tick_at(seconds):
            self.at(schedules.timestamp(start + timedelta(seconds=seconds)))
            return schedules.tick(self.registry, self.cfg)['deferred']
        # Before: a deferral every 30 seconds, forever. Now 30 s, then 60, 120, 240 ... at most an hour.
        # Tried at 0 s, 30 s later, then 60 s, 120 s and 240 s after each try: 0, 30, 90, 210 and 450.
        ticks = [tick_at(s) for s in (0, 30, 60, 90, 120, 180, 210, 300, 420, 450)]
        self.assertEqual(ticks, [1, 1, 0, 1, 0, 0, 1, 0, 0, 1])
        events = self.deferred()
        self.assertEqual([e['attempt'] for e in events], [1, 2, 3, 4, 5])
        self.assertEqual([e['retry_after_seconds'] for e in events], [30, 60, 120, 240, 480])
        self.assertEqual([e.get('alert') for e in events], [None, None, True, None, None], 'the alert is raised once')
        self.assertEqual({e['code'] for e in events}, {'execution_unavailable'})
        self.assertEqual(schedules.retry_delay(40), schedules.MAX_RETRY_SECONDS)
        # The user sees it: the digest alerts once, and the desktop says it once.
        digest = pip_digest.build(self.registry, self.cfg)
        self.assertEqual(digest['reason'], 'alert')
        self.assertIn("ERP smoke test can't run on this computer", digest['headline'])
        self.assertIn('dgc pips execution --fix', digest['headline'])
        pip_digest.mark_seen(self.registry, digest['until'], 'editor-user')
        tick_at(1200)
        again = pip_digest.build(self.registry, self.cfg)
        self.assertNotEqual(again['reason'], 'alert', 'seen once: not an alert again for the same episode')
        self.assertIn("ERP smoke test can't run on this computer", again['headline'], 'still said while it lasts')
        notifier_clock[0] += 120
        self.assertIn("ERP smoke test can't run on this computer", notifier.tick(self.registry))
        tick_at(1800)
        notifier_clock[0] += 120
        self.assertIsNone(notifier.tick(self.registry), 'never once per retry')
        self.assertEqual(len(shown), 1)
        # And the model learns it from the Pip's status.
        ctx = type('Ctx', (), {'config': self.cfg, 'project_root': self.root})()
        with patch.object(pip_context_tool, 'WorkspaceRegistry',
                          lambda: WorkspaceRegistry(self.registry.directory, clock=lambda: self.now)):
            listed = json.loads(pip_context_tool.read({'action': 'list'}, ctx))
        item = next(p for p in listed['pips'] if p['id'] == pip_id)
        self.assertTrue(item['cannot_run_here'].startswith("can't run here: "))
        self.assertIn('Ubuntu 23.10', listed['execution_notice'], 'the reason and its fix, once per list')
        self.assertIn('dgc pips execution --fix', listed['execution_notice'])
        self.assertEqual(item['schedule_deferred']['code'], 'execution_unavailable')
        self.assertGreaterEqual(item['schedule_deferred']['attempts'], 5)
        with patch.object(pip_context_tool, 'WorkspaceRegistry',
                          lambda: WorkspaceRegistry(self.registry.directory, clock=lambda: self.now)):
            one = json.loads(pip_context_tool.read({'action': 'definition', 'pip_id': pip_id}, ctx))['pip']
        self.assertIn('Ubuntu 23.10', one['cannot_run_here'], "one Pip's status says why in full")
        # Fixed: the next try starts it, and the record of the episode is gone.
        with patch.object(pip_execution, '_probe_bwrap', return_value=True):
            pip_execution._PROBE_CACHE.clear()
            self.at('2026-10-02T09:00:00.000Z')
            self.assertEqual(schedules.tick(self.registry, self.cfg)['enqueued'], 1)
            self.assertIsNone(schedules.deferral_status(self.registry, pip_id))
            self.assertEqual(schedules.blocked_schedules(self.registry), [])


if __name__ == '__main__':
    unittest.main()
