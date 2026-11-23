"""The charts ChatDGC replies drew, in the Library (decided 16 Nov: "ChatDGC charts in the Library" into 0.52).

A reply's chart is a ```chart JSON block in its words, drawn by the screen; the Library's Widgets listed ChatDGC's
widgets (show_widget) and never a chart, so it said "A chart in a chat stays in its chat". Now chatdgc_widgets
op "charts" lists every chart a reply drew, in every chat, the newest first ({chat_id, chat_title, message_id, id,
title, kind: "chart", chart_type, created_at}), found by name; each opens its chat. Offered as
ready.capabilities.chatdgc.chart_library."""
import unittest

from tests import test_chatdgc_widgets as base

CHART = '```chart\n{"type": "bar", "title": "Spend by month", "x": ["Jan", "Feb"], "series": [{"name": "Spend", "y": [3, 4]}]}\n```'
LINE = '```chart\n{"type": "line", "title": "Tides", "x": [1, 2], "series": [{"name": "m", "y": [1, 2]}]}\n```'


class ChartsInTheLibrary(unittest.TestCase):
    setUp, ask = base.InTheLibrary.setUp, base.InTheLibrary.ask

    def replied(self, words, temporary=False):
        chat = self.engine.open(temporary=temporary)
        self.world["script"] += [{"parts": [words]}]
        reply = self.engine.send(chat["id"], "Show me", search="off")
        return chat["id"], reply

    def test_every_chart_a_reply_drew_listed_newest_first_and_found_by_name(self):
        spend_chat, spend = self.replied("Here it is.\n\n" + CHART)
        self.replied("Two:\n\n" + LINE + "\n\nand\n\n" + CHART.replace("Spend by month", "Spend by week"))
        self.replied(CHART, temporary=True)
        listed = self.ask("c", op="charts")
        self.assertEqual([c["title"] for c in listed["widgets"]], ["Tides", "Spend by week", "Spend by month"],
                         "every chart, newest first; a temporary chat keeps none")
        oldest = listed["widgets"][-1]
        self.assertEqual((oldest["chat_id"], oldest["message_id"], oldest["kind"], oldest["chart_type"]),
                         (spend_chat, spend["id"], "chart", "bar"))
        self.assertEqual([c["title"] for c in self.ask("q", op="charts", query="tide")["widgets"]], ["Tides"])

    def test_a_block_that_isnt_json_is_still_a_chart_named_plainly(self):
        self.replied("```chart\nnot json\n```")
        [chart] = self.ask("b", op="charts")["widgets"]
        self.assertEqual(chart["title"], "Chart")

    def test_offered_as_a_capability_and_known_to_the_protocol(self):
        from dgc import headless
        from dgc.editor_protocol import COMMAND_FIELDS
        self.assertIn("charts", COMMAND_FIELDS["chatdgc_widgets"]["op"]["enum"])
        be = headless.Backend.__new__(headless.Backend)
        be._host = object()                   # only a Host offers ChatDGC
        self.assertEqual(be._chatdgc_capability()["chatdgc"].get("chart_library"), 1)


if __name__ == "__main__":
    unittest.main()
