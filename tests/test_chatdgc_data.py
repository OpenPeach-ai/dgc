"""Data analysis (ChatGPT's), without running code the model wrote: the chat's spreadsheets as in-memory SQLite tables
it asks with one read-only SELECT at a time, for exact numbers. And charts: the model's ```chart JSON is in the prompt."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from dgc.chatdgc import data, made
from dgc.chatdgc.engine import LOOK_UP, ChatEngine
from dgc.chatdgc.prompt import CHARTS, system_prompt
from dgc.chatdgc.store import ChatStore
from dgc.llm import ToolCall
from dgc.shared_memory import SharedMemory

CONFIG = SimpleNamespace(get=lambda key, default=None: default)
EXPENSES = ("Date,Category,Amount (₹),Code\n2026-01-03,Food,\"1,200\",007\n2026-01-09,Rent,25000,012\n"
            "2026-02-02,Food,850.5,007\n2026-02-11,Travel,\"₹3,400\",019\n").encode()


class Tables(unittest.TestCase):
    def setUp(self):
        workbook = made.make({"name": "Budget", "format": "xlsx", "sheets": [
            {"name": "Costs", "rows": [["Item", "Amount", "Paid on"], ["Flat", 450000, "2026-03-01"], ["Fees", "12,500", ""]]},
            {"name": "Notes", "rows": [["id", "note"], ["007", "x"]]}]}, CONFIG).raw
        self.d = data.Data([("expenses.csv", EXPENSES), ("Budget.xlsx", workbook)])
        self.addCleanup(self.d.close)

    def test_each_sheet_a_table_with_its_columns_typed_and_named_for_sql(self):
        self.assertEqual([t["table"] for t in self.d.tables], ["expenses", "budget_costs", "budget_notes"])
        cols = {c["name"]: c["type"] for c in self.d.tables[0]["columns"]}
        self.assertEqual(cols, {"date": "text", "category": "text", "amount": "number", "code": "text"},
                         "₹ and thousands are numbers; a code with a leading zero stays text")
        described = self.d.describe()
        self.assertIn("- expenses (from expenses.csv, 4 rows): date (text), category (text), amount (number, was “Amount (₹)”)", described)
        self.assertIn("budget_costs (from Budget.xlsx, sheet Costs, 2 rows)", described)

    def test_exact_answers_including_medians_and_correlations(self):
        by = self.d.query("SELECT category, SUM(amount) AS total FROM expenses GROUP BY category ORDER BY total DESC")
        self.assertEqual(by["rows"], [("Rent", 25000), ("Travel", 3400), ("Food", 2050.5)])
        month = self.d.query("SELECT strftime('%Y-%m', date) AS m, SUM(amount) FROM expenses GROUP BY m")
        self.assertEqual(month["rows"], [("2026-01", 26200), ("2026-02", 4250.5)])
        stats = self.d.query("SELECT median(amount), round(stdev(amount), 1), corr(amount, amount), sqrt(16) FROM expenses")
        import statistics
        self.assertEqual(stats["rows"], [(2300.0, round(statistics.stdev([1200, 25000, 850.5, 3400]), 1), 1.0, 4.0)])
        self.assertIn("| Rent | 25000 |", data.as_table(by))
        self.assertIn("| 2026-02 | 4250.5 |", data.as_table(month))
        exact = self.d.query("SELECT 44662.76 AS a, 133988.28 AS b, 0.1 + 0.2 AS c")
        self.assertIn("| 44662.76 | 133988.28 | 0.3 |", data.as_table(exact), "numbers in full, never rounded to 6 digits")

    def test_nothing_but_reading_and_never_for_long(self):
        for sql in ("DELETE FROM expenses", "SELECT 1; DROP TABLE expenses", "ATTACH '/etc/passwd' AS x", "PRAGMA table_info(expenses)",
                    "UPDATE expenses SET amount = 0", "CREATE TABLE x (a)", "SELECT * FROM pragma_table_info('expenses')",
                    "VACUUM INTO '/tmp/x.db'"):
            with self.assertRaises(data.DataError, msg=sql):
                self.d.query(sql)
        from unittest.mock import patch
        with patch.object(data, "QUERY_SECONDS", 1.0), self.assertRaisesRegex(data.DataError, "more than 1 seconds; ask for less"):
            self.d.query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n")
        self.assertEqual(self.d.query("SELECT count(*) FROM expenses")["rows"], [(4,)], "still all there")

    def test_a_big_result_is_capped_and_says_so(self):
        big = data.Data([("n.csv", ("n\n" + "\n".join(str(i) for i in range(500))).encode())])
        result = big.query("SELECT n FROM n")
        self.assertEqual((len(result["rows"]), result["more"]), (data.MAX_RESULT_ROWS, True))
        self.assertIn(f"(more than {data.MAX_RESULT_ROWS} rows; showing the first {data.SHOWN_ROWS}.", data.as_table(result))


class Model:
    def __init__(self, world):
        self.world, self.model, self.context_size = world, "chat-model", 0

    def prepare_model(self, **_):
        pass

    def model_context_limit(self):
        return 32768

    def chat(self, messages, tools=None, reasoning_effort=None, on_text=None, on_thinking=None, cancel=None):
        if str(messages[0]["content"]).startswith(LOOK_UP[:60]):
            return SimpleNamespace(content="", tool_calls=[ToolCall("lu", "search_first", {"needs_search": False, "query": ""})],
                                   finish_reason="stop", thinking="", usage={})
        self.world["read"].append({"messages": messages, "tools": [t["function"]["name"] for t in tools or []]})
        step = self.world["script"].pop(0) if self.world["script"] else {"parts": ["OK."]}
        for part in step.get("parts", []):
            on_text(part)
        calls = [ToolCall(f"c{i}", name, args) for i, (name, args) in enumerate(step.get("calls", []))]
        return SimpleNamespace(content="".join(step.get("parts", [])), tool_calls=calls, finish_reason="stop",
                               thinking="", usage={"input_tokens": 10, "output_tokens": 5})


class InChat(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="chatdgc-data-")
        self.addCleanup(temp.cleanup)
        folder = Path(temp.name)
        self.csv = folder / "expenses.csv"
        self.csv.write_bytes(EXPENSES)
        self.world = {"script": [], "read": []}
        config = SimpleNamespace(base_url="", api_key="", model="chat-model", project_root=str(folder),
                                 get=lambda key, default=None: default)
        self.engine = ChatEngine(config, ChatStore(folder / "chat"), searcher=lambda q: [],
                                 memory=SharedMemory(folder / "memory"), projects=lambda hidden: [],
                                 client_factory=lambda model: Model(self.world), plugins=lambda chat, said, taint: None)

    def test_a_spreadsheet_is_queried_exactly_and_the_queries_are_kept_on_the_reply(self):
        chat = self.engine.open()
        self.world["script"] += [{"parts": ["Hello."]}]
        self.engine.send(chat["id"], "Hi")
        self.assertNotIn("query_data", self.world["read"][-1]["tools"], "no spreadsheet, no tool")
        sql = "SELECT category, SUM(amount) AS total FROM expenses GROUP BY category ORDER BY total DESC LIMIT 1"
        self.world["script"] += [{"calls": [("query_data", {"sql": sql}), ("query_data", {"sql": "DROP TABLE expenses"})]},
                                 {"parts": ["Rent, ₹25,000."]}]
        reply = self.engine.send(chat["id"], "Which category did I spend most on?", attachments=[{"kind": "file", "path": str(self.csv)}])
        first = self.world["read"][-2]
        self.assertIn("query_data", first["tools"])
        self.assertIn("- expenses (from expenses.csv, 4 rows)", first["messages"][0]["content"], "the tables are in its instructions")
        told = [m["content"] for m in self.world["read"][-1]["messages"] if m["role"] == "tool"]
        self.assertEqual(told[0], "1 row:\n| category | total |\n|---|---|\n| Rent | 25000 |")
        self.assertTrue(told[1].startswith("error: Only one SELECT"))
        self.assertEqual([q.get("error", "") == "" for q in reply["queries"]], [True, False])
        self.assertEqual(reply["queries"][0]["rows"], [["Rent", 25000]])
        self.world["script"] += [{"parts": ["Sure."]}]
        self.engine.send(chat["id"], "Thanks")
        history = "\n".join(str(m["content"]) for m in self.world["read"][-1]["messages"])
        self.assertIn(f"[You queried the chat's data here: {sql}]", history)

    def test_charts_are_in_the_instructions(self):
        self.assertIn(CHARTS, system_prompt())
        self.assertIn("```chart", CHARTS)


if __name__ == "__main__":
    unittest.main()
