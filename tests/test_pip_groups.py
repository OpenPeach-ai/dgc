"""pips-12: folders in the Personal list ("folders, not walls"). A Pip's group is part of its page, set by the user
(set_pip_profile changes.group), read with every listed Pip's profile; "" puts it back in no folder."""
import unittest

from dgc import pip_profile
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures


class GroupTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def test_a_pips_folder_is_set_listed_and_cleared(self):
        a = self.store.create(self.registry.personal()["id"], "Ava", "Plans", "local-console")
        b = self.store.create(self.registry.personal()["id"], "Bo", "Plans", "local-console")
        self.assertEqual(pip_profile.get(self.store.db, a["id"])["group"], "", "no folder at first")
        done = pip_profile.update(self.store, a["id"], {"group": "  Launch  "}, "editor-user")
        self.assertEqual(done["profile"]["group"], "Launch")
        listed = pip_profile.profiles(self.store.db, [a["id"], b["id"]])
        self.assertEqual((listed[a["id"]]["group"], listed[b["id"]]["group"]), ("Launch", ""))
        pip_profile.update(self.store, a["id"], {"title": "Plans", "group": "Ops"}, "editor-user")
        self.assertEqual(pip_profile.get(self.store.db, a["id"])["group"], "Ops")
        pip_profile.update(self.store, a["id"], {"group": ""}, "editor-user")
        self.assertEqual(pip_profile.get(self.store.db, a["id"])["group"], "")

    def test_a_folder_name_is_one_short_line(self):
        a = self.store.create(self.registry.personal()["id"], "Ava", "Plans", "local-console")
        for bad in ("x" * 41, "two\nlines", 7, None):
            with self.subTest(group=bad), self.assertRaises(RegistryError):
                pip_profile.update(self.store, a["id"], {"group": bad}, "editor-user")
        with self.assertRaises(RegistryError):
            pip_profile.update(self.store, a["id"], {"group": "Ops"}, "device_1")


if __name__ == "__main__":
    unittest.main()
