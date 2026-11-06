"""Token usage by system (0.51): which computer or cloud service each counted request ran on.

The ledger stores the DGC Router system that sent each request (a nullable column added to older ledgers), and
every report names each row's system: a Router system by its stored id or its address, this computer, an Ollama
cloud model as Ollama Cloud, a cloud service by its host. A report can keep one system only (totals, days and
models), in Settings -> Token usage (get_usage / get_pip_usage_report `system`), `dgc usage --system` and `/usage`.
"""
from __future__ import annotations

import contextlib
import json
import os
import queue
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import config as config_mod  # noqa: E402
from dgc import pip_usage, pip_usage_report, usage_ledger, usage_systems  # noqa: E402
from dgc.agent import Agent  # noqa: E402
from dgc.editor_protocol import COMMAND_FIELDS, command_error, event_error  # noqa: E402

NAS = {"id": "nas", "name": "NAS", "base_url": "http://nas.local:11434", "server": "ollama"}
MINI = {"id": "mini", "name": "Mini PC", "base_url": "http://mini.local:11434", "server": "ollama"}
SYSTEMS = [NAS, MINI]


class _Case(unittest.TestCase):
    def setUp(self):
        home = tempfile.TemporaryDirectory(prefix="dgc-usage-system-")
        self.addCleanup(home.cleanup)
        self.home = Path(home.name)
        for name, value in (("USER_HOME", self.home / ".dgc"), ("USER_CONFIG", self.home / ".dgc" / "config.json")):
            patcher = patch.object(config_mod, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        usage_ledger._reset_for_tests()
        self.addCleanup(usage_ledger._reset_for_tests)
        self.now = time.time()

    def add(self, model, base_url, *, provider="ollama", inp=100, out=10, system_id=None, source="main", ago=0,
            metered=None):
        self.assertTrue(usage_ledger.record(provider=provider, base_url=base_url, model=model, source=source,
                                            input_tokens=inp, output_tokens=out, system_id=system_id,
                                            metered=metered, now=self.now - ago))

    def stored(self):
        with sqlite3.connect(str(usage_ledger.ledger_path())) as db:
            return db.execute("SELECT host, model, system_id FROM requests ORDER BY id").fetchall()

    def names(self, report):
        return {(row["model"], row["system"]) for row in report["by_model"]}


class LedgerSystemTests(_Case):
    def test_a_row_is_named_by_the_router_system_whose_address_it_went_to(self):
        self.add("qwen3.5:9b", "http://nas.local:11434/v1")                 # no stored id: an older row
        self.add("qwen2.5:7b", "http://mini.local:11434/v1", system_id="mini")
        rows = usage_ledger.report("7d", systems=SYSTEMS, now=self.now)["by_model"]
        self.assertEqual({(r["model"], r["system"], r["system_id"], r["system_kind"]) for r in rows},
                         {("qwen3.5:9b", "NAS", "nas", "system"), ("qwen2.5:7b", "Mini PC", "mini", "system")})
        self.assertEqual({r["host"] for r in rows}, {"nas.local:11434", "mini.local:11434"},
                         "the address stays in the row, for the tooltip and --json")

    def test_a_renamed_system_shows_its_new_name_for_all_of_its_history(self):
        self.add("qwen3.5:9b", "http://nas.local:11434/v1", system_id="nas", ago=3 * 86400)
        self.add("qwen3.5:9b", "http://nas.local:11434/v1", ago=86400)
        renamed = [{**NAS, "name": "Basement NAS"}, MINI]
        report = usage_ledger.report("7d", systems=renamed, now=self.now)
        self.assertEqual([(r["system"], r["requests"]) for r in report["by_model"]], [("Basement NAS", 2)],
                         "an older row and a newer one with its stored id are one row")

    def test_a_system_whose_address_changed_keeps_its_history_through_the_stored_id(self):
        self.add("qwen3.5:9b", "http://192.0.2.10:11434/v1", system_id="nas", inp=500, out=50, ago=2 * 86400)
        self.add("qwen3.5:9b", "http://192.0.2.10:11434/v1", inp=7, out=1, ago=2 * 86400)    # no id: by address
        self.add("qwen3.5:9b", "http://nas.local:11434/v1", system_id="nas", inp=100, out=10)
        report = usage_ledger.report("7d", systems=SYSTEMS, now=self.now)
        by = {(r["host"], r["system"]): r["input_tokens"] for r in report["by_model"]}
        self.assertEqual(by, {("192.0.2.10:11434", "NAS"): 500, ("nas.local:11434", "NAS"): 100,
                              ("192.0.2.10:11434", "192.0.2.10:11434"): 7})
        only = usage_ledger.report("7d", systems=SYSTEMS, now=self.now, system="nas")
        self.assertEqual((only["totals"]["input_tokens"], only["totals"]["requests"]), (600, 2))

    def test_an_ollama_cloud_model_counts_as_ollama_cloud_not_the_computer_it_passed_through(self):
        self.add("glm-5.3:cloud", "http://127.0.0.1:11434/v1", inp=1000, out=100)
        self.add("gpt-oss:120b-cloud", "http://nas.local:11434/v1", system_id="nas", inp=300, out=30)
        self.add("qwen3.5:9b", "http://nas.local:11434/v1", system_id="nas", inp=50, out=5)
        self.add("glm-5.3:cloud", "https://ollama.com/v1", inp=1, out=1)
        report = usage_ledger.report("7d", systems=SYSTEMS, now=self.now)
        self.assertEqual(self.names(report), {("glm-5.3:cloud", "Ollama Cloud"), ("gpt-oss:120b-cloud", "Ollama Cloud"),
                                              ("qwen3.5:9b", "NAS")})
        systems = usage_systems.by_system(report["by_model"])
        self.assertEqual([(s["system"], s["input_tokens"]) for s in systems], [("Ollama Cloud", 1301), ("NAS", 50)],
                         "the NAS did 50 tokens of work, not 350")
        nas = usage_ledger.report("7d", systems=SYSTEMS, now=self.now, system="NAS")
        self.assertEqual(nas["totals"]["input_tokens"], 50)

    def test_a_cloud_stub_its_discovery_found_counts_as_ollama_cloud(self):
        self.add("kimi-k3", "http://nas.local:11434/v1", system_id="nas")
        with patch("dgc.router.runs_elsewhere", side_effect=lambda system, model: model == "kimi-k3"):
            report = usage_ledger.report("7d", systems=SYSTEMS, now=self.now)
        self.assertEqual(self.names(report), {("kimi-k3", "Ollama Cloud")})

    def test_this_computer_or_the_name_the_person_gave_it(self):
        self.add("qwen2.5:7b", "http://127.0.0.1:11434/v1")
        self.add("small", "http://localhost:8080/v1", provider="llamacpp")
        alone = usage_ledger.report("7d", systems=SYSTEMS, now=self.now)
        self.assertEqual({r["system"] for r in alone["by_model"]}, {"This computer"})
        self.assertEqual({r["system_id"] for r in alone["by_model"]}, {"computer:this"})
        named = [*SYSTEMS, {"id": "gpu-box", "name": "GPU box", "base_url": "http://127.0.0.1:11434", "server": "ollama"}]
        self.assertEqual({r["system"] for r in usage_ledger.report("7d", systems=named, now=self.now)["by_model"]},
                         {"GPU box"}, "this computer's own server, on another port too, is the system named for it")
        twice = [*named, {"id": "gpu-box-2", "name": "Second", "base_url": "http://localhost:11434", "server": "ollama"}]
        rows = {r["model"]: r["system"] for r in usage_ledger.report("7d", systems=twice, now=self.now)["by_model"]}
        self.assertEqual(rows, {"qwen2.5:7b": "GPU box", "small": "This computer"},
                         "two systems on this computer: only an exact address names one")

    def test_cloud_services_by_their_host_and_an_unknown_host_by_itself(self):
        for model, url, provider in (("claude-x", "https://api.anthropic.com/v1", "anthropic"),
                                     ("gpt-x", "https://api.openai.com/v1", "openai"),
                                     ("deepseek-chat", "https://api.deepseek.com/v1", "deepseek"),
                                     ("m", "https://llm.example.com/v1", "compat"),
                                     ("lan", "http://gpu-box.local:8000/v1", "vllm")):
            self.add(model, url, provider=provider)
        rows = {r["model"]: (r["system"], r["system_id"], r["system_kind"])
                for r in usage_ledger.report("7d", systems=[], now=self.now)["by_model"]}
        self.assertEqual(rows, {
            "claude-x": ("Anthropic", "service:anthropic", "service"),
            "gpt-x": ("OpenAI", "service:openai", "service"),
            "deepseek-chat": ("DeepSeek", "service:deepseek", "service"),
            "m": ("llm.example.com", "host:llm.example.com", "service"),
            "lan": ("gpu-box.local:8000", "host:gpu-box.local:8000", "computer")})

    def test_the_filter_applies_to_totals_days_and_models(self):
        self.add("qwen3.5:9b", "http://nas.local:11434/v1", system_id="nas", inp=100, out=10, ago=2 * 86400)
        self.add("qwen3.5:9b", "http://nas.local:11434/v1", system_id="nas", inp=40, out=4, metered=False)
        self.add("glm-5.3:cloud", "http://127.0.0.1:11434/v1", inp=1000, out=100)
        self.add("claude-x", "https://api.anthropic.com/v1", provider="anthropic", inp=9, out=9, ago=86400)
        whole = usage_ledger.report("7d", systems=SYSTEMS, now=self.now)
        nas = usage_ledger.report("7d", systems=SYSTEMS, now=self.now, system="nas")
        self.assertEqual(nas["totals"], {"input_tokens": 140, "output_tokens": 14, "cached_input_tokens": 0,
                                         "requests": 2, "unmetered_requests": 1})
        self.assertEqual([r["model"] for r in nas["by_model"]], ["qwen3.5:9b"])
        self.assertEqual(len(nas["by_day"]), len(whole["by_day"]), "every day of the range is still listed")
        self.assertEqual([(d["input_tokens"], d["requests"]) for d in nas["by_day"] if d["requests"]],
                         [(100, 1), (40, 1)])
        self.assertEqual(sum(d["input_tokens"] for d in whole["by_day"]), 1149, "unfiltered: everything, as before")
        by_name = usage_ledger.report("7d", systems=SYSTEMS, now=self.now, system="ollama cloud")
        self.assertEqual(by_name["totals"]["input_tokens"], 1000, "a name in any case works too")
        nowhere = usage_ledger.report("7d", systems=SYSTEMS, now=self.now, system="no such system")
        self.assertEqual((nowhere["totals"]["requests"], nowhere["by_model"]), (0, []))
        self.assertEqual(len(nowhere["by_day"]), 7)
        pips = usage_ledger.by_model_for_source("main", "7d", now=self.now, systems=SYSTEMS, system="anthropic")
        self.assertEqual([r["model"] for r in pips], ["claude-x"])

    def test_an_old_ledger_without_the_column_reads_and_then_stores_ids(self):
        path = usage_ledger.ledger_path()
        path.parent.mkdir(parents=True)
        with contextlib.closing(sqlite3.connect(str(path))) as db:
            db.execute("""CREATE TABLE requests(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL,
                host TEXT NOT NULL, model TEXT NOT NULL, source TEXT NOT NULL, input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL, metered INTEGER NOT NULL)""")
            db.execute("INSERT INTO requests(ts,provider,host,model,source,input_tokens,output_tokens,"
                       "cached_input_tokens,metered) VALUES (?,?,?,?,?,?,?,?,?)",
                       (int(self.now), "ollama", "nas.local:11434", "qwen3.5:9b", "main", 70, 7, 0, 1))
            db.commit()
        report = usage_ledger.report("7d", systems=SYSTEMS, now=self.now)
        self.assertEqual([(r["system"], r["input_tokens"]) for r in report["by_model"]], [("NAS", 70)])
        self.add("qwen2.5:7b", "http://mini.local:11434/v1", system_id="mini")
        self.assertEqual(self.stored(), [("nas.local:11434", "qwen3.5:9b", None),
                                         ("mini.local:11434", "qwen2.5:7b", "mini")])
        # An older DGC names its columns when it writes, so it keeps working with the new column there.
        with contextlib.closing(sqlite3.connect(str(path))) as db:
            db.execute("INSERT INTO requests(ts,provider,host,model,source,input_tokens,output_tokens,"
                       "cached_input_tokens,metered) VALUES (?,?,?,?,?,?,?,?,?)",
                       (int(self.now), "ollama", "nas.local:11434", "qwen3.5:9b", "main", 30, 3, 0, 1))
            db.commit()
        nas = usage_ledger.report("7d", systems=SYSTEMS, now=self.now, system="nas")
        self.assertEqual(nas["totals"]["input_tokens"], 100)

    def test_only_a_system_id_is_stored_never_an_address_or_text(self):
        self.add("m", "http://nas.local:11434/v1", system_id="http://nas.local:11434")
        self.add("m", "http://nas.local:11434/v1", system_id="NAS box")
        self.add("m", "http://nas.local:11434/v1", system_id="nas")
        self.assertEqual([row[2] for row in self.stored()], [None, None, "nas"])

    def test_names_come_from_the_users_config_when_no_systems_are_given(self):
        config_mod.USER_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        config_mod.USER_CONFIG.write_text(json.dumps({"router": {"enabled": False, "systems": [
            {"id": "nas", "name": "NAS", "base_url": "http://nas.local:11434", "server": "ollama"}]}}))
        self.add("qwen3.5:9b", "http://nas.local:11434/v1")
        self.assertEqual(self.names(usage_ledger.report("7d", now=self.now)), {("qwen3.5:9b", "NAS")},
                         "a system keeps its name with the Router off")

    def test_systems_in_lists_every_system_of_the_range_most_tokens_first(self):
        self.add("qwen3.5:9b", "http://nas.local:11434/v1", system_id="nas", inp=10, out=0)
        self.add("glm-5.3:cloud", "http://127.0.0.1:11434/v1", inp=900, out=0)
        self.add("qwen2.5:7b", "http://mini.local:11434/v1", inp=0, out=0, metered=False)
        found = usage_ledger.systems_in("7d", systems=SYSTEMS, now=self.now)
        self.assertEqual([(s["system"], s["requests"], s["unmetered_requests"]) for s in found],
                         [("Ollama Cloud", 1, 0), ("NAS", 1, 0), ("Mini PC", 1, 1)])


class TerminalTests(_Case):
    def seed(self):
        self.add("qwen3.5:9b", "http://nas.local:11434/v1", system_id="nas", inp=100, out=10)
        self.add("glm-5.3:cloud", "http://127.0.0.1:11434/v1", inp=1000, out=100)

    def test_dgc_usage_has_a_by_system_block_only_with_more_than_one_system(self):
        self.add("qwen3.5:9b", "http://nas.local:11434/v1", system_id="nas", inp=100, out=10)
        report, name, found = usage_ledger.system_report("7d", "", systems=SYSTEMS, now=self.now)
        one = usage_ledger.format_report(report, shell=True, by_system=found)
        self.assertNotIn("By system", one)
        self.assertIn("Provider · host", one, "one system: the page reads as it did")
        self.add("glm-5.3:cloud", "http://127.0.0.1:11434/v1", inp=1000, out=100)
        report, name, found = usage_ledger.system_report("7d", "", systems=SYSTEMS, now=self.now)
        two = usage_ledger.format_report(report, shell=True, by_system=found)
        self.assertIn("### By system", two)
        self.assertIn("| Ollama Cloud | 1 | 1,000 | 100 | 91% |", two)
        self.assertIn("| NAS | 1 | 100 | 10 | 9% |", two)
        self.assertIn("| qwen3.5:9b | NAS · ollama |", two)
        self.assertIn("`dgc usage --system NAME`", two)

    def test_one_system_by_name_and_an_unknown_one_says_which_there_are(self):
        self.seed()
        report, name, _found = usage_ledger.system_report("7d", "nas", systems=SYSTEMS, now=self.now)
        self.assertEqual((name, report["totals"]["input_tokens"]), ("NAS", 100))
        text = usage_ledger.format_report(report, shell=True, system=name)
        self.assertIn("## Token usage · Last 7 days · NAS", text)
        self.assertNotIn("glm-5.3:cloud", text)
        quiet, name, _ = usage_ledger.system_report("7d", "Mini PC", systems=SYSTEMS, now=self.now)
        self.assertEqual((name, quiet["totals"]["requests"]), ("Mini PC", 0))
        self.assertIn("No model requests counted on Mini PC in this range.",
                      usage_ledger.format_report(quiet, shell=True, system=name))
        with self.assertRaisesRegex(ValueError, "no system called Basement. Systems with usage in this range: "
                                                "Ollama Cloud, NAS"):
            usage_ledger.system_report("7d", "Basement", systems=SYSTEMS, now=self.now)

    def test_usage_arguments_take_a_range_then_a_system(self):
        self.assertEqual(usage_ledger.parse_usage_args(""), ("7d", ""))
        self.assertEqual(usage_ledger.parse_usage_args("30d"), ("30d", ""))
        self.assertEqual(usage_ledger.parse_usage_args("today Mini PC"), ("today", "Mini PC"))
        self.assertEqual(usage_ledger.parse_usage_args("Ollama Cloud"), ("7d", "Ollama Cloud"))
        self.assertEqual(usage_ledger.parse_usage_args("this month"), ("month", ""))

    def test_dgc_usage_system_from_a_shell_with_json(self):
        dot = self.home / ".dgc"
        dot.mkdir(parents=True, exist_ok=True)
        (dot / "config.json").write_text(json.dumps({"router": {"enabled": True, "systems": [
            {"id": "nas", "name": "NAS", "base_url": "http://nas.local:11434", "server": "ollama"}]}}))
        self.seed()
        usage_ledger._reset_for_tests()
        env = dict(os.environ, PYTHONPATH=str(PROJECT), HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1",
                   COLUMNS="200")
        env.pop("DGC_HOME", None)
        run = lambda *args: subprocess.run([sys.executable, "-m", "dgc", "usage", *args], env=env,
                                           capture_output=True, text=True, timeout=60)
        done = run("--system", "NAS", "--json")
        self.assertEqual(done.returncode, 0, done.stderr)
        value = json.loads(done.stdout)
        self.assertEqual((value["system"], value["totals"]["input_tokens"]), ("NAS", 100))
        self.assertEqual([r["system"] for r in value["by_model"]], ["NAS"])
        self.assertEqual([s["system"] for s in value["by_system"]], ["Ollama Cloud", "NAS"])
        text = run()
        self.assertEqual(text.returncode, 0, text.stderr)
        self.assertIn("By system", text.stdout)
        self.assertIn("Ollama Cloud", text.stdout)
        bad = run("--system", "Basement")
        self.assertEqual(bad.returncode, 2)
        self.assertIn("no system called Basement", bad.stderr)

    def test_tui_usage_takes_a_system(self):
        from dgc.tui import TUI
        self.seed()
        opened = []
        fake = type("T", (), {"_open_reader": lambda self, md, **kw: opened.append(md),
                              "_flash": lambda self, message: opened.append(("flash", message))})()
        with patch("dgc.usage_systems.router_systems", return_value=SYSTEMS):
            TUI._show_usage(fake, "today NAS")
            self.assertIn("Token usage · Today · NAS", opened[-1])
            TUI._show_usage(fake, "")
            self.assertIn("By system", opened[-1])
            TUI._show_usage(fake, "Basement")
        self.assertEqual(opened[-1][0], "flash")


class ProtocolTests(unittest.TestCase):
    def test_get_usage_and_the_pips_report_take_an_optional_system(self):
        for kind in ("get_usage", "get_pip_usage_report"):
            self.assertIn("system", COMMAND_FIELDS[kind])
            self.assertFalse(COMMAND_FIELDS[kind]["system"]["required"])
            self.assertIsNone(command_error({"type": kind, "request_id": "u", "range": "7d"}))
            self.assertIsNone(command_error({"type": kind, "request_id": "u", "range": "7d", "system": "nas"}))
            self.assertIsNotNone(command_error({"type": kind, "request_id": "u", "range": "7d", "system": 3}))
        # System names travel inside the rows, never as new top-level fields of the reports.
        report = usage_ledger.empty_report("7d")
        report["by_model"] = [{"model": "m", "provider": "ollama", "host": "nas.local:11434", "requests": 1,
                               "unmetered_requests": 0, "input_tokens": 1, "output_tokens": 1,
                               "cached_input_tokens": 0, "system": "NAS", "system_id": "nas",
                               "system_kind": "system"}]
        self.assertIsNone(event_error({"type": "usage_report", "seq": 1, "request_id": "u", **report}))
        self.assertIsNotNone(event_error({"type": "usage_report", "seq": 1, "request_id": "u", **report,
                                          "by_system": []}), "a top-level field would fail an SDK's validator")


class RecordingTests(_Case):
    def agent(self, **router):
        cfg = object.__new__(config_mod.Config)
        cfg.data = {"router": {"enabled": True, "systems": [dict(NAS)]}, **router}
        owner = types.SimpleNamespace(depth=0, config=cfg)
        return owner

    def test_a_routed_client_stores_its_systems_id_and_a_main_turn_its_systems_by_address(self):
        from dgc.llm import ChatResult
        owner = self.agent()
        result = ChatResult(content="x", usage={"prompt_tokens": 3, "completion_tokens": 1})
        routed = types.SimpleNamespace(api_mode="ollama", family="ollama", base_url="http://192.0.2.7:11434/v1",
                                       model="qwen3.5:9b", usage_source="subagent",
                                       _router_route=types.SimpleNamespace(system_id="mini"))
        Agent._ledger_usage(owner, routed, result)
        main = types.SimpleNamespace(api_mode="ollama", family="ollama", base_url="http://nas.local:11434/v1",
                                     model="qwen3.5:9b", usage_source="main")
        Agent._ledger_usage(owner, main, result)
        other = types.SimpleNamespace(api_mode="", family="anthropic", base_url="https://api.anthropic.com/v1",
                                      model="claude-x", usage_source="main")
        Agent._ledger_usage(owner, other, result)
        self.assertEqual(self.stored(), [("192.0.2.7:11434", "qwen3.5:9b", "mini"),
                                         ("nas.local:11434", "qwen3.5:9b", "nas"),
                                         ("api.anthropic.com", "claude-x", None)])

    def test_a_stub_config_never_costs_the_row(self):
        from dgc.llm import ChatResult
        owner = types.SimpleNamespace(depth=1, config=None)
        client = types.SimpleNamespace(api_mode="", family="compat", base_url="http://nas.local:11434/v1",
                                       model="m", usage_source="main")
        Agent._ledger_usage(owner, client, ChatResult(content="x", usage={"prompt_tokens": 1}))
        self.assertEqual(self.stored(), [("nas.local:11434", "m", None)])


class PipImportTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.run = "run_" + "b" * 32
        self.path = self.home / "pips" / "runs" / self.run / "worker-home" / ".dgc" / "usage.sqlite"
        self.path.parent.mkdir(parents=True)
        self.addCleanup(usage_ledger._reset_for_tests)
        now = int(time.time())
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            db.execute(usage_ledger._SCHEMA)
            db.executemany("INSERT INTO requests(ts,provider,host,model,source,input_tokens,output_tokens,"
                           "cached_input_tokens,metered) VALUES (?,?,?,?,?,?,?,?,?)",
                           [(now, "ollama", "nas.local:11434", "qwen3.5:9b", "main", 100, 10, 0, 1),
                            (now, "ollama", "127.0.0.1:11434", "glm-5.3:cloud", "main", 5, 1, 0, 1)])
            db.commit()

    def test_a_routed_runs_requests_keep_the_system_it_leased(self):
        self.assertTrue(pip_usage.import_run(self.run, home=self.home, routed=("nas", "http://nas.local:11434/v1")))
        with contextlib.closing(sqlite3.connect(self.home / usage_ledger.LEDGER_NAME)) as db:
            rows = db.execute("SELECT host, source, system_id FROM requests ORDER BY id").fetchall()
        self.assertEqual(rows, [("nas.local:11434", "pip", "nas"), ("127.0.0.1:11434", "pip", None)])
        models = sorted(pip_usage.run_models([self.run], home=self.home, with_system=True)[self.run])
        self.assertEqual(models, [("glm-5.3:cloud", "ollama", "127.0.0.1:11434", 5, 1, 1, None),
                                  ("qwen3.5:9b", "ollama", "nas.local:11434", 100, 10, 1, "nas")])
        self.assertEqual(sorted(pip_usage.run_models([self.run], home=self.home)[self.run])[1],
                         ("qwen3.5:9b", "ollama", "nas.local:11434", 100, 10, 1), "the old shape is unchanged")

    def test_an_unrouted_run_stores_no_system(self):
        self.assertTrue(pip_usage.import_run(self.run, home=self.home))
        with contextlib.closing(sqlite3.connect(self.home / usage_ledger.LEDGER_NAME)) as db:
            self.assertEqual({r[0] for r in db.execute("SELECT system_id FROM requests")}, {None})

    def test_an_older_run_models_table_gets_the_column(self):
        ledger_file = self.home / usage_ledger.LEDGER_NAME
        with contextlib.closing(sqlite3.connect(ledger_file)) as db:
            db.execute("CREATE TABLE pip_usage_run_models(run_id TEXT NOT NULL, model TEXT NOT NULL, provider TEXT "
                       "NOT NULL, host TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, "
                       "requests INTEGER NOT NULL, PRIMARY KEY(run_id, model, provider, host))")
            db.execute("INSERT INTO pip_usage_run_models VALUES (?,?,?,?,?,?,?)",
                       ("run_" + "c" * 32, "m", "ollama", "h", 1, 1, 1))
            db.commit()
        pip_usage.import_run(self.run, home=self.home, routed=("nas", "http://nas.local:11434"))
        self.assertEqual(pip_usage.run_models(["run_" + "c" * 32], home=self.home, with_system=True),
                         {"run_" + "c" * 32: [("m", "ollama", "h", 1, 1, 1, None)]})


from tests import test_pip_spend as spend   # noqa: E402  (the module, not the class: a TestCase would rerun here)

NOW = 1_790_000_000.0


class PipReportSystemTests(unittest.TestCase):
    setUp = spend.SpendTests.setUp
    finish = spend.SpendTests.finish

    def job(self, name):
        job = self.store.create(self.workspace["id"], name, "Inspect source", "user")
        proposal = self.store.propose(job["id"], 1, {"schedule": {"type": "interval", "minutes": 5}}, "user")
        return self.store.accept(job["id"], proposal["id"], 1, "user")

    def imported(self, run_id, rows):
        """What the runner records when it imports a run: its totals and its models (with the system it leased)."""
        path = Path(self.registry.directory).parent / "usage.sqlite"
        with contextlib.closing(sqlite3.connect(path)) as db:
            pip_usage._imports_table(db)
            db.execute("INSERT INTO pip_usage_imports(run_id,imported_at,input_tokens,output_tokens,requests) "
                       "VALUES (?,?,?,?,?)", (run_id, 0, sum(r[3] for r in rows), sum(r[4] for r in rows), len(rows)))
            db.executemany("INSERT INTO pip_usage_run_models(run_id,model,provider,host,input_tokens,output_tokens,"
                           "requests,system_id) VALUES (?,?,?,?,?,?,?,?)", [(run_id, *row) for row in rows])
            db.commit()

    def report(self, system=None):
        own = Path(self.registry.directory).parent / "report-ledger.sqlite"
        with patch("dgc.workspace_registry.WorkspaceRegistry", return_value=self.registry), \
                patch.object(self.registry, "close"), patch("dgc.workspace_registry.in_use", return_value=True), \
                patch.object(usage_ledger, "ledger_path", return_value=own):
            usage_ledger._reset_for_tests()
            return pip_usage_report.report("all", now=time.time(), system=system, systems=SYSTEMS)

    def test_one_systems_part_of_each_pip(self):
        inbox, docs = self.job("Inbox"), self.job("Docs")
        one = self.store.enqueue(inbox["id"], "a", "user", self.cfg)
        self.finish(one["id"], tokens=1_000)
        self.imported(one["id"], [("qwen3.5:9b", "ollama", "nas.local:11434", 600, 60, 2, "nas"),
                                  ("glm-5.3:cloud", "ollama", "127.0.0.1:11434", 300, 30, 1, None)])
        two = self.store.enqueue(docs["id"], "b", "user", self.cfg)
        self.finish(two["id"], tokens=500)
        self.imported(two["id"], [("qwen2.5:7b", "ollama", "mini.local:11434", 400, 40, 1, None)])
        everything = self.report()
        self.assertEqual({p["name"]: p["input_tokens"] for p in everything["by_pip"]}, {"Inbox": 900, "Docs": 400})
        nas = self.report("NAS")
        self.assertEqual([(p["name"], p["input_tokens"], p["output_tokens"], p["runs"]) for p in nas["by_pip"]],
                         [("Inbox", 600, 60, 1)])
        self.assertEqual(nas["totals"], {"input_tokens": 600, "output_tokens": 60, "runs": 1})
        self.assertEqual([m["model"] for m in nas["by_pip"][0]["models"]], ["qwen3.5:9b"])
        cloud = self.report("service:ollama-cloud")
        self.assertEqual([(p["name"], p["input_tokens"]) for p in cloud["by_pip"]], [("Inbox", 300)])
        self.assertEqual([p["name"] for p in self.report("mini")["by_pip"]], ["Docs"])


class ServeRoundTripTests(unittest.TestCase):
    """A real `dgc serve` with DGC Router systems in its config: get_usage with and without `system`."""

    def test_get_usage_by_system_over_stdio(self):
        home = tempfile.TemporaryDirectory(prefix="dgc-usage-system-serve-")
        work = tempfile.TemporaryDirectory(prefix="dgc-usage-system-work-")
        self.addCleanup(home.cleanup)
        self.addCleanup(work.cleanup)
        dot = Path(home.name) / ".dgc"
        dot.mkdir()
        (dot / "config.json").write_text(json.dumps({
            "base_url": "http://127.0.0.1:9/v1", "model": "mock-model", "suggest": False, "notes": False,
            "router": {"enabled": True, "systems": [dict(NAS, jobs=["subagents"], models=[{"name": "qwen3.5:9b"}])]}}))
        ledger = dot / usage_ledger.LEDGER_NAME
        for model, url, system_id, inp in (("qwen3.5:9b", "http://nas.local:11434/v1", "nas", 100),
                                           ("glm-5.3:cloud", "http://127.0.0.1:11434/v1", None, 1000),
                                           ("claude-x", "https://api.anthropic.com/v1", None, 10)):
            usage_ledger.record(provider="ollama", base_url=url, model=model, input_tokens=inp, output_tokens=1,
                                system_id=system_id, path=ledger)
        usage_ledger._reset_for_tests()
        env = dict(os.environ, HOME=home.name, PYTHONPATH=str(PROJECT), PYTHONDONTWRITEBYTECODE="1")
        env.pop("DGC_HOME", None)
        proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=work.name, env=env,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        events: "queue.Queue[dict]" = queue.Queue()
        threading.Thread(target=lambda: [events.put(json.loads(line)) for line in proc.stdout if line.strip()],
                         daemon=True).start()

        def cleanup():
            if proc.poll() is None:
                with contextlib.suppress(OSError):
                    proc.stdin.close()
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=10)
            for pipe in (proc.stdin, proc.stdout):
                with contextlib.suppress(OSError, ValueError):
                    pipe.close()
        self.addCleanup(cleanup)

        def wait(predicate, timeout=90):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                try:
                    event = events.get(timeout=max(0.01, deadline - time.monotonic()))
                except queue.Empty:
                    break
                self.assertIsNone(event_error(event), event)
                if predicate(event):
                    return event
            self.fail("no matching event")

        def ask(command):
            self.assertIsNone(command_error(command))
            proc.stdin.write(json.dumps(command) + "\n")
            proc.stdin.flush()
            return wait(lambda e: e.get("request_id") == command["request_id"]
                        and e["type"] in ("usage_report", "pip_usage_report", "command_rejected"))

        ready = wait(lambda e: e["type"] == "ready")
        self.assertIs(ready["capabilities"].get("usage_by_system"), True)
        everything = ask({"type": "get_usage", "request_id": "all", "range": "7d"})
        self.assertEqual({r["system"] for r in everything["by_model"]}, {"NAS", "Ollama Cloud", "Anthropic"})
        self.assertEqual(everything["totals"]["input_tokens"], 1110)
        nas = ask({"type": "get_usage", "request_id": "nas", "range": "7d", "system": "nas"})
        self.assertEqual((nas["totals"]["input_tokens"], [r["model"] for r in nas["by_model"]]), (100, ["qwen3.5:9b"]))
        pips = ask({"type": "get_pip_usage_report", "request_id": "pips", "range": "7d", "system": "nas"})
        self.assertEqual((pips["all_tokens"], pips["by_model"]), (101, []))
        bad = ask({"type": "get_usage", "request_id": "bad", "range": "7d", "system": "x" * 400})
        self.assertEqual(bad["reason"], "invalid_system")
        self.assertIsNone(proc.poll())


if __name__ == "__main__":
    unittest.main()
