"""Every widget is kept in the Library (his call 15 Nov: "every widget, automatically"). A dgc-ui card a Work session's
or a Pip's reply draws becomes a Page of its own (as ChatDGC's widgets already do: artifact_index), drawn from its JSON,
saying who made it; the same card drawn again in the same session or Pip is a new version of that Page, never a new
item; nothing is deleted. HTML in a card's words is shown as words, never run."""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path


def reply(card, before="Here is the status."):
    return f"{before}\n\n```dgc-ui\n{json.dumps(card)}\n```\n"


CARD = {"version": "1", "title": "Release status", "subtitle": "Tonight",
        "blocks": [{"type": "metrics", "items": [{"label": "Tests", "value": "10048", "detail": "all green"}]},
                   {"type": "steps", "label": "Steps", "items": [{"label": "Build", "state": "done", "detail": ""}]},
                   {"type": "bars", "label": "Time", "items": [{"label": "Python", "value": 63}, {"label": "Editor", "value": 45}]},
                   {"type": "table", "label": "Suites", "columns": ["Suite", "Result"], "rows": [["Python", "OK"]]}]}


class CardsAreKeptAsPages(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="dgc-cards-"))
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(self.home)

    def tearDown(self):
        if self._env is None:
            os.environ.pop("DGC_HOME", None)
        else:
            os.environ["DGC_HOME"] = self._env

    def pages(self):
        from dgc.artifact_store import store
        return [a for a in store().list(type="page") if a.legacy.get("card")]

    def test_a_card_in_a_reply_becomes_a_page_saying_who_made_it(self):
        from dgc import artifact_cards
        origin = {"surface": "work", "project": "/w", "session": "20261115-010101-aaaa"}
        kept = artifact_cards.keep(reply(CARD), origin=origin, author="DGC")
        self.assertEqual(len(kept), 1)
        [page] = self.pages()
        self.assertEqual(page.title, "Release status")
        self.assertEqual(page.origin, origin)
        from dgc import artifact_service
        files, entry = artifact_service.render(page.id, page.version)
        html = files[entry].decode()
        for word in ("Release status", "10048", "all green", "Python", "Suites"):
            self.assertIn(word, html)

    def test_drawn_again_in_the_same_place_it_is_a_new_version_never_a_new_item(self):
        from dgc import artifact_cards
        origin = {"surface": "pip", "pip": "pip_" + "a" * 32}
        artifact_cards.keep(reply(CARD), origin=origin, author="Sales watch")
        changed = {**CARD, "subtitle": "This morning"}
        artifact_cards.keep(reply(changed), origin=origin, author="Sales watch")
        [page] = self.pages()
        self.assertEqual(page.version, 2)
        artifact_cards.keep(reply(CARD), origin={"surface": "pip", "pip": "pip_" + "b" * 32}, author="Other")
        self.assertEqual(len(self.pages()), 2, "another Pip's card is its own")

    def test_html_in_a_cards_words_is_words(self):
        from dgc import artifact_cards, artifact_service
        bad = {"version": "1", "title": "<script>alert(1)</script>", "blocks": [
            {"type": "metrics", "items": [{"label": "<img src=x onerror=alert(1)>", "value": "1", "detail": ""}]}]}
        artifact_cards.keep(reply(bad), origin={"surface": "work", "project": "/w"}, author="DGC")
        [page] = self.pages()
        files, entry = artifact_service.render(page.id, page.version)
        html = files[entry].decode()
        self.assertNotIn("<script>alert", html)
        self.assertNotIn("<img src=x", html)

    def test_no_card_or_a_broken_one_keeps_nothing(self):
        from dgc import artifact_cards
        self.assertEqual(artifact_cards.keep("Just words.", origin={"surface": "work", "project": "/w"}), [])
        self.assertEqual(artifact_cards.keep("```dgc-ui\n{not json\n```", origin={"surface": "work", "project": "/w"}), [])
        self.assertEqual(self.pages(), [])


class TheLibraryNamesWhoMadeIt(unittest.TestCase):
    def test_made_by_names_the_pip_session_or_chat(self):
        from dgc import artifact_service
        names = {("pip", "pip_" + "a" * 32): "Sales watch", ("session", "s1"): "Fix totals", ("chat", "chat_1"): "Trip plan"}
        resolve = lambda kind, ident: names.get((kind, ident), "")
        self.assertEqual(artifact_service.made_by({"surface": "pip", "pip": "pip_" + "a" * 32}, resolve),
                         {"kind": "pip", "id": "pip_" + "a" * 32, "name": "Sales watch"})
        self.assertEqual(artifact_service.made_by({"surface": "work", "project": "/w", "session": "s1"}, resolve),
                         {"kind": "session", "id": "s1", "name": "Fix totals"})
        self.assertEqual(artifact_service.made_by({"surface": "chat", "chat": "chat_1"}, resolve),
                         {"kind": "chat", "id": "chat_1", "name": "Trip plan"})
        self.assertEqual(artifact_service.made_by({"surface": "cli"}, resolve), {"kind": "cli", "id": "", "name": ""})


class APipsReplyKeepsItsCard(unittest.TestCase):
    """A Pip's reply that draws a card: kept when its run finishes, as that Pip's."""

    def setUp(self):
        from tests import test_pips_local as fixtures
        fixtures.LocalPipsTests.setUp(self)
        os.environ["DGC_HOME"] = str(Path(self.registry.directory).parent / "dgc-home")

    def test_its_card_is_in_the_library_as_the_pips(self):
        from dgc import pip_chat
        from dgc.artifact_store import store
        pip = self.store.create(self.registry.personal()["id"], "Sales watch", "Keep the numbers", "editor-user")
        pip_chat.send(self.store, pip["id"], "how are sales?", "you-cards", "editor-user", self.cfg)
        run = self.store.claim_next()
        self.store.finish(run["id"], result={"text": reply(CARD)})
        [page] = [a for a in store().list(type="page") if a.legacy.get("card")]
        self.assertEqual(page.origin, {"surface": "pip", "pip": pip["id"]})
        self.assertEqual(store().versions(page.id)[-1].author, "Sales watch")


class AWorkTurnKeepsItsCard(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="dgc-cards-work-"))
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(self.home)

    def tearDown(self):
        if self._env is None:
            os.environ.pop("DGC_HOME", None)
        else:
            os.environ["DGC_HOME"] = self._env

    def test_the_last_reply_of_a_turn(self):
        import types
        from dgc import headless
        from dgc.artifact_store import store
        origin = {"surface": "work", "project": "/w", "session": "20261115-020202-bbbb"}
        agent = types.SimpleNamespace(messages=[{"role": "user", "content": "status?"},
                                                {"role": "assistant", "content": reply(CARD)}],
                                      _artifact_origin=lambda: origin)
        headless.Backend._keep_cards(types.SimpleNamespace(agent=agent))
        [page] = [a for a in store().list(type="page") if a.legacy.get("card")]
        self.assertEqual(page.origin, origin)


if __name__ == "__main__":
    unittest.main()
