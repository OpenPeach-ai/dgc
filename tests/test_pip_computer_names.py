"""pips-17d (0.52, asked 12 Nov): each of a Pip's computers has a name, and you choose which one to open.

"We need to also allow user to be able to name the personal computer Pips get. By default, we randomly name these
computers, but user should be able to rename them ... when user clicks the personal computer icon on Pip chat, it should
give ... a dropdown, to select which computer to open."

Pips API 86: get_pip_computer's `names` [{number, name, named}]: a friendly name of its own (from a list, the same one
every time for that Pip and number, never one another of its computers has) until the user renames it;
rename_pip_computer {pip_id, number, name} ("" gives back the first name; never a name another of its computers has);
open_pip_computer / use_pip_computer_view take an optional `number`: that computer's own live view.
"""
import unittest
from unittest import mock

from dgc import pip_computer
from dgc.workspace_registry import RegistryError
from tests.test_pip_levels import Store


class ComputerNames(Store):
    def setUp(self):
        super().setUp()
        self.pip = self.personal(computer=True)

    def names(self):
        return [{k: n[k] for k in ("number", "name", "named")}
                for n in self.control("get_pip_computer", pip_id=self.pip["id"])["computer"]["names"]]

    def test_each_computer_has_a_friendly_name_that_stays(self):
        first = self.names()
        self.assertEqual(len(first), 1)
        self.assertIn(first[0]["name"], pip_computer.COMPUTER_NAMES)
        self.assertEqual((first[0]["number"], first[0]["named"]), (1, False))
        added = self.control("add_pip_computer", pip_id=self.pip["id"])
        self.assertEqual(added["name"], added["names"][1]["name"], "the new one's name comes with the answer")
        both = self.names()
        self.assertEqual([n["number"] for n in both], [1, 2])
        self.assertNotEqual(both[0]["name"], both[1]["name"])
        self.assertEqual(both[0]["name"], first[0]["name"], "adding one never renames another")
        self.assertEqual(self.names(), both, "the same every time")

    def test_you_can_rename_one_and_give_back_its_first_name(self):
        self.control("add_pip_computer", pip_id=self.pip["id"])
        given = self.names()[1]["name"]
        renamed = self.control("rename_pip_computer", pip_id=self.pip["id"], number=2, name="  Studio   Mac ")
        self.assertEqual(renamed["name"], "Studio Mac")
        self.assertEqual(self.names()[1], {"number": 2, "name": "Studio Mac", "named": True})
        self.control("rename_pip_computer", pip_id=self.pip["id"], number=2, name="")
        self.assertEqual(self.names()[1], {"number": 2, "name": given, "named": False})

    def test_two_of_its_computers_never_share_a_name(self):
        self.control("add_pip_computer", pip_id=self.pip["id"])
        first, second = self.names()
        self.control("rename_pip_computer", pip_id=self.pip["id"], number=2, name="Studio")
        with self.assertRaisesRegex(RegistryError, "Another of its computers"):
            self.control("rename_pip_computer", pip_id=self.pip["id"], number=1, name="STUDIO")
        self.control("rename_pip_computer", pip_id=self.pip["id"], number=2, name="")
        # Taking the other one's friendly name moves that one to a different friendly name.
        self.control("rename_pip_computer", pip_id=self.pip["id"], number=1, name=second["name"])
        now = self.names()
        self.assertEqual(now[0]["name"], second["name"])
        self.assertNotEqual(now[1]["name"].casefold(), second["name"].casefold())
        self.assertIn(now[1]["name"], pip_computer.COMPUTER_NAMES)

    def test_a_name_is_plain_words_and_names_a_computer_it_has(self):
        for bad in ("<b>x</b>", "x" * 31, "-dash first", "semi;colon"):
            with self.assertRaises(RegistryError, msg=bad):
                self.control("rename_pip_computer", pip_id=self.pip["id"], number=1, name=bad)
        for number in (0, 2, "1", True):
            with self.assertRaises(RegistryError, msg=repr(number)):
                self.control("rename_pip_computer", pip_id=self.pip["id"], number=number, name="Desk")
        with self.assertRaises(RegistryError) as caught:
            self.control("rename_pip_computer", actor="device_1", pip_id=self.pip["id"], number=1, name="Desk")
        self.assertEqual(caught.exception.code, "local_only")
        self.control("rename_pip_computer", pip_id=self.pip["id"], number=1, name="Mom's laptop (2)")
        self.assertEqual(self.names()[0]["name"], "Mom's laptop (2)")


class ComputerStates(Store):
    """The dots beside each computer (asked 12 Nov): closed, open (its screen is open in a tab), working (a reply has
    it, with what it is doing) or needs_you (that reply waits for the user: an approval, or a check on its screen)."""

    def setUp(self):
        super().setUp()
        self.pip = self.personal(computer=True)
        self.control("add_pip_computer", pip_id=self.pip["id"])

    def states(self):
        return {n["number"]: (n["state"], n.get("doing", "")) for n in
                self.control("get_pip_computer", pip_id=self.pip["id"])["computer"]["names"]}

    def take(self, number, run_id, label="Find a flat in Pune"):
        class Host:
            pass
        host = Host()
        host.state_directory, host.pip_id, host.number, host.label, host.id = (
            self.registry.directory, self.pip["id"], number, label, f"host_{number}")
        pip_computer.Host._say_at_work(host, run_id)
        return host

    def a_run(self):
        run = self.control("send_pip_message", pip_id=self.pip["id"], text="Look at flats for me",
                           idempotency_key="flats-" + str(len(self.registry.db.execute("SELECT id FROM pip_runs").fetchall())))["run"]["id"]
        self.registry.db.execute("UPDATE pip_runs SET status='running' WHERE id=?", (run,))
        return run

    def test_closed_open_working_and_needs_you(self):
        self.assertEqual(self.states(), {1: ("closed", ""), 2: ("closed", "")})
        with self.registry.transaction():
            self.registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
                                     (pip_computer._view_key(self.pip["id"], 2), '{"socket": "/run/v", "token": "t"}'))
        self.assertEqual(self.states()[2], ("open", ""))
        run = self.a_run()
        host = self.take(1, run)
        self.assertEqual(self.states()[1], ("working", "Find a flat in Pune"))
        with self.registry.transaction():
            self.registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (pip_computer.NEEDS_YOU + self.pip["id"],
                                     '{"host": "accounts.example", "at": "now", "run_id": "%s"}' % run))
        self.assertEqual(self.states()[1][0], "needs_you", "a check on its screen only a person can pass")
        self.assertEqual(self.states()[2][0], "open", "the other one is not the one waiting")
        pip_computer.Host._say_at_work(host, None)
        self.assertEqual(self.states()[1][0], "closed", "its run let it go")

    def test_closing_its_tab_reads_closed_at_once_and_the_supervisor_closes_the_view(self):
        with self.registry.transaction():
            self.registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)",
                                     (pip_computer._view_key(self.pip["id"], 2), '{"socket": "/run/v", "token": "t"}'))
        self.assertEqual(self.states()[2], ("open", ""))
        done = self.control("use_pip_computer_view", pip_id=self.pip["id"], op="close", number=2)
        self.assertEqual(done["view"], {"ok": True, "closed": True})
        self.assertEqual(self.states()[2], ("closed", ""), "no ten minutes of Open after its tab is gone")
        key = f"computer_close_view:{self.pip['id']}:2"
        self.assertIsNotNone(self.registry.db.execute("SELECT 1 FROM metadata WHERE key=?", (key,)).fetchone())
        closed = []
        class Viewer:
            last_used = __import__("time").monotonic()
            def endpoint(self): return {"socket": "/run/v", "token": "t"}
            def close(self): closed.append(True)
        class Host:
            pass
        host = Host()
        host.pip_id, host.number, host.viewer = self.pip["id"], 2, Viewer()
        from unittest.mock import patch
        with patch.dict(pip_computer.HOSTS, {("k",): host}, clear=True):
            pip_computer.handle_opens(self.registry)
        self.assertEqual((closed, host.viewer), ([True], None))
        self.assertIsNone(self.registry.db.execute("SELECT 1 FROM metadata WHERE key=?", (key,)).fetchone())
        with self.assertRaises(pip_computer.RegistryError):
            self.control("use_pip_computer_view", actor="device_1", pip_id=self.pip["id"], op="close", number=2)

    def test_a_record_left_by_a_run_that_ended_reads_as_not_working(self):
        run = self.a_run()
        self.take(2, run)
        self.assertEqual(self.states()[2][0], "working")
        self.registry.db.execute("UPDATE pip_runs SET status='succeeded' WHERE id=?", (run,))
        self.assertEqual(self.states()[2][0], "closed")


class OpenWhichComputer(Store):
    """The live view of the computer you chose: each computer its own view; an open that names none acts as before."""

    def setUp(self):
        super().setUp()
        self.pip = self.personal(computer=True)
        self.control("add_pip_computer", pip_id=self.pip["id"])

    def supervisor(self):
        made = {}

        class Host:
            def __init__(self, number):
                import threading
                self.lock, self.viewer, self.run_id, self.number, self.pip_id = threading.Lock(), None, None, number, self_pip

        class Viewer:
            def __init__(self, host):
                self.host = host

            def endpoint(self):
                return {"socket": f"/run/view-{self.host.number}", "token": "t", "host_id": f"h{self.host.number}"}

        self_pip = self.pip["id"]

        def host_for(_directory, pip_id, _workspace, number=1):
            return made.setdefault(number, Host(number))
        return made, mock.patch.multiple(pip_computer, host_for=host_for, ViewServer=Viewer, hosts_of=lambda _pip: [])

    def test_opening_the_second_one_shows_its_own_view(self):
        made, patched = self.supervisor()
        opened = self.control("open_pip_computer", pip_id=self.pip["id"], number=2)["view"]
        self.assertEqual((opened["ready"], opened["number"]), (False, 2))
        self.assertEqual(opened["name"], self.control("get_pip_computer", pip_id=self.pip["id"])["computer"]["names"][1]["name"])
        with patched:
            pip_computer.handle_opens(self.registry)
        self.assertEqual(list(made), [2], "the second computer, not the first")
        view = pip_computer.view_endpoint(self.registry, self.pip["id"], 2)
        self.assertEqual(view["socket"], "/run/view-2")
        self.assertIsNone(pip_computer.view_endpoint(self.registry, self.pip["id"], 1), "the first one's view is its own")
        again = self.control("open_pip_computer", pip_id=self.pip["id"], number=2)["view"]
        self.assertTrue(again["ready"])
        self.assertNotIn("socket", again)
        self.assertNotIn("token", again)

    def test_an_open_that_names_none_acts_as_before(self):
        made, patched = self.supervisor()
        self.control("open_pip_computer", pip_id=self.pip["id"])
        with patched:
            pip_computer.handle_opens(self.registry)
        self.assertEqual(list(made), [1])
        self.assertEqual(pip_computer.view_endpoint(self.registry, self.pip["id"])["socket"], "/run/view-1")

    def test_a_computer_it_does_not_have_is_refused(self):
        for number in (3, 0, "2"):
            with self.assertRaises(RegistryError, msg=repr(number)):
                self.control("open_pip_computer", pip_id=self.pip["id"], number=number)
        with self.assertRaises(RegistryError):
            self.control("use_pip_computer_view", pip_id=self.pip["id"], op="look", number=5)

    def test_closing_one_view_leaves_the_other(self):
        made, patched = self.supervisor()
        for number in (1, 2):
            self.control("open_pip_computer", pip_id=self.pip["id"], number=number)
        with patched:
            pip_computer.handle_opens(self.registry)
        with mock.patch.object(pip_computer, "ViewServer", None):
            made[2].viewer.close = lambda: None
            pip_computer.close_view(self.registry, made[2])
        self.assertIsNone(pip_computer.view_endpoint(self.registry, self.pip["id"], 2))
        self.assertEqual(pip_computer.view_endpoint(self.registry, self.pip["id"], 1)["socket"], "/run/view-1")


class ComputerNamesSDK(unittest.TestCase):
    def test_the_sdks_know_the_command_and_gate_number_on_86(self):
        import sys
        sys.path.insert(0, "sdk/python")
        sys.path.insert(0, "tests")
        from test_dgc_sdk_pips import CAPS, Wire, session
        from dgc_sdk import DGCConfigError, DGCUnsupportedError
        from dgc_sdk.pips import COMMAND_FIELDS, MUTATION_COMMANDS
        from dgc.pips import _COMMAND_ARGS
        for name in ("rename_pip_computer", "open_pip_computer", "use_pip_computer_view"):
            self.assertEqual(COMMAND_FIELDS[name], _COMMAND_ARGS[name], name)
        self.assertIn("rename_pip_computer", MUTATION_COMMANDS)
        pip = "pip_" + "a" * 32
        wire = Wire(); old = session(wire, caps={**CAPS, "pips_api_version": 85})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 86"):
            old.pips.mutate("rename_pip_computer", {"pip_id": pip, "number": 1, "name": "Desk"}, approved=True)
        with self.assertRaisesRegex(DGCUnsupportedError, "API 86"):
            old.pips.mutate("open_pip_computer", {"pip_id": pip, "number": 2}, approved=True)
        self.assertFalse(wire.calls)
        wire = Wire(); current = session(wire, caps={**CAPS, "pips_api_version": 86})
        sent = current.pips.mutate("rename_pip_computer", {"pip_id": pip, "number": 2, "name": "Studio"}, approved=True)["request"]
        self.assertEqual((sent["number"], sent["name"]), (2, "Studio"))
        for bad in ({"number": "2", "name": "x"}, {"number": 0, "name": "x"}, {"number": 1, "name": "x" * 31}):
            with self.assertRaises(DGCConfigError, msg=repr(bad)[:40]):
                current.pips.mutate("rename_pip_computer", {"pip_id": pip, **bad}, approved=True)


if __name__ == "__main__":
    unittest.main()
