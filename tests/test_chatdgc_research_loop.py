"""ChatDGC deep research, the loop: rounds that follow the gaps a review finds, pages picked from a pool of results,
read whole and each once (however linked, redirected or copied), a depth's budget of rounds, pages and minutes, no
stopping before it's deep enough, Stop and Keep researching, and the progress and the note on how it was researched.
A stand-in web and a stand-in model; no network."""
import json
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
           "note": research.NOTER, "write": research.WRITER, "check": research.CHECKER,
           "repair": getattr(research, "REPAIRER", "\0")}
STEPS = ["Home loan rates in 2026", "Processing fees", "Prepayment rules"]


class Config(dict):
    base_url, api_key, model = "http://127.0.0.1:11434/v1", "", "chat-model"

    def get(self, key, default=None):
        return super().get(key, default)


class Model:
    """Answers each step by the `answers` the test gives (a dict, or a function of the request's words), by tool call."""

    def __init__(self, world):
        self.world, self.model, self.context_size = world, world.get("model", "chat-model"), 0

    def prepare_model(self, **_):
        pass

    def model_context_limit(self):
        return self.world.get("limit", 131072)

    def chat(self, messages, tools=None, reasoning_effort=None, on_text=None, on_thinking=None, cancel=None):
        system, user = messages[0]["content"], messages[-1]["content"]
        kind = next(k for k, p in PROMPTS.items() if system.startswith(p[:40]))
        with self.world["lock"]:
            self.world["calls"].append({"kind": kind, "user": user, "window": self.context_size})
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
        return url, f"{url} says something specific about it, with figures: rates from 7.5%, fees 0.5%. " * 40


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
        run = research.Research(None, state, client_for=lambda: Model(self.world), room=32768,
                                search=lambda q: self.web.search(q), fetch=self.web.fetch, cancel=cancel, **kwargs)
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

    def test_a_round_waits_for_its_searches_only_so_long(self):
        """A keyless search that keeps failing can take a minute a query; a round waits SEARCH_SECONDS at most, and
        SEARCH_GRACE once one has answered, then goes on with what answered, and the slow ones count as failed. Many
        failed: the line on how it was researched says so."""
        import time as clock
        release, original = threading.Event(), self.web.search
        self.addCleanup(release.set)

        def search(query):
            if "slow" in query:
                release.wait(5)
                raise RuntimeError("timed out")
            return original(query)
        self.web.search = search
        self.world["answers"]["search"] = lambda user: {"enough": False, "searches": [] if notes_in(user) else
                                                        ["slow one", "slow two", "slow three", "home loan rates"]}
        for name, value in (("SEARCH_SECONDS", 10), ("SEARCH_GRACE", 0.4), ("SEARCH_WORKERS", 4)):
            self.addCleanup(setattr, research, name, getattr(research, name))
            setattr(research, name, value)
        state = {"depth": "standard"}
        started = clock.monotonic()
        run = self.run_(state)
        self.assertLess(clock.monotonic() - started, 4, "it didn't wait for the slow searches")
        self.assertEqual((state["failed"], state["found"]), (3, 8))
        self.assertEqual(self.kinds(state, "error"), ["Search took too long: slow one", "Search took too long: slow two",
                                                      "Search took too long: slow three"])
        state.setdefault("notes", [])
        how = run.how()
        self.assertIn("4 searches (3 failed)", how)
        self.assertIn("Many searches failed, so it read from fewer sources than it could have.", how)

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


class Check(Stand):
    def test_a_table_row_is_checked_under_its_tables_heads(self):
        """A bare row ("Qwen3.8-27B | 27B dense | 262K | Apache 2.0") says too little to judge, and a check read
        supported rows as unsupported: each row goes to it as "column: value", an empty cell left out."""
        state = {"question": "q", "plan": {"title": "t", "steps": ["s"], "sites": []},
                 "notes": [{"n": 1, "title": "Qwen", "url": "u", "note": "- Qwen3.8-27B: 27B dense, Apache 2.0"},
                           {"n": 2, "title": "Ornith", "url": "v", "note": "- Ornith-1.5-9B is MIT"}]}
        run = research.Research(None, state, client_for=lambda: Model(self.world), room=32768, search=None)
        report = ("# Models\n\n| Model | Size | Context | Licence |\n|---|---|---|---|\n"
                  "| Qwen3.8-27B | 27B dense [1] | 262K | Apache 2.0 [1] |\n| Ornith-1.5-9B | — | — | MIT [2] |\n\n"
                  "Both are open [1][2].")
        run.check(report)
        asked = next(c for c in self.world["calls"] if c["kind"] == "check")["user"]
        self.assertIn("1. Model: Qwen3.8-27B; Size: 27B dense; Context: 262K; Licence: Apache 2.0 (cites 1)", asked)
        self.assertIn("2. Model: Ornith-1.5-9B; Licence: MIT (cites 2)", asked)
        self.assertIn("3. Both are open. (cites 1, 2)", asked)
        self.assertEqual(state["check"]["claims"], 3, "the heads aren't a claim")
        self.assertIn("Cite every note a sentence or a table row draws on", research.WRITER)


def facts_in(claim: str, text: str) -> bool:
    """The stand-in checker: a source backs a claim when it gives every figure and every long word of it."""
    flat = text.replace(",", "").lower()
    tokens = [f.replace(",", "") for f in re.findall(r"\d[\d,.]*\d%?|\d%", claim)] + \
        [w.lower() for w in re.findall(r"[A-Za-z]{7,}", claim)]
    return all(t.lower() in flat for t in tokens)


def judge(user: str) -> dict:
    """Verdicts, source by source, as the checker gives them: each claim's cited sources that back it."""
    head, _, rest = user.partition("\n\nNotes:\n")
    evidence = {}
    for block in re.split(r"\n\n(?=\[\d+\] )", rest):
        m = re.match(r"\[(\d+)\] (?:\(for claim (\d+), [^)\n]*\)\n)?(.*)", block, re.S)
        evidence[(m[2], int(m[1])) if m[2] else int(m[1])] = m[3]
    verdicts = []
    for number, words, cites in re.findall(r"^(\d+)\. (.*) \(cites ([\d, ]+)\)$", head, re.M):
        backed = [n for n in map(int, cites.split(", ")) if facts_in(words, evidence.get((number, n), evidence.get(n, "")))]
        verdicts.append({"id": int(number), "backed_by": backed})
    return {"verdicts": verdicts}


def repairs(user: str) -> dict:
    out = []
    for number, words in re.findall(r"^(\d+)\. (.*) \(cited", user, re.M):
        if "8.50%" in words:
            out.append({"id": int(number), "action": "correct", "text": "ICICI's rate starts at 8.75% [4].",
                        "why": "The source gives 8.75%, not 8.50%"})
        elif "Kotak" in words:
            out.append({"id": int(number), "action": "correct", "text": "Kotak waives processing fees [2].", "why": "x"})
        else:
            out.append({"id": int(number), "action": "delete", "why": "No source says this"})
    return {"repairs": out}


class Citations(Stand):
    """The check, source by source: a claim keeps the sources that back it; one none backs gets a second look at the
    pages themselves, then goes back to the model once to be corrected or deleted, and a correction is checked again.
    Nothing is left standing uncited; sentences that cite nothing are the writer's own and aren't touched."""

    NOTES = [{"n": 1, "title": "SBI rates", "url": "https://sbi.co.in/rates", "note": "- SBI home loans start at 7.50% p.a."},
             {"n": 2, "title": "A blog", "url": "https://blog.example/prepay",
              "note": "- Floating-rate loans carry no prepayment charge from January 2026."},
             {"n": 3, "title": "HDFC fees", "url": "https://hdfc.example/fees", "note": "- HDFC charges a processing fee of up to 0.50%."},
             {"n": 4, "title": "ICICI rates", "url": "https://icici.example/rates", "note": "- ICICI's rate starts at 8.75%."}]
    REPORT = ("# Home loans\n\nRates start at 7.50% [1][2]. The processing fee is capped at ₹15,000 [3]. "
              "ICICI's rate starts at 8.50% [4]. SBI is the largest lender in Pune [1].\n\n- Kotak waives processing "
              "fees for women [2].\n\nThis is my own reasoning, from all of that.\n\n| Lender | Rate |\n|---|---|\n"
              "| SBI | 7.50% [1] |\n| Axis | 9.99% [4] |\n")

    def checked(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-research-pages-")
        self.addCleanup(temp.cleanup)
        self.pages = Path(temp.name) / "pages"
        self.pages.mkdir()
        filler = "Other terms and conditions apply to every loan. " * 120
        (self.pages / "1.txt").write_text("SBI home loans start at 7.50% p.a. " + filler)
        (self.pages / "2.txt").write_text("Floating-rate loans carry no prepayment charge. " + filler)
        (self.pages / "3.txt").write_text(filler + "The processing fee is capped at ₹15,000 plus GST. " + filler)
        (self.pages / "4.txt").write_text("ICICI's rate starts at 8.75%. " + filler)
        self.world["answers"].update(check=judge, repair=repairs)
        self.state = {"question": "q", "plan": {"title": "t", "steps": ["s"], "sites": []},
                      "notes": [dict(n) for n in self.NOTES], "round": 2, "searched": ["a"], "found": 9, "opened": 4,
                      "whole": 4}
        run = research.Research(None, self.state, client_for=lambda: Model(self.world), room=32768, search=None,
                                pages=self.pages)
        return run, run.check(self.REPORT)

    def test_each_source_on_its_own_then_the_page_then_a_repair(self):
        run, report = self.checked()
        self.assertIn("Rates start at 7.50% [1].", report, "a source that doesn't back a claim loses its citation; "
                                                           "one that does keeps it")
        self.assertIn("The processing fee is capped at ₹15,000 [3].", report,
                      "the page says what its note left out, so the claim stays cited")
        self.assertIn("ICICI's rate starts at 8.75% [4].", report, "corrected to what the source says")
        self.assertNotIn("8.50%", report)
        self.assertNotIn("largest lender", report, "a claim no source backs goes, not left uncited")
        self.assertNotIn("Kotak", report, "a correction the check still doesn't back goes too")
        self.assertIn("| Axis | not given |", report, "a row stays (a comparison doesn't lose a lender): only the cell "
                                                      "no source gives says so")
        self.assertIn("| SBI | 7.50% [1] |", report)
        self.assertIn("This is my own reasoning, from all of that.", report, "a sentence that cites nothing is the "
                                                                            "writer's own")
        check = self.state["check"]
        self.assertEqual({k: check[k] for k in ("claims", "checked", "supported", "first", "page")},
                         {"claims": 7, "checked": 7, "supported": 3, "first": 2, "page": 1})
        self.assertEqual(check["sources"], {"cited": 8, "backed": 2})
        self.assertEqual(sorted((c["now"], c["why"]) for c in check["corrected"]),
                         [("Axis | not given", "No source gives Rate (9.99%)"),
                          ("ICICI's rate starts at 8.75%.", "The source gives 8.75%, not 8.50%")])
        self.assertEqual(sorted(r["claim"][:5] for r in check["removed"]), ["Kotak", "SBI i"])
        self.assertEqual(len([c for c in self.world["calls"] if c["kind"] == "repair"]), 2,
                         "one call repairs them all, and one stricter call what it didn't fix")
        self.assertIn("Citations checked: 3 of 7 cited claims hold up against their sources; 2 corrected, 2 removed: "
                      "no source backed them.", run.how())

    def test_a_fact_no_source_gives_means_no_source_backs_the_claim(self):
        """Sources that say part of a claim don't back it when a fact of it is in none of them (a release date only
        the writer had). With its page kept, the date is on none of its cited pages: when no repair fixes it, it
        goes, saying which figure. Without the page, part of it is in its source: kept, without a citation."""
        self.world["answers"].update(
            check=lambda user: {"verdicts": [{"id": 1, "backed_by": [1], "missing": "the date, 27 July 2026"}]},
            repair=lambda user: {"repairs": [{"id": 1, "as_written": False, "corrected": ""}]})
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-research-pages-")
        self.addCleanup(temp.cleanup)
        (Path(temp.name) / "1.txt").write_text("Kimi K3 has 2.8T total parameters. " * 20)
        for pages in (Path(temp.name), None):
            self.world["calls"].clear()
            state = {"question": "q", "plan": {"title": "t", "steps": ["s"], "sites": []},
                     "notes": [dict(self.Citations_NOTE)]}
            run = research.Research(None, state, client_for=lambda: Model(self.world), room=32768, search=None,
                                    pages=pages)
            report = run.check("Kimi K3 (2.8T) went up on 27 July 2026 [1]. It is big.")
            self.assertEqual((state["check"]["supported"], state["check"]["sources"]), (0, {"cited": 1, "backed": 0}))
            repair = next(c for c in self.world["calls"] if c["kind"] == "repair")
            self.assertIn("no source gives: the date, 27 July 2026", repair["user"])
            if pages:
                self.assertEqual(report, "It is big.")
                self.assertEqual(state["check"]["removed"][0]["why"], "No source backed it: no cited page gives 27, 2026")
            else:
                self.assertEqual(report, "Kimi K3 (2.8T) went up on 27 July 2026. It is big.")
                self.assertEqual(state["check"]["judgement"][0]["why"], "Its sources give part of it; kept without a citation")

    Citations_NOTE = {"n": 1, "title": "Kimi", "url": "https://kimi.example", "note": "- Kimi K3: 2.8T total parameters."}

    def run_check(self, report, verdicts, repairs=None, notes=None, pages=None, question="q"):
        answers = iter(verdicts)
        fixes = iter(repairs if repairs and isinstance(repairs[0], list) else [repairs or []] * 2)
        self.world["answers"].update(check=lambda user: {"verdicts": next(answers)},
                                     repair=lambda user: {"repairs": next(fixes)})
        state = {"question": question, "plan": {"title": "t", "steps": ["s"], "sites": []},
                 "notes": notes or [dict(self.Citations_NOTE)]}
        kept = None
        if pages:
            temp = tempfile.TemporaryDirectory(prefix="chatdgc-research-pages-")
            self.addCleanup(temp.cleanup)
            kept = Path(temp.name)
            for n, text in pages.items():
                (kept / f"{n}.txt").write_text(text)
        run = research.Research(None, state, client_for=lambda: Model(self.world), room=32768, search=None, pages=kept)
        return run.check(report), state["check"]

    def calls(self, kind):
        return [c for c in self.world["calls"] if c["kind"] == kind]

    def test_a_figure_on_none_of_its_pages_isnt_kept_on_its_notes_word(self):
        """The checker trusted a wrong note (Kimi K3 "1.56 TB"; the page has 594 GB, and 51.56 in a score): a figure on
        none of the cited pages, in any form (8.00% is 8%, 1,000 is 1000, ₹70 lakh is 70,00,000), sends the claim to
        the page check and the repair, whatever the note said. Counted as caught."""
        notes = [{"n": 1, "title": "Kimi", "url": "https://kimi.example", "note": "- Kimi K3 weights: 1.56 TB."}]
        pages = {1: "Kimi K3 MXFP4 weights are 594 GB. It scores 51.56 on one test. " * 10}
        report, check = self.run_check(
            "Kimi K3's weights are 1.56 TB [1].",
            [[{"id": 1, "why": "The note gives 1.56 TB.", "backed_by": [1], "holds": True}],
             [{"id": 1, "why": "The page gives 594 GB.", "backed_by": [], "holds": False, "missing": "1.56 TB"}],
             [{"id": 1, "why": "The page gives 594 GB.", "backed_by": [1], "holds": True}]],
            [{"id": 1, "why": "The page gives 594 GB, not 1.56 TB.", "judgement": False, "as_written": False,
              "corrected": "Kimi K3's MXFP4 weights are 594 GB [1]."}], notes=notes, pages=pages)
        self.assertEqual(report, "Kimi K3's MXFP4 weights are 594 GB [1].")
        self.assertEqual((check["figures"], check["first"], len(check["corrected"])), (1, 0, 1))
        self.assertEqual(len(self.calls("check")), 3, "first check, the page, and the correction")
        self.assertIn("no cited page has the figure 1.56", self.calls("repair")[0]["user"])
        self.assertIn("From the page itself:", self.calls("check")[-1]["user"], "a correction is checked against its page")
        same = {1: "Fees are 8% of 1000 on ₹70,00,000 loans. " * 5}
        report, check = self.run_check("Fees are 8.00% of 1,000 on ₹70 lakh loans [1].",
                                       [[{"id": 1, "why": "Given.", "backed_by": [1], "holds": True}]],
                                       notes=notes, pages=same)
        self.assertEqual((report, check["figures"]), ("Fees are 8.00% of 1,000 on ₹70 lakh loans [1].", 0),
                         "the same figures, written another way")
        rounded = {1: "At 131,072 tokens it needs 24.347 GiB; Ornith-1.5-35B-A3B and Qwen3.8-27B both load. " * 5}
        report, check = self.run_check("At 131K tokens Qwen3.8-27B needs 24.3 GiB, 20-fold more [1].",
                                       [[{"id": 1, "why": "Given.", "backed_by": [1], "holds": True}]],
                                       notes=notes, pages=rounded)
        self.assertEqual(check["figures"], 0, "rounded as the page's figure rounds, a scale word within 0.6%, and "
                                              "numbers inside a name or a compound word aren't figures")
        report, check = self.run_check("For a ₹70 lakh flat, SBI charges 8% [1].",
                                       [[{"id": 1, "why": "Given.", "backed_by": [1], "holds": True}]],
                                       notes=notes, pages=same, question="Home loans for a ₹70 lakh flat in Pune")
        self.assertEqual(check["figures"], 0, "the question's own figures are the user's, not a source's")
        garbled = {1: "On \u00e2\u00b950 lakh: up to \u00e2\u00b925,000. Table says up to \u00e2\u00b91,00,000. " * 5}
        report, check = self.run_check("On ₹50 lakh it's ₹25,000 or ₹1,00,000 [1].",
                                       [[{"id": 1, "why": "Given.", "backed_by": [1], "holds": True}]],
                                       notes=notes, pages=garbled)
        self.assertEqual(check["figures"], 0, "a page that writes ₹ as â¹ still has its figures")

    def test_a_rows_own_arithmetic_stays_in_its_cell(self):
        notes = [{"n": 4, "title": "HDFC", "url": "https://hdfc.example", "note": "- HDFC: processing fee 0.50%."}]
        report, check = self.run_check(
            "| Lender | Fee | On this loan |\n|---|---|---|\n| HDFC | 0.50% [4] | about ₹35,000 [4] |",
            [[{"id": 1, "why": "No ₹35,000.", "backed_by": [4], "holds": False, "missing": "₹35,000"}],
             [{"id": 1, "why": "No ₹35,000.", "backed_by": [4], "holds": False, "missing": "₹35,000"}],
             [{"id": 1, "why": "Given.", "backed_by": [4], "holds": True},
              {"id": 2, "why": "Not given.", "backed_by": [], "holds": False, "missing": "₹35,000"}],
             [{"id": 2, "why": "Not given.", "backed_by": [], "holds": False, "missing": "₹35,000"}]],
            notes=notes, pages={4: "HDFC processing fee: 0.50% of the loan. " * 10},
            question="Home loans for a ₹70 lakh flat in Pune")
        self.assertEqual(report.splitlines()[-1], "| HDFC | 0.50% [4] | about ₹35,000 |",
                         "0.5% of ₹70 lakh: computed, kept without a citation, not blanked")
        report, check = self.run_check(
            "| Lender | Fee |\n|---|---|\n| HDFC | 9.99% [4] |",
            [[{"id": 1, "why": "No.", "backed_by": [], "holds": False, "missing": "9.99%"}]],
            notes=notes, pages={4: "HDFC processing fee: 0.50% of the loan. " * 10})
        self.assertEqual(report.splitlines()[-1], "| HDFC | 9.99% [4] |", "a row whose cells couldn't be checked stays")

    def test_the_reports_own_arithmetic_is_derived_not_sourced(self):
        """₹70 lakh over 20 years at 8.75% is about ₹61,900 a month: computed, not on any page. It stays, without a
        citation, and isn't swapped for another example; no repair is asked for."""
        notes = [{"n": 2, "title": "Rates", "url": "https://rates.example", "note": "- 8.75% for loans over ₹70 lakh."}]
        pages = {2: "Loans over ₹70 lakh: 8.75% for up to 20 years. " * 10}
        report, check = self.run_check(
            "A ₹70 lakh loan over 20 years at 8.75% costs about ₹61,900 a month [2].",
            [[{"id": 1, "why": "No EMI given.", "backed_by": [2], "holds": False, "missing": "₹61,900"}],
             [{"id": 1, "why": "No EMI given.", "backed_by": [2], "holds": False, "missing": "₹61,900"}]],
            notes=notes, pages=pages)
        self.assertEqual(report, "A ₹70 lakh loan over 20 years at 8.75% costs about ₹61,900 a month.")
        self.assertEqual(check["judgement"], [{"claim": "A ₹70 lakh loan over 20 years at 8.75% costs about ₹61,900 a month.",
                                               "why": "The report's own arithmetic on figures its sources give"}])
        self.assertEqual(self.calls("repair"), [])
        self.assertFalse(research._derivable("32 GB", "On a 24 GB GPU or a 32 GB Mac, Qwen3.8-27B at 8 bits is best."),
                         "figures that happen to add up, in a sentence that does no sums, aren't arithmetic")
        self.assertTrue(research._derivable("₹56 lakh", "The bank lends 80% of ₹70 lakh, ₹56 lakh, leaving the rest."))
        self.assertTrue(research._derivable("₹35,000", "| HDFC | 0.50% | about ₹35,000 | Home loans for a ₹70 lakh flat",
                                            cue=False), "a share of an amount, in a table row")
        self.assertFalse(research._derivable("40B", "| GLM-5.3 | Aug 14; Aug 28, 2026 | ~753B MoE, ~40B active |", cue=False),
                         "in a row, only a share of an amount counts: other sums are coincidence")

    def test_doubt_in_a_verdicts_reason_means_a_second_look(self):
        """Kept with "hmm, that's 6% + 1% for men" in its reason: it goes to the page check, not straight through."""
        pages = {1: "Stamp duty in Pune is 6% + 1% for men and 5% + 1% for women. " * 10}
        notes = [{"n": 1, "title": "Duty", "url": "https://duty.example", "note": "- Stamp duty 5% + 1% + 1%."}]
        report, check = self.run_check(
            "Stamp duty is 5% + 1% + 1% [1].",
            [[{"id": 1, "why": "The note agrees, hmm, but the page says 6% + 1% for men.", "backed_by": [1],
               "holds": True}],
             [{"id": 1, "why": "Men pay 6% + 1%.", "backed_by": [], "holds": False, "missing": "5% + 1% + 1%"}],
             [{"id": 1, "why": "Given.", "backed_by": [1], "holds": True}]],
            [{"id": 1, "why": "Men pay 6% + 1%, women 5% + 1%.", "judgement": False, "as_written": False,
              "corrected": "Stamp duty is 6% + 1% for men and 5% + 1% for women [1]."}], notes=notes, pages=pages)
        self.assertEqual(report, "Stamp duty is 6% + 1% for men and 5% + 1% for women [1].")
        self.assertEqual(len(self.calls("check")), 3)

    def test_a_plain_but_in_a_reason_isnt_doubt(self):
        """Doubt is "hmm", "not the same", "doesn't match": a reason saying "gives X but not Y" with holds true isn't
        sent back (it sent good claims round the loop until they were lost)."""
        report, check = self.run_check("Kimi K3 has 2.8T parameters [1].",
                                       [[{"id": 1, "why": "Gives 2.8T, but not the date; the claim has none.",
                                          "backed_by": [1], "holds": True}]])
        self.assertEqual((report, len(self.calls("check"))), ("Kimi K3 has 2.8T parameters [1].", 1))

    def test_a_verdict_with_its_sources_and_nothing_missing_cant_be_a_removal(self):
        report, check = self.run_check("Kimi K3 has 2.8T parameters [1].",
                                       [[{"id": 1, "why": "Odd wording.", "backed_by": [1], "holds": False}]])
        self.assertEqual((report, check["supported"], self.calls("repair")), ("Kimi K3 has 2.8T parameters [1].", 1, []))

    def test_a_claim_part_of_which_is_sourced_is_corrected_not_removed(self):
        """The report's main answer ("Qwen3.8-27B is the strongest you can run", one figure off and a ranking no source
        makes) was removed. A repair that would remove a claim part of which is in a note gets a second, stricter try,
        which corrects it (fix the figure, say who ranks it)."""
        notes = [{"n": 29, "title": "Guide", "url": "https://guide.example",
                  "note": "- The best local LLM for coding in 2026 is Qwen3.8 27B."}]
        report, check = self.run_check(
            "Qwen3.8-27B (27.8B) is the strongest model you can run on your desk [29].",
            [[{"id": 1, "why": "27B, not 27.8B; no ranking.", "backed_by": [29], "holds": False, "missing": "27.8B"}],
             [{"id": 1, "why": "Given.", "backed_by": [29], "holds": True}]],
            [[{"id": 1, "why": "No source ranks it.", "judgement": False, "as_written": False, "corrected": ""}],
             [{"id": 1, "why": "27B, and one guide calls it the best.", "judgement": False, "as_written": False,
               "corrected": "One guide calls Qwen3.8-27B the best local model for coding in 2026 [29]."}]],
            notes=notes)
        self.assertEqual(report, "One guide calls Qwen3.8-27B the best local model for coding in 2026 [29].")
        self.assertEqual((len(check["corrected"]), check["removed"]), (1, []))
        self.assertIn("Second try", self.calls("repair")[1]["user"])

    def test_a_verdict_whose_reason_says_backed_isnt_removed(self):
        """Reasons come first, and a "doesn't hold" its own reason contradicts ("All figures appear in the cited
        sources") doesn't remove a claim: the check's, or the repair's."""
        self.assertLess(list(research.CHECK_SCHEMA["properties"]["verdicts"]["items"]["properties"]).index("why"),
                        list(research.CHECK_SCHEMA["properties"]["verdicts"]["items"]["properties"]).index("holds"))
        report, check = self.run_check("Kimi K3 has 2.8T parameters [1].",
                                       [[{"id": 1, "why": "All figures appear in the cited sources.", "backed_by": [1],
                                          "holds": False}]])
        self.assertEqual((report, check["supported"], check["removed"]), ("Kimi K3 has 2.8T parameters [1].", 1, []))
        report, check = self.run_check(
            "Kimi K3 has 2.8T parameters [1].",
            [[{"id": 1, "why": "Only part of it.", "backed_by": [1], "holds": False, "missing": "2.8T"}],
             [{"id": 1, "why": "Fine.", "backed_by": [1], "holds": True}]],
            [{"id": 1, "why": "Figures match the cited sources.", "judgement": False, "as_written": False, "corrected": ""}])
        self.assertEqual((report, check["rechecked"], check["removed"]), ("Kimi K3 has 2.8T parameters [1].", 1, []))

    def test_what_counts_as_a_reason_saying_backed(self):
        for said in ("Figures match the cited sources.", "All figures appear in the cited sources.",
                     "Every tool and the qwen3_xml flag with that quote appear in the notes.",
                     "Both figures are given; no correction needed on facts.", "All cells are backed as stated."):
            self.assertTrue(research.says_backed(said), said)
        for said in ("Not all figures appear in the sources.", "No source gives an Aug 26 release date.",
                     "The catalog gives 1.7T total, not 1.6T.", "Nothing in the notes appears in the sources cited."):
            self.assertFalse(research.says_backed(said), said)

    def test_a_correction_that_changes_nothing_isnt_one(self):
        report, check = self.run_check(
            "Kimi K3 has 2.8T parameters [1].",
            [[{"id": 1, "why": "x", "backed_by": [], "holds": False, "missing": "2.8T"}],
             [{"id": 1, "why": "y", "backed_by": [1], "holds": True}]],
            [{"id": 1, "why": "No correction needed.", "judgement": False, "as_written": False,
              "corrected": "Kimi K3 has 2.8T parameters [1]."}])
        self.assertEqual((check["corrected"], check["rechecked"]), ([], 1))

    def test_the_reports_own_judgement_stays_uncited(self):
        """Advice or a conclusion drawn from facts given elsewhere isn't a fact a source states: it stays, without its
        citation, and is listed as such. Only factual claims are removed."""
        report, check = self.run_check(
            "Kimi K3 has 2.8T parameters [1]. For anything bigger, plan on APIs [1]. It ships in 2027 [1].",
            [[{"id": 1, "why": "a", "backed_by": [1], "holds": True},
              {"id": 2, "why": "b", "backed_by": [], "holds": False, "missing": "all"},
              {"id": 3, "why": "c", "backed_by": [], "holds": False, "missing": "2027"}]],
            [{"id": 2, "why": "The report's own advice.", "judgement": True, "as_written": False, "corrected": ""},
             {"id": 3, "why": "No source gives a date.", "judgement": False, "as_written": False, "corrected": ""}])
        self.assertEqual(report, "Kimi K3 has 2.8T parameters [1]. For anything bigger, plan on APIs.")
        self.assertEqual([j["claim"] for j in check["judgement"]], ["For anything bigger, plan on APIs."])
        self.assertEqual([r["claim"] for r in check["removed"]], ["It ships in 2027."])

    def test_a_table_row_loses_only_the_cell_no_source_gives(self):
        """A comparison table keeps every row: the row is checked cell by cell, and a cell no source gives says
        "not given" (the model is still listed, with what the sources do give)."""
        notes = [{"n": 3, "title": "Qwen", "url": "https://qwen.example", "note": "- Alibaba's Qwen3.8-Flash-Next."}]
        report, check = self.run_check(
            "| Model | Developer | Release |\n|---|---|---|\n| Qwen3.8-Flash-Next | Alibaba [3] | Aug 26, 2026 [3] |",
            [[{"id": 1, "why": "No date.", "backed_by": [3], "holds": False, "missing": "Aug 26, 2026"}],
             [{"id": 1, "why": "Alibaba is there.", "backed_by": [3], "holds": True},
              {"id": 2, "why": "No date.", "backed_by": [], "holds": False, "missing": "the date"}]],
            notes=notes)
        self.assertEqual(report.splitlines()[-1], "| Qwen3.8-Flash-Next | Alibaba [3] | not given |")
        self.assertEqual(check["corrected"], [{"claim": "Model: Qwen3.8-Flash-Next; Developer: Alibaba; Release: Aug 26, 2026",
                                               "now": "Qwen3.8-Flash-Next | Alibaba | not given",
                                               "why": "No source gives Release (Aug 26, 2026)"}])
        self.assertEqual(len([c for c in self.world["calls"] if c["kind"] == "repair"]), 0, "a row isn't rewritten whole")

    def test_holds_is_the_checks_word_and_a_repair_can_say_keep(self):
        """`holds` decides, whatever `missing` says ("no facts missing" is no missing fact). A claim that doesn't hold
        and that the repair says the notes do give, as written, is checked once more, and stays when it holds."""
        verdicts = iter([[{"id": 1, "backed_by": [1], "holds": True, "missing": "no facts missing"},
                          {"id": 2, "backed_by": [1], "holds": False, "missing": "2.8T"}],
                         [{"id": 2, "backed_by": [1], "holds": True}]])
        self.world["answers"].update(check=lambda user: {"verdicts": next(verdicts)},
                                     repair=lambda user: {"repairs": [{"id": 2, "as_written": True, "corrected": "", "why": "It's there"}]})
        state = {"question": "q", "plan": {"title": "t", "steps": ["s"], "sites": []}, "notes": [dict(self.Citations_NOTE)]}
        run = research.Research(None, state, client_for=lambda: Model(self.world), room=32768, search=None)
        report = run.check("Kimi K3 is open [1]. It has 2.8T parameters [1].")
        self.assertEqual(report, "Kimi K3 is open [1]. It has 2.8T parameters [1].")
        check = state["check"]
        self.assertEqual({k: check[k] for k in ("supported", "first", "page", "rechecked")},
                         {"supported": 2, "first": 1, "page": 0, "rechecked": 1})
        self.assertEqual((check["corrected"], check["removed"]), ([], []))

    def test_the_verdicts_and_the_passages_are_kept_beside_the_pages_not_on_the_wire(self):
        run, _ = self.checked()
        kept = json.loads((self.pages / "check.json").read_text())
        fee = next(c for c in kept["claims"] if "₹15,000" in c["claim"])
        self.assertEqual((fee["first"], fee["page"], fee["final"]), ([], [3], "page"))
        self.assertIn("capped at ₹15,000", fee["passages"]["3"])
        self.assertLessEqual(len(fee["passages"]["3"]), research.PASSAGE_CHARS)
        self.assertEqual(fee["urls"], {"3": "https://hdfc.example/fees"})
        self.assertNotIn("passages", json.dumps(run.snapshot()))
        self.assertNotIn("Other terms and conditions", json.dumps(self.state))

    def test_a_page_read_is_kept_on_disk_as_it_was_read(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-research-pages-")
        self.addCleanup(temp.cleanup)
        state = {"question": "q", "plan": {"title": "t", "steps": ["s"], "sites": []}}
        run = research.Research(None, state, client_for=lambda: Model(self.world), room=32768, search=None,
                                fetch=self.web.fetch, pages=Path(temp.name) / "p")
        run._read({"url": "https://a.example/x", "title": "A"})
        self.assertTrue((Path(temp.name) / "p" / "1.txt").read_text().startswith("https://a.example/x says"))
        self.assertNotIn("says something specific", json.dumps(state))

    def test_the_passage_is_where_the_claims_figures_are(self):
        page = ("Nothing to see here. " * 400) + "Muse Glimmer 30B runs at 74.9 tok/s on an RTX 4090." + (" More filler." * 400)
        found = research.passage(page, "Muse Glimmer 30B | 74.9 tok/s | RTX 4090", 1000)
        self.assertIn("74.9 tok/s", found)
        self.assertLessEqual(len(found), 1000)
        self.assertEqual(research.passage("short page", "anything", 1000), "short page")


class Depths(unittest.TestCase):
    def test_a_bigger_window_reads_more_and_no_note_reaches_the_writer_shorter(self):
        pages = {room: {d: b["pages"] for d, b in research.depths(room).items()}
                 for room in (16384, 32768, 65536, 131072, 1048576)}
        self.assertEqual(pages, {16384: {"quick": 15, "standard": 40, "thorough": 80},
                                 32768: {"quick": 15, "standard": 40, "thorough": 80},
                                 65536: {"quick": 15, "standard": 60, "thorough": 120},
                                 131072: {"quick": 15, "standard": 80, "thorough": 160},
                                 1048576: {"quick": 15, "standard": 80, "thorough": 160}})
        # The writer reads every note in 55% of the window: a note gets no shorter than a 32k window's 40 gave it.
        each = lambda room, n: int(room * 0.55) * 4 // n          # noqa: E731
        for room in (32768, 65536, 131072):
            budgets = research.depths(room)
            self.assertGreaterEqual(each(room, budgets["standard"]["pages"]), each(32768, 40), room)
            self.assertGreaterEqual(each(room, budgets["thorough"]["pages"]), each(32768, 80), room)
            for budget in budgets.values():
                self.assertEqual(budget["least"], -(-budget["pages"] // 2))
                self.assertLessEqual(-(-budget["pages"] // budget["rounds"]) + 1, research.MAX_ROUND_READS,
                                     "the rounds read the pages")


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

    def test_a_hosted_model_with_a_big_window_researches_deeper_by_itself(self):
        """The model decides: a :cloud model with a 1M window researches in 128k and reads 80 pages at Standard; the
        same window on this machine stays at the chat's 32k (memory), and 40 pages. Edit and Settings still rule."""
        self.world.update(model="big-model:cloud", limit=1048576)
        queries = iter(f"search number {i}" for i in range(1000))
        self.world["answers"]["search"] = lambda user: {"enough": False, "searches": [next(queries), next(queries)]}
        chat, reply = self.planned()
        state = reply["research"]
        self.assertEqual((state["depth"], state["budget"]["pages"], state["budget"]["rounds"]), ("standard", 80, 10))
        self.assertEqual(state["depths"]["thorough"]["pages"], 160)
        self.assertIn("Standard: reads up to 80 pages, in up to 25 minutes.", reply["text"])
        done = self.engine.research_run(chat["id"], reply["id"], on_research=lambda mid, s: self.said.append(s))
        self.assertEqual({c["window"] for c in self.world["calls"] if c["kind"] != "plan"}, {131072},
                         "every step is sent research's window")
        self.assertEqual(self.said[-1]["budget"]["pages"], 80, "progress shows the real budget")
        self.assertEqual((done["research"]["round"], len(done["research"]["read"])), (9, 80), "80 pages, in 9 rounds")
        # Thorough, as edited, on the same model.
        chat, reply = self.planned()
        done = self.engine.research_run(chat["id"], reply["id"], {**reply["research"]["plan"], "depth": "thorough"})
        self.assertEqual(done["research"]["budget"]["pages"], 160)
        # On this machine: the chat's window, and a 32k window's budget.
        self.world.update(model="big-local-model")
        self.world["calls"].clear()
        chat, reply = self.planned()
        self.assertEqual(reply["research"]["budget"]["pages"], 40)
        self.engine.research_run(chat["id"], reply["id"])
        self.assertEqual({c["window"] for c in self.world["calls"] if c["kind"] != "plan"}, {32768})
        # Settings' depth still rules.
        self.world.update(model="big-model:cloud")
        self.config["chatdgc_research_depth"] = "quick"
        self.assertEqual(self.planned()[1]["research"]["budget"]["pages"], 15)

    def test_the_pages_and_the_verdicts_live_beside_the_chat_and_go_with_it(self):
        chat, reply = self.planned()
        self.engine.research_run(chat["id"], reply["id"])
        kept = self.store.root / "research" / chat["id"] / reply["id"]
        self.assertTrue((kept / "1.txt").is_file())
        self.assertTrue((kept / "check.json").is_file())
        self.engine.delete(chat["id"])
        self.assertFalse((self.store.root / "research" / chat["id"]).exists(), "deleting the chat deletes them")

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
