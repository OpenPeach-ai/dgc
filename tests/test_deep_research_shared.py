"""Deep research is ONE module every surface runs (0.52, "one capability, one module"): ChatDGC's screen, a Work
session's deep_research tool and a Pip's. run_report runs it start to finish with nobody to edit the plan: the plan,
the rounds, the report and its citation check, the line on how it was researched, and the sources it cites.
A stand-in web and model (test_chatdgc_research_loop's); no network."""
import threading
import unittest

from dgc import deep_research
from test_chatdgc_research_loop import Model, Stand


class OneModule(unittest.TestCase):
    def test_chatdgc_research_is_the_shared_module(self):
        from dgc.chatdgc import research
        self.assertIs(research, deep_research, "the old name is the same module, so a change reaches every surface")


class RunReport(Stand):
    def report(self, **kwargs):
        heard = []
        out = deep_research.run_report(
            "Home loans in Pune", client_for=lambda: Model(self.world), room=32768, search=self.web.search,
            fetch=self.web.fetch, progress=heard.append, **kwargs)
        return out, heard

    def test_it_plans_reads_writes_and_checks_with_nobody_to_edit_the_plan(self):
        out, heard = self.report(depth="quick")
        kinds = [c["kind"] for c in self.world["calls"]]
        self.assertEqual(kinds[0], "plan", "a plan first")
        self.assertIn("write", kinds)
        self.assertIn("check", kinds, "every citation checked, as in ChatDGC")
        self.assertEqual(out["status"], "done")
        self.assertIn("Rates start at 7.5% [1]", out["report"])
        self.assertTrue(out["how"].startswith("How this was researched:"))
        self.assertEqual([s["n"] for s in out["sources"]], [1, 2], "the sources it cites, numbered as cited")
        self.assertTrue(all(s["url"].startswith("https://") and s["title"] for s in out["sources"]))
        self.assertEqual(out["plan"]["title"], "Home loans in Pune")
        self.assertTrue(heard and all(isinstance(line, str) and line for line in heard), "progress in plain words")

    def test_the_depth_bounds_the_reading(self):
        out, _ = self.report(depth="quick")
        self.assertLessEqual(out["read"], deep_research.depths(32768)["quick"]["pages"])
        self.assertEqual(out["depth"], "quick")
        out, _ = self.report(depth="no such depth")
        self.assertEqual(out["depth"], deep_research.DEFAULT_DEPTH, "an unknown depth is the default")

    def test_a_stop_ends_it_with_what_it_found(self):
        cancel = threading.Event()
        self.web.on_fetch = lambda url: cancel.set()
        with self.assertRaises(deep_research.ResearchError) as raised:
            self.report(depth="quick", cancel=cancel)
        self.assertIn("Stopped", str(raised.exception))

    def test_a_window_too_small_is_refused_before_anything_runs(self):
        with self.assertRaises(deep_research.ResearchError):
            deep_research.run_report("x", client_for=lambda: Model(self.world), room=8192, search=self.web.search,
                                     fetch=self.web.fetch)
        self.assertEqual(self.world["calls"], [], "nothing asked of the model")

    def test_tool_text_gives_the_report_and_its_sources_as_one_reply(self):
        out, _ = self.report(depth="quick")
        text = deep_research.tool_text(out)
        self.assertIn("Rates start at 7.5% [1]", text)
        self.assertIn("Sources:", text)
        self.assertIn("[1] ", text)
        self.assertIn(out["sources"][0]["url"], text)
        self.assertIn("How this was researched", text)


class Schema(unittest.TestCase):
    def test_one_tool_schema_for_every_surface(self):
        schema = deep_research.TOOL_SCHEMA
        self.assertEqual(schema["function"]["name"], "deep_research")
        params = schema["function"]["parameters"]
        self.assertEqual(params["required"], ["question"])
        self.assertEqual(set(params["properties"]["depth"]["enum"]), set(deep_research.DEPTHS))


class Window(unittest.TestCase):
    """The window a Work session's or a Pip's research works in (room_for), as ChatDGC decides it: on a model hosted
    elsewhere a bigger window costs none of the user's memory, so up to HOSTED_WINDOW; on this machine, never more
    than the window it already runs in (32k when none is set)."""

    def client(self, model="m", base="http://127.0.0.1:11434/v1", context=0, limit=262144):
        from types import SimpleNamespace
        return SimpleNamespace(model=model, base_url=base, context_size=context, model_context_limit=lambda: limit)

    def test_a_model_on_this_machine_keeps_its_window(self):
        self.assertEqual(deep_research.room_for(self.client(context=65536)), 65536)
        self.assertEqual(deep_research.room_for(self.client()), deep_research.LOCAL_WINDOW, "none set: 32k, not 128k")
        self.assertEqual(deep_research.room_for(self.client(base="http://gpu-box.local:11434")), deep_research.LOCAL_WINDOW)

    def test_a_hosted_model_reads_with_a_bigger_window(self):
        self.assertEqual(deep_research.room_for(self.client(model="deepseek-v4.1-flash:cloud")), deep_research.HOSTED_WINDOW)
        self.assertEqual(deep_research.room_for(self.client(base="https://api.example.com/v1", limit=65536)), 65536)
        self.assertEqual(deep_research.room_for(self.client(base="https://api.example.com/v1", context=200000)), 200000)

    def test_hosted_is_the_one_reading_chatdgc_uses(self):
        self.assertTrue(deep_research.hosted(self.client(base="https://api.example.com/v1")))
        self.assertFalse(deep_research.hosted(self.client(base="http://192.168.1.20:11434")))
        self.assertTrue(deep_research.hosted(self.client(model="x-cloud")))


if __name__ == "__main__":
    unittest.main()
