"""Dev Mode lifts DGC's capacity limits (0.52, asked 7 and 10 Nov: "imagine a B300 server ... Dev Mode removes every
limitation"). Off by default: every limit keeps today's default and ceiling. On, each limit is a whole number you set,
1 or more, with no ceiling; safety limits never move. dgc/dev_mode.py is the one table and the one reader."""
import json
import os
import pwd
import sys
import tempfile
import unittest
from pathlib import Path

_REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir
if "dgc.config" in sys.modules:
    import dgc.config as _config
    if Path(_config.USER_HOME) == Path(_REAL_HOME) or Path(_REAL_HOME) in Path(_config.USER_HOME).parents:
        raise RuntimeError("tests/test_dev_mode.py needs HOME redirected before dgc is imported")
else:
    _HOME = tempfile.TemporaryDirectory(prefix="dgc-dev-mode-home-")
    for _var in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
        os.environ[_var] = _HOME.name

from dgc import dev_mode  # noqa: E402


class Settings(dict):
    def get(self, key, default=None):
        return super().get(key, default)


class TableTests(unittest.TestCase):
    def test_every_limit_has_a_default_a_ceiling_a_place_and_a_cost_line(self):
        names = [limit.name for limit in dev_mode.LIMITS]
        self.assertEqual(len(names), len(set(names)), "one row a limit")
        for limit in dev_mode.LIMITS:
            with self.subTest(limit=limit.name):
                self.assertRegex(limit.name, r"^[a-z][a-z0-9_]{2,40}$")
                self.assertGreaterEqual(limit.default, 1)
                self.assertTrue(limit.ceiling is None or limit.ceiling >= limit.default)
                self.assertTrue(limit.label and limit.cost and limit.where)
                self.assertNotIn(" AI ", f" {limit.label} {limit.cost} ")
        for first in ("pips_parallel_runs", "pip_computers", "pip_conversations", "payments_a_day",
                      "monitors_per_chat", "monitors_per_dgc"):
            self.assertIn(first, names)

    def test_off_every_limit_is_todays(self):
        off = Settings(dev_mode=False, dev_limits={"pip_computers": 40, "monitors_per_chat": 99})
        self.assertEqual(dev_mode.value("pip_computers", off), 3)
        self.assertEqual(dev_mode.value("monitors_per_chat", off), 4)
        self.assertFalse(dev_mode.on(off))

    def test_on_each_limit_is_yours_with_no_ceiling_and_a_bad_value_is_ignored(self):
        on = Settings(dev_mode=True, dev_limits={"pip_computers": 40, "pips_parallel_runs": 500, "monitors_per_chat": 0,
                                                 "pip_conversations": "lots", "payments_a_day": True})
        self.assertTrue(dev_mode.on(on))
        self.assertEqual(dev_mode.value("pip_computers", on), 40)
        self.assertEqual(dev_mode.value("pips_parallel_runs", on), 500, "past the usual ceiling of 32")
        for name, default in (("monitors_per_chat", 4), ("pip_conversations", 500), ("payments_a_day", 3)):
            self.assertEqual(dev_mode.value(name, on), default, f"{name}: not a whole number of 1 or more")
        with self.assertRaises(KeyError):
            dev_mode.value("sandbox", on)

    def test_the_ceiling_without_dev_mode(self):
        self.assertEqual(dev_mode.ceiling("pips_parallel_runs", Settings(dev_mode=False)), 32)
        self.assertIsNone(dev_mode.ceiling("pips_parallel_runs", Settings(dev_mode=True)))

    def test_with_no_settings_handed_over_it_reads_dgcs_own(self):
        from dgc.config import USER_CONFIG
        USER_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        USER_CONFIG.write_text(json.dumps({"dev_mode": True, "dev_limits": {"pip_computers": 12}}))
        self.addCleanup(lambda: USER_CONFIG.unlink(missing_ok=True))
        self.assertEqual(dev_mode.value("pip_computers"), 12)
        USER_CONFIG.write_text(json.dumps({"dev_mode": False, "dev_limits": {"pip_computers": 12}}))
        os.utime(USER_CONFIG, (os.path.getmtime(USER_CONFIG) + 2,) * 2)
        self.assertEqual(dev_mode.value("pip_computers"), 3, "read again when the file changes")

    def test_settings_check_what_is_saved(self):
        self.assertEqual(dev_mode.clean_limits({"pip_computers": 9, "nope": 3, "monitors_per_chat": 0}),
                         ({"pip_computers": 9}, ["nope: not a Dev Mode limit", "monitors_per_chat: a whole number, 1 or more"]))


if __name__ == "__main__":
    unittest.main()


class WiredTests(unittest.TestCase):
    """The first limits read through dev_mode: each one rises in Dev Mode and stays put without it."""

    def settings(self, on, **limits):
        from unittest.mock import patch
        return patch.object(dev_mode, "_settings", return_value={"dev_mode": on, "dev_limits": limits})

    def test_pip_runs_at_once_lose_their_ceiling(self):
        from dgc import pips
        on = Settings(dev_mode=True, pips_parallel_runs=200)
        off = Settings(dev_mode=False, pips_parallel_runs=200)
        self.assertEqual(pips.parallel_runs(off), 32)
        self.assertEqual(pips.parallel_runs(on), 200)
        # The number set on Settings → Dev Mode is the one in force (not only the old setting with its ceiling lifted).
        self.assertEqual(pips.parallel_runs(Settings(dev_mode=True, pips_parallel_runs=4, dev_limits={"pips_parallel_runs": 64})), 64)
        self.assertEqual(pips.parallel_runs(Settings(dev_mode=False, pips_parallel_runs=4, dev_limits={"pips_parallel_runs": 64})), 4)

    def test_monitors_per_chat_and_per_dgc(self):
        from dgc import monitors
        with self.settings(False, monitors_per_chat=9, monitors_per_dgc=40):
            self.assertEqual((monitors.max_per_owner(), monitors.max_process()), (4, 16))
        with self.settings(True, monitors_per_chat=9, monitors_per_dgc=40):
            self.assertEqual((monitors.max_per_owner(), monitors.max_process()), (9, 40))

    def test_conversations_and_computers_per_pip(self):
        import sqlite3
        from dgc import pip_computer, pip_conversations
        db = sqlite3.connect(":memory:")
        db.execute("CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT)")
        with self.settings(False, pip_conversations=2000, pip_computers=8):
            self.assertEqual((pip_conversations.max_conversations(), pip_computer.computers_limit(db)), (500, 3))
        with self.settings(True, pip_conversations=2000, pip_computers=8):
            self.assertEqual((pip_conversations.max_conversations(), pip_computer.computers_limit(db)), (2000, 8))
            db.execute("INSERT INTO metadata VALUES(?,?)", (pip_computer.COMPUTERS_LIMIT_KEY, "100"))
            self.assertEqual(pip_computer.computers_limit(db), 100, "a registry's own setting still wins")

    def test_payments_a_day_may_go_past_twenty_only_in_dev_mode(self):
        from dgc import pip_levels
        with self.settings(False):
            self.assertEqual(pip_levels.pay_most(), 20)
        with self.settings(True):
            self.assertEqual(pip_levels.pay_most(), 1_000_000, "no real ceiling")


class SettingTests(unittest.TestCase):
    def test_settings_take_the_switch_and_the_limits_and_refuse_what_is_not_one(self):
        from dgc.config import DEFAULTS
        from dgc.headless import _validated_config_values
        self.assertIs(DEFAULTS["dev_mode"], False, "off by default")
        self.assertEqual(DEFAULTS["dev_limits"], {})
        values, error = _validated_config_values({"dev_mode": True, "dev_limits": {"pip_computers": 8}}, ())
        self.assertIsNone(error)
        self.assertEqual(values["dev_limits"], {"pip_computers": 8})
        for bad, said in (({"dev_mode": "yes"}, "dev_mode must be true or false"),
                          ({"dev_limits": {"sandbox": 1}}, "sandbox: not a Dev Mode limit"),
                          ({"dev_limits": {"pip_computers": 0}}, "pip_computers: a whole number, 1 or more"),
                          ({"dev_limits": []}, "dev_limits must be an object")):
            with self.subTest(bad=bad):
                self.assertEqual(_validated_config_values(bad, ())[1], said)


class MoreWiredTests(unittest.TestCase):
    settings = WiredTests.settings

    def test_queued_pip_runs_and_routines_per_pip(self):
        from dgc import pip_routines, pips
        with self.settings(False, pip_queue=200, pip_routines=50):
            self.assertEqual((pips.max_queue(), pip_routines.max_routines()), (20, 10))
        with self.settings(True, pip_queue=200, pip_routines=50):
            self.assertEqual((pips.max_queue(), pip_routines.max_routines()), (200, 50))


class EditorTests(unittest.TestCase):
    def test_the_editor_is_told_the_limits_in_ready_capabilities(self):
        # Settings → Dev Mode draws its Limits group from DGC's own table: a new key in ready.capabilities (an open
        # object), never a new field on the ready event.
        import inspect
        from dgc import headless
        self.assertIn('"dev_limits": dev_mode_limits()', inspect.getsource(headless))
        rows = headless.dev_mode_limits()
        self.assertEqual([r["name"] for r in rows], [limit.name for limit in dev_mode.LIMITS])
        self.assertEqual(set(rows[0]), {"name", "label", "default", "ceiling", "cost"})


class ConfigEventTests(unittest.TestCase):
    def test_a_client_that_asks_is_told_the_switch_and_the_limits(self):
        # Settings → Dev Mode shows what DGC holds (a change from the terminal or another window shows too): opt-in
        # fields on the config event, sent only to a client that asks (get_config fields), like fallback_engine.
        from dgc import editor_protocol as ep, headless
        self.assertIn("dev_mode", headless._CONFIG_OPT_IN_FIELDS)
        self.assertIn("dev_limits", headless._CONFIG_OPT_IN_FIELDS)
        base = {"seq": 1, "type": "config", "model": "m", "mode": "default", "think": "off", "base_url": "u",
                "project_root": "/p", "goal": {}}
        self.assertIsNone(ep.event_error({**base, "dev_mode": True, "dev_limits": {"pip_computers": 8}}))
        self.assertIsNotNone(ep.event_error({**base, "dev_mode": "yes"}))
        sent = {}
        backend = object.__new__(headless.Backend)
        backend.config = Settings(model="m", mode="default", dev_mode=True, dev_limits={"pip_computers": 8, "bogus": 2})
        backend._config_fields = frozenset({"dev_mode", "dev_limits"})
        self.assertEqual(headless.Backend._config_opt_in_dev(backend), {"dev_mode": True, "dev_limits": {"pip_computers": 8}})


class DefaultsTests(unittest.TestCase):
    def test_off_each_limit_is_its_modules_own_constant_read_when_asked(self):
        # The full suite found it: tests (and anyone) patching pips.MAX_QUEUE saw no effect once the check read the
        # table. Each wired limit's default is its module's constant, read at the moment it is asked.
        from unittest.mock import patch
        from dgc import monitors, pip_conversations, pip_routines, pips
        with patch.object(dev_mode, "_settings", return_value={}):
            for module, constant, read in ((pips, "MAX_QUEUE", pips.max_queue), (monitors, "MAX_MONITORS_PER_OWNER", monitors.max_per_owner),
                                           (monitors, "MAX_MONITORS_PROCESS", monitors.max_process),
                                           (pip_conversations, "MAX_CONVERSATIONS", pip_conversations.max_conversations),
                                           (pip_routines, "MAX_ROUTINES", pip_routines.max_routines)):
                with self.subTest(constant=constant), patch.object(module, constant, 2):
                    self.assertEqual(read(), 2)
        for limit in dev_mode.LIMITS:
            with self.subTest(limit=limit.name):
                where = limit.where.split(".")
                if where[-1].isupper():
                    import importlib
                    self.assertEqual(getattr(importlib.import_module("dgc." + where[0]), where[-1]), limit.default,
                                     "the table's default is the module's own")
