"""Comments on an artifact: you point at part of a doc, sheet, deck, page or checklist and say something; DGC answers in
that thread, or makes the change and says so there.

What the user asked for: a comment keeps exactly what it points at (the words and where they sit: a doc's paragraph, a
sheet's cells, a deck's slide and field, a page's element, a checklist's item), with the artifact in DGC's store, so a
reload and every window see the same threads; a later version that no longer has it says so; "Ask DGC" answers in the
thread, or changes it (a new version, "From a comment") and says what changed there; wording can come as suggestions
the user accepts (a new version) or rejects (nothing changes), one by one; resolved threads fold away; the Library row
counts the open ones.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import artifact_service as service
from dgc import artifact_store
from dgc.editor_protocol import command_error, event_error
from dgc.llm import ChatResult, ToolCall

DOC = ("# Trip plan\n\n## Getting there\n\nWe take the **early train** to Pune on Friday. It leaves at 6:10 and costs "
       "about ₹900.\n\n## Where we stay\n\nA small hotel near the station, two nights.\n")
BOOK = {"sheets": [{"name": "Budget", "columns": [{"name": "Item", "type": "text"}, {"name": "Cost", "type": "number"}],
                    "rows": [["Train", 900], ["Hotel", 4000], ["Food", 1500], ["Total", "=SUM(B2:B4)"]]}]}
DECK = {"slides": [{"layout": "title", "title": "Trip plan", "subtitle": "Pune, two nights"},
                   {"layout": "bullets", "title": "Getting there", "bullets": ["Early train on Friday", "Back on Sunday"]},
                   {"layout": "closing", "title": "Questions?"}]}
LIST = {"items": [{"title": "Book the train", "done_when": "Tickets are in the mail"},
                  {"title": "Book the hotel", "done_when": "A confirmation number"}]}
PAGE = ("<!doctype html><html><head><title>Trip</title><style>p{color:red}</style></head><body><main><h1>Trip</h1>"
        "<section><h2>Prices</h2><p>The train costs about ₹900 each way.</p></section></main></body></html>")


class Fake:
    """A model that answers from a script: each step is a ChatResult (or an exception to raise)."""

    def __init__(self, *steps):
        self.steps, self.calls = list(steps), []

    def chat(self, messages, tools=None, **kw):
        self.calls.append({"messages": json.loads(json.dumps(messages, default=str)), "tools": tools})
        step = self.steps.pop(0) if self.steps else ChatResult(content="")
        if isinstance(step, BaseException):
            raise step
        return step


def call(name, **args):
    return ChatResult(content="", tool_calls=[ToolCall(id=f"call_{name}_{len(args)}", name=name, arguments=args)],
                      finish_reason="tool_calls")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-comments-")))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self._env = os.environ.get("DGC_HOME")
        os.environ["DGC_HOME"] = str(self.tmp / "home")
        self.addCleanup(self._restore)
        from dgc import artifact_comments as comments
        self.c = comments

    def _restore(self):
        if self._env is None:
            os.environ.pop("DGC_HOME", None)
        else:
            os.environ["DGC_HOME"] = self._env

    def make(self, type_, title, spec):
        return service.make(type_, title, spec, origin={"surface": "chat", "chat": "chat_x"})


class WhereACommentPoints(Base):
    def test_a_doc_comment_keeps_the_words_and_where_they_sit_and_survives_a_reload(self):
        doc = self.make("doc", "Trip plan", DOC)
        thread = self.c.add(doc["id"], {"kind": "text", "quote": "early train to Pune", "before": "We take the ",
                                        "after": " on Friday"}, "Is there a later one?")
        self.assertEqual(thread["version"], doc["version"])
        self.assertEqual(thread["status"], "open")
        self.assertEqual(thread["messages"][0]["text"], "Is there a later one?")
        self.assertEqual(thread["messages"][0]["by"], "you")
        # A store read afresh (another window, a reload) sees the same thread, with the store, not in an editor.
        again = self.c.threads(doc["id"], store=artifact_store.Store(artifact_store.default_root()))
        self.assertEqual([t["id"] for t in again], [thread["id"]])
        shown = again[0]
        self.assertEqual(shown["found"], "here")
        self.assertIn("Getting there", shown["where"])            # the heading over the paragraph it sits in
        self.assertIn("early train", shown["part"])               # the paragraph, as the model reads it
        self.assertTrue((artifact_store.default_root() / doc["id"] / "comments.json").is_file())

    def test_a_later_version_that_moved_the_words_keeps_the_thread_and_one_that_dropped_them_says_so(self):
        doc = self.make("doc", "Trip plan", DOC)
        tid = self.c.add(doc["id"], {"kind": "text", "quote": "costs about ₹900"}, "Check this price")["id"]
        service.edit(doc["id"], edits=[{"find": "## Where we stay", "replace": "## Before\n\nPack light.\n\n## Where we stay"}])
        self.assertEqual(self.c.threads(doc["id"])[0]["found"], "here")
        service.edit(doc["id"], edits=[{"find": "costs about ₹900", "replace": "is free with the pass"}])
        shown = self.c.threads(doc["id"])[0]
        self.assertEqual(shown["id"], tid)
        self.assertEqual(shown["found"], "changed")
        self.assertIn("changed", shown["where"].lower())

    def test_the_same_words_twice_are_told_apart_by_the_words_around_them(self):
        doc = self.make("doc", "Notes", "# Notes\n\n## Monday\n\nCall the bank.\n\n## Tuesday\n\nCall the bank.\n")
        tid =self.c.add(doc["id"], {"kind": "text", "quote": "Call the bank.", "before": "Tuesday "}, "Which branch?")["id"]
        shown = [t for t in self.c.threads(doc["id"]) if t["id"] == tid][0]
        self.assertIn("Tuesday", shown["where"])

    def test_a_sheet_comment_points_at_its_cells_and_follows_them_when_a_row_is_put_above(self):
        book = self.make("sheet", "Budget", BOOK)
        tid = self.c.add(book["id"], {"kind": "cells", "sheet": "Budget", "range": "B3", "values": [[4000]],
                                      "quote": "4000"}, "Too much for a hotel")["id"]
        shown = self.c.threads(book["id"])[0]
        self.assertEqual((shown["found"], shown["anchor"]["range"]), ("here", "B3"))
        self.assertIn("B3", shown["where"])
        self.assertIn("Budget", shown["where"])
        self.assertIn("4000", shown["part"])
        service.edit(book["id"], edits=[{"op": "insert_rows", "sheet": "Budget", "row": 2, "rows": [["Taxi", 300]]}])
        moved = [t for t in self.c.threads(book["id"]) if t["id"] == tid][0]
        self.assertEqual(moved["found"], "moved")
        self.assertIn("B4", moved["where"])
        service.edit(book["id"], edits=[{"op": "set", "sheet": "Budget", "cell": "B4", "value": 2500}])
        self.assertEqual(self.c.threads(book["id"])[0]["found"], "changed")

    def test_a_deck_comment_points_at_the_slide_and_field_and_follows_the_slide_when_slides_move(self):
        deck = self.make("slides", "Trip deck", DECK)
        tid = self.c.add(deck["id"], {"kind": "slide", "slide": 2, "field": "bullets", "title": "Getting there",
                                      "quote": "Early train"}, "Say which train")["id"]
        shown = self.c.threads(deck["id"])[0]
        self.assertEqual(shown["found"], "here")
        self.assertIn("slide 2", shown["where"].lower())
        service.edit(deck["id"], edits=[{"op": "move", "slide": 2, "to": 1}])
        moved = [t for t in self.c.threads(deck["id"]) if t["id"] == tid][0]
        self.assertEqual(moved["found"], "moved")
        self.assertIn("slide 1", moved["where"].lower())
        service.edit(deck["id"], edits=[{"op": "set", "slide": 1, "field": "bullets", "value": ["Bus on Friday"]}])
        self.assertEqual(self.c.threads(deck["id"])[0]["found"], "changed")

    def test_a_checklist_comment_points_at_its_item(self):
        lst = self.make("checklist", "Trip jobs", LIST)
        thread = self.c.add(lst["id"], {"kind": "item", "item": "c2", "title": "Book the hotel"}, "This isn't done")
        shown = self.c.threads(lst["id"])[0]
        self.assertEqual(shown["found"], "here")
        self.assertIn("c2", shown["where"])
        self.assertIn("Book the hotel", shown["where"])
        self.assertIn("A confirmation number", shown["part"])
        service.edit(lst["id"], edits=[{"op": "remove", "item": "c2"}])
        self.assertEqual(self.c.threads(lst["id"])[0]["found"], "changed")
        self.assertEqual(thread["anchor"]["item"], "c2")

    def test_a_page_comment_points_at_its_element_and_words(self):
        page = self.make("page", "Trip page", {"html": PAGE})
        self.c.add(page["id"], {"kind": "element", "path": "main > section:nth-of-type(1) > p:nth-of-type(1)",
                                "quote": "about ₹900 each way", "near": "Prices", "tag": "p"}, "Round trip?")
        shown = self.c.threads(page["id"])[0]
        self.assertEqual(shown["found"], "here")
        self.assertIn("Prices", shown["where"])
        service.edit(page["id"], content={"html": PAGE.replace("about ₹900 each way", "₹1,700 return")})
        self.assertEqual(self.c.threads(page["id"])[0]["found"], "changed")

    def test_a_comment_on_the_whole_artifact_works_for_every_type(self):
        board = service.make("dashboard", "Sales", {"sources": [{"id": "shop", "kind": "sqlite", "path": "shop.db"}],
                                                    "widgets": [{"id": "n", "kind": "number", "title": "Orders", "source": "shop",
                                                                 "query": "SELECT COUNT(*) AS n FROM orders", "value": "n"}]},
                             origin={"surface": "chat", "chat": "x"})
        self.c.add(board["id"], {"kind": "whole"}, "Add a chart of refunds")
        self.assertEqual(self.c.threads(board["id"])[0]["found"], "here")

    def test_what_a_comment_points_at_is_checked(self):
        doc = self.make("doc", "Trip plan", DOC)
        lst = self.make("checklist", "Trip jobs", LIST)
        for anchor in ({"kind": "cells", "sheet": "Budget", "range": "B3"},          # not a doc's kind of place
                       {"kind": "text"},                                              # no words
                       {"kind": "text", "quote": "x" * 5000},                         # too long
                       {"kind": "teleport", "quote": "early"}, "early train"):
            with self.assertRaises(service.ArtifactUseError, msg=anchor):
                self.c.add(doc["id"], anchor, "hm")
        with self.assertRaises(service.ArtifactUseError):
            self.c.add(lst["id"], {"kind": "item", "item": "c9"}, "There's no c9")
        with self.assertRaises(service.ArtifactUseError):
            self.c.add(doc["id"], {"kind": "whole"}, "   ")


class Threads(Base):
    def test_reply_resolve_reopen_delete_and_the_counts_the_library_shows(self):
        doc = self.make("doc", "Trip plan", DOC)
        self.assertNotIn("comments", service.view(doc["id"]))           # none: the view says nothing of them
        a = self.c.add(doc["id"], {"kind": "text", "quote": "early train"}, "Is there a later one?")
        b = self.c.add(doc["id"], {"kind": "whole"}, "Add a packing list")
        self.c.reply(doc["id"], a["id"], "One at 9, I think")
        self.assertEqual(len(self.c.get(doc["id"], a["id"])["messages"]), 2)
        self.assertEqual(service.view(doc["id"])["comments"], {"open": 2, "all": 2})
        self.c.resolve(doc["id"], b["id"], True)
        self.assertEqual(self.c.get(doc["id"], b["id"])["status"], "resolved")
        self.assertEqual(service.view(doc["id"])["comments"], {"open": 1, "all": 2})
        self.assertEqual(service.listing()[0]["comments"], {"open": 1, "all": 2})
        self.c.resolve(doc["id"], b["id"], False)
        self.assertEqual(self.c.get(doc["id"], b["id"])["status"], "open")
        self.c.delete(doc["id"], b["id"])
        self.assertEqual([t["id"] for t in self.c.threads(doc["id"])], [a["id"]])
        with self.assertRaises(service.ArtifactUseError):
            self.c.reply(doc["id"], "t_nothere00", "hello")

    def test_removing_the_artifact_takes_its_comments_to_the_trash(self):
        doc = self.make("doc", "Trip plan", DOC)
        self.c.add(doc["id"], {"kind": "whole"}, "Keep me")
        trashed = artifact_store.store().remove(doc["id"])
        self.assertTrue((trashed / "comments.json").is_file())

    def test_a_torn_or_foreign_comments_file_never_breaks_the_artifact(self):
        doc = self.make("doc", "Trip plan", DOC)
        path = artifact_store.default_root() / doc["id"] / "comments.json"
        path.write_text("{not json", encoding="utf-8")
        self.assertEqual(self.c.threads(doc["id"]), [])
        self.assertNotIn("comments", service.view(doc["id"]))
        path.write_text(json.dumps({"threads": [{"id": "x"}, "junk", {"id": "t_aaaaaaaaaaaa", "anchor": {"kind": "whole"},
                                                                        "messages": "no"}]}), encoding="utf-8")
        self.assertEqual(self.c.threads(doc["id"]), [])
        self.c.add(doc["id"], {"kind": "whole"}, "Still works")
        self.assertEqual(len(self.c.threads(doc["id"])), 1)


class Suggestions(Base):
    def test_accept_makes_a_new_version_and_reject_leaves_it(self):
        doc = self.make("doc", "Trip plan", DOC)
        tid = self.c.add(doc["id"], {"kind": "text", "quote": "It leaves at 6:10 and costs about ₹900."}, "Shorter")["id"]
        made = self.c.suggest(doc["id"], tid, [{"old": "It leaves at 6:10 and costs about ₹900.", "new": "6:10, ₹900."},
                                               {"old": "two nights", "new": "for two nights"}])
        self.assertEqual([s["state"] for s in made], ["open", "open"])
        first, second = made
        before = service.view(doc["id"])["version"]
        view = self.c.accept(doc["id"], tid, first["id"])
        self.assertEqual(view["version"], before + 1)
        text = artifact_store.store().source(doc["id"])
        self.assertIn("6:10, ₹900.", text)
        self.assertIn("two nights", text)                                  # never a silent rewrite of the rest
        self.assertIn("From a comment", view["versions"][-1]["summary"])
        # The thread made that change: it points at the words now there, not at "the text changed".
        shown = [t for t in self.c.threads(doc["id"]) if t["id"] == tid][0]
        self.assertEqual(shown["found"], "here")
        self.assertEqual(shown["anchor"]["quote"], "6:10, ₹900.")
        self.c.reject(doc["id"], tid, second["id"])
        self.assertEqual(service.view(doc["id"])["version"], before + 1)    # reject: nothing written
        states = {s["id"]: s["state"] for s in self.c.get(doc["id"], tid)["suggestions"]}
        self.assertEqual(states, {first["id"]: "accepted", second["id"]: "rejected"})
        with self.assertRaises(service.ArtifactUseError):
            self.c.accept(doc["id"], tid, first["id"])                      # answered already

    def test_a_suggestion_whose_words_are_gone_is_refused_and_nothing_changes(self):
        doc = self.make("doc", "Trip plan", DOC)
        tid = self.c.add(doc["id"], {"kind": "whole"}, "Tighten it")["id"]
        sid = self.c.suggest(doc["id"], tid, [{"old": "two nights", "new": "2 nights"}])[0]["id"]
        service.edit(doc["id"], edits=[{"find": "two nights", "replace": "three nights"}])
        version = service.view(doc["id"])["version"]
        with self.assertRaises(service.ArtifactUseError) as said:
            self.c.accept(doc["id"], tid, sid)
        self.assertIn("aren't in it", str(said.exception))
        self.assertEqual(service.view(doc["id"])["version"], version)
        with self.assertRaises(service.ArtifactUseError):                   # words that aren't there can't be suggested
            self.c.suggest(doc["id"], tid, [{"old": "four nights", "new": "x"}])

    def test_a_page_suggestion_changes_the_page_text_once(self):
        page = self.make("page", "Trip page", {"html": PAGE})
        tid = self.c.add(page["id"], {"kind": "whole"}, "Say return")["id"]
        sid = self.c.suggest(page["id"], tid, [{"old": "about ₹900 each way", "new": "₹1,700 return"}])[0]["id"]
        self.c.accept(page["id"], tid, sid)
        html = artifact_store.store().read_file(page["id"], "index.html").decode()
        self.assertIn("₹1,700 return", html)
        self.assertIn("<h2>Prices</h2>", html)

    def test_suggestions_are_for_words_in_a_doc_or_page(self):
        book = self.make("sheet", "Budget", BOOK)
        tid = self.c.add(book["id"], {"kind": "whole"}, "x")["id"]
        with self.assertRaises(service.ArtifactUseError):
            self.c.suggest(book["id"], tid, [{"old": "Train", "new": "Rail"}])


class AskDGC(Base):
    def answer(self, aid, tid, fake, changes=None):
        from dgc import artifact_comment_turn as turn
        return turn.answer(aid, tid, client=fake, on_change=(lambda v, op: changes.append((v, op))) if changes is not None
                           else None)

    def test_dgc_answers_in_the_thread_with_what_the_comment_points_at(self):
        doc = self.make("doc", "Trip plan", DOC)
        tid = self.c.add(doc["id"], {"kind": "text", "quote": "early train to Pune"}, "Is there a later one?")["id"]
        fake = Fake(call("reply", text="Yes: one at 9:40 that gets in by noon."))
        thread = self.answer(doc["id"], tid, fake)
        self.assertEqual(thread["messages"][-1]["by"], "DGC")
        self.assertEqual(thread["messages"][-1]["text"], "Yes: one at 9:40 that gets in by noon.")
        self.assertFalse(thread.get("answering"))
        sent = json.dumps(fake.calls[0]["messages"], ensure_ascii=False)
        self.assertIn("early train to Pune", sent)                         # exactly what it points at
        self.assertIn("Getting there", sent)                               # and where it sits
        self.assertIn("Is there a later one?", sent)
        self.assertIn(doc["id"], sent)                                     # the artifact, read as edit_artifact reads it
        self.assertEqual(service.view(doc["id"])["version"], doc["version"])  # only an answer: nothing changed

    def test_dgc_makes_the_change_and_says_so_there(self):
        book = self.make("sheet", "Budget", BOOK)
        tid = self.c.add(book["id"], {"kind": "cells", "sheet": "Budget", "range": "B3", "values": [[4000]]},
                         "Make the hotel 3500")["id"]
        changes = []
        fake = Fake(call("edit_artifact", edits=[{"op": "set", "sheet": "Budget", "cell": "B3", "value": 3500}],
                         note="Hotel at 3500"),
                    call("reply", text="Changed the hotel to 3500."))
        thread = self.answer(book["id"], tid, fake, changes)
        view = service.view(book["id"])
        self.assertEqual(view["version"], book["version"] + 1)
        self.assertEqual(view["versions"][-1]["author"], "DGC")
        self.assertIn("From a comment", view["versions"][-1]["summary"])
        kinds = [m["kind"] for m in thread["messages"]]
        self.assertIn("change", kinds)
        change = [m for m in thread["messages"] if m["kind"] == "change"][0]
        self.assertEqual(change["version"], view["version"])
        self.assertEqual(thread["messages"][-1]["text"], "Changed the hotel to 3500.")
        self.assertEqual(thread["status"], "open")                         # the person resolves it, having seen it
        self.assertEqual([op for _v, op in changes], ["changed"])          # every screen is told
        # The change the comment asked for is no "change since": the thread points at the cell as it is now.
        shown = self.c.threads(book["id"])[0]
        self.assertEqual((shown["found"], shown["anchor"]["values"]), ("here", [[3500]]))
        self.assertIn("B3", shown["where"])

    def test_a_comment_changes_only_what_it_is_about_never_the_whole_of_it(self):
        deck = self.make("slides", "Trip deck", {**DECK, "theme": "dusk"})
        tid = self.c.add(deck["id"], {"kind": "slide", "slide": 2, "field": "slide", "title": "Getting there"}, "Add snacks")["id"]
        whole = {**DECK, "slides": DECK["slides"][:1] + [{**DECK["slides"][1], "bullets": ["Early train", "Snacks"]}] + DECK["slides"][2:]}
        fake = Fake(call("edit_artifact", data=whole),
                    call("edit_artifact", edits=[{"op": "set", "slide": 2, "field": "bullets",
                                                  "value": ["Early train on Friday", "Back on Sunday", "Bring snacks"]}]),
                    call("reply", text="Added snacks."))
        self.answer(deck["id"], tid, fake)
        refused = [m for m in fake.calls[1]["messages"] if m["role"] == "tool"][0]["content"]
        self.assertIn("nothing changed", refused)
        data = artifact_store.store().source(deck["id"])
        self.assertEqual(data["theme"], "dusk")                            # the rest of the deck as it was
        self.assertEqual(service.view(deck["id"])["version"], deck["version"] + 1)
        tools = {t["function"]["name"]: t for t in fake.calls[0]["tools"]}
        self.assertNotIn("data", tools["edit_artifact"]["function"]["parameters"]["properties"])
        self.assertNotIn("content", tools["edit_artifact"]["function"]["parameters"]["properties"])

    def test_wording_comes_as_suggestions(self):
        doc = self.make("doc", "Trip plan", DOC)
        tid = self.c.add(doc["id"], {"kind": "text", "quote": "A small hotel near the station, two nights."},
                         "Make this friendlier")["id"]
        fake = Fake(call("suggest", changes=[{"old": "A small hotel near the station", "new": "A cosy hotel by the station"}]),
                    call("reply", text="Here's a warmer line for you to accept or reject."))
        thread = self.answer(doc["id"], tid, fake)
        self.assertEqual(len(thread["suggestions"]), 1)
        self.assertEqual(thread["suggestions"][0]["old"], "A small hotel near the station")
        self.assertEqual(service.view(doc["id"])["version"], doc["version"])  # nothing written until Accept

    def test_a_checklist_item_comment_changes_that_item(self):
        lst = self.make("checklist", "Trip jobs", LIST)
        tid = self.c.add(lst["id"], {"kind": "item", "item": "c1", "title": "Book the train"}, "Redo this one: it's Building")["id"]
        fake = Fake(call("edit_artifact", edits=[{"op": "set", "item": "c1", "status": "Building",
                                                  "note": "Looking for a later train"}]),
                    call("reply", text="Back to Building."))
        self.answer(lst["id"], tid, fake)
        data = artifact_store.store().source(lst["id"])
        self.assertEqual(data["items"][0]["status"], "Building")
        self.assertEqual(data["items"][1]["status"], "Not started")
        self.assertIn("c1", json.dumps(fake.calls[0]["messages"]))

    def test_the_turn_says_how_this_kind_is_changed(self):
        # (Told only "slides: [{op, slide, …}]", the real model guessed a deck's insert fields five times and gave up.)
        deck = self.make("slides", "Trip deck", DECK)
        tid = self.c.add(deck["id"], {"kind": "slide", "slide": 2, "field": "slide", "title": "Getting there"}, "Add snacks")["id"]
        fake = Fake(call("reply", text="ok"))
        self.answer(deck["id"], tid, fake)
        said = fake.calls[0]["messages"][1]["content"]
        self.assertIn('"op": "set", "slide": 2, "field": "bullets"', said)
        doc = self.make("doc", "Trip plan", DOC)
        tid = self.c.add(doc["id"], {"kind": "whole"}, "Shorter")["id"]
        fake = Fake(call("reply", text="ok"))
        self.answer(doc["id"], tid, fake)
        self.assertIn("suggest", fake.calls[0]["messages"][1]["content"])
        self.assertIn("suggest", {t["function"]["name"] for t in fake.calls[0]["tools"]})

    def test_an_edit_can_only_change_this_artifact(self):
        doc = self.make("doc", "Trip plan", DOC)
        other = self.make("doc", "Other", "# Other\n\nKeep.\n")
        tid = self.c.add(doc["id"], {"kind": "whole"}, "Fix it")["id"]
        fake = Fake(call("edit_artifact", id=other["id"], edits=[{"find": "Keep.", "replace": "Gone."}]),
                    call("reply", text="ok"))
        self.answer(doc["id"], tid, fake)
        self.assertEqual(artifact_store.store().source(other["id"]), "# Other\n\nKeep.\n")

    def test_a_model_that_fails_says_so_in_the_thread_and_frees_it(self):
        doc = self.make("doc", "Trip plan", DOC)
        tid = self.c.add(doc["id"], {"kind": "whole"}, "Hello?")["id"]
        thread = self.answer(doc["id"], tid, Fake(RuntimeError("connection refused")))
        last = thread["messages"][-1]
        self.assertEqual(last["kind"], "error")
        self.assertIn("connection refused", last["text"])
        self.assertFalse(thread.get("answering"))

    def test_plain_words_from_the_model_are_its_answer(self):
        doc = self.make("doc", "Trip plan", DOC)
        tid = self.c.add(doc["id"], {"kind": "whole"}, "Thoughts?")["id"]
        thread = self.answer(doc["id"], tid, Fake(ChatResult(content="Looks good to me.")))
        self.assertEqual(thread["messages"][-1]["text"], "Looks good to me.")


class Commands(Base):
    def setUp(self):
        super().setUp()
        from dgc.artifact_commands import ArtifactCommands
        self.events, self.lock = [], threading.Lock()

        def emit(kind, **fields):
            event = {"type": kind, "seq": 1, **fields}
            problem = event_error(event)
            assert problem is None, problem
            with self.lock:
                self.events.append(event)
        self.commands = ArtifactCommands(emit)
        self.doc = self.make("doc", "Trip plan", DOC)

    def send(self, cmd):
        self.assertIsNone(command_error(cmd), cmd)
        self.commands.dispatch(cmd)

    def wait(self, test, seconds=20.0):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            with self.lock:
                found = [e for e in self.events if test(e)]
            if found:
                return found[-1]
            time.sleep(0.05)
        raise AssertionError(f"no event: {self.events[-3:]}")

    def test_the_capability_offers_comments(self):
        from dgc.artifact_commands import CAPABILITY
        self.assertEqual(CAPABILITY["artifacts"]["comments"], 1)

    def test_add_reply_resolve_and_list_answer_with_the_threads(self):
        aid = self.doc["id"]
        self.send({"type": "artifact_comment_add", "request_id": "r1", "id": aid, "text": "Later train?",
                   "anchor": {"kind": "text", "quote": "early train"}, "version": self.doc["version"]})
        got = self.wait(lambda e: e.get("request_id") == "r1")
        self.assertEqual(got["type"], "artifact_comments")
        self.assertEqual(got["id"], aid)
        tid = got["threads"][0]["id"]
        self.send({"type": "artifact_comment_reply", "request_id": "r2", "id": aid, "thread": tid, "text": "Or a bus"})
        self.assertEqual(len(self.wait(lambda e: e.get("request_id") == "r2")["threads"][0]["messages"]), 2)
        self.send({"type": "artifact_comment_resolve", "request_id": "r3", "id": aid, "thread": tid, "resolved": True})
        self.assertEqual(self.wait(lambda e: e.get("request_id") == "r3")["threads"][0]["status"], "resolved")
        self.send({"type": "artifact_comment_list", "request_id": "r4", "id": aid})
        self.assertEqual(self.wait(lambda e: e.get("request_id") == "r4")["threads"][0]["id"], tid)
        self.send({"type": "artifact_comment_delete", "request_id": "r5", "id": aid, "thread": tid})
        self.assertEqual(self.wait(lambda e: e.get("request_id") == "r5")["threads"], [])

    def test_a_bad_anchor_is_refused_with_words(self):
        self.send({"type": "artifact_comment_add", "request_id": "r1", "id": self.doc["id"], "text": "x",
                   "anchor": {"kind": "cells", "sheet": "S", "range": "A1"}})
        got = self.wait(lambda e: e.get("request_id") == "r1")
        self.assertEqual(got["type"], "command_rejected")
        self.assertEqual(got["reason"], "invalid")

    def test_ask_answers_on_a_thread_of_its_own_and_tells_every_screen(self):
        aid = self.doc["id"]
        self.commands.comment_client = lambda: Fake(call("reply", text="There is one at 9:40."))
        self.send({"type": "artifact_comment_add", "request_id": "r1", "id": aid, "text": "Later train?", "ask": True,
                   "anchor": {"kind": "text", "quote": "early train"}})
        busy = self.wait(lambda e: e.get("request_id") == "r1")
        self.assertTrue(busy["threads"][0].get("answering"))               # said at once: DGC is on it
        done = self.wait(lambda e: e["type"] == "artifact_comments" and not e.get("request_id")
                         and e["threads"] and e["threads"][0]["messages"][-1]["by"] == "DGC")
        self.assertEqual(done["threads"][0]["messages"][-1]["text"], "There is one at 9:40.")
        self.assertFalse(done["threads"][0].get("answering"))

    def test_an_edit_from_a_comment_is_an_artifact_change_every_screen_hears(self):
        aid = self.doc["id"]
        self.commands.comment_client = lambda: Fake(
            call("edit_artifact", edits=[{"find": "early train", "replace": "9:40 train"}], note="Later train"),
            call("reply", text="Switched to the 9:40."))
        self.send({"type": "artifact_comment_add", "request_id": "r1", "id": aid, "text": "Make it the later train",
                   "anchor": {"kind": "text", "quote": "early train"}})
        tid = self.wait(lambda e: e.get("request_id") == "r1")["threads"][0]["id"]
        self.send({"type": "artifact_comment_ask", "request_id": "r2", "id": aid, "thread": tid})
        changed = self.wait(lambda e: e["type"] == "artifact_changed")
        self.assertEqual(changed["op"], "changed")
        self.assertEqual(changed["surface"], "comment")
        self.assertIn("comments", changed["artifact"])                     # (its count rides inside the view)
        self.wait(lambda e: e["type"] == "artifact_comments" and e["threads"][0]["messages"][-1]["text"] == "Switched to the 9:40.")

    def test_accept_and_reject_answer_with_the_threads_and_accept_is_a_change(self):
        aid = self.doc["id"]
        tid = self.c.add(aid, {"kind": "whole"}, "Tighten")["id"]
        sid, other = [s["id"] for s in self.c.suggest(aid, tid, [{"old": "two nights", "new": "2 nights"},
                                                                 {"old": "about ₹900", "new": "₹900"}])]
        self.send({"type": "artifact_suggestion_accept", "request_id": "r1", "id": aid, "thread": tid, "suggestion": sid})
        got = self.wait(lambda e: e.get("request_id") == "r1" and e["type"] == "artifact_comments")
        self.assertEqual({s["id"]: s["state"] for s in got["threads"][0]["suggestions"]}[sid], "accepted")
        self.wait(lambda e: e["type"] == "artifact_changed")
        self.send({"type": "artifact_suggestion_reject", "request_id": "r2", "id": aid, "thread": tid, "suggestion": other})
        got = self.wait(lambda e: e.get("request_id") == "r2")
        self.assertEqual({s["id"]: s["state"] for s in got["threads"][0]["suggestions"]}[other], "rejected")

    def test_the_new_commands_are_checked_by_the_protocol(self):
        self.assertIsNotNone(command_error({"type": "artifact_comment_add", "request_id": "r", "id": "ar_0", "text": 5,
                                            "anchor": {}}))
        self.assertIsNotNone(command_error({"type": "artifact_comment_resolve", "request_id": "r", "id": "x", "thread": "t"}))
        self.assertIsNone(command_error({"type": "artifact_suggestion_reject", "request_id": "r", "id": "x", "thread": "t",
                                         "suggestion": "s"}))
        self.assertIsNotNone(event_error({"type": "artifact_comments", "seq": 1, "id": "x", "threads": [],
                                          "version": 1, "extra": True}))


class AFramedPage(Base):
    """A page is framed at its own address: DGC's helper is added to its HTML only when the browser frames it."""

    def setUp(self):
        super().setUp()
        import dgc.artifacts as A
        self.A = A
        self._server, A._SRV = A._SRV, A._Server(persistent=False)
        self.addCleanup(self._stop)

    def _stop(self):
        self.A._SRV.shutdown()
        self.A._SRV = self._server

    def get(self, url, **headers):
        import urllib.request
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=10) as r:
            return r.read(), r.headers.get("Content-Type", "")

    def test_the_helper_rides_only_in_a_framed_page_and_is_served_where_no_page_file_can_be(self):
        from dgc import artifact_comment_frame as frame
        page = self.make("page", "Trip page", {"html": PAGE})
        url = service.serve(page["id"])
        framed, _ = self.get(url, **{"Sec-Fetch-Dest": "iframe"})
        alone, _ = self.get(url, **{"Sec-Fetch-Dest": "document"})
        plain, _ = self.get(url)
        self.assertIn(frame.TAG, framed)
        self.assertEqual(framed.replace(frame.TAG, b""), PAGE.encode())
        self.assertTrue(framed.index(frame.TAG) < framed.lower().rindex(b"</body>"))
        self.assertEqual(alone, PAGE.encode(), "opened in its own tab: the page as it is")
        self.assertEqual(plain, PAGE.encode())
        self.assertEqual(artifact_store.store().read_file(page["id"], "index.html"), PAGE.encode(), "the store keeps it as made")
        root = url[:url.index("/", len("http://"))]
        script, kind = self.get(f"{root}/{frame.PATH}")
        self.assertEqual(script.decode(), frame.SCRIPT)
        self.assertTrue(kind.startswith("text/javascript"))
        with self.assertRaises(artifact_store.ArtifactError):
            artifact_store.safe_rel(frame.PATH)                 # no page can hold a file by that name

    def test_inject_is_once_and_goes_before_the_last_body_end(self):
        from dgc import artifact_comment_frame as frame
        once = frame.inject(b"<html><body><p>a</p></body></html>")
        self.assertEqual(once, b"<html><body><p>a</p>" + frame.TAG + b"</body></html>")
        self.assertEqual(frame.inject(once), once)
        self.assertEqual(frame.inject(b"<p>no body</p>"), b"<p>no body</p>" + frame.TAG)


if __name__ == "__main__":
    unittest.main()


from unittest.mock import patch                  # noqa: E402


class TheChatThatMadeIt(Base):
    """Ask DGC on a comment also reads, briefly, what was said in the chat that made the artifact (a Work session, a
    ChatDGC chat or a Pip's chat): the last few things said, words only, trimmed. Never a whole transcript, never tool
    output, nothing where the chat isn't there any more."""

    def body(self, aid, tid):
        from dgc import artifact_comment_turn as turn
        return turn.prompt(aid, tid)[1]["content"]

    def test_a_chatdgc_chat_that_made_it_is_read_in_brief(self):
        from dgc.chatdgc.store import ChatStore
        store = ChatStore()
        chat = store.create(title="Pune trip")
        chat["messages"] = [{"id": "msg_" + "1" * 32, "role": "user", "text": "Plan a Pune trip; we picked the Lotus Inn, 3500 a night."},
                            {"id": "msg_" + "2" * 32, "role": "assistant", "text": "Done: the budget sheet has the Lotus Inn."}]
        store.save(chat)
        book = service.make("sheet", "Budget", BOOK, origin={"surface": "chat", "chat": chat["id"]})
        tid = self.c.add(book["id"], {"kind": "cells", "sheet": "Budget", "range": "B3", "values": [[4000]]},
                         "Use the hotel we picked")["id"]
        body = self.body(book["id"], tid)
        self.assertIn("The chat that made it", body)
        self.assertIn("Pune trip", body)
        self.assertIn("we picked the Lotus Inn, 3500 a night", body)
        self.assertLess(body.index("The chat that made it"), body.index("The thread so far"))

    def test_a_work_session_that_made_it_is_read_without_its_tool_output(self):
        from dgc import sessions
        project = self.tmp / "proj"
        project.mkdir()
        with patch.object(sessions, "SESSIONS_DIR", self.tmp / "sessions"):
            path = sessions.new_path(project)
            sessions.save(path, [{"role": "system", "content": "SYSTEM PROMPT"},
                                 {"role": "user", "content": "Write the launch doc; keep it under a page."},
                                 {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function",
                                  "function": {"name": "bash", "arguments": "{}"}}]},
                                 {"role": "tool", "tool_call_id": "c1", "content": "SECRET TOOL OUTPUT"},
                                 {"role": "assistant", "content": "The launch doc is in the Library."}],
                          project, name="Launch doc")
            doc = service.make("doc", "Launch", DOC, origin={"surface": "work", "session": path.stem, "project": str(project)})
            tid = self.c.add(doc["id"], {"kind": "text", "quote": "early train to Pune"}, "Shorter?")["id"]
            body = self.body(doc["id"], tid)
        self.assertIn("Launch doc", body)
        self.assertIn("keep it under a page", body)
        self.assertIn("The launch doc is in the Library.", body)
        self.assertNotIn("SECRET TOOL OUTPUT", body)
        self.assertNotIn("SYSTEM PROMPT", body)

    def test_only_the_last_few_and_each_trimmed(self):
        from dgc import artifact_origin
        from dgc.chatdgc.store import ChatStore
        store = ChatStore()
        chat = store.create(title="Long one")
        chat["messages"] = [{"id": f"msg_{i:032x}", "role": "user" if i % 2 else "assistant", "text": f"message {i} " + "x" * 3000}
                            for i in range(1, 41)]
        store.save(chat)
        said = artifact_origin.conversation({"surface": "chat", "chat": chat["id"]})
        self.assertIn("message 40", said)
        self.assertNotIn("message 20 ", said, "only the last few")
        self.assertLessEqual(len(said), artifact_origin.MAX_TOTAL + 200)

    def test_nothing_where_the_chat_is_gone_or_unknown(self):
        from dgc import artifact_origin
        self.assertEqual(artifact_origin.conversation({"surface": "chat", "chat": "chat_gone"}), "")
        self.assertEqual(artifact_origin.conversation({"surface": "work", "session": "../../etc", "project": "/"}), "")
        self.assertEqual(artifact_origin.conversation({"surface": "sdk"}), "")
        doc = self.make("doc", "Trip plan", DOC)          # its chat (chat_x) was never saved
        tid = self.c.add(doc["id"], {"kind": "text", "quote": "early train to Pune"}, "Is there a later one?")["id"]
        self.assertNotIn("The chat that made it", self.body(doc["id"], tid))

    def test_a_pips_chat_that_made_it_is_read_in_brief(self):
        """A Pip's own chat (pip_chat_messages, the columns the real table has): its last few things said."""
        import sqlite3
        from dgc import artifact_origin

        class Registry:
            def __init__(self, *a):
                self.db = sqlite3.connect(":memory:")
                self.db.execute("CREATE TABLE pip_chat_messages(seq INTEGER PRIMARY KEY, pip_id TEXT, role TEXT, text TEXT)")
                for i, (role, text) in enumerate([("user", "Find us a hotel in Pune under 4000."),
                                                  ("assistant", "The Lotus Inn, 3500 a night; I put it in the sheet.")]):
                    self.db.execute("INSERT INTO pip_chat_messages VALUES(?,?,?,?)", (i + 1, "pip_ava", role, text))
                    self.db.execute("INSERT INTO pip_chat_messages VALUES(?,?,?,?)", (i + 10, "pip_other", role, "NOT HERS"))

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        with patch("dgc.workspace_registry.WorkspaceRegistry", Registry), \
                patch("dgc.your_browser._pip_names", lambda registry, ids: {"pip_ava": "Ava"}):
            said = artifact_origin.conversation({"surface": "pip", "pip": "pip_ava"})
        self.assertTrue(said.startswith("Ava's chat"), said)
        self.assertIn("The Lotus Inn, 3500 a night", said)
        self.assertNotIn("NOT HERS", said)
