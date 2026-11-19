"""pips-12's folders in the Personal list were dropped before release (0.52): a Pip's profile has no group any more.

The Pips page is one list (One Pips, API 94); its filter line is how a folder's Pips are seen. set_pip_profile refuses a
`group` change as any change it doesn't know, and what a development install saved for it (metadata rows
"pip_group:<pip id>") is never read: no crash, nothing shown, no migration."""
import json
import unittest

from dgc import pip_profile
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures


class NoGroupTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def test_a_group_change_is_refused_and_the_profile_has_no_group(self):
        a = self.store.create(self.registry.personal()["id"], "Ava", "Plans", "local-console")
        self.assertNotIn("group", pip_profile.get(self.store.db, a["id"]))
        for changes in ({"group": "Launch"}, {"title": "Plans", "group": ""}):
            with self.subTest(changes=changes), self.assertRaises(RegistryError) as caught:
                pip_profile.update(self.store, a["id"], changes, "editor-user")
            self.assertEqual(caught.exception.code, "invalid_request")
            self.assertNotIn("folder", str(caught.exception))
        self.assertEqual(pip_profile.get(self.store.db, a["id"])["title"], "", "nothing of a refused change is kept")
        done = pip_profile.update(self.store, a["id"], {"title": "Plans"}, "editor-user")
        self.assertEqual(done["profile"], {"title": "Plans", "body": None, "color": None, "notify": True})

    def test_a_folder_a_development_install_saved_is_never_read(self):
        a = self.store.create(self.registry.personal()["id"], "Ava", "Plans", "local-console")
        b = self.store.create(self.registry.personal()["id"], "Bo", "Plans", "local-console")
        with self.registry.transaction():
            self.registry.db.execute("INSERT INTO metadata VALUES(?,?)", ("pip_group:" + a["id"], "Launch"))
        pip_profile.update(self.store, b["id"], {"color": "mint"}, "editor-user")
        listed = pip_profile.profiles(self.store.db, [a["id"], b["id"]])
        self.assertEqual(listed[a["id"]], pip_profile.default())
        self.assertEqual(listed[b["id"]]["color"], "mint")
        self.assertNotIn("Launch", json.dumps(listed))
        self.assertNotIn("group", pip_profile.get(self.store.db, a["id"]))


if __name__ == "__main__":
    unittest.main()
