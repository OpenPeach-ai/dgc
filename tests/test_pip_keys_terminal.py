"""pips-10, slice 2c (0.52, D9 b): a Pip's own key in its computer's Terminal, only at Do it all, only if you ticked it.

A key a Personal Pip asked for (pip_keys, a site's key) is sent by DGC to its one site and the Pip never sees it. At Do
it all the card may also offer "Also let its Terminal use it (it could read it there)": ticked, the key is a variable
in the Pip's computer Terminal (INVOICELY_API_KEY), so a script there can use it. The rules:
- the tick is refused below Do it all; and at each command the level is read again: below Do it all, no variable;
- the key never goes on a command line (bwrap's --setenv would show it in the process list): it reaches the box
  through a pipe into a file only the box sees (bwrap --file), read in before the command;
- what the Terminal prints is masked: the key itself never comes back to the Pip or the history.
"""
import json
import os
import unittest
from unittest import mock

from dgc import pip_computer, pip_computer_files as desk, pip_keys, plugin_credentials
from dgc.workspace_registry import RegistryError
from tests.test_pip_computer_desk import BOXES
from tests.test_pip_levels import Store

SECRET = "inv_live_0123456789abcdefTERM"
HOST = "api.invoicely.example"


class TerminalKey(Store):
    def setUp(self):
        super().setUp()
        plugin_credentials.configure("file")
        self.addCleanup(plugin_credentials.configure, "auto")
        self.pip = self.personal(computer=True)
        pip_keys.request(self.registry, self.cfg, self.pip["id"], self.pip["workspace_id"], None,
                         {"name": "Invoicely API key", "why": "Read invoices", "host": HOST})
        self.card = pip_keys.listing(self.registry, self.pip["id"])["keys"][0]

    def save(self, **kw):
        with mock.patch("dgc.pip_chat.continue_after_key"):
            return self.control("save_pip_key", pip_id=self.pip["id"], key_id=self.card["id"], value=SECRET, **kw)

    def level(self, level):
        self.control("set_pip_level", pip_id=self.pip["id"], level=level)

    def test_the_tick_is_refused_below_do_it_all(self):
        with self.assertRaisesRegex(RegistryError, "Do it all"):
            self.save(terminal=True)
        self.assertEqual(pip_keys.listing(self.registry, self.pip["id"])["keys"][0]["status"], "requested",
                         "nothing saved when the tick is refused")

    def test_only_a_ticked_key_at_do_it_all_reaches_the_terminal(self):
        self.level("full")
        self.save(terminal=True)
        card = pip_keys.listing(self.registry, self.pip["id"])["keys"][0]
        self.assertTrue(card["terminal"])
        self.assertEqual(card["terminal_name"], "INVOICELY_API_KEY")
        self.assertEqual(pip_keys.terminal_env(self.registry, self.pip["id"]), {"INVOICELY_API_KEY": SECRET})
        self.level("approve")
        self.assertEqual(pip_keys.terminal_env(self.registry, self.pip["id"]), {}, "read again at each command")
        self.level("full")
        self.assertEqual(set(pip_keys.terminal_env(self.registry, self.pip["id"])), {"INVOICELY_API_KEY"})

    def test_an_unticked_key_never_does(self):
        self.level("full")
        self.save()
        self.assertFalse(pip_keys.listing(self.registry, self.pip["id"])["keys"][0]["terminal"])
        self.assertEqual(pip_keys.terminal_env(self.registry, self.pip["id"]), {})

    def test_the_key_never_goes_on_a_command_line(self):
        argv = desk.terminal_argv(desk.files_root(pip_computer.computer_root(self.registry.directory, self.pip["id"])),
                                  "echo hi", keys_fd=11)
        self.assertIn("--file", argv)
        self.assertEqual(argv[argv.index("--file") + 1], "11")
        self.assertNotIn(SECRET, " ".join(argv))
        self.assertFalse(any(a == "--setenv" and argv[i + 1] == "INVOICELY_API_KEY" for i, a in enumerate(argv[:-1])))

    def test_the_variable_names_are_safe_shell_names(self):
        for name, expected in (("Invoicely API key", "INVOICELY_API_KEY"), ("weather.com token!", "WEATHER_COM_TOKEN"),
                               ("1st key", "KEY_1ST_KEY"), ("PATH", "PIP_KEY_PATH"), ("", "PIP_KEY")):
            self.assertEqual(pip_keys.terminal_name(name), expected, name)

    def test_the_pip_is_told_the_names_and_sites_never_a_value(self):
        self.level("full")
        self.save(terminal=True)
        names = pip_keys.terminal_names(self.registry, self.pip["id"])
        self.assertEqual(names, [{"name": "INVOICELY_API_KEY", "host": HOST}])
        told = pip_keys.terminal_notice(names)
        self.assertIn("$INVOICELY_API_KEY", told)
        self.assertIn(HOST, told)
        self.assertNotIn(SECRET, told)
        self.level("approve")
        self.assertEqual(pip_keys.terminal_names(self.registry, self.pip["id"]), [], "below Do it all it is told none")

    def test_two_keys_with_one_name_are_named_the_same_everywhere(self):
        self.level("full")
        self.save(terminal=True)
        pip_keys.request(self.registry, self.cfg, self.pip["id"], self.pip["workspace_id"], None,
                         {"name": "Invoicely API key", "why": "Read the other account", "host": "eu.invoicely.example"})
        second = next(k for k in pip_keys.listing(self.registry, self.pip["id"])["keys"] if k["host"] == "eu.invoicely.example")
        with mock.patch("dgc.pip_chat.continue_after_key"):
            saved = self.control("save_pip_key", pip_id=self.pip["id"], key_id=second["id"], value=SECRET + "EU", terminal=True)
        env = pip_keys.terminal_env(self.registry, self.pip["id"])
        self.assertEqual(env, {"INVOICELY_API_KEY": SECRET, "INVOICELY_API_KEY_2": SECRET + "EU"})
        told = {n["host"]: n["name"] for n in pip_keys.terminal_names(self.registry, self.pip["id"])}
        cards = {k["host"]: k["terminal_name"] for k in pip_keys.listing(self.registry, self.pip["id"])["keys"]}
        self.assertEqual(told, {HOST: "INVOICELY_API_KEY", "eu.invoicely.example": "INVOICELY_API_KEY_2"})
        self.assertEqual(cards, told, "its card names the variable the Terminal really has")
        self.assertEqual(saved["key"]["terminal_name"], "INVOICELY_API_KEY_2", "and so does the save's answer")

    @unittest.skipUnless(BOXES, "needs Linux and a working bubblewrap")
    def test_in_the_box_the_variable_is_there_and_its_value_is_masked(self):
        root = pip_computer.computer_root(self.registry.directory, self.pip["id"])
        env = {"INVOICELY_API_KEY": SECRET}
        length = desk.run_command(root, 'printf "%s" "$INVOICELY_API_KEY" | wc -c', "pip", env=env)
        self.assertEqual(length["output"].strip(), str(len(SECRET)))
        echoed = desk.run_command(root, 'echo "$INVOICELY_API_KEY"', "pip", env=env)
        self.assertNotIn(SECRET, echoed["output"], "masked in what the Terminal prints")
        history = json.dumps(desk.history(root)) if hasattr(desk, "history") else ""
        self.assertNotIn(SECRET, history)
        without = desk.run_command(root, 'printf "[%s]" "$INVOICELY_API_KEY"', "pip")
        self.assertEqual(without["output"].strip(), "[]", "no key unless given")


if __name__ == "__main__":
    unittest.main()
