"""ChatDGC deep research: a plan first, to edit or start; rounds of searching and reading, each useful page a note;
one report from the notes alone, streamed; every citation checked, and the ones that don't hold dropped. Stop
keeps what was found, and the report can be written from it. Pages are data, read through the public-only fetch."""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

from dgc.chatdgc import research
from dgc.chatdgc.engine import ChatEngine, ChatEngineError
from dgc.chatdgc.store import ChatStore
from dgc.shared_memory import SharedMemory
from dgc.llm import ToolCall

KINDS = {"plan": research.PLANNER[:40], "search": research.SEARCHER[:40], "note": research.NOTER[:40],
         "write": research.WRITER[:40], "check": research.CHECKER[:40]}
PAGES = {
    "https://rbi.org.in/lrs": ("Liberalised Remittance Scheme", "Under the LRS a resident individual may remit up to "
                               "USD 250,000 per financial year for permitted current or capital account transactions, "
                               "including the purchase of immovable property outside India. " * 3),
    "https://gov.uk/sdlt": ("Stamp Duty Land Tax", "Non-UK residents pay a 2% surcharge on SDLT for residential "
                            "property in England, on top of the standard rates. " * 4),
    "https://example.com/ad": ("Buy now", "Cheap flights and hotels, book today! " * 20),
}


class Config(dict):
    base_url, api_key, model = "http://127.0.0.1:11434/v1", "", "chat-model"

    def get(self, key, default=None):
        return super().get(key, default)


def kind_of(system: str) -> str:
    return next(k for k, start in KINDS.items() if system.startswith(start))


class Model:
    """Answers each research step as the world scripts it: by tool call when one is offered, else as JSON in text."""

    def __init__(self, model, world):
        self.model, self.world, self.context_size = model, world, 0

    def prepare_model(self, **_):
        pass

    def model_context_limit(self):
        return 131072

    def chat(self, messages, tools=None, reasoning_effort=None, on_text=None, on_thinking=None, cancel=None):
        kind = kind_of(messages[0]["content"])
        with self.world["lock"]:
            self.world["calls"].append({"kind": kind, "user": messages[-1]["content"], "system": messages[0]["content"],
                                        "tools": [t["function"]["name"] for t in tools or []],
                                        "effort": reasoning_effort})
        if self.world.get("toolless") and tools:
            raise RuntimeError('HTTP 400: {"error":"registry.ollama.ai/library/gemma3:4b does not support tools"}')
        answer = self.world["answers"][kind]
        answer = answer(messages[-1]["content"]) if callable(answer) else answer
        if kind == "write":
            for part in answer:
                on_text(part)
            return SimpleNamespace(content="".join(answer), tool_calls=[], finish_reason="stop", thinking="", usage={})
        if tools:
            call = ToolCall("c1", tools[0]["function"]["name"], answer)
            return SimpleNamespace(content="", tool_calls=[call], finish_reason="stop", thinking="", usage={})
        return SimpleNamespace(content="Here you go:\n```json\n" + json.dumps(answer) + "\n```", tool_calls=[],
                               finish_reason="stop", thinking="", usage={})


def note_for(user: str) -> dict:
    if "Cheap flights" in user:
        return {"relevant": False, "note": ""}
    if "USD 250,000 per financial year" in user:
        return {"relevant": True, "note": "- LRS allows a resident to remit up to USD 250,000 a financial year.\n"
                                          "- Purchase of immovable property outside India is a permitted purpose."}
    return {"relevant": True, "note": "- Non-UK residents pay a 2% SDLT surcharge on residential property in England."}


REPORT = ["# Buying a London flat from India\n\n",
          "An Indian resident can buy property abroad under the LRS [1]. ",
          "The limit is USD 250,000 a year [1]. ",
          "The flat needs no UK visa [2]. ",
          "A 2% surcharge applies to non-residents [2]. ",
          "Banks also charge fees [7].\n\n",
          "| Cost | Amount |\n| --- | --- |\n| SDLT surcharge | 2% [2] |\n"]


def checks(user: str) -> dict:
    """The check says the visa claim doesn't hold; every other claim does."""
    ids = [int(line.split(".")[0]) for line in user.split("Notes:")[0].splitlines() if line[:1].isdigit()]
    return {"verdicts": [{"id": i, "supported": "visa" not in next(l for l in user.splitlines() if l.startswith(f"{i}."))}
                         for i in ids]}


class ResearchTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-research-")
        self.addCleanup(temp.cleanup)
        self.store = ChatStore(Path(temp.name) / "chat")
        searches = iter([{"enough": False, "searches": ["LRS property abroad", "SDLT non resident surcharge"]},
                         {"enough": True, "searches": []}])
        self.world = {"calls": [], "lock": threading.Lock(), "searched": [], "fetched": [],
                      "answers": {"plan": {"title": "London flat from India",
                                           "steps": ["1. What FEMA and the LRS allow", "2026 UK purchase taxes",
                                                     "What it costs in all"]},
                                  "search": lambda user: next(searches, {"enough": True, "searches": []}),
                                  "note": note_for, "write": REPORT, "check": checks}}
        self.config = Config(chatdgc_window="32k")
        self.engine = ChatEngine(self.config, self.store, client_factory=lambda model: Model(model or "chat-model", self.world),
                                 searcher=self.search, fetcher=self.fetch,
                                 memory=SharedMemory(Path(temp.name) / "memory"), projects=lambda hidden: [])
        self.said = []
        # Pages are read WORKERS at a time and numbered as their notes land; one at a time, the numbers are known.
        workers, research.WORKERS = research.WORKERS, 1
        self.addCleanup(setattr, research, "WORKERS", workers)

    def search(self, query):
        self.world["searched"].append(query)
        if "LRS" in query:
            return [{"title": "LRS", "url": "https://rbi.org.in/lrs", "snippet": ""},
                    {"title": "Ad", "url": "https://example.com/ad", "snippet": ""}]
        return [{"title": "SDLT", "url": "https://gov.uk/sdlt/", "snippet": ""},
                {"title": "LRS again", "url": "https://www.rbi.org.in/lrs#top", "snippet": ""}]

    def fetch(self, url):
        self.world["fetched"].append(url)
        key = url.rstrip("/").split("#")[0]
        if key not in PAGES:
            raise ValueError("connection refused")
        return key, PAGES[key][1]

    def on_research(self, message_id, state):
        self.said.append((message_id, state))

    def planned(self):
        chat = self.engine.open()
        reply = self.engine.research_plan(chat["id"], "Can I buy a London flat with my savings in India?",
                                          on_research=self.on_research)
        return chat, reply

    def test_a_plan_first_to_edit_or_start(self):
        chat, reply = self.planned()
        state = reply["research"]
        self.assertEqual(state["status"], "planned")
        self.assertEqual(state["plan"], {"title": "London flat from India", "sites": [],
                                         "steps": ["What FEMA and the LRS allow", "2026 UK purchase taxes",
                                                   "What it costs in all"]},
                         "list markers go, a step's own figures stay")
        self.assertEqual(reply["text"].splitlines()[0], "**Research plan: London flat from India**",
                         "the conversation keeps the plan as words")
        mine = self.store.get(chat["id"])["messages"][0]
        self.assertTrue(mine["research"])
        self.assertEqual([s["status"] for _, s in self.said], ["planning", "planned"])
        self.assertEqual(self.world["calls"][0]["tools"], ["research_plan"])

    def test_research_reads_notes_writes_and_checks_every_citation(self):
        chat, reply = self.planned()
        written = []
        done = self.engine.research_run(chat["id"], reply["id"], {**reply["research"]["plan"], "steps": [
            "What FEMA and the LRS allow", "UK taxes for a non-resident buyer"]}, on_text=written.append,
            on_research=self.on_research)
        state = done["research"]
        self.assertEqual(state["status"], "done")
        self.assertEqual(state["plan"]["steps"][1], "UK taxes for a non-resident buyer", "the plan as edited")
        self.assertEqual(self.world["searched"], ["LRS property abroad", "SDLT non resident surcharge"])
        self.assertEqual(sorted(self.world["fetched"]), ["https://example.com/ad", "https://gov.uk/sdlt/", "https://rbi.org.in/lrs"],
                         "each page once, however it's linked")
        self.assertEqual([(n["n"], n["title"]) for n in state["notes"]], [(1, "LRS"), (2, "SDLT")],
                         "an ad isn't a note")
        self.assertEqual("".join(written), "".join(REPORT), "the report streams like any reply")
        text = done["text"]
        self.assertNotIn("[7]", text, "a number that isn't a note is dropped")
        self.assertIn("The flat needs no UK visa.", text, "a claim its source doesn't support loses the citation")
        self.assertIn("A 2% surcharge applies to non-residents [2]. Banks also charge fees.", text)
        self.assertIn("| SDLT surcharge | 2% [2] |", text, "a table row is checked whole")
        check = state["check"]
        self.assertEqual((check["claims"], check["checked"], check["supported"], check["invalid"]), (5, 5, 4, 1))
        self.assertEqual([c["cites"] for c in check["unsupported"]], [[2]])
        self.assertEqual(done["sources"], [{"n": 1, "title": "LRS", "url": "https://rbi.org.in/lrs",
                                            "snippet": "LRS allows a resident to remit up to USD 250,000 a financial year."},
                                           {"n": 2, "title": "SDLT", "url": "https://gov.uk/sdlt",
                                            "snippet": "Non-UK residents pay a 2% SDLT surcharge on residential property in England."}],
                         "a note keeps the address the page was read at")
        kinds = [a["kind"] for a in state["activity"]]
        for kind in ("round", "search", "read", "note", "skip", "write", "check", "checked"):
            self.assertIn(kind, kinds)
        self.assertLess(kinds.index("write"), kinds.index("check"))
        statuses = [s["status"] for _, s in self.said]
        self.assertEqual(statuses[-1], "done")
        self.assertIn("running", statuses)
        self.assertNotIn("note", self.said[-1][1]["notes"][0], "progress names a note; the saved reply keeps its words")
        saved = self.store.get(chat["id"])["messages"][-1]
        self.assertEqual((saved["text"], saved["research"]["status"]), (text, "done"))
        writer = next(c for c in self.world["calls"] if c["kind"] == "write")
        self.assertIn("[1] LRS (https://rbi.org.in/lrs)\n- LRS allows", writer["user"], "the writer reads notes, not pages")
        self.assertNotIn("Cheap flights", writer["user"])
        with self.assertRaisesRegex(ChatEngineError, "finished"):
            self.engine.research_run(chat["id"], reply["id"])

    def test_what_the_user_adds_while_it_runs_reaches_the_next_searches_and_the_report(self):
        chat, reply = self.planned()
        original = self.search

        def search(query):
            if not self.world.get("steered"):
                self.world["steered"] = True
                self.engine.research_steer(chat["id"], reply["id"], "I'm an NRI, not a resident")
            return original(query)
        self.engine._searcher = search
        self.engine.research_run(chat["id"], reply["id"])
        second = [c for c in self.world["calls"] if c["kind"] == "search"][1]
        self.assertIn("The user added, while it ran:\n- I'm an NRI, not a resident", second["user"])
        self.assertIn("The user added:\n- I'm an NRI", next(c for c in self.world["calls"] if c["kind"] == "write")["user"])
        with self.assertRaisesRegex(ChatEngineError, "isn't running"):
            self.engine.research_steer(chat["id"], reply["id"], "more")

    def test_sites_keep_it_to_those_sites(self):
        chat, reply = self.planned()
        self.engine.research_run(chat["id"], reply["id"], {**reply["research"]["plan"], "sites": ["https://www.RBI.org.in/"]})
        self.assertTrue(all(q.endswith(" site:rbi.org.in") for q in self.world["searched"]))
        self.assertEqual(self.world["fetched"], ["https://rbi.org.in/lrs"])
        for bad in (["not a site"], ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com"]):
            with self.subTest(bad=bad), self.assertRaises(ChatEngineError):
                self.engine.research_plan(chat["id"], "again")      # a new plan to edit
                last = self.store.get(chat["id"])["messages"][-1]
                self.engine.research_run(chat["id"], last["id"], {**last["research"]["plan"], "sites": bad})

    def test_stop_keeps_what_was_found_and_writes_from_it(self):
        chat, reply = self.planned()
        cancel = threading.Event()
        original = self.fetch

        def fetch(url):
            found = original(url)
            cancel.set()                                    # Stop, while the first page is read
            return found
        self.engine._fetcher = fetch
        stopped = self.engine.research_run(chat["id"], reply["id"], cancel=cancel)
        self.assertEqual((stopped["research"]["status"], stopped["finish"]), ("stopped", "cancelled"))
        self.assertRegex(stopped["text"], r"^Research stopped: \d pages? read")
        self.assertFalse(any(c["kind"] == "write" for c in self.world["calls"]))
        notes = self.store.get(chat["id"])["messages"][-1]["research"].get("notes") or []
        self.engine._fetcher = original
        if not notes:                                       # the page noted before the stop was seen, or not
            with self.assertRaisesRegex(ChatEngineError, "nothing found"):
                self.engine.research_run(chat["id"], reply["id"], write=True)
            return
        done = self.engine.research_run(chat["id"], reply["id"], write=True)
        self.assertEqual(done["research"]["status"], "done")
        self.assertEqual(len([c for c in self.world["calls"] if c["kind"] == "search"]), 1, "write: no more reading")

    def test_a_page_that_cant_be_read_and_a_search_that_fails_are_said_not_fatal(self):
        chat, reply = self.planned()
        self.engine._fetcher = lambda url: (_ for _ in ()).throw(ValueError("connection refused")) \
            if "gov.uk" in url else self.fetch(url)
        original = self.search
        self.engine._searcher = lambda q: (_ for _ in ()).throw(RuntimeError("rate limited")) if "SDLT" in q else original(q)
        done = self.engine.research_run(chat["id"], reply["id"])
        texts = [a["text"] for a in done["research"]["activity"]]
        self.assertIn("Search failed: rate limited", texts)
        self.assertEqual(done["research"]["status"], "done")

    def test_nothing_useful_found_fails_saying_so(self):
        chat, reply = self.planned()
        self.engine._searcher = lambda q: [{"title": "Ad", "url": "https://example.com/ad", "snippet": ""}]
        failed = self.engine.research_run(chat["id"], reply["id"])
        self.assertEqual((failed["research"]["status"], failed["finish"]), ("failed", "error"))
        self.assertIn("No page gave anything to write from", failed["text"])

    def test_it_needs_a_16k_window(self):
        self.config["chatdgc_window"] = "8k"
        chat = self.engine.open()
        with self.assertRaisesRegex(ChatEngineError, "at least 16k"):
            self.engine.research_plan(chat["id"], "Research this")

    def test_a_model_that_cant_take_tools_answers_in_json(self):
        self.world["toolless"] = True
        chat, reply = self.planned()
        self.assertEqual(reply["research"]["plan"]["title"], "London flat from India")
        self.assertEqual([c["tools"] for c in self.world["calls"]], [["research_plan"], []])
        self.engine._toolless.add("chat-model")
        self.world["calls"].clear()
        self.engine.research_run(chat["id"], reply["id"])
        self.assertTrue(all(c["tools"] == [] for c in self.world["calls"]), "known: not offered again")

    def test_the_report_exports_with_its_sources_and_check(self):
        chat, reply = self.planned()
        with self.assertRaisesRegex(ChatEngineError, "finished research report"):
            self.engine.export(chat["id"], "report", reply["id"])
        self.engine.research_run(chat["id"], reply["id"])
        exported = self.engine.export(chat["id"], "report", reply["id"])
        self.assertTrue(exported.startswith("# Buying a London flat from India"))
        self.assertIn("## Sources\n\n1. [LRS](https://rbi.org.in/lrs)\n2. [SDLT](https://gov.uk/sdlt)", exported)
        self.assertIn("Citations checked: 4 of 5 cited claims hold up against their sources.", exported)

    def test_a_plan_the_conversation_moved_on_from_isnt_run(self):
        chat, reply = self.planned()
        self.world["answers"]["plan"] = {"title": "Second", "steps": ["Another"]}
        self.engine.research_plan(chat["id"], "Something else")
        with self.assertRaisesRegex(ChatEngineError, "moved on"):
            self.engine.research_run(chat["id"], reply["id"])


def pdf_bytes() -> bytes:
    """A one-page PDF saying "Hello PDF" (as tests/test_document_attachments.py builds one)."""
    stream = b"BT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET"
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
               b"/Resources << /Font << /F1 5 0 R >> >> >>",
               b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{index} 0 obj\n".encode() + body + b"\nendobj\n"
    start = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode() + b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode()
    return bytes(out)


class ReadingTests(unittest.TestCase):
    """How pages are read: a PDF as text (regulators publish that way), the coding chat's public-only fetch."""

    def fetched(self, ctype, data):
        from unittest.mock import patch
        with patch("dgc.tools._fetch_public", return_value=("https://www.rbi.org.in/a2.pdf", ctype, data, "utf-8")) as fetch:
            found = research.fetch_page("https://www.rbi.org.in/a2.pdf")
        self.assertEqual(fetch.call_args.kwargs["binary_types"], frozenset({"application/pdf"}), "a PDF is let through")
        return found

    def test_a_pdf_is_read_as_text(self):
        self.assertIn("Hello PDF", self.fetched("application/pdf", pdf_bytes())[1])
        self.assertIn("Hello PDF", self.fetched("application/octet-stream", pdf_bytes())[1],
                      "named by its bytes when the server doesn't say")
        self.assertEqual(self.fetched("text/html", b"<p>A <b>page</b></p>")[1].strip(), "A page")
        with self.assertRaisesRegex(ValueError, "the PDF couldn't be read"):
            self.fetched("application/pdf", b"%PDF-1.4 not really")

    def test_pages_are_read_at_once_and_numbered_once(self):
        """Three readers: every page read once, every note its own number."""
        urls = [f"https://site{i}.example/page" for i in range(9)]
        state = {"question": "q", "plan": {"title": "t", "steps": ["s"], "sites": []}}
        gate = threading.Barrier(3, timeout=5)

        def fetch(url):
            try:
                gate.wait()                          # three at once, or this times out
            except threading.BrokenBarrierError:
                pass
            return url, "Something worth noting. " * 20

        class Client:
            def chat(self, messages, tools=None, **_):
                call = ToolCall("c1", "page_note", {"relevant": True, "note": "- a fact worth keeping"})
                return SimpleNamespace(content="", tool_calls=[call])
        run = research.Research(None, state, client_for=Client, room=32768, search=None, fetch=fetch)
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(run._read, [{"url": u, "title": u} for u in urls]))
        self.assertFalse(gate.broken, "read side by side")
        self.assertEqual(sorted(n["n"] for n in state["notes"]), list(range(1, 10)))
        self.assertEqual(sorted(state["read"]), sorted(urls))

    def test_a_slow_model_is_said(self):
        state = {"question": "q", "plan": {"title": "t", "steps": ["s"], "sites": []}}
        made = SimpleNamespace(stall_listener=None)
        run = research.Research(None, state, client_for=lambda: made, room=32768, search=None)
        self.assertIs(run.client(), made)
        made.stall_listener(SimpleNamespace(kind="notice"))
        made.stall_listener(SimpleNamespace(kind="retry"))
        made.stall_listener(SimpleNamespace(kind="cleared"))
        self.assertEqual([(a["kind"], a["text"]) for a in state["activity"]],
                         [("wait", "The model is slow to answer; still waiting"),
                          ("wait", "The model didn't answer; asking again")])


class StructuredTests(unittest.TestCase):
    def test_json_is_read_from_the_text_around_it(self):
        self.assertEqual(research._json_in('Sure: {"a": {"b": "}"}} and {"c": 1}'), {"a": {"b": "}"}})
        self.assertIsNone(research._json_in("no json [1, 2]"))

    def test_an_edited_plan(self):
        self.assertEqual(research.clean_plan({"steps": ["1) First", "* Second", "First"], "sites": ["www.gov.uk"]}),
                         {"title": "First", "steps": ["First", "Second"], "sites": ["gov.uk"]})
        for bad in ({"steps": []}, {"steps": ["x"], "sites": ["no spaces allowed"]}, []):
            with self.subTest(bad=bad), self.assertRaises(research.ResearchError):
                research.clean_plan(bad)


if __name__ == "__main__":
    unittest.main()
