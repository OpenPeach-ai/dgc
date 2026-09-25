"""`ask_user` can carry the picker's options without becoming the picker.

DGC already had Codex's non-blocking shape -- `ask_user` returns at once, the card sits in the
transcript, folds to a line you can answer later, and the answer arrives as an ordinary tagged
prompt. What it lacked was options, so a model that COULD name the choices had to either invent a
free-text question or call `propose_options` and stop the turn dead.

The whole risk here is the wire. `options` is a new field on an EXISTING event, and the receiver
drops an event carrying a field it has not declared -- so an older panel would show no card at
all, which is strictly worse than a card without options. It is therefore sent only to a client
that declared `ask_options`, exactly as `spooled_images` and `open_asks` are.
"""
from __future__ import annotations

import unittest

from dgc.editor_protocol import EVENT_FIELDS, COMMAND_FIELDS
from dgc.questions import _option


class AskOptionsWire(unittest.TestCase):
    def test_the_field_is_declared_optional_on_both_sides(self) -> None:
        self.assertIn("options", EVENT_FIELDS["ask_request"])
        self.assertFalse(EVENT_FIELDS["ask_request"]["options"]["required"],
                         "an older backend must not be forced to send it")
        self.assertIn("ask_options", COMMAND_FIELDS["set_workspace_roots"])
        self.assertFalse(COMMAND_FIELDS["set_workspace_roots"]["ask_options"]["required"])

    def test_options_reach_a_client_that_asked_for_them(self) -> None:
        ui, sent = _ui(open_asks=True, ask_options=True)
        self.assertTrue(ui.ask_open_question("a1", "Where?", "", [], None,
                                             [{"label": "Local", "description": "", "recommended": True}]))
        self.assertEqual(sent[-1][0], "ask_request")
        self.assertEqual(sent[-1][1]["options"], [{"label": "Local", "description": "", "recommended": True}])

    def test_a_client_that_did_not_ask_still_gets_the_question(self) -> None:
        # The whole point of the gate: degrade to a text box, never to silence.
        ui, sent = _ui(open_asks=True, ask_options=False)
        self.assertTrue(ui.ask_open_question("a1", "Where?", "", [], None, [{"label": "Local"}]))
        self.assertEqual(sent[-1][0], "ask_request")
        self.assertNotIn("options", sent[-1][1], "the field would make it drop the whole event")
        self.assertEqual(sent[-1][1]["question"], "Where?")

    def test_a_client_that_cannot_show_open_questions_gets_nothing(self) -> None:
        ui, sent = _ui(open_asks=False, ask_options=True)
        self.assertFalse(ui.ask_open_question("a1", "Where?", "", [], None, [{"label": "Local"}]))
        self.assertEqual(sent, [])


class AskOptionsNormalisation(unittest.TestCase):
    def test_options_go_through_the_pickers_own_normaliser(self) -> None:
        # Not a second parser: the same (Recommended) handling, in all three places a model puts it.
        self.assertEqual(_option("Fast (Recommended)"),
                         {"label": "Fast", "description": "", "recommended": True})
        self.assertEqual(_option({"label": "Fast", "description": "Recommended: quick"}),
                         # the marker is removed and what is left reads as a sentence again
                         {"label": "Fast", "description": "Quick", "recommended": True})

    def test_a_model_added_other_row_is_dropped(self) -> None:
        # The client supplies its own free-text row; a model-invented one would duplicate it.
        self.assertIsNone(_option("Other"))
        self.assertIsNone(_option({"label": "other…"}))

    def test_a_malformed_option_does_not_lose_the_question(self) -> None:
        with self.assertRaises(ValueError):
            _option({"description": "no label"})


def _ui(*, open_asks: bool, ask_options: bool):
    """A HeadlessUI with just enough around it to watch what it emits."""
    from dgc.headless import HeadlessUI
    from dgc.protocol import PendingRequests

    sent: list[tuple] = []

    class _Emitter:
        def emit(self, kind, **fields):
            sent.append((kind, fields))

    ui = HeadlessUI(_Emitter(), PendingRequests())
    ui._open_asks_enabled = open_asks
    ui._ask_options_enabled = ask_options
    return ui, sent


if __name__ == "__main__":
    unittest.main()
