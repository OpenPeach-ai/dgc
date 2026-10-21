"""Memory that learns: the one memory DGC keeps (dgc/shared_memory.py), improved, never a second one.

* A look back after a conversation (dgc/memory_review.py) keeps at most a few preferences, facts, decisions and
  outcomes, each from the user's own words (never a reply, a page or a file), never a secret, never twice, with a kind
  and maybe an expiry. Memory off means no look back at all; a turn DGC wrote is never looked back over.
* Every add, edit, forget and learned skill is journaled with who made it and when, with Undo; the journal is bounded.
* /learn (dgc/skill_learn.py) drafts a skill, writes nothing until Save, never over another, never with a secret.
"""
import json
import os
import tempfile
import threading
import time
import unittest
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from dgc import memory_review, shared_memory, skill_learn
from dgc.chatdgc.engine import FOLLOW_UP, LOOK_UP, ChatEngine
from dgc.chatdgc.store import ChatStore
from dgc.editor_protocol import event_error
from dgc.llm import ToolCall
from dgc.shared_memory import NotRemembered, SharedMemory


def answer(name, args):
    return SimpleNamespace(content="", tool_calls=[ToolCall("x", name, args)], finish_reason="stop", thinking="",
                           usage={})


class Model:
    """A model that answers each kind of call DGC makes: the check before a reply, the look back, /learn, a reply."""

    def __init__(self, world):
        self.world, self.model, self.context_size = world, "chat-model", 0

    def prepare_model(self, **_):
        pass

    def model_context_limit(self):
        return 32768

    def chat(self, messages, tools=None, reasoning_effort=None, on_text=None, on_thinking=None, cancel=None):
        system = str(messages[0]["content"])
        if system.startswith(LOOK_UP[:60]):
            return answer("search_first", {"needs_search": False, "query": ""})
        if system.startswith(FOLLOW_UP[:60]):
            return answer("suggest", {"followups": []})
        if system.startswith(memory_review.PROMPT[:60]):
            self.world["reviews"].append(messages[-1]["content"])
            return answer("remember", {"items": self.world["review"]})
        if system.startswith(skill_learn.PROMPT[:60]):
            self.world["learns"].append(messages[-1]["content"])
            return answer("skill", self.world["skill"])
        step = self.world["script"].pop(0) if self.world["script"] else {"parts": ["Sure."]}
        for part in step.get("parts", []):
            if on_text is not None:
                on_text(part)
        return SimpleNamespace(content="".join(step.get("parts", [])), tool_calls=[], finish_reason="stop",
                               thinking="", usage={})


class Config(dict):
    base_url, api_key, model = "http://127.0.0.1:11434/v1", "", "chat-model"

    def get(self, key, default=None):
        return super().get(key, default)


def new_world(review=None):
    return {"reviews": [], "learns": [], "script": [], "review": review or [], "skill": {}}


class JournalTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-learns-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.memory = SharedMemory(self.root / "memory")

    def test_every_change_is_journaled_with_who_and_undo_takes_it_back(self):
        typed = self.memory.add("Lives in Pune")
        told = self.memory.remember("Prefers UPI for bills", said="I always pay my bills with UPI", surface="work",
                                    where="billing", by="review", kind="preference")
        self.memory.edit(typed["id"], "Lives in Pune with two kids")
        self.memory.forget(told["id"], by="tool", surface="chat")
        rows = self.memory.history()
        self.assertEqual([(r["op"], r["by"]) for r in rows],
                         [("forget", "tool"), ("edit", "you"), ("add", "review"), ("add", "you")], "newest first, and who")
        self.assertEqual((rows[2]["surface"], rows[2]["where"], rows[2]["kind"]), ("work", "billing", "preference"))
        self.assertEqual(rows[1]["before"], "Lives in Pune")
        self.assertNotIn("said", json.dumps(rows), "the history never shows the words that backed a fact")
        # Undo the forget: the same fact, the same id, back.
        self.memory.undo(rows[0]["id"])
        self.assertEqual([f["id"] for f in self.memory.facts()], [typed["id"], told["id"]])
        # Undo the edit: the text it had.
        self.memory.undo(rows[1]["id"])
        self.assertEqual(self.memory.facts()[0]["text"], "Lives in Pune")
        # Undo the review's add: gone.
        self.memory.undo(rows[2]["id"])
        self.assertEqual([f["text"] for f in self.memory.facts()], ["Lives in Pune"])
        with self.assertRaisesRegex(NotRemembered, "already undone"):
            self.memory.undo(rows[2]["id"])
        after = {r["id"]: r for r in self.memory.history()}
        self.assertTrue(after[rows[2]["id"]]["undone"])
        self.assertFalse(after[rows[2]["id"]]["undoable"])
        self.assertEqual([r["op"] for r in self.memory.history()][:3], ["undo", "undo", "undo"], "an undo is journaled")
        self.assertEqual(oct((self.root / "memory" / "journal.ndjson").stat().st_mode & 0o777), "0o600")

    def test_delete_all_comes_back_with_one_undo(self):
        for text in ("Lives in Pune", "Is vegetarian", "Works at Fungi"):
            self.memory.add(text)
        self.memory.clear()
        row = self.memory.history()[0]
        self.assertEqual((row["op"], row["text"]), ("clear", "3 memories"))
        self.memory.undo(row["id"])
        self.assertEqual(sorted(f["text"] for f in self.memory.facts()), ["Is vegetarian", "Lives in Pune", "Works at Fungi"])

    def test_the_journal_is_bounded(self):
        for i in range(shared_memory.MAX_JOURNAL + shared_memory.JOURNAL_SLACK + 5):
            fact = self.memory.add(f"Fact number {i} about them")
            self.memory.forget(fact["id"])
        lines = (self.root / "memory" / "journal.ndjson").read_text().splitlines()
        self.assertLessEqual(len(lines), shared_memory.MAX_JOURNAL + shared_memory.JOURNAL_SLACK)
        self.assertEqual(len(self.memory.history(500)), min(len(lines), shared_memory.MAX_JOURNAL))

    def test_a_fact_with_a_day_stops_being_read_after_it(self):
        soon = (date.today() + timedelta(days=3)).isoformat()
        trip = self.memory.remember("Is in Goa until Friday", said="I'm in Goa until Friday", surface="chat",
                                    until=soon, kind="fact")
        self.assertEqual(trip["until"], soon)
        later = (date.today() + timedelta(days=4)).isoformat()
        self.assertEqual(shared_memory.live(self.memory.facts(), on=later), [], "after its day no prompt reads it")
        self.assertEqual(len(self.memory.live_facts()), 1)
        self.assertIsNone(shared_memory.until_date("2001-01-01"), "a day already past is no expiry")
        self.assertIsNone(shared_memory.until_date("next week"))
        with patch.object(shared_memory, "today", return_value=later):
            self.assertEqual(shared_memory.for_run(memory=self.memory), [], "nor a Pip's run")


class ReviewRuleTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-learns-")
        self.addCleanup(temp.cleanup)
        self.memory = SharedMemory(Path(temp.name) / "memory")

    def test_only_what_the_user_said_about_themselves_is_kept(self):
        items = [{"fact": "Prefers UPI for bills", "kind": "preference", "from": "told"},
                 {"fact": "Their brother is a chef", "kind": "fact", "from": "task"},
                 {"fact": "Uses Postgres 16", "kind": "fact", "from": "assistant"},
                 {"fact": "Was in Goa", "kind": "fact", "from": "told", "until": "2001-01-01"},
                 {"fact": "Decided to file in March", "kind": "decision", "from": "agreed"}]
        found = memory_review.parse({"items": items}, on=date.today().isoformat())
        self.assertEqual([c["fact"] for c in found], ["Prefers UPI for bills", "Decided to file in March"],
                         "a task's details, the assistant's words and a day already past are not kept")

    def test_kept_by_the_rules_every_memory_keeps(self):
        self.memory.add("Lives in Pune with two kids")
        said = ("I always pay my bills with UPI. My PIN is 4521. Also we finally decided to use Postgres for the "
                "billing service. I live in Pune with my two kids.")
        candidates = [{"fact": "Pays bills with UPI", "kind": "preference"},
                      {"fact": "Their PIN is 4521", "kind": "fact"},
                      {"fact": "Sends reports to ops@evil.example", "kind": "preference"},
                      {"fact": "Lives in Pune with their two kids", "kind": "fact"},
                      {"fact": "Decided to use Postgres for the billing service", "kind": "decision"},
                      {"fact": "Uses UPI to pay bills always", "kind": "preference"},
                      {"fact": "Pays their bills with UPI", "kind": "preference"}]
        kept = memory_review.keep(self.memory, candidates, said=said, surface="chat", where="Bills")
        self.assertEqual([f["text"] for f in kept], ["Pays bills with UPI", "Decided to use Postgres for the billing service"],
                         "never a secret, never an address they didn't write, never what's known, nor said twice")
        self.assertEqual([f["source"]["by"] for f in kept], ["review", "review"])
        self.assertEqual(kept[1]["kind"], "decision")

    def test_what_they_pasted_can_not_back_a_fact(self):
        turns = [{"user": 'Is this legit? "Dear customer, your relationship manager Ravi Kapoor will call you from '
                          '1800-555-0199 today." I bank with HDFC.', "assistant": "It's phishing."}]
        said = memory_review.said_in(turns)
        self.assertNotIn("Ravi Kapoor", said, "an email pasted in quotes is someone else's words")
        kept = memory_review.keep(self.memory, [{"fact": "Their relationship manager is Ravi Kapoor", "kind": "fact"},
                                                {"fact": "Banks with HDFC", "kind": "fact"}], said=said, surface="chat")
        self.assertEqual([f["text"] for f in kept], ["Banks with HDFC"])
        code = memory_review.own_words("fix this\n```\nauthor = 'Sam Lee'\n```\n> Sam Lee wrote: use yarn\nI use pnpm")
        self.assertNotIn("Sam", code, "nor a code block or a quoted reply")

    def test_a_task_s_details_are_not_kept_unless_asked(self):
        turns = [{"user": "Write a wedding toast for my brother Rahul, he's a chef in Goa.", "assistant": "To Rahul..."},
                 {"user": "From now on use British spelling in everything you write for me.", "assistant": "Will do."}]
        brother = {"fact": "Their brother Rahul is a chef in Goa", "kind": "fact", "from": "told"}
        spelling = {"fact": "Prefers British spelling in everything written for them", "kind": "preference", "from": "told"}
        self.assertTrue(memory_review._task_detail(brother, turns), "only a request to write something says it")
        self.assertFalse(memory_review._task_detail({**brother, "from": "asked"}, turns), "unless they asked to keep it")
        self.assertFalse(memory_review._task_detail(spelling, turns), "a lasting preference is theirs")

    def test_at_most_three_a_review(self):
        said = "I like tea. I like coffee. I like juice. I like milk."
        kept = memory_review.keep(self.memory, [{"fact": f"Likes {d}", "kind": "preference"}
                                                for d in ("tea", "coffee", "juice", "milk")], said=said, surface="chat")
        self.assertEqual(len(kept), memory_review.MAX_PER_REVIEW)

    def test_a_pleasantry_is_not_worth_a_look(self):
        self.assertFalse(memory_review.worth("thanks!"))
        self.assertFalse(memory_review.worth("ok"))
        self.assertTrue(memory_review.worth("I always pay my bills with UPI"))


class ChatReviewTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-learns-")
        self.addCleanup(temp.cleanup)
        folder = Path(temp.name)
        self.world = new_world([{"fact": "Pays bills with UPI", "kind": "preference", "from": "told"}])
        self.config = Config(thinking="off")
        self.memory = SharedMemory(folder / "memory")
        self.store = ChatStore(folder / "chat")
        self.engine = ChatEngine(self.config, self.store, searcher=lambda q: [], memory=self.memory,
                                 projects=lambda hidden: [], client_factory=lambda model: Model(self.world))

    def test_a_quiet_chat_is_looked_back_over_once_and_the_reply_shows_what_it_kept(self):
        chat = self.engine.open()
        self.engine.send(chat["id"], "Remind me what's due this week. I always pay my bills with UPI, by the way.")
        found = self.engine.review_memory(chat["id"])
        fact = self.memory.facts()[0]
        self.assertEqual((fact["text"], fact["kind"], fact["source"]["by"]), ("Pays bills with UPI", "preference", "review"))
        self.assertEqual(found["message"]["memory"],
                         [{"op": "saved", "id": fact["id"], "text": "Pays bills with UPI", "by": "review"}],
                         "the chat's latest reply says Remembered, with Forget")
        self.assertEqual(self.store.get(chat["id"])["messages"][-1]["memory"][0]["by"], "review", "kept with the chat")
        self.assertIn("User: Remind me what's due this week.", self.world["reviews"][0])
        self.assertIsNone(self.engine.review_memory(chat["id"]), "what was looked back over isn't looked at again")
        self.assertEqual(len(self.world["reviews"]), 1)
        self.assertEqual(self.engine.unreviewed_chars(chat["id"]), 0)

    def test_memory_off_or_a_temporary_chat_means_no_look_back_at_all(self):
        temporary = self.engine.open(temporary=True)
        self.engine.send(temporary["id"], "I always pay my bills with UPI, every single month.")
        self.assertIsNone(self.engine.review_memory(temporary["id"]))
        self.config["memory"] = False
        chat = self.engine.open()
        self.engine.send(chat["id"], "I always pay my bills with UPI, every single month.")
        self.assertIsNone(self.engine.review_memory(chat["id"]))
        self.assertEqual(self.world["reviews"], [], "not even asked")
        self.engine.skip_review(chat["id"])
        self.config["memory"] = True
        self.assertEqual(self.engine.unreviewed_chars(chat["id"]), 0, "what was said while it was off is never looked at")
        self.assertEqual(self.memory.facts(), [])

    def test_a_card_answer_the_model_wrote_is_not_the_users_words(self):
        chat = self.engine.open()
        self.engine.send(chat["id"], "hello there, how are you doing today?")
        stored = self.store.get(chat["id"])
        stored["messages"].append({"id": "msg_" + "a" * 32, "role": "user", "created_at": "2999-01-01T00:00:00Z",
                                   "text": "I always pay my bills with UPI", "answers": {"message": "x", "question": 0,
                                                                                         "choice": "UPI"}})
        self.store.save(stored)
        turns, _ = self.engine._unreviewed(self.store.get(chat["id"]))
        self.assertEqual([t["user"] for t in turns], ["hello there, how are you doing today?"])

    def test_the_service_looks_back_when_a_turn_ends_with_enough_words_or_once_it_is_quiet(self):
        from dgc.chatdgc.service import ChatService
        frames = []
        lock = threading.Lock()

        def emit(type, **fields):
            frame = {"type": type, "seq": len(frames), **fields}
            problem = event_error(frame)
            if problem:
                raise AssertionError(f"invalid event: {problem}")
            with lock:
                frames.append(frame)
        self.config["memory_review_idle_s"] = 0.2
        service = ChatService(emit, self.config, engine=self.engine)
        self.addCleanup(service.close, 2.0)
        service.dispatch({"type": "chatdgc_open", "request_id": "o"})
        chat_id = next(f for f in reversed(frames) if f["type"] == "chatdgc_opened")["conversation"]["id"]

        def wait_for(test, seconds=5.0):
            for _ in range(int(seconds / 0.01)):
                with lock:
                    if test():
                        return True
                time.sleep(0.01)
            return False
        # A short message: looked back over once the chat has been quiet a while.
        service.dispatch({"type": "chatdgc_send", "request_id": "s1", "conversation_id": chat_id,
                          "text": "I always pay my bills with UPI"})
        self.assertTrue(wait_for(lambda: any(f["type"] == "chatdgc_message" and f["message"].get("memory")
                                             for f in frames)), "the reply shows what the look back kept")
        shown = next(f for f in frames if f["type"] == "chatdgc_message" and f["message"].get("memory"))
        self.assertEqual(shown["message"]["memory"][0]["text"], "Pays bills with UPI")
        self.assertTrue(any(f["type"] == "memory_state" for f in frames), "and Settings -> Memory, if open")
        # History, then Undo, through the wire.
        service.dispatch({"type": "memory_history", "request_id": "h"})
        history = next(f for f in reversed(frames) if f["type"] == "memory_history")
        self.assertEqual((history["entries"][0]["op"], history["entries"][0]["by"]), ("add", "review"))
        service.dispatch({"type": "memory_undo", "request_id": "u", "id": history["entries"][0]["id"]})
        undone = next(f for f in reversed(frames) if f["type"] == "memory_history" and f.get("request_id") == "u")
        self.assertNotIn("error", undone)
        self.assertEqual(self.memory.facts(), [])
        self.assertTrue(undone["entries"][1]["undone"])
        service.dispatch({"type": "memory_undo", "request_id": "u2", "id": history["entries"][0]["id"]})
        again = next(f for f in reversed(frames) if f["type"] == "memory_history" and f.get("request_id") == "u2")
        self.assertIn("already undone", again["error"])
        # memory_watch is answered by memory_state, and marks this screen as one that shows Work's line.
        service.dispatch({"type": "memory_watch", "request_id": "w"})
        self.assertTrue(service.watching)
        self.assertTrue(any(f["type"] == "memory_state" and f.get("request_id") == "w" for f in frames))

    def test_memory_off_the_service_never_asks_the_model_to_look_back(self):
        from dgc.chatdgc.service import ChatService
        frames = []
        self.config["memory_review_idle_s"] = 0.05
        self.config["memory"] = False
        service = ChatService(lambda type, **f: frames.append({"type": type, **f}), self.config, engine=self.engine)
        self.addCleanup(service.close, 2.0)
        service.dispatch({"type": "chatdgc_open", "request_id": "o"})
        chat_id = next(f for f in reversed(frames) if f["type"] == "chatdgc_opened")["conversation"]["id"]
        service.dispatch({"type": "chatdgc_send", "request_id": "s1", "conversation_id": chat_id,
                          "text": "I always pay my bills with UPI, and I live in Pune with my two kids. " * 6})
        for _ in range(100):
            if any(f["type"] == "chatdgc_turn" and f.get("state") == "ended" for f in frames):
                break
            time.sleep(0.01)
        time.sleep(0.3)
        service._reviews.wait(2)
        self.assertEqual(self.world["reviews"], [])


class LearnTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-learn-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.memory = SharedMemory(self.root / "memory")
        self.world = new_world()
        self.world["skill"] = {"name": "Release The Extension", "description": "Release the VS Code extension.",
                               "body": "# Release the extension\n\n## Steps\n1. Run `npm run package` with token "
                                       "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD.\n2. Publish."}

    def test_a_draft_is_redacted_named_freely_and_nothing_is_written(self):
        folder = self.root / "skills"
        (folder / "release-the-extension").mkdir(parents=True)
        source = skill_learn.session_source([
            {"role": "system", "content": "you are dgc"},
            {"role": "user", "content": "release the extension please"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "1", "type": "function", "function": {
                "name": "bash", "arguments": json.dumps({"command": "npm run package"})}}]},
            {"role": "tool", "tool_call_id": "1", "content": "packaged dgc-0.33.0.vsix"},
            {"role": "assistant", "content": "Packaged and published."}])
        self.assertIn("Tool call bash:", source)
        self.assertNotIn("you are dgc", source, "never the system prompt")
        drafted = skill_learn.draft(Model(self.world), source, "how to release", folder=folder)
        self.assertEqual(drafted["name"], "release-the-extension-2", "never another skill's name")
        self.assertNotIn("sk-ant-api03", drafted["markdown"], "a key the model echoed is redacted")
        self.assertIn("The skill is for: how to release", self.world["learns"][0])
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ["release-the-extension"], "nothing written")

    def test_save_writes_once_journals_and_undo_deletes_it(self):
        folder = self.root / "home" / ".dgc" / "skills"
        markdown = skill_learn.compose("bill-reminders", "Remind about bills due this week.", "# Bills\n\n## Steps\n1. List them.")
        with patch("dgc.config.USER_SKILLS", folder):
            saved = skill_learn.save(markdown, scope="user", project_root=self.root, memory=self.memory)
            path = Path(saved["path"])
            self.assertEqual(path, folder / "bill-reminders" / "SKILL.md")
            self.assertEqual(oct(path.stat().st_mode & 0o777), "0o600")
            with self.assertRaisesRegex(skill_learn.SkillError, "already exists"):
                skill_learn.save(markdown, scope="user", project_root=self.root, memory=self.memory)
            with self.assertRaisesRegex(skill_learn.SkillError, "password, a key or an account number"):
                skill_learn.save(markdown.replace("List them.", "Use card 4111 1111 1111 1111."), scope="user",
                                 project_root=self.root, memory=self.memory)
            row = self.memory.history()[0]
            self.assertEqual((row["op"], row["text"], row["scope"], row["undoable"]), ("learn", "bill-reminders", "user", True))
            self.memory.undo(row["id"])
            self.assertFalse(path.exists(), "Undo deletes the skill it saved")
            # A skill changed after it was saved is the user's: Undo leaves it.
            saved = skill_learn.save(markdown, scope="user", project_root=self.root, memory=self.memory)
            Path(saved["path"]).write_text(markdown + "\nMy own step.\n")
            with self.assertRaisesRegex(NotRemembered, "changed after it was saved"):
                self.memory.undo(self.memory.history()[0]["id"])
            self.assertTrue(Path(saved["path"]).exists())

    def test_a_project_skill_goes_in_the_projects_folder(self):
        markdown = skill_learn.compose("run-tests", "Run the project's tests.", "# Tests\n\n1. `make test`")
        saved = skill_learn.save(markdown, scope="project", project_root=self.root / "proj", memory=self.memory)
        self.assertEqual(Path(saved["path"]), self.root / "proj" / ".dgc" / "skills" / "run-tests" / "SKILL.md")
        from dgc.skills import discover_skills
        self.assertIn("run-tests", discover_skills(self.root / "proj"), "read as a project skill")

    def test_a_skill_with_no_description_or_no_name_is_refused(self):
        with self.assertRaisesRegex(skill_learn.SkillError, "description"):
            skill_learn.save("---\nname: x-skill\n---\n\nDo it.\n", scope="user", project_root=self.root,
                             memory=self.memory)
        with self.assertRaisesRegex(skill_learn.SkillError, "name"):
            skill_learn.save("Just steps\n", scope="user", project_root=self.root, memory=self.memory)


if __name__ == "__main__":
    unittest.main()


class WorkReviewTests(unittest.TestCase):
    """A Work session's prompts are looked back over (never a wake-up or a monitor's turn), and only for a screen
    that shows the line (memory_watch): an SDK session, or no panel, learns nothing."""

    def setUp(self):
        import copy
        from dgc.agent import Agent
        from dgc.config import DEFAULTS, Config as DGCConfig
        from dgc.headless import Backend, HeadlessUI
        from dgc.protocol import PendingRequests
        directory = tempfile.TemporaryDirectory(prefix="dgc-work-learns-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        (self.root / "proj").mkdir()
        config = object.__new__(DGCConfig)
        config.project_root, config.project_dir, config._persist = self.root / "proj", self.root / "proj" / ".dgc", False
        config.data = copy.deepcopy(DEFAULTS)
        config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="default", hooks={},
                           mcp_servers={}, suggest=False, artifact_autostart=False, notes=False,
                           memory_review_idle_s=0.1)
        config._stored_secrets, config._env_secret_keys, config._explicit_keys = {}, set(), set()
        config.credential_warnings = ()
        config.permissions = {"allow": [], "ask": [], "deny": []}
        self.config = config
        self.events, self.condition = [], threading.Condition()

        def emit(_event_type, /, **fields):
            event = {"type": _event_type, **fields}
            self.assertIsNone(event_error({"seq": 1, **event}), event)
            with self.condition:
                self.events.append(event)
                self.condition.notify_all()
        emitter = SimpleNamespace(emit=emit)
        memory_root = self.root / "memory"
        patcher = patch("dgc.shared_memory.default_root", return_value=memory_root)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.memory = SharedMemory(memory_root)
        backend = object.__new__(Backend)
        backend.config, backend.em, backend.pending = config, emitter, PendingRequests()
        backend.ui = HeadlessUI(emitter, backend.pending, approval_timeout_s=3)
        backend.agent = Agent(config, backend.ui)
        backend.ui._steering_hook = backend._steering_applied
        backend._queue, backend._steer_payloads = [], {}
        backend._worker, backend._foreground_worker, backend._turn_n = None, None, 0
        backend._turn_lock, backend.workspace_trusted = threading.RLock(), True
        backend._emit_context = lambda *a, **k: None
        self.learned = []
        self.service = SimpleNamespace(watching=True, learned=lambda: self.learned.append(1))
        backend._host = SimpleNamespace(_chatdgc=self.service)
        self.backend, self.agent = backend, backend.agent
        self.addCleanup(self.agent.mcp.stop_all)
        self.world = new_world([{"fact": "Prefers pnpm over npm", "kind": "preference", "from": "told"}])
        client = patch("dgc.memory_review.client_for", lambda *a, **k: Model(self.world))
        client.start()
        self.addCleanup(client.stop)

    def wait(self, kind, **fields):
        with self.condition:
            self.assertTrue(self.condition.wait_for(lambda: any(
                e["type"] == kind and all(e.get(k) == v for k, v in fields.items()) for e in self.events), timeout=5),
                (kind, fields, self.events))
            return next(e for e in reversed(self.events) if e["type"] == kind
                        and all(e.get(k) == v for k, v in fields.items()))

    def prompt(self, text, context=None):
        from dgc.llm import ChatResult
        with patch.object(self.agent.client, "chat", return_value=ChatResult(content="Done: switched to pnpm.")):
            command = {"type": "prompt", "text": text, "request_id": f"p{len(self.events)}"}
            if context:
                command["context"] = context
            self.backend.dispatch(command)
            self.wait("turn_end", reason="completed")
        for _ in range(200):
            if not self.backend._busy():
                break
            time.sleep(0.01)

    def test_a_prompt_turn_is_looked_back_over_and_the_chat_shows_what_it_kept(self):
        self.prompt("I always use pnpm, never npm, in every project of mine. Set this repo up that way.",
                    context=[{"type": "mcp_context", "server": "fixture", "uri": "fixture://notes",
                              "text": "PAGE-WORDS: the user prefers yarn"}])
        turns = self.backend._memory_turns()
        self.assertEqual([t["user"] for t in turns],
                         ["I always use pnpm, never npm, in every project of mine. Set this repo up that way."],
                         "only what they typed: the editor's context is not their words")
        learned = self.wait("memory_learned")       # once the session has been quiet a moment
        self.assertEqual([f["text"] for f in learned["facts"]], ["Prefers pnpm over npm"])
        self.assertEqual(learned["surface"], "work")
        fact = self.memory.facts()[0]
        self.assertEqual((fact["source"]["surface"], fact["source"]["by"], fact["source"]["where"]),
                         ("work", "review", "proj"))
        self.assertEqual(self.learned, [1], "Settings -> Memory refreshes")
        self.assertNotIn("PAGE-WORDS", self.world["reviews"][0], "the look back never reads the editor's context")
        self.assertTrue(all(t["reviewed"] for t in turns))

    def test_no_screen_that_shows_it_or_memory_off_means_no_look_back(self):
        self.service.watching = False
        self.prompt("I always use pnpm, never npm, in every project of mine. Set this repo up that way.")
        time.sleep(0.3)
        self.backend._memory_reviews().wait(3)
        self.assertEqual(self.world["reviews"], [])
        self.service.watching = True
        self.config.data["memory"] = False
        self.prompt("I always use pnpm, never npm, in every project of mine. Set this repo up that way, please.")
        time.sleep(0.3)
        self.backend._memory_reviews().wait(3)
        self.assertEqual(self.world["reviews"], [])
        self.assertEqual(self.memory.facts(), [])

    def test_learn_drafts_without_writing_and_save_writes_a_project_skill(self):
        self.world["skill"] = {"name": "pnpm-setup", "description": "Set a repo up to use pnpm.",
                               "body": "# pnpm setup\n\n## Steps\n1. `corepack enable`\n2. `pnpm import`"}
        self.agent.messages.append({"role": "user", "content": "switch this repo to pnpm"})
        self.agent.messages.append({"role": "assistant", "content": "Ran corepack enable and pnpm import."})
        self.backend.dispatch({"type": "learn_skill", "request_id": "l1", "request": "pnpm setup"})
        draft = self.wait("skill_draft", request_id="l1")
        self.assertTrue(draft["ok"], draft)
        self.assertEqual((draft["name"], draft["scope"]), ("pnpm-setup", "project"), "a trusted folder: a project skill")
        skills = self.root / "proj" / ".dgc" / "skills"
        self.assertFalse((skills / "pnpm-setup").exists(), "nothing is written before Save")
        self.backend.dispatch({"type": "save_skill", "request_id": "s1", "markdown": draft["markdown"],
                               "scope": "project"})
        saved = self.wait("skill_saved", request_id="s1")
        self.assertTrue(saved["ok"], saved)
        self.assertTrue((skills / "pnpm-setup" / "SKILL.md").is_file())
        self.assertIn("pnpm-setup", self.agent.skills, "available at once")
        self.assertEqual(self.memory.history()[0]["op"], "learn")
        self.backend.workspace_trusted = False
        self.backend.dispatch({"type": "save_skill", "request_id": "s2", "markdown": draft["markdown"].replace(
            "pnpm-setup", "pnpm-setup-2"), "scope": "project"})
        refused = self.wait("skill_saved", request_id="s2")
        self.assertFalse(refused["ok"])
        self.assertIn("isn't trusted", refused["message"])
        self.backend.dispatch({"type": "learn_skill", "request_id": "l2"})
        self.assertEqual(self.wait("skill_draft", request_id="l2")["scope"], "user", "untrusted: your own skills")
