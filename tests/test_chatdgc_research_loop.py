"""ChatDGC deep research, the loop: rounds that follow the gaps a review finds, pages picked from a pool of results,
read whole and each once (however linked, redirected or copied), a depth's budget of rounds, pages and minutes, no
stopping before it's deep enough, Stop and Keep researching, and the progress and the note on how it was researched.
A stand-in web and a stand-in model; no network."""
import re
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

from dgc.chatdgc import research
from dgc.chatdgc.engine import ChatEngine
from dgc.chatdgc.store import ChatStore
from dgc.llm import ToolCall
from dgc.shared_memory import SharedMemory

PROMPTS = {"plan": research.PLANNER, "search": research.SEARCHER, "pick": getattr(research, "PICKER", "\0"),
           "note": research.NOTER, "write": research.WRITER, "check": research.CHECKER}
STEPS = ["Home loan rates in 2026", "Processing fees", "Prepayment rules"]


class Config(dict):
    base_url, api_key, model = "http://127.0.0.1:11434/v1", "", "chat-model"

    def get(self, key, default=None):
        return super().get(key, default)


class Model:
    """Answers each step by the `answers` the test gives (a dict, or a function of the request's words), by tool call."""

    def __init__(self, world):
        self.world, self.model, self.context_size = world, "chat-model", 0

    def prepare_model(self, **_):
        pass

    def model_context_limit(self):
        return 131072

    def chat(self, messages, tools=None, reasoning_effort=None, on_text=None, on_thinking=None, cancel=None):
        system, user = messages[0]["content"], messages[-1]["content"]
        kind = next(k for k, p in PROMPTS.items() if system.startswith(p[:40]))
        with self.world["lock"]:
            self.world["calls"].append({"kind": kind, "user": user})
        answer = self.world["answers"][kind]
        answer = answer(user) if callable(answer) else answer
        if kind == "write":
            for part in answer:
                if on_text is not None:
                    on_text(part)
            return SimpleNamespace(content="".join(answer), tool_calls=[], finish_reason="stop", usage={})
        return SimpleNamespace(content="", tool_calls=[ToolCall("c1", tools[0]["function"]["name"], answer)],
                               finish_reason="stop", usage={})


def slug(text: str) -> str:
    return re.sub(r"\W+", "-", text.lower()).strip("-")


class Web:
    """A stand-in web: each search finds `per` pages of its own (each on its own site unless `site` says), and every
    page reads as a long text of its own."""

    def __init__(self, per=8, site=None):
        self.per, self.site, self.searched, self.fetched = per, site, [], []
        self.lock = threading.Lock()
        self.on_fetch = None

    def search(self, query):
        with self.lock:
            self.searched.append(query)
        s = slug(query)
        return [{"title": f"{query} ({i})", "url": f"https://{self.site or f'{s}-{i}.example'}/{s}/{i}",
                 "snippet": f"What {query} says, part {i}"} for i in range(1, self.per + 1)]

    def fetch(self, url):
        with self.lock:
            self.fetched.append(url)
        if self.on_fetch is not None:
            self.on_fetch(url)
        return url, f"{url} says something specific about it, with figures. " * 40


def note_of(user: str) -> dict:
    url = re.search(r"\nThe page: .*? \((\S+)\)\n", user).group(1)
    return {"relevant": True, "note": f"- What {url} says." + " More detail." * 40 + " TAILMARK", "steps": [1],
            "date": "12 October 2026"}


def notes_in(user: str) -> int:
    return len(re.findall(r"^\[\d+\] ", user.split("Notes so far:")[-1], re.M))


class Stand(unittest.TestCase):
    """The stand-in web and model each test starts from."""

    def setUp(self):
        self.web = Web()
        self.world = {"calls": [], "lock": threading.Lock(), "answers": {
            "plan": {"title": "Home loans in Pune", "steps": STEPS},
            "search": self.review, "pick": lambda user: {"pick": list(range(1, 10))}, "note": note_of,
            "write": ["# Home loans\n\n", "Rates start at 7.5% [1]. ", "Fees are 0.5% [2].\n"],
            "check": lambda user: {"verdicts": [{"id": int(i), "supported": True}
                                                for i in re.findall(r"^(\d+)\. ", user.split("Notes:")[0], re.M)]}}}
        self.reviews = []
        # One reader and one search at a time: the order of what's read is then known.
        for name, value in (("WORKERS", 1), ("SEARCH_WORKERS", 1), ("SEARCH_RETRY_SECONDS", 0.01)):
            if hasattr(research, name):
                old = getattr(research, name)
                setattr(research, name, value)
                self.addCleanup(setattr, research, name, old)

    def review(self, user):
        """The review the test scripts: round 1 searches for rates and fees; then the gap is prepayment, until a
        page on it is noted; then it's enough."""
        self.reviews.append(user)
        if "No notes yet" in user or notes_in(user) == 0:
            return {"enough": False, "searches": ["home loan rates", "home loan fees"]}
        if "prepayment-rules-floating" not in user:
            return {"covered": [1, 2], "gaps": ["Prepayment rules for floating-rate loans"], "conflicts": [],
                    "searches": ["prepayment rules floating"], "enough": False}
        return {"covered": [1, 2, 3], "gaps": [], "conflicts": [], "searches": [], "enough": True}


class Loop(Stand):
    def run_(self, state, *, clock=None, cancel=None):
        state.setdefault("question", "Compare home loans for a ₹70 lakh flat in Pune")
        state.setdefault("plan", {"title": "Home loans", "steps": STEPS, "sites": []})
        kwargs = {"clock": clock} if clock else {}
        run = research.Research(None, state, client_for=lambda: Model(self.world), room=32768, search=self.web.search,
                                fetch=self.web.fetch, cancel=cancel, **kwargs)
        run.gather()
        return run

    def kinds(self, state, kind):
        return [a["text"] for a in state.get("activity") or [] if a["kind"] == kind]

    def test_rounds_follow_the_gaps_the_review_finds_and_it_doesnt_stop_early(self):
        state = {"depth": "standard"}
        self.run_(state)
        self.assertEqual(state["searched"][:3], ["home loan rates", "home loan fees", "prepayment rules floating"],
                         "the next search is for the gap the review found")
        self.assertIn("Prepayment rules for floating-rate loans", self.kinds(state, "gap"), "the gap is shown")
        self.assertIn("TAILMARK", self.reviews[1], "the review reads each note whole, not its first 240 characters")
        self.assertEqual(state.get("covered"), [1, 2, 3])
        self.assertIn("It's too early to call it enough", self.reviews[2],
                      "a review before it's deep enough is told so")
        self.assertGreaterEqual(state["round"], 3, "the model can't call it enough before three rounds")
        self.assertGreaterEqual(len(state["read"]), 20, "nor before a standard depth's 20 pages")
        self.assertEqual(self.kinds(state, "info")[-1], "The notes cover the plan.")

    def test_it_reads_what_it_picks_and_keeps_the_rest_for_a_later_round(self):
        picks = iter([[16, 3, 5], []])
        self.world["answers"]["pick"] = lambda user: {"pick": next(picks, [])}
        self.world["answers"]["search"] = lambda user: (
            {"enough": False, "searches": ["home loan rates", "home loan fees"]} if "No notes yet" in user
            else {"enough": False, "searches": []})
        state = {"depth": "standard"}
        self.run_(state)
        pick = next(c for c in self.world["calls"] if c["kind"] == "pick")
        self.assertIn("16. home loan fees (8) (home-loan-fees-8.example): What home loan fees says, part 8", pick["user"],
                      "the model chooses from each result's title, site and snippet")
        self.assertEqual(self.web.fetched[:3], ["https://home-loan-fees-8.example/home-loan-fees/8",
                                                "https://home-loan-rates-2.example/home-loan-rates/2",
                                                "https://home-loan-rates-3.example/home-loan-rates/3"], "what it picked")
        self.assertEqual(len(set(self.web.fetched)), len(self.web.fetched), "each page once")
        self.assertGreater(len(self.web.fetched), 3, "the rest of what was found is read in later rounds")
        self.assertEqual(state["found"], 16)

    def test_each_page_once_however_its_linked_redirected_or_copied(self):
        article = "The RBI's 2026 directions remove prepayment charges on floating-rate home loans. " * 40
        pages = {"https://a.example/rules": article, "https://d.example/other": "Another page entirely. " * 40}
        moved = {"https://b.example/go": "https://a.example/rules", "https://www.a.example/rules#top": "https://a.example/rules"}
        copies = {"https://c.example/syndicated": article}

        def fetch(url):
            self.web.fetched.append(url)
            final = moved.get(url, url)
            return final, pages.get(final) or copies[url]
        self.web.fetch = fetch
        self.web.search = lambda q: [{"title": t, "url": u, "snippet": ""} for t, u in (
            ("A", "https://www.a.example/rules#top"), ("A again", "http://a.example/rules/"), ("B", "https://b.example/go"),
            ("C", "https://c.example/syndicated"), ("D", "https://d.example/other"))]
        self.world["answers"]["search"] = lambda user: {"enough": False, "searches": [] if notes_in(user) else ["x"]}
        state = {"depth": "standard"}
        self.run_(state)
        self.assertEqual(self.web.fetched, ["https://www.a.example/rules#top", "https://b.example/go",
                                            "https://c.example/syndicated", "https://d.example/other"],
                         "the same page linked two ways is fetched once")
        self.assertEqual([n["url"] for n in state["notes"]], ["https://a.example/rules", "https://d.example/other"],
                         "a redirect to a page read, and a copy of one, aren't read again")
        skipped = self.kinds(state, "skip")
        self.assertEqual(len([s for s in skipped if s.startswith("Already read")]), 2, skipped)

    def test_a_site_is_read_a_few_times_at_most(self):
        self.web.site = "one-site.example"
        self.world["answers"]["search"] = lambda user: {"enough": False, "searches": [] if notes_in(user) else ["home loan rates"]}
        state = {"depth": "standard"}
        self.run_(state)
        self.assertEqual(len(self.web.fetched), 4, "four pages from one site, then other sites first")

    def test_a_depth_bounds_the_rounds_and_the_pages(self):
        queries = iter(f"search number {i}" for i in range(100))
        self.world["answers"]["search"] = lambda user: {"enough": False, "searches": [next(queries), next(queries)]}
        state = {"depth": "quick"}
        self.run_(state)
        self.assertEqual((state["round"], len(state["read"])), (3, 15), "quick: three rounds, 15 pages")
        self.assertIn("as many as this research takes", self.kinds(state, "info")[-1])
        state = {"depth": "thorough"}
        self.web.fetched.clear()
        self.run_(state)
        self.assertEqual(len(state["read"]), 80, "thorough: 80 pages")
        self.assertEqual(state["budget"], {"rounds": 10, "pages": 80, "minutes": 30, "least": 40})

    def test_a_search_that_fails_is_asked_again_once(self):
        tries, search = {}, self.web.search

        def flaky(query):
            tries[query] = tries.get(query, 0) + 1
            if query == "home loan fees" and tries[query] == 1 or query == "home loan rates":
                raise RuntimeError("DuckDuckGo returned nothing")
            return search(query)
        self.web.search = flaky
        self.world["answers"]["search"] = lambda user: {"enough": False, "searches": [] if notes_in(user) else
                                                        ["home loan rates", "home loan fees"]}
        state = {"depth": "standard"}
        self.run_(state)
        self.assertEqual(tries, {"home loan rates": 2, "home loan fees": 2})
        self.assertEqual(self.kinds(state, "error"), ["Search failed: DuckDuckGo returned nothing"],
                         "only the one that failed twice is said")
        self.assertEqual(state["found"], 8, "the retried search's results are read")

    def test_the_time_is_a_budget_too(self):
        now = [0.0]
        self.web.on_fetch = lambda url: now.__setitem__(0, now[0] + 120)        # each page takes two minutes
        state = {"depth": "quick"}                                              # five minutes of reading
        self.run_(state, clock=lambda: now[0])
        self.assertEqual(len(self.web.fetched), 3, "no page started once the time is up")
        self.assertIn("That's the time for reading: writing from what's found.", self.kinds(state, "info"))
        self.assertGreaterEqual(state["seconds"], 300)


class Report(unittest.TestCase):
    def test_a_line_that_only_cites_goes_when_its_sources_are_cited_elsewhere(self):
        """On screen the marks go, and "Source: [3]." would read "Source:."; the source stays listed when it's
        cited elsewhere, and the line stays when it's the only place a source is cited."""
        report = "| Rate | 8.5% [3] |\n\nSource: [3].\n\nText [4].\n*Sources: [5][6]*\nMore [5]."
        self.assertEqual(research.without_source_lines(report),
                         "| Rate | 8.5% [3] |\n\n\nText [4].\n*Sources: [5][6]*\nMore [5].")
        self.assertIn("never give citations a line or a table column of their own", research.WRITER)

    def test_a_source_column_gives_its_marks_to_the_fact_beside_it(self):
        """A "Source" column of marks reads empty on screen: the marks move to the cell before, a source's name stays,
        and a column left with nothing goes."""
        table = ("| Item | Pune figure | Source |\n|---|---|---|\n| Stamp duty | 7% | [11][22]; derived [11] |\n"
                 "| Registration | 1%, capped at ₹30,000 | [22] |")
        self.assertEqual(research.without_source_columns(table),
                         "| Item | Pune figure | Source |\n| --- | --- | --- |\n| Stamp duty | 7% [11][22][11] | derived |\n"
                         "| Registration | 1%, capped at ₹30,000 [22] |  |")
        only = "Intro [1].\n\n| Rule | Sources |\n|:--|--|\n| No charge on floating loans | [18][34] |\n\nEnd."
        self.assertEqual(research.without_source_columns(only),
                         "Intro [1].\n\n| Rule |\n| :-- |\n| No charge on floating loans [18][34] |\n\nEnd.")
        odd = "| A | Source |\n|---|---|\n| x | [1] | extra |"
        self.assertEqual(research.without_source_columns(odd), odd, "a table it can't read whole is left as it is")


class EngineLoop(Stand):
    """Through ChatEngine: the depth (Settings, or the plan as edited), Stop and Keep researching, the progress, and
    the note on how it was researched."""

    def setUp(self):
        super().setUp()
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-research-loop-")
        self.addCleanup(temp.cleanup)
        self.config = Config(chatdgc_window="32k")
        self.store = ChatStore(Path(temp.name) / "chat")
        self.engine = ChatEngine(self.config, self.store, client_factory=lambda model: Model(self.world),
                                 searcher=lambda q: self.web.search(q), fetcher=lambda u: self.web.fetch(u),
                                 memory=SharedMemory(Path(temp.name) / "memory"), projects=lambda hidden: [])
        self.said = []

    def planned(self):
        chat = self.engine.open()
        return chat, self.engine.research_plan(chat["id"], "Compare home loans for a ₹70 lakh flat in Pune")

    def test_the_depth_comes_from_settings_or_the_plan_as_edited(self):
        self.config["chatdgc_research_depth"] = "quick"
        chat, reply = self.planned()
        self.assertEqual(reply["research"].get("depth"), "quick")
        self.assertIn("Quick: reads up to 15 pages, in up to 5 minutes.", reply["text"])
        done = self.engine.research_run(chat["id"], reply["id"], {**reply["research"]["plan"], "depth": "thorough"})
        self.assertEqual(done["research"]["depth"], "thorough")
        self.assertEqual(done["research"]["budget"]["pages"], 80)

    def test_progress_says_how_far_and_the_report_says_how_it_was_researched(self):
        chat, reply = self.planned()
        done = self.engine.research_run(chat["id"], reply["id"], on_research=lambda mid, s: self.said.append(s))
        running = [s for s in self.said if s.get("status") == "running" and s.get("round")]
        last = running[-1]
        self.assertEqual(last["budget"]["rounds"], 6)
        for key in ("found", "opened", "searches", "seconds"):
            self.assertIn(key, last)
        self.assertNotIn("pool", last, "what's left to read stays off the wire")
        state = done["research"]
        how = state["how"]
        self.assertRegex(how, r"^How this was researched: \d+ rounds of searching and reading, \d+ searches, \d+ sources "
                              r"found, \d+ pages read in full, \d+ of them used, under a minute\. Citations checked: "
                              r"2 of 2 cited claims hold up against their sources\.$")
        self.assertNotIn("pool", state, "a finished report keeps no list of what more rounds would read")
        exported = self.engine.export(chat["id"], "report", reply["id"])
        self.assertTrue(exported.rstrip().endswith(f"*{how}*"), "an export ends with how it was researched")
        self.assertLess(exported.index("## Sources"), exported.index(how))
        writer = next(c for c in self.world["calls"] if c["kind"] == "write")
        self.assertIn(" · dated 12 October 2026\n- What ", writer["user"], "the writer knows each page's date")
        self.assertIn("never write \"the notes\"", research.WRITER, "the report never talks about its notes")

    def test_stop_then_keep_researching_carries_on_and_then_past_the_budget(self):
        self.config["chatdgc_research_depth"] = "quick"
        queries = iter(f"search number {i}" for i in range(100))
        self.world["answers"]["search"] = lambda user: {"enough": False, "searches": [next(queries), next(queries)]}
        chat, reply = self.planned()
        cancel = threading.Event()
        self.web.on_fetch = lambda url: cancel.set() if len(self.web.fetched) == 9 else None
        stopped = self.engine.research_run(chat["id"], reply["id"], cancel=cancel)
        state = stopped["research"]
        self.assertEqual(state["status"], "stopped")
        self.assertEqual((state["round"], len(state["read"])), (2, 9), "stopped in round 2, at its second page")
        self.assertEqual(len(state["notes"]), 8, "what was noted is kept")
        self.web.on_fetch = None
        done = self.engine.research_run(chat["id"], reply["id"])          # Keep researching
        state = done["research"]
        self.assertEqual(state["status"], "done")
        self.assertEqual(state["round"], 3, "it carried on from round 2, to the depth's three")
        self.assertEqual(len(set(self.web.fetched)), len(self.web.fetched), "no page read twice")
        self.assertEqual(len(state["read"]), 15, "and its 15 pages")
        # A run that used its whole budget, stopped while writing, then Keep researching: a little more of each.
        message = self.store.get(chat["id"])["messages"][-1]
        message["research"].update(status="stopped")
        message.pop("sources", None)
        chat_ = self.store.get(chat["id"])
        chat_["messages"][-1] = message
        self.store.save(chat_)
        more = self.engine.research_run(chat["id"], reply["id"])
        self.assertIn("Carrying on: up to 25 pages and 10 minutes in all.", " ".join(a["text"] for a in more["research"]["activity"]))
        self.assertEqual((more["research"]["round"], len(more["research"]["read"])), (5, 25))
        self.assertEqual(len(set(self.web.fetched)), len(self.web.fetched), "still no page read twice")


if __name__ == "__main__":
    unittest.main()
