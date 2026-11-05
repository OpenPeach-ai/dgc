"""MCP Apps (io.modelcontextprotocol/ui): a plugin's own card in the chat (dgc/mcp_apps.py).

What these pin: a tool's card address and who may call it survive tools/list; a tool only its card calls never reaches
the model; DGC says it can show cards; a Work call of a tool with a card keeps the card (page, input, whole result),
shows it once the client draws cards, tells the model in one line and replays it after a reload; the page is served
from loopback behind its card's token with a CSP built only from what it declared, one origin per plugin; and what a
card asks goes only to its own server, through DGC's approvals (a read runs, a change asks, a payment plugin is asked
every time and never offered Always, plan mode refuses, a tool hidden from cards is refused).
"""
from __future__ import annotations

import copy
import io
import json
import os
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import PropertyMock, patch

if "dgc.config" not in sys.modules:
    _HOME = tempfile.TemporaryDirectory(prefix="dgc-mcp-apps-home-")
    os.environ["HOME"] = os.path.realpath(_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import requests                                              # noqa: E402

from dgc import mcp_apps                                     # noqa: E402
from dgc.config import DEFAULTS, Config                      # noqa: E402
from dgc.mcp import MCPManager                               # noqa: E402

PAGE = "<!doctype html><html><body><h1>Board</h1><script>parent.postMessage({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{}},'*')</script></body></html>"

SERVER = r'''import json, sys
PAGE = %r
CSP = %r
wire = open(sys.argv[1], "a") if len(sys.argv) > 1 else None
for line in sys.stdin:
    r = json.loads(line)
    if wire:
        wire.write(line); wire.flush()
    if "id" not in r:
        continue
    m = r.get("method"); result = {}
    if m == "server/discover":
        print(json.dumps({"jsonrpc": "2.0", "id": r["id"], "error": {"code": -32601, "message": "legacy fixture"}}), flush=True); continue
    if m == "initialize":
        result = {"protocolVersion": "2025-11-25", "capabilities": {"tools": {}, "resources": {}}, "serverInfo": {"name": "board", "version": "1"}}
    elif m == "tools/list":
        result = {"tools": [
            {"name": "show_board", "title": "Show the board", "description": "Show the board", "inputSchema": {"type": "object", "properties": {"size": {"type": "integer"}}},
             "annotations": {"readOnlyHint": True}, "_meta": {"ui": {"resourceUri": "ui://board/card.html"}}},
            {"name": "move", "description": "Make a move", "inputSchema": {"type": "object", "properties": {"to": {"type": "string"}}},
             "_meta": {"openai/outputTemplate": "ui://board/card.html"}},
            {"name": "refresh", "description": "Only the card refreshes", "inputSchema": {"type": "object"},
             "annotations": {"readOnlyHint": True}, "_meta": {"ui": {"visibility": ["app"]}}},
            {"name": "model_only", "description": "Only the model", "inputSchema": {"type": "object"},
             "annotations": {"readOnlyHint": True}, "_meta": {"ui": {"visibility": ["model"]}}},
            {"name": "plain", "description": "No card", "inputSchema": {"type": "object"}}]}
    elif m == "resources/read":
        meta = {"ui": {"csp": CSP, "prefersBorder": True}} if CSP is not None else {}
        result = {"contents": [{"uri": r["params"]["uri"], "mimeType": "text/html;profile=mcp-app", "text": PAGE, "_meta": meta}]}
    elif m == "tools/call":
        name = r["params"]["name"]
        result = {"content": [{"type": "text", "text": "board " + name}], "structuredContent": {"tool": name, "args": r["params"].get("arguments")},
                  "_meta": {"at": "now"}}
    print(json.dumps({"jsonrpc": "2.0", "id": r["id"], "result": result}), flush=True)
'''

CSP = {"connectDomains": ["https://api.board.test"], "resourceDomains": ["https://cdn.board.test", "'unsafe-eval'"]}

# The official MCP Apps example's clock as the release check met it: one tool, get-time, with a card and no annotations.
CLOCK = r'''import json, sys
PAGE = %r
CSP = %r
wire = open(sys.argv[1], "a") if len(sys.argv) > 1 else None
calls = 0
for line in sys.stdin:
    r = json.loads(line)
    if wire:
        wire.write(line); wire.flush()
    if "id" not in r:
        continue
    m = r.get("method"); result = {}
    if m == "server/discover":
        print(json.dumps({"jsonrpc": "2.0", "id": r["id"], "error": {"code": -32601, "message": "legacy fixture"}}), flush=True); continue
    if m == "initialize":
        result = {"protocolVersion": "2025-11-25", "capabilities": {"tools": {}, "resources": {}}, "serverInfo": {"name": "example", "version": "1"}}
    elif m == "tools/list":
        result = {"tools": [{"name": "get-time", "title": "Get time", "description": "Returns the current server time.",
                             "inputSchema": {"type": "object", "properties": {}},
                             "_meta": {"ui": {"resourceUri": "ui://get-time/mcp-app.html"}}}]}
    elif m == "resources/read":
        result = {"contents": [{"uri": r["params"]["uri"], "mimeType": "text/html;profile=mcp-app", "text": PAGE, "_meta": {}}]}
    elif m == "tools/call":
        calls += 1
        at = f"2026-11-03T12:0{calls}:00.000Z"
        result = {"content": [{"type": "text", "text": at}], "structuredContent": {"time": at}}
    print(json.dumps({"jsonrpc": "2.0", "id": r["id"], "result": result}), flush=True)
'''


def _config(root: Path, **extra) -> Config:
    config = object.__new__(Config)
    config.project_root = root
    config.project_dir = root / ".dgc"
    config._persist = False
    config.data = copy.deepcopy(DEFAULTS)
    config.data.update(base_url="http://localhost.invalid/v1", model="fixture-local", mode="default", hooks={},
                       mcp_servers={}, suggest=False, artifact_autostart=False, plan_artifact=False,
                       tool_profile="full", **extra)
    config._stored_secrets = {}
    config._env_secret_keys = set()
    config._stored_mcp_env = {}
    config._stored_mcp_identity = {}
    config._explicit_keys = set()
    config.permissions = {"allow": [], "ask": [], "deny": []}
    config.save = lambda *a, **k: None
    return config


class _Fixture(unittest.TestCase):
    csp = CSP
    server_name, server_source = "board", SERVER

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        home = patch.object(mcp_apps, "home", lambda: self.root / "mcp-apps")
        home.start()
        self.addCleanup(home.stop)
        self.wire = self.root / "wire.jsonl"
        script = self.root / "server.py"
        script.write_text(self.server_source % (PAGE, self.csp))
        self.manager = MCPManager(self.root)
        self.addCleanup(self.manager.stop_all)
        self.manager.connect_all({self.server_name: {"command": sys.executable, "args": [str(script), str(self.wire)]}})
        self.assertIn(self.server_name, self.manager.servers, self.manager.failures)
        self.server = self.manager.servers[self.server_name]

    def requests_sent(self, method: str) -> list[dict]:
        rows = [json.loads(line) for line in self.wire.read_text().splitlines()]
        return [row for row in rows if row.get("method") == method]


class ToolsList(_Fixture):
    def test_a_tools_card_address_and_who_may_call_it_survive_tools_list(self):
        meta = self.server.tool_meta
        self.assertEqual(meta["show_board"]["uri"], "ui://board/card.html")
        self.assertEqual(meta["move"]["uri"], "ui://board/card.html", "ChatGPT's openai/outputTemplate names the same page")
        self.assertEqual(meta["show_board"]["annotations"], {"readOnlyHint": True})
        self.assertEqual(meta["refresh"]["visibility"], ["app"])
        self.assertNotIn("plain", meta)

    def test_a_tool_only_its_card_calls_never_reaches_the_model(self):
        names = [t["name"] for t in self.server.tools]
        self.assertNotIn("refresh", names)
        self.assertIn("refresh", self.server.app_tools)
        offered = [s["function"]["name"] for s in self.manager.tool_schemas()]
        self.assertNotIn("mcp__board__refresh", offered)
        self.assertIn("mcp__board__model_only", offered)

    def test_dgc_says_it_shows_cards(self):
        [init] = self.requests_sent("initialize")
        self.assertEqual(init["params"]["capabilities"]["extensions"],
                         {"io.modelcontextprotocol/ui": {"mimeTypes": ["text/html;profile=mcp-app"]}})

    def test_the_rows_digests_are_unchanged(self):
        """The model's tool rows stay name, description and inputSchema: a Pip's saved approval is pinned to their
        digest, and a release must not invalidate every one of them."""
        for row in self.server.tools:
            self.assertEqual(set(row), {"name", "description", "inputSchema"})


class Policy(unittest.TestCase):
    def test_the_csp_names_only_what_the_page_declared(self):
        header = mcp_apps.csp_header(mcp_apps.sanitize_csp(CSP))
        self.assertIn("connect-src https://api.board.test", header)
        self.assertIn("script-src 'self' 'unsafe-inline' https://cdn.board.test", header)
        self.assertNotIn("unsafe-eval", header)
        self.assertIn("frame-src 'none'", header)
        self.assertIn("object-src 'none'", header)

    def test_a_declared_value_cannot_inject_a_directive(self):
        header = mcp_apps.csp_header({"connectDomains": ["https://a.test; script-src *", "*", "data:", "javascript:x",
                                                         "http://evil.test", "https://*.ok.test", "http://localhost:3000"]})
        self.assertIn("connect-src https://*.ok.test http://localhost:3000;", header)
        self.assertNotIn("evil", header)
        self.assertNotIn("script-src *", header)

    def test_a_long_declared_list_keeps_its_later_origins(self):
        # Higgsfield's preset gallery lists dozens of storage hosts before the one its page's code comes from; a
        # 32-origin cap dropped that one and the card stayed blank.
        many = [f"https://d{n}.cloudfront.net" for n in range(40)] + ["https://mcp.higgsfield.ai"]
        kept = mcp_apps.sanitize_csp({"resourceDomains": many, "connectDomains": many})
        self.assertIn("https://mcp.higgsfield.ai", kept["resourceDomains"])
        header = mcp_apps.csp_header(kept)
        self.assertIn("https://mcp.higgsfield.ai", header.split("script-src", 1)[1].split(";", 1)[0])
        self.assertIn("*.higgsfield.ai", mcp_apps.link_hosts(kept, "https://mcp.higgsfield.ai/mcp"))
        capped = mcp_apps.sanitize_csp({"connectDomains": [f"https://h{n}.test" for n in range(1000)]})
        self.assertEqual(len(capped["connectDomains"]), mcp_apps._CSP_KEEP, "still bounded")

    def test_a_page_that_declared_nothing_reaches_nothing(self):
        header = mcp_apps.csp_header(None)
        self.assertIn("connect-src 'none'", header)
        self.assertIn("default-src 'none'", header)
        self.assertNotIn("https:", header)

    def test_the_sites_it_opens_without_asking(self):
        hosts = mcp_apps.link_hosts({"connectDomains": ["https://*.api.test"], "resourceDomains": ["https://cdn.test"]},
                                    "https://mcp.cardboard.ai/mcp")
        self.assertEqual(hosts, ["*.api.test", "cdn.test", "*.cardboard.ai"])
        self.assertIn("*.example.co.uk", mcp_apps.link_hosts({}, "https://mcp.example.co.uk/"))


class _Card(_Fixture):
    def card(self, tool="show_board", surface="work", **owner):
        result = {"content": [{"type": "text", "text": "the board"}], "structuredContent": {"cells": [1, 2]},
                  "_meta": {"v": 1}}
        return mcp_apps.make_card(server=self.server, tool=tool, arguments={"size": 3}, result=result,
                                  surface=surface, plugin="Board", plugin_id="board", call_id="call_1",
                                  owner={"session_id": "s1", **owner})


class Cards(_Card):
    def test_a_card_keeps_its_page_input_and_whole_result(self):
        record = self.card()
        self.assertRegex(record["card_id"], r"^app_[0-9a-f]{24}$")
        self.assertEqual(record["tool_input"], {"size": 3})
        self.assertEqual(record["tool_result"]["structuredContent"], {"cells": [1, 2]})
        self.assertEqual(record["tool_result"]["_meta"], {"v": 1})
        self.assertEqual(mcp_apps.load_html(record["html_sha"]), PAGE)
        self.assertEqual(mcp_apps.load_card(record["card_id"])["tool"], "show_board")
        self.assertEqual(record["csp"]["connectDomains"], ["https://api.board.test"])
        fields = mcp_apps.event_fields(record)
        self.assertEqual(fields["html"], PAGE)
        self.assertNotIn("html", mcp_apps.event_fields(record, with_html=False), "a replay never carries the page")
        self.assertNotIn("token", fields)
        from dgc.editor_protocol import event_error
        self.assertIsNone(event_error({"type": "mcp_app_card", "seq": 1, **fields}))

    def test_the_page_is_read_once_per_connection(self):
        self.card()
        self.card()
        self.assertEqual(len(self.requests_sent("resources/read")), 1)

    def test_a_result_too_large_for_a_card_shows_none(self):
        huge = {"content": [{"type": "text", "text": "x" * (mcp_apps.MAX_RESULT_BYTES + 10)}]}
        with self.assertRaises(mcp_apps.CardError):
            mcp_apps.make_card(server=self.server, tool="show_board", arguments={}, result=huge, surface="work")

    def test_a_failed_tool_does_not_leave_an_interactive_card_loading(self):
        failed = {"isError": True, "content": [{"type": "text", "text": "Choose a different preset source"}]}
        with self.assertRaisesRegex(mcp_apps.CardError, "tool failed"):
            mcp_apps.make_card(server=self.server, tool="show_board", arguments={}, result=failed, surface="work")

    def test_a_tool_without_a_card_makes_none(self):
        with self.assertRaises(mcp_apps.CardError):
            mcp_apps.make_card(server=self.server, tool="plain", arguments={}, result={"content": []}, surface="work")


class Served(_Card):
    def fetch(self, url):
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                return response.status, response.headers, response.read().decode()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.headers, ""

    def test_the_page_is_served_behind_its_token_with_its_csp(self):
        record = self.card()
        url = mcp_apps.CardServer.get().card_url(record)
        self.assertTrue(url.startswith("http://127.0.0.1:"))
        status, headers, body = self.fetch(url)
        self.assertEqual(status, 200)
        self.assertEqual(body, PAGE)
        self.assertEqual(headers["Content-Security-Policy"], mcp_apps.csp_header(record["csp"]))
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.fetch(url.split("?t=")[0] + "?t=wrong")[0], 404)
        self.assertEqual(self.fetch(url.split("?t=")[0])[0], 404)

    def test_each_plugin_has_an_origin_of_its_own(self):
        record = self.card()
        other = dict(record, server="another", card_id="app_" + "0" * 24)
        mcp_apps.save_card(other)
        mine, theirs = mcp_apps.CardServer.get().card_url(record), mcp_apps.CardServer.get().card_url(other)
        self.assertNotEqual(mine.split("/card/")[0], theirs.split("/card/")[0])
        # A card can't be fetched from another plugin's origin, even with its own token.
        self.assertEqual(self.fetch(theirs.split("/card/")[0] + "/card/" + mine.split("/card/")[1])[0], 404)


class _Link(mcp_apps.Link):
    def __init__(self, server, mode="default", money=False, level=False, rules=None, reviewed=()):
        self._server, self.mode, self._money, self._level = server, mode, money, level
        self.rules = rules or {"allow": [], "ask": [], "deny": []}
        self.reviewed = set(reviewed)
        self.always = []
        self.surface = "work"

    def server(self, record):
        return self._server

    def permissions(self):
        from dgc.permissions import PermissionEngine
        return PermissionEngine(self.mode, self.rules)

    def money(self, record):
        return self._money

    def reviewed_read(self, record, tool):
        return tool in self.reviewed

    def level_lets(self, record, row):
        return self._level

    def allow_always(self, record, tool):
        self.always.append(tool)


class Asks(_Card):
    def call(self, link, tool, **arguments):
        return mcp_apps.CALLS.begin(self.card(), link, "tools/call", {"name": tool, "arguments": arguments})

    def test_a_read_runs(self):
        out = self.call(_Link(self.server), "show_board", size=2)
        self.assertEqual(out["result"]["structuredContent"], {"tool": "show_board", "args": {"size": 2}})

    def test_a_tool_only_its_card_may_call_runs_for_the_card(self):
        self.assertEqual(self.call(_Link(self.server), "refresh")["result"]["structuredContent"]["tool"], "refresh")

    def test_a_tool_hidden_from_cards_is_refused(self):
        out = self.call(_Link(self.server), "model_only")
        self.assertIn("doesn't let its card call", out["error"]["message"])
        self.assertFalse([r for r in self.requests_sent("tools/call") if r["params"]["name"] == "model_only"])

    def test_an_unknown_tool_is_refused(self):
        self.assertIn("has no tool named", self.call(_Link(self.server), "nope")["error"]["message"])

    def test_a_change_asks_and_runs_once_allowed(self):
        link = _Link(self.server)
        out = self.call(link, "move", to="b2")
        ask = out["ask"]
        self.assertTrue(ask["always"])
        self.assertEqual(ask["arguments"], {"to": "b2"})
        self.assertFalse(self.requests_sent("tools/call"), "nothing runs before the user answers")
        _asked, done = mcp_apps.CALLS.answer(ask["ask_id"], "once")
        self.assertEqual(done["result"]["structuredContent"]["tool"], "move")
        self.assertEqual(mcp_apps.CALLS.answer(ask["ask_id"], "once")[0], None, "an answer is used once")

    def test_dont_runs_nothing(self):
        ask = self.call(_Link(self.server), "move")["ask"]
        _asked, done = mcp_apps.CALLS.answer(ask["ask_id"], "deny")
        self.assertIn("didn't allow", done["error"]["message"])
        self.assertFalse(self.requests_sent("tools/call"))

    def test_always_allow_is_remembered(self):
        link = _Link(self.server)
        ask = self.call(link, "move")["ask"]
        mcp_apps.CALLS.answer(ask["ask_id"], "always")
        self.assertEqual(link.always, ["move"])

    def test_failed_always_allow_does_not_run_or_claim_a_saved_rule(self):
        link = _Link(self.server)
        ask = self.call(link, "move")["ask"]
        with patch.object(link, "allow_always", side_effect=OSError("disk full")):
            _asked, done = mcp_apps.CALLS.answer(ask["ask_id"], "always")
        self.assertIn("could not save Always allow", done["error"]["message"])
        self.assertFalse(self.requests_sent("tools/call"))

    def test_failed_rule_save_does_not_leave_an_in_memory_allow(self):
        config = _config(self.root)
        config.permissions = {"allow": [], "ask": [], "deny": []}
        with patch.object(config, "save", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                mcp_apps._remember_rule(config, self.card(), "move")
        self.assertEqual(config.permissions["allow"], [])

    def test_an_answer_for_another_card_cannot_spend_its_question(self):
        first, second = self.card(), self.card()
        ask = mcp_apps.CALLS.begin(first, _Link(self.server), "tools/call",
                                   {"name": "move", "arguments": {"to": "b2"}})["ask"]
        _wrong, refused = mcp_apps.CALLS.answer(ask["ask_id"], "once", card_id=second["card_id"])
        self.assertIn("not this card's question", refused["error"]["message"])
        self.assertFalse(self.requests_sent("tools/call"))
        self.assertEqual(len(mcp_apps.CALLS.pending(first["card_id"])), 1)
        _right, done = mcp_apps.CALLS.answer(ask["ask_id"], "once", card_id=first["card_id"])
        self.assertEqual(done["result"]["structuredContent"]["tool"], "move")

    def test_a_payment_plugin_asks_every_time_and_never_offers_always(self):
        link = _Link(self.server, money=True, rules={"allow": ["McpCall(mcp__board__move)"], "ask": [], "deny": []})
        ask = self.call(link, "move")["ask"]
        self.assertFalse(ask["always"])
        self.assertTrue(ask["money"])
        _asked, refused = mcp_apps.CALLS.answer(ask["ask_id"], "always")
        self.assertIn("not available", refused["error"]["message"])
        self.assertFalse(self.requests_sent("tools/call"))
        self.assertEqual(link.always, [], "Always is never saved for a payment plugin")

    def test_auto_mode_and_an_allow_rule_let_a_work_change_through(self):
        self.assertIn("result", self.call(_Link(self.server, mode="auto"), "move"))
        rule = {"allow": ["McpCall(mcp__board__move)"], "ask": [], "deny": []}
        self.assertIn("result", self.call(_Link(self.server, rules=rule), "move"))

    def test_plan_mode_refuses_a_cards_call(self):
        out = self.call(_Link(self.server, mode="plan"), "show_board")
        self.assertIn("plan mode", out["error"]["message"])

    def test_a_deny_rule_refuses_it(self):
        out = self.call(_Link(self.server, rules={"allow": [], "ask": [], "deny": ["McpCall(mcp__board__show_board)"]}),
                        "show_board")
        self.assertIn("deny rule", out["error"]["message"])

    def test_a_plugins_level_lets_a_chat_change_through(self):
        link = _Link(self.server, level=True)
        link.surface = "chat"
        self.assertIn("result", self.call(link, "move"))

    def test_an_ask_rule_asks_even_for_a_read(self):
        """Deny, then the user's own ask, then reads and allows: a read the vendor marked never skips an ask rule."""
        link = _Link(self.server, rules={"allow": [], "ask": ["McpCall(mcp__board__show_board)"], "deny": []})
        out = self.call(link, "show_board", size=2)
        self.assertIn("ask", out, out)
        self.assertFalse(out["ask"]["always"], "Always can't beat the user's own ask rule, so it isn't offered")
        self.assertFalse(self.requests_sent("tools/call"), "nothing runs before the user answers")
        reviewed = _Link(self.server, reviewed={"move"},
                         rules={"allow": [], "ask": ["McpCall(mcp__board__move)"], "deny": []})
        self.assertIn("ask", self.call(reviewed, "move"), "a reviewed read asks too when the user said to")

    def test_the_vendors_destructive_mark_beats_dgcs_reviewed_reads(self):
        """One read rule with ChatDGC and Pips (pip_plugins.read_only): a tool on DGC's reviewed list that its vendor
        now marks destructive, or not read-only, is a change, and a payment plugin asks before it."""
        meta = dict(self.server.tool_meta.get("move") or {})
        for marks in ({"destructiveHint": True}, {"readOnlyHint": False}, {"readOnlyHint": True, "destructiveHint": True}):
            with patch.dict(self.server.tool_meta, {"move": {**meta, "annotations": marks}}):
                out = self.call(_Link(self.server, money=True, reviewed={"move"}), "move")
                self.assertIn("ask", out, (marks, out))
                self.assertTrue(out["ask"]["money"])
                self.assertIn("ask", self.call(_Link(self.server, reviewed={"move"}), "move"), marks)
        self.assertFalse(self.requests_sent("tools/call"))
        self.assertIn("result", self.call(_Link(self.server, money=True, reviewed={"move"}), "move"),
                      "a reviewed read the vendor marks neither way still runs")

    # -- an open question is decided again when the user answers it

    def test_a_deny_rule_added_while_asking_runs_nothing(self):
        link = _Link(self.server)
        ask = self.call(link, "move", to="b2")["ask"]
        link.rules["deny"].append("McpCall(mcp__board__move)")
        _asked, done = mcp_apps.CALLS.answer(ask["ask_id"], "always")
        self.assertIn("deny rule", done.get("error", {}).get("message", ""), done)
        self.assertEqual(link.always, [], "a refused answer saves no rule")
        self.assertFalse(self.requests_sent("tools/call"))

    def test_a_tool_hidden_from_cards_while_asking_runs_nothing(self):
        link = _Link(self.server)
        ask = self.call(link, "move")["ask"]
        meta = dict(self.server.tool_meta.get("move") or {})
        with patch.dict(self.server.tool_meta, {"move": {**meta, "visibility": ["model"]}}):
            _asked, done = mcp_apps.CALLS.answer(ask["ask_id"], "once")
        self.assertIn("doesn't let its card call", done.get("error", {}).get("message", ""), done)
        self.assertFalse(self.requests_sent("tools/call"))

    def test_a_tool_whose_inputs_changed_while_asking_runs_nothing(self):
        link = _Link(self.server)
        ask = self.call(link, "move")["ask"]
        row = next(t for t in self.server.tools if t["name"] == "move")
        changed = [dict(t, inputSchema={"type": "object", "properties": {"to": {"type": "string"}, "pay": {"type": "number"}}})
                   if t is row else t for t in self.server.tools]
        with patch.object(self.server, "tools", changed):
            _asked, done = mcp_apps.CALLS.answer(ask["ask_id"], "once")
        self.assertIn("changed since you were asked", done.get("error", {}).get("message", ""), done)
        self.assertFalse(self.requests_sent("tools/call"))

    def test_a_new_connection_while_asking_runs_nothing(self):
        """The plugin reconnected (its settings were edited, or the chat reloaded its plugins): the approval was for the
        old connection, so it never runs on the new one."""
        link = _Link(self.server)
        ask = self.call(link, "move")["ask"]
        other = MCPManager(self.root)
        self.addCleanup(other.stop_all)
        other.connect_all({"board": {"command": sys.executable, "args": [str(self.root / "server.py"), str(self.wire)]}})
        link._server = other.servers["board"]
        _asked, done = mcp_apps.CALLS.answer(ask["ask_id"], "once")
        self.assertIn("changed since you were asked", done.get("error", {}).get("message", ""), done)
        self.assertFalse(self.requests_sent("tools/call"))

    def test_an_expired_question_runs_nothing(self):
        ask = self.call(_Link(self.server), "move")["ask"]
        mcp_apps.CALLS._asks[ask["ask_id"]]["at"] -= mcp_apps.ASK_TTL_S + 5      # asked eleven minutes ago
        _asked, done = mcp_apps.CALLS.answer(ask["ask_id"], "once")
        self.assertIn("expired", done.get("error", {}).get("message", ""), done)
        self.assertFalse(self.requests_sent("tools/call"))

    def test_only_tools_call_and_resources_read_reach_the_server(self):
        out = mcp_apps.CALLS.begin(self.card(), _Link(self.server), "prompts/get", {})
        self.assertIn("doesn't pass", out["error"]["message"])
        page = mcp_apps.CALLS.begin(self.card(), _Link(self.server), "resources/read", {"uri": "ui://board/card.html"})
        self.assertEqual(page["result"]["contents"][0]["text"], PAGE)


class _UI:
    def __init__(self, shown=True):
        self.shown, self.cards, self.infos = shown, [], []

    def mcp_apps_shown(self):
        return self.shown

    def mcp_app_card(self, record):
        self.cards.append(record)

    def info(self, text):
        self.infos.append(text)

    def __getattr__(self, name):
        return lambda *a, **kw: None


class WorkTurn(_Fixture):
    def agent(self, ui):
        from dgc.agent import Agent
        config = _config(self.root)
        agent = Agent(config, ui, mcp=self.manager)
        return agent

    def run_turn(self, agent, native=True, tool="mcp__board__show_board"):
        calls = []

        def post(url, **kwargs):
            payload = kwargs["json"]
            calls.append(copy.deepcopy(payload["messages"]))
            if len(calls) == 1:
                delta = ({"tool_calls": [{"index": 0, "id": "call1", "type": "function",
                                          "function": {"name": tool, "arguments": "{\"size\": 3}"}}]}
                         if native else
                         {"content": "```tool_call\n" + json.dumps({"name": tool, "arguments": {"size": 3}}) + "\n```"})
            else:
                delta = {"content": "Here is the board."}
            response = requests.Response()
            response.status_code, response.encoding, response.url = 200, "utf-8", url
            response.headers["Content-Type"] = "text/event-stream"
            finish = "tool_calls" if native and len(calls) == 1 else "stop"
            response.raw = io.BytesIO(("data: " + json.dumps({"choices": [{"index": 0, "delta": delta,
                                                                           "finish_reason": finish}]})
                                       + "\n\ndata: [DONE]\n\n").encode())
            return response

        rules = {"allow": ["McpCall(mcp__board__show_board)", "McpCall(mcp__board__plain)"], "ask": [], "deny": []}
        agent.config.permissions = rules
        with patch.object(type(agent.client), "tools_supported", new_callable=PropertyMock, return_value=native), \
                patch("dgc.llm.requests.post", side_effect=post):
            self.assertTrue(agent.run_turn("Show me the board."))
        return calls

    def test_a_tool_with_a_card_shows_it_and_the_model_reads_one_line(self):
        ui = _UI()
        agent = self.agent(ui)
        calls = self.run_turn(agent)
        [record] = ui.cards
        self.assertEqual(record["tool"], "show_board")
        self.assertEqual(record["call_id"], "call1")
        self.assertEqual(record["tool_result"]["structuredContent"]["tool"], "show_board")
        told = [m for m in calls[1] if m.get("role") == "tool"][0]["content"]
        self.assertIn("board show_board", told, "the tool's own answer stands")
        self.assertIn("DGC showed board's card for show_board", told)
        self.assertNotIn("<html", told, "the model never gets the page")
        saved = [m for m in agent.messages if m.get("role") == "tool"][0]
        self.assertEqual(saved["_dgc_mcp_app"]["card_id"], record["card_id"])

    def test_text_tool_models_keep_the_card_too(self):
        ui = _UI()
        agent = self.agent(ui)
        self.run_turn(agent, native=False)
        [record] = ui.cards
        kept = [m for m in agent.messages if m.get("_dgc_mcp_apps")]
        self.assertEqual(kept[0]["_dgc_mcp_apps"][0]["card_id"], record["card_id"])

    def test_no_card_until_the_client_draws_them(self):
        ui = _UI(shown=False)
        agent = self.agent(ui)
        calls = self.run_turn(agent)
        self.assertEqual(ui.cards, [])
        told = [m for m in calls[1] if m.get("role") == "tool"][0]["content"]
        self.assertNotIn("card", told)
        self.assertFalse(self.requests_sent("resources/read"), "an older client costs the server nothing")

    def test_a_tool_without_a_card_shows_none(self):
        ui = _UI()
        agent = self.agent(ui)
        self.run_turn(agent, tool="mcp__board__plain")
        self.assertEqual(ui.cards, [])

    def test_a_plugins_own_local_server_names_the_plugin_as_its_allow_card_does(self):
        """ready.capabilities.plugin_names names the plugin on the Allow card; its card says the same name, for a
        plugin's local server too (pip_plugins.owner knows only hosted ones)."""
        ui = _UI()
        agent = self.agent(ui)
        rows = [{"name": "board-game", "display_name": "Board Game", "servers": {"board": {"command": "board"}}}]
        with patch("dgc.plugins._installed", return_value=rows):
            calls = self.run_turn(agent)
        [record] = ui.cards
        self.assertEqual(record["plugin"], "Board Game")
        told = [m for m in calls[1] if m.get("role") == "tool"][0]["content"]
        self.assertIn("DGC showed Board Game's card for show_board", told)


class HostCommands(_Fixture):
    """What a card asks reaches the process by the card's own id: answered on the wire, validated as every event is."""

    def setUp(self):
        super().setUp()
        from dgc import config as config_module, headless, sessions
        user = self.root / "user-dgc"
        user.mkdir()
        for name, value in (("USER_HOME", user), ("USER_CONFIG", user / "config.json"),
                            ("USER_SECRETS", user / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        (user / "config.json").write_text(json.dumps({"model": "fixture", "base_url": "http://localhost.invalid/v1",
                                                      "suggest": False, "artifact_autostart": False,
                                                      "mcp_servers": {}}))
        scoped = patch.object(sessions, "SESSIONS_DIR", self.root / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        (self.root / "a").mkdir()
        self.host = headless.Host(Config(project_root=self.root / "a"))
        self.out = io.StringIO()
        self.host.core.fp = self.out
        self.chat = self.host.default
        own = self.chat.agent.mcp
        self.chat.agent.mcp = self.manager
        self.addCleanup(own.stop_all)
        self.chat.agent.config.save = lambda *a, **k: None

    def frames(self, kind=None):
        rows = [json.loads(line) for line in self.out.getvalue().splitlines()]
        return [row for row in rows if kind is None or row["type"] == kind]

    def wait(self, kind, request_id, seconds=10):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            found = [f for f in self.frames(kind) if f.get("request_id") == request_id]
            if found:
                return found[-1]
            time.sleep(0.02)
        self.fail(f"no {kind} for {request_id}: {self.frames()}")

    def wait_count(self, kind, request_id, count, seconds=10):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            found = [f for f in self.frames(kind) if f.get("request_id") == request_id]
            if len(found) >= count:
                return found[-1]
            time.sleep(0.02)
        self.fail(f"no {count} {kind} for {request_id}: {self.frames()}")

    def shown(self):
        self.host.dispatch({"type": "watch_mcp_apps"})
        result = {"content": [{"type": "text", "text": "the board"}], "structuredContent": {"cells": [1]}}
        record = mcp_apps.make_card(server=self.server, tool="show_board", arguments={}, result=result,
                                    surface="work", plugin="Board", call_id="call_1", owner={"session_id": "s-1"})
        self.chat.ui.mcp_app_card(record)
        return record

    def test_nothing_is_sent_before_the_client_watches(self):
        record = mcp_apps.make_card(server=self.server, tool="show_board", arguments={}, result={"content": []},
                                    surface="work")
        self.chat.ui.mcp_app_card(record)
        self.assertEqual(self.frames("mcp_app_card"), [])

    def test_a_card_is_sent_once_watched(self):
        record = self.shown()
        [frame] = self.frames("mcp_app_card")
        self.assertEqual(frame["card_id"], record["card_id"])
        self.assertTrue(frame["url"].startswith("http://127.0.0.1:"))
        self.assertEqual(frame["html"], PAGE)
        self.assertTrue(self.chat.agent.mcp_apps_shown() if hasattr(self.chat.agent, "mcp_apps_shown") else True)

    def test_a_cards_read_is_answered(self):
        record = self.shown()
        self.host.dispatch({"type": "mcp_app_call", "request_id": "r1", "card_id": record["card_id"],
                            "method": "tools/call", "params": {"name": "show_board", "arguments": {"size": 5}}})
        reply = self.wait("mcp_app_reply", "r1")
        self.assertEqual(reply["result"]["structuredContent"], {"tool": "show_board", "args": {"size": 5}})

    def test_a_cards_change_asks_then_runs(self):
        record = self.shown()
        self.host.dispatch({"type": "mcp_app_call", "request_id": "r2", "card_id": record["card_id"],
                            "method": "tools/call", "params": {"name": "move", "arguments": {"to": "c3"}}})
        ask = self.wait("mcp_app_reply", "r2")["ask"]
        self.assertEqual((ask["tool"], ask["arguments"], ask["always"]), ("move", {"to": "c3"}, True))
        self.host.dispatch({"type": "mcp_app_answer", "ask_id": ask["ask_id"], "choice": "always", "request_id": "r2"})
        reply = self.wait_count("mcp_app_reply", "r2", 2)
        self.assertEqual(reply["result"]["structuredContent"]["tool"], "move")
        self.assertIn("MCPCall(mcp__board__move)", self.chat.config.permissions.get("allow", []),
                      "Always allow is the same rule Settings → Permissions lists")
        self.assertEqual([f["rule"] for f in self.frames("rule_added")], ["MCPCall(mcp__board__move)"])

    def test_the_page_is_given_to_an_sdk_app(self):
        record = self.shown()
        self.host.dispatch({"type": "mcp_app_get", "request_id": "g1", "card_id": record["card_id"]})
        resource = self.wait("mcp_app_resource", "g1")
        self.assertEqual(resource["html"], PAGE)
        self.assertEqual(resource["csp_header"], mcp_apps.csp_header(record["csp"]))

    def test_a_cards_context_goes_to_the_next_turn_once(self):
        record = self.shown()
        self.host.dispatch({"type": "mcp_app_context", "card_id": record["card_id"],
                            "content": [{"type": "text", "text": "The user picked cell 2."}]})
        [row] = self.chat.agent._draft_mcp_context
        self.assertIn("Untrusted content from Board's card", row["text"])
        self.assertIn("The user picked cell 2.", row["text"])
        from dgc.mcp_context import apply_staged_context
        sent = apply_staged_context(self.chat.agent, "next question")
        self.assertIn('trust="untrusted-reference-data"', sent)
        self.assertEqual(self.chat.agent._draft_mcp_context, [], "once")
        self.assertEqual(mcp_apps.load_card(record["card_id"])["context"], "The user picked cell 2.")

    def test_an_unknown_card_is_said_so(self):
        self.host.dispatch({"type": "mcp_app_call", "request_id": "r9", "card_id": "app_" + "1" * 24,
                            "method": "tools/call", "params": {"name": "show_board"}})
        self.assertIn("isn't open", self.wait("mcp_app_reply", "r9")["error"]["message"])

    def test_history_replays_the_card_without_its_page(self):
        record = self.shown()
        self.chat.agent.messages = [
            {"role": "user", "content": "Show me the board."},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "call_1", "type": "function", "function": {
                "name": "mcp__board__show_board", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "call_1", "content": "the board\n" + mcp_apps.model_line(record),
             "_dgc_mcp_app": mcp_apps.summary(record)},
            {"role": "assistant", "content": "Here it is."}]
        items = self.chat._history()
        cards = [i for i in items if i.get("type") == "mcp_app_card"]
        self.assertEqual([c["card_id"] for c in cards], [record["card_id"]])
        self.assertNotIn("html", cards[0])
        order = [i.get("type") for i in items]
        self.assertLess(order.index("tool_result"), order.index("mcp_app_card"), "under its tool's row")
        self.chat.ui._mcp_apps_on = False
        self.assertFalse([i for i in self.chat._history() if i.get("type") == "mcp_app_card"],
                         "an older client's history is what it always was")

    def test_the_persons_row_says_the_card_opened_and_the_model_reads_its_line(self):
        record = self.shown()
        told = "the board\n" + mcp_apps.model_line(record)
        self.assertIn("The user sees and can use it; its page is not part of this result.", told)
        self.chat.ui.tool_result("mcp__board__show_board", told, "call_1")
        [live] = [f for f in self.frames("tool_result") if f.get("call_id") == "call_1"]
        self.assertEqual(live["output"], "the board\nOpened Board's card")
        self.chat.agent.messages = [
            {"role": "user", "content": "Show me the board."},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "call_1", "type": "function", "function": {
                "name": "mcp__board__show_board", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "call_1", "content": told, "_dgc_mcp_app": mcp_apps.summary(record)},
            {"role": "assistant", "content": "Here it is."}]
        [again] = [i for i in self.chat._history() if i.get("type") == "tool_result"]
        self.assertEqual(again["output"], "the board\nOpened Board's card", "a reopened chat reads the same")
        self.assertEqual(self.chat.agent.messages[2]["content"], told, "what the model reads is unchanged")


class ChatAndPipCards(_Fixture):
    """ChatDGC's and Pips' plugin layer: a read of a tool with a card keeps the card (for the reply), only while a
    screen draws them (ChatDGC) or for a chat a person reads later (a Pip, never a routine nobody watches)."""

    SPEC = {"transport": "remote", "url": "https://mcp.board.test/mcp", "args": ["-y", "mcp-remote", "https://mcp.board.test/mcp"]}

    def info(self):
        return {"board": {"display_name": "Board", "about": "", "money": False, "reads": frozenset({"show_board"}),
                          "servers": {"board": self.SPEC}}}

    def session(self, owner=None):
        from dgc.chatdgc import plugins as chat_plugins
        session = chat_plugins.ChatPlugins(_config(self.root), installed=self.info(),
                                           manager_factory=lambda server, spec: self.manager)
        session.app_owner = owner
        session.close = lambda: None
        return session

    def test_a_chat_read_of_a_tool_with_a_card_keeps_it_for_the_reply(self):
        session = self.session({"conversation_id": "chat_" + "a" * 32, "message_id": "msg_1"})
        told, card = session.call("call_plugin", {"plugin": "board", "tool": "show_board", "arguments": {"size": 2}})
        self.assertIsNone(card)
        [record] = session.app_cards
        self.assertEqual((record["surface"], record["conversation_id"], record["message_id"]), ("chat", "chat_" + "a" * 32, "msg_1"))
        self.assertEqual(record["plugin"], "Board")
        self.assertIn("board show_board", told)
        self.assertIn("DGC showed Board's card for show_board", told)
        self.assertIn("*.board.test", record["link_hosts"], "the plugin's own site opens without asking")

    def test_the_vendors_read_only_mark_lets_a_read_run_and_a_change_still_asks(self):
        """ChatDGC and Pips document "a read (the vendor's readOnlyHint, or DGC's reviewed reads) runs at once"; the
        mark now reaches that decision (kept beside the row, so no saved approval's digest changes)."""
        from dgc import pip_plugins
        info = self.info()
        info["board"]["reads"] = frozenset()
        from dgc.chatdgc import plugins as chat_plugins
        session = chat_plugins.ChatPlugins(_config(self.root), installed=info, manager_factory=lambda server, spec: self.manager)
        session.close = lambda: None
        told, card = session.call("call_plugin", {"plugin": "board", "tool": "show_board", "arguments": {}})
        self.assertIsNone(card, "a read the vendor marked runs at once")
        self.assertIn("board show_board", told)
        told, card = session.call("call_plugin", {"plugin": "board", "tool": "move", "arguments": {"to": "c1"}})
        self.assertIsNotNone(card, "a change still waits on its card")
        row = pip_plugins.vendor_marked({"name": "x"}, type("S", (), {"tool_meta": {"x": {"annotations": {
            "readOnlyHint": False, "destructiveHint": False, "openWorldHint": False}}}})(), "x")
        self.assertEqual(row["annotations"], {"readOnlyHint": False}, "a vendor calling a change harmless never lets it through")
        self.assertTrue(pip_plugins.important(row))

    def test_no_chat_card_while_no_screen_draws_them(self):
        session = self.session(None)
        told, _card = session.call("call_plugin", {"plugin": "board", "tool": "show_board", "arguments": {}})
        self.assertEqual(session.app_cards, [])
        self.assertNotIn("card", told)
        self.assertFalse(self.requests_sent("resources/read"))

    def test_send_it_now_on_a_chats_action_card_shows_its_plugin_card(self):
        from dgc.chatdgc import plugins as chat_plugins
        from dgc import pip_app_access as apps
        catalog_row = next(t for t in self.server.tools if t["name"] == "move")
        card = {"plugin": "board", "plugin_name": "Board", "server": "board", "tool": "move",
                "connection_digest": apps.digest(self.SPEC), "schema_digest": apps.digest(catalog_row), "arguments": {"to": "a1"}}
        outcome = chat_plugins.run(_config(self.root), card, installed=self.info(),
                                   manager_factory=lambda server, spec: self.manager,
                                   app_owner={"conversation_id": "chat_" + "b" * 32, "message_id": "msg_2"})
        self.assertEqual(outcome["status"], "done", outcome)
        self.assertEqual(outcome["app"]["tool"], "move")
        self.assertEqual(outcome["app"]["tool_result"]["structuredContent"]["args"], {"to": "a1"})

    def test_a_pips_reply_keeps_its_cards_and_a_routine_none(self):
        from dgc import pip_chat
        record = self.card_for_pip()
        kept = [mcp_apps.summary(record)]
        self.assertEqual(pip_chat.valid_apps(kept), kept)
        self.assertIsNone(pip_chat.valid_apps([{**kept[0], "html": "<b>"}]), "only what the controller keeps")
        self.assertIsNone(pip_chat.valid_apps([{**kept[0], "card_id": "app_nope"}]))
        self.assertEqual(mcp_apps.cards_of_run("run_1")[0]["card_id"], record["card_id"])

    def test_a_pips_next_reply_reads_what_its_cards_reported(self):
        import sqlite3
        from types import SimpleNamespace
        from dgc import pip_chat
        record = self.card_for_pip()
        mcp_apps.update_card(record["card_id"], context="The user starred project 2.")
        db = sqlite3.connect(":memory:")
        db.execute("CREATE TABLE pip_chat_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, pip_id TEXT, role TEXT, run_id TEXT)")
        db.execute("INSERT INTO pip_chat_messages(pip_id, role, run_id) VALUES ('pip_1', 'assistant', 'run_1')")
        said = pip_chat.card_context(SimpleNamespace(db=db), "pip_1")
        self.assertEqual(said, [{"plugin": "Board", "tool": "show_board", "text": "The user starred project 2."}])
        context = {"text": "next", "history": [], "history_omitted_count": 0, "last_report": None, "card_context": said}
        pip_chat.validate_context(context)
        from dgc.workspace_registry import RegistryError
        with self.assertRaises(RegistryError):
            pip_chat.validate_context({**context, "card_context": [{"plugin": "B", "tool": "t", "text": "x", "html": "<b>"}]})

    def card_for_pip(self):
        return mcp_apps.make_card(server=self.server, tool="show_board", arguments={}, result={"content": []},
                                  surface="pip", plugin="Board", owner={"pip_id": "pip_1", "run_id": "run_1"})


class PipCardAfterAllow(_Fixture):
    """A Pip's plugin call that waits for the user's Allow (the plugin at its default level) shows its card once it runs,
    as a call that runs at once does: made while the server is connected, kept with the reply that offered the action
    (so the chat shows it after a window reload), and the Pip reads that it is there. The reply's stored result, which
    every review from it pins, stays exactly as it was."""

    def setUp(self):
        super().setUp()
        from dgc import pip_chat, plugins as plugin_mod, pips
        from dgc.workspace_registry import WorkspaceRegistry
        from tests import test_pips_local as local
        self.spec = plugin_mod.mcp_spec("https://mcp.board.test/mcp", "")
        for patcher in (patch.dict(os.environ, {"DGC_HOME": str(self.root / "home")}),
                        patch("dgc.config.USER_CONFIG", self.root / "home" / "missing-config.json"),
                        patch("dgc.plugins.STATE_PATH", self.root / "plugin-state.json"),
                        patch("dgc.plugins.load_catalog", return_value={"plugins": []}),
                        patch("dgc.plugins._installed", return_value=[
                            {"name": "board", "display_name": "Board", "registered_specs": {"board": self.spec}}])):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.registry = WorkspaceRegistry(self.root / "state", clock=lambda: "2026-11-03T06:00:00.000Z")
        self.addCleanup(self.registry.close)
        self.store = pips.PipStore(self.registry)
        (self.root / "repo").mkdir()
        self.cfg = local.config(self.root / "repo", mcp_servers={"board": dict(self.spec)})
        self.pip = self.store.create(self.registry.personal()["id"], "Core", "Help with my day", "local-console")
        self.pip_chat = pip_chat

    def reply(self, actor="local-console", key="ask-1"):
        """A reply of the Pip's that offered an Allow card for the board's change tool (move)."""
        sent = (self.pip_chat.send(self.store, self.pip["id"], "Move to a1 on the board.", key, actor, self.cfg)
                if actor == "local-console" else
                self.pip_chat.send(self.store, self.pip["id"], "Move to a1 on the board.", key, actor, self.cfg, _intro=True))
        self.store.claim_next()
        return self.store.finish(sent["run"]["id"], result={"text": "The card below moves to a1 once you allow it."})

    def allow(self, run, key="one"):
        from functools import partial
        from dgc import pip_app_access as apps, pip_app_actions as actions, pip_connector_actions as connector
        entry = connector.catalog(self.manager, "board")["move"]
        action = actions.propose(self.store, run["id"], "board", apps.connection(self.cfg, "board")[1], "connection_managed",
                                 entry["schema_digest"], {"tool": "move", "arguments": {"to": "a1"}}, key, "local-console",
                                 self.cfg, kind="connector_call")
        self.manager.stop_all = lambda: None           # the fixture's server stays up for the next call
        connected = partial(connector.prepared, manager_factory=lambda *a: self.manager,
                            servers_reader=lambda config: config.get("mcp_servers"))
        sent = []
        with patch.object(connector, "prepared", connected), \
                patch("dgc.pip_chat.send", lambda store, pip_id, text, key, *a, **kw: sent.append(text)):
            done = actions.accept(self.store, action["id"], action["digest"], "local-console", self.cfg)
            from dgc import pip_plugins
            pip_plugins.after_action(self.store, self.cfg, done)
        return done

    def test_allow_shows_the_card_under_the_reply_that_offered_it_and_it_stays(self):
        from dgc import pip_app_access as apps
        run = self.reply()
        pinned = apps.digest(self.store.run(run["id"])["result"])
        done = self.allow(run)
        self.assertEqual(done["status"], "succeeded", done)
        [shown] = self.pip_chat.reply_apps(self.store.db, run["id"])
        self.assertEqual((shown["plugin"], shown["tool"], shown["server"]), ("Board", "move", "board"))
        record = mcp_apps.load_card(shown["card_id"])
        self.assertEqual((record["surface"], record["pip_id"], record["run_id"], record["action_id"]),
                         ("pip", self.pip["id"], run["id"], done["id"]))
        self.assertEqual(record["tool_result"]["structuredContent"]["args"], {"to": "a1"}, "the result it ran with")
        self.assertEqual(len(self.requests_sent("resources/read")), 1, "its page was read while the server was connected")
        # The chat as the editor loads it, on opening it or after Reload Window: the card is on that reply.
        listed = self.pip_chat.list_messages(self.store, self.pip["id"])["messages"]
        [offered] = [m for m in listed if m["role"] == "assistant" and m["run_id"] == run["id"]]
        self.assertEqual([a["card_id"] for a in offered["apps"]], [shown["card_id"]])
        [kept] = [r[0] for r in self.registry.db.execute("SELECT text FROM pip_plugin_answers")]
        self.assertIn("board move", kept)
        self.assertIn("DGC keeps Board's card for move under your reply that offered this action", kept)
        self.assertEqual(apps.digest(self.store.run(run["id"])["result"]), pinned, "the reply's result is unchanged")
        self.assertEqual(self.allow(run, key="two")["status"], "succeeded", "another review from that reply still runs")
        self.assertEqual(len(self.pip_chat.reply_apps(self.store.db, run["id"])), 2)

    def test_a_routine_nobody_watches_gets_no_card(self):
        run = self.reply(actor="local-routine", key="routine_" + "1" * 32)
        done = self.allow(run)
        self.assertEqual(done["status"], "succeeded", done)
        self.assertEqual(self.pip_chat.reply_apps(self.store.db, run["id"]), [])
        self.assertFalse(self.requests_sent("resources/read"), "no page read for a card nobody sees")


class PipAlwaysAsk(_Fixture):
    """A Pip's plugin at Always ask (Pips settings → Plugins) shows its Allow card for every call, also at a new Pip's own
    level, Approve for me, and also minutes after the same call ran. Release check, 2026-11-03: a get-time ran on
    Approve for me; the plugin was then set to Always ask and Core was asked to call it again. Core said "it's waiting
    for your Allow below", but call_plugin had handed it the answer of the call allowed two minutes before, so there
    was no draft, no action and no call. Allow runs it and shows its card under that reply; Don't runs nothing."""

    server_name, server_source = "example", CLOCK
    ask = {"plugin": "apps-example", "tool": "get-time", "arguments": {}}

    def setUp(self):
        super().setUp()
        from functools import partial
        from dgc import pip_chat, pip_connector_actions as connector, pip_levels, pips, plugins as plugin_mod
        from dgc.workspace_registry import WorkspaceRegistry
        from tests import test_pips_local as local
        self.spec = plugin_mod.mcp_spec("https://mcp.example.test/mcp", "")
        # The plugin's server is this fixture's own: every plugin session and every Allow reach it, and nothing else.
        self.manager.connect_all = lambda *a, **k: None
        self.manager.stop_all = lambda: None
        connected = partial(connector.prepared, manager_factory=lambda *a: self.manager,
                            servers_reader=lambda config: config.get("mcp_servers"))
        for patcher in (patch.dict(os.environ, {"DGC_HOME": str(self.root / "home")}),
                        patch("dgc.config.USER_CONFIG", self.root / "home" / "missing-config.json"),
                        patch("dgc.plugins.STATE_PATH", self.root / "plugin-state.json"),
                        patch("dgc.plugins.load_catalog", return_value={"plugins": []}),
                        patch("dgc.plugins._installed", return_value=[
                            {"name": "apps-example", "display_name": "MCP Apps example",
                             "registered_specs": {"example": self.spec}}]),
                        patch("dgc.mcp.MCPManager", lambda *a, **k: self.manager),
                        patch.object(connector, "prepared", connected)):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.registry = WorkspaceRegistry(self.root / "state")
        self.addCleanup(self.registry.close)
        self.store = pips.PipStore(self.registry)
        (self.root / "repo").mkdir()
        self.cfg = local.config(self.root / "repo", mcp_servers={"example": dict(self.spec)})
        self.pip = self.store.create(self.registry.personal()["id"], "Core", "Help with my day", "local-console")
        pip_levels.set_level(self.registry, self.pip["id"], "approve", "editor-user")      # a new Pip's level
        self.pip_chat, self.pips, self.plugin_mod = pip_chat, pips, plugin_mod

    def session(self, run_id):
        from dgc import pip_plugins
        session = pip_plugins.Session(self.registry.directory, self.cfg, self.pip["id"], self.pip["workspace_id"], run_id)
        self.addCleanup(session.close)
        return session

    def turn(self, text, key, *, actor="local-console", **send):
        """One chat turn as the runner makes it: the message, the Pip's call_plugin of get-time through the real
        plugin session, its reply saved, then what Always allow and the Pip's level let through. (run, call_plugin's
        answer)."""
        sent = self.pip_chat.send(self.store, self.pip["id"], text, key, actor, self.cfg, **send)
        claimed = self.store.claim_next()
        self.assertEqual(claimed["id"], sent["run"]["id"], "the turn runs next")
        said = self.session(claimed["id"]).call(self.registry, "call_plugin", self.ask)
        result = {"text": "Here it is."}
        if isinstance(said, dict):
            result = {"text": "The card below gets the time once you allow it.", "connector_action_draft": said["draft"]}
        run = self.store.finish(claimed["id"], result=result)
        self.pips._run_granted_actions(self.registry, self.cfg, run["id"])
        return run, said

    def carry_on(self):
        """The turn DGC starts once an allowed call ran: there the same call reads its answer and doesn't run again."""
        queued = self.registry.db.execute("SELECT m.text,m.request_key FROM pip_chat_messages m JOIN pip_runs r ON r.id=m.run_id "
                                          "WHERE r.status='queued' AND m.role='user'").fetchone()
        self.assertIsNotNone(queued, "DGC asks the Pip to carry on")
        claimed = self.store.claim_next()
        again = self.session(claimed["id"]).call(self.registry, "call_plugin", self.ask)
        self.assertIsInstance(again, str, "no second card in the turn that carries on")
        self.assertIn("it did not run again", again)
        self.store.finish(claimed["id"], result={"text": "It's 12:01 on its server."})

    def calls(self):
        return len(self.requests_sent("tools/call"))

    def pending(self):
        from dgc import pip_message_drafts as drafts
        return [d for d in drafts.history(self.store, self.pip["id"], None, 20, kind="connector")["drafts"]
                if d["status"] == "pending"]

    def test_always_ask_shows_its_allow_card_minutes_after_the_same_call_ran(self):
        first, said = self.turn("What time is it on the example's server?", "ask-1")
        self.assertIn("draft", said, "at its default level an unmarked tool is a change: a draft")
        self.assertEqual(self.calls(), 1, "and the Pip's level, Approve for me, ran it at once")
        self.carry_on()
        self.assertEqual(self.calls(), 1)
        self.plugin_mod.set_permission("apps-example", "always_ask", money=False)

        run, said = self.turn("Please call the get-time tool of the MCP Apps example plugin now.", "ask-2")
        self.assertIsInstance(said, dict, f"a turn the user starts is a new request, so it asks: {said!r}")
        self.assertIn("An Allow card for get-time in MCP Apps example is below your reply", said["text"])
        self.assertTrue(self.registry.db.execute("SELECT 1 FROM pip_plugin_offers WHERE run_id=?", (run["id"],)).fetchone())
        [card] = self.pending()
        self.assertEqual(card["source_run_id"], run["id"], "the Allow card waits under that reply")
        self.assertEqual(self.calls(), 1, "Approve for me doesn't run a plugin set to Always ask: nothing ran")
        self.assertEqual(self.pip_chat.reply_apps(self.store.db, run["id"]), [])

        # Allow, as the card does it: prepare the draft, then accept the action it made.
        from dgc import pip_app_actions as actions, pip_connector_drafts, pip_message_drafts as drafts, pip_plugins
        draft = drafts.get(self.store, card["id"], kind="connector")
        action = pip_connector_drafts.prepare(self.store, draft["id"], draft["digest"], None, "editor-user", self.cfg)
        done = actions.accept(self.store, action["id"], action["digest"], "editor-user", self.cfg)
        self.assertEqual(done["status"], "succeeded", done)
        self.assertTrue(pip_plugins.after_action(self.store, self.cfg, done), "the Pip carries on in its chat")
        self.assertEqual(self.calls(), 2, "Allow ran it once")
        [shown] = self.pip_chat.reply_apps(self.store.db, run["id"])
        self.assertEqual((shown["plugin"], shown["tool"], shown["server"]), ("MCP Apps example", "get-time", "example"))
        self.carry_on()
        self.assertEqual(self.calls(), 2)

        # Don't: the next card runs nothing, and the chat's drafts say it was not run.
        run, said = self.turn("Once more, please.", "ask-3")
        self.assertIn("draft", said)
        [card] = self.pending()
        self.assertEqual(card["source_run_id"], run["id"])
        draft = drafts.get(self.store, card["id"], kind="connector")
        dismissed = drafts.dismiss(self.store, draft["id"], draft["digest"], "editor-user", kind="connector")
        self.assertEqual(dismissed["status"], "dismissed")
        self.assertEqual(self.pending(), [])
        self.assertEqual(self.calls(), 2, "nothing ran")

    def test_full_access_never_runs_a_plugin_set_to_always_ask(self):
        from dgc import pip_levels
        pip_levels.set_level(self.registry, self.pip["id"], "full", "editor-user")
        self.plugin_mod.set_permission("apps-example", "always_ask", money=False)
        run, said = self.turn("What time is it on the example's server?", "ask-1")
        self.assertIn("draft", said)
        self.assertEqual(len(self.pending()), 1)
        self.assertEqual(self.calls(), 0)


class TerminalLine(_Fixture):
    """The terminal can't draw a card: one line says it opened, and its Open it shows it in the browser on a page DGC
    serves for that chat alone, whose requests reach that chat's agent."""

    def test_the_browser_page_is_this_chats_and_carries_what_the_card_asks(self):
        record = mcp_apps.make_card(server=self.server, tool="show_board", arguments={}, result={"content": []},
                                    surface="work", plugin="Board")

        class Agent:
            mcp = self.manager
            mode = "default"
            config = _config(self.root)

        sent, context = [], []
        cards = mcp_apps.CardServer.get()
        token = cards.register(mcp_apps.WorkLink(Agent()), message=lambda r, t: sent.append(t),
                               context=lambda r, t: context.append(t))
        self.assertEqual(urllib.request.urlopen(cards.card_url(record)).status, 200)
        page_url = cards.page_url(token, record["card_id"])
        with self.assertRaises(urllib.error.HTTPError, msg="a card this chat didn't show is not its to open"):
            urllib.request.urlopen(page_url, timeout=5)
        cards.owned(token, record["card_id"])
        with urllib.request.urlopen(page_url, timeout=5) as response:
            page = response.read().decode()
            self.assertIn("frame-src http://127.0.0.1:", response.headers["Content-Security-Policy"])
        self.assertIn(cards.card_url(record), page.replace("\\u0026", "&"))

        def post(kind, body):
            request = urllib.request.Request(f"{page_url}/{kind}", data=json.dumps(body).encode(),
                                             headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.loads(response.read())

        read = post("rpc", {"method": "tools/call", "params": {"name": "show_board", "arguments": {}}})
        self.assertEqual(read["result"]["structuredContent"]["tool"], "show_board")
        ask = post("rpc", {"method": "tools/call", "params": {"name": "move", "arguments": {"to": "b1"}}})["ask"]
        other = mcp_apps.make_card(server=self.server, tool="show_board", arguments={}, result={"content": []},
                                   surface="work", plugin="Board")
        cards.owned(token, other["card_id"])
        cross = urllib.request.Request(cards.page_url(token, other["card_id"]) + "/answer",
                                       data=json.dumps({"ask_id": ask["ask_id"], "choice": "once"}).encode(),
                                       headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(cross, timeout=5) as response:
            refused = json.loads(response.read())
        self.assertIn("not this card's question", refused["error"]["message"])
        self.assertEqual(len(mcp_apps.CALLS.pending(record["card_id"])), 1)
        self.assertEqual(post("answer", {"ask_id": ask["ask_id"], "choice": "once"})["result"]["structuredContent"]["tool"], "move")
        post("message", {"params": {"role": "user", "content": [{"type": "text", "text": "Make it bigger"}]}})
        self.assertEqual(sent, ["From Board's card: Make it bigger"])
        post("context", {"params": {"content": [{"type": "text", "text": "cell 3 picked"}]}})
        self.assertEqual(context, ["cell 3 picked"])
        wrong = urllib.request.Request(page_url.replace(token, "x" * 32) + "/rpc", data=b"{}", method="POST",
                                       headers={"Content-Type": "application/json"})
        with self.assertRaises(urllib.error.HTTPError):
            urllib.request.urlopen(wrong, timeout=5)

    def test_the_line_and_its_open_it(self):
        from dgc import tui as tui_mod
        record = mcp_apps.make_card(server=self.server, tool="show_board", arguments={}, result={"content": []},
                                    surface="work", plugin="Board")
        ui = object.__new__(tui_mod.TUI)
        sess = type("Session", (), {})()
        sess.blocks, sess.agent = [], type("Agent", (), {"mcp": self.manager, "mode": "default",
                                                          "config": _config(self.root)})()
        opened = []
        ui._cur_session = lambda: sess
        ui._invalidate = lambda: None
        ui._open_url = lambda url: opened.append(url) or True
        ui._flash = lambda text: None
        shown = []
        ui._append = lambda item: shown.append(item)
        ui._rich = lambda value: getattr(value, "plain", str(value))
        ui.mcp_app_card(record)
        [block] = sess.blocks
        frags = ui._card_frags(block)
        self.assertEqual("".join(f[1] for f in frags).strip().split("   ")[0], "\u25c6 Board opened a card \u00b7 Open it")
        handler = next(f[2] for f in frags if len(f) == 3)
        from prompt_toolkit.mouse_events import MouseEvent, MouseEventType, MouseButton
        from prompt_toolkit.data_structures import Point
        handler(MouseEvent(Point(0, 0), MouseEventType.MOUSE_UP, MouseButton.LEFT, frozenset()))
        self.assertEqual(opened, [block["url"]])
        ui._cards_command("")
        self.assertEqual(opened[-1], block["url"])
        self.assertIn(block["url"], shown[-1], "/cards also says the address, to copy on a computer reached over SSH")
        ui._open_url = lambda url: False
        ui._cards_command("")
        self.assertIn(block["url"], shown[-1], "and when no browser opened")
        self.assertTrue(block["url"].startswith("http://127.0.0.1:") and record["card_id"] in block["url"])


CLOUDFLARE_502 = ('the server answered HTTP 502: {"type":"https://developers.cloudflare.com/support/troubleshooting/'
                  'http-status-codes/cloudflare-5xx-errors/error-502/","title":"Error"}')


class _FailingReads:
    """resources/read fails ``times`` times with ``error`` (then works); every other request goes through."""

    def __init__(self, error: str, times: int):
        import dgc.mcp_context as mcp_context
        self.original, self.error, self.left, self.reads = mcp_context.request_complete, error, times, 0

    def __call__(self, server, method, params, *args, **kwargs):
        from dgc.mcp import MCPInputError
        if method == "resources/read":
            self.reads += 1
            if self.left:
                self.left -= 1
                raise MCPInputError(self.error)
        return self.original(server, method, params, *args, **kwargs)

    def __enter__(self):
        self.patch = patch("dgc.mcp_context.request_complete", self)
        self.patch.start()
        self.wait = patch.object(mcp_apps, "RETRY_WAIT_S", 0.01)
        self.wait.start()
        mcp_apps._resources.clear()
        return self

    def __exit__(self, *exc):
        self.patch.stop()
        self.wait.stop()


class Pruning(unittest.TestCase):
    """Kept cards are bounded, and so is what they point at: a page, or a Pip run's index, that no kept card (nor the
    last page that loaded for a plugin) points at goes with them. One written in the last hour stays: a card may be
    about to point at it."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        for patcher in (patch.object(mcp_apps, "home", lambda: self.root / "mcp-apps"),
                        patch.object(mcp_apps, "MAX_CARDS_KEPT", 1)):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(mcp_apps._pruned_at.__setitem__, 0, mcp_apps._pruned_at[0])

    @staticmethod
    def age(*paths):                                         # written an hour and a minute ago
        old = time.time() - 3660
        for path in paths:
            os.utime(path, (old, old))

    def test_pruned_cards_take_their_pages_and_run_indexes_with_them(self):
        home = mcp_apps.home()
        mcp_apps._pruned_at[0] = time.monotonic()            # no pass while the cards are made
        a, b = mcp_apps.save_html("<html>page a</html>"), mcp_apps.save_html("<html>page b</html>")
        cards = [("app_" + "a" * 24, a, "run-0"), ("app_" + "b" * 24, b, "run-1"), ("app_" + "c" * 24, b, "run-1")]
        for n, (card_id, sha, run) in enumerate(cards):
            mcp_apps.save_card({"card_id": card_id, "html_sha": sha, "run_id": run})
            mcp_apps._index_run(run, card_id)
            when = time.time() - 7200 + n * 60               # the oldest first
            os.utime(home / "cards" / f"{card_id}.json", (when, when))
        remembered = mcp_apps.save_html("<html>the last page that loaded</html>")
        mcp_apps._remember_page("board", "ui://board/card.html", {"uri": "ui://board/card.html", "sha": remembered,
                                                                   "csp": None, "permissions": {}, "prefers_border": None})
        self.age(*(home / "pages").glob("*.html"), *(home / "runs").glob("*.json"))
        fresh = mcp_apps.save_html("<html>just read; its card isn't saved yet</html>")
        mcp_apps._pruned_at[0] = 0
        mcp_apps._prune_later()
        self.assertEqual([p.stem for p in (home / "cards").glob("*.json")], ["app_" + "c" * 24])
        self.assertEqual(sorted(p.stem for p in (home / "pages").glob("*.html")), sorted([b, remembered, fresh]),
                         "the kept card's page (shared with a pruned one), the last page that loaded, and a new one")
        self.assertEqual(len(list((home / "runs").glob("*.json"))), 1, "only the run a kept card belongs to")
        self.assertEqual([c["card_id"] for c in mcp_apps.cards_of_run("run-1")], ["app_" + "c" * 24])
        self.assertEqual(mcp_apps.cards_of_run("run-0"), [])
        self.assertEqual(mcp_apps.load_html(b), "<html>page b</html>")

    def test_a_page_read_again_is_new_again(self):
        sha = mcp_apps.save_html("<html>x</html>")
        path = mcp_apps.home() / "pages" / f"{sha}.html"
        self.age(path)
        mcp_apps.save_html("<html>x</html>")
        self.assertGreater(path.stat().st_mtime, time.time() - 60, "a card about to point at it keeps it")


class CardPageFailures(_Card):
    """Seen in testing, 2026-11-02: Higgsfield's card page came back as Cloudflare's HTTP 502 once. The card was lost,
    the person read Cloudflare's JSON, and the model, told nothing, said the card was there."""

    def test_a_5xx_is_tried_once_more_and_the_card_shows(self):
        with _FailingReads(CLOUDFLARE_502, times=1) as reads:
            record = self.card()
        self.assertEqual(reads.reads, 2)
        self.assertEqual(mcp_apps.load_html(record["html_sha"]), PAGE)

    def test_a_page_that_keeps_failing_says_why_in_plain_words(self):
        with _FailingReads(CLOUDFLARE_502, times=9) as reads, self.assertRaises(mcp_apps.CardError) as raised:
            self.card()
        self.assertEqual(reads.reads, 2, "one more try, not more")
        self.assertEqual(str(raised.exception), "its server had a temporary problem (HTTP 502)")
        self.assertNotIn("cloudflare", str(raised.exception).lower())

    def test_a_404_is_not_tried_again(self):
        with _FailingReads("the server answered HTTP 404", times=9) as reads, \
                self.assertRaises(mcp_apps.CardError) as raised:
            self.card()
        self.assertEqual(reads.reads, 1)
        self.assertIn("wasn't found", str(raised.exception))

    def test_the_last_page_that_loaded_shows_when_a_read_fails(self):
        first = self.card()
        with _FailingReads(CLOUDFLARE_502, times=9):
            again = self.card()
        self.assertEqual(again["html_sha"], first["html_sha"])
        self.assertNotEqual(again["card_id"], first["card_id"], "a new card, with the new call's result")

    def test_the_model_line_for_a_failed_card_stays_out_of_the_persons_row(self):
        line = mcp_apps.failed_line("Higgsfield", "plans", "its server had a temporary problem (HTTP 502)")
        self.assertIn("could not show Higgsfield's card for plans", line)
        self.assertIn("The user sees no card", line)
        self.assertEqual(mcp_apps.shown_text("Plan: Free\n" + line), "Plan: Free")

    def test_plain_reasons(self):
        self.assertEqual(mcp_apps.plain_reason("request timed out after 20 s"), "its card page took too long to load")
        self.assertEqual(mcp_apps.plain_reason("the server answered HTTP 403"),
                         "its server refused to send the card page (HTTP 403)")
        self.assertEqual(mcp_apps.plain_reason("weird"), "its card page couldn't be loaded")


class WorkCardFailure(_Fixture):
    agent, run_turn = WorkTurn.agent, WorkTurn.run_turn

    def test_the_model_is_told_and_the_person_reads_plain_words(self):
        ui = _UI()
        agent = self.agent(ui)
        with _FailingReads(CLOUDFLARE_502, times=9):
            calls = self.run_turn(agent)
        self.assertEqual(ui.cards, [])
        told = [m for m in calls[1] if m.get("role") == "tool"][0]["content"]
        self.assertIn("board show_board", told, "the tool's own answer stands")
        self.assertIn("DGC could not show board's card for show_board: its server had a temporary problem (HTTP 502)", told)
        self.assertIn("give the result in your reply", told)
        self.assertNotIn("DGC showed", told)
        said = [line for line in ui.infos if "card couldn't be shown" in line]
        self.assertEqual(said, ["board's card couldn't be shown: its server had a temporary problem (HTTP 502). "
                                "Its answer is in the reply."])
        self.assertNotIn("{", said[0])


class ChatCardFailure(_Fixture):
    SPEC, info, session = ChatAndPipCards.SPEC, ChatAndPipCards.info, ChatAndPipCards.session

    def test_a_chat_read_whose_card_fails_tells_the_model(self):
        session = self.session({"conversation_id": "chat_" + "c" * 32, "message_id": "msg_3"})
        with _FailingReads(CLOUDFLARE_502, times=9):
            told, card = session.call("call_plugin", {"plugin": "board", "tool": "show_board", "arguments": {}})
        self.assertIsNone(card)
        self.assertEqual(session.app_cards, [])
        self.assertIn("board show_board", told)
        self.assertIn("DGC could not show Board's card for show_board", told)
        self.assertNotIn("DGC showed", told)


if __name__ == "__main__":
    unittest.main()
